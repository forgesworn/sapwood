<script lang="ts">
  // Per-app "approve from my phone" switch (the slot's `escalate` flag). Off
  // by default. Turning it on asks the owner to accept the risks first, and
  // over USB the signer asks for a press too; turning it off never asks.
  import type { ConnectSlot } from '../lib/types.js'
  import { AWAY_APPROVAL_RISKS, type AwayApprovalAvailability } from '../lib/away-approval.js'

  interface Props {
    slot: ConnectSlot
    availability: AwayApprovalAvailability
    /** Over USB the signer shows a card and waits for the button. */
    overUsb: boolean
    /** USB or WiFi: turning it off is always allowed on either. */
    canChange: boolean
    busy?: boolean
    onchange: (on: boolean) => Promise<void>
  }
  let { slot, availability, overUsb, canChange, busy = false, onchange }: Props = $props()

  const on = $derived(Boolean(slot.escalate))
  let reviewing = $state(false)
  let accepted = $state(false)
  let saving = $state(false)
  let error = $state<string | null>(null)

  function openReview() {
    error = null
    accepted = false
    reviewing = true
  }

  async function apply(next: boolean) {
    saving = true
    error = null
    try {
      await onchange(next)
      reviewing = false
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not change this setting.'
      error = /denied/i.test(msg) ? 'Not changed: the press on the signer was declined or timed out.' : msg
    } finally {
      saving = false
    }
  }
</script>

<div class="away">
  <div class="away-row">
    <span class="away-title">Approve from my phone</span>
    {#if on}
      <span class="tag tag--amber" title="Requests that need the button can be approved from your phone">ON</span>
      <button class="btn btn-secondary btn-sm" disabled={busy || saving || !canChange}
        onclick={() => apply(false)}>
        {saving ? (overUsb ? 'Press the button on the signer…' : 'Turning off…') : 'Turn off'}
      </button>
    {:else if availability.available}
      <span class="tag">OFF</span>
      {#if !reviewing}
        <button class="btn btn-secondary btn-sm" disabled={busy || saving} onclick={openReview}>Turn on…</button>
      {/if}
    {:else}
      <span class="tag">OFF</span>
    {/if}
  </div>

  {#if !on && !availability.available}
    <p class="hint-sm">{availability.reason}</p>
  {:else if !on && !reviewing}
    <p class="hint-sm">When you are away from the signer, requests from this app that need the button can be approved in the Signet app on your phone instead.</p>
  {/if}

  {#if reviewing && !on}
    <div class="away-review">
      <h4>Approve this app's requests from your phone?</h4>
      <ul>
        {#each AWAY_APPROVAL_RISKS as risk (risk)}<li>{risk}</li>{/each}
      </ul>
      <p class="away-note">Your phone needs the Signet app connected to this signer as your identity, holding
        its operator key. Only requests that would ask for the button are sent to your phone; an app set to sign
        automatically is unaffected. A request nobody answers is dropped after 10 minutes.</p>
      <label class="away-accept">
        <input type="checkbox" bind:checked={accepted} disabled={saving} />
        I understand my phone can now approve for this app
      </label>
      <div class="away-actions">
        <button class="btn btn-primary btn-sm" disabled={!accepted || saving || busy} onclick={() => apply(true)}>
          {saving ? (overUsb ? 'Press the button on the signer…' : 'Turning on…') : 'Turn on'}
        </button>
        {#if !saving}
          <button class="btn-link" onclick={() => (reviewing = false)}>Cancel</button>
        {/if}
      </div>
      {#if overUsb}
        <p class="away-note">The signer will show <strong>PHONE MAY OK</strong>. Hold its button to confirm.</p>
      {/if}
    </div>
  {/if}

  {#if error}<p class="warn-text" role="alert">{error}</p>{/if}
</div>

<style>
  .away { margin-top: 0.75rem; border-top: 1px solid var(--border); padding-top: 0.75rem; }
  .away-row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .away-title { font-size: 0.85rem; color: var(--text); margin-right: auto; }
  .away-row + .hint-sm { margin-top: 0.4rem; }
  .away-review {
    margin-top: 0.6rem; padding: 0.75rem 0.85rem;
    border: 1px solid var(--border); border-radius: 6px;
    display: flex; flex-direction: column; gap: 0.5rem;
  }
  .away-review h4 { margin: 0; font-size: 0.95rem; color: var(--amber); }
  .away-review ul { margin: 0; padding-left: 1.1rem; font-size: 0.82rem; color: var(--text-dim); line-height: 1.5; }
  .away-note { margin: 0; font-size: 0.78rem; color: var(--text-dim); line-height: 1.45; }
  .away-accept { display: flex; gap: 0.5rem; align-items: flex-start; font-size: 0.85rem; color: var(--text); }
  .away-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  @media (max-width: 480px) {
    .away-review { padding: 0.65rem 0.7rem; }
  }
</style>

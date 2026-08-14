<script lang="ts">
  // Path B family recovery: words only, no phone. The guardian's identity is
  // already provisioned from its recovery words (the existing Add-an-identity
  // flow); from there this wizard derives the natural person on the signer,
  // fetches the encrypted roster My Signet keeps on the sync relay, has the
  // signer decrypt it, and re-derives every family identity with the roster's
  // expected pubkeys as a checksum. Keys never leave the signer. All decision
  // logic lives in lib/recovery.ts; this component only holds the reactive
  // walk through it.
  import { nip19 } from 'nostr-tools'
  import {
    device, serialDerivePersona, serialRenamePersona, serialDeviceDecrypt,
  } from '../lib/device.svelte.js'
  import {
    DEFAULT_MANIFEST_RELAYS, NATURAL_PERSON_NAME,
    fetchDependantsManifest, parseDependantsManifest, buildEnrolmentPlan,
    npubToHex, runEnrolment,
    type EnrolmentPlan, type EnrolmentRowResult,
  } from '../lib/recovery.js'
  import { parseRelays, relayError } from '../lib/wizard.js'

  type Stage = 'intro' | 'natural-person' | 'fetch' | 'roster' | 'enrolling' | 'report'

  let stage = $state<Stage>('intro')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let npHex = $state('')
  let npNpub = $state('')
  let relayText = $state(DEFAULT_MANIFEST_RELAYS.join('\n'))
  let plan = $state<EnrolmentPlan | null>(null)
  let rows = $state<EnrolmentRowResult[]>([])
  let complete = $state(false)

  const guardian = $derived(
    device.masters.find((m) => m.slot === device.selectedSlot && !m.persona) ?? null,
  )

  function shortNpub(hex: string): string {
    try { return nip19.npubEncode(hex).slice(0, 16) + '…' } catch { return hex.slice(0, 16) + '…' }
  }

  async function deriveNaturalPerson() {
    busy = true
    error = null
    try {
      const persona = await serialDerivePersona(NATURAL_PERSON_NAME)
      npNpub = persona.npub
      npHex = npubToHex(persona.npub)
      stage = 'fetch'
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not derive the natural person.'
    } finally {
      busy = false
    }
  }

  async function fetchRoster() {
    const relays = parseRelays(relayText)
    const invalid = relayError(relays)
    if (invalid) { error = invalid; return }
    busy = true
    error = null
    try {
      const event = await fetchDependantsManifest(relays, npHex)
      if (!event) {
        error = 'No family roster found for this identity on those relays. '
          + 'Check the words belong to the guardian who runs My Signet, and add the relay My Signet publishes to.'
        return
      }
      const plaintext = await serialDeviceDecrypt(npHex, npHex, event.content)
      plan = buildEnrolmentPlan(parseDependantsManifest(plaintext))
      stage = 'roster'
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not fetch or decrypt the roster.'
    } finally {
      busy = false
    }
  }

  async function enrol() {
    if (!plan) return
    busy = true
    error = null
    stage = 'enrolling'
    rows = plan.entries.map((entry) => ({ ...entry, outcome: 'pending' }))
    try {
      const result = await runEnrolment(plan.entries, {
        derive: (name) => serialDerivePersona(name),
        rename: (npub, label) => serialRenamePersona(npub, label),
      }, (row, index) => { rows[index] = { ...row } })
      rows = result.rows.map((row) => ({ ...row }))
      complete = result.complete
      stage = 'report'
    } catch (e) {
      error = e instanceof Error ? e.message : 'Enrolment stopped unexpectedly.'
      stage = 'report'
      complete = false
    } finally {
      busy = false
    }
  }

  function restart() {
    stage = 'intro'
    error = null
    plan = null
    rows = []
    complete = false
  }

  const verifiedCount = $derived(rows.filter((row) => row.outcome === 'verified').length)
</script>

<div class="recovery">
  {#if stage === 'intro'}
    <p class="hint">
      Rebuild a family onto this signer from the guardian's recovery words alone: no phone needed.
      The wizard derives the guardian's natural person, fetches the encrypted family roster that
      My Signet keeps on its sync relay, asks the signer to decrypt it, then re-derives every
      family identity and checks each one against the pubkey the roster expects. Keys never leave
      the signer.
    </p>
    {#if guardian}
      <p class="hint-sm">
        Recovering against <strong>{guardian.label || guardian.npub.slice(0, 16) + '…'}</strong>
        (slot {guardian.slot}). This must be the identity provisioned from the guardian's recovery
        words; if it is not on the signer yet, add it first under "Add an identity to this signer"
        using the recovery phrase mode.
      </p>
      <button class="btn btn-secondary" onclick={() => { stage = 'natural-person' }}>Start recovery</button>
    {:else}
      <p class="hint-sm">
        No identity is on this signer yet. First add the guardian's identity from its recovery
        words under "Add an identity to this signer", then return here.
      </p>
    {/if}
  {:else if stage === 'natural-person'}
    <p class="hint">
      Step 1 of 3. The signer derives the guardian's natural person: the identity the roster is
      encrypted to. If Sapwood has not paired with this identity before, confirm the pairing on
      the signer's button when its screen asks.
    </p>
    <button class="btn btn-secondary" disabled={busy} onclick={deriveNaturalPerson}>
      {busy ? 'Waiting for the signer…' : 'Derive the natural person'}
    </button>
  {:else if stage === 'fetch'}
    <p class="hint">
      Step 2 of 3. Natural person ready at <code class="mono">{npNpub.slice(0, 20)}…</code>.
      Now fetch the encrypted roster. My Signet publishes it to one relay, its primary; the list
      below starts with the ecosystem default. The signer decrypts the roster itself, and may ask
      for one button press to allow decryption on an older Sapwood pairing.
    </p>
    <textarea class="input relays" rows="4" bind:value={relayText} disabled={busy}></textarea>
    <button class="btn btn-secondary" disabled={busy} onclick={fetchRoster}>
      {busy ? 'Fetching and decrypting…' : 'Fetch the family roster'}
    </button>
  {:else if stage === 'roster' && plan}
    <p class="hint">
      Step 3 of 3. The roster names {plan.entries.length} identities to enrol. Each derived key
      is checked against the pubkey the roster expects; a single mismatch stops everything.
    </p>
    <div class="rows">
      {#each plan.entries as entry (entry.derivationName)}
        <div class="row">
          <span class="row-name">{entry.displayName}</span>
          <span class="row-derivation mono">{entry.derivationName}</span>
          <span class="row-expected mono">{entry.expectedPubkey ? shortNpub(entry.expectedPubkey) : 'derived blind'}</span>
        </div>
      {/each}
    </div>
    {#if plan.skipped.length > 0}
      <div class="skipped">
        <p class="hint-sm">Not recoverable from words:</p>
        {#each plan.skipped as skip (skip.displayName + skip.reason)}
          <p class="hint-sm">• {skip.displayName}: {skip.reason}</p>
        {/each}
      </div>
    {/if}
    <button class="btn btn-secondary" disabled={busy} onclick={enrol}>
      Enrol {plan.entries.length} identities
    </button>
  {:else if stage === 'enrolling' || stage === 'report'}
    <div class="rows">
      {#each rows as row (row.derivationName)}
        <div class="row">
          <span class="row-status" class:ok={row.outcome === 'verified'}
            class:bad={row.outcome === 'mismatch' || row.outcome === 'failed'}>
            {row.outcome === 'verified' ? '✓' : row.outcome === 'pending' ? '·' : '✗'}
          </span>
          <span class="row-name">{row.displayName}</span>
          <span class="row-derivation mono">{row.derivationName}</span>
        </div>
        {#if row.error}<p class="error-text">{row.error}</p>{/if}
      {/each}
    </div>
    {#if stage === 'report'}
      {#if complete}
        <p class="hint done">
          Family recovered: {verifiedCount} identities enrolled and verified against the roster.
          Two things words alone cannot bring back: the guardian's own extra named identities
          (re-derive each under "Add a persona" by its remembered name, which reproduces the same
          key), and app pairings, so each family app re-pairs with a fresh connect link when next
          used. Approval rules push down from My Signet once it pairs with this signer.
        </p>
      {:else}
        <p class="error-text">
          Enrolment stopped before completing. Nothing wrong was enrolled: fix the cause above
          and run the recovery again; identities already verified stay valid.
        </p>
      {/if}
      <button class="btn btn-secondary" onclick={restart}>Start again</button>
    {/if}
  {/if}
  {#if error && stage !== 'report'}
    <p class="error-text">{error}</p>
  {/if}
</div>

<style>
  .recovery { display: flex; flex-direction: column; gap: 0.7rem; align-items: flex-start; }
  .relays { width: 100%; resize: vertical; font-size: 0.8rem; }
  .rows { width: 100%; display: flex; flex-direction: column; gap: 0.25rem; }
  .row { display: flex; gap: 0.7rem; align-items: baseline; font-size: 0.82rem; }
  .row-status { width: 1rem; color: var(--text-muted); }
  .row-status.ok { color: var(--green); }
  .row-status.bad { color: var(--red); }
  .row-name { color: var(--text); min-width: 8rem; }
  .row-derivation { color: var(--text-muted); font-size: 0.76rem; }
  .row-expected { color: var(--text-dim); font-size: 0.76rem; margin-left: auto; }
  .skipped { border-left: 2px solid var(--border); padding-left: 0.7rem; }
  .done { color: var(--text); }
</style>

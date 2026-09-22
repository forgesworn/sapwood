<script lang="ts">
  import type { ConnectSlot } from '../lib/types.js'
  import ConfirmButton from './ConfirmButton.svelte'

  interface Props {
    slot: ConnectSlot
    canRevoke: boolean
    identityLabel: (key: string) => string
    onrevoke: (client?: string, identity?: string) => Promise<void>
  }

  let { slot, canRevoke, identityLabel, onrevoke }: Props = $props()

  const TOTAL_CLIENT_CAPACITY = 8

  let localbusy = $state(false)
  let activeaction = $state('')
  let localerror = $state('')
  let localstatus = $state('')

  const hasApprovals = $derived(Array.isArray(slot.client_approvals))

  function shortKey(key: string): string {
    return key.length > 16 ? key.slice(0, 8) + '…' + key.slice(-8) : key
  }

  function fp(client: { client_pubkey: string }): string {
    return shortKey(client.client_pubkey)
  }

  function isCurrent(client: { client_pubkey: string }): boolean {
    return slot.current_pubkey != null && client.client_pubkey === slot.current_pubkey
  }

  const clientKeyCount = $derived(hasApprovals ? slot.client_approvals!.length : 0)

  async function revoke(client?: string, identity?: string, scope: string = 'all') {
    if (localbusy || !canRevoke) return
    localbusy = true
    activeaction = scope
    localerror = ''
    localstatus = ''
    try {
      await onrevoke(client, identity)
      localstatus = 'Consent withdrawn.'
    } catch (e) {
      localerror = e instanceof Error && e.message ? e.message : 'Withdrawal failed.'
    } finally {
      localbusy = false
      activeaction = ''
    }
  }
</script>

{#if hasApprovals}
  <details class="consent">
    <summary><h3>Persona consent</h3></summary>

    <p class="counts">Client keys: {clientKeyCount} / {TOTAL_CLIENT_CAPACITY}</p>
    <p class="full-note">When consent storage is full, Heartwood can approve a request once.</p>

    <p class="scope-note">
      Device consent survives app updates; pairing method/kind limits still apply; new devices need
      their own consent.
    </p>

    {#if localerror}
      <p class="error" role="alert">{localerror}</p>
    {/if}
    {#if localstatus}
      <p class="status" role="status">{localstatus}</p>
    {/if}

    {#if !canRevoke}
      <p class="hint" role="note">Connect with management access to withdraw consent.</p>
    {/if}

    {#each slot.client_approvals as client (client.client_pubkey)}
      <details class="client">
        <summary>
          <code class="fp">{fp(client)}</code>
          {#if isCurrent(client)}<span class="badge">current</span>{/if}
        </summary>

        {#if client.approved_identities.length === 0 && client.legacy_identity_tags.length === 0}
          <p class="hint">No remembered persona consent.</p>
        {:else}
          <ul class="ids">
            {#each client.approved_identities as key (key)}
              <li>
                <span class="id-label" title={key}>{identityLabel(key)}</span>
                {#if canRevoke}
                  <ConfirmButton
                    label="Withdraw identity"
                    question={'Withdraw consent for ' + identityLabel(key) + ' from ' + fp(client) + '?'}
                    confirmLabel="Yes, withdraw identity"
                    busyLabel="Withdrawing…"
                    busy={activeaction === 'identity:' + client.client_pubkey + ':' + key}
                    disabled={localbusy}
                    onconfirm={() => revoke(client.client_pubkey, key, 'identity:' + client.client_pubkey + ':' + key)}
                  />
                {/if}
              </li>
            {/each}
            {#each client.legacy_identity_tags as tag (tag)}
              <li>
                <span class="id-label legacy" title={tag}>{identityLabel(tag)}</span>
                <span class="badge legacy-badge">inherited approval</span>
                {#if canRevoke}
                  <ConfirmButton
                    label="Withdraw identity"
                    question={'Withdraw consent for ' + identityLabel(tag) + ' from ' + fp(client) + '?'}
                    confirmLabel="Yes, withdraw identity"
                    busyLabel="Withdrawing…"
                    busy={activeaction === 'identity:' + client.client_pubkey + ':' + tag}
                    disabled={localbusy}
                    onconfirm={() => revoke(client.client_pubkey, tag, 'identity:' + client.client_pubkey + ':' + tag)}
                  />
                {/if}
              </li>
            {/each}
          </ul>

          {#if canRevoke}
            <ConfirmButton
              label="Withdraw all for this client"
              question={'Withdraw all remembered persona consent for ' + fp(client) + '?'}
              confirmLabel="Yes, withdraw all"
              busyLabel="Withdrawing…"
              busy={activeaction === 'client:' + client.client_pubkey}
              disabled={localbusy}
              onconfirm={() => revoke(client.client_pubkey, undefined, 'client:' + client.client_pubkey)}
            />
          {/if}
        {/if}
      </details>
    {/each}

    {#if canRevoke && slot.client_approvals!.length > 0}
      <ConfirmButton
        label="Withdraw all consent"
        question="Withdraw remembered persona consent for all clients on this pairing?"
        confirmLabel="Yes, withdraw all consent"
        busyLabel="Withdrawing…"
        busy={activeaction === 'pairing'}
        disabled={localbusy}
        onconfirm={() => revoke(undefined, undefined, 'pairing')}
      />
    {/if}
  </details>
{/if}

<style>
  .consent { margin-top: 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
  h3 { margin: 0; font-size: 1rem; display: inline; }
  .counts { font-size: 0.85rem; color: var(--text-dim, #888); margin: 0; }
  .scope-note, .full-note, .hint { font-size: 0.85rem; color: var(--text-dim, #888); margin: 0; }
  .error { font-size: 0.85rem; color: var(--danger, #c0392b); margin: 0; }
  .status { font-size: 0.85rem; color: var(--text, #222); margin: 0; }
  .client { border: 1px solid var(--border, #ddd); border-radius: 6px; padding: 0.5rem; }
  summary { cursor: pointer; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  summary::before { content: "▸"; color: var(--text-dim); }
  details[open] > summary::before { content: "▾"; }
  .fp { font-size: 0.8rem; overflow-wrap: anywhere; word-break: break-all; }
  .badge { font-size: 0.75rem; padding: 0.1rem 0.4rem; border-radius: 999px;
    background: var(--accent-bg, #eef); color: var(--accent, #345); }
  .legacy-badge { background: var(--warn-bg, #fdf3d8); color: var(--warn, #8a6d1a); }
  .ids { list-style: none; padding: 0; margin: 0.5rem 0; display: flex;
    flex-direction: column; gap: 0.4rem; }
  .ids li { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .id-label { font-size: 0.85rem; overflow-wrap: anywhere; word-break: break-all; }
  .id-label.legacy { color: var(--text-dim, #888); }
</style>

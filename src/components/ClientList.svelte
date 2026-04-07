<script lang="ts">
  import { device, refreshSlots, serialTransport, httpTransport, type PendingClient } from '../lib/device.svelte.js'
  import { FrameType, buildPolicyRevoke, buildPolicyUpdate } from '../lib/frame.js'
  import { kindLabel } from '../lib/kinds.js'
  import KindPermissions from './KindPermissions.svelte'
  import ApprovalQueue from './ApprovalQueue.svelte'
  import type { ConnectSlot } from '../lib/types.js'

  // --- State ---

  let creating = $state(false)
  let newLabel = $state('')
  let createError = $state<string | null>(null)
  let createdUri = $state<string | null>(null)
  let createdUriCopied = $state(false)
  let showAdvancedUri = $state(false)
  let advancedCopied = $state(false)

  // Connect slots (secret-based, Pi mode)
  let connectSlots = $state<{ label: string; secret: string; bunker_uri: string; clients: string[] }[]>([])

  // Per-client URI reveal
  let uriForPubkey = $state<string | null>(null)
  let uriValue = $state('')
  let uriCopied = $state(false)

  $effect(() => { if (device.connected) { refreshSlots(); loadConnectSlots() } })

  async function loadConnectSlots() {
    connectSlots = await httpTransport.getConnectSlots(device.selectedSlot)
  }

  /** Find the bunker URI for a client by matching its pubkey against connect slot records. */
  function slotUriForClient(pubkey: string): string | null {
    for (const cs of connectSlots) {
      if (cs.clients.includes(pubkey)) return cs.bunker_uri
    }
    return null
  }

  // --- Derived ---

  const selectedBunkerUri = $derived(
    device.masters.find((m) => m.slot === device.selectedSlot)?.bunkerUri ?? ''
  )

  const selectedMasterLabel = $derived(
    device.masters.find((m) => m.slot === device.selectedSlot)?.label ?? ''
  )

  // --- Handlers ---

  async function handleCreate() {
    const label = newLabel.trim()
    if (!label) { createError = 'Name is required.'; return }
    creating = true
    createError = null
    createdUri = null
    createdUriCopied = false
    try {
      const result = await httpTransport.createSlot(device.selectedSlot, label)
      createdUri = (result.bunker_uri as string) ?? null
      // heartwoodd returns { slot_index, secret, npub } without bunker_uri —
      // fetch the full URI from the slot endpoint.
      if (!createdUri && result.slot_index !== undefined) {
        try {
          const uri = await httpTransport.getSlotUri(device.selectedSlot, result.slot_index as number)
          createdUri = uri
        } catch { /* non-fatal */ }
      }
      newLabel = ''
    } catch (e) {
      createError = e instanceof Error ? e.message : 'Failed to create connection'
    } finally {
      creating = false
    }
  }

  function dismissCreatedUri() {
    createdUri = null
    createdUriCopied = false
    refreshSlots()
    loadConnectSlots()
  }

  async function handleRevoke(slot: ConnectSlot) {
    if (!confirm(`Revoke "${slot.label}"?`)) return
    try {
      const frame = device.mode === 'http'
        ? await httpTransport.revokeSlot(device.selectedSlot, slot.slot_index)
        : await serialTransport.sendAndReceive(
            buildPolicyRevoke(device.selectedSlot, slot.slot_index.toString()),
            [FrameType.ACK, FrameType.NACK],
          )
      if (frame.type === FrameType.NACK) device.error = 'Revoke rejected.'
      await refreshSlots()
    } catch (e) { device.error = e instanceof Error ? e.message : 'Revoke failed' }
  }

  /** Track which slot index is currently waiting for device confirmation. */
  let updatingSlotIndex = $state<number | null>(null)

  async function handleUpdate(slot: ConnectSlot, changes: Record<string, unknown>) {
    updatingSlotIndex = slot.slot_index
    try {
      const frame = device.mode === 'http'
        ? await httpTransport.updateSlot(device.selectedSlot, slot.slot_index, changes)
        : await serialTransport.sendAndReceive(
            buildPolicyUpdate(device.selectedSlot, JSON.stringify({ ...slot, ...changes })),
            [FrameType.ACK, FrameType.NACK],
          )
      if (frame.type === FrameType.NACK) device.error = 'Update denied on device.'
      await refreshSlots()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Update failed'
      if (msg.includes('denied') || msg.includes('Denied')) {
        device.error = 'Update denied on device.'
      } else if (msg.includes('timeout') || msg.includes('Timeout')) {
        device.error = 'Timed out waiting for device confirmation.'
      } else {
        device.error = msg
      }
    } finally {
      updatingSlotIndex = null
    }
  }

  async function handleRevokeAll() {
    if (!confirm(`Revoke all ${device.slots.length} clients for ${selectedMasterLabel}?`)) return
    try {
      if (device.mode === 'http') {
        await httpTransport.clearClients(device.selectedSlot)
      } else {
        for (const slot of [...device.slots]) {
          await serialTransport.sendAndReceive(
            buildPolicyRevoke(device.selectedSlot, slot.slot_index.toString()),
            [FrameType.ACK, FrameType.NACK],
          )
        }
      }
    } catch { /* */ }
    await refreshSlots()
  }

  function handleSlotChange(e: Event) {
    device.selectedSlot = parseInt((e.target as HTMLSelectElement).value)
    createdUri = null
    showAdvancedUri = false
    uriForPubkey = null
    refreshSlots(device.selectedSlot)
    loadConnectSlots()
  }

  async function fetchBunkerUri(slot: ConnectSlot) {
    if (device.mode !== 'http') return
    uriFetching = true
    uriSlotIndex = slot.slot_index
    uriValue = ''
    uriCopied = false
    try {
      uriValue = await httpTransport.getSlotUri(device.selectedSlot, slot.slot_index)
    } catch (e) {
      device.error = e instanceof Error ? e.message : 'Failed to fetch URI'
      uriSlotIndex = null
    } finally {
      uriFetching = false
    }
  }

  async function copyUri(uri: string, target: 'created' | 'advanced' | 'slot' = 'slot') {
    let ok = false
    try {
      await navigator.clipboard.writeText(uri)
      ok = true
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = uri
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch { /* */ }
    }
    if (ok) {
      if (target === 'created') {
        createdUriCopied = true
        createdUriCopied = true
        setTimeout(() => { createdUriCopied = false }, 2000)
      } else if (target === 'advanced') {
        advancedCopied = true
        setTimeout(() => { advancedCopied = false }, 2000)
      } else {
        uriCopied = true
        setTimeout(() => { uriCopied = false }, 2000)
      }
    }
  }

  async function approveWithLabel(pubkey: string, label: string) {
    const ok = await httpTransport.approveClient(device.selectedSlot, pubkey, label.trim() || 'approved')
    if (ok) await refreshSlots()
  }

  async function renameSlot(slot: ConnectSlot, newLabel: string) {
    const trimmed = newLabel.trim()
    if (!trimmed || trimmed === slot.label) return
    if (!slot.current_pubkey) return
    const ok = await httpTransport.approveClient(device.selectedSlot, slot.current_pubkey, trimmed)
    if (ok) await refreshSlots()
  }

  function shortPubkey(hex: string): string {
    return hex.slice(0, 8) + '\u2009\u00b7\u00b7\u00b7\u2009' + hex.slice(-8)
  }

  function timeAgo(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime()
    if (ms < 60_000) return 'just now'
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
    return `${Math.floor(ms / 86_400_000)}d ago`
  }
</script>

<div class="clients">

  <!-- Header -->
  <div class="head">
    <h2>Clients</h2>
    <div class="head-controls">
      {#if device.masters.length > 1}
        <label class="identity-pick">
          <select value={device.selectedSlot} onchange={handleSlotChange}>
            {#each device.masters as master}
              <option value={master.slot}>{master.label ?? master.slot}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if device.slots.length > 0}
        <button class="btn-text btn-danger" onclick={handleRevokeAll}>Revoke all</button>
      {/if}
    </div>
  </div>

  <!-- New Connection (primary action) -->
  {#if device.mode === 'http' && device.connected}
    <section class="new-connection">
      {#if createdUri}
        <!-- URI just created — this is the ONLY URI the user needs to see -->
        <div class="created-result">
          <div class="created-header">
            <span class="created-dot"></span>
            <span class="created-title">Connection ready</span>
            <button class="btn-text btn-muted" onclick={dismissCreatedUri}>Dismiss</button>
          </div>
          <p class="created-hint">Paste this URI into your Nostr client.</p>
          <div class="uri-box">
            <code class="uri-code">{createdUri}</code>
            <button
              class="btn-copy"
              class:copied={createdUriCopied}
              onclick={() => copyUri(createdUri!, 'created')}
            >
              {createdUriCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      {:else}
        <!-- Create form -->
        <form class="create-form" onsubmit={(e) => { e.preventDefault(); handleCreate() }}>
          <input
            type="text"
            bind:value={newLabel}
            placeholder="Name this connection (e.g. bark-macbook)"
            disabled={creating}
          />
          <button type="submit" class="btn-primary" disabled={creating || !newLabel.trim()}>
            {creating ? 'Creating\u2026' : 'New connection'}
          </button>
        </form>
        {#if createError}
          <p class="form-error">{createError}</p>
        {/if}
      {/if}
    </section>
  {/if}

  <!-- Approval Queue (heartwoodd Soft mode) -->
  <ApprovalQueue />

  <!-- Pending Approval -->
  {#if device.pendingClients.length > 0}
    <section class="pending">
      <h3 class="section-label section-label--amber">Awaiting approval</h3>
      {#each device.pendingClients as pc}
        {@const ago = pc.lastSeen ? timeAgo(pc.lastSeen) : ''}
        <div class="pending-row">
          <div class="pending-left">
            <code class="pending-pk">{pc.pubkey}</code>
            <span class="pending-meta">{pc.attempts} attempt{pc.attempts !== 1 ? 's' : ''}{ago ? ` \u00b7 ${ago}` : ''}</span>
          </div>
          <div class="pending-right">
            <input
              class="pending-label"
              type="text"
              placeholder="label"
              onkeydown={(e) => { if (e.key === 'Enter') { const el = e.target as HTMLInputElement; approveWithLabel(pc.pubkey, el.value) } }}
            />
            <button class="btn-approve" onclick={(e) => {
              const input = (e.target as HTMLElement).closest('.pending-right')?.querySelector('input') as HTMLInputElement | null
              approveWithLabel(pc.pubkey, input?.value ?? '')
            }}>Approve</button>
          </div>
        </div>
      {/each}
    </section>
  {/if}

  <!-- Approved Clients -->
  {#if !device.connected}
    <p class="empty-state">Connect to view clients.</p>
  {:else if device.slots.length === 0 && device.pendingClients.length === 0 && !createdUri}
    <p class="empty-state">No clients connected to {selectedMasterLabel || 'this identity'}.</p>
  {:else if device.slots.length > 0}
    <section class="approved">
      <h3 class="section-label">Connected</h3>
      {#each device.slots as slot, i}
        <div class="client-card">
          <div class="client-row">
            <div class="client-identity">
              <input
                class="client-name"
                type="text"
                value={slot.label}
                onblur={(e) => renameSlot(slot, (e.target as HTMLInputElement).value)}
                onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
              {#if slot.current_pubkey}
                <span class="client-pk">{shortPubkey(slot.current_pubkey)}</span>
              {/if}
            </div>
            <div class="client-actions">
              {#if slot.signing_approved}
                <span class="tag tag--blue">SIGNED</span>
              {/if}
              <button
                class="tag tag--toggle"
                class:on={slot.auto_approve}
                onclick={() => handleUpdate(slot, { auto_approve: !slot.auto_approve })}
              >
                {slot.auto_approve ? 'AUTO' : 'MANUAL'}
              </button>
              <button class="btn-uri" onclick={async () => {
                if (uriForPubkey === (slot.current_pubkey ?? String(slot.slot_index))) {
                  uriForPubkey = null; uriValue = ''
                } else {
                  uriForPubkey = slot.current_pubkey ?? String(slot.slot_index)
                  uriCopied = false
                  try {
                    uriValue = await httpTransport.getSlotUri(device.selectedSlot, slot.slot_index)
                  } catch { uriValue = ''; device.error = 'Failed to fetch URI' }
                }
              }}>
                {uriForPubkey === (slot.current_pubkey ?? String(slot.slot_index)) ? 'Hide URI' : 'URI'}
              </button>
              <button class="btn-text btn-danger" onclick={() => handleRevoke(slot)}>Revoke</button>
            </div>
          </div>

          {#if uriForPubkey === (slot.current_pubkey ?? String(slot.slot_index)) && uriValue}
            <div class="uri-box" style="margin-top: 0.75rem;">
              <code class="uri-code">{uriValue}</code>
              <button
                class="btn-copy btn-copy--sm"
                class:copied={uriCopied}
                onclick={() => copyUri(uriValue, 'slot')}
              >
                {uriCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
          {/if}

          <KindPermissions
            allowedKinds={slot.allowed_kinds}
            unrestricted={slot.allowed_kinds.length === 0}
            signingApproved={slot.signing_approved ?? true}
            updating={updatingSlotIndex === slot.slot_index}
            onchange={(kinds) => handleUpdate(slot, { allowed_kinds: kinds })}
          />
        </div>
      {/each}
    </section>
  {/if}

  <!-- Advanced: raw bunker URI (Pi multi-instance mode only, hidden in heartwoodd mode) -->
  {#if device.mode === 'http' && device.connected && selectedBunkerUri}
    <section class="advanced">
      <button class="advanced-toggle" onclick={() => showAdvancedUri = !showAdvancedUri}>
        <span class="advanced-chevron" class:open={showAdvancedUri}>{'\u25B8'}</span>
        Advanced: raw bunker URI (no pre-authorisation)
      </button>
      {#if showAdvancedUri}
        <div class="uri-box uri-box--muted">
          <code class="uri-code uri-code--dim">{selectedBunkerUri}</code>
          <button
            class="btn-copy btn-copy--sm"
            class:copied={advancedCopied}
            onclick={() => copyUri(selectedBunkerUri, 'advanced')}
          >
            {advancedCopied ? 'Copied' : 'Copy'}
          </button>
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  /* --- Layout --- */
  .clients { display: flex; flex-direction: column; gap: 1.5rem; }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  h2 { font-size: 1.3rem; font-weight: 600; margin: 0; color: #fff; }

  .head-controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .identity-pick select {
    background: var(--surface);
    border: 1px solid var(--border-bright);
    color: var(--text);
    padding: 0.35rem 0.75rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.9rem;
  }

  /* --- Section labels --- */
  .section-label {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0 0 0.75rem;
  }
  .section-label--amber { color: var(--amber); }

  /* --- Buttons --- */
  .btn-primary {
    background: var(--green);
    color: #050505;
    border: none;
    padding: 0.5rem 1.25rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s, box-shadow 0.15s;
  }
  .btn-primary:hover:not(:disabled) { background: #00ff88; box-shadow: var(--green-glow); }
  .btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }

  .btn-text {
    background: none;
    border: none;
    font-family: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    padding: 0.3rem 0.5rem;
    border-radius: 3px;
    transition: background 0.12s;
  }
  .btn-danger { color: var(--red); }
  .btn-danger:hover { background: #1a0808; }
  .btn-muted { color: var(--text-muted); }
  .btn-muted:hover { color: var(--text-dim); }

  .btn-copy {
    background: var(--green);
    color: #050505;
    border: none;
    padding: 0.4rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .btn-copy:hover { background: #00ff88; }
  .btn-copy.copied { background: var(--green-dim); }
  .btn-copy--sm { padding: 0.25rem 0.6rem; font-size: 0.75rem; }

  .btn-approve {
    background: var(--green);
    color: #050505;
    border: none;
    border-radius: 3px;
    padding: 0.35rem 0.85rem;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
  }
  .btn-approve:hover { background: #00ff88; }

  .btn-uri {
    background: #001a0a;
    border: 1px solid var(--green-dim);
    color: var(--green);
    padding: 0.3rem 0.65rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.12s;
  }
  .btn-uri:hover { background: #002a12; border-color: var(--green); }

  /* --- New Connection --- */
  .new-connection {
    background: var(--surface-raised);
    border: 1px solid var(--border-bright);
    border-radius: 6px;
    padding: 1.25rem;
  }

  .create-form {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .create-form input {
    background: #0e0e0e;
    border: 1px solid #3a3a3a;
    color: #eee;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.9rem;
    flex: 1;
  }
  .create-form input:focus { outline: none; border-color: var(--green); }
  .create-form input::placeholder { color: #666; }
  .create-form input:disabled { opacity: 0.5; }

  .form-error { font-size: 0.8rem; color: var(--red); margin: 0.5rem 0 0; }

  /* Created URI result */
  .created-result {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .created-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .created-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 8px rgba(0, 232, 123, 0.5);
    flex-shrink: 0;
  }

  .created-title {
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--green);
    flex: 1;
  }

  .created-hint {
    font-size: 0.85rem;
    color: var(--text-dim);
    margin: 0;
  }

  /* --- URI Box (reusable) --- */
  .uri-box {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    background: #061a0c;
    border: 1px solid var(--green-dim);
    border-radius: 4px;
    padding: 0.75rem 1rem;
    margin-top: 0.25rem;
  }
  .uri-box--muted {
    background: #0a0a0a;
    border-color: var(--border-bright);
    margin-top: 0.5rem;
  }

  .uri-code {
    font-size: 0.8rem;
    color: var(--green);
    word-break: break-all;
    line-height: 1.5;
    flex: 1;
    user-select: all;
  }
  .uri-code--dim { color: var(--text-dim); }

  /* --- Pending --- */
  .pending {
    background: #100e00;
    border: 1px solid #33290a;
    border-radius: 6px;
    padding: 1rem 1.25rem;
  }

  .pending-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.6rem 0;
    border-top: 1px solid #221c00;
  }
  .pending-row:first-of-type { border-top: none; }

  .pending-left {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .pending-pk {
    font-size: 0.7rem;
    color: var(--text-dim);
    word-break: break-all;
    line-height: 1.4;
  }

  .pending-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .pending-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .pending-label {
    background: #0a0a0a;
    border: 1px solid var(--border);
    color: var(--text);
    padding: 0.3rem 0.6rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.8rem;
    width: 110px;
  }
  .pending-label::placeholder { color: #444; }

  /* --- Approved Clients --- */
  .client-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1rem 1.25rem;
    margin-bottom: 0.5rem;
    transition: border-color 0.15s;
  }
  .client-card:hover { border-color: var(--border-bright); }

  .client-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }

  .client-identity { min-width: 0; }

  .client-name {
    display: block;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    color: #fff;
    font-family: inherit;
    font-size: 1rem;
    font-weight: 600;
    padding: 0.1rem 0.35rem;
    margin: -0.1rem -0.35rem;
    width: calc(100% + 0.7rem);
    max-width: 260px;
  }
  .client-name:hover { border-color: var(--border); }
  .client-name:focus { border-color: var(--green-dim); outline: none; background: #080808; }

  .client-pk {
    display: block;
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-top: 0.15rem;
    letter-spacing: 0.02em;
    padding-left: 0.35rem;
  }

  .client-actions {
    display: flex;
    gap: 0.4rem;
    flex-shrink: 0;
    align-items: center;
  }

  /* --- Tags --- */
  .tag {
    padding: 0.3rem 0.75rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    border: 1px solid;
  }
  .tag--blue {
    background: #001520;
    border-color: #003a5c;
    color: #44aaee;
    cursor: default;
  }
  .tag--toggle {
    background: #1a0e00;
    border-color: #3a2200;
    color: var(--amber);
    cursor: pointer;
    transition: all 0.12s;
  }
  .tag--toggle.on {
    background: #001a0a;
    border-color: #003a1a;
    color: var(--green);
  }

  /* --- Advanced --- */
  .advanced {
    border-top: 1px solid var(--border);
    padding-top: 1rem;
  }

  .advanced-toggle {
    background: none;
    border: none;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .advanced-toggle:hover { color: var(--text-dim); }

  .advanced-chevron {
    display: inline-block;
    transition: transform 0.15s;
    font-size: 0.7rem;
  }
  .advanced-chevron.open { transform: rotate(90deg); }

  /* --- Empty --- */
  .empty-state {
    color: var(--text-muted);
    font-size: 0.95rem;
    text-align: center;
    padding: 2rem 0;
  }
</style>

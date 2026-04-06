<script lang="ts">
  import { device, refreshSlots, serialTransport, httpTransport } from '../lib/device.svelte.js'
  import { FrameType, buildPolicyRevoke, buildPolicyUpdate } from '../lib/frame.js'
  import { kindLabel } from '../lib/kinds.js'
  import KindPermissions from './KindPermissions.svelte'
  import type { ConnectSlot } from '../lib/types.js'

  // Track which slot is showing its bunker URI.
  let uriSlotIndex = $state<number | null>(null)
  let uriValue = $state('')
  let uriFetching = $state(false)
  let uriCopied = $state(false)

  // New slot creation.
  let creating = $state(false)
  let newLabel = $state('')
  let createError = $state<string | null>(null)
  let createdUri = $state<string | null>(null)
  let createdUriCopied = $state(false)

  $effect(() => { if (device.connected) refreshSlots() })

  async function handleRevoke(slot: ConnectSlot) {
    if (!confirm(`Revoke connection slot "${slot.label}"?`)) return
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

  async function handleUpdate(slot: ConnectSlot, changes: Record<string, unknown>) {
    try {
      const frame = device.mode === 'http'
        ? await httpTransport.updateSlot(device.selectedSlot, slot.slot_index, changes)
        : await serialTransport.sendAndReceive(
            buildPolicyUpdate(device.selectedSlot, JSON.stringify({ ...slot, ...changes })),
            [FrameType.ACK, FrameType.NACK],
          )
      if (frame.type === FrameType.NACK) device.error = 'Update rejected.'
      await refreshSlots()
    } catch (e) { device.error = e instanceof Error ? e.message : 'Update failed' }
  }

  async function handleRevokeAll() {
    if (!confirm(`Revoke all ${device.slots.length} connection slots for master slot ${device.selectedSlot}?`)) return
    for (const slot of [...device.slots]) {
      try {
        if (device.mode === 'http') {
          await httpTransport.revokeSlot(device.selectedSlot, slot.slot_index)
        } else {
          await serialTransport.sendAndReceive(
            buildPolicyRevoke(device.selectedSlot, slot.slot_index.toString()),
            [FrameType.ACK, FrameType.NACK],
          )
        }
      } catch { /* continue revoking the rest */ }
    }
    await refreshSlots()
  }

  function handleSlotChange(e: Event) {
    device.selectedSlot = parseInt((e.target as HTMLSelectElement).value)
    refreshSlots(device.selectedSlot)
  }

  async function fetchBunkerUri(slot: ConnectSlot) {
    if (device.mode !== 'http') {
      device.error = 'Bunker URI retrieval requires bridge (HTTP) connection.'
      return
    }
    uriFetching = true
    uriSlotIndex = slot.slot_index
    uriValue = ''
    uriCopied = false
    try {
      uriValue = await httpTransport.getSlotUri(device.selectedSlot, slot.slot_index)
    } catch (e) {
      device.error = e instanceof Error ? e.message : 'Failed to fetch bunker URI'
      uriSlotIndex = null
    } finally {
      uriFetching = false
    }
  }

  async function copyUri(uri: string, isCreated = false) {
    let ok = false
    try {
      await navigator.clipboard.writeText(uri)
      ok = true
    } catch {
      // Clipboard API blocked (HTTP context). Use legacy execCommand fallback.
      try {
        const ta = document.createElement('textarea')
        ta.value = uri
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch { /* both methods failed */ }
    }
    if (ok) {
      if (isCreated) {
        createdUriCopied = true
        setTimeout(() => { createdUriCopied = false }, 2000)
      } else {
        uriCopied = true
        setTimeout(() => { uriCopied = false }, 2000)
      }
    }
  }

  async function handleCreate() {
    const label = newLabel.trim()
    if (!label) { createError = 'Label is required.'; return }
    creating = true
    createError = null
    createdUri = null
    createdUriCopied = false
    try {
      const result = await httpTransport.createSlot(device.selectedSlot, label)
      createdUri = result.bunker_uri as string
      newLabel = ''
      await refreshSlots()
    } catch (e) {
      createError = e instanceof Error ? e.message : 'Create failed'
    } finally {
      creating = false
    }
  }

  function shortPubkey(hex: string): string {
    return hex.slice(0, 8) + '...' + hex.slice(-8)
  }
</script>

<div class="client-list">
  <div class="header-row">
    <h2>Connection Slots</h2>
    <div class="header-actions">
      {#if device.slots.length > 0}
        <button class="btn-revoke-all" onclick={handleRevokeAll}>Revoke All</button>
      {/if}
      <label class="slot-pick">
        MASTER SLOT
        <select value={device.selectedSlot} onchange={handleSlotChange}>
          {#each [0, 1, 2, 3, 4, 5, 6, 7] as s}
            <option value={s}>{s}</option>
          {/each}
        </select>
      </label>
    </div>
  </div>

  {#if device.mode === 'http' && device.connected}
    <div class="create-row">
      <form class="create-form" onsubmit={(e) => { e.preventDefault(); handleCreate() }}>
        <input
          type="text"
          bind:value={newLabel}
          placeholder="Connection label (e.g. Nostrudel, Coracle, Bark...)"
          disabled={creating}
        />
        <button type="submit" class="btn-create" disabled={creating || !newLabel.trim()}>
          {creating ? 'Creating...' : 'New Connection'}
        </button>
      </form>
      {#if createError}
        <p class="create-error">{createError}</p>
      {/if}
      {#if createdUri}
        <div class="created-uri-block">
          <p class="created-uri-hint">Paste this bunker URI into your Nostr client to connect:</p>
          <div class="uri-inner">
            <code class="uri-text">{createdUri}</code>
            <button class="btn-copy" onclick={() => copyUri(createdUri!, true)}>
              {createdUriCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if !device.connected}
    <p class="empty">Connect to view connection slots.</p>
  {:else if device.slots.length === 0}
    <p class="empty">No connection slots for master slot {device.selectedSlot}.</p>
  {:else}
    {#each device.slots as slot, i}
      <div class="card">
        <div class="card-top">
          <div class="card-left">
            <span class="slot-num">#{i + 1}</span>
            <div class="slot-info">
              <span class="slot-name">{slot.label}</span>
              {#if slot.current_pubkey}
                <span class="pubkey">{shortPubkey(slot.current_pubkey)}</span>
              {:else}
                <span class="pubkey not-connected">Not yet connected</span>
              {/if}
            </div>
          </div>

          <div class="actions">
            {#if slot.signing_approved}
              <span class="badge signed">SIGNED</span>
            {/if}
            <button
              class="badge auto-badge"
              class:on={slot.auto_approve}
              onclick={() => handleUpdate(slot, { auto_approve: !slot.auto_approve })}
            >
              {slot.auto_approve ? 'AUTO' : 'MANUAL'}
            </button>
            {#if device.mode === 'http'}
              <button class="btn-uri" onclick={() => fetchBunkerUri(slot)}>
                Bunker URI
              </button>
            {/if}
            <button class="btn-revoke" onclick={() => handleRevoke(slot)}>
              Revoke
            </button>
          </div>
        </div>

        {#if uriSlotIndex === slot.slot_index}
          <div class="uri-block">
            {#if uriFetching}
              <span class="uri-loading">Fetching...</span>
            {:else if uriValue}
              <div class="uri-inner">
                <code class="uri-text">{uriValue}</code>
                <button class="btn-copy" onclick={() => copyUri(uriValue)}>
                  {uriCopied ? 'Copied' : 'Copy'}
                </button>
                <button class="btn-uri-close" onclick={() => { uriSlotIndex = null; uriValue = '' }}>
                  Dismiss
                </button>
              </div>
            {/if}
          </div>
        {/if}

        <KindPermissions
          allowedKinds={slot.allowed_kinds}
          unrestricted={slot.allowed_kinds.length === 0}
          onchange={(kinds) => handleUpdate(slot, { allowed_kinds: kinds })}
        />
      </div>
    {/each}
  {/if}
</div>

<style>
  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  h2 { font-size: 1.3rem; font-weight: 600; margin: 0; color: #fff; }

  .slot-pick {
    font-size: 0.85rem;
    color: var(--text-muted);
    letter-spacing: 0.1em;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .slot-pick select {
    background: var(--surface);
    border: 1px solid var(--border-bright);
    color: var(--text);
    padding: 0.35rem 0.6rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.9rem;
  }

  .create-row {
    margin-bottom: 1.5rem;
  }

  .create-form {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .create-form input {
    background: #080808;
    border: 1px solid var(--green-dim);
    color: var(--text);
    padding: 0.4rem 0.75rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.95rem;
    flex: 1;
  }

  .create-form input:focus { outline: none; border-color: var(--green); }
  .create-form input::placeholder { color: #444; }
  .create-form input:disabled { opacity: 0.5; }

  .btn-create {
    background: var(--green);
    color: #050505;
    border: none;
    padding: 0.4rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
  }

  .btn-create:hover:not(:disabled) { background: #00ff88; box-shadow: var(--green-glow); }
  .btn-create:disabled { opacity: 0.4; cursor: not-allowed; }

  .create-error {
    font-size: 0.8rem;
    color: var(--red);
    margin: 0.5rem 0 0;
  }

  .created-uri-block {
    margin-top: 1rem;
    background: #040d06;
    border: 1px solid var(--green-dim);
    border-radius: 6px;
    padding: 1rem 1.25rem;
  }

  .created-uri-hint {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin: 0 0 0.75rem;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 0.75rem;
    transition: border-color 0.15s;
  }

  .card:hover { border-color: var(--border-bright); }

  .card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }

  .card-left {
    display: flex;
    align-items: center;
    gap: 1rem;
    min-width: 0;
  }

  .slot-num {
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--text-muted);
    min-width: 2rem;
  }

  .slot-info { min-width: 0; }

  .slot-name {
    display: block;
    font-size: 1.15rem;
    font-weight: 600;
    color: #fff;
  }

  .pubkey {
    display: block;
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-top: 0.15rem;
    letter-spacing: 0.03em;
  }

  .pubkey.not-connected {
    font-style: italic;
    color: #444;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
    align-items: center;
  }

  .badge {
    padding: 0.4rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.08em;
  }

  .badge.signed {
    background: #001a22;
    border: 1px solid #004466;
    color: #22aaff;
    cursor: default;
  }

  .auto-badge {
    background: #1a0e00;
    border: 1px solid #442800;
    color: var(--amber);
    cursor: pointer;
    transition: all 0.15s;
  }

  .auto-badge.on {
    background: #001a0a;
    border-color: #004422;
    color: var(--green);
  }

  .btn-uri {
    background: #001a0a;
    border: 1px solid var(--green-dim);
    color: var(--green);
    padding: 0.4rem 0.85rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-uri:hover { background: #002a12; border-color: var(--green); box-shadow: var(--green-glow); }

  .btn-revoke {
    background: transparent;
    border: 1px solid #442222;
    color: var(--red);
    padding: 0.4rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-revoke:hover { background: #1a0808; }

  .uri-block {
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .uri-inner {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    background: #040d06;
    border: 1px solid var(--green-dim);
    border-radius: 6px;
    padding: 0.75rem 1rem;
  }

  .uri-text {
    font-size: 0.85rem;
    color: var(--green);
    word-break: break-all;
    line-height: 1.5;
    flex: 1;
    user-select: all;
  }

  .uri-loading {
    font-size: 0.85rem;
    color: var(--text-muted);
    font-style: italic;
  }

  .btn-copy {
    background: var(--green);
    color: #050505;
    border: none;
    padding: 0.4rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
    transition: all 0.15s;
  }

  .btn-copy:hover { background: #00ff88; box-shadow: var(--green-glow); }

  .btn-uri-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    padding: 0.4rem 0.25rem;
    flex-shrink: 0;
  }

  .btn-uri-close:hover { color: var(--text); }

  .header-actions { display: flex; align-items: center; gap: 0.75rem; }

  .btn-revoke-all {
    background: transparent;
    border: 1px solid #442222;
    color: var(--red);
    padding: 0.35rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
  }
  .btn-revoke-all:hover { background: #1a0808; }

  .empty { color: var(--text-muted); font-size: 1.1rem; }
</style>

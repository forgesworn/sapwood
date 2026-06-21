<script lang="ts">
  import {
    device, refreshSlots, mgmtCreateClient, mgmtApproveSigning,
    mgmtRevokeClient, mgmtUpdateClient, mgmtCanApproveSigning,
  } from '../lib/device.svelte.js'
  import KindPermissions from './KindPermissions.svelte'

  let creating = $state(false)
  let newLabel = $state('')
  let preApprove = $state(true)
  let createError = $state<string | null>(null)
  let updatingSlot = $state<number | null>(null)

  // The created connection — the ONE time the secret/URI is shown.
  let created = $state<{ bunker_uri: string; secret: string; signing_approved: boolean } | null>(null)
  let copied = $state<'uri' | 'secret' | null>(null)
  let approvingSlot = $state<number | null>(null)

  const canApprove = $derived(mgmtCanApproveSigning())
  const overUsb = $derived(device.mode === 'serial')
  const transportLabel = $derived(overUsb ? 'over USB' : 'over relay')

  // Load the slot list on connect. Relay mode also polls every 4s; serial relies
  // on this (CONNSLOT_LIST → device.slots via handleFrame).
  $effect(() => { if (device.connected) refreshSlots() })

  async function handleCreate() {
    const label = newLabel.trim()
    if (!label) { createError = 'Name is required.'; return }
    creating = true
    createError = null
    created = null
    try {
      const res = await mgmtCreateClient(label, canApprove && preApprove)
      created = { bunker_uri: res.bunker_uri, secret: res.secret, signing_approved: res.signing_approved }
      newLabel = ''
    } catch (e) {
      createError = e instanceof Error ? e.message : 'Failed to create client'
    } finally {
      creating = false
    }
  }

  async function handleApprove(slotIndex: number) {
    approvingSlot = slotIndex
    try {
      await mgmtApproveSigning(slotIndex)
    } catch (e) {
      device.error = e instanceof Error ? e.message : 'Approve failed'
    } finally {
      approvingSlot = null
    }
  }

  async function handleRevoke(slotIndex: number, label: string) {
    if (!confirm(`Revoke "${label || `slot ${slotIndex}`}"? The client will lose access.`)) return
    updatingSlot = slotIndex
    try {
      await mgmtRevokeClient(slotIndex)
    } catch (e) {
      device.error = e instanceof Error ? e.message : 'Revoke failed'
    } finally {
      updatingSlot = null
    }
  }

  async function handleUpdate(slotIndex: number, changes: { label?: string; allowed_kinds?: number[]; auto_approve?: boolean }) {
    updatingSlot = slotIndex
    try {
      await mgmtUpdateClient(slotIndex, changes)
    } catch (e) {
      device.error = e instanceof Error ? e.message : 'Update failed'
    } finally {
      updatingSlot = null
    }
  }

  async function copy(text: string, which: 'uri' | 'secret') {
    try {
      await navigator.clipboard.writeText(text)
      copied = which
      setTimeout(() => { if (copied === which) copied = null }, 1800)
    } catch { /* ignore */ }
  }

  function shortPubkey(hex: string): string {
    return hex.slice(0, 8) + ' · ' + hex.slice(-8)
  }
</script>

<div class="relay-clients">
  <div class="head">
    <h2>Clients</h2>
    <div class="head-controls">
      <span class="status">{device.slots.length} slot{device.slots.length === 1 ? '' : 's'} · {transportLabel}</span>
      <button class="btn-refresh" onclick={() => refreshSlots()}>Refresh</button>
    </div>
  </div>

  <!-- New connection -->
  <section class="new-connection">
    {#if created}
      <div class="created">
        <div class="created-head">
          <span class="dot"></span>
          <span class="created-title">Connection ready{created.signing_approved ? ' · auto-signs' : ''}</span>
          <button class="btn-text btn-muted" onclick={() => (created = null)}>Dismiss</button>
        </div>
        <p class="hint">Paste this bunker URI into the client. It carries the slot secret — shown once.</p>
        {#if created.bunker_uri}
          <div class="uri-box">
            <code>{created.bunker_uri}</code>
            <button class="btn-copy" class:copied={copied === 'uri'} onclick={() => copy(created!.bunker_uri, 'uri')}>
              {copied === 'uri' ? 'Copied' : 'Copy'}
            </button>
          </div>
        {:else}
          <p class="warn">Created, but no bunker URI yet — this device has no relay configured.
            Flash it in wifi mode (or set a relay) so clients can reach it; the secret is
            <code class="inline-secret">{created.secret}</code>.</p>
        {/if}
        {#if !created.signing_approved}
          <p class="warn">Signing not yet approved — this client can connect but its first sign needs
            {overUsb ? 'one physical PRG press on the device' : 'approval (tick “Pre-approve signing”, use Approve signing below, or one PRG press)'}.</p>
        {/if}
      </div>
    {:else}
      <form class="create-form" onsubmit={(e) => { e.preventDefault(); handleCreate() }}>
        <input
          type="text"
          bind:value={newLabel}
          placeholder="Name this connection (e.g. bark-macbook)"
          disabled={creating}
        />
        <button type="submit" class="btn-primary" disabled={creating || !newLabel.trim()}>
          {creating ? 'Creating…' : 'New connection'}
        </button>
      </form>
      {#if canApprove}
        <label class="approve-toggle">
          <input type="checkbox" bind:checked={preApprove} disabled={creating} />
          <span>Pre-approve signing — client auto-signs once it connects (operator authority, no button)</span>
        </label>
      {:else}
        <p class="usb-note">USB-direct: the first management action prompts a PRG press to pair this browser,
          and the client's first sign is approved by a physical press.</p>
      {/if}
      {#if createError}<p class="form-error">{createError}</p>{/if}
    {/if}
  </section>

  <!-- Existing clients -->
  {#if device.slots.length === 0}
    <p class="empty">No clients yet. Create one above.</p>
  {:else}
    <section class="approved">
      <h3 class="section-label">Connected slots</h3>
      {#each device.slots as slot (slot.slot_index)}
        <div class="client-card">
          <div class="client-row">
            <div class="client-identity">
              <span class="client-name">{slot.label || `slot ${slot.slot_index}`}</span>
              {#if slot.current_pubkey}
                <span class="client-pk">{shortPubkey(slot.current_pubkey)}</span>
              {:else}
                <span class="client-pk dim">unbound — waiting for client to connect</span>
              {/if}
            </div>
            <div class="client-actions">
              {#if slot.signing_approved}
                <span class="tag tag--blue">SIGNED</span>
              {:else if canApprove}
                <button class="btn-approve" disabled={approvingSlot === slot.slot_index} onclick={() => handleApprove(slot.slot_index)}>
                  {approvingSlot === slot.slot_index ? 'Approving…' : 'Approve signing'}
                </button>
              {:else}
                <span class="tag" title="First sign approved by a physical PRG press">BUTTON</span>
              {/if}
              <button
                class="tag tag--toggle"
                class:on={slot.auto_approve}
                disabled={updatingSlot === slot.slot_index}
                onclick={() => handleUpdate(slot.slot_index, { auto_approve: !slot.auto_approve })}
              >
                {slot.auto_approve ? 'AUTO' : 'MANUAL'}
              </button>
              <button class="btn-revoke" disabled={updatingSlot === slot.slot_index} onclick={() => handleRevoke(slot.slot_index, slot.label)}>
                Revoke
              </button>
            </div>
          </div>
          <KindPermissions
            allowedKinds={slot.allowed_kinds}
            unrestricted={slot.allowed_kinds.length === 0}
            signingApproved={slot.signing_approved}
            updating={updatingSlot === slot.slot_index}
            onchange={(kinds) => handleUpdate(slot.slot_index, { allowed_kinds: kinds ?? [] })}
          />
        </div>
      {/each}
    </section>
  {/if}
</div>

<style>
  .relay-clients { display: flex; flex-direction: column; gap: 1.5rem; }
  .head { display: flex; justify-content: space-between; align-items: center; }
  h2 { font-size: 1.3rem; font-weight: 600; margin: 0; color: #fff; }
  .head-controls { display: flex; align-items: center; gap: 0.75rem; }
  .status { font-size: 0.8rem; color: var(--text-muted); }

  .btn-refresh {
    background: transparent; border: 1px solid var(--border-bright); color: var(--text-dim);
    padding: 0.4rem 1rem; border-radius: 4px; font-family: inherit; font-size: 0.85rem; cursor: pointer;
  }
  .btn-refresh:hover { color: var(--text); border-color: #444; }

  .new-connection {
    background: var(--surface-raised); border: 1px solid var(--border-bright);
    border-radius: 6px; padding: 1.25rem;
  }
  .create-form { display: flex; gap: 0.5rem; align-items: center; }
  .create-form input {
    background: #0e0e0e; border: 1px solid #3a3a3a; color: #eee;
    padding: 0.5rem 0.75rem; border-radius: 4px; font-family: inherit; font-size: 0.9rem; flex: 1;
  }
  .create-form input:focus { outline: none; border-color: var(--green); }
  .create-form input::placeholder { color: #666; }

  .approve-toggle {
    display: flex; gap: 0.5rem; align-items: flex-start; margin-top: 0.75rem;
    font-size: 0.78rem; color: var(--text-dim); line-height: 1.4;
  }
  .approve-toggle input { margin-top: 0.15rem; accent-color: var(--green); }
  .usb-note { font-size: 0.75rem; color: var(--text-dim); margin: 0.6rem 0 0; line-height: 1.4; }
  .inline-secret { color: var(--green); word-break: break-all; user-select: all; }

  .btn-primary {
    background: var(--green); color: #050505; border: none; padding: 0.5rem 1.25rem;
    border-radius: 4px; font-family: inherit; font-size: 0.85rem; font-weight: 600;
    cursor: pointer; white-space: nowrap; transition: background 0.15s, box-shadow 0.15s;
  }
  .btn-primary:hover:not(:disabled) { background: #00ff88; box-shadow: var(--green-glow); }
  .btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }

  .form-error { font-size: 0.8rem; color: var(--red); margin: 0.5rem 0 0; }

  .created { display: flex; flex-direction: column; gap: 0.5rem; }
  .created-head { display: flex; align-items: center; gap: 0.5rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px rgba(0,232,123,0.5); }
  .created-title { font-weight: 600; font-size: 0.9rem; color: var(--green); flex: 1; }
  .hint { font-size: 0.85rem; color: var(--text-dim); margin: 0; }
  .warn { font-size: 0.78rem; color: var(--amber); margin: 0.25rem 0 0; line-height: 1.4; }

  .uri-box {
    display: flex; align-items: flex-start; gap: 0.75rem; background: #061a0c;
    border: 1px solid var(--green-dim); border-radius: 4px; padding: 0.75rem 1rem; margin-top: 0.25rem;
  }
  .uri-box code { font-size: 0.8rem; color: var(--green); word-break: break-all; line-height: 1.5; flex: 1; user-select: all; }

  .btn-copy {
    background: var(--green); color: #050505; border: none; padding: 0.4rem 1rem; border-radius: 4px;
    font-family: inherit; font-size: 0.8rem; font-weight: 600; cursor: pointer; flex-shrink: 0; transition: background 0.15s;
  }
  .btn-copy:hover { background: #00ff88; }
  .btn-copy.copied { background: var(--green-dim); }

  .section-label {
    font-size: 0.75rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--text-muted); margin: 0 0 0.75rem;
  }

  .client-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 1rem 1.25rem; margin-bottom: 0.5rem;
  }
  .client-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .client-identity { min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }
  .client-name { color: #fff; font-size: 1rem; font-weight: 600; }
  .client-pk { font-size: 0.8rem; color: var(--text-muted); letter-spacing: 0.02em; }
  .client-pk.dim { color: #555; font-style: italic; }
  .client-actions { display: flex; gap: 0.4rem; flex-shrink: 0; align-items: center; }

  .tag {
    padding: 0.3rem 0.75rem; border-radius: 3px; font-family: inherit; font-size: 0.75rem;
    font-weight: 600; letter-spacing: 0.08em; border: 1px solid;
    background: #1a0e00; border-color: #3a2200; color: var(--amber);
  }
  .tag.on { background: #001a0a; border-color: #003a1a; color: var(--green); }
  .tag--blue { background: #001520; border-color: #003a5c; color: #44aaee; }
  .tag--toggle { cursor: pointer; transition: all 0.12s; }
  .tag--toggle:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-revoke {
    background: none; border: none; color: var(--red); font-family: inherit;
    font-size: 0.8rem; cursor: pointer; padding: 0.3rem 0.5rem; border-radius: 3px;
  }
  .btn-revoke:hover:not(:disabled) { background: #1a0808; }
  .btn-revoke:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-approve {
    background: #001a0a; border: 1px solid var(--green-dim); color: var(--green);
    border-radius: 3px; padding: 0.35rem 0.85rem; font-family: inherit; font-size: 0.8rem;
    font-weight: 600; cursor: pointer; transition: all 0.12s;
  }
  .btn-approve:hover:not(:disabled) { background: #002a12; border-color: var(--green); }
  .btn-approve:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-text { background: none; border: none; font-family: inherit; font-size: 0.8rem; cursor: pointer; padding: 0.3rem 0.5rem; }
  .btn-muted { color: var(--text-muted); }
  .btn-muted:hover { color: var(--text-dim); }

  .empty { color: var(--text-muted); font-size: 0.95rem; text-align: center; padding: 2rem 0; }

  /* Mobile: stack the create form, wrap client rows, full-width copy/URI. */
  @media (max-width: 640px) {
    .head { flex-wrap: wrap; gap: 0.5rem; }
    .create-form { flex-direction: column; align-items: stretch; }
    .create-form .btn-primary { width: 100%; }
    .client-row { flex-wrap: wrap; }
    .client-actions { width: 100%; justify-content: flex-end; }
    .uri-box { flex-direction: column; }
    .uri-box .btn-copy { width: 100%; }
  }
</style>

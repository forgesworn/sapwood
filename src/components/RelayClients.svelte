<script lang="ts">
  import { device, refreshSlots, relayCreateClient, relayApproveSigning } from '../lib/device.svelte.js'

  let creating = $state(false)
  let newLabel = $state('')
  let preApprove = $state(true)
  let createError = $state<string | null>(null)

  // The created connection — the ONE time the secret/URI is shown.
  let created = $state<{ bunker_uri: string; secret: string; signing_approved: boolean } | null>(null)
  let copied = $state<'uri' | 'secret' | null>(null)
  let approvingSlot = $state<number | null>(null)

  async function handleCreate() {
    const label = newLabel.trim()
    if (!label) { createError = 'Name is required.'; return }
    creating = true
    createError = null
    created = null
    try {
      const res = await relayCreateClient(label, preApprove)
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
      await relayApproveSigning(slotIndex)
    } catch (e) {
      device.error = e instanceof Error ? e.message : 'Approve failed'
    } finally {
      approvingSlot = null
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
      {#if device.relayStatus}
        <span class="status">{device.relayStatus.slots} slot{device.relayStatus.slots === 1 ? '' : 's'} · over relay</span>
      {/if}
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
        <div class="uri-box">
          <code>{created.bunker_uri}</code>
          <button class="btn-copy" class:copied={copied === 'uri'} onclick={() => copy(created!.bunker_uri, 'uri')}>
            {copied === 'uri' ? 'Copied' : 'Copy'}
          </button>
        </div>
        {#if !created.signing_approved}
          <p class="warn">Signing not yet approved — this client can connect but its first sign needs
            approval (tick “Pre-approve signing”, use <em>Approve signing</em> below, or one physical PRG press).</p>
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
      <label class="approve-toggle">
        <input type="checkbox" bind:checked={preApprove} disabled={creating} />
        <span>Pre-approve signing — client auto-signs once it connects (operator authority, no button)</span>
      </label>
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
            {:else}
              <button class="btn-approve" disabled={approvingSlot === slot.slot_index} onclick={() => handleApprove(slot.slot_index)}>
                {approvingSlot === slot.slot_index ? 'Approving…' : 'Approve signing'}
              </button>
            {/if}
            <span class="tag" class:on={slot.auto_approve}>{slot.auto_approve ? 'AUTO' : 'MANUAL'}</span>
          </div>
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
    display: flex; justify-content: space-between; align-items: center; gap: 1rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 1rem 1.25rem; margin-bottom: 0.5rem;
  }
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
</style>

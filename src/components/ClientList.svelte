<script lang="ts">
  import { device, refreshClients, serialTransport, httpTransport } from '../lib/device.svelte.js'
  import { FrameType, buildPolicyRevoke, buildPolicyUpdate } from '../lib/frame.js'
  import { resolveProfiles, type Profile } from '../lib/profiles.js'
  import { kindLabel } from '../lib/kinds.js'
  import type { ClientPolicy } from '../lib/types.js'

  let profiles = $state(new Map<string, Profile>())
  let loadingProfiles = $state(false)

  $effect(() => { if (device.connected) refreshClients() })

  $effect(() => {
    if (device.clients.length > 0) loadProfiles()
  })

  async function loadProfiles() {
    const pubkeys = device.clients.map(c => c.client_pubkey)
    if (pubkeys.length === 0) return
    loadingProfiles = true
    try { profiles = await resolveProfiles(pubkeys) } catch { /* fallback to hex */ }
    finally { loadingProfiles = false }
  }

  function clientName(pubkey: string): string {
    const p = profiles.get(pubkey)
    return p?.display_name || p?.name || pubkey.slice(0, 12) + '...'
  }

  function clientNip05(pubkey: string): string | null {
    return profiles.get(pubkey)?.nip05 ?? null
  }

  async function handleRevoke(pubkey: string) {
    if (!confirm(`Revoke ${clientName(pubkey)}?`)) return
    try {
      const frame = device.mode === 'http'
        ? await httpTransport.revokeClient(device.selectedSlot, pubkey)
        : await serialTransport.sendAndReceive(buildPolicyRevoke(device.selectedSlot, pubkey), [FrameType.ACK, FrameType.NACK])
      if (frame.type === FrameType.NACK) device.error = 'Revoke rejected.'
      await refreshClients()
    } catch (e) { device.error = e instanceof Error ? e.message : 'Revoke failed' }
  }

  async function handleUpdate(client: ClientPolicy, changes: Partial<ClientPolicy>) {
    const updated = { ...client, ...changes }
    try {
      const frame = device.mode === 'http'
        ? await httpTransport.updateClient(device.selectedSlot, updated)
        : await serialTransport.sendAndReceive(buildPolicyUpdate(device.selectedSlot, JSON.stringify(updated)), [FrameType.ACK, FrameType.NACK])
      if (frame.type === FrameType.NACK) device.error = 'Update rejected.'
      await refreshClients()
    } catch (e) { device.error = e instanceof Error ? e.message : 'Update failed' }
  }

  function handleSlotChange(e: Event) {
    device.selectedSlot = parseInt((e.target as HTMLSelectElement).value)
    refreshClients(device.selectedSlot)
  }
</script>

<div class="client-list">
  <div class="header-row">
    <h2>
      Approved Clients
      {#if loadingProfiles}
        <span class="resolving">resolving...</span>
      {/if}
    </h2>
    <label class="slot-pick">
      SLOT
      <select value={device.selectedSlot} onchange={handleSlotChange}>
        {#each [0, 1, 2, 3, 4, 5, 6, 7] as s}
          <option value={s}>{s}</option>
        {/each}
      </select>
    </label>
  </div>

  {#if !device.connected}
    <p class="empty">Connect to view clients.</p>
  {:else if device.clients.length === 0}
    <p class="empty">No approved clients for slot {device.selectedSlot}.</p>
  {:else}
    {#each device.clients as client}
      {@const profile = profiles.get(client.client_pubkey)}
      <div class="card">
        <div class="card-top">
          <div class="identity">
            {#if profile?.picture}
              <img class="avatar" src={profile.picture} alt="" />
            {:else}
              <div class="avatar-placeholder"></div>
            {/if}
            <div class="identity-text">
              <span class="name">{clientName(client.client_pubkey)}</span>
              {#if clientNip05(client.client_pubkey)}
                <span class="nip05">{clientNip05(client.client_pubkey)}</span>
              {:else}
                <span class="pubkey-short">{client.client_pubkey.slice(0, 20)}...</span>
              {/if}
            </div>
          </div>
          <div class="actions">
            <button
              class="badge"
              class:on={client.auto_approve}
              onclick={() => handleUpdate(client, { auto_approve: !client.auto_approve })}
            >
              {client.auto_approve ? 'AUTO' : 'MANUAL'}
            </button>
            <button class="btn-revoke" onclick={() => handleRevoke(client.client_pubkey)}>
              Revoke
            </button>
          </div>
        </div>

        <div class="card-meta">
          {#if client.allowed_kinds.length > 0}
            <div class="kinds">
              {#each client.allowed_kinds as kind}
                <span class="kind-tag">{kindLabel(kind)}</span>
              {/each}
            </div>
          {:else}
            <span class="all-kinds">All event kinds</span>
          {/if}
        </div>
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

  h2 {
    font-size: 1.3rem;
    font-weight: 600;
    margin: 0;
    color: #fff;
  }

  .resolving {
    font-size: 0.8rem;
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 0.5rem;
  }

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

  .identity {
    display: flex;
    align-items: center;
    gap: 1rem;
    min-width: 0;
  }

  .avatar {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
    border: 2px solid var(--border-bright);
  }

  .avatar-placeholder {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    background: var(--surface-hover);
    border: 2px solid var(--border);
    flex-shrink: 0;
  }

  .identity-text { min-width: 0; }

  .name {
    display: block;
    font-size: 1.1rem;
    font-weight: 600;
    color: #fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nip05 {
    display: block;
    font-size: 0.85rem;
    color: var(--green-dim);
  }

  .pubkey-short {
    display: block;
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
    align-items: center;
  }

  .badge {
    background: #1a0e00;
    border: 1px solid #442800;
    color: var(--amber);
    padding: 0.35rem 0.85rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    cursor: pointer;
    transition: all 0.15s;
  }

  .badge.on {
    background: #001a0a;
    border-color: #004422;
    color: var(--green);
  }

  .btn-revoke {
    background: transparent;
    border: 1px solid #442222;
    color: var(--red);
    padding: 0.35rem 0.85rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-revoke:hover { background: #1a0808; }

  .card-meta {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .kinds { display: flex; gap: 0.4rem; flex-wrap: wrap; }

  .kind-tag {
    background: var(--surface-hover);
    border: 1px solid var(--border-bright);
    border-radius: 3px;
    padding: 0.2rem 0.6rem;
    font-size: 0.8rem;
    color: var(--text-dim);
  }

  .all-kinds {
    font-size: 0.85rem;
    color: var(--text-muted);
    font-style: italic;
  }

  .empty { color: var(--text-muted); font-size: 1rem; }
</style>

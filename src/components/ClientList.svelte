<script lang="ts">
  import { device, refreshClients, serialTransport, httpTransport } from '../lib/device.svelte.js'
  import { FrameType, buildPolicyRevoke, buildPolicyUpdate } from '../lib/frame.js'
  import { resolveProfiles, type Profile } from '../lib/profiles.js'
  import { kindLabel } from '../lib/kinds.js'
  import KindPermissions from './KindPermissions.svelte'
  import type { ClientPolicy } from '../lib/types.js'

  let profiles = $state(new Map<string, Profile>())
  let editingLabel = $state<string | null>(null)
  let labelInput = $state('')

  $effect(() => { if (device.connected) refreshClients() })

  $effect(() => {
    if (device.clients.length > 0) {
      const pubkeys = device.clients.map(c => c.client_pubkey)
      resolveProfiles(pubkeys).then(p => { profiles = p }).catch(() => {})
    }
  })

  function displayName(client: ClientPolicy): string {
    if (client.label) return client.label
    const p = profiles.get(client.client_pubkey)
    if (p?.display_name) return p.display_name
    if (p?.name) return p.name
    return 'Unknown client'
  }

  function startEditLabel(pubkey: string, currentLabel: string) {
    editingLabel = pubkey
    labelInput = currentLabel
  }

  async function saveLabel(client: ClientPolicy) {
    await handleUpdate(client, { label: labelInput })
    editingLabel = null
    labelInput = ''
  }

  async function handleRevoke(client: ClientPolicy) {
    const name = displayName(client)
    if (!confirm(`Revoke ${name}?`)) return
    try {
      const frame = device.mode === 'http'
        ? await httpTransport.revokeClient(device.selectedSlot, client.client_pubkey)
        : await serialTransport.sendAndReceive(buildPolicyRevoke(device.selectedSlot, client.client_pubkey), [FrameType.ACK, FrameType.NACK])
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

  function shortPubkey(hex: string): string {
    return hex.slice(0, 8) + '...' + hex.slice(-8)
  }
</script>

<div class="client-list">
  <div class="header-row">
    <h2>Approved Clients</h2>
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
    {#each device.clients as client, i}
      {@const profile = profiles.get(client.client_pubkey)}
      <div class="card">
        <div class="card-top">
          <div class="card-left">
            <span class="client-num">#{i + 1}</span>
            {#if profile?.picture}
              <img class="avatar" src={profile.picture} alt="" />
            {/if}
            <div class="client-info">
              {#if editingLabel === client.client_pubkey}
                <form class="label-edit" onsubmit={(e) => { e.preventDefault(); saveLabel(client) }}>
                  <input
                    type="text"
                    bind:value={labelInput}
                    placeholder="e.g. Nostrudel, Coracle, Bark..."
                    autofocus
                  />
                  <button type="submit" class="label-save">Save</button>
                  <button type="button" class="label-cancel" onclick={() => editingLabel = null}>Cancel</button>
                </form>
              {:else}
                <span class="client-name" onclick={() => startEditLabel(client.client_pubkey, client.label)}>
                  {displayName(client)}
                  <span class="edit-hint">edit</span>
                </span>
              {/if}
              <span class="pubkey">{shortPubkey(client.client_pubkey)}</span>
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
            <button class="btn-revoke" onclick={() => handleRevoke(client)}>
              Revoke
            </button>
          </div>
        </div>

        <KindPermissions
          allowedKinds={client.allowed_kinds}
          unrestricted={client.allowed_kinds.length === 0}
          onchange={(kinds) => handleUpdate(client, { allowed_kinds: kinds })}
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

  .client-num {
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--text-muted);
    min-width: 2rem;
  }

  .avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
    border: 2px solid var(--border-bright);
  }

  .client-info { min-width: 0; }

  .client-name {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.15rem;
    font-weight: 600;
    color: #fff;
    cursor: pointer;
  }

  .client-name:hover .edit-hint { opacity: 1; }

  .edit-hint {
    font-size: 0.7rem;
    font-weight: 400;
    color: var(--text-muted);
    opacity: 0;
    transition: opacity 0.15s;
    letter-spacing: 0.05em;
  }

  .pubkey {
    display: block;
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-top: 0.15rem;
    letter-spacing: 0.03em;
  }

  .label-edit {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .label-edit input {
    background: #080808;
    border: 1px solid var(--green-dim);
    color: var(--text);
    padding: 0.4rem 0.75rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 1rem;
    width: 250px;
  }

  .label-edit input:focus { outline: none; border-color: var(--green); }
  .label-edit input::placeholder { color: #444; }

  .label-save {
    background: var(--green);
    color: #050505;
    border: none;
    padding: 0.4rem 0.85rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }

  .label-cancel {
    background: none;
    border: none;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    padding: 0.4rem 0.5rem;
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
    padding: 0.4rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
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
    padding: 0.4rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-revoke:hover { background: #1a0808; }

  .card-meta {
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* kind permissions handled by KindPermissions component */

  .empty { color: var(--text-muted); font-size: 1.1rem; }
</style>

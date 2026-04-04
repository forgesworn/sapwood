<script lang="ts">
  import { device, refreshClients, transport } from '../lib/device.svelte.js'
  import { FrameType, buildPolicyRevoke, buildPolicyUpdate } from '../lib/frame.js'
  import type { ClientPolicy } from '../lib/types.js'

  $effect(() => {
    if (device.connected) refreshClients()
  })

  async function handleRevoke(pubkey: string) {
    const short = pubkey.slice(0, 16)
    if (!confirm(`Revoke client ${short}...?`)) return
    try {
      const frame = await transport.sendAndReceive(
        buildPolicyRevoke(device.selectedSlot, pubkey),
        [FrameType.ACK, FrameType.NACK],
      )
      if (frame.type === FrameType.NACK) {
        device.error = 'Revoke rejected by device.'
      }
      await refreshClients()
    } catch (e) {
      device.error = e instanceof Error ? e.message : 'Revoke failed'
    }
  }

  async function handleUpdate(client: ClientPolicy, changes: Partial<ClientPolicy>) {
    const updated = { ...client, ...changes }
    try {
      const frame = await transport.sendAndReceive(
        buildPolicyUpdate(device.selectedSlot, JSON.stringify(updated)),
        [FrameType.ACK, FrameType.NACK],
      )
      if (frame.type === FrameType.NACK) {
        device.error = 'Update rejected by device.'
      }
      await refreshClients()
    } catch (e) {
      device.error = e instanceof Error ? e.message : 'Update failed'
    }
  }

  function handleSlotChange(e: Event) {
    device.selectedSlot = parseInt((e.target as HTMLSelectElement).value)
    refreshClients(device.selectedSlot)
  }
</script>

<div class="client-list">
  <div class="header-row">
    <h2>Approved Clients</h2>
    <label class="slot-select">
      Slot
      <select value={device.selectedSlot} onchange={handleSlotChange}>
        {#each [0, 1, 2, 3, 4, 5, 6, 7] as s}
          <option value={s}>{s}</option>
        {/each}
      </select>
    </label>
  </div>

  {#if !device.connected}
    <p class="muted">Connect to view clients.</p>
  {:else if device.clients.length === 0}
    <p class="muted">No approved clients for slot {device.selectedSlot}.</p>
  {:else}
    {#each device.clients as client}
      <div class="client-card">
        <div class="client-header">
          <span class="pubkey" title={client.client_pubkey}>
            {client.client_pubkey.slice(0, 16)}...
          </span>
          <div class="actions">
            <button
              class="toggle"
              class:on={client.auto_approve}
              onclick={() => handleUpdate(client, { auto_approve: !client.auto_approve })}
            >
              {client.auto_approve ? 'auto' : 'manual'}
            </button>
            <button class="revoke" onclick={() => handleRevoke(client.client_pubkey)}>
              Revoke
            </button>
          </div>
        </div>
        {#if client.label}
          <div class="label">{client.label}</div>
        {/if}
        <div class="meta">
          {#if client.allowed_methods.length > 0}
            <span>{client.allowed_methods.join(', ')}</span>
          {/if}
          {#if client.allowed_kinds.length > 0}
            <span>kinds: {client.allowed_kinds.join(', ')}</span>
          {/if}
        </div>
      </div>
    {/each}
  {/if}
</div>

<style>
  .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  h2 { font-size: 1rem; font-weight: 600; margin: 0; color: #ccc; }
  .slot-select { font-size: 0.8rem; color: #666; }
  .slot-select select {
    background: #111; border: 1px solid #333; color: #ccc;
    padding: 0.2rem 0.4rem; border-radius: 3px; font-family: inherit; font-size: 0.8rem;
  }
  .client-card {
    background: #111; border: 1px solid #222; border-radius: 4px;
    padding: 0.75rem; margin-bottom: 0.5rem;
  }
  .client-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.25rem; }
  .pubkey { font-size: 0.8rem; color: #aaa; }
  .actions { display: flex; gap: 0.25rem; }
  .toggle, .revoke {
    background: none; border: 1px solid #333; padding: 0.15rem 0.5rem;
    border-radius: 3px; font-family: inherit; font-size: 0.7rem; cursor: pointer;
  }
  .toggle { color: #a93; border-color: #533; }
  .toggle.on { color: #4a9; border-color: #354; }
  .revoke { color: #a44; border-color: #633; }
  .revoke:hover { background: #211; }
  .label { color: #888; font-size: 0.8rem; margin-bottom: 0.25rem; }
  .meta { display: flex; gap: 0.75rem; font-size: 0.7rem; color: #555; }
  .muted { color: #555; font-size: 0.85rem; }
</style>

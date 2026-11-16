<script lang="ts">
  import { device, refreshMasters, serialWrappedAccount } from '../lib/device.svelte.js'
  import { validWrappedRecord, type WrappedSlot } from '../lib/wrapped-account.js'
  let rootSlot = $state('')
  let targetSlot = $state('')
  let expected = $state('')
  let record = $state('')
  let label = $state('')
  let busy = $state(false)
  let status = $state('')
  let error = $state('')
  let checked = $state('')
  let fileSelection = 0
  const masters = $derived(device.masters.filter(m => !m.persona && m.mode !== undefined))
  const rawTargets = $derived(masters.filter(m => m.mode === 0 && String(m.slot) !== rootSlot))
  const destination = $derived(masters.length ? Math.max(...masters.map(m => m.slot)) + 1 : 0)
  const root = $derived(masters.find(m => String(m.slot) === rootSlot))
  const scope = $derived(JSON.stringify([root?.slot, root?.npub, root?.mode, expected, record]))
  const canRestore = $derived(checked === scope && !!label.trim() && destination < 8 && !masters.some(m => m.npub === expected))

  function reference(slot: string): WrappedSlot {
    const master = masters.find(m => String(m.slot) === slot)
    if (!master || master.mode === undefined) throw new Error('Choose an identity held on this signer.')
    return { slot: master.slot, npub: master.npub, mode: master.mode }
  }
  async function run(action: () => Promise<void>) {
    busy = true; status = ''; error = ''
    try { await action() } catch (e) { error = e instanceof Error ? e.message : 'The signer refused the operation.' }
    finally { busy = false }
  }
  async function download() {
    await run(async () => {
      const target = reference(targetSlot)
      const receipt = await serialWrappedAccount({ op: 'wrap', root: reference(rootSlot), target })
      if (!receipt.record) throw new Error('The signer did not return an encrypted file.')
      const url = URL.createObjectURL(new Blob([receipt.record], { type: 'text/plain' }))
      try {
        const link = document.createElement('a')
        link.href = url; link.download = 'imported-account.nstw'
        document.body.append(link); link.click(); link.remove()
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000) }
      expected = target.npub; checked = ''; record = ''
      status = 'Download started. Select the saved file below and check it on the signer.'
    })
  }
  async function selectFile(event: Event) {
    const selection = ++fileSelection
    checked = ''; record = ''; status = ''; error = ''
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    const file = input.files?.[0]
    if (!file) return
    try {
      if (file.size !== 181) throw new Error('Choose an unmodified 181-byte .nstw file.')
      const text = await file.text()
      if (selection !== fileSelection) return
      if (!validWrappedRecord(text)) throw new Error('Choose an unmodified 181-byte .nstw file.')
      record = text
    } catch (e) {
      if (selection === fileSelection) error = e instanceof Error ? e.message : 'Could not read the file.'
    }
  }
  async function check() {
    checked = ''
    const checkingScope = scope
    await run(async () => {
      const receipt = await serialWrappedAccount({ op: 'check', root: reference(rootSlot), record, expected_npub: expected })
      if (checkingScope !== scope) throw new Error('The selection changed. Check the saved file again.')
      checked = checkingScope
      status = `Saved file checked for ${receipt.npub}. Keep this encrypted file and the same root recovery backup.`
    })
  }
  async function restore() {
    if (!canRestore) return
    await run(async () => {
      const receipt = await serialWrappedAccount({ op: 'restore', root: reference(rootSlot), record, expected_npub: expected, destination, label: label.trim() })
      checked = ''
      status = `Restored ${receipt.npub} into raw-key slot ${receipt.slot}. Pair apps with this account separately.`
      try { await refreshMasters() } catch { /* WiFi firmware reboots after adding a master. */ }
    })
  }
</script>

<div class="wrapped-account">
  <p class="hint">Test-key preview. Recovery needs the same root and this encrypted file. The original account npub stays the same. Apps need their own pairing and approval.</p>
  {#if device.mode !== 'serial'}
    <p>Connect directly by USB to wrap, check or restore an account.</p>
  {:else}
    <fieldset disabled={busy || !device.connected}>
      <label class="field-label" for="wrapped-root">Recovery root</label>
      <select class="field-input" id="wrapped-root" bind:value={rootSlot}>
        <option value="">Choose the root held on this signer</option>
        {#each masters as master}<option value={String(master.slot)}>Slot {master.slot}: {master.label}</option>{/each}
      </select>
      {#if root}<p class="mono identity">{root.npub}</p>{/if}
      <label class="field-label" for="wrapped-target">Raw account to back up</label>
      <select class="field-input" id="wrapped-target" bind:value={targetSlot}>
        <option value="">Choose a separate raw-key slot</option>
        {#each rawTargets as master}<option value={String(master.slot)}>Slot {master.slot}: {master.label}</option>{/each}
      </select>
      <button class="btn btn-secondary" disabled={!root || !targetSlot} onclick={download}>Download encrypted account file</button>
      <label class="field-label" for="wrapped-file">Saved encrypted file</label>
      <input class="field-input" id="wrapped-file" type="file" accept=".nstw,text/plain" onchange={selectFile} />
      <label class="field-label" for="wrapped-expected">Expected account npub</label>
      <input class="field-input" id="wrapped-expected" bind:value={expected} placeholder="npub1…" spellcheck={false} />
      <button class="btn btn-secondary" disabled={!root || !record || !expected} onclick={check}>Check saved file on signer</button>
      <label class="field-label" for="wrapped-label">Restored account name</label>
      <input class="field-input" id="wrapped-label" bind:value={label} maxlength="32" />
      <p class="hint">Restore creates raw-key slot {destination}. Read the root, target npub and destination on the signer, then hold its button for 5 seconds. Existing slots and app permissions are preserved.</p>
      <button class="btn btn-primary" disabled={!canRestore} onclick={restore}>Restore into empty slot {destination}</button>
    </fieldset>
  {/if}
  {#if status}<p role="status" class="identity">{status}</p>{/if}
  {#if error}<p role="alert" class="error-text">{error}</p>{/if}
</div>

<style>
  fieldset { border: 0; padding: 0; display: grid; gap: 0.75rem; min-width: 0; }
  select, input { width: 100%; min-width: 0; box-sizing: border-box; }
  label { margin-top: 0.5rem; }
  .hint { font-size: 0.875rem; line-height: 1.5; color: var(--text-muted); }
  .identity { overflow-wrap: anywhere; }
  .btn { justify-self: start; max-width: 100%; white-space: normal; }
</style>

<script lang="ts">
  // Backup and restore the signer's app pairings (connection slots) and bridge
  // secret. These live only in device NVS, so a factory reset or reflash wipes
  // them and every app must re-pair. Export reads them out (button-confirmed on
  // the device) and encrypts them under a passphrase; import restores them after
  // the identities have been re-provisioned. USB only. The heavy lifting and the
  // crypto live in lib/backup.ts; this component is the form around it.
  import { device, serialTransport } from '../lib/device.svelte.js'
  import { npubToHex } from '../lib/known-devices.js'
  import {
    exportBackup, importBackup, matchBackup, encryptBackup, decryptBackup, parseBackupEnvelope,
    type BackupPayload, type BackupEnvelope, type MasterMatch, type DeviceMaster,
  } from '../lib/backup.js'

  // The provisioned masters, as backup match targets. Personas share their
  // owner's slot table, so they are excluded.
  const deviceMasters = $derived<DeviceMaster[]>(
    device.masters
      .filter((m) => !m.persona)
      .map((m) => ({ pubkeyHex: npubToHex(m.npub) ?? '', label: m.label }))
      .filter((m) => m.pubkeyHex.length > 0),
  )

  function triggerDownload(name: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
  }

  // --- Export ---
  let exportPass = $state('')
  let exportPass2 = $state('')
  let exporting = $state(false)
  let exportMsg = $state<string | null>(null)
  let exportErr = $state<string | null>(null)

  async function runExport() {
    exportErr = null
    exportMsg = null
    if (!exportPass) { exportErr = 'Enter a passphrase to encrypt the backup.'; return }
    if (exportPass !== exportPass2) { exportErr = 'The passphrases do not match.'; return }
    exporting = true
    try {
      const payload = await exportBackup(serialTransport)
      const envelope = encryptBackup(payload, exportPass)
      const slots = payload.masters.reduce((total, m) => total + m.connection_slots.length, 0)
      triggerDownload(`heartwood-backup-${payload.device_id.slice(0, 8) || 'signer'}.json`, JSON.stringify(envelope, null, 2))
      exportMsg = `Saved ${payload.masters.length} identities and ${slots} app slots. Keep the file and its passphrase together, and safe.`
      exportPass = ''
      exportPass2 = ''
    } catch (e) {
      exportErr = e instanceof Error ? e.message : 'The backup could not be exported.'
    } finally {
      exporting = false
    }
  }

  // --- Import ---
  let importFile = $state<File | null>(null)
  let importPass = $state('')
  let envelope = $state<BackupEnvelope | null>(null)
  let preview = $state<{ payload: BackupPayload; report: MasterMatch[] } | null>(null)
  let importing = $state(false)
  let importMsg = $state<string | null>(null)
  let importErr = $state<string | null>(null)

  const matchedSlots = $derived(
    preview ? preview.report.filter((r) => r.matched).reduce((total, r) => total + r.slots, 0) : 0,
  )

  function pickFile(e: Event) {
    importFile = (e.target as HTMLInputElement).files?.[0] ?? null
    envelope = null
    preview = null
    importMsg = null
    importErr = null
  }

  async function unlock() {
    importErr = null
    importMsg = null
    preview = null
    if (!importFile) { importErr = 'Choose a backup file first.'; return }
    if (!importPass) { importErr = 'Enter the backup passphrase.'; return }
    importing = true
    try {
      const env = envelope ?? parseBackupEnvelope(await importFile.text())
      envelope = env
      const payload = decryptBackup(env, importPass)
      const { report } = matchBackup(payload, deviceMasters)
      preview = { payload, report }
    } catch (e) {
      importErr = e instanceof Error ? e.message : 'The backup could not be read.'
    } finally {
      importing = false
    }
  }

  async function runImport() {
    if (!preview) return
    importErr = null
    importMsg = null
    importing = true
    try {
      const result = await importBackup(serialTransport, preview.payload, deviceMasters)
      importMsg = `Restored ${result.restored} app slots. The connected apps reconnect on their own.`
      preview = null
      importFile = null
      importPass = ''
      envelope = null
    } catch (e) {
      importErr = e instanceof Error ? e.message : 'The restore failed.'
    } finally {
      importing = false
    }
  }
</script>

<section class="backup-restore">
  <h2 class="section-title">Backup and restore</h2>
  <p class="hint">
    Save this signer's app pairings and bridge secret so they survive a factory reset or a reflash.
    Without a backup, every connected app has to pair again. The signer asks you to confirm on its
    button for both the export and the restore.
  </p>

  <!-- Export -->
  <div class="card sub">
    <h3 class="sub-title">Export a backup</h3>
    <p class="hint-sm">
      The file holds your app secrets. It is encrypted with the passphrase you set here, so choose a
      strong one and store it separately. Losing the passphrase makes the backup unrecoverable.
    </p>
    <div class="fields">
      <input class="field-input" type="password" bind:value={exportPass} placeholder="Passphrase"
        autocomplete="new-password" spellcheck="false" disabled={exporting} />
      <input class="field-input" type="password" bind:value={exportPass2} placeholder="Confirm passphrase"
        autocomplete="new-password" spellcheck="false" disabled={exporting} />
    </div>
    <button class="btn btn-primary" onclick={runExport} disabled={exporting}>
      {exporting ? 'Confirm on the signer…' : 'Export backup'}
    </button>
    {#if exporting}<p class="hint-sm">Press the button on the signer to approve the export.</p>{/if}
    {#if exportErr}<p class="hint-sm error-text">{exportErr}</p>{/if}
    {#if exportMsg}<p class="hint-sm success-text">{exportMsg}</p>{/if}
  </div>

  <!-- Import -->
  <div class="card sub">
    <h3 class="sub-title">Restore a backup</h3>
    <p class="hint-sm">
      Re-provision your identities first: a backup only restores app pairings for identities the
      signer already holds. Others are skipped.
    </p>
    <div class="fields">
      <input class="field-input file" type="file" accept=".json,application/json" onchange={pickFile} disabled={importing} />
      <input class="field-input" type="password" bind:value={importPass} placeholder="Backup passphrase"
        autocomplete="off" spellcheck="false" disabled={importing} />
    </div>

    {#if !preview}
      <button class="btn btn-secondary" onclick={unlock} disabled={importing || !importFile}>
        {importing ? 'Reading…' : 'Unlock and preview'}
      </button>
    {:else}
      <div class="report">
        {#each preview.report as row (row.pubkey)}
          <div class="report-row" class:matched={row.matched}>
            <span class="report-mark">{row.matched ? '✓' : '·'}</span>
            <span class="report-label">{row.label}</span>
            <span class="report-slots">
              {row.slots} slot{row.slots === 1 ? '' : 's'}{row.matched ? '' : ' · not on this signer, skipped'}
            </span>
          </div>
        {/each}
      </div>
      {#if matchedSlots > 0}
        <button class="btn btn-primary" onclick={runImport} disabled={importing}>
          {importing ? 'Confirm on the signer…' : `Restore ${matchedSlots} app slot${matchedSlots === 1 ? '' : 's'}`}
        </button>
        {#if importing}<p class="hint-sm">Press the button on the signer to approve the restore.</p>{/if}
      {:else}
        <p class="hint-sm error-text">None of this backup's identities are on the signer. Re-provision them, then unlock again.</p>
      {/if}
    {/if}
    {#if importErr}<p class="hint-sm error-text">{importErr}</p>{/if}
    {#if importMsg}<p class="hint-sm success-text">{importMsg}</p>{/if}
  </div>
</section>

<style>
  .backup-restore { display: flex; flex-direction: column; gap: 0.75rem; }
  .backup-restore .section-title, .backup-restore .hint { margin-bottom: 0; }
  .sub { padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: 0.6rem; }
  .sub-title { font-size: 0.98rem; font-weight: 600; color: #fff; margin: 0; }
  .fields { display: flex; flex-direction: column; gap: 0.4rem; }
  .fields .field-input { padding: 0.45rem 0.6rem; font-size: 0.85rem; }
  .field-input.file { padding: 0.35rem; color: var(--text-dim); }
  .sub .btn { align-self: flex-start; }
  .report {
    display: flex; flex-direction: column; gap: 0.25rem;
    background: #0a0a0a; border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem 0.8rem;
  }
  .report-row { display: flex; align-items: baseline; gap: 0.6rem; font-size: 0.82rem; color: var(--text-muted); }
  .report-row.matched { color: var(--text); }
  .report-mark { color: var(--text-muted); width: 1rem; flex-shrink: 0; }
  .report-row.matched .report-mark { color: var(--green); }
  .report-label { font-weight: 600; min-width: 0; }
  .report-slots { color: var(--text-muted); font-size: 0.78rem; }
</style>

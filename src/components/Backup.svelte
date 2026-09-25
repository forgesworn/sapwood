<script lang="ts">
  // Backup and restore the signer's app pairings (connection slots) and bridge
  // secret. These live only in device NVS, so a factory reset or reflash wipes
  // them and every app must re-pair. Export reads them out (button-confirmed on
  // the device) and encrypts them under a passphrase; import restores them after
  // the identities have been re-provisioned. USB only. The heavy lifting and the
  // crypto live in lib/backup.ts; this component is the form around it.
  import {
    device, serialTransport, ensureBridgeAuth, isThisBrowsersUsbPairing, forgetBridgeAuth,
  } from '../lib/device.svelte.js'
  import { npubToHex } from '../lib/known-devices.js'
  import { copyText } from '../lib/clipboard.js'
  import {
    exportBackup, importBackup, matchBackup, encryptBackup, decryptBackup, parseBackupEnvelope,
    inventoryReportFor, msatToSats,
    type BackupPayload, type BackupEnvelope, type MasterMatch, type DeviceMaster,
  } from '../lib/backup.js'
  import {
    markPairingBackupExported, pairingBackupStatus, type PairingBackupStatus,
  } from '../lib/pairing-backup.js'

  // The provisioned masters, as backup match targets. Personas share their
  // owner's slot table, so they are excluded.
  const deviceMasters = $derived<DeviceMaster[]>(
    device.masters
      .filter((m) => !m.persona)
      .map((m) => ({ pubkeyHex: npubToHex(m.npub) ?? '', label: m.label }))
      .filter((m) => m.pubkeyHex.length > 0),
  )
  const backupScope = $derived(device.masters
    .filter((master) => !master.persona)
    .map((master) => master.npub.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|'))
  let backupStatus = $state<PairingBackupStatus>({
    needsBackup: false, lastExportAt: null, lastMutationAt: null, lastExportSlotCount: null,
  })
  $effect(() => { backupStatus = pairingBackupStatus(backupScope) })

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
      // BACKUP_EXPORT and BACKUP_IMPORT both require an authenticated bridge
      // session. Without this the device NACKs, and lib/backup.ts reports it as
      // "confirm the prompt on its screen" -- but no prompt is ever shown, so
      // the operator holds a button against a card that does not exist.
      await ensureBridgeAuth()
      const payload = await exportBackup(serialTransport)
      const envelope = encryptBackup(payload, exportPass)
      const slots = payload.masters.reduce((total, m) => total + m.connection_slots.length, 0)
      const notes = payload.note_inventory?.length ?? 0
      triggerDownload(`heartwood-backup-${payload.device_id.slice(0, 8) || 'signer'}.json`, JSON.stringify(envelope, null, 2))
      // A browser download is only marked after the encrypted envelope has
      // been built. The signer export itself was button-confirmed above.
      markPairingBackupExported(backupScope, slots)
      backupStatus = pairingBackupStatus(backupScope)
      exportMsg = `Saved ${payload.masters.length} identities and ${slots} app slots${notes ? `, plus a non-spendable inventory of ${notes} note${notes === 1 ? '' : 's'}` : ''}. Keep the file and its passphrase together, and safe.`
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

  // --- Note inventory (display only: not a restore path) ---
  const inventory = $derived(preview?.payload.note_inventory ?? [])
  const inventoryReport = $derived(preview ? inventoryReportFor(preview.payload) : null)
  const inventoryUnreadable = $derived(preview?.payload.note_inventory_unreadable ?? 0)
  const inventoryTotalSats = $derived(inventory.reduce((total, n) => total + msatToSats(n.amount_msat), 0))

  let copiedCommitment = $state<string | null>(null)

  async function copyCommitment(id: string, commitment: string) {
    if (await copyText(commitment)) {
      copiedCommitment = id
      setTimeout(() => { if (copiedCommitment === id) copiedCommitment = null }, 1800)
    }
  }

  function truncateHex(hex: string): string {
    return hex.slice(0, 8) + '…' + hex.slice(-8)
  }

  function pickFile(e: Event) {
    importFile = (e.target as HTMLInputElement).files?.[0] ?? null
    envelope = null
    preview = null
    importMsg = null
    importErr = null
    copiedCommitment = null
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

  // A backup carries the USB pairing (bridge secret) of the board it came
  // from. When that is this browser's own pairing, sending it only costs the
  // owner a pointless second prompt, so it is left out. When it belongs to
  // another browser or a bridge daemon, installing it hands USB management
  // to them and locks this browser out, which the 2026-09-24 rehearsal did
  // without anyone meaning to. So it is opt-in, and off by default.
  const carriesOtherPairing = $derived(
    !!preview
    && /^[0-9a-f]{64}$/i.test(preview.payload.bridge_secret)
    && !isThisBrowsersUsbPairing(preview.payload.bridge_secret),
  )
  let installBackupPairing = $state(false)

  async function runImport() {
    if (!preview) return
    importErr = null
    importMsg = null
    importing = true
    try {
      await ensureBridgeAuth()
      const handOver = carriesOtherPairing && installBackupPairing
      const result = await importBackup(serialTransport, preview.payload, deviceMasters, { keepBridgeSecret: handOver })
      importMsg = `Restored ${result.restored} app slots. The connected apps reconnect on their own.`
      if (handOver) {
        forgetBridgeAuth()
        importMsg += ' If you approved “Replace bridge secret?”, the signer now takes USB management from the backup’s pairing, not from this browser.'
      }
      installBackupPairing = false
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

  interface Props {
    /** False when nested under a parent heading (e.g. a collapsible section summary). */
    heading?: boolean
  }
  let { heading = true }: Props = $props()
</script>

<section class="backup-restore">
  {#if heading}<h2 class="section-title">Backup and restore</h2>{/if}
  <p class="hint">
    Save this signer's app pairings and bridge secret so they survive a factory reset or a reflash.
    Without a backup, every connected app has to pair again. The signer asks you to confirm on its
    button for both the export and the restore.
  </p>
  {#if backupStatus.needsBackup}
    <p class="backup-warning" role="status">
      {#if backupStatus.lastExportAt}
        App pairings changed after this browser's last recorded backup. Export a fresh encrypted backup now.
      {:else}
        App pairings changed and this browser has not recorded an encrypted pairing backup. Export one now: without it, a reset means every app must pair again.
      {/if}
    </p>
  {/if}

  <!-- Export -->
  <div class="card sub">
    <h3 class="sub-title">Export a backup</h3>
    <p class="hint-sm">
      The file holds your app secrets. It is encrypted with the passphrase you set here, so choose a
      strong one and store it separately. Losing the passphrase makes the backup unrecoverable.
      Bearer notes are <strong>not</strong> in this backup: a note restored onto two signers could be
      spent twice. Newer signer firmware adds only a non-spendable note inventory (hash, mint, amount
      and state) so a board loss is visible; it cannot restore or redeem a note.
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
      {#if inventoryReport && (inventory.length > 0 || inventoryUnreadable > 0)}
        <div class="inventory">
          <p class="hint-sm">
            Notes held at export time, recorded below for legibility only. This is not a restore: the
            file holds no bearer secrets for these notes and cannot spend or redeem them.
          </p>
          {#if inventoryUnreadable > 0}
            <p class="hint-sm inventory-warning" role="status">
              Incomplete: the signer could not read {inventoryUnreadable} note{inventoryUnreadable === 1 ? '' : 's'} at export
              time, likely because it was locked. This list may be missing notes.
            </p>
          {/if}
          {#if inventoryReport.dropped > 0}
            <p class="hint-sm">
              {inventoryReport.dropped} inventory entr{inventoryReport.dropped === 1 ? 'y' : 'ies'} in this file could not
              be read and {inventoryReport.dropped === 1 ? 'was' : 'were'} dropped.
            </p>
          {/if}
          {#if inventory.length > 0}
            <div class="inventory-list">
              {#each inventory as note (note.id)}
                <div class="inventory-row">
                  <span class="inventory-amount">{msatToSats(note.amount_msat).toLocaleString()} sats</span>
                  <span class="inventory-host">{note.host}</span>
                  <span class="inventory-state">{note.state}</span>
                  {#if note.key_index !== null}<span class="inventory-tag">key note</span>{/if}
                </div>
              {/each}
            </div>
            <p class="hint-sm">
              Total: {inventoryTotalSats.toLocaleString()} sats across {inventory.length} note{inventory.length === 1 ? '' : 's'}.
            </p>
            <details class="inventory-details">
              <summary class="hint-sm">Technical detail</summary>
              {#each inventory as note (note.id)}
                <div class="inventory-tech-row">
                  <span class="inventory-tech-label">commitment</span>
                  <code class="inventory-tech-value">{truncateHex(note.commitment)}</code>
                  <button class="btn btn-secondary btn-sm" onclick={() => copyCommitment(note.id, note.commitment)}>
                    {copiedCommitment === note.id ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
              {/each}
            </details>
          {/if}
        </div>
      {/if}
      {#if matchedSlots > 0}
        {#if carriesOtherPairing}
          <label class="hint-sm pairing-choice">
            <input type="checkbox" bind:checked={installBackupPairing} disabled={importing} />
            Also install the USB pairing saved in this backup. It belongs to the browser or bridge that
            made the backup, not this one: only tick this if that bridge will manage this signer, because
            this browser then loses USB management of it until you pair it again.
          </label>
        {/if}
        <button class="btn btn-primary" onclick={runImport} disabled={importing}>
          {importing ? 'Confirm on the signer…' : `Restore ${matchedSlots} app slot${matchedSlots === 1 ? '' : 's'}`}
        </button>
        {#if importing}
          <p class="hint-sm">
            Hold the button on the signer when it shows “Restore {matchedSlots} slots?”{carriesOtherPairing && installBackupPairing ? ', then again for “Replace bridge secret?”' : ''}.
          </p>
        {/if}
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
  .backup-warning { margin: 0; color: var(--amber); font-weight: 600; }
  .pairing-choice { display: flex; gap: 0.5rem; align-items: flex-start; margin: 0; }
  .inventory {
    display: flex; flex-direction: column; gap: 0.4rem;
    background: #0a0a0a; border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem 0.8rem;
  }
  .inventory-warning { margin: 0; color: var(--amber); font-weight: 600; }
  .inventory-list { display: flex; flex-direction: column; gap: 0.3rem; }
  .inventory-row { display: flex; align-items: baseline; gap: 0.6rem; font-size: 0.82rem; color: var(--text); flex-wrap: wrap; }
  .inventory-amount { font-weight: 600; min-width: 5rem; }
  .inventory-host { color: var(--text-muted); }
  .inventory-state { color: var(--text-muted); font-size: 0.78rem; }
  .inventory-tag {
    font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--amber);
    border: 1px solid var(--amber); border-radius: 3px; padding: 0.05rem 0.35rem;
  }
  .inventory-details { font-size: 0.8rem; color: var(--text-muted); }
  .inventory-details summary { cursor: pointer; }
  .inventory-tech-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0; flex-wrap: wrap; }
  .inventory-tech-label { color: var(--text-muted); min-width: 5.5rem; }
  .inventory-tech-value { font-size: 0.78rem; }
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

<script lang="ts">
  // Device — everything about the hardware and how it's reached: connection
  // details, network mode, firmware, security (PIN, bridge secret), the bridge,
  // and the danger zone. Replaces the old Connectivity, Firmware and Danger
  // tabs plus the device half of Settings.
  import { tick } from 'svelte'
  import {
    device, serialTransport, httpTransport, bridgeRestart, mgmtRevokeClient,
    relaySetLogQuiet, ensureBridgeAuth, usbDisplayFlip, setDisplayFlip,
  } from '../lib/device.svelte.js'
  import { deviceSummaryRows, type DeviceSummaryInput, type SummaryRowId } from '../lib/device-summary.js'
  import { FrameType, buildSetPin, buildSetBridgeSecret, buildFactoryReset } from '../lib/frame.js'
  import { getFirmwareVersion } from '../lib/device.svelte.js'
  import { storageGauge } from '../lib/storage-gauge.js'
  import { describeReset, formatUptime, formatBytes } from '../lib/reset-reason.js'
  import { npubToHex } from '../lib/known-devices.js'
  import { copyText } from '../lib/clipboard.js'
  import {
    generateVaultKeyHex, loadVaultKey, storeVaultKey, removeVaultKey,
    normaliseVaultKeyHex, serialVaultSet,
  } from '../lib/vault.js'
  import { checkForUpdate, type UpdateCheck } from '../lib/update-check.js'
  import {
    PAIRING_BACKUP_EVENT, pairingBackupStatus, type PairingBackupStatus,
  } from '../lib/pairing-backup.js'
  import { inferUnlockMode, type UnlockMode } from '../lib/phone-unlock.js'
  import Connectivity from './Connectivity.svelte'
  import UnlockPhones from './UnlockPhones.svelte'
  import OtaUpdate from './OtaUpdate.svelte'
  import Backup from './Backup.svelte'
  import PasswordReveal from './PasswordReveal.svelte'
  import ConfirmButton from './ConfirmButton.svelte'

  const overUsb = $derived(device.mode === 'serial')
  const overBridge = $derived(device.mode === 'http')

  // The encrypted pairing backup covers every master held by the signer, not
  // only the selected slot. This scope carries public identifiers only; it is
  // used solely as a localStorage key for the non-secret freshness marker.
  const pairingBackupScope = $derived(device.masters
    .filter((master) => !master.persona)
    .map((master) => master.npub.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|'))
  let pairingBackup = $state<PairingBackupStatus>({
    needsBackup: false, lastExportAt: null, lastMutationAt: null, lastExportSlotCount: null,
  })
  $effect(() => {
    const refresh = () => { pairingBackup = pairingBackupStatus(pairingBackupScope) }
    refresh()
    if (typeof window === 'undefined') return
    window.addEventListener(PAIRING_BACKUP_EVENT, refresh)
    return () => window.removeEventListener(PAIRING_BACKUP_EVENT, refresh)
  })

  function backupTime(at: number): string {
    return new Date(at).toLocaleString()
  }

  function modeLabel(): string {
    if (device.mode === 'serial') return 'USB cable'
    if (device.mode === 'relay') return 'WiFi'
    if (device.mode === 'http') return 'Bridge'
    return 'Disconnected'
  }

  // Signer uptime + why it last restarted: over WiFi from get_status, over USB
  // from FIRMWARE_INFO. Turns "it keeps rebooting" from an anecdote into data —
  // a planned restart reads differently from a crash.
  let usbHealth = $state<{
    version?: string
    uptime_s?: number; last_reset?: string; crashed_during?: string
    max_sign_bytes?: number; max_sign_bytes_object?: number
    free_heap?: number; largest_block?: number
    nvs_used_entries?: number; nvs_free_entries?: number; nvs_total_entries?: number
  } | null>(null)
  $effect(() => {
    if (device.connected && device.mode === 'serial') {
      void getFirmwareVersion().then((info) => { usbHealth = info })
    } else {
      usbHealth = null
    }
  })

  // Screen orientation. Over the cable it is asked for (null: firmware that
  // predates it); over the relay it rides the status poll.
  let usbFlip = $state<boolean | null>(null)
  $effect(() => {
    if (device.connected && device.mode === 'serial') {
      void usbDisplayFlip().then((flip) => { usbFlip = flip })
    } else {
      usbFlip = null
    }
  })
  const screenFlip = $derived(
    device.mode === 'relay'
      ? (typeof device.relayStatus?.display_flip === 'boolean' ? device.relayStatus.display_flip : null)
      : device.mode === 'serial' ? usbFlip : null,
  )
  let flipPending = $state(false)
  async function turnScreen(flip: boolean) {
    flipPending = true
    try { usbFlip = await setDisplayFlip(flip) }
    catch (e) { device.error = e instanceof Error ? e.message : 'Could not turn the screen.' }
    finally { flipPending = false }
  }
  // Update nudge: firmware updating shouldn't rely on the owner scrolling to
  // the Firmware section unprompted. When the bundle is newer than what the
  // connected signer reports, a banner at the top points them there.
  let updateInfo = $state<UpdateCheck | null>(null)
  let firmwareSection = $state<HTMLElement | null>(null)
  const runningVersion = $derived(device.mode === 'relay'
    ? device.relayStatus?.version ?? null
    : usbHealth?.version ?? null)
  $effect(() => {
    const running = runningVersion
    if (!device.connected || !running) {
      updateInfo = null
      return
    }
    void checkForUpdate(running).then((check) => { updateInfo = check })
  })

  const health = $derived(device.mode === 'relay'
    ? { uptime_s: device.relayStatus?.uptime_s, last_reset: device.relayStatus?.last_reset, crashed_during: device.relayStatus?.crashed_during }
    : { uptime_s: usbHealth?.uptime_s, last_reset: usbHealth?.last_reset, crashed_during: usbHealth?.crashed_during })
  const lastReset = $derived(health.last_reset ? describeReset(health.last_reset) : null)

  // Firmware 0.13.8+ takes a deliberate restart when its relay service has
  // been unusable for minutes (heap too fragmented to dial or publish), and
  // names the reason. It arrives as a planned software restart, so surface it
  // distinctly: the signer healing itself, not a crash, not operator action.
  const recoveryReason = $derived(!lastReset?.crash && health.crashed_during?.startsWith('relay watchdog')
    ? health.crashed_during
    : null)

  // Live memory health. A largest block far below total free is a fragmented
  // heap — the condition behind the bulk-decrypt crashes. Flag it amber so it
  // is visible before it becomes a reboot.
  //
  // Relay reports it in get_status; over USB it now rides on FIRMWARE_INFO, so
  // this is no longer relay-only. That matters because USB is where someone
  // debugs a signer that is misbehaving.
  const freeHeap = $derived(device.mode === 'relay' ? device.relayStatus?.free_heap : usbHealth?.free_heap)
  const largestBlock = $derived(device.mode === 'relay' ? device.relayStatus?.largest_free_block : usbHealth?.largest_block)

  // The signer's structural signing ceiling. Worth showing plainly: a request
  // over it is refused, and without this the failure is a bare timeout.
  const maxSignBytes = $derived(usbHealth?.max_sign_bytes)
  const maxSignBytesObject = $derived(usbHealth?.max_sign_bytes_object)

  // Identity & app storage: one NVS pool shared by identities, personas, app
  // pairings and settings. Null on firmware that predates the stats.
  const storage = $derived(device.mode === 'relay'
    ? storageGauge(device.relayStatus?.nvs?.used_entries, device.relayStatus?.nvs?.total_entries)
    : storageGauge(usbHealth?.nvs_used_entries, usbHealth?.nvs_total_entries))
  const fragmented = $derived(typeof freeHeap === 'number' && typeof largestBlock === 'number'
    && freeHeap > 0 && largestBlock / freeHeap < 0.4)
  // The signer trimmed this poll to the vital fields because its heap was too
  // fragmented to transport the full status. The request log paused this poll
  // rather than the signer crashing — it resumes once the heap recovers.
  const trimmed = $derived(device.mode === 'relay' && device.relayStatus?.truncated === true)
  const kb = (n: number) => `${Math.round(n / 1024)} KB`

  // Quiet logging: warnings only, which also calms activity LEDs wired to the
  // log UART (the T-Display's blue light flashes with every log line).
  let logQuietPending = $state(false)
  async function setLogQuiet(quiet: boolean) {
    logQuietPending = true
    try { await relaySetLogQuiet(quiet) }
    catch (e) { device.error = e instanceof Error ? e.message : 'Could not change the log level.' }
    finally { logQuietPending = false }
  }

  // --- Boot PIN (USB only) ---
  let pinValue = $state('')
  let pinStatus = $state<string | null>(null)
  let pinPending = $state(false)
  let showPin = $state(false)

  async function handleSetPin() {
    if (pinValue && (pinValue.length < 4 || pinValue.length > 8 || !/^\d+$/.test(pinValue))) {
      pinStatus = 'PIN must be 4–8 digits, or empty to clear.'
      return
    }
    pinPending = true
    pinStatus = null
    try {
      const frame = await serialTransport.sendAndReceive(
        buildSetPin(pinValue),
        [FrameType.ACK, FrameType.NACK],
        60_000,
      )
      pinStatus = frame.type === FrameType.ACK
        ? (pinValue ? 'PIN set.' : 'PIN cleared. The signer stores its keys in plaintext again, and no phone can unlock it.')
        : 'The device rejected the PIN change.'
      if (frame.type === FrameType.ACK) {
        encryptionKnown = !!pinValue
        // Clearing turns encryption off whichever secret held it, so a vault
        // key this browser kept no longer opens anything.
        if (!pinValue && vaultDeviceKey) { removeVaultKey(vaultDeviceKey); vaultStored = null }
        phonesRefresh++
      }
      pinValue = ''
      clearPinAck = false
      clearPinConfirming = false
    } catch (e) {
      pinStatus = e instanceof Error ? e.message : 'Failed'
    } finally {
      pinPending = false
    }
  }

  // --- Bridge secret (USB only) ---
  let secretValue = $state('')
  let secretStatus = $state<string | null>(null)
  let secretPending = $state(false)
  let showSecret = $state(false)

  async function handleSetBridgeSecret() {
    if (secretValue.length !== 64 || !/^[0-9a-fA-F]+$/.test(secretValue)) {
      secretStatus = 'The secret must be 64 hex characters (32 bytes).'
      return
    }
    secretPending = true
    secretStatus = null
    try {
      const frame = await serialTransport.sendAndReceive(
        buildSetBridgeSecret(secretValue),
        [FrameType.ACK, FrameType.NACK],
        60_000,
      )
      secretStatus = frame.type === FrameType.ACK
        ? 'Bridge secret set.'
        : 'The device rejected it. Is a bridge currently authenticated?'
      secretValue = ''
    } catch (e) {
      secretStatus = e instanceof Error ? e.message : 'Failed'
    } finally {
      secretPending = false
    }
  }

  // --- Bridge control (bridge mode only) ---
  let bridgeBusy = $state(false)
  async function handleBridgeStop() {
    bridgeBusy = true
    try { await bridgeRestart() } // exits the process
    catch { /* expected — the bridge is gone */ }
    finally { bridgeBusy = false }
  }
  async function handleBridgeRestart() {
    bridgeBusy = true
    try { await bridgeRestart() }
    catch { /* expected during restart */ }
    finally { bridgeBusy = false }
  }

  // --- Encrypt at rest / vault key (USB only) ---
  // The vault key encrypts the signer's stored seeds and lives only with the
  // host (this browser), never on the device. The firmware gives no read-back
  // of "encrypted but unlocked", so the card goes by what this browser holds:
  // a stored key means we enabled it (or restored an escrowed key) here.
  const vaultDeviceKey = $derived(overUsb
    ? npubToHex(device.masters.find((m) => !m.persona)?.npub ?? '')
    : null)
  const vaultLocked = $derived(device.masters.some((m) => m.locked === true))
  let vaultStored = $state<string | null>(null)
  $effect(() => { vaultStored = vaultDeviceKey ? loadVaultKey(vaultDeviceKey) : null })

  let vaultPending = $state(false)
  let vaultStatus = $state<string | null>(null)
  let vaultShowKey = $state(false)
  let vaultCopied = $state(false)
  let vaultImport = $state('')
  // Escrow-first state: a generated key that is stored in this browser but
  // not yet applied on the signer. The seal step is gated on the operator
  // confirming they have backed the key up off-browser.
  let vaultEscrowKey = $state<string | null>(null)
  let vaultEscrowTick = $state(false)

  function handleVaultGenerate() {
    if (!vaultDeviceKey) { vaultStatus = 'Add an identity to the signer first.'; return }
    const key = generateVaultKeyHex()
    // Store immediately: even if the flow is abandoned or the device round-trip
    // later fails, the key is never orphaned.
    storeVaultKey(vaultDeviceKey, key)
    vaultEscrowKey = key
    vaultEscrowTick = false
    vaultStatus = null
  }

  async function handleVaultSeal() {
    if (!vaultDeviceKey || !vaultEscrowKey) return
    const key = vaultEscrowKey
    vaultPending = true
    vaultStatus = null
    try {
      await ensureBridgeAuth()
      device.awaitingButton = 'Confirm on your signer: it shows “Encrypt at rest?” — press its button within 30 seconds.'
      try {
        await serialVaultSet(serialTransport, key)
      } finally {
        device.awaitingButton = null
      }
      vaultStored = key
      vaultEscrowKey = null
      vaultShowKey = true
      encryptionKnown = true
      vaultStatus = 'Encryption at rest is on. The key stays in this browser — keep your off-site copy safe.'
    } catch (e) {
      // The key is already stored (and visible below) whatever happened; a
      // missed ACK after the signer re-encrypted its seeds cannot orphan it.
      vaultStatus = `${e instanceof Error ? e.message : 'Failed'} — your vault key is shown above and kept in this browser. If the signer sealed itself anyway, it will ask for this key on next boot.`
    } finally {
      vaultPending = false
    }
  }

  async function handleVaultDisable() {
    if (!vaultDeviceKey) return
    vaultPending = true
    vaultStatus = null
    try {
      await ensureBridgeAuth()
      device.awaitingButton = 'Confirm on your signer: it shows “Disable encryption?” — press its button within 30 seconds.'
      try {
        await serialVaultSet(serialTransport, null)
      } finally {
        device.awaitingButton = null
      }
      removeVaultKey(vaultDeviceKey)
      vaultStored = null
      vaultShowKey = false
      encryptionKnown = false
      phonesRefresh++
      vaultStatus = 'Encryption at rest is off. The signer stores its keys in plaintext again.'
    } catch (e) {
      vaultStatus = e instanceof Error ? e.message : 'Failed'
    } finally {
      vaultPending = false
    }
  }

  async function handleVaultCopy() {
    if (!vaultStored) return
    if (await copyText(vaultStored)) {
      vaultCopied = true
      setTimeout(() => { vaultCopied = false }, 1800)
    }
  }

  function handleVaultDownload() {
    if (!vaultStored) return
    const url = URL.createObjectURL(new Blob([`${vaultStored}\n`], { type: 'text/plain' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `heartwood-vault-key-${vaultDeviceKey?.slice(0, 8) ?? 'signer'}.txt`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function handleVaultImport() {
    if (!vaultDeviceKey) { vaultStatus = 'Add an identity to the signer first.'; return }
    const key = normaliseVaultKeyHex(vaultImport)
    if (!key) { vaultStatus = 'The vault key must be 64 hexadecimal characters (32 bytes).'; return }
    storeVaultKey(vaultDeviceKey, key)
    vaultStored = key
    vaultImport = ''
    vaultStatus = 'Vault key saved in this browser. It will be used the next time the signer asks for it.'
  }

  // --- After a power cut: the three modes ---
  // The signer does not report whether it is encrypted, so the current mode
  // is inferred (inferUnlockMode) and left unmarked when it cannot be told.
  // "No encryption" is never a default: turning encryption off, by either
  // route, waits for the owner to confirm the sentence that says what it costs.
  let phoneCount = $state<number | null>(null)
  /** Bumped when this page changed encryption: turning it off drops every phone. */
  let phonesRefresh = $state(0)
  /** What this session saw the signer accept; null until then. */
  let encryptionKnown = $state<boolean | null>(null)
  const currentMode = $derived(inferUnlockMode(phoneCount, !!vaultStored, encryptionKnown))
  let chosenMode = $state<UnlockMode | null>(null)
  let modesSection = $state<HTMLElement | null>(null)
  let noEncryptionAck = $state(false)
  let clearPinAck = $state(false)
  let clearPinConfirming = $state(false)

  const NO_ENCRYPTION_RISK = 'Anyone who takes the board can copy every key off it over USB in minutes. If it is taken, I treat every identity on it as stolen.'

  const MODES: { id: UnlockMode; name: string; after: string; taken: string }[] = [
    {
      id: 'none',
      name: 'No encryption',
      after: 'Signs again straight away.',
      taken: 'They can copy every key off it over USB in minutes. Treat every identity on it as stolen.',
    },
    {
      id: 'phone',
      name: 'Phone unlock',
      after: 'Your phone shows a notification: one tap and its screen lock.',
      taken: 'Keys stay sealed unless you tap a prompt you were not expecting.',
    },
    {
      id: 'sapwood',
      name: 'Sapwood or PIN only',
      after: 'Unlock from Sapwood, or type the PIN on the cable. The slowest recovery.',
      taken: 'Keys stay sealed.',
    },
  ]

  function showNoEncryption() {
    chosenMode = 'none'
    noEncryptionAck = false
    void openAndScroll(() => { modesOpen = true }, () => modesSection)
  }

  // --- Danger zone ---
  // Disconnecting every app works over any transport; wiping the signer needs
  // it in your hands (USB or its bridge) — the relay channel has no reset
  // method, deliberately.
  const canReset = $derived(overUsb || overBridge)

  let revokeAllPending = $state(false)
  let revokeAllResult = $state<string | null>(null)

  async function handleRevokeAll() {
    const n = device.slots.length
    if (n === 0) { revokeAllResult = 'No apps are connected.'; return }
    revokeAllPending = true
    revokeAllResult = null
    let done = 0
    try {
      if (overBridge) {
        await httpTransport.clearClients(device.selectedSlot)
        done = n
      } else {
        // Revoke highest slot first so indices stay stable as the list shrinks.
        const slots = [...device.slots].sort((a, b) => b.slot_index - a.slot_index)
        for (const slot of slots) {
          await mgmtRevokeClient(slot.slot_index, slot.secret_fingerprint)
          done++
        }
      }
      revokeAllResult = `Disconnected ${done} app${done === 1 ? '' : 's'}.`
    } catch (e) {
      revokeAllResult = `Disconnected ${done} of ${n}, then stopped: ${e instanceof Error ? e.message : 'failed'}`
    } finally {
      revokeAllPending = false
    }
  }

  let resetPending = $state(false)
  let resetResult = $state<string | null>(null)

  async function handleReset() {
    resetPending = true
    resetResult = null
    device.awaitingButton = 'Hold the signer’s button to confirm the wipe — it then erases and verifies every region, which can take up to a minute.'
    try {
      const frame = overBridge
        ? await httpTransport.factoryReset()
        : await serialTransport.sendAndReceive(
            buildFactoryReset(),
            [FrameType.ACK, FrameType.NACK],
            60_000,
          )
      resetResult = frame.type === FrameType.ACK
        ? 'Factory reset complete. The device will reboot.'
        : 'Factory reset rejected by the device.'
    } catch (e) {
      resetResult = e instanceof Error ? e.message : 'Factory reset failed'
    } finally {
      device.awaitingButton = null
      resetPending = false
    }
  }

  // --- "Your signer" summary: one row per concern, worst first. Each row's
  // button opens the matching section below and scrolls to it. ---
  let backupSection = $state<HTMLElement | null>(null)
  let diagnosticsSection = $state<HTMLElement | null>(null)

  let firmwareOpen = $state(false)
  let modesOpen = $state(false)
  let securityOpen = $state(false)
  let backupOpen = $state(false)
  let networkOpen = $state(false)
  let displayOpen = $state(false)
  let diagnosticsOpen = $state(false)
  let bridgeOpen = $state(false)
  let dangerOpen = $state(false)

  async function openAndScroll(open: () => void, target: () => HTMLElement | null) {
    open()
    await tick()
    target()?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function handleSummaryAction(id: SummaryRowId) {
    if (id === 'firmware') void openAndScroll(() => { firmwareOpen = true }, () => firmwareSection)
    else if (id === 'power-cut') void openAndScroll(() => { modesOpen = true }, () => modesSection)
    else if (id === 'backup') void openAndScroll(() => { backupOpen = true }, () => backupSection)
    else void openAndScroll(() => { diagnosticsOpen = true }, () => diagnosticsSection)
  }

  const summaryInput = $derived<DeviceSummaryInput>({
    updateAvailable: !!updateInfo?.upgrade,
    updateVersion: updateInfo?.latest ?? null,
    runningVersion,
    unlockMode: currentMode,
    phoneCount,
    overUsb,
    needsBackup: pairingBackup.needsBackup,
    lastExportAt: pairingBackup.lastExportAt,
    crash: !!lastReset?.crash,
    fragmented,
    recovering: !!recoveryReason,
    storageState: storage?.state ?? null,
    modeLabel: modeLabel(),
  })
  const summaryRows = $derived(deviceSummaryRows(summaryInput))

  const powerCutStateWord = $derived(
    currentMode === 'phone' ? 'Phone unlock'
      : currentMode === 'sapwood' ? 'Sapwood or PIN only'
        : currentMode === 'none' ? 'No encryption'
          : 'Unknown',
  )
  const securityStateWord = $derived(!overUsb ? 'USB only' : vaultStored ? 'Encrypted' : 'Not encrypted')
  const backupStateWord = $derived(!overUsb ? 'USB only' : pairingBackup.needsBackup ? 'Needed' : 'Backed up')
  const networkStateWord = $derived(
    device.mode === 'relay' ? 'WiFi' : device.mode === 'serial' ? 'USB cable' : device.mode === 'http' ? 'Bridge' : '',
  )
  const displayStateWord = $derived(screenFlip === null ? '' : screenFlip ? 'Flipped' : 'Upright')
  const diagnosticsStateWord = $derived(
    lastReset?.crash || fragmented || (storage && storage.state !== 'ok') ? 'Attention' : 'OK',
  )
  const bridgeStateWord = $derived(typeof device.bridgeInfo?.mode === 'string' ? device.bridgeInfo.mode : '')
</script>

<div class="device-panel">
  {#if pairingBackup.needsBackup}
    <section class="card pairing-backup-warning" aria-live="polite">
      <h2 class="section-title">Pairing backup required</h2>
      <p class="hint">
        {#if pairingBackup.lastExportAt}
          App pairings changed after this browser's recorded encrypted backup ({backupTime(pairingBackup.lastExportAt)}).
        {:else}
          App pairings changed and this browser has not recorded a completed encrypted pairing backup.
        {/if}
        A reset or reflash would make the affected apps pair again. {#if overUsb}Export a fresh backup below and keep its passphrase separately.{:else}Connect this signer by USB to export a fresh backup; the signer will ask for a physical button confirmation.{/if}
      </p>
    </section>
  {/if}

  <!-- Your signer: one bold row per concern, worst first. -->
  <section class="your-signer">
    <h2 class="section-title">Your signer</h2>
    <div class="summary-rows">
      {#each summaryRows as row (row.id)}
        <div class="summary-row">
          <span class="summary-lead">
            <span class="dot dot-{row.dot}" aria-hidden="true"></span>
            <span class="summary-label">{row.label}</span>
          </span>
          <span class="summary-text">{row.text}</span>
          {#if row.actionLabel}
            <button class="btn btn-secondary btn-sm summary-action" onclick={() => handleSummaryAction(row.id)}>
              {row.actionLabel}
            </button>
          {/if}
        </div>
      {/each}
    </div>
  </section>

  <!-- Firmware -->
  <details class="device-section" bind:this={firmwareSection} bind:open={firmwareOpen}>
    <summary><span class="summary-title">Firmware</span><span class="summary-state">{updateInfo?.upgrade ? 'Update available' : 'Up to date'}</span></summary>
    <OtaUpdate heading={false} />
  </details>

  <!-- After a power cut: modes and phones -->
  {#if overUsb || device.mode === 'relay'}
    <details class="device-section" bind:this={modesSection} bind:open={modesOpen}>
      <summary><span class="summary-title">After a power cut</span><span class="summary-state">{powerCutStateWord}</span></summary>
      <p class="hint">How this signer recovers its keys after a restart. Pick the option that suits
        where it lives.</p>
      <div class="modes">
        {#each MODES as mode (mode.id)}
          <div class="card mode" class:mode-current={currentMode === mode.id}>
            <div class="mode-head">
              <span class="mode-name">{mode.name}</span>
              {#if currentMode === mode.id}<span class="tag tag--green">current</span>{/if}
            </div>
            <p class="hint-sm"><span class="mode-label">After a power cut:</span> {mode.after}</p>
            <p class="hint-sm"><span class="mode-label">If someone takes the board:</span> {mode.taken}</p>
            {#if currentMode !== mode.id && chosenMode !== mode.id}
              <button class="btn btn-ghost btn-sm" onclick={() => { chosenMode = mode.id; noEncryptionAck = false }}>
                Switch to this
              </button>
            {/if}
            {#if chosenMode === mode.id && currentMode !== mode.id}
              <div class="mode-steps">
                {#if mode.id === 'phone'}
                  {#if currentMode === null}
                    <p class="hint-sm">Phone unlock needs encryption on. Turn on Encrypt at rest
                      (Security{overUsb ? ', below' : ', over the USB cable'}), then add a phone
                      below over the cable. Add two if you can, so one lost abroad does not leave
                      the signer locked.</p>
                  {:else}
                    <p class="hint-sm">Add a phone below{overUsb ? '' : ', with the signer on the USB cable'}. Encryption is already on.</p>
                  {/if}
                {:else if mode.id === 'sapwood'}
                  {#if (phoneCount ?? 0) > 0}
                    <p class="hint-sm">Revoke each phone below. Encryption stays on.</p>
                  {:else}
                    <p class="hint-sm">Turn on Encrypt at rest (Security{overUsb ? ', below' : ', over the USB cable'}), or set a boot PIN.</p>
                  {/if}
                {:else}
                  {#if !overUsb}
                    <p class="hint-sm">Turning encryption off needs the signer on the USB cable.</p>
                  {:else}
                    <label class="hint-sm ack">
                      <input type="checkbox" bind:checked={noEncryptionAck} disabled={vaultPending} />
                      {NO_ENCRYPTION_RISK}{#if (phoneCount ?? 0) > 0}&#32;Every phone stops being able to unlock it.{/if}
                    </label>
                    {#if vaultStored}
                      <button class="btn btn-danger btn-sm" disabled={!noEncryptionAck || vaultPending}
                        onclick={async () => {
                          await handleVaultDisable()
                          if (!vaultStored) chosenMode = null
                          noEncryptionAck = false
                        }}>
                        {vaultPending ? 'Waiting for the button…' : 'Turn encryption off'}
                      </button>
                      {#if vaultStatus}<p class="hint-sm status">{vaultStatus}</p>{/if}
                    {:else}
                      <p class="hint-sm">This browser holds no vault key for the signer. If it has a
                        boot PIN, clear the PIN in Security, below.</p>
                    {/if}
                  {/if}
                {/if}
                <button class="btn btn-ghost btn-sm" onclick={() => { chosenMode = null }}>Cancel</button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
      {#if currentMode === null}
        {#if overUsb}
          <p class="hint-sm">This browser holds no vault key for the signer, and the signer does not
            say whether it has a boot PIN. With neither, it runs without encryption.</p>
        {:else}
          <p class="hint-sm">Over WiFi, Sapwood can tell only from the phones listed below. Connect
            by USB to see whether this browser holds the signer's vault key.</p>
        {/if}
      {/if}
      <details class="disclosure">
        <summary>Why is there no automatic phone unlock?</summary>
        <p class="hint-sm">Anyone holding the board can make it ask for its key, and a phone that
          answered by itself would hand it over: no safer than no encryption, while looking safer.</p>
      </details>
      <div class="phones">
        <UnlockPhones bind:count={phoneCount} refresh={phonesRefresh} />
      </div>
    </details>
  {/if}

  <!-- Security (USB only) -->
  <details class="device-section" bind:open={securityOpen}>
    <summary><span class="summary-title">Security</span><span class="summary-state">{securityStateWord}</span></summary>
    {#if !overUsb}
      <p class="hint">The boot PIN, bridge secret and encryption at rest are changed over USB.
        Plug the signer into this computer and connect by cable.</p>
    {:else}
      <h3 class="sub-title">Boot PIN</h3>
      <p class="hint">Locks the device at boot. It must be unlocked before it signs anything.
        The device asks for its button to confirm.</p>
      <p class="warn-text">A boot PIN is typed over the USB cable, so after any reboot or power cut
        a signer in another location stays locked until someone reaches it: signing and remote
        management cannot resume, and the signer refuses remote network activation in this mode.
        For an unattended signer, use a vault key with phone unlock instead (After a power cut,
        above).</p>
      <div class="inline-form">
        <div class="pw-wrap">
          <input
            type={showPin ? 'text' : 'password'}
            class="field-input"
            bind:value={pinValue}
            oninput={() => { clearPinAck = false; clearPinConfirming = false }}
            placeholder="4–8 digits (empty to clear)"
            maxlength="8"
            disabled={pinPending}
          />
          <PasswordReveal bind:shown={showPin} disabled={pinPending} />
        </div>
        {#if pinValue || !clearPinConfirming}
          <button class="btn btn-secondary" disabled={pinPending}
            onclick={() => { if (pinValue) void handleSetPin(); else { clearPinConfirming = true; clearPinAck = false } }}>
            {pinPending ? 'Waiting…' : pinValue ? 'Set PIN' : 'Clear PIN'}
          </button>
        {/if}
      </div>
      {#if !pinValue && clearPinConfirming}
        <label class="hint-sm ack">
          <input type="checkbox" bind:checked={clearPinAck} disabled={pinPending} />
          Clearing a PIN turns encryption off and stops every phone unlocking it. {NO_ENCRYPTION_RISK}
        </label>
        <div class="inline-form">
          <button class="btn btn-danger btn-sm" disabled={pinPending || !clearPinAck} onclick={handleSetPin}>
            {pinPending ? 'Waiting…' : 'Clear the PIN'}
          </button>
          <button class="btn btn-ghost btn-sm" disabled={pinPending}
            onclick={() => { clearPinConfirming = false; clearPinAck = false }}>Cancel</button>
        </div>
      {/if}
      {#if pinStatus}<p class="hint-sm status">{pinStatus}</p>{/if}

      <h3 class="sub-title">Encrypt at rest</h3>
      <p class="hint">Encrypts the signer's stored keys with a vault key held by this browser, never
        by the device: a stolen device yields only ciphertext.</p>
      {#if vaultLocked}
        <p class="warn-text">This signer is locked. Unlock it from the banner on Home before
          changing encryption.</p>
      {:else if !vaultDeviceKey}
        <p class="hint-sm">Add an identity to the signer first.</p>
      {:else if vaultEscrowKey}
        <div class="vault-escrow">
          <p class="warn-text">Your vault key: store it somewhere safe off this browser
            (password manager, printed) <strong>before</strong> the signer is sealed. Without it,
            a sealed signer cannot be unlocked.</p>
          <div class="uri-box"><code>{vaultEscrowKey}</code></div>
          <div class="inline-form">
            <button class="btn btn-secondary btn-sm" disabled={vaultPending}
              onclick={async () => { vaultCopied = await copyText(vaultEscrowKey ?? '') }}>
              {vaultCopied ? 'Copied ✓' : 'Copy'}
            </button>
            <button class="btn btn-secondary btn-sm" disabled={vaultPending}
              onclick={() => {
                const url = URL.createObjectURL(new Blob([`${vaultEscrowKey}\n`], { type: 'text/plain' }))
                const a = document.createElement('a')
                a.href = url
                a.download = `heartwood-vault-key-${vaultDeviceKey?.slice(0, 8) ?? 'signer'}.txt`
                a.click()
                URL.revokeObjectURL(url)
              }}>
              Download
            </button>
          </div>
          <label class="hint-sm vault-escrow-tick">
            <input type="checkbox" bind:checked={vaultEscrowTick} disabled={vaultPending} />
            I have stored this key outside this browser
          </label>
          <div class="inline-form">
            <button class="btn btn-primary btn-sm"
              disabled={vaultPending || !vaultEscrowTick}
              onclick={handleVaultSeal}>
              {vaultPending ? 'Waiting for the button…' : 'Seal the signer now'}
            </button>
            <button class="btn btn-ghost btn-sm" disabled={vaultPending}
              onclick={() => { if (vaultDeviceKey) removeVaultKey(vaultDeviceKey); vaultEscrowKey = null }}>
              Discard key
            </button>
          </div>
        </div>
      {:else if vaultStored}
        <p class="hint-sm">This browser holds a vault key for this signer.</p>
        <div class="vault-escrow">
          <p class="hint-sm">Store this somewhere safe off-site (e.g. password manager). It
            unlocks your signer if this browser's storage is lost.</p>
          {#if vaultShowKey}
            <div class="uri-box"><code>{vaultStored}</code></div>
          {/if}
          <div class="inline-form">
            <button class="btn btn-secondary btn-sm" disabled={vaultPending}
              onclick={() => (vaultShowKey = !vaultShowKey)}>
              {vaultShowKey ? 'Hide vault key' : 'Reveal vault key'}
            </button>
            <button class="btn btn-secondary btn-sm" disabled={vaultPending} onclick={handleVaultCopy}>
              {vaultCopied ? 'Copied ✓' : 'Copy'}
            </button>
            <button class="btn btn-secondary btn-sm" disabled={vaultPending} onclick={handleVaultDownload}>
              Download
            </button>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" disabled={vaultPending} onclick={showNoEncryption}>
          Disable encryption
        </button>
      {:else}
        <ConfirmButton
          label="Encrypt at rest"
          question="Generate a vault key and encrypt this signer's stored keys? You will back the key up before anything is sealed."
          confirmLabel="Yes, generate the key"
          busyLabel="Working…"
          busy={vaultPending}
          buttonClass="btn btn-secondary btn-sm"
          onconfirm={handleVaultGenerate}
        />
        <details class="disclosure vault-import">
          <summary>Restore a vault key saved elsewhere</summary>
          <p class="hint-sm">Paste a vault key you escrowed from another browser so this one can
            unlock the signer too.</p>
          <div class="inline-form">
            <input
              class="field-input"
              bind:value={vaultImport}
              placeholder="64 hex characters"
              maxlength="64"
              spellcheck="false"
              autocomplete="off"
              disabled={vaultPending}
            />
            <button class="btn btn-secondary btn-sm" disabled={vaultPending || !normaliseVaultKeyHex(vaultImport)}
              onclick={handleVaultImport}>
              Save in this browser
            </button>
          </div>
        </details>
      {/if}
      {#if vaultStatus}<p class="hint-sm status">{vaultStatus}</p>{/if}

      <details class="disclosure advanced-block">
        <summary>Advanced: bridge secret</summary>
        <p class="hint">Shared secret for bridge authentication (device-decrypts mode). Needs the
          button; cannot be set while a bridge session is active.</p>
        <div class="inline-form">
          <div class="pw-wrap">
            <input
              type={showSecret ? 'text' : 'password'}
              class="field-input"
              bind:value={secretValue}
              placeholder="64 hex chars (32 bytes)"
              maxlength="64"
              disabled={secretPending}
            />
            <PasswordReveal bind:shown={showSecret} disabled={secretPending} />
          </div>
          <button class="btn btn-secondary" disabled={secretPending || secretValue.length !== 64} onclick={handleSetBridgeSecret}>
            {secretPending ? 'Waiting…' : 'Set secret'}
          </button>
        </div>
        {#if secretStatus}<p class="hint-sm status">{secretStatus}</p>{/if}
      </details>
    {/if}
  </details>

  <!-- Backup and restore app pairings (USB only) -->
  {#if overUsb}
    <details class="device-section" bind:this={backupSection} bind:open={backupOpen}>
      <summary><span class="summary-title">Backup</span><span class="summary-state">{backupStateWord}</span></summary>
      <Backup heading={false} />
    </details>
  {/if}

  <!-- Network mode -->
  <details class="device-section" bind:open={networkOpen}>
    <summary><span class="summary-title">Network</span><span class="summary-state">{networkStateWord}</span></summary>
    <Connectivity heading={false} />
  </details>

  <!-- Display and light -->
  <details class="device-section" bind:open={displayOpen}>
    <summary><span class="summary-title">Display and light</span><span class="summary-state">{displayStateWord}</span></summary>
    <p class="hint">Screen orientation and the activity light's log detail.</p>
    {#if device.mode === 'relay' && typeof device.relayStatus?.log_quiet === 'boolean'}
      <div class="log-quiet">
        <span class="lq-label">Activity light and log detail</span>
        <div class="lq-buttons">
          <button
            class="btn btn-sm"
            class:btn-secondary={device.relayStatus.log_quiet}
            class:lq-on={!device.relayStatus.log_quiet}
            disabled={logQuietPending || !device.relayStatus.log_quiet}
            onclick={() => setLogQuiet(false)}
          >Detailed</button>
          <button
            class="btn btn-sm"
            class:btn-secondary={!device.relayStatus.log_quiet}
            class:lq-on={device.relayStatus.log_quiet}
            disabled={logQuietPending || device.relayStatus.log_quiet}
            onclick={() => setLogQuiet(true)}
          >Quiet</button>
        </div>
        <p class="hint-sm no-gap">The signer's blue activity light flashes with its log output. Quiet keeps
          warnings only, so the light stays dark in normal use.</p>
      </div>
    {/if}
    {#if screenFlip !== null}
      <div class="log-quiet">
        <span class="lq-label">Screen orientation</span>
        <div class="lq-buttons">
          <button
            class="btn btn-sm"
            class:btn-secondary={screenFlip}
            class:lq-on={!screenFlip}
            disabled={flipPending || !screenFlip}
            onclick={() => turnScreen(false)}
          >Upright</button>
          <button
            class="btn btn-sm"
            class:btn-secondary={!screenFlip}
            class:lq-on={screenFlip}
            disabled={flipPending || screenFlip}
            onclick={() => turnScreen(true)}
          >Flipped</button>
        </div>
        <p class="hint-sm no-gap">Turn the picture round if the signer sits the other way up, for the
          other hand or a case. The button labels on its cards move with it. On the signer itself: hold its
          button on the DEVICE page.</p>
      </div>
    {/if}
  </details>

  <!-- Diagnostics -->
  <details class="device-section" bind:this={diagnosticsSection} bind:open={diagnosticsOpen}>
    <summary><span class="summary-title">Diagnostics</span><span class="summary-state">{diagnosticsStateWord}</span></summary>
    <p class="hint">Live numbers from the signer: connection, memory and storage.</p>
    <table class="kv-table"><tbody>
      <tr><td class="label">Connected over</td><td>{modeLabel()}</td></tr>
      <tr><td class="label">Address</td><td class="mono">{device.portInfo || '--'}</td></tr>
      <tr><td class="label">Identities</td><td>{device.masters.filter((m) => !m.persona).length}</td></tr>
      <tr><td class="label">Apps</td><td>{device.slots.length}</td></tr>
      {#if typeof health.uptime_s === 'number'}
        <tr><td class="label">Signer up</td><td>{formatUptime(health.uptime_s)}</td></tr>
      {/if}
      {#if lastReset}
        <tr><td class="label">Last restart</td><td class:crash-reset={lastReset.crash}>{recoveryReason ? 'self-recovery restart' : lastReset.text}</td></tr>
      {/if}
      {#if typeof freeHeap === 'number' && typeof largestBlock === 'number'}
        <tr>
          <td class="label">Free memory</td>
          <td class:crash-reset={fragmented}>
            {kb(freeHeap)}{#if fragmented} · fragmented (largest block {kb(largestBlock)}){/if}
          </td>
        </tr>
      {/if}
      {#if typeof maxSignBytes === 'number'}
        <tr><td class="label">Max signed message</td><td>
          {formatBytes(maxSignBytes)}{#if typeof maxSignBytesObject === 'number' && maxSignBytesObject > maxSignBytes}
            · {formatBytes(maxSignBytesObject)} for apps that ask for the compact reply{/if}
        </td></tr>
      {/if}
      {#if storage}
        <tr>
          <td class="label">Identity &amp; app storage</td>
          <td class:crash-reset={storage.state !== 'ok'}>
            <span class="gauge-track"><span
              class="gauge-fill gauge-{storage.state}"
              style={`width:${storage.pct}%`}
            ></span></span>
            {storage.label}
          </td>
        </tr>
      {/if}
    </tbody></table>
    {#if storage?.state === 'warn'}
      <p class="hint-sm crash-hint">The signer's storage is filling up. Identities, personas, app pairings
        and settings share it. Removing an unused persona or app pairing frees space.</p>
    {/if}
    {#if storage?.state === 'full'}
      <p class="hint-sm crash-hint">The signer's storage is nearly full. It will refuse new personas before
        app pairings stop working, so remove an unused persona or app pairing now.</p>
    {/if}
    {#if lastReset?.crash}
      <p class="hint-sm crash-hint">The signer's last restart was not planned.{#if health.crashed_during}&#32;It crashed while
        handling <strong>{health.crashed_during}</strong>.{/if} If this repeats, note the pattern; the request log
        below restarts empty each boot.</p>
    {/if}
    {#if fragmented}
      <details class="disclosure">
        <summary>Why is the memory fragmented?</summary>
        <p class="hint-sm crash-hint">The signer's largest free block is small relative to total free.
          This can happen after a burst of decryptions; it clears on the next restart. Newer firmware
          frees the TLS buffers between messages to avoid it.</p>
      </details>
    {/if}
    {#if trimmed}
      <p class="hint-sm crash-hint">The signer trimmed this status to its vital fields because its memory
        was too fragmented to send the full report. The request log paused this poll instead of the signer
        crashing, and resumes once the memory recovers.</p>
    {/if}
    {#if recoveryReason}
      <details class="disclosure">
        <summary>Why did the signer restart itself?</summary>
        <p class="hint-sm crash-hint">Its relay service was unusable for several minutes
          (<strong>{recoveryReason}</strong>), usually memory too fragmented to place TLS or publish
          buffers. It now recovers on its own instead of staying unreachable until a power-cycle; if
          this repeats often, the memory readings above tell the story.</p>
      </details>
    {/if}
  </details>

  <!-- Bridge (bridge mode only) -->
  {#if overBridge && device.bridgeInfo}
    <details class="device-section" bind:open={bridgeOpen}>
      <summary><span class="summary-title">Bridge</span><span class="summary-state">{bridgeStateWord}</span></summary>
      <table class="kv-table"><tbody>
        <tr><td class="label">Mode</td><td>{device.bridgeInfo.mode}</td></tr>
        <tr><td class="label">Uptime</td><td>{formatUptime(device.bridgeInfo.uptime_secs as number)}</td></tr>
        <tr>
          <td class="label">Relays</td>
          <td>
            {#each (device.bridgeInfo.relays as string[]) as relay}
              <div class="mono">{relay}</div>
            {/each}
          </td>
        </tr>
      </tbody></table>
      <p class="hint bridge-hint">The bridge holds the USB port. Stop it to connect directly over USB
        (then reload Sapwood and connect by cable).</p>
      <div class="inline-form">
        <ConfirmButton
          label="Stop bridge"
          question="Stop the bridge? You'll need to restart it manually."
          confirmLabel="Yes, stop it"
          busyLabel="Stopping…"
          busy={bridgeBusy}
          buttonClass="btn btn-warn btn-sm"
          onconfirm={handleBridgeStop}
        />
        <ConfirmButton
          label="Restart bridge"
          question="Restart the bridge? Relay connections drop briefly."
          confirmLabel="Yes, restart"
          busyLabel="Restarting…"
          busy={bridgeBusy}
          buttonClass="btn btn-secondary btn-sm"
          onconfirm={handleBridgeRestart}
        />
      </div>
    </details>
  {/if}

  <!-- Set up another device -->
  <p class="hint flash-line">Flash another board: install or re-flash firmware in the guided
    <a class="flash-link" href="#/flash">flasher</a>.</p>

  <!-- Danger zone -->
  <details class="device-section device-section--danger" bind:open={dangerOpen}>
    <summary><span class="summary-title danger-title">Danger zone</span></summary>
    <div class="card card--danger danger">
      <div class="danger-row">
        <div class="danger-info">
          <span class="danger-name">Disconnect all apps</span>
          <span class="hint-sm">Every connected app loses access immediately. The signer and its keys are untouched.</span>
        </div>
        <ConfirmButton
          label={`Disconnect all ${device.slots.length}`}
          question="Disconnect all {device.slots.length} app{device.slots.length === 1 ? '' : 's'}? This cannot be undone."
          confirmLabel="Yes, disconnect all"
          busyLabel="Disconnecting…"
          busy={revokeAllPending}
          disabled={device.slots.length === 0}
          onconfirm={handleRevokeAll}
        />
      </div>
      {#if revokeAllResult}<p class="hint-sm status">{revokeAllResult}</p>{/if}

      <div class="danger-row">
        <div class="danger-info">
          <span class="danger-name">Factory reset</span>
          <span class="hint-sm">Erases all keys, apps, bridge secret and PIN. Irreversible.
            The device asks for its button to confirm.</span>
          {#if device.connected && !canReset}
            <span class="hint-sm">Not available over WiFi. Wiping the signer needs it in your
              hands. Plug it in over USB.</span>
          {/if}
        </div>
        <ConfirmButton
          label="Factory reset"
          question="Erase everything on this signer?"
          confirmLabel="Yes, erase it all"
          busyLabel="Waiting for the button…"
          busy={resetPending}
          disabled={!canReset}
          onconfirm={handleReset}
        />
      </div>
      {#if resetResult}<p class="hint-sm status">{resetResult}</p>{/if}
    </div>
  </details>
</div>

<style>
  .crash-reset { color: var(--amber); font-weight: 600; }
  .crash-hint { margin-top: 0.4rem; color: var(--amber); }

  .gauge-track {
    display: inline-block; vertical-align: middle; margin-right: 0.5rem;
    width: 7rem; height: 0.45rem; border-radius: 3px;
    background: #1a1a1a; border: 1px solid var(--border); overflow: hidden;
  }
  .gauge-fill { display: block; height: 100%; }
  .gauge-ok { background: var(--green); }
  .gauge-warn { background: var(--amber); }
  .gauge-full { background: var(--red); }

  .log-quiet { margin-top: 0.9rem; }
  .lq-label { display: block; font-size: 0.8rem; color: var(--text-dim); margin-bottom: 0.4rem; }
  .lq-buttons { display: flex; gap: 0.5rem; margin-bottom: 0.4rem; }
  .lq-on { border-color: var(--green-dim); color: var(--green); background: #08130d; }

  .device-panel {
    display: flex; flex-direction: column; gap: 1.75rem;
    /* Room above the docked mobile tab bar so the last section (Danger
       zone) is never hidden behind it. */
    padding-bottom: 2rem;
  }
  .pairing-backup-warning { border-color: var(--amber); background: #1a1508; }
  .pairing-backup-warning .section-title { color: var(--amber); }

  /* "Your signer": bold, spaced-out rows, worst concern first. The heading
     reads as the headline: same weight as a section summary, a touch bigger. */
  .your-signer { display: flex; flex-direction: column; gap: 0.25rem; }
  .your-signer > .section-title { font-size: 1.2rem; font-weight: 700; color: #fff; margin-bottom: 1rem; }
  .summary-rows { display: flex; flex-direction: column; gap: 1rem; }
  .summary-row {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.9rem 1rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  }
  .summary-lead { flex: 0 0 13.5rem; display: flex; align-items: center; gap: 0.6rem; min-width: 0; }
  .dot {
    flex: none; width: 0.7rem; height: 0.7rem; border-radius: 50%;
  }
  .dot-ok { background: var(--green); }
  .dot-unknown { background: var(--text-muted); }
  .dot-attention { background: var(--amber); }
  .dot-problem { background: var(--red); }
  .summary-label { font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .summary-text { flex: 1 1 auto; min-width: 0; font-size: 1rem; font-weight: 600; color: var(--text); }
  .summary-action { flex: none; margin-left: auto; }

  /* Phone width: dot+label on their own line, then the state text, then a
     full-width button. The dot never sits alone on a line. */
  @media (max-width: 480px) {
    .summary-row { flex-direction: column; align-items: stretch; gap: 0.4rem; }
    .summary-lead { flex: none; }
    .summary-text { flex: none; }
    .summary-action { margin-left: 0; width: 100%; }
  }

  /* Collapsible sections: bold, roomy summaries with a state word docked right. */
  .device-section {
    border: 1px solid var(--border); border-radius: 8px;
    padding: 0 1.1rem;
  }
  .device-section > summary {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: 1rem 0; cursor: pointer; list-style: none;
  }
  .device-section > summary::-webkit-details-marker { display: none; }
  .device-section--danger { border-color: #442222; }
  .summary-title { font-size: 1.05rem; font-weight: 700; color: #fff; }
  .summary-title::before {
    content: '▸'; display: inline-block; margin-right: 0.6rem; color: var(--text-muted);
    transition: transform 0.15s;
  }
  .device-section[open] > summary .summary-title::before { transform: rotate(90deg); }
  .summary-state { font-size: 0.8rem; color: var(--text-muted); white-space: nowrap; }
  .device-section > :not(summary) { padding-bottom: 1.1rem; }
  .advanced-block { margin-top: 1.1rem; }
  .flash-line { margin: 0; }

  .sub-title { font-size: 0.9rem; font-weight: 600; color: var(--text); margin: 1.1rem 0 0.4rem; }
  .sub-title:first-of-type { margin-top: 0; }

  .inline-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .inline-form .field-input { font-size: 0.85rem; padding: 0.45rem 0.7rem; }
  .status { margin-top: 0.6rem; color: var(--text-dim); }

  .bridge-hint { margin-top: 0.8rem; }

  .modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.75rem; margin: 0.8rem 0; }
  .mode { display: flex; flex-direction: column; gap: 0.4rem; align-items: flex-start; }
  .mode-current { border-color: var(--green-dim); }
  .mode-head { display: flex; gap: 0.5rem; align-items: center; }
  .mode-name { font-weight: 600; color: var(--text); }
  .mode-label { color: var(--text); }
  .mode-steps { display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-start; margin-top: 0.3rem; }
  .ack { display: flex; gap: 0.5rem; align-items: flex-start; margin-top: 0.4rem; }
  .ack input { margin-top: 0.2rem; flex: none; }
  .phones { margin-top: 1.2rem; }

  .vault-escrow {
    display: flex; flex-direction: column; gap: 0.6rem;
    margin: 0.6rem 0 0.9rem;
  }
  .vault-escrow .uri-box { margin: 0; }
  .vault-import { margin-top: 0.8rem; }
  .vault-import .field-input { font-size: 0.85rem; padding: 0.45rem 0.7rem; flex: 1; }

  .flash-link { color: var(--green-dim); }
  .flash-link:hover { color: var(--green); }

  .danger-title { color: var(--red); }
  .danger-row {
    display: flex; justify-content: space-between; align-items: center; gap: 1rem;
    padding: 0.8rem 0; border-top: 1px solid #2a1414;
  }
  .danger-info { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
  .danger-name { font-size: 0.95rem; font-weight: 600; color: var(--text); }

  @media (max-width: 640px) {
    .danger-row { flex-wrap: wrap; }
    .inline-form .pw-wrap { width: 100%; }
    .summary-row { padding: 0.8rem 0.85rem; }
    .device-section { padding: 0 0.85rem; }
  }
</style>

<script lang="ts">
  // Device — everything about the hardware and how it's reached: connection
  // details, network mode, firmware, security (PIN, bridge secret), the bridge,
  // and the danger zone. Replaces the old Connectivity, Firmware and Danger
  // tabs plus the device half of Settings.
  import {
    device, serialTransport, httpTransport, bridgeRestart, mgmtRevokeClient,
    relaySetLogQuiet, ensureBridgeAuth,
  } from '../lib/device.svelte.js'
  import { FrameType, buildSetPin, buildSetBridgeSecret, buildFactoryReset } from '../lib/frame.js'
  import { getFirmwareVersion } from '../lib/device.svelte.js'
  import { describeReset, formatUptime, formatBytes } from '../lib/reset-reason.js'
  import { npubToHex } from '../lib/known-devices.js'
  import { copyText } from '../lib/clipboard.js'
  import {
    generateVaultKeyHex, loadVaultKey, storeVaultKey, removeVaultKey,
    normaliseVaultKeyHex, serialVaultSet,
  } from '../lib/vault.js'
  import Connectivity from './Connectivity.svelte'
  import OtaUpdate from './OtaUpdate.svelte'
  import Backup from './Backup.svelte'
  import PasswordReveal from './PasswordReveal.svelte'
  import ConfirmButton from './ConfirmButton.svelte'

  const overUsb = $derived(device.mode === 'serial')
  const overBridge = $derived(device.mode === 'http')

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
    uptime_s?: number; last_reset?: string; crashed_during?: string
    max_sign_bytes?: number; max_sign_bytes_object?: number
    free_heap?: number; largest_block?: number
  } | null>(null)
  $effect(() => {
    if (device.connected && device.mode === 'serial') {
      void getFirmwareVersion().then((info) => { usbHealth = info })
    } else {
      usbHealth = null
    }
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
        ? (pinValue ? 'PIN set.' : 'PIN cleared.')
        : 'The device rejected the PIN change.'
      pinValue = ''
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
      resetPending = false
    }
  }
</script>

<div class="device-panel">
  <!-- Connection -->
  <section>
    <h2 class="section-title">Connection</h2>
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
    </tbody></table>
    {#if fragmented}
      <p class="hint-sm crash-hint">The signer's memory is fragmented (its largest free block is small
        relative to total free). This can happen after a burst of decryptions; it clears on the next
        restart. Newer firmware frees the TLS buffers between messages to avoid it.</p>
    {/if}
    {#if trimmed}
      <p class="hint-sm crash-hint">The signer trimmed this status to its vital fields because its memory
        was too fragmented to send the full report. The request log paused this poll instead of the signer
        crashing, and resumes once the memory recovers.</p>
    {/if}
    {#if lastReset?.crash}
      <p class="hint-sm crash-hint">The signer's last restart was not planned.{#if health.crashed_during}&#32;It crashed while
        handling <strong>{health.crashed_during}</strong>.{/if} If this repeats, note the pattern; the request log
        below restarts empty each boot.</p>
    {/if}
    {#if recoveryReason}
      <p class="hint-sm crash-hint">The signer restarted itself after its relay service was unusable for
        several minutes (<strong>{recoveryReason}</strong>) — usually memory too fragmented to place TLS or
        publish buffers. It now recovers on its own instead of staying unreachable until a power-cycle; if
        this repeats often, the memory readings above tell the story.</p>
    {/if}
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
  </section>

  <!-- Network mode -->
  <section>
    <Connectivity />
  </section>

  <!-- Firmware -->
  <section>
    <OtaUpdate />
  </section>

  <!-- Security (USB only) -->
  <section>
    <h2 class="section-title">Security</h2>
    {#if !overUsb}
      <p class="hint">The boot PIN, bridge secret and encryption at rest are changed over USB.
        Plug the signer into this computer and connect by cable.</p>
    {:else}
      <h3 class="sub-title">Boot PIN</h3>
      <p class="hint">Locks the device at boot. It must be unlocked before it signs anything.
        The device asks for its button to confirm.</p>
      <p class="warn-text">For an unattended signer in another location, leave the boot PIN clear.
        After any reboot or power cut it requires a local USB unlock, so automatic signing and remote
        management cannot resume; the signer also refuses remote network activation in this mode.</p>
      <div class="inline-form">
        <div class="pw-wrap">
          <input
            type={showPin ? 'text' : 'password'}
            class="field-input"
            bind:value={pinValue}
            placeholder="4–8 digits (empty to clear)"
            maxlength="8"
            disabled={pinPending}
          />
          <PasswordReveal bind:shown={showPin} disabled={pinPending} />
        </div>
        <button class="btn btn-secondary" disabled={pinPending} onclick={handleSetPin}>
          {pinPending ? 'Waiting…' : pinValue ? 'Set PIN' : 'Clear PIN'}
        </button>
      </div>
      {#if pinStatus}<p class="hint-sm status">{pinStatus}</p>{/if}

      <h3 class="sub-title">Bridge secret</h3>
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

      <h3 class="sub-title">Encrypt at rest</h3>
      <p class="hint">Encrypts the signer's stored keys with a vault key held by this browser,
        never by the device — a stolen device yields only ciphertext. The device asks for its
        button to confirm.</p>
      {#if vaultLocked}
        <p class="warn-text">This signer is locked. Unlock it from the banner on Home before
          changing encryption.</p>
      {:else if !vaultDeviceKey}
        <p class="hint-sm">Add an identity to the signer first.</p>
      {:else if vaultEscrowKey}
        <div class="vault-escrow">
          <p class="warn-text">Your vault key — store it somewhere safe off this browser
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
        <ConfirmButton
          label="Disable encryption"
          question="Return to plaintext key storage on the signer?"
          confirmLabel="Yes, disable it"
          busyLabel="Waiting for the button…"
          busy={vaultPending}
          buttonClass="btn btn-secondary btn-sm"
          onconfirm={handleVaultDisable}
        />
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
    {/if}
  </section>

  <!-- Backup and restore app pairings (USB only) -->
  {#if overUsb}
    <Backup />
  {/if}

  <!-- Bridge (bridge mode only) -->
  {#if overBridge && device.bridgeInfo}
    <section>
      <h2 class="section-title">Bridge</h2>
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
    </section>
  {/if}

  <!-- Set up another device -->
  <section>
    <h2 class="section-title">Flash a device</h2>
    <p class="hint">Install or re-install firmware on a Heartwood board, whether a new device or a
      full re-flash, in the guided <a class="flash-link" href="#/flash">flasher</a>.</p>
  </section>

  <!-- Danger zone -->
  <section class="card card--danger danger">
    <h2 class="section-title danger-title">Danger zone</h2>

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
  </section>
</div>

<style>
  .crash-reset { color: var(--amber); font-weight: 600; }
  .crash-hint { margin-top: 0.4rem; color: var(--amber); }

  .log-quiet { margin-top: 0.9rem; }
  .lq-label { display: block; font-size: 0.8rem; color: var(--text-dim); margin-bottom: 0.4rem; }
  .lq-buttons { display: flex; gap: 0.5rem; margin-bottom: 0.4rem; }
  .lq-on { border-color: var(--green-dim); color: var(--green); background: #08130d; }

  .device-panel { display: flex; flex-direction: column; gap: 1.75rem; }

  .sub-title { font-size: 0.9rem; font-weight: 600; color: var(--text); margin: 1.1rem 0 0.4rem; }
  .sub-title:first-of-type { margin-top: 0; }

  .inline-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .inline-form .field-input { font-size: 0.85rem; padding: 0.45rem 0.7rem; }
  .status { margin-top: 0.6rem; color: var(--text-dim); }

  .bridge-hint { margin-top: 0.8rem; }

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
  }
</style>

<script lang="ts">
  // Device — everything about the hardware and how it's reached: connection
  // details, network mode, firmware, security (PIN, bridge secret), the bridge,
  // and the danger zone. Replaces the old Connectivity, Firmware and Danger
  // tabs plus the device half of Settings.
  import {
    device, serialTransport, httpTransport, bridgeRestart, mgmtRevokeClient,
    relaySetLogQuiet,
  } from '../lib/device.svelte.js'
  import { FrameType, buildSetPin, buildSetBridgeSecret, buildFactoryReset } from '../lib/frame.js'
  import { getFirmwareVersion } from '../lib/device.svelte.js'
  import { describeReset, formatUptime } from '../lib/reset-reason.js'
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
  let usbHealth = $state<{ uptime_s?: number; last_reset?: string; crashed_during?: string } | null>(null)
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

  // Live memory health (relay only). A largest block far below total free is a
  // fragmented heap — the condition behind the bulk-decrypt crashes. Flag it
  // amber so it is visible before it becomes a reboot.
  const freeHeap = $derived(device.mode === 'relay' ? device.relayStatus?.free_heap : undefined)
  const largestBlock = $derived(device.mode === 'relay' ? device.relayStatus?.largest_free_block : undefined)
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
      <p class="hint">The boot PIN and bridge secret are changed over USB. Plug the signer into
        this computer and connect by cable.</p>
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

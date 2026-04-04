<script lang="ts">
  import { device, serialTransport } from '../lib/device.svelte.js'
  import { FrameType, buildSetPin, buildSetBridgeSecret } from '../lib/frame.js'

  // --- PIN management ---
  let pinValue = $state('')
  let pinStatus = $state<string | null>(null)
  let pinPending = $state(false)

  async function handleSetPin() {
    if (device.mode !== 'serial') {
      pinStatus = 'PIN management requires USB connection.'
      return
    }
    if (pinValue && (pinValue.length < 4 || pinValue.length > 8 || !/^\d+$/.test(pinValue))) {
      pinStatus = 'PIN must be 4-8 digits, or empty to clear.'
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
        : 'Device rejected PIN change.'
      pinValue = ''
    } catch (e) {
      pinStatus = e instanceof Error ? e.message : 'Failed'
    } finally {
      pinPending = false
    }
  }

  // --- Bridge secret ---
  let secretValue = $state('')
  let secretStatus = $state<string | null>(null)
  let secretPending = $state(false)

  async function handleSetBridgeSecret() {
    if (device.mode !== 'serial') {
      secretStatus = 'Bridge secret management requires USB connection.'
      return
    }
    if (secretValue.length !== 64 || !/^[0-9a-fA-F]+$/.test(secretValue)) {
      secretStatus = 'Secret must be 64 hex characters (32 bytes).'
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
        : 'Device rejected. Is a bridge currently authenticated?'
      secretValue = ''
    } catch (e) {
      secretStatus = e instanceof Error ? e.message : 'Failed'
    } finally {
      secretPending = false
    }
  }

  // --- Helpers ---
  function formatUptime(secs: number): string {
    if (secs < 60) return `${secs}s`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    return `${h}h ${m}m`
  }

  let copied = $state(false)

  function modeLabel(): string {
    if (device.mode === 'serial') return 'USB (Web Serial)'
    if (device.mode === 'http') return 'Bridge (HTTP)'
    return 'Disconnected'
  }

  async function copyBunkerUri() {
    const uri = device.bridgeInfo?.bunker_uri as string | undefined
    if (!uri) return
    try {
      await navigator.clipboard.writeText(uri)
      copied = true
      setTimeout(() => { copied = false }, 2000)
    } catch {
      // Fallback: select the text
      const el = document.querySelector('.bunker-uri') as HTMLElement
      if (el) {
        const range = document.createRange()
        range.selectNodeContents(el)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
      }
    }
  }
</script>

<div class="settings">
  <h2>Connection</h2>
  <table><tbody>
    <tr><td class="label">Mode</td><td>{modeLabel()}</td></tr>
    <tr><td class="label">Port</td><td>{device.portInfo || '--'}</td></tr>
    <tr><td class="label">Masters</td><td>{device.masters.length}</td></tr>
    <tr><td class="label">Clients</td><td>{device.clients.length} (slot {device.selectedSlot})</td></tr>
  </tbody></table>

  {#if device.mode === 'http' && device.bridgeInfo}
    <h2>Bunker URI</h2>
    <p class="info">Paste this into Nostrudel, Coracle, or any NIP-46 client to connect.</p>
    <div class="bunker-block">
      <code class="bunker-uri">{device.bridgeInfo.bunker_uri}</code>
      <button class="btn-copy" onclick={copyBunkerUri}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>

    <h2>Bridge</h2>
    <table><tbody>
      <tr><td class="label">Mode</td><td>{device.bridgeInfo.mode}</td></tr>
      <tr><td class="label">Uptime</td><td>{formatUptime(device.bridgeInfo.uptime_secs as number)}</td></tr>
      <tr>
        <td class="label">Relays</td>
        <td>
          {#each device.bridgeInfo.relays as relay}
            <div class="relay">{relay}</div>
          {/each}
        </td>
      </tr>
    </tbody></table>
  {/if}

  <h2>Boot PIN</h2>
  <p class="info">Locks the device at boot. Must be unlocked before signing. Requires button confirmation.</p>
  <div class="inline-form">
    <input
      type="password"
      bind:value={pinValue}
      placeholder="4-8 digits (empty to clear)"
      maxlength="8"
      disabled={!device.connected || device.mode !== 'serial' || pinPending}
    />
    <button
      class="btn"
      disabled={!device.connected || device.mode !== 'serial' || pinPending}
      onclick={handleSetPin}
    >
      {pinPending ? 'Waiting...' : pinValue ? 'Set PIN' : 'Clear PIN'}
    </button>
  </div>
  {#if pinStatus}
    <p class="status">{pinStatus}</p>
  {/if}

  <h2>Bridge Secret</h2>
  <p class="info">Shared secret for bridge authentication (device-decrypts mode). Requires button confirmation. Cannot be set while a bridge session is active.</p>
  <div class="inline-form">
    <input
      type="password"
      bind:value={secretValue}
      placeholder="64 hex chars (32 bytes)"
      maxlength="64"
      disabled={!device.connected || device.mode !== 'serial' || secretPending}
    />
    <button
      class="btn"
      disabled={!device.connected || device.mode !== 'serial' || secretPending || secretValue.length !== 64}
      onclick={handleSetBridgeSecret}
    >
      {secretPending ? 'Waiting...' : 'Set Secret'}
    </button>
  </div>
  {#if secretStatus}
    <p class="status">{secretStatus}</p>
  {/if}

  {#if device.mode !== 'serial' && device.connected}
    <p class="hint">PIN and bridge secret management require a direct USB connection.</p>
  {/if}
</div>

<style>
  h2 { font-size: 1rem; font-weight: 600; margin: 1.5rem 0 0.5rem; color: #ccc; }
  h2:first-child { margin-top: 0; }

  table { width: 100%; border-collapse: collapse; }

  td {
    padding: 0.35rem 0.5rem;
    font-size: 0.8rem;
    border-bottom: 1px solid #1a1a1a;
    vertical-align: top;
  }

  td.label { color: #666; width: 100px; white-space: nowrap; }

  .relay { color: var(--text); font-size: 0.9rem; }

  .bunker-block {
    background: #080808;
    border: 1px solid var(--green-dim);
    border-radius: 6px;
    padding: 1rem 1.25rem;
    display: flex;
    align-items: flex-start;
    gap: 1rem;
  }

  .bunker-uri {
    font-size: 0.85rem;
    color: var(--green);
    word-break: break-all;
    line-height: 1.5;
    flex: 1;
    user-select: all;
  }

  .btn-copy {
    background: var(--green);
    color: #050505;
    border: none;
    padding: 0.4rem 1rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
    transition: all 0.15s;
  }

  .btn-copy:hover { background: #00ff88; box-shadow: var(--green-glow); }
  .info { font-size: 0.8rem; color: #555; margin: 0 0 0.5rem; }
  .hint { font-size: 0.8rem; color: #555; margin-top: 1.5rem; }
  .status { font-size: 0.8rem; color: #888; margin-top: 0.5rem; }

  .inline-form {
    display: flex;
    gap: 0.25rem;
    align-items: center;
  }

  .inline-form input {
    background: #0a0a0a;
    border: 1px solid #333;
    color: #ccc;
    padding: 0.3rem 0.5rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.8rem;
    flex: 1;
  }

  .inline-form input::placeholder { color: #444; }
  .inline-form input:disabled { opacity: 0.4; }

  .btn {
    background: #1a1a1a;
    border: 1px solid #333;
    color: #ccc;
    padding: 0.3rem 0.75rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .btn:hover:not(:disabled) { background: #222; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>

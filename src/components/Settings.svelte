<script lang="ts">
  import { device, serialTransport } from '../lib/device.svelte.js'
  import { FrameType, buildSetPin, buildSetBridgeSecret } from '../lib/frame.js'
  import {
    getOrCreateOperator,
    regenerateOperator,
    importOperator,
    getOperatorMnemonic,
    importOperatorMnemonic,
  } from '../lib/op-mgmt.js'
  import { getProfileRelays, setProfileRelays, isValidRelayUrl } from '../lib/profile-relays.js'
  import { clearProfileCache } from '../lib/profiles.svelte.js'

  // --- Operator key (relay management authority) ---
  let operator = $state(getOrCreateOperator())
  let opMnemonic = $state(getOperatorMnemonic())
  let opReveal = $state(false)
  let opPhraseReveal = $state(false)
  let opImportValue = $state('')
  let opPhraseImport = $state('')
  let opStatus = $state<string | null>(null)

  async function handleCopyOpSecret() {
    try {
      await navigator.clipboard.writeText(operator.skHex)
      opStatus = 'Operator secret copied to clipboard.'
    } catch {
      opStatus = 'Copy failed — reveal and copy manually.'
    }
  }

  function handleImportOperator() {
    try {
      operator = importOperator(opImportValue)
      opMnemonic = getOperatorMnemonic()
      opImportValue = ''
      opReveal = false
      opStatus = `Imported. Operator pubkey is now ${operator.pubHex.slice(0, 16)}… — reconnect over WiFi.`
    } catch (e) {
      opStatus = e instanceof Error ? e.message : 'Import failed'
    }
  }

  function handleImportPhrase() {
    try {
      operator = importOperatorMnemonic(opPhraseImport)
      opMnemonic = getOperatorMnemonic()
      opPhraseImport = ''
      opPhraseReveal = false
      opStatus = `Restored from phrase. Operator pubkey is now ${operator.pubHex.slice(0, 16)}… — reconnect over WiFi.`
    } catch (e) {
      opStatus = e instanceof Error ? e.message : 'Restore failed'
    }
  }

  async function handleCopyPhrase() {
    if (!opMnemonic) return
    try {
      await navigator.clipboard.writeText(opMnemonic)
      opStatus = 'Recovery phrase copied to clipboard.'
    } catch {
      opStatus = 'Copy failed — reveal and write the words down manually.'
    }
  }

  function handleRegenerateOperator() {
    if (!confirm('Generate a NEW operator key? The current one is lost. Devices already flashed with the old key will reject management from this browser until re-flashed.')) return
    operator = regenerateOperator()
    opMnemonic = getOperatorMnemonic()
    opReveal = false
    opPhraseReveal = false
    opImportValue = ''
    opStatus = 'New operator key generated — write down its recovery phrase below.'
  }

  // --- Profile relays (kind-0 name lookups) ---
  let profileRelays = $state(getProfileRelays())
  let newProfileRelay = $state('')
  let profileRelayError = $state<string | null>(null)

  function persistProfileRelays() {
    setProfileRelays(profileRelays)
    profileRelays = getProfileRelays() // reflect validation + de-dupe
    clearProfileCache() // names re-resolve from the new relays
  }

  function addProfileRelay() {
    const url = newProfileRelay.trim()
    if (!isValidRelayUrl(url)) {
      profileRelayError = 'Enter a wss:// relay URL.'
      return
    }
    if (profileRelays.includes(url)) {
      profileRelayError = 'That relay is already listed.'
      return
    }
    profileRelays = [...profileRelays, url]
    newProfileRelay = ''
    profileRelayError = null
    persistProfileRelays()
  }

  function removeProfileRelay(index: number) {
    if (profileRelays.length <= 1) return
    profileRelays = profileRelays.filter((_, i) => i !== index)
    persistProfileRelays()
  }

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

  function modeLabel(): string {
    if (device.mode === 'serial') return 'USB (Web Serial)'
    if (device.mode === 'http') return 'Bridge (HTTP)'
    return 'Disconnected'
  }


</script>

<div class="settings">
  <h2>Connection</h2>
  <table><tbody>
    <tr><td class="label">Mode</td><td>{modeLabel()}</td></tr>
    <tr><td class="label">Port</td><td>{device.portInfo || '--'}</td></tr>
    <tr><td class="label">Masters</td><td>{device.masters.length}</td></tr>
    <tr><td class="label">Slots</td><td>{device.slots.length} (master slot {device.selectedSlot})</td></tr>
  </tbody></table>

  <h2>Operator Key</h2>
  <p class="info">Your authority to manage WiFi devices over relays. A device's expected operator is baked in when you flash it — management only works if this key matches. (This is <em>not</em> the master seed; it's a separate, lower-stakes key.) Back it up with the recovery phrase — write the words down and you can restore this exact key on any device.</p>
  <table><tbody>
    <tr><td class="label">Pubkey</td><td class="mono">{operator.pubHex}</td></tr>
    <tr>
      <td class="label">Recovery phrase</td>
      <td>
        {#if opMnemonic}
          {#if opPhraseReveal}
            <span class="mono phrase">{opMnemonic}</span>
            <div class="op-buttons">
              <button class="btn small" onclick={handleCopyPhrase}>Copy</button>
              <button class="btn small" onclick={() => opPhraseReveal = false}>Hide</button>
            </div>
          {:else}
            <span class="mono muted">•••• •••• •••• •••• (12 words)</span>
            <div class="op-buttons">
              <button class="btn small" onclick={() => opPhraseReveal = true}>Reveal</button>
              <button class="btn small" onclick={handleCopyPhrase}>Copy</button>
            </div>
          {/if}
        {:else}
          <span class="muted">No phrase — this is a legacy key. <strong>Regenerate</strong> to create a phrase-backed key (needs a re-flash).</span>
        {/if}
      </td>
    </tr>
    <tr>
      <td class="label">Secret</td>
      <td>
        {#if opReveal}
          <span class="mono secret">{operator.skHex}</span>
          <div class="op-buttons">
            <button class="btn small" onclick={handleCopyOpSecret}>Copy</button>
            <button class="btn small" onclick={() => opReveal = false}>Hide</button>
          </div>
        {:else}
          <span class="mono muted">••••••••••••••••••••••••••••••••</span>
          <div class="op-buttons">
            <button class="btn small" onclick={() => opReveal = true}>Reveal</button>
            <button class="btn small" onclick={handleCopyOpSecret}>Copy</button>
          </div>
        {/if}
      </td>
    </tr>
  </tbody></table>
  <div class="inline-form">
    <input
      type="text"
      bind:value={opPhraseImport}
      placeholder="Restore: type your 12/24-word recovery phrase"
      spellcheck="false"
      autocomplete="off"
    />
    <button class="btn" disabled={opPhraseImport.trim().split(/\s+/).length < 12} onclick={handleImportPhrase}>Restore</button>
    <button class="btn danger" onclick={handleRegenerateOperator}>Regenerate</button>
  </div>
  <details class="advanced-op">
    <summary>Advanced: import a raw 64-hex secret</summary>
    <div class="inline-form">
      <input
        type="text"
        bind:value={opImportValue}
        placeholder="Paste 64-hex operator secret"
        maxlength="64"
        spellcheck="false"
        autocomplete="off"
      />
      <button class="btn" disabled={opImportValue.trim().length !== 64} onclick={handleImportOperator}>Import</button>
    </div>
    <p class="hint">A raw secret has no recovery phrase. Use this only to match a device flashed elsewhere.</p>
  </details>
  {#if opStatus}
    <p class="status">{opStatus}</p>
  {/if}

  <h2>Profile Relays</h2>
  <p class="info">Where client names are looked up. Sapwood reads each client's kind-0 profile from these relays to show a name beside its pubkey. Read-only — nothing is published here.</p>
  <div class="relay-list">
    {#each profileRelays as relay, i (relay)}
      <div class="relay-row">
        <span class="mono relay-url">{relay}</span>
        <button class="btn small" disabled={profileRelays.length <= 1} onclick={() => removeProfileRelay(i)}>Remove</button>
      </div>
    {/each}
  </div>
  <div class="inline-form">
    <input
      type="url"
      bind:value={newProfileRelay}
      placeholder="wss://relay.example.com"
      spellcheck="false"
      autocomplete="off"
      onkeydown={(e) => { if (e.key === 'Enter') addProfileRelay() }}
    />
    <button class="btn" onclick={addProfileRelay}>Add</button>
  </div>
  {#if profileRelayError}
    <p class="status">{profileRelayError}</p>
  {/if}

  {#if device.mode === 'http' && device.bridgeInfo}
    <h2>Bunker URIs</h2>
    <p class="info">Bunker URIs are now per-connection. Manage them in the Connection Slots tab.</p>

    <h2>Bridge</h2>
    <table><tbody>
      <tr><td class="label">Mode</td><td>{device.bridgeInfo.mode}</td></tr>
      <tr><td class="label">Uptime</td><td>{formatUptime(device.bridgeInfo.uptime_secs as number)}</td></tr>
      <tr>
        <td class="label">Relays</td>
        <td>
          {#each (device.bridgeInfo.relays as string[]) as relay}
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
  .relay-list { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 0.5rem; }
  .relay-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .relay-url { flex: 1; }

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

  .mono {
    font-family: inherit;
    font-size: 0.75rem;
    color: var(--green-dim);
    word-break: break-all;
    user-select: all;
  }
  .mono.muted { color: #444; letter-spacing: 0.1em; }
  .mono.secret { color: var(--amber); }
  .mono.phrase { color: var(--text); line-height: 1.7; word-spacing: 0.25rem; display: inline-block; }
  .muted strong { color: var(--amber); }
  .advanced-op { margin-top: 0.75rem; }
  .advanced-op summary { font-size: 0.78rem; color: #666; cursor: pointer; }
  .advanced-op .hint { margin-top: 0.4rem; }
  .op-buttons { display: flex; gap: 0.25rem; margin-top: 0.4rem; }
  .btn.small { padding: 0.15rem 0.5rem; font-size: 0.72rem; }
  .btn.danger { border-color: var(--red-dim); color: var(--red); }
  .btn.danger:hover:not(:disabled) { background: #1a0c0c; }
  .info em { color: #777; font-style: normal; }
</style>

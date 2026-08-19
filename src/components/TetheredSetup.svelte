<script lang="ts">
  // Guided setup for a USB-tethered ESP8266 signer — a GUI alternative to the
  // `heartwood-provision` CLI, for people who'd rather click than type.
  //
  // The signing key IS created/handled in this browser, so the key step is gated
  // behind an explicit "this computer is offline" acknowledgement: an offline
  // browser is the same trust model as the offline CLI (a program on an
  // air-gapped machine), but it's clicks, not commands. The browser flashes the
  // public firmware, generates/restores the key and provisions it + the bridge
  // secret over USB, then renders the heartwood-bridge daemon config.
  import { onMount } from 'svelte'
  import { flashTetheredImage, TETHERED_BOARDS } from '../lib/flasher.js'
  import {
    generateMnemonic,
    deriveFromMnemonic,
    deriveFromNsec,
    decodeNsec,
    buildProvisionFrame,
    zeroize,
    type ProvisionMode,
  } from '../lib/provision.js'
  import { buildSetBridgeSecret, FrameType } from '../lib/frame.js'
  import { transport as serialTransport } from '../lib/serial.js'
  import { generateBridgeSecret, bridgeArtifacts, type BridgeArtifacts } from '../lib/bridge-setup.js'
  import { copyText } from '../lib/clipboard.js'

  type Step = 'intro' | 'flash' | 'provision' | 'bridge' | 'done'
  let step = $state<Step>('intro')

  const board = TETHERED_BOARDS[0]
  const hasWebSerial = typeof navigator !== 'undefined' && 'serial' in navigator

  // Per-OS serial-port hint (for the bridge host field, step 3).
  function detectOs(): 'mac' | 'linux' | 'windows' | 'other' {
    const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '').toLowerCase()
    if (ua.includes('mac')) return 'mac'
    if (ua.includes('win')) return 'windows'
    if (ua.includes('linux') || ua.includes('x11')) return 'linux'
    return 'other'
  }
  const os = detectOs()
  const defaultPort = os === 'mac' ? '/dev/cu.usbserial-110' : os === 'windows' ? 'COM3' : '/dev/ttyUSB0'

  // Network indicator for the offline gate. navigator.onLine is a hint (it only
  // means "a network interface is up"), so we pair it with an explicit checkbox.
  let online = $state(typeof navigator !== 'undefined' ? navigator.onLine : true)
  onMount(() => {
    const on = () => (online = true)
    const off = () => (online = false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  })
  let offlineAck = $state(false)

  // --- Flash (public firmware — no key involved) -------------------------
  let flashing = $state(false)
  let flashPct = $state(0)
  let flashMsg = $state('')
  let flashDone = $state(false)

  async function flash() {
    flashing = true
    flashMsg = ''
    try {
      await flashTetheredImage(board, {
        onProgress: (p) => (flashPct = p),
        onLog: (l) => (flashMsg = l),
      })
      flashDone = true
      flashMsg = 'Flashed. Press the RESET button on the board so it starts the new firmware.'
    } catch (e) {
      flashMsg = e instanceof Error ? e.message : 'Flashing failed.'
    } finally {
      flashing = false
    }
  }

  // --- Provision (offline, in-browser) -----------------------------------
  let source = $state<'create' | 'import'>('create')
  let mnemonic = $state('')
  let written = $state(false)
  let importText = $state('')
  let provisioning = $state(false)
  let provisionMsg = $state('')
  let npub = $state('')
  let bridgeSecret = $state('') // generated here, set on the device + shown in step 3

  function newPhrase() {
    mnemonic = generateMnemonic(128)
    written = false
    npub = ''
    provisionMsg = ''
  }

  async function deriveSecret(): Promise<{ secret: Uint8Array; mode: ProvisionMode; npub: string }> {
    if (source === 'create') {
      const r = await deriveFromMnemonic(mnemonic.trim(), '')
      return { secret: r.secret, mode: 'tree-mnemonic', npub: r.npub }
    }
    const t = importText.trim()
    if (t.startsWith('nsec1')) {
      // deriveFromNsec copies the bytes into its result, so the decoded nsec
      // can (and must) be wiped straight after — same pattern as restore.ts.
      const bytes = decodeNsec(t)
      try {
        const r = deriveFromNsec(bytes)
        return { secret: r.secret, mode: 'tree-nsec', npub: r.npub }
      } finally {
        zeroize(bytes)
      }
    }
    const r = await deriveFromMnemonic(t, '')
    return { secret: r.secret, mode: 'tree-mnemonic', npub: r.npub }
  }

  const canProvision = $derived(
    offlineAck &&
      (source === 'create' ? mnemonic.trim().length > 0 && written : importText.trim().length > 0),
  )

  async function provision() {
    provisioning = true
    provisionMsg = ''
    let secret: Uint8Array | null = null
    try {
      if (!serialTransport.connected) {
        provisionMsg = 'Choose your signer’s USB port in the browser dialog…'
        await serialTransport.connect(115200)
      }
      if (!bridgeSecret) bridgeSecret = generateBridgeSecret()

      const d = await deriveSecret()
      secret = d.secret
      provisionMsg = 'On the signer, hold the FLASH button to approve the new key…'
      const resp = await serialTransport.sendAndReceive(
        buildProvisionFrame(secret, 'default', d.mode),
        [FrameType.ACK, FrameType.NACK],
        45_000,
      )
      if (resp.type !== FrameType.ACK) {
        throw new Error('The signer declined the key (button not held, or it timed out).')
      }
      provisionMsg = 'Pairing the bridge secret…'
      const r2 = await serialTransport.sendAndReceive(
        buildSetBridgeSecret(bridgeSecret),
        [FrameType.ACK, FrameType.NACK],
        15_000,
      )
      if (r2.type !== FrameType.ACK) throw new Error('The signer declined the bridge secret.')

      npub = d.npub
      provisionMsg = ''
      // The seed material now lives on the device — drop every browser-side
      // copy held in component state so it does not linger for the page's
      // lifetime. (The derived bytes are zeroized in the finally below.)
      mnemonic = ''
      importText = ''
      written = false
      step = 'bridge'
    } catch (e) {
      provisionMsg = e instanceof Error ? e.message : 'Provisioning failed.'
    } finally {
      if (secret) zeroize(secret)
      provisioning = false
    }
  }

  // --- Bridge daemon config ----------------------------------------------
  let hostPort = $state(defaultPort)
  let relaysText = $state('wss://relay.trotters.cc')
  let copied = $state('')

  let artifacts: BridgeArtifacts | null = $derived.by(() => {
    if (!/^[0-9a-f]{64}$/i.test(bridgeSecret)) return null
    try {
      return bridgeArtifacts({
        devicePort: hostPort,
        secretHex: bridgeSecret.toLowerCase(),
        relays: relaysText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
      })
    } catch {
      return null
    }
  })

  async function copy(label: string, text: string) {
    if (await copyText(text)) {
      copied = label
      setTimeout(() => (copied = copied === label ? '' : copied), 1500)
    }
  }
</script>

<section class="tethered" aria-label="Set up a tethered signer">
  <h1>USB tethered signer</h1>

  {#if !hasWebSerial}
    <p class="lede">This setup needs <strong>Chrome or Edge</strong> on a computer (Web Serial). Open
      this page there. Prefer the command line? See <code>provision/README.md</code> for the
      <code>heartwood-provision</code> tool.</p>
  {:else if step === 'intro'}
    <p class="lede">
      The ESP8266 signer has <strong>no Wi-Fi</strong>. It reaches Nostr through a small
      <strong>bridge</strong> program on an always-on computer (a Raspberry Pi is ideal), connected to
      the signer by USB. We'll flash it, set its key, and give you the bridge to run, all here.
    </p>
    <div class="card">
      <p class="hint">
        The key is created on <strong>this computer</strong>. In a moment you'll be asked to
        <strong>disconnect it from the internet</strong> first. That's what keeps the key safe, the same
        as the command-line tool.
      </p>
    </div>
    <button class="btn btn-primary" onclick={() => (step = 'flash')}>Begin →</button>

  {:else if step === 'flash'}
    <h2 class="section-title">1 · Flash the firmware</h2>
    <p class="lede">Plug the ESP8266 into this computer with a USB cable, then flash it. This writes
      the public firmware only, no key yet, so it's fine to do online.</p>
    {#if flashing || flashPct > 0}
      <div class="progress"><div class="progress-fill" style="width: {flashPct}%"></div></div>
    {/if}
    {#if flashMsg}<p class="hint">{flashMsg}</p>{/if}
    <div class="row">
      <button class="btn btn-primary" disabled={flashing} onclick={flash}>
        {flashing ? `Flashing… ${flashPct}%` : flashDone ? 'Re-flash' : 'Flash firmware'}
      </button>
      <button class="btn btn-secondary" onclick={() => (step = 'provision')}>
        {flashDone ? 'Continue →' : 'Skip (already flashed) →'}
      </button>
    </div>

  {:else if step === 'provision'}
    <h2 class="section-title">2 · Set the key</h2>

    <div class="gate" class:armed={offlineAck}>
      <p class="gate-title">⚠ Go offline first</p>
      <p>Your signing key is about to be created on this computer. <strong>Turn off Wi-Fi and unplug
        any network cable now.</strong> Anyone who can reach this machine over a network while the key
        exists could steal it.</p>
      {#if online}
        <p class="gate-online">This browser still reports a network connection. Disconnect, then tick the box.</p>
      {/if}
      <label class="check"><input type="checkbox" bind:checked={offlineAck} />
        This computer is disconnected from the internet.</label>
    </div>

    <fieldset class="keybox" disabled={!offlineAck}>
      <div class="seg">
        <button class:active={source === 'create'} onclick={() => (source = 'create')}>Create a new key</button>
        <button class:active={source === 'import'} onclick={() => (source = 'import')}>Import existing</button>
      </div>

      {#if source === 'create'}
        <p class="lede">Generate a recovery phrase. <strong>Write it down on paper</strong>. It is the
          only backup of this signer's key.</p>
        <button class="btn btn-secondary" onclick={newPhrase}>{mnemonic ? 'Regenerate' : 'Generate phrase'}</button>
        {#if mnemonic}
          <pre class="phrase">{mnemonic}</pre>
          <label class="check"><input type="checkbox" bind:checked={written} /> I've written it down safely.</label>
        {/if}
      {:else}
        <p class="lede">Paste an existing <code>nsec1…</code> or a 12/24-word recovery phrase.</p>
        <textarea bind:value={importText} rows="3" placeholder="nsec1… or twelve word recovery phrase" spellcheck="false"></textarea>
      {/if}

      {#if provisionMsg}<p class="hint">{provisionMsg}</p>{/if}
      <button class="btn btn-primary" disabled={!canProvision || provisioning} onclick={provision}>
        {provisioning ? 'Provisioning…' : 'Connect + write key →'}
      </button>
    </fieldset>

  {:else if step === 'bridge'}
    <h2 class="section-title">3 · Run the bridge</h2>
    {#if npub}<p class="success-text">✓ Key written. Signer npub: <code class="mono">{npub}</code></p>{/if}
    <p class="lede">On the always-on computer the signer plugs into, set its USB port + relays, then
      run these. The bridge secret below is already set on your device.</p>

    <div class="grid">
      <label class="field">
        <span class="field-label">Bridge secret (already on your device)</span>
        <input type="text" class="field-input" value={bridgeSecret} readonly />
      </label>
      <label class="field">
        <span class="field-label">Signer's port on that computer</span>
        <input type="text" class="field-input" bind:value={hostPort} placeholder={defaultPort} />
        <span class="field-hint">Linux/Pi: <code>/dev/ttyUSB0</code> · macOS: <code>/dev/cu.usbserial-…</code> · Windows: <code>COM3</code></span>
      </label>
      <label class="field">
        <span class="field-label">Relays (one per line)</span>
        <textarea class="field-input" bind:value={relaysText} rows="2"></textarea>
      </label>
    </div>

    {#if artifacts}
      <div class="code-card">
        <div class="code-card-head"><span>Create the bridge's config</span>
          <button class="btn btn-secondary btn-sm" onclick={() => copy('setup', artifacts.setupScript)}>{copied === 'setup' ? 'Copied' : 'Copy'}</button>
        </div>
        <pre>{artifacts.setupScript}</pre>
      </div>
      <div class="code-card">
        <div class="code-card-head"><span>Run the bridge</span>
          <button class="btn btn-secondary btn-sm" onclick={() => copy('run', artifacts.runCommand)}>{copied === 'run' ? 'Copied' : 'Copy'}</button>
        </div>
        <pre>{artifacts.runCommand}</pre>
      </div>
      <button class="btn btn-secondary" onclick={() => (step = 'done')}>Done →</button>
    {:else}
      <p class="hint-sm">Enter the signer's port and at least one relay to generate the bridge config.</p>
    {/if}

  {:else if step === 'done'}
    <h2 class="section-title">✓ Your tethered signer is ready</h2>
    <p class="lede">
      You can reconnect this computer to the internet now. Start the bridge on your always-on computer
      (step 3) and it answers NIP-46 over your relays, including any <strong>personas</strong> an app
      derives from this signer. Point a NIP-46 app at the signer's npub to sign.
    </p>
    <button class="btn btn-secondary" onclick={() => { step = 'intro'; offlineAck = false }}>Set up another</button>
  {/if}
</section>

<style>
  .tethered { color: var(--text); max-width: 640px; }
  h1 { font-size: 1.25rem; font-weight: 700; color: #fff; margin: 0 0 1rem; }
  .lede { font-size: 0.92rem; color: var(--text-dim); line-height: 1.6; margin: 0 0 1rem; }
  .lede strong { color: var(--text); }
  .lede code { color: var(--green); word-break: break-all; }
  .hint { margin: 0.6rem 0; }
  .card > .hint { margin: 0; }
  .row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin-top: 0.6rem; }

  .gate { background: #1a0d0d; border: 1px solid var(--red); border-radius: 6px; padding: 0.8rem 1rem; margin-bottom: 1.2rem; }
  .gate.armed { background: #0a0a0a; border-color: var(--border); }
  .gate p { font-size: 0.85rem; color: var(--text-dim); line-height: 1.55; margin: 0 0 0.5rem; }
  .gate-title { font-weight: 700; color: #fff !important; font-size: 0.95rem !important; }
  .gate-online { color: var(--red) !important; }

  .keybox { border: none; padding: 0; margin: 0; min-width: 0; }
  .keybox:disabled { opacity: 0.45; }

  .seg { display: inline-flex; border: 1px solid var(--border-bright); border-radius: 6px; overflow: hidden; margin-bottom: 1rem; }
  .seg button { background: transparent; color: var(--text-dim); border: none; padding: 0.5rem 1rem; cursor: pointer; font-family: inherit; font-size: 0.85rem; }
  .seg button.active { background: var(--green); color: #050505; font-weight: 600; }

  .phrase { background: #08130d; border: 1px solid var(--green-dim); border-radius: 6px;
    padding: 0.9rem; color: var(--green); font-size: 0.95rem; line-height: 1.7; white-space: pre-wrap;
    word-spacing: 0.3rem; margin: 0.8rem 0; }
  .check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; color: var(--text-dim); margin-bottom: 1rem; }

  input[readonly] { color: var(--text-muted); }
  .grid { display: grid; gap: 0.4rem; margin-bottom: 1rem; }

  .code-card { background: #0a0a0a; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 0.9rem; overflow: hidden; }
  .code-card-head { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.7rem;
    border-bottom: 1px solid var(--border); font-size: 0.82rem; color: var(--text-dim); }
  .code-card pre { margin: 0; padding: 0.7rem; font-size: 0.8rem; color: var(--text); overflow-x: auto; white-space: pre-wrap; word-break: break-all; }

  .progress { margin: 0.6rem 0; }
</style>

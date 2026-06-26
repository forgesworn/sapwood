<script lang="ts">
  // Guided setup for a USB-tethered ESP8266 signer.
  //
  // The signing key is NEVER handled in this browser. It is restored (from a
  // recovery phrase / nsec) or generated on an OFFLINE computer with the
  // `heartwood-provision` CLI, which also pairs the bridge secret. This wizard
  // does only what the browser can safely do: flash the (public) firmware, and
  // render the heartwood-bridge daemon config to run on an always-on host.
  // See heartwood-esp32/provision/README.md.
  import { flashTetheredImage, TETHERED_BOARDS } from '../lib/flasher.js'
  import { bridgeArtifacts, type BridgeArtifacts } from '../lib/bridge-setup.js'

  type Step = 'intro' | 'flash' | 'provision' | 'bridge' | 'done'
  let step = $state<Step>('intro')

  const board = TETHERED_BOARDS[0]
  const hasWebSerial = typeof navigator !== 'undefined' && 'serial' in navigator

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
      flashMsg = 'Flashed. Press RESET on the board so it starts the new firmware.'
    } catch (e) {
      flashMsg = e instanceof Error ? e.message : 'Flashing failed.'
    } finally {
      flashing = false
    }
  }

  // --- Bridge daemon config ----------------------------------------------
  // The bridge secret is produced by the offline provision CLI (--gen-bridge-secret
  // prints it); paste it here. It is NOT the signing key — only a session token —
  // so it is safe to handle here.
  let bridgeSecret = $state('')
  let hostPort = $state('/dev/ttyUSB0')
  let relaysText = $state('wss://relay.trotters.cc')
  let copied = $state('')

  // The offline commands shown in step 2 (constant text).
  const RESTORE_CMD =
    'heartwood-provision --port /dev/ttyUSB0 provision \\\n  --mode tree-mnemonic --gen-bridge-secret'
  const GENERATE_CMD =
    'heartwood-provision --port /dev/ttyUSB0 generate \\\n  --words 12 --gen-bridge-secret'

  const secretValid = $derived(/^[0-9a-f]{64}$/i.test(bridgeSecret.trim()))
  let artifacts: BridgeArtifacts | null = $derived.by(() => {
    if (!secretValid) return null
    try {
      return bridgeArtifacts({
        devicePort: hostPort,
        secretHex: bridgeSecret.trim().toLowerCase(),
        relays: relaysText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
      })
    } catch {
      return null
    }
  })

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      copied = label
      setTimeout(() => (copied = copied === label ? '' : copied), 1500)
    } catch {
      /* clipboard blocked — the text is on screen to copy by hand */
    }
  }
</script>

<section class="tethered" aria-label="Set up a tethered signer">
  <h1>USB tethered signer</h1>

  {#if step === 'intro'}
    <p class="lede">
      The ESP8266 signer has <strong>no WiFi</strong>. It reaches Nostr through a small
      <strong>bridge</strong> program you run on an always-on computer (a Raspberry Pi is ideal),
      connected to the signer by USB. We'll flash it here, then you set its key <strong>offline</strong>
      and run the bridge.
    </p>
    <p class="note">
      Your signing key is <strong>never entered in this browser</strong>. You'll set it on an
      offline computer with the <code>heartwood-provision</code> tool — the only safe place for a key.
    </p>
    <button class="btn primary" onclick={() => (step = 'flash')}>Begin →</button>

  {:else if step === 'flash'}
    <h2>1 · Flash the firmware</h2>
    <p class="lede">Plug the ESP8266 into this computer with a USB cable, then flash it. This writes
      the public firmware only — no key is involved, so it's fine to do here.</p>
    {#if !hasWebSerial}
      <p class="note">Flashing needs <strong>Chrome or Edge</strong> (Web Serial). You can also flash
        offline with <code>esptool</code> — see <code>esp8266-firmware/FLASHING.md</code>.</p>
    {:else}
      {#if flashing || flashPct > 0}
        <div class="progress"><div class="fill" style="width: {flashPct}%"></div></div>
      {/if}
      {#if flashMsg}<p class="msg">{flashMsg}</p>{/if}
      <div class="row">
        <button class="btn primary" disabled={flashing} onclick={flash}>
          {flashing ? `Flashing… ${flashPct}%` : flashDone ? 'Re-flash' : 'Flash firmware'}
        </button>
      </div>
    {/if}
    <div class="row">
      <button class="btn ghost" onclick={() => (step = 'provision')}>
        {flashDone ? 'Continue →' : 'Skip (already flashed) →'}
      </button>
    </div>

  {:else if step === 'provision'}
    <h2>2 · Set the key — offline</h2>
    <p class="lede">
      On an <strong>offline computer</strong> (no internet) with the signer plugged in, run the
      provision tool. It puts your key on the device and pairs the bridge secret — the key never
      touches a networked machine or this browser.
    </p>
    <div class="card">
      <div class="card-head"><span>Restore an existing key</span>
        <button class="copy" onclick={() => copy('restore', RESTORE_CMD)}>{copied === 'restore' ? 'Copied' : 'Copy'}</button>
      </div>
      <pre>{RESTORE_CMD}</pre>
    </div>
    <div class="card">
      <div class="card-head"><span>…or generate a fresh key</span>
        <button class="copy" onclick={() => copy('gen', GENERATE_CMD)}>{copied === 'gen' ? 'Copied' : 'Copy'}</button>
      </div>
      <pre>{GENERATE_CMD}</pre>
    </div>
    <p class="note">
      Hold the device's <strong>FLASH</strong> button to approve when it prompts. The tool prints a
      <strong>bridge secret</strong> — copy it; you'll paste it next. Full guide:
      <code>provision/README.md</code>.
    </p>
    <button class="btn primary" onclick={() => (step = 'bridge')}>I've provisioned it →</button>

  {:else if step === 'bridge'}
    <h2>3 · Run the bridge</h2>
    <p class="lede">On the always-on computer the signer plugs into, paste the bridge secret the tool
      printed, set the port + relays, then run these.</p>
    <div class="grid">
      <label>Bridge secret (from the provision tool)
        <input type="text" bind:value={bridgeSecret} placeholder="64 hex characters" spellcheck="false" />
      </label>
      {#if bridgeSecret.trim() && !secretValid}
        <p class="msg err">That isn't a 64-character hex secret.</p>
      {/if}
      <label>Signer's port on that computer
        <input type="text" bind:value={hostPort} placeholder="/dev/ttyUSB0" />
      </label>
      <label>Relays (one per line)
        <textarea bind:value={relaysText} rows="2"></textarea>
      </label>
    </div>

    {#if artifacts}
      <div class="card">
        <div class="card-head"><span>Create the bridge's config</span>
          <button class="copy" onclick={() => copy('setup', artifacts.setupScript)}>{copied === 'setup' ? 'Copied' : 'Copy'}</button>
        </div>
        <pre>{artifacts.setupScript}</pre>
      </div>
      <div class="card">
        <div class="card-head"><span>Run the bridge</span>
          <button class="copy" onclick={() => copy('run', artifacts.runCommand)}>{copied === 'run' ? 'Copied' : 'Copy'}</button>
        </div>
        <pre>{artifacts.runCommand}</pre>
      </div>
      <button class="btn ghost" onclick={() => (step = 'done')}>Done →</button>
    {:else}
      <p class="note">Paste the bridge secret and a relay to generate the bridge config.</p>
    {/if}

  {:else if step === 'done'}
    <h2>✓ Your tethered signer is ready</h2>
    <p class="lede">
      Start the bridge on your always-on computer (step 3) and it answers NIP-46 over your relays —
      including any <strong>personas</strong> a client derives from this signer. Point a NIP-46 client
      at the signer's npub to sign.
    </p>
    <button class="btn ghost" onclick={() => (step = 'intro')}>Set up another</button>
  {/if}
</section>

<style>
  .tethered { color: var(--text); max-width: 640px; }
  h1 { font-size: 1.25rem; font-weight: 700; color: #fff; margin: 0 0 1rem; }
  h2 { font-size: 1.05rem; font-weight: 700; color: #fff; margin: 0 0 0.8rem; }
  .lede { font-size: 0.92rem; color: var(--text-dim); line-height: 1.6; margin: 0 0 1rem; }
  .lede strong, .note strong { color: var(--text); }
  .note code { color: var(--green); word-break: break-all; }
  .note { font-size: 0.85rem; color: var(--text-muted); line-height: 1.55; margin: 0 0 1rem;
    background: #110d08; border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem 0.85rem; }
  .msg { font-size: 0.85rem; color: var(--text-dim); margin: 0.6rem 0; line-height: 1.5; }
  .msg.err { color: var(--red); }
  .row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; margin-top: 0.6rem; }

  .btn { font-family: inherit; font-size: 0.92rem; font-weight: 600; padding: 0.6rem 1.4rem;
    border-radius: 5px; cursor: pointer; border: 1px solid transparent; }
  .btn.primary { background: var(--green); color: #050505; border-color: var(--green); }
  .btn.primary:hover:not(:disabled) { background: #00ff88; }
  .btn.ghost { background: transparent; color: var(--text-dim); border-color: var(--border-bright); }
  .btn.ghost:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  input[type=text], textarea { width: 100%; box-sizing: border-box; background: #0a0a0a;
    border: 1px solid var(--border-bright); border-radius: 6px; color: var(--text);
    font-family: inherit; font-size: 0.9rem; padding: 0.6rem; margin: 0.3rem 0 0.8rem; }
  .grid { display: grid; gap: 0.3rem; margin-bottom: 1rem; }
  .grid label { font-size: 0.82rem; color: var(--text-dim); }

  .card { background: #0a0a0a; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 0.9rem; overflow: hidden; }
  .card-head { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.7rem;
    border-bottom: 1px solid var(--border); font-size: 0.82rem; color: var(--text-dim); }
  .card pre { margin: 0; padding: 0.7rem; font-size: 0.8rem; color: var(--text); overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .copy { background: transparent; border: 1px solid var(--border-bright); color: var(--text-dim);
    border-radius: 4px; padding: 0.2rem 0.6rem; font-size: 0.75rem; cursor: pointer; }
  .copy:hover { color: var(--text); border-color: var(--green-dim); }

  .progress { height: 6px; background: #11221a; border-radius: 3px; margin: 0.6rem 0; overflow: hidden; }
  .fill { height: 100%; background: var(--green); transition: width 0.2s; }
</style>

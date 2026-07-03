<script lang="ts">
  // The /flash surface: a focused, guided flasher (flasher.meshtastic.org model).
  // Desktop + USB only. Walks a newcomer from "plug it in" to "your signer is
  // live" in one calm flow. All decisions delegate to the pure wizard lib; the
  // flash itself goes through flashDevice (same path the old Flash tab used).
  import { flashDevice, BOARDS, type FlasherBackend } from './lib/flasher.js'
  import { boardCandidates, type BoardCandidates } from './lib/board-detect.js'
  import { findAttachedGrantedPort } from './lib/serial-ports.js'
  import { getOrCreateOperator, type Operator } from './lib/op-mgmt.js'
  import { device, disconnect } from './lib/device.svelte.js'
  import { navigate } from './lib/route.svelte.js'
  import { copyText } from './lib/clipboard.js'
  import type { NetConfig } from './lib/frame'
  import {
    type WizardStep, type WizardData,
    USER_STEPS, initialData, networkError, canAdvance,
    nextStep, prevStep, friendlyStage, SUGGESTED_SIGNER_RELAYS,
  } from './lib/wizard.js'
  import TetheredSetup from './components/TetheredSetup.svelte'
  import PasswordReveal from './components/PasswordReveal.svelte'
  import RelayEditor from './components/RelayEditor.svelte'

  const webSerial = typeof navigator !== 'undefined' && 'serial' in navigator

  let step = $state<WizardStep>('welcome')
  let data = $state<WizardData>(initialData())
  let showWifiPw = $state(false)
  // The ESP8266 is a USB-tethered, no-WiFi signer — its own flow, not the WiFi wizard.
  let tethered = $state(false)
  let showAdvanced = $state(false)

  // Flash progress
  let pct = $state(0)
  let rawStage = $state('starting')
  let logLines = $state<string[]>([])
  let flashError = $state('')
  let operator = $state<Operator | null>(null)
  let copied = $state(false)

  // E2E seam: tests inject a fake backend on window so the whole flash flow can
  // run in a real browser without hardware. Undefined in production, so
  // flashDevice falls back to its default esptool-js backend.
  function flashBackend(): FlasherBackend | undefined {
    return (globalThis as unknown as { __sapwoodFlashBackend?: FlasherBackend }).__sapwoodFlashBackend
  }

  const board = $derived(BOARDS.find((b) => b.id === data.boardId))
  const netError = $derived(networkError(data))
  const userStepNo = $derived(USER_STEPS.indexOf(step) + 1) // 1..4, or 0 outside

  // --- Board detection from the cable ---
  // The USB descriptor names the bridge chip, which narrows the board: one
  // certain match is selected for you; native-USB boards (V4/C6) tie, so both
  // are tagged and you pick. Runs prompt-free on entry when the port was
  // granted before; the button covers a brand-new device (one chooser).
  let detected = $state<BoardCandidates | null>(null)
  let detectError = $state('')

  function applyCandidates(c: BoardCandidates, { quiet = false } = {}) {
    if (!c.boardIds.length) {
      if (!quiet) detectError = "Couldn't recognise that USB device. Pick your board from the list."
      return
    }
    detected = c
    detectError = ''
    // Auto-select only a single, certain ESP32 match, and never override a
    // choice already made. The ESP8266 gets tagged, not auto-entered — its
    // setup is a different flow, so that stays a deliberate click.
    if (c.boardIds.length === 1 && c.boardIds[0] !== 'esp8266' && !data.boardId) {
      data.boardId = c.boardIds[0]
    }
  }

  // Prompt-free pass whenever the board step is (re)entered.
  $effect(() => {
    if (step !== 'board' || detected) return
    void findAttachedGrantedPort().then((port) => {
      if (port && step === 'board') applyCandidates(boardCandidates(port.getInfo()), { quiet: true })
    })
  })

  async function detectFromCable() {
    detectError = ''
    try {
      const port = await navigator.serial.requestPort({
        filters: [
          { usbVendorId: 0x303a, usbProductId: 0x1001 },
          { usbVendorId: 0x1a86 },
          { usbVendorId: 0x10c4 },
          { usbVendorId: 0x0403 },
        ],
      })
      applyCandidates(boardCandidates(port.getInfo()))
    } catch {
      /* chooser dismissed — nothing to do */
    }
  }

  function goNext() {
    if (canAdvance(step, data)) step = nextStep(step)
  }
  function goBack() {
    step = prevStep(step)
  }

  function appendLog(line: string) {
    if (line) logLines = [...logLines.slice(-300), line]
  }

  async function copyOperator() {
    if (!operator) return
    const ok = await copyText(operator.skHex)
    if (ok) {
      copied = true
      setTimeout(() => (copied = false), 1500)
    }
  }

  async function startFlash() {
    const wifi = data.netMode === 'wifi'
    const relays = wifi ? data.relays : []
    const op = getOrCreateOperator()
    const cfg: NetConfig = {
      ssid: wifi ? data.ssid.trim() : '',
      password: wifi ? data.password : '',
      relays,
      mode: data.netMode,
      op_mgmt: op.pubHex,
    }
    // Remember relays so the admin console can default this device's relay.
    // A USB-only signer has none — it is reached over the cable (or its bridge).
    if (wifi) {
      try { localStorage.setItem('heartwood.lastRelays', JSON.stringify(relays)) } catch { /* ignore */ }
    }

    step = 'flashing'
    pct = 0
    rawStage = 'starting'
    flashError = ''
    logLines = []
    operator = null

    try {
      await flashDevice(board!, cfg, {
        fullErase: data.fullErase,
        onLog: appendLog,
        onProgress: (p, label) => { pct = p; rawStage = label },
      }, flashBackend())
      operator = op
      step = 'done'
      // Tell the console this is a freshly-flashed device still on USB, so it
      // leads with "finish setting up" rather than "set up a new device".
      try { sessionStorage.setItem('heartwood.justFlashed', '1') } catch { /* ignore */ }
    } catch (e) {
      flashError = e instanceof Error ? e.message : String(e)
    }
  }

  function restart() {
    data = initialData()
    step = 'welcome'
    pct = 0
    rawStage = 'starting'
    logLines = []
    flashError = ''
    operator = null
    showAdvanced = false
  }
</script>

<main>
  <header>
    <div class="brand">
      <h1>SAPWOOD</h1>
      <span class="divider"></span>
      <p class="tagline">SET UP YOUR SIGNER</p>
    </div>
    <button class="btn-link console-link" onclick={() => navigate('admin')}>Advanced console →</button>
  </header>

  {#if !tethered && step !== 'flashing' && step !== 'done'}
    <ol class="stepper" aria-label="setup steps">
      {#each USER_STEPS.slice(1) as s, i (s)}
        <li class:done={userStepNo - 1 > i + 1} class:current={step === s}>
          <span class="dot">{i + 1}</span>
          <span class="label">{s}</span>
        </li>
      {/each}
    </ol>
  {/if}

  <section class="panel">
    {#if tethered}
      <button class="btn-link" onclick={() => (tethered = false)}>← Choose a different board</button>
      <TetheredSetup />
    {:else if step === 'welcome'}
      <h2>Set up your Heartwood</h2>
      <p class="lede">
        This installs the signing software on your device and sets up how it connects. Usually
        that's your Wi-Fi, so you can manage it from your phone afterwards. You'll need the device and a
        USB cable. It takes about a minute.
      </p>
      {#if !webSerial}
        <div class="card card--danger">
          <p class="error-text">
            Flashing needs a computer running Chrome or Edge, which can talk to USB devices from the
            browser. Open this page there, then come back.
          </p>
        </div>
      {:else}
        <p class="hint-sm">Works in Chrome and Edge on a computer. You won't flash from a phone.</p>
      {/if}
      <div class="actions">
        <button class="btn btn-primary" onclick={goNext} disabled={!webSerial}>Start</button>
      </div>

    {:else if step === 'board'}
      <h2>Which device do you have?</h2>
      <p class="lede">Pick the board you're holding. The model is printed on it.</p>
      {#if detected}
        <p class="detect-note">
          ✓ Recognised {detected.via} on your cable.
          {detected.boardIds.length === 1 ? 'The matching board is selected.' : 'It is one of the tagged boards.'}
        </p>
      {:else if webSerial}
        <button class="btn-link detect-link" onclick={detectFromCable}>
          Plugged in already? Work it out from the cable →
        </button>
        {#if detectError}<p class="warn-text">{detectError}</p>{/if}
      {/if}
      <div class="boards">
        {#each BOARDS as b (b.id)}
          <button
            class="board-card"
            class:selected={data.boardId === b.id}
            onclick={() => (data.boardId = b.id)}
            aria-pressed={data.boardId === b.id}
          >
            <span class="board-name">{b.label}
              {#if detected?.boardIds.includes(b.id)}<span class="detect-tag">on your cable</span>{/if}
            </span>
            <span class="board-tick">{data.boardId === b.id ? '●' : '○'}</span>
          </button>
        {/each}
        <!-- The ESP8266 is a board like any other to choose — but its setup is its
             own guided flow (no WiFi on the signer; provisioned in-browser; runs
             behind the bridge daemon), so picking it hands over rather than
             advancing this wizard. -->
        <button class="board-card board-card--tethered" onclick={() => (tethered = true)}>
          <span class="board-body">
            <span class="board-name">ESP8266 <span class="board-tag">USB-tethered · hardened</span>
              {#if detected?.boardIds.includes('esp8266')}<span class="detect-tag">on your cable</span>{/if}
            </span>
            <span class="board-sub">No WiFi on the signer. It stays plugged into an always-on
              computer and the bridge daemon carries its traffic. Its own guided setup.</span>
          </span>
          <span class="board-tick">→</span>
        </button>
      </div>
      <p class="hint-sm">Plug the board into this computer with a USB cable now, if you haven't already.</p>
      <div class="actions">
        <button class="btn btn-secondary" onclick={goBack}>Back</button>
        <button class="btn btn-primary" onclick={goNext} disabled={!canAdvance('board', data)}>Next</button>
      </div>

    {:else if step === 'network'}
      {#snippet wipeOption()}
        <!-- Destructive, so it wears the danger colours even behind the
             Advanced disclosure, with a full-size control. -->
        <div class="card card--danger wipe">
          <p class="wipe-title">Wipe the device first</p>
          <p class="wipe-desc">Clears any identity already on it for a clean start.
            This destroys all keys on the device.</p>
          <label class="wipe-toggle">
            <input type="checkbox" bind:checked={data.fullErase} />
            <span>Yes, wipe everything on this device</span>
          </label>
        </div>
      {/snippet}
      <h2>How will it connect?</h2>
      <div class="mode-cards">
        <button
          class="mode-card"
          class:selected={data.netMode === 'wifi'}
          onclick={() => (data.netMode = 'wifi')}
          aria-pressed={data.netMode === 'wifi'}
        >
          <span class="mode-name">Join my Wi-Fi <span class="mode-tag">recommended</span></span>
          <span class="mode-desc">The signer sits on your network and works from anywhere,
            so you can manage it from your phone. No extra software.</span>
        </button>
        <button
          class="mode-card"
          class:selected={data.netMode === 'usb'}
          onclick={() => (data.netMode = 'usb')}
          aria-pressed={data.netMode === 'usb'}
        >
          <span class="mode-name">USB-only <span class="mode-tag mode-tag--amber">hardened</span></span>
          <span class="mode-desc">The radio stays off, so the key-holding chip never touches a
            network. Needs a bridge daemon for apps to reach it remotely.</span>
        </button>
      </div>

      {#if data.netMode === 'wifi'}
        <p class="lede">The device joins this network on its own once it's set up.</p>
        <label class="field">
          <span class="field-label">Wi-Fi name</span>
          <input class="field-input" bind:value={data.ssid} placeholder="your network" autocomplete="off" />
        </label>
        <label class="field">
          <span class="field-label">Wi-Fi password</span>
          <div class="pw-wrap">
            <input class="field-input" type={showWifiPw ? 'text' : 'password'} bind:value={data.password} autocomplete="off" />
            <PasswordReveal bind:shown={showWifiPw} />
          </div>
        </label>

        <div class="field relay-field">
          <span class="field-label">Relays</span>
          <span class="field-hint">The shared postboxes your signer listens on. The defaults work
            for most people; add or remove to match the relays your apps use.</span>
          <RelayEditor
            relays={data.relays}
            suggestions={SUGGESTED_SIGNER_RELAYS}
            onchange={(relays) => (data.relays = relays)}
          />
        </div>

        <details class="disclosure advanced" bind:open={showAdvanced}>
          <summary>Advanced</summary>
          {@render wipeOption()}
        </details>

        {#if netError && (data.ssid || data.password)}
          <div class="card card--warn"><p class="warn-text">{netError}</p></div>
        {/if}
      {:else}
        <div class="card card--warn usb-only-card">
          <p class="usb-only-title">What USB-only means</p>
          <ul class="usb-only-list">
            <li>It signs over the cable, and you manage it here whenever it's plugged in.</li>
            <li>For Nostr apps to reach it remotely, you run the <strong>heartwood bridge
              daemon</strong> on a computer that stays on with the signer plugged in. It couriers
              signing requests between your relays and the cable. We'll show what it needs after
              the flash.</li>
            <li>You can switch to Wi-Fi later under Advanced › Device › Network.</li>
          </ul>
        </div>
        <details class="disclosure advanced" bind:open={showAdvanced}>
          <summary>Advanced</summary>
          {@render wipeOption()}
        </details>
      {/if}
      <div class="actions">
        <button class="btn btn-secondary" onclick={goBack}>Back</button>
        <button class="btn btn-primary" onclick={goNext} disabled={!canAdvance('network', data)}>Next</button>
      </div>

    {:else if step === 'review'}
      <h2>Ready to flash</h2>
      <ul class="summary">
        <li><span>Device</span><strong>{board?.label ?? '—'}</strong></li>
        {#if data.netMode === 'wifi'}
          <li><span>Wi-Fi</span><strong>{data.ssid}</strong></li>
          <li><span>Relays</span><strong>{data.relays.map((r) => r.replace(/^wss?:\/\//i, '')).join(', ') || '—'}</strong></li>
        {:else}
          <li><span>Network</span><strong>USB-only, radio off (hardened)</strong></li>
        {/if}
        {#if data.fullErase}<li><span>Wipe first</span><strong class="danger">Yes, erases existing keys</strong></li>{/if}
      </ul>
      <p class="hint-sm">
        When you start, your browser asks which USB device to use. Pick your board from the list.
      </p>
      {#if device.connected}
        <div class="card card--warn">
          <p class="warn-text">
            The console is connected to a device over USB. Flashing needs exclusive access:
            <button class="btn-link" onclick={() => disconnect()}>disconnect it first</button>.
          </p>
        </div>
      {/if}
      <div class="actions">
        <button class="btn btn-secondary" onclick={goBack}>Back</button>
        <button class="btn btn-primary" onclick={startFlash} disabled={device.connected}>
          {data.fullErase ? 'Wipe & Flash' : 'Flash'}
        </button>
      </div>

    {:else if step === 'flashing'}
      <h2>{flashError ? 'Something went wrong' : 'Setting up your device'}</h2>
      {#if !flashError}
        <div class="progress"><div class="progress-fill" style="width: {pct}%"></div></div>
        <p class="stage">{friendlyStage(rawStage)}<span class="pct"> · {pct}%</span></p>
        <p class="hint-sm">Keep the device plugged in. This only takes a moment.</p>
      {:else}
        <div class="card card--danger"><p class="error-text">{flashError}</p></div>
        <p class="hint-sm">
          A few things to check: the cable carries data (not charge-only), the device is plugged in,
          and the console isn't already connected to it.
        </p>
        <div class="actions">
          <button class="btn btn-secondary" onclick={() => (step = 'review')}>Try again</button>
        </div>
      {/if}
      {#if logLines.length}
        <details class="disclosure log-details">
          <summary>Technical log</summary>
          <pre class="log">{logLines.join('\n')}</pre>
        </details>
      {/if}

    {:else if step === 'done'}
      <h2>Your signer is flashed</h2>
      <div class="reset-callout">
        <p class="reset-title">⚠ Now press the RESET button on the board</p>
        <p class="reset-body">
          {board?.label} has the new firmware, but it won't start running it until it restarts.
          Press the small <strong>RST</strong> button on the board (or unplug it and plug it back in).
          Its screen should then light up showing your signer.
        </p>
      </div>
      <p class="lede">
        {#if data.netMode === 'wifi'}
          It's joining <strong>{data.ssid}</strong>.
        {:else}
          It's a USB-only signer. Its radio is off and it signs over the cable.
        {/if}
        {#if data.fullErase}
          It boots ready for a fresh identity.
        {:else}
          It reconnects with its existing identity.
        {/if}
      </p>

      {#if operator}
        <div class="card card--live operator">
          {#if operator.mnemonic}
            <p class="op-title">✍ Write down these 12 words</p>
            <p class="op-desc">
              They're your <strong>operator key</strong>. Your signer was just told to accept
              WiFi management (approving apps, revoking them, checking status) only from the
              holder of this key, so keep the words private. They restore the key in any
              browser; it also stays saved in this one, under <strong>Identity › Operator
              key</strong> in the console. You don't need it for the next steps.
              Heads up: in a moment your signer shows <strong>a different 12 words on its own
              screen</strong>. That's its recovery phrase, a separate thing. Label this one
              <strong>“operator”</strong> so you don't mix them up.
            </p>
            <pre class="op-phrase">{operator.mnemonic}</pre>
          {:else}
            <p class="op-title">⚿ Your operator key</p>
            <p class="op-desc">
              This browser already held an operator key, so your signer was flashed to trust
              it. The signer accepts WiFi management (approving apps, revoking them, checking
              status) only from the holder of this key; over USB the cable itself is the
              authority. Nothing to write down now: view, copy or back it up any time under
              <strong>Identity › Operator key</strong> in the console.
            </p>
          {/if}
          <details class="disclosure op-advanced">
            <summary>Advanced: manage this signer from other tools</summary>
            <p class="hint-sm">
              Any tool that signs with the operator secret can manage this signer over relays,
              same as this console. For bray, set this in its environment:
            </p>
            <div class="uri-box"><code>NOSTR_SECRET_KEY={operator.skHex}</code></div>
            <button class="btn btn-secondary btn-sm" onclick={copyOperator}>{copied ? 'Copied ✓' : 'Copy'}</button>
          </details>
        </div>
      {/if}

      {#if data.netMode === 'usb'}
        <div class="card card--warn bridge-todo">
          <p class="bridge-todo-title">To let Nostr apps reach this signer remotely</p>
          <p class="hint-sm">
            Run the <strong>heartwood bridge daemon</strong> (from the
            <a href="https://github.com/forgesworn/heartwood-esp32" target="_blank" rel="noopener">heartwood-esp32</a>
            project) on a computer that stays on, with the signer plugged into it. The daemon holds the cable
            and couriers signing requests to and from your relays. The signer itself never
            touches the network. Once it's running, open Sapwood from the bridge's address (or use
            “Other ways to connect › Connect to a bridge”) to manage the signer through it.
          </p>
          <p class="hint-sm">
            Nothing to do right now. Finishing setup below works over this cable, and local
            signing needs no daemon at all.
          </p>
        </div>
      {/if}

      <div class="next">
        <p class="section-label">One more step</p>
        <p class="hint-sm">
          Leave it plugged in. Next we'll give your signer a <strong>name</strong> and create its
          <strong>keys</strong>. The console picks up the cable automatically and walks you through it.
        </p>
        <div class="actions">
          <button class="btn btn-primary" onclick={() => navigate('admin')}>Continue setup →</button>
          <button class="btn btn-secondary" onclick={restart}>Set up another</button>
        </div>
      </div>
    {/if}
  </section>

  <p class="security-note">
    Firmware is bundled and flashed over USB; your Wi-Fi details are written to the device and never
    sent over the network. This page makes no third-party requests and stores nothing about you.
  </p>
</main>

<style>
  main { max-width: 640px; margin: 0 auto; padding: 2.5rem 1.5rem 3rem; }

  header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 2rem; }
  .brand { display: flex; align-items: baseline; gap: 1rem; }
  h1 { margin: 0; font-size: 1.9rem; font-weight: 700; color: #fff; letter-spacing: 0.15em; }
  .divider { width: 2px; height: 1.2rem; background: var(--green); box-shadow: var(--green-glow); align-self: center; }
  .tagline { margin: 0; font-size: 0.7rem; font-weight: 500; color: var(--green-dim); letter-spacing: 0.2em; }
  .console-link { font-size: 0.75rem; color: var(--text-muted); white-space: nowrap; }
  .console-link:hover { color: var(--text-dim); }

  .stepper { display: flex; gap: 0.5rem; list-style: none; padding: 0; margin: 0 0 2rem; }
  .stepper li { display: flex; align-items: center; gap: 0.4rem; flex: 1; color: var(--text-muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; }
  .stepper .dot { width: 1.5rem; height: 1.5rem; border-radius: 50%; border: 1px solid var(--border-bright); display: grid; place-items: center; font-size: 0.75rem; flex-shrink: 0; }
  .stepper li.current { color: var(--text); }
  .stepper li.current .dot { border-color: var(--green); color: var(--green); box-shadow: var(--green-glow); }
  .stepper li.done .dot { border-color: var(--green-dim); color: var(--green-dim); }

  .reset-callout {
    border: 1px solid var(--amber); border-left: 4px solid var(--amber);
    border-radius: 6px; padding: 0.9rem 1.1rem; background: #1a1206; margin: 0 0 1.1rem;
  }
  .reset-title { font-size: 1rem; font-weight: 700; color: var(--amber); margin: 0 0 0.4rem; }
  .reset-body { font-size: 0.85rem; color: var(--text-dim); line-height: 1.6; margin: 0; }
  .reset-body strong { color: var(--amber); }

  .panel { min-height: 320px; }
  h2 { font-size: 1.4rem; font-weight: 600; margin: 0 0 0.75rem; color: #fff; letter-spacing: 0.01em; }
  .lede { font-size: 0.95rem; color: var(--text-dim); margin: 0 0 1.5rem; line-height: 1.7; }
  .lede strong { color: var(--text); }

  .card > .error-text, .card > .warn-text { margin: 0; }

  .field { margin-bottom: 1rem; }

  .boards { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1rem; }
  .board-card {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    background: var(--surface); border: 1px solid var(--border-bright); color: var(--text);
    padding: 1rem 1.1rem; border-radius: 6px; font-family: inherit; font-size: 1rem; cursor: pointer;
    transition: border-color 0.15s, background 0.15s; text-align: left;
  }
  .board-card:hover { background: var(--surface-hover); }
  .board-card.selected { border-color: var(--green); background: #06120e; }
  .board-tick { color: var(--green); font-size: 1.1rem; flex-shrink: 0; }

  .detect-link { padding: 0; margin: -0.75rem 0 1rem; display: inline-block; font-size: 0.85rem; }
  .detect-note { font-size: 0.85rem; color: var(--green); margin: -0.75rem 0 1rem; }
  .detect-tag {
    font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;
    color: var(--green); border: 1px solid var(--green-dim); border-radius: 3px;
    padding: 0.1rem 0.4rem; margin-left: 0.5rem; vertical-align: middle;
  }

  .board-card--tethered { align-items: flex-start; }
  .board-body { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
  .board-card--tethered .board-name { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .board-tag {
    font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;
    color: var(--amber); border: 1px solid #5a4a20; border-radius: 3px; padding: 0.1rem 0.4rem;
  }
  .board-sub { font-size: 0.78rem; color: var(--text-dim); line-height: 1.5; }

  .mode-cards { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1.25rem; }
  .mode-card {
    display: flex; flex-direction: column; gap: 0.3rem; text-align: left;
    background: var(--surface); border: 1px solid var(--border-bright); color: var(--text);
    padding: 0.9rem 1.1rem; border-radius: 6px; font-family: inherit; cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .mode-card:hover { background: var(--surface-hover); }
  .mode-card.selected { border-color: var(--green); background: #06120e; }
  .mode-name { font-size: 0.95rem; font-weight: 600; color: #fff; display: flex; align-items: center; gap: 0.5rem; }
  .mode-tag {
    font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;
    color: var(--green); border: 1px solid var(--green-dim); border-radius: 3px; padding: 0.1rem 0.4rem;
  }
  .mode-tag--amber { color: var(--amber); border-color: #5a4a20; }
  .mode-desc { font-size: 0.8rem; color: var(--text-dim); line-height: 1.5; }

  .usb-only-card { margin-bottom: 1rem; }
  .usb-only-title { font-size: 0.9rem; font-weight: 600; color: var(--amber); margin: 0 0 0.5rem; }
  .usb-only-list { margin: 0; padding-left: 1.2rem; font-size: 0.82rem; color: var(--text-dim); line-height: 1.6; }
  .usb-only-list li { margin-bottom: 0.4rem; }
  .usb-only-list li:last-child { margin-bottom: 0; }
  .usb-only-list strong { color: var(--text); }

  .bridge-todo { margin: 1.25rem 0; }
  .bridge-todo-title { font-size: 0.9rem; font-weight: 600; color: var(--amber); margin: 0 0 0.5rem; }
  .bridge-todo .hint-sm { margin-bottom: 0.5rem; }
  .bridge-todo .hint-sm:last-child { margin-bottom: 0; }
  .bridge-todo strong { color: var(--text); }

  .advanced { margin: 0.5rem 0 1rem; border-top: 1px solid var(--border); padding-top: 0.75rem; }

  .wipe { margin-top: 0.6rem; padding: 1rem 1.1rem; }
  .wipe-title { font-size: 0.92rem; font-weight: 700; color: var(--red); margin: 0 0 0.3rem; }
  .wipe-desc { font-size: 0.8rem; color: var(--text-dim); line-height: 1.5; margin: 0 0 0.75rem; }
  .wipe-toggle {
    display: flex; align-items: center; gap: 0.6rem; cursor: pointer;
    font-size: 0.95rem; font-weight: 600; color: var(--text);
  }
  .wipe-toggle input { width: 1.25rem; height: 1.25rem; accent-color: var(--red); cursor: pointer; flex-shrink: 0; }

  .summary { list-style: none; padding: 0; margin: 0 0 1rem; border: 1px solid var(--border); border-radius: 6px; }
  .summary li { display: flex; justify-content: space-between; gap: 1rem; padding: 0.7rem 1rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
  .summary li:last-child { border-bottom: none; }
  .summary span { color: var(--text-muted); }
  .summary strong { color: var(--text); font-weight: 600; text-align: right; word-break: break-all; }
  .summary strong.danger { color: var(--amber); }

  .progress { margin: 1.5rem 0 0.6rem; }
  .progress-fill { box-shadow: var(--green-glow); transition: width 0.25s ease; }
  .stage { font-size: 1rem; color: var(--text); margin: 0.4rem 0 0; }
  .stage .pct { color: var(--text-muted); }

  .actions { display: flex; gap: 0.75rem; margin-top: 1.75rem; }

  .log-details { margin-top: 1.25rem; }
  .log { margin-top: 0.5rem; max-height: 200px; overflow: auto; background: #030303; border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem; font-size: 0.68rem; color: var(--text-dim); white-space: pre-wrap; word-break: break-all; }

  .operator { margin: 1.25rem 0; }
  .op-title { font-size: 0.9rem; color: var(--green); margin: 0 0 0.4rem; font-weight: 600; }
  .op-desc { font-size: 0.8rem; color: var(--text-dim); margin: 0 0 0.6rem; line-height: 1.5; }
  .op-desc strong { color: var(--text); }
  .op-phrase { background: #030303; border: 1px solid var(--amber); border-radius: 4px; padding: 0.7rem; font-size: 0.85rem; line-height: 1.6; color: var(--text); white-space: pre-wrap; word-spacing: 0.3rem; margin: 0 0 0.8rem; }
  .op-advanced { margin-top: 0.5rem; }

  .next { margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1.25rem; }

  .security-note { font-size: 0.7rem; color: var(--text-muted); margin-top: 2.5rem; border-top: 1px solid var(--border); padding-top: 1rem; line-height: 1.6; }

  /* The flasher is desktop-only, but degrade gracefully if opened on a phone:
     wrap the header and let the step buttons share the row. */
  @media (max-width: 640px) {
    main { padding: 1.75rem 1rem 2.5rem; }
    header { flex-wrap: wrap; gap: 0.5rem; }
    h1 { font-size: 1.55rem; }
    .actions { flex-wrap: wrap; }
    .actions .btn { flex: 1; min-width: 8rem; }
  }
</style>

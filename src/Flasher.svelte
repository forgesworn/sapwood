<script lang="ts">
  // The /flash surface: a focused, guided flasher (flasher.meshtastic.org model).
  // Desktop + USB only. Walks a newcomer from "plug it in" to "your signer is
  // live" in one calm flow. All decisions delegate to the pure wizard lib; the
  // flash itself goes through flashDevice (same path the old Flash tab used).
  import { flashDevice, BOARDS, type FlasherBackend } from './lib/flasher.js'
  import { getOrCreateOperator, type Operator } from './lib/op-mgmt.js'
  import { device, disconnect } from './lib/device.svelte.js'
  import { navigate } from './lib/route.svelte.js'
  import type { NetConfig } from './lib/frame'
  import {
    type WizardStep, type WizardData,
    USER_STEPS, initialData, parseRelays, networkError, canAdvance,
    nextStep, prevStep, friendlyStage,
  } from './lib/wizard.js'
  import TetheredSetup from './components/TetheredSetup.svelte'
  import PasswordReveal from './components/PasswordReveal.svelte'

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
    await navigator.clipboard.writeText(operator.skHex)
    copied = true
    setTimeout(() => (copied = false), 1500)
  }

  async function startFlash() {
    const relays = parseRelays(data.relaysText)
    const op = getOrCreateOperator()
    const cfg: NetConfig = {
      ssid: data.ssid.trim(),
      password: data.password,
      relays,
      mode: 'wifi',
      op_mgmt: op.pubHex,
    }
    // Remember relays so the admin console can default this device's relay.
    try { localStorage.setItem('heartwood.lastRelays', JSON.stringify(relays)) } catch { /* ignore */ }

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
    <button class="link console-link" onclick={() => navigate('admin')}>Advanced console →</button>
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
      <button class="link back-link" onclick={() => (tethered = false)}>← Back to Wi-Fi setup</button>
      <TetheredSetup />
    {:else if step === 'welcome'}
      <h2>Set up your Heartwood</h2>
      <p class="lede">
        This installs the signing software on your device and joins it to your Wi-Fi, so you can
        manage it from your phone afterwards. You'll need the device and a USB cable. It takes about a minute.
      </p>
      {#if !webSerial}
        <p class="callout error">
          Flashing needs a computer running Chrome or Edge — they can talk to USB devices from the
          browser. Open this page there, then come back.
        </p>
      {:else}
        <p class="note">Works in Chrome and Edge on a computer. You won't flash from a phone.</p>
      {/if}
      <div class="actions">
        <button class="btn primary" onclick={goNext} disabled={!webSerial}>Start</button>
      </div>
      {#if webSerial}
        <button class="link tethered-link" onclick={() => (tethered = true)}>
          Setting up a USB-tethered ESP8266 signer instead? →
        </button>
      {/if}

    {:else if step === 'board'}
      <h2>Which device do you have?</h2>
      <p class="lede">Pick the board you're holding. The model is printed on it.</p>
      <div class="boards">
        {#each BOARDS as b (b.id)}
          <button
            class="board-card"
            class:selected={data.boardId === b.id}
            onclick={() => (data.boardId = b.id)}
            aria-pressed={data.boardId === b.id}
          >
            <span class="board-name">{b.label}</span>
            <span class="board-tick">{data.boardId === b.id ? '●' : '○'}</span>
          </button>
        {/each}
      </div>
      <p class="note">Plug the board into this computer with a USB cable now, if you haven't already.</p>
      <div class="actions">
        <button class="btn ghost" onclick={goBack}>Back</button>
        <button class="btn primary" onclick={goNext} disabled={!canAdvance('board', data)}>Next</button>
      </div>

    {:else if step === 'network'}
      <h2>Which Wi-Fi should it use?</h2>
      <p class="lede">The device joins this network on its own once it's set up.</p>
      <label class="field">
        <span>Wi-Fi name</span>
        <input bind:value={data.ssid} placeholder="your network" autocomplete="off" />
      </label>
      <label class="field">
        <span>Wi-Fi password</span>
        <div class="pw">
          <input type={showWifiPw ? 'text' : 'password'} bind:value={data.password} autocomplete="off" />
          <PasswordReveal bind:shown={showWifiPw} />
        </div>
      </label>

      <details class="advanced" bind:open={showAdvanced}>
        <summary>Advanced</summary>
        <label class="field">
          <span>Relays (one per line)</span>
          <textarea bind:value={data.relaysText} rows="2"></textarea>
        </label>
        <label class="erase-field">
          <input type="checkbox" bind:checked={data.fullErase} />
          <span>
            <strong>Wipe the device first.</strong> Clears any identity already on it for a clean start.
            <em>This destroys all keys on the device.</em>
          </span>
        </label>
      </details>

      {#if netError && (data.ssid || data.password)}
        <p class="callout warn">{netError}</p>
      {/if}
      <div class="actions">
        <button class="btn ghost" onclick={goBack}>Back</button>
        <button class="btn primary" onclick={goNext} disabled={!canAdvance('network', data)}>Next</button>
      </div>

    {:else if step === 'review'}
      <h2>Ready to flash</h2>
      <ul class="summary">
        <li><span>Device</span><strong>{board?.label ?? '—'}</strong></li>
        <li><span>Wi-Fi</span><strong>{data.ssid}</strong></li>
        <li><span>Relays</span><strong>{parseRelays(data.relaysText).join(', ') || '—'}</strong></li>
        {#if data.fullErase}<li><span>Wipe first</span><strong class="danger">Yes — erases existing keys</strong></li>{/if}
      </ul>
      <p class="note">
        When you start, your browser asks which USB device to use — pick your board from the list.
      </p>
      {#if device.connected}
        <p class="callout warn">
          The console is connected to a device over USB. Flashing needs exclusive access —
          <button class="link" onclick={() => disconnect()}>disconnect it first</button>.
        </p>
      {/if}
      <div class="actions">
        <button class="btn ghost" onclick={goBack}>Back</button>
        <button class="btn primary" onclick={startFlash} disabled={device.connected}>
          {data.fullErase ? 'Wipe & Flash' : 'Flash'}
        </button>
      </div>

    {:else if step === 'flashing'}
      <h2>{flashError ? 'Something went wrong' : 'Setting up your device'}</h2>
      {#if !flashError}
        <div class="progress"><div class="bar" style="width: {pct}%"></div></div>
        <p class="stage">{friendlyStage(rawStage)}<span class="pct"> · {pct}%</span></p>
        <p class="note">Keep the device plugged in. This only takes a moment.</p>
      {:else}
        <p class="callout error">{flashError}</p>
        <p class="note">
          A few things to check: the cable carries data (not charge-only), the device is plugged in,
          and the console isn't already connected to it.
        </p>
        <div class="actions">
          <button class="btn ghost" onclick={() => (step = 'review')}>Try again</button>
        </div>
      {/if}
      {#if logLines.length}
        <details class="log-details">
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
        It's joining <strong>{data.ssid}</strong>.
        {#if data.fullErase}
          It boots ready for a fresh identity.
        {:else}
          It reconnects with its existing identity.
        {/if}
      </p>

      {#if operator}
        <div class="operator">
          {#if operator.mnemonic}
            <p class="op-title">✍ Write down these 12 words</p>
            <p class="op-desc">
              They're the master key to manage this signer from anywhere later. Keep them safe and
              private — like the keys to your house. You don't need them for the next steps.
              Heads up: in a moment your signer shows <strong>a different 12 words on its own
              screen</strong> — that's its recovery phrase, a separate thing. Label this one
              <strong>“operator”</strong> so you don't mix them up.
            </p>
            <pre class="op-phrase">{operator.mnemonic}</pre>
          {:else}
            <p class="op-title">⚿ Your operator key</p>
            <p class="op-desc">Keep this safe — it's how you manage this signer remotely later.</p>
          {/if}
          <details class="op-advanced">
            <summary>Advanced — connect bray to this signer</summary>
            <pre class="op-secret">NOSTR_SECRET_KEY={operator.skHex}</pre>
            <button class="btn small" onclick={copyOperator}>{copied ? 'Copied ✓' : 'Copy'}</button>
          </details>
        </div>
      {/if}

      <div class="next">
        <p class="next-title">One more step</p>
        <p class="note">
          Leave it plugged in. Next we'll give your signer a <strong>name</strong> and create its
          <strong>keys</strong> — the console picks up the cable automatically and walks you through it.
        </p>
        <div class="actions">
          <button class="btn primary" onclick={() => navigate('admin')}>Continue setup →</button>
          <button class="btn ghost" onclick={restart}>Set up another</button>
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
  .reset-body { font-size: 0.85rem; color: #cdbfa0; line-height: 1.6; margin: 0; }
  .reset-body strong { color: var(--amber); }

  .panel { min-height: 320px; }
  h2 { font-size: 1.4rem; font-weight: 600; margin: 0 0 0.75rem; color: #fff; letter-spacing: 0.01em; }
  .lede { font-size: 0.95rem; color: var(--text-dim); margin: 0 0 1.5rem; line-height: 1.7; }
  .lede strong { color: var(--text); }
  .note { font-size: 0.8rem; color: var(--text-muted); margin: 0.75rem 0; line-height: 1.6; }

  .field { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 1rem; }
  .field span { font-size: 0.75rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; }
  .field input, .field textarea {
    background: #080808; border: 1px solid var(--border-bright); color: var(--text);
    padding: 0.7rem 0.85rem; border-radius: 5px; font-family: inherit; font-size: 1rem; resize: vertical;
  }
  .field input:focus, .field textarea:focus { outline: none; border-color: var(--green-dim); }
  .pw { position: relative; }
  .pw input { width: 100%; box-sizing: border-box; padding-right: 2.5rem; }

  .boards { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 1rem; }
  .board-card {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    background: var(--surface); border: 1px solid var(--border-bright); color: var(--text);
    padding: 1rem 1.1rem; border-radius: 6px; font-family: inherit; font-size: 1rem; cursor: pointer;
    transition: border-color 0.15s, background 0.15s; text-align: left;
  }
  .board-card:hover { background: var(--surface-hover); }
  .board-card.selected { border-color: var(--green); background: #06120e; }
  .board-tick { color: var(--green); font-size: 1.1rem; }

  .advanced { margin: 0.5rem 0 1rem; border-top: 1px solid var(--border); padding-top: 0.75rem; }
  .advanced summary { cursor: pointer; font-size: 0.8rem; color: var(--text-dim); letter-spacing: 0.04em; }
  .erase-field { display: flex; gap: 0.5rem; align-items: flex-start; font-size: 0.78rem; color: #aa9; line-height: 1.5; margin-top: 0.5rem; }
  .erase-field input { margin-top: 0.2rem; accent-color: var(--amber); }
  .erase-field strong { color: var(--amber); }
  .erase-field em { color: var(--red); font-style: normal; }

  .summary { list-style: none; padding: 0; margin: 0 0 1rem; border: 1px solid var(--border); border-radius: 6px; }
  .summary li { display: flex; justify-content: space-between; gap: 1rem; padding: 0.7rem 1rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
  .summary li:last-child { border-bottom: none; }
  .summary span { color: var(--text-muted); }
  .summary strong { color: var(--text); font-weight: 600; text-align: right; word-break: break-all; }
  .summary strong.danger { color: var(--amber); }

  .progress { height: 10px; background: var(--surface-raised); border-radius: 5px; margin: 1.5rem 0 0.6rem; overflow: hidden; }
  .bar { height: 100%; background: var(--green); box-shadow: var(--green-glow); transition: width 0.25s ease; }
  .stage { font-size: 1rem; color: var(--text); margin: 0.4rem 0 0; }
  .stage .pct { color: var(--text-muted); }

  .callout { font-size: 0.85rem; border-radius: 5px; padding: 0.75rem 0.9rem; margin: 1rem 0; line-height: 1.6; }
  .callout.error { color: #ffb4b4; background: #160a0a; border: 1px solid #3a2020; }
  .callout.warn { color: #ffd98a; background: #161106; border: 1px solid #3a2f10; }

  .actions { display: flex; gap: 0.75rem; margin-top: 1.75rem; }
  .btn {
    font-family: inherit; font-size: 0.95rem; font-weight: 500; padding: 0.7rem 1.6rem;
    border-radius: 5px; cursor: pointer; border: 1px solid transparent; transition: all 0.15s;
  }
  .btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .btn.primary { background: var(--green); color: #050505; border-color: var(--green); font-weight: 600; }
  .btn.primary:hover:not(:disabled) { background: #00ff88; box-shadow: var(--green-glow); }
  .btn.ghost { background: transparent; color: var(--text-dim); border-color: var(--border-bright); }
  .btn.ghost:hover { background: var(--surface-hover); color: var(--text); }
  .btn.small { padding: 0.4rem 1rem; font-size: 0.82rem; background: var(--surface-raised); color: var(--text); border-color: var(--border-bright); }

  .link { background: none; border: none; padding: 0; color: var(--green-dim); cursor: pointer; font-family: inherit; font-size: inherit; text-decoration: underline; }
  .link:hover { color: var(--green); }

  .log-details { margin-top: 1.25rem; }
  .log-details summary { cursor: pointer; font-size: 0.75rem; color: var(--text-muted); }
  .log { margin-top: 0.5rem; max-height: 200px; overflow: auto; background: #030303; border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem; font-size: 0.68rem; color: var(--text-dim); white-space: pre-wrap; word-break: break-all; }

  .operator { margin: 1.25rem 0; border: 1px solid var(--green-dim); border-radius: 6px; padding: 1rem; background: #06120e; }
  .op-title { font-size: 0.9rem; color: var(--green); margin: 0 0 0.4rem; font-weight: 600; }
  .op-desc { font-size: 0.8rem; color: #9a9; margin: 0 0 0.6rem; line-height: 1.5; }
  .op-desc strong { color: var(--text); }
  .op-secret { background: #030303; border: 1px solid var(--border); border-radius: 4px; padding: 0.6rem; font-size: 0.68rem; color: var(--green); white-space: pre-wrap; word-break: break-all; margin: 0 0 0.6rem; }
  .op-phrase { background: #030303; border: 1px solid var(--amber, #d9a441); border-radius: 4px; padding: 0.7rem; font-size: 0.85rem; line-height: 1.6; color: var(--text); white-space: pre-wrap; word-spacing: 0.3rem; margin: 0 0 0.8rem; }
  .op-advanced { margin-top: 0.5rem; }
  .op-advanced summary { font-size: 0.72rem; color: var(--text-muted); cursor: pointer; }
  .op-advanced .op-secret { margin-top: 0.5rem; }

  .next { margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1.25rem; }
  .next-title { font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.1em; margin: 0; }

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

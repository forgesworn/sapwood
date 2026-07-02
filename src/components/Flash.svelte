<script lang="ts">
  import { flashDevice, BOARDS, type BoardSpec } from '../lib/flasher.js'
  import { device } from '../lib/device.svelte.js'
  import { getOrCreateOperator, type Operator } from '../lib/op-mgmt.js'
  import type { NetConfig } from '../lib/frame'
  import PasswordReveal from './PasswordReveal.svelte'

  let board = $state<BoardSpec>(BOARDS[0])
  let mode = $state<'wifi' | 'usb'>('wifi')
  let ssid = $state('')
  let password = $state('')
  let showPw = $state(false)
  let relaysText = $state('wss://relay.trotters.cc')
  let fullErase = $state(false)

  let status = $state<'idle' | 'flashing' | 'done' | 'error'>('idle')
  let pct = $state(0)
  let stage = $state('')
  let message = $state('')
  let logLines = $state<string[]>([])
  let operator = $state<Operator | null>(null)
  let copied = $state(false)

  const webSerial = typeof navigator !== 'undefined' && 'serial' in navigator

  function appendLog(line: string) {
    if (line) logLines = [...logLines.slice(-300), line]
  }

  async function copyOperator() {
    if (!operator) return
    await navigator.clipboard.writeText(operator.skHex)
    copied = true
    setTimeout(() => (copied = false), 1500)
  }

  async function flash() {
    const relays = relaysText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
    if (mode === 'wifi' && (!ssid.trim() || relays.length === 0)) {
      status = 'error'
      message = 'WiFi mode needs an SSID and at least one relay.'
      return
    }
    // WiFi mode bakes an operator pubkey so the device accepts remote
    // management (kind 24134) over relays. USB mode has no relay channel.
    const op = mode === 'wifi' ? getOrCreateOperator() : null
    const cfg: NetConfig = { ssid: ssid.trim(), password, relays, mode, op_mgmt: op?.pubHex ?? '' }
    // Remember the relays so the Provision tab can default this device's relay
    // (the device's mgmt address is its master pubkey, known only at provision).
    if (mode === 'wifi' && relays.length) {
      try { localStorage.setItem('heartwood.lastRelays', JSON.stringify(relays)) } catch { /* ignore */ }
    }
    status = 'flashing'
    pct = 0
    stage = 'starting'
    message = ''
    logLines = []
    operator = null
    try {
      await flashDevice(board, cfg, {
        fullErase,
        onLog: appendLog,
        onProgress: (p, label) => {
          pct = p
          stage = label
        },
      })
      status = 'done'
      operator = op
      message = fullErase
        ? `${board.label} wiped, flashed and configured. If it doesn't reboot on its own, press RESET (or replug) — it will boot to "provision me", ready for a fresh master.`
        : `${board.label} flashed and configured. If it doesn't reboot on its own, press RESET (or replug) — it will then connect to ${relays[0] ?? 'the relay'}.`
    } catch (e) {
      status = 'error'
      message = e instanceof Error ? e.message : String(e)
    }
  }
</script>

<div class="flash">
  <h2>Flash &amp; Configure</h2>
  <p class="hint">Pick your board, set wifi + relays, then flash. The device boots already configured — no separate setup step.</p>

  {#if !webSerial}
    <p class="error">Browser flashing needs Web Serial — open this in Chrome or Edge.</p>
  {/if}

  {#if device.connected}
    <p class="warning">Disconnect the device first (the bar above) — the flasher needs exclusive USB access. If it's already connected, esptool can't reset it and hangs at "Connecting…".</p>
  {/if}

  <label class="field">
    <span>Device</span>
    <select bind:value={board} disabled={status === 'flashing'}>
      {#each BOARDS as b (b.id)}
        <option value={b}>{b.label}</option>
      {/each}
    </select>
  </label>

  <label class="field">
    <span>Mode</span>
    <select bind:value={mode} disabled={status === 'flashing'}>
      <option value="wifi">WiFi-standalone</option>
      <option value="usb">USB-bridged</option>
    </select>
  </label>

  {#if mode === 'wifi'}
    <label class="field">
      <span>WiFi SSID</span>
      <input bind:value={ssid} disabled={status === 'flashing'} placeholder="your network" />
    </label>
    <label class="field">
      <span>WiFi password</span>
      <div class="pw">
        <input type={showPw ? 'text' : 'password'} bind:value={password} disabled={status === 'flashing'} />
        <PasswordReveal bind:shown={showPw} disabled={status === 'flashing'} />
      </div>
    </label>
    <label class="field">
      <span>Relays (one per line)</span>
      <textarea bind:value={relaysText} rows="2" disabled={status === 'flashing'}></textarea>
    </label>
  {/if}

  <label class="erase-field">
    <input type="checkbox" bind:checked={fullErase} disabled={status === 'flashing'} />
    <span>
      <strong>Wipe device first (full erase)</strong> — clears NVS incl. any provisioned master, so the
      device boots into provision-wait mode ready for a fresh master. Tick this for a clean slate;
      leave it off to keep the existing master. <em>Destroys all keys on the device.</em>
    </span>
  </label>

  <button class="btn flash-btn" onclick={flash} disabled={status === 'flashing' || !webSerial || device.connected}>
    {status === 'flashing' ? 'Flashing…' : fullErase ? 'Wipe, Flash & Configure' : 'Flash & Configure'}
  </button>

  {#if status !== 'idle'}
    <div class="progress"><div class="bar" style="width: {pct}%"></div></div>
    <p class="stage">{pct}% — {stage}</p>
  {/if}

  {#if message}
    <p class={status === 'error' ? 'error' : 'success'}>{message}</p>
  {/if}

  {#if operator}
    <div class="operator">
      <p class="op-title">⚿ Operator key — manage this device remotely</p>
      <p class="op-desc">
        The device now accepts remote management (create clients, list, status) over relays
        <strong>only</strong> from this operator key. Load it into bray to manage it from anywhere:
      </p>
      {#if operator.mnemonic}
        <p class="op-phrase-label">✍ Your <strong>operator phrase</strong> — write these 12 words down to restore this management key on any device:</p>
        <pre class="op-phrase">{operator.mnemonic}</pre>
        <p class="op-phrase-note">
          Heads up: this is <strong>not</strong> the same as your signer's own recovery phrase — the
          12 words that later appear <em>on the device's screen</em>. Two different phrases. Label
          this one <strong>“operator”</strong> when you write it down so you don't mix them up.
        </p>
      {/if}
      <pre class="op-secret">NOSTR_SECRET_KEY={operator.skHex}</pre>
      <button class="btn" onclick={copyOperator}>{copied ? 'Copied ✓' : 'Copy secret'}</button>
      <p class="op-warn">
        Kept in this browser so re-flashing reuses it. This is the management authority —
        <strong>not</strong> the device master seed. Keep it safe.
      </p>
    </div>
  {/if}

  {#if logLines.length}
    <pre class="log">{logLines.join('\n')}</pre>
  {/if}

  <p class="security-note">
    Firmware for the selected board is bundled and flashed over USB; the wifi config is baked into the device's
    config partition at flash time. Nothing is sent over the network.
  </p>
</div>

<style>
  h2 { font-size: 1rem; font-weight: 600; margin: 0 0 1rem; color: #ccc; }
  .hint { font-size: 0.8rem; color: #888; margin: 0 0 1rem; }
  .field { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 0.75rem; }
  .field span { font-size: 0.75rem; color: #666; }
  .field select, .field input, .field textarea {
    background: #0a0a0a; border: 1px solid #333; color: #ccc;
    padding: 0.35rem 0.5rem; border-radius: 3px; font-family: inherit; font-size: 0.8rem; resize: vertical;
  }
  .field select { cursor: pointer; }
  .pw { position: relative; display: flex; }
  .pw input { flex: 1; padding-right: 2.2rem; }
  .field input:disabled, .field textarea:disabled, .field select:disabled { opacity: 0.4; }
  .btn {
    background: #1a1a1a; border: 1px solid #333; color: #ccc; padding: 0.4rem 1rem;
    border-radius: 3px; font-family: inherit; font-size: 0.85rem; cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: #222; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .flash-btn { border-color: #4a9; color: #4a9; margin-top: 0.25rem; }
  .erase-field {
    display: flex; gap: 0.5rem; align-items: flex-start; margin: 0.25rem 0 0.75rem;
    font-size: 0.72rem; color: #886; line-height: 1.4;
  }
  .erase-field input { margin-top: 0.15rem; accent-color: #a93; }
  .erase-field strong { color: #a93; }
  .erase-field em { color: #a44; font-style: normal; }
  .progress { height: 6px; background: #1a1a1a; border-radius: 3px; margin-top: 1rem; overflow: hidden; }
  .bar { height: 100%; background: #4a9; transition: width 0.2s; }
  .stage { font-size: 0.75rem; color: #888; margin: 0.4rem 0 0; }
  .error { font-size: 0.8rem; color: #a44; margin-top: 0.75rem; }
  .warning { font-size: 0.8rem; color: #a93; margin-top: 0.75rem; }
  .success { font-size: 0.85rem; color: #4a9; margin-top: 0.75rem; }
  .log {
    margin-top: 0.75rem; max-height: 200px; overflow: auto; background: #050505; border: 1px solid #1a1a1a;
    border-radius: 3px; padding: 0.5rem; font-size: 0.68rem; color: #777; white-space: pre-wrap; word-break: break-all;
  }
  .security-note { font-size: 0.7rem; color: #444; margin-top: 1.5rem; border-top: 1px solid #1a1a1a; padding-top: 0.75rem; }
  .operator { margin-top: 1rem; border: 1px solid #4a9; border-radius: 4px; padding: 0.75rem; background: #06120e; }
  .op-title { font-size: 0.82rem; color: #4a9; margin: 0 0 0.4rem; font-weight: 600; }
  .op-desc { font-size: 0.75rem; color: #9a9; margin: 0 0 0.5rem; line-height: 1.4; }
  .op-desc strong { color: #ccc; }
  .op-secret {
    background: #050505; border: 1px solid #1a1a1a; border-radius: 3px; padding: 0.5rem;
    font-size: 0.68rem; color: #4a9; white-space: pre-wrap; word-break: break-all; margin: 0 0 0.5rem;
  }
  .op-warn { font-size: 0.68rem; color: #886; margin: 0.5rem 0 0; line-height: 1.4; }
  .op-warn strong { color: #a93; }
  .op-phrase-label { font-size: 0.74rem; color: #d9a441; margin: 0 0 0.35rem; font-weight: 600; }
  .op-phrase-note { font-size: 0.7rem; color: #998; margin: 0 0 0.6rem; line-height: 1.5; }
  .op-phrase-note strong { color: #d9a441; }
  .op-phrase {
    background: #050505; border: 1px solid #d9a441; border-radius: 3px; padding: 0.6rem;
    font-size: 0.82rem; line-height: 1.6; color: #ddd; white-space: pre-wrap; word-spacing: 0.3rem; margin: 0 0 0.6rem;
  }
</style>

<script lang="ts">
  // Firmware update over USB. The device only accepts OTA over the cable (never
  // the relay), and a WiFi signer boots straight into its relay loop — so the
  // first job is to get the owner onto USB, then stream + verify the image.
  // The transfer logic lives in lib/ota.ts (unit-tested); this is the UI over it.
  //
  // The bundled firmware is described by /firmware/version.json (published by the
  // heartwood-esp32 release and pulled in with `npm run sync:firmware`), so we can
  // show "running vX → update to vY" and update in one click — no .bin hunting.
  import { onMount } from 'svelte'
  import { device, serialTransport, httpTransport, getFirmwareVersion } from '../lib/device.svelte.js'
  import { streamOta } from '../lib/ota.js'

  interface BoardAsset { app: string; sha256: string; bytes: number; ota?: boolean; signature?: string }
  interface Manifest { version: string; builtAt?: string; boards: Record<string, BoardAsset> }

  /** 128-hex release signature → 64 bytes; undefined for pre-signature manifests. */
  function parseSignature(hex: string | undefined): Uint8Array | undefined {
    if (!hex || !/^[0-9a-fA-F]{128}$/.test(hex)) return undefined
    const sig = new Uint8Array(64)
    for (let i = 0; i < 64; i++) sig[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return sig
  }

  // Only OTA-capable boards need an app path here. The factory-only 4 MB boards
  // (T-Display/C6) and the esp8266 carry ota:false in the manifest and update by
  // re-flashing, so they are intentionally absent.
  const BOARD_DIR: Record<string, string> = { 'heltec-v4': 'v4', 'heltec-v3': 'v3' }

  let file = $state<File | null>(null)
  let sigFile = $state<File | null>(null)
  let progress = $state(0)
  let status = $state<'idle' | 'waiting' | 'uploading' | 'verifying' | 'done' | 'error'>('idle')
  let message = $state('')
  let showAdvanced = $state(false)

  let available = $state<Manifest | null>(null)
  let usbInfo = $state<{ version: string; board: string } | null>(null)
  // Set optimistically after a successful OTA: the device rebooted into the
  // version we just sent, before any transport re-reads it.
  let optimisticVersion = $state<string | null>(null)

  const canUpdate = $derived(device.connected && (device.mode === 'serial' || device.mode === 'http'))
  const busy = $derived(status === 'waiting' || status === 'uploading' || status === 'verifying')
  const latest = $derived(available ? available.version : null)
  // What the signer is running: over WiFi from get_status (firmware ≥0.13.2),
  // over USB from the FIRMWARE_INFO frame. Older firmware → unknown.
  const running = $derived(optimisticVersion
    ?? (device.mode === 'relay' ? device.relayStatus?.version ?? null : usbInfo?.version ?? null))
  const deviceBoard = $derived(device.mode === 'relay'
    ? device.relayStatus?.board ?? null
    : usbInfo?.board ?? null)
  const upToDate = $derived(!!running && !!latest && running === latest)

  // Pick which board's image to offer: the device's own, else the first
  // OTA-capable board. The served list now also holds factory-only boards, which
  // must not become the default for a legacy device that doesn't report its board.
  const boardKey = $derived.by(() => {
    const boards = available ? Object.keys(available.boards ?? {}) : []
    const otaBoards = boards.filter((b) => available?.boards[b]?.ota !== false)
    return (deviceBoard && boards.includes(deviceBoard)) ? deviceBoard : (otaBoards[0] ?? boards[0] ?? null)
  })

  onMount(async () => {
    // What firmware ships with this app…
    try {
      const res = await fetch('/firmware/version.json', { cache: 'no-store' })
      if (res.ok) available = await res.json()
    } catch { /* not bundled / offline — fall back to the manual picker */ }

    // …and what the connected device is running over USB (older firmware → null).
    const info = await getFirmwareVersion()
    usbInfo = info ? { version: info.version, board: info.board } : null
  })

  // The connected board's manifest entry, and whether it supports OTA at all.
  // Factory-only boards carry ota:false (no OTA slot — they update by re-flashing);
  // an omitted ota is treated as capable (legacy manifest).
  const boardMeta = $derived(boardKey && available ? (available.boards[boardKey] ?? null) : null)
  const otaCapable = $derived(!!boardMeta && boardMeta.ota !== false)
  const appUrl = $derived(otaCapable && boardKey && BOARD_DIR[boardKey] ? `/firmware/${BOARD_DIR[boardKey]}/app.bin` : null)

  async function runUpdate(data: Uint8Array, signature?: Uint8Array) {
    progress = 0
    try {
      if (device.mode === 'http') {
        status = 'waiting'
        message = 'On your signer, hold its button for 2 seconds to approve the update.'
        status = 'uploading'
        message = 'Sending the firmware via the bridge…'
        const sigHex = signature
          ? Array.from(signature, (b) => b.toString(16).padStart(2, '0')).join('')
          : undefined
        await httpTransport.otaUpload(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, sigHex)
        status = 'done'
        message = 'Done. Your signer is restarting with the new firmware.'
        return
      }
      await streamOta(serialTransport, data, {
        onPhase: (phase) => {
          status = phase
          if (phase === 'waiting') {
            message = 'Your signer is showing the update size. Hold its button for 2 seconds to approve.'
          } else if (phase === 'verifying') {
            message = 'Checking the firmware arrived safely…'
          }
        },
        onProgress: (pct) => { progress = pct; message = `Sending… ${pct}%` },
      }, signature)
      status = 'done'
      message = 'Done. Your signer is restarting with the new firmware.'
      optimisticVersion = latest // it rebooted into the version we just sent
    } catch (e) {
      status = 'error'
      message = e instanceof Error ? e.message : 'The update could not be completed.'
    }
  }

  async function updateToLatest() {
    if (!appUrl || busy) return
    try {
      status = 'waiting'
      message = 'Fetching the firmware…'
      const res = await fetch(appUrl, { cache: 'no-store' })
      if (!res.ok) throw new Error('Could not load the bundled firmware.')
      await runUpdate(new Uint8Array(await res.arrayBuffer()), parseSignature(boardMeta?.signature))
    } catch (e) {
      status = 'error'
      message = e instanceof Error ? e.message : 'The update could not be completed.'
    }
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement
    file = input.files?.[0] ?? null
    status = 'idle'
    message = ''
    progress = 0
  }

  function handleSigFileSelect(e: Event) {
    const input = e.target as HTMLInputElement
    sigFile = input.files?.[0] ?? null
  }

  async function updateFromFile() {
    if (!file || busy) return
    // A .sig file holds the 128-hex signature (comment lines allowed).
    let signature: Uint8Array | undefined
    if (sigFile) {
      const text = await sigFile.text()
      const hex = text.split('\n').map((l) => l.trim()).filter((l) => !l.startsWith('#')).join('')
      signature = parseSignature(hex)
      if (!signature) {
        status = 'error'
        message = "That signature file doesn't look right: expected 128 hex characters."
        return
      }
    }
    await runUpdate(new Uint8Array(await file.arrayBuffer()), signature)
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
</script>

<section class="ota" aria-label="Update firmware">
  <h2 class="section-title">Update firmware</h2>

  {#if !canUpdate}
    <!-- Version state is knowable over WiFi (get_status carries the running
         version on current firmware) even though the update itself needs the
         cable — show it, so "is my signer current?" has an answer here. -->
    {#if running || latest}
      <table class="kv-table fw-status"><tbody>
        <tr><td class="label">On your signer</td><td>{running ? `v${running}` : 'unknown (older firmware)'}</td></tr>
        <tr><td class="label">Bundled with this app</td><td>{latest ? `v${latest}` : '—'}</td></tr>
      </tbody></table>
      {#if upToDate}
        <p class="success-text fw-ok">Your signer is up to date.</p>
      {/if}
    {/if}
    <p class="hint">
      Firmware updates run <strong>over USB</strong>, never over WiFi, for safety. Connect this
      signer with a cable to update it.
    </p>
    <div class="card card--live usb-steps">
      <p class="steps-head">Already-set-up WiFi signer? Put it in USB mode first:</p>
      <ol>
        <li>Plug it into this computer with a USB cable.</li>
        <li>Press <strong>RESET</strong> on the board (or unplug and replug it).</li>
        <li>As it starts it shows <strong>"Hold PRG = USB"</strong> for 3 seconds. Hold the
          <strong>PRG</strong> button until the screen says <strong>"USB mode"</strong>.</li>
        <li>Then connect over USB here and come back to this screen.</li>
      </ol>
    </div>
  {:else}
    <table class="kv-table fw-status"><tbody>
      <tr><td class="label">On your signer</td><td>{running ? `v${running}` : 'unknown'}</td></tr>
      <tr><td class="label">Bundled with this app</td><td>{latest ? `v${latest}` : '—'}</td></tr>
    </tbody></table>

    {#if upToDate}
      <p class="success-text fw-ok">Your signer is up to date.</p>
      {#if appUrl}
        <button class="btn btn-secondary" disabled={busy} onclick={updateToLatest}>Re-install v{latest}</button>
      {/if}
    {:else if latest && appUrl}
      <p class="hint">
        A newer firmware is bundled here. Your signer will ask you to approve it with its button,
        check it, and restart, rolling back on its own if anything is wrong.
      </p>
      <button class="btn btn-primary" disabled={busy} onclick={updateToLatest}>
        {busy ? 'Updating…' : `Update to v${latest} →`}
      </button>
    {:else if latest && boardMeta && !otaCapable}
      <p class="hint">
        This board has no over-the-air update slot, so it updates by <strong>re-flashing over USB</strong>.
        Open the <a href="#/flash">Flasher</a> to install v{latest} (you'll re-enter your Wi-Fi).
      </p>
    {:else}
      <p class="hint">No bundled firmware was found. Use your own <code>.bin</code> below.</p>
    {/if}

    <button class="advanced-toggle" onclick={() => (showAdvanced = !showAdvanced)}>
      {showAdvanced ? '▾' : '▸'} Advanced: install a firmware file
    </button>
    {#if showAdvanced}
      <label class="file-picker" class:has-file={!!file}>
        <input type="file" accept=".bin" onchange={handleFileSelect} disabled={busy} />
        {file ? `${file.name} · ${formatSize(file.size)}` : 'Choose a firmware .bin file'}
      </label>
      {#if file}
        <label class="file-picker" class:has-file={!!sigFile}>
          <input type="file" accept=".sig" onchange={handleSigFileSelect} disabled={busy} />
          {sigFile ? sigFile.name : 'Signature (.sig): newer firmware requires it'}
        </label>
        <button class="btn btn-primary" disabled={busy} onclick={updateFromFile}>
          {busy ? 'Updating…' : 'Update over USB →'}
        </button>
      {/if}
    {/if}

    {#if status === 'uploading'}
      <div class="progress ota-progress" role="progressbar" aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100">
        <div class="progress-fill" style="width: {progress}%"></div>
      </div>
    {/if}

    {#if message}
      <p
        class="status-msg"
        class:error-text={status === 'error'}
        class:success-text={status === 'done'}
        class:hint-sm={status !== 'error' && status !== 'done'}
      >{message}</p>
    {/if}
  {/if}
</section>

<style>
  .ota { color: var(--text); }

  .usb-steps { font-size: 0.88rem; }
  .steps-head { margin: 0 0 0.5rem; color: var(--text); font-weight: 600; }
  .usb-steps ol { margin: 0; padding-left: 1.3rem; }
  .usb-steps li { margin: 0.2rem 0; }
  .usb-steps strong { color: var(--green); }

  .fw-status { margin-bottom: 1rem; }
  .fw-ok { margin: 0 0 0.8rem; }

  .advanced-toggle {
    display: block; margin: 1rem 0 0.6rem; padding: 0; background: none; border: none;
    color: var(--text-muted); cursor: pointer; font-family: inherit; font-size: 0.8rem;
  }
  .advanced-toggle:hover { color: var(--text-dim); }

  .file-picker {
    display: block; padding: 1rem; border: 1px dashed var(--border-bright); border-radius: 6px;
    text-align: center; color: var(--text-muted); font-size: 0.85rem; cursor: pointer;
    margin-bottom: 1rem; word-break: break-all;
  }
  .file-picker:hover { border-color: var(--green-dim); color: var(--text-dim); }
  .file-picker.has-file { color: var(--green); border-color: var(--green-dim); }
  .file-picker input { display: none; }

  .ota-progress { margin-top: 1rem; }

  .status-msg { margin-top: 0.8rem; }
</style>

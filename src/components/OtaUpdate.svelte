<script lang="ts">
  // Firmware update over USB. The device only accepts OTA over the cable (never
  // the relay), and a WiFi signer boots straight into its relay loop — so the
  // first job here is to get the owner onto USB, then stream + verify the image.
  // The transfer logic lives in lib/ota.ts (unit-tested); this is the UI over it.
  import { device, serialTransport, httpTransport } from '../lib/device.svelte.js'
  import { streamOta } from '../lib/ota.js'

  let file = $state<File | null>(null)
  let progress = $state(0)
  let status = $state<'idle' | 'waiting' | 'uploading' | 'verifying' | 'done' | 'error'>('idle')
  let message = $state('')

  // OTA needs a direct cable (Web Serial) or the local bridge. A WiFi/relay
  // connection can't carry it — the device rejects OTA frames in WiFi mode.
  const canUpdate = $derived(device.connected && (device.mode === 'serial' || device.mode === 'http'))
  const busy = $derived(status === 'waiting' || status === 'uploading' || status === 'verifying')

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement
    file = input.files?.[0] ?? null
    status = 'idle'
    message = ''
    progress = 0
  }

  async function handleUpload() {
    if (!file || !canUpdate) return
    progress = 0
    try {
      // HTTP bridge: hand it the whole image; the bridge does the chunking.
      if (device.mode === 'http') {
        status = 'waiting'
        message = 'On your signer, hold its button for 2 seconds to approve the update.'
        const buf = await file.arrayBuffer()
        status = 'uploading'
        message = 'Sending the firmware via the bridge…'
        await httpTransport.otaUpload(buf)
        status = 'done'
        message = 'Done — your signer is restarting with the new firmware.'
        return
      }

      // Web Serial: stream + verify directly.
      const data = new Uint8Array(await file.arrayBuffer())
      await streamOta(serialTransport, data, {
        onPhase: (phase) => {
          status = phase
          if (phase === 'waiting') {
            message = 'Your signer is showing the update size. Hold its button for 2 seconds to approve.'
          } else if (phase === 'verifying') {
            message = 'Checking the firmware arrived safely…'
          }
        },
        onProgress: (pct) => {
          progress = pct
          message = `Sending… ${pct}%`
        },
      })
      status = 'done'
      message = 'Done — your signer is restarting with the new firmware.'
    } catch (e) {
      status = 'error'
      message = e instanceof Error ? e.message : 'The update could not be completed.'
    }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
</script>

<section class="ota" aria-label="Update firmware">
  <h2>Update firmware</h2>

  {#if !canUpdate}
    <p class="lede">
      Firmware updates run <strong>over USB</strong> — never over WiFi, for safety. Connect this
      signer with a cable to update it.
    </p>
    <div class="usb-steps">
      <p class="steps-head">Already-set-up WiFi signer? Put it in USB mode first:</p>
      <ol>
        <li>Plug it into this computer with a USB cable.</li>
        <li>Press <strong>RESET</strong> on the board (or unplug and replug it).</li>
        <li>As it starts it shows <strong>"Hold PRG = USB"</strong> for 3 seconds — hold the
          <strong>PRG</strong> button until the screen says <strong>"USB mode"</strong>.</li>
        <li>Then connect over USB here and come back to this screen.</li>
      </ol>
    </div>
  {:else}
    <p class="lede">
      Pick the firmware file to install. Your signer will ask you to approve it with its button,
      check it, and restart into the new version. If anything's wrong it rolls back on its own.
    </p>

    <label class="file-picker" class:has-file={!!file}>
      <input type="file" accept=".bin" onchange={handleFileSelect} disabled={busy} />
      {file ? `${file.name} · ${formatSize(file.size)}` : 'Choose a firmware .bin file'}
    </label>

    {#if file}
      <button class="btn primary" disabled={busy} onclick={handleUpload}>
        {busy ? 'Updating…' : 'Update over USB →'}
      </button>
    {/if}

    {#if status === 'uploading'}
      <div class="progress" role="progressbar" aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100">
        <div class="fill" style="width: {progress}%"></div>
      </div>
    {/if}

    {#if message}
      <p class="message" class:error={status === 'error'} class:done={status === 'done'}>{message}</p>
    {/if}
  {/if}
</section>

<style>
  .ota { color: var(--text); }
  h2 { font-size: 1.05rem; font-weight: 700; margin: 0 0 0.8rem; color: #fff; }
  .lede { font-size: 0.9rem; color: var(--text-dim); line-height: 1.6; margin: 0 0 1rem; }
  .lede strong { color: var(--text); }

  .usb-steps {
    background: #08130d; border: 1px solid var(--green-dim); border-radius: 6px;
    padding: 0.9rem 1rem; font-size: 0.88rem; color: var(--text-dim); line-height: 1.6;
  }
  .steps-head { margin: 0 0 0.5rem; color: var(--text); font-weight: 600; }
  .usb-steps ol { margin: 0; padding-left: 1.3rem; }
  .usb-steps li { margin: 0.2rem 0; }
  .usb-steps strong { color: var(--green); }

  .file-picker {
    display: block; padding: 1rem; border: 1px dashed var(--border-bright); border-radius: 6px;
    text-align: center; color: var(--text-muted); font-size: 0.85rem; cursor: pointer;
    margin-bottom: 1rem; word-break: break-all;
  }
  .file-picker:hover { border-color: var(--green-dim); color: var(--text-dim); }
  .file-picker.has-file { color: var(--green); border-color: var(--green-dim); }
  .file-picker input { display: none; }

  .btn {
    font-family: inherit; font-size: 0.92rem; font-weight: 600; padding: 0.6rem 1.4rem;
    border-radius: 5px; cursor: pointer; border: 1px solid transparent;
  }
  .btn.primary { background: var(--green); color: #050505; border-color: var(--green); }
  .btn.primary:hover:not(:disabled) { background: #00ff88; box-shadow: var(--green-glow); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .progress { height: 6px; background: #11221a; border-radius: 3px; margin-top: 1rem; overflow: hidden; }
  .fill { height: 100%; background: var(--green); transition: width 0.2s; }

  .message { font-size: 0.85rem; color: var(--text-dim); margin-top: 0.8rem; line-height: 1.5; }
  .message.error { color: var(--red); }
  .message.done { color: var(--green); }
</style>

<script lang="ts">
  import { device, transport } from '../lib/device.svelte.js'
  import { FrameType, buildFrame } from '../lib/frame.js'

  let file = $state<File | null>(null)
  let progress = $state(0)
  let status = $state<'idle' | 'hashing' | 'waiting' | 'uploading' | 'verifying' | 'done' | 'error'>('idle')
  let message = $state('')

  const CHUNK_SIZE = 4096

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement
    file = input.files?.[0] ?? null
    status = 'idle'
    message = ''
    progress = 0
  }

  async function handleUpload() {
    if (!file || !device.connected) return

    try {
      status = 'hashing'
      message = 'Computing hash...'
      const data = new Uint8Array(await file.arrayBuffer())
      const hashBuffer = await crypto.subtle.digest('SHA-256', data)
      const hash = new Uint8Array(hashBuffer)

      // OTA_BEGIN: [size_u32_be] [sha256_32]
      status = 'waiting'
      message = 'Press button on device to approve OTA update.'
      const beginPayload = new Uint8Array(4 + 32)
      const size = data.length
      beginPayload[0] = (size >>> 24) & 0xff
      beginPayload[1] = (size >>> 16) & 0xff
      beginPayload[2] = (size >>> 8) & 0xff
      beginPayload[3] = size & 0xff
      beginPayload.set(hash, 4)

      const beginFrame = buildFrame(FrameType.OTA_BEGIN, beginPayload)
      const beginResp = await transport.sendAndReceive(
        beginFrame,
        [FrameType.OTA_STATUS],
        60_000,
      )

      if (beginResp.payload[0] !== 0x00) { // OTA_STATUS_READY
        status = 'error'
        message = `Device rejected OTA begin (status 0x${beginResp.payload[0]?.toString(16)}).`
        return
      }

      // Stream chunks.
      status = 'uploading'
      let offset = 0
      while (offset < data.length) {
        const end = Math.min(offset + CHUNK_SIZE, data.length)
        const chunk = data.slice(offset, end)

        // OTA_CHUNK: [offset_u32_be] [data...]
        const chunkPayload = new Uint8Array(4 + chunk.length)
        chunkPayload[0] = (offset >>> 24) & 0xff
        chunkPayload[1] = (offset >>> 16) & 0xff
        chunkPayload[2] = (offset >>> 8) & 0xff
        chunkPayload[3] = offset & 0xff
        chunkPayload.set(chunk, 4)

        const chunkFrame = buildFrame(FrameType.OTA_CHUNK, chunkPayload)
        const chunkResp = await transport.sendAndReceive(
          chunkFrame,
          [FrameType.OTA_STATUS],
          10_000,
        )

        if (chunkResp.payload[0] !== 0x01) { // OTA_STATUS_CHUNK_OK
          status = 'error'
          message = `Chunk at offset ${offset} rejected (status 0x${chunkResp.payload[0]?.toString(16)}).`
          return
        }

        offset = end
        progress = Math.round((offset / data.length) * 100)
        message = `Uploading... ${progress}% (${offset} / ${data.length} bytes)`
      }

      // OTA_FINISH
      status = 'verifying'
      message = 'Verifying hash...'
      const finishFrame = buildFrame(FrameType.OTA_FINISH)
      const finishResp = await transport.sendAndReceive(
        finishFrame,
        [FrameType.OTA_STATUS],
        30_000,
      )

      if (finishResp.payload[0] === 0x02) { // OTA_STATUS_VERIFIED
        status = 'done'
        message = 'Firmware verified. Device rebooting.'
      } else {
        status = 'error'
        message = `Verification failed (status 0x${finishResp.payload[0]?.toString(16)}). Automatic rollback.`
      }
    } catch (e) {
      status = 'error'
      message = e instanceof Error ? e.message : 'OTA upload failed'
    }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
</script>

<div class="ota">
  <h2>Firmware Update</h2>

  <label class="file-picker">
    <input type="file" accept=".bin" onchange={handleFileSelect} />
    {file ? `${file.name} (${formatSize(file.size)})` : 'Select firmware .bin file'}
  </label>

  {#if file}
    <button
      class="upload-btn"
      disabled={!device.connected || status === 'uploading' || status === 'waiting' || status === 'verifying'}
      onclick={handleUpload}
    >
      {status === 'idle' ? 'Upload and Flash' : status}
    </button>
  {/if}

  {#if status === 'uploading'}
    <div class="progress-bar">
      <div class="fill" style="width: {progress}%"></div>
    </div>
  {/if}

  {#if message}
    <p class="message" class:error={status === 'error'} class:done={status === 'done'}>
      {message}
    </p>
  {/if}
</div>

<style>
  h2 { font-size: 1rem; font-weight: 600; margin: 0 0 1rem; color: #ccc; }

  .file-picker {
    display: block;
    padding: 1rem;
    border: 1px dashed #333;
    border-radius: 4px;
    text-align: center;
    color: #666;
    font-size: 0.85rem;
    cursor: pointer;
    margin-bottom: 1rem;
  }

  .file-picker:hover { border-color: #555; color: #888; }
  .file-picker input { display: none; }

  .upload-btn {
    background: #111a15;
    border: 1px solid #354;
    color: #4a9;
    padding: 0.5rem 1.5rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .upload-btn:hover:not(:disabled) { background: #152a1a; }
  .upload-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .progress-bar {
    height: 4px;
    background: #222;
    border-radius: 2px;
    margin-top: 1rem;
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: #4a9;
    transition: width 0.2s;
  }

  .message { font-size: 0.85rem; color: #888; margin-top: 0.75rem; }
  .message.error { color: #a44; }
  .message.done { color: #4a9; }
</style>

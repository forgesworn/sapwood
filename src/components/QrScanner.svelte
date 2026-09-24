<script lang="ts">
  // Reads a QR code from this computer's camera. Frames are decoded in the
  // browser; nothing leaves it. The camera stops when a code is read, on
  // Cancel, or when the component goes away.
  import { onDestroy, onMount } from 'svelte'
  import { QRCanvas, frontalCamera } from '@paulmillr/qr/dom.js'

  interface Props {
    /** Called with each decoded text until it returns true (accepted). */
    onresult: (text: string) => boolean
    oncancel: () => void
  }
  let { onresult, oncancel }: Props = $props()

  let video = $state<HTMLVideoElement | null>(null)
  let error = $state<string | null>(null)
  let camera: Awaited<ReturnType<typeof frontalCamera>> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  function stop() {
    stopped = true
    if (timer) { clearInterval(timer); timer = null }
    try { camera?.stop() } catch { /* already stopped */ }
    camera = null
  }

  onMount(async () => {
    if (!video) return
    if (!navigator.mediaDevices?.getUserMedia) {
      error = 'This browser gives no access to a camera. Copy the code on the phone and paste it instead.'
      return
    }
    try {
      const opened = await frontalCamera(video)
      if (stopped) { opened.stop(); return }
      camera = opened
    } catch {
      error = 'The camera could not be opened (no camera, or permission refused). Copy the code on the phone and paste it instead.'
      return
    }
    const canvas = new QRCanvas()
    // A few reads a second is plenty for a code held up to the camera.
    timer = setInterval(() => {
      if (!camera || !video || video.readyState < 2) return
      let text: string | undefined
      try { text = camera.readFrame(canvas) } catch { return }
      if (text && onresult(text)) stop()
    }, 200)
  })

  onDestroy(stop)
</script>

<div class="scanner">
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={video} autoplay playsinline muted class:hidden={!!error}></video>
  {#if error}
    <p class="warn-text">{error}</p>
  {:else}
    <p class="hint-sm">Hold the phone's code up to this computer's camera.</p>
  {/if}
  <button class="btn btn-ghost btn-sm" onclick={() => { stop(); oncancel() }}>Stop the camera</button>
</div>

<style>
  .scanner { display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-start; }
  video {
    width: 280px; max-width: 100%; aspect-ratio: 4 / 3; object-fit: cover;
    border: 1px solid var(--border); border-radius: 6px; background: #000;
  }
  .hidden { display: none; }
</style>

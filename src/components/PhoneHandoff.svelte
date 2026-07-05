<script lang="ts">
  // "Manage from your phone": once a device is set up and connected, this shows a
  // QR encoding everything the phone needs — operator key + device address +
  // relays. The operator key is the management credential, so by default we
  // encrypt it with a PIN (NIP-49): the QR is useless to anyone who photographs
  // it without the code, which the phone prompts for. A "no PIN" fallback exists
  // for a quick scan on a trusted screen. See lib/import-link (the phone side).
  import { encodeQR } from '@paulmillr/qr'
  import { onDestroy } from 'svelte'
  import { device } from '../lib/device.svelte.js'
  import { getOrCreateOperator } from '../lib/op-mgmt.js'
  import { buildHandoffLink, buildProtectedHandoffLink, encryptOperator } from '../lib/import-link.svelte.js'
  import { listKnownDevices } from '../lib/known-devices.js'
  import { nip19 } from 'nostr-tools'
  import { copyText } from '../lib/clipboard.js'

  let copied = $state(false)
  let reveal = $state(false)
  let pin = $state('')
  let building = $state(false)
  let link = $state('') // the built handoff link (protected or plain)
  let protectedLink = $state(false)
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  const MIN_PIN = 6

  /** Device master pubkey as x-only hex, from the connected device's npub. */
  function deviceHex(): string {
    const npub = device.masters[0]?.npub ?? ''
    if (/^[0-9a-f]{64}$/i.test(npub)) return npub.toLowerCase()
    try {
      const d = nip19.decode(npub)
      if (d.type === 'npub') return d.data as string
    } catch { /* not an npub */ }
    return ''
  }

  /** Relays this device listens on: from the remembered device, else last flash. */
  function relaysFor(hex: string): string[] {
    const known = listKnownDevices().find((d) => d.pubHex === hex)
    if (known?.relays.length) return known.relays
    try {
      const saved = JSON.parse(localStorage.getItem('heartwood.lastRelays') ?? '[]')
      if (Array.isArray(saved) && saved.length) return saved
    } catch { /* none */ }
    return []
  }

  const hex = $derived(deviceHex())
  const relays = $derived(hex ? relaysFor(hex) : [])
  const ready = $derived(!!hex && relays.length > 0)
  const qr = $derived(link ? encodeQR(link, 'svg') : '')

  function armHideTimer() {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(hidePairing, 2 * 60 * 1000)
  }

  function startReveal() {
    reveal = true
    link = ''
    pin = ''
    copied = false
  }

  async function showProtected() {
    if (pin.length < MIN_PIN || !hex || !relays.length) return
    building = true
    // Yield so "Protecting…" paints before the (blocking) scrypt in encryptOperator.
    await new Promise((r) => setTimeout(r, 0))
    try {
      const eop = encryptOperator(getOrCreateOperator().skHex, pin)
      link = buildProtectedHandoffLink(location.origin, eop, hex, relays)
      protectedLink = true
      armHideTimer()
    } finally {
      building = false
    }
  }

  function showPlain() {
    link = buildHandoffLink(location.origin, getOrCreateOperator().skHex, hex, relays)
    protectedLink = false
    armHideTimer()
  }

  function hidePairing() {
    reveal = false
    link = ''
    pin = ''
    copied = false
    protectedLink = false
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  async function copyLink() {
    if (!link) return
    if (await copyText(link)) {
      copied = true
      setTimeout(() => (copied = false), 1500)
    }
  }

  onDestroy(() => {
    if (hideTimer) clearTimeout(hideTimer)
  })
</script>

{#if ready}
  <section class="card card--live handoff">
    <p class="section-title">⚲ Manage from your phone</p>

    {#if !reveal}
      <p class="hint">
        Pair this signer with your phone or another browser. You'll set a PIN, then scan a QR that
        opens the console there, already connected.
      </p>
      <button class="btn btn-secondary btn-sm" onclick={startReveal}>Pair a device</button>

    {:else if !link}
      <p class="hint">
        Set a PIN. You enter it on the phone to unlock the link, so a photo or a saved copy of the QR
        is useless without it. A short phrase is stronger than digits.
      </p>
      <label class="field">
        <span class="field-label">PIN or passphrase ({MIN_PIN}+ characters)</span>
        <input
          type="text"
          class="field-input"
          bind:value={pin}
          placeholder="e.g. river-otter-27"
          maxlength="64"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          data-1p-ignore
          data-lpignore="true"
          onkeydown={(e) => { if (e.key === 'Enter' && pin.length >= MIN_PIN) showProtected() }}
        />
      </label>
      <div class="handoff-actions">
        <button class="btn btn-primary btn-sm" disabled={pin.length < MIN_PIN || building} onclick={showProtected}>
          {building ? 'Protecting…' : 'Protect and show QR'}
        </button>
        <button class="btn btn-ghost btn-sm" onclick={hidePairing}>Cancel</button>
      </div>
      <button class="plain-link" onclick={showPlain}>Show without a PIN (only on a screen you trust)</button>

    {:else}
      <p class="hint">
        Scan this with your phone's camera.
        {protectedLink ? 'It opens the console and asks for your PIN.' : 'It opens the console, already connected.'}
      </p>
      <div class="qr">{@html qr}</div>
      <div class="handoff-actions">
        <button class="btn btn-secondary btn-sm" onclick={copyLink}>{copied ? 'Link copied ✓' : 'Copy link instead'}</button>
        <button class="btn btn-ghost btn-sm" onclick={hidePairing}>Hide</button>
      </div>
      {#if protectedLink}
        <p class="hint-sm">
          Enter your PIN on the phone to unlock it. The PIN is not in the link, so the QR alone can't
          be used. Hides automatically after two minutes.
        </p>
      {:else}
        <p class="warn-text">
          This link carries your operator key in the clear. Treat it like a password: anyone who scans
          it can manage this device. Scan it, don't save it. It hides after two minutes.
        </p>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .handoff { margin-top: 1.5rem; }
  .handoff .section-title { font-size: 0.95rem; color: var(--green); }
  .field { margin-bottom: 0.9rem; }
  .qr { width: 184px; padding: 12px; background: #fff; border-radius: 6px; margin-bottom: 0.9rem; }
  .qr :global(svg) { display: block; width: 100%; height: auto; }
  .handoff-actions { display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .plain-link {
    display: block; margin: 0.9rem 0 0; padding: 0; width: 100%;
    background: none; border: none; color: var(--text-muted);
    cursor: pointer; font-family: inherit; font-size: 0.78rem; text-align: center;
  }
  .plain-link:hover { color: var(--text-dim); text-decoration: underline; }
</style>

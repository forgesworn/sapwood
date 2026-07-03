<script lang="ts">
  // "Manage from your phone": once a device is set up and connected, this shows a
  // QR encoding everything the phone needs — operator key + device address +
  // relays. Scanning it opens the console there, already connected. No npub, no
  // typing. See lib/import-link (the phone side consumes the same link).
  import { encodeQR } from '@paulmillr/qr'
  import { device } from '../lib/device.svelte.js'
  import { getOrCreateOperator } from '../lib/op-mgmt.js'
  import { buildHandoffLink } from '../lib/import-link.svelte.js'
  import { listKnownDevices } from '../lib/known-devices.js'
  import { nip19 } from 'nostr-tools'
  import { copyText } from '../lib/clipboard.js'

  let copied = $state(false)

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
  const link = $derived(ready ? buildHandoffLink(location.origin, getOrCreateOperator().skHex, hex, relays) : '')
  const qr = $derived(link ? encodeQR(link, 'svg') : '')

  async function copyLink() {
    if (!link) return
    const ok = await copyText(link)
    if (ok) {
      copied = true
      setTimeout(() => (copied = false), 1500)
    }
  }
</script>

{#if ready}
  <section class="card card--live handoff">
    <p class="section-title">⚲ Manage from your phone</p>
    <p class="hint">
      Scan this with your phone's camera. It opens the console there, already connected to this
      signer, nothing to type.
    </p>
    <div class="qr">{@html qr}</div>
    <button class="btn btn-secondary btn-sm" onclick={copyLink}>{copied ? 'Link copied ✓' : 'Copy link instead'}</button>
    <p class="warn-text">
      This link carries your operator key. Treat it like a password: anyone who scans it can manage
      this device. It is not the device's secret seed.
    </p>
  </section>
{/if}

<style>
  .handoff { margin-top: 1.5rem; }
  .handoff .section-title { font-size: 0.95rem; color: var(--green); }
  .qr { width: 184px; padding: 12px; background: #fff; border-radius: 6px; margin-bottom: 0.9rem; }
  .qr :global(svg) { display: block; width: 100%; height: auto; }
</style>

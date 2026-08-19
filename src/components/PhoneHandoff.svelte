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
  import { findStoredOperatorByPubHex, type Operator } from '../lib/op-mgmt.js'
  import { buildHandoffLink, buildProtectedHandoffLink, encryptOperator } from '../lib/import-link.svelte.js'
  import { nip19 } from 'nostr-tools'
  import { copyText } from '../lib/clipboard.js'

  let copied = $state(false)
  let reveal = $state(false)
  let revealAuthorityKey = $state('')
  let pin = $state('')
  let building = $state(false)
  let link = $state('') // the built handoff link (protected or plain)
  let linkAuthorityKey = $state('')
  let protectedLink = $state(false)
  let confirmPlain = $state(false) // explicit second step before a PIN-less link is shown
  let observedAuthorityKey = $state<string | null>(null)
  let revealEpoch = $state(0)
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

  /** Relays proven by this exact live target, never browser-global defaults. */
  function provenRelays(): string[] {
    if (device.mode === 'relay' && device.relayStatus) return [...(device.relayConfiguredRelays ?? [])]
    const state = device.mode === 'serial' ? device.usbNetworkState : null
    if (state?.configured && state.recovery_ok && state.mode === 'wifi' && state.trial === null) {
      return [...(state.relays ?? [])]
    }
    return []
  }

  function provenOperator(): Operator | null {
    if (device.mode === 'relay' && device.relayStatus && device.operatorPub) {
      return findStoredOperatorByPubHex(device.operatorPub)
    }
    const state = device.mode === 'serial' ? device.usbNetworkState : null
    if (state?.configured && state.recovery_ok && state.mode === 'wifi'
      && state.trial === null && state.op_mgmt) {
      return findStoredOperatorByPubHex(state.op_mgmt)
    }
    return null
  }

  /** Bind generated material to the exact authority proof that produced it.
   * Relay order is deliberately part of the tuple: any device-read change,
   * including a reordered route, requires a fresh user reveal. */
  function authorityTupleKey(
    devicePubHex: string,
    operator: Operator | null,
    exactRelays: string[],
  ): string {
    if (!devicePubHex || !operator || exactRelays.length === 0) return ''
    return JSON.stringify([
      devicePubHex.toLowerCase(),
      operator.pubHex.toLowerCase(),
      exactRelays,
    ])
  }

  function currentAuthority(): {
    devicePubHex: string
    operator: Operator
    exactRelays: string[]
    key: string
  } | null {
    const devicePubHex = deviceHex()
    const operator = provenOperator()
    const exactRelays = devicePubHex ? provenRelays() : []
    const key = authorityTupleKey(devicePubHex, operator, exactRelays)
    return operator && key ? { devicePubHex, operator, exactRelays, key } : null
  }

  const hex = $derived(deviceHex())
  const relays = $derived(hex ? provenRelays() : [])
  // Relay proof comes from authenticated get_status. USB proof comes from the
  // current firmware's exact device-read operator + relay state. Neither path
  // guesses from the browser's primary key or a global relay cache.
  const handoffOperator = $derived<Operator | null>(provenOperator())
  const visible = $derived(
    !!hex && (device.mode === 'serial' || device.mode === 'relay'),
  )
  const ready = $derived(visible && relays.length > 0 && handoffOperator !== null)
  const authorityKey = $derived(
    ready ? authorityTupleKey(hex, handoffOperator, relays) : '',
  )
  // The key check closes the render-time gap before the invalidation effect
  // runs, so old QR material cannot flash when proof A changes to B.
  const activeLink = $derived(
    authorityKey && linkAuthorityKey === authorityKey ? link : '',
  )
  const qr = $derived(activeLink ? encodeQR(activeLink, 'svg') : '')

  $effect(() => {
    const current = authorityKey
    if (observedAuthorityKey === null) {
      observedAuthorityKey = current
      return
    }
    if (current === observedAuthorityKey) return
    observedAuthorityKey = current
    // This also covers A -> unavailable -> A: once proof disappears, an old
    // reveal must never resurrect merely because the same tuple returns.
    hidePairing()
  })

  function armHideTimer() {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(hidePairing, 2 * 60 * 1000)
  }

  function startReveal() {
    if (!ready) return
    revealEpoch += 1
    reveal = true
    revealAuthorityKey = authorityKey
    link = ''
    linkAuthorityKey = ''
    pin = ''
    copied = false
    confirmPlain = false
  }

  async function showProtected() {
    if (building || pin.length < MIN_PIN || !ready) return
    const buildEpoch = revealEpoch
    const buildAuthorityKey = revealAuthorityKey
    const buildPin = pin
    if (!buildAuthorityKey || buildAuthorityKey !== authorityKey) return
    building = true
    // Yield so "Protecting…" paints before the (blocking) scrypt in encryptOperator.
    await new Promise((r) => setTimeout(r, 0))
    try {
      // Re-resolve after yielding: a reconnect could have changed or removed
      // the proof while the PIN step was open. Never reuse a stale authority or
      // complete work after the reveal was invalidated.
      const authority = currentAuthority()
      if (!reveal || revealEpoch !== buildEpoch || !authority
        || buildPin.length < MIN_PIN || pin !== buildPin
        || authority.key !== buildAuthorityKey
        || authorityKey !== buildAuthorityKey
        || revealAuthorityKey !== buildAuthorityKey) return
      const eop = encryptOperator(authority.operator.skHex, buildPin)
      linkAuthorityKey = authority.key
      link = buildProtectedHandoffLink(
        location.origin,
        eop,
        authority.devicePubHex,
        authority.exactRelays,
      )
      protectedLink = true
      armHideTimer()
    } finally {
      building = false
    }
  }

  function showPlain() {
    const authority = currentAuthority()
    if (!reveal || !confirmPlain || !authority || authority.key !== authorityKey
      || authority.key !== revealAuthorityKey) return
    linkAuthorityKey = authority.key
    link = buildHandoffLink(
      location.origin,
      authority.operator.skHex,
      authority.devicePubHex,
      authority.exactRelays,
    )
    protectedLink = false
    armHideTimer()
  }

  function hidePairing() {
    revealEpoch += 1
    reveal = false
    revealAuthorityKey = ''
    link = ''
    linkAuthorityKey = ''
    pin = ''
    copied = false
    protectedLink = false
    confirmPlain = false
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  async function copyLink() {
    if (!activeLink) return
    if (await copyText(activeLink)) {
      copied = true
      setTimeout(() => (copied = false), 1500)
    }
  }

  onDestroy(() => {
    // A zero-delay protected build may still be waiting to resume. Tear-down
    // is an authority boundary too: invalidate that continuation and remove
    // the PIN/link material, not merely the long-lived hide timer.
    hidePairing()
  })
</script>

{#if visible}
  <section class="card card--live handoff">
    <p class="section-title">⚲ Manage from your phone</p>

    {#if device.mode === 'serial' && device.usbNetworkSupport !== 'supported'}
      {#if device.usbNetworkSupport === 'unsupported'}
        <p class="warn-text">Update the signer firmware over USB before pairing a phone. Sapwood will not guess its operator or relays.</p>
      {:else}
        <p class="hint">Reading this signer's operator and relays before enabling phone pairing…</p>
      {/if}
    {:else if device.mode === 'serial' && device.usbNetworkState?.trial}
      <p class="warn-text">
        Phone pairing stays locked while this signer is trying a network change. Wait for it to
        finish or roll back; Sapwood will not export the previous relay route.
      </p>
    {:else if device.mode === 'serial' && device.usbNetworkState?.mode !== 'wifi'}
      <p class="hint">Enable WiFi-standalone mode before pairing a phone for remote management.</p>
    {:else if device.mode === 'relay' && !device.relayStatus}
      <p class="warn-text">
        Pairing stays locked until this signer answers an authenticated status request. Retry the WiFi
        connection; a relay subscription alone does not prove which operator key the signer accepts.
      </p>
    {:else if device.mode === 'relay' && device.relayConfiguredRelays === null}
      <p class="hint">Reading this signer's active configured relays before enabling phone pairing…</p>
    {:else if device.mode === 'relay' && (device.relayConfiguredRelays?.length ?? 0) === 0}
      <p class="warn-text">
        This signer did not report an active relay route, so pairing stays locked. Sapwood will not
        export cached relay addresses.
      </p>
    {:else if !ready}
      <p class="warn-text">
        Pairing is unavailable because this browser does not have the operator key that authenticated
        this WiFi session. Restore that exact operator key, reconnect, then pair your phone.
      </p>
    {:else if !reveal}
      <p class="hint">
        {device.mode === 'serial'
          ? "The cable has proven this signer's exact operator and relays. Pair your phone now; it can connect after the signer is left online elsewhere."
          : "Pair this signer with your phone or another browser. You'll set a PIN, then scan a QR that opens the console there, already connected."}
      </p>
      <button class="btn btn-secondary btn-sm" onclick={startReveal}>Pair a device</button>

    {:else if !activeLink}
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
          onkeydown={(e) => {
            if (e.key === 'Enter' && pin.length >= MIN_PIN && !building) showProtected()
          }}
        />
      </label>
      <div class="handoff-actions">
        <button class="btn btn-primary btn-sm" disabled={pin.length < MIN_PIN || building} onclick={showProtected}>
          {building ? 'Protecting…' : 'Protect and show QR'}
        </button>
        <button class="btn btn-ghost btn-sm" onclick={hidePairing}>Cancel</button>
      </div>
      {#if !confirmPlain}
        <button class="plain-link" onclick={() => (confirmPlain = true)}>Show without a PIN (only on a screen you trust)</button>
      {:else}
        <div class="plain-confirm">
          <p class="warn-text">
            A PIN-less link carries your operator key in the clear. Anyone who scans, photographs,
            or saves it can manage this signer — never paste it into notes or chat that syncs.
            Scan it once, on a screen you trust, then let it hide.
          </p>
          <div class="handoff-actions">
            <button class="btn btn-warn btn-sm" onclick={showPlain}>I understand — show the plain link</button>
            <button class="btn btn-ghost btn-sm" onclick={() => (confirmPlain = false)}>Back</button>
          </div>
        </div>
      {/if}

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
  .plain-confirm { margin-top: 0.9rem; }
  .plain-confirm .handoff-actions { margin-top: 0.6rem; }
</style>

<script lang="ts">
  // The guided "give your signer its first identity" flow, shown on Home when a
  // device is connected over USB but has no identity yet. The DEVICE generates its
  // own seed from its hardware RNG and shows the 12-word recovery phrase on its
  // OWN screen — the phrase is never generated or displayed in the browser. We
  // only ask it to generate and then show the resulting public npub. Power users
  // with an existing key take the "I already have one" door to Advanced › Identity.
  import { device, connectRelay, generateIdentity, restoreIdentity, getFirmwareVersion } from '../lib/device.svelte.js'
  import { rememberDevice } from '../lib/known-devices.js'
  import { navigate } from '../lib/route.svelte.js'
  import {
    type IdentityStep, nameOk, nameError, provisionLabel, friendlyLabel,
  } from '../lib/first-identity.js'
  import { nip19 } from 'nostr-tools'

  interface Props {
    /** Jump to the advanced cockpit (for the "I already have a key" path). */
    onadvanced?: () => void
    /** Called once the identity is created (so Home can refresh). */
    ondone?: () => void
  }
  let { onadvanced, ondone }: Props = $props()

  let step = $state<IdentityStep>('intro')
  // 'create' = device makes a fresh seed; 'restore' = owner re-enters an
  // existing 12-word phrase on the device itself (never typed in the browser).
  let mode = $state<'create' | 'restore'>('create')
  let name = $state('')
  let saved = $state(false) // owner confirmed they wrote down the on-screen phrase
  let npub = $state('')
  let status = $state<'idle' | 'generating' | 'restoring' | 'error'>('idle')
  let error = $state('')

  // The connected board (from FIRMWARE_INFO), so the on-device entry
  // instructions match its buttons. The T-Display has two buttons and a
  // different restore vocabulary; every other board is single-button.
  let deviceBoard = $state('')
  const twoButton = $derived(deviceBoard === 'tdisplay')

  // The just-provisioned wifi device's relays, if any — drives the handoff at the end.
  let handoff = $state<{ hex: string; relays: string[] } | null>(null)
  let handoffConnecting = $state(false)
  let handoffError = $state('')

  function startCreate() {
    mode = 'create'
    name = ''
    saved = false
    error = ''
    step = 'naming'
  }

  function startRestore() {
    mode = 'restore'
    name = ''
    saved = false
    error = ''
    step = 'naming'
  }

  /** Remember this device + decide whether a WiFi handoff applies. */
  function rememberProvisioned() {
    try {
      const decoded = nip19.decode(npub)
      if (decoded.type !== 'npub') return
      const hex = decoded.data as string
      let relays: string[] | null = null
      try {
        const raw = JSON.parse(localStorage.getItem('heartwood.lastRelays') ?? '[]')
        if (Array.isArray(raw) && raw.length) relays = raw
      } catch { /* not a wifi flash */ }
      rememberDevice(hex, relays ?? ['wss://relay.trotters.cc'], friendlyLabel(name))
      handoff = relays ? { hex, relays } : null
    } catch { /* non-fatal */ }
  }

  async function generateOnDevice() {
    if (!nameOk(name)) return
    status = 'generating'
    error = ''
    try {
      // The device makes the seed and shows the phrase on its screen; only the
      // public npub comes back.
      npub = await generateIdentity(provisionLabel(name))
      rememberProvisioned()
      status = 'idle'
      step = 'writedown'
    } catch (e) {
      status = 'error'
      error = e instanceof Error ? e.message : 'The device could not generate an identity.'
    }
  }

  async function restoreOnDevice() {
    if (!nameOk(name)) return
    status = 'restoring'
    error = ''
    // Learn the board before the (blocking) restore so the on-device entry
    // instructions match its buttons.
    try { deviceBoard = (await getFirmwareVersion())?.board ?? '' } catch { deviceBoard = '' }
    step = 'restoring'
    try {
      // The owner enters their 12 words on the device's screen; only the
      // resulting public npub comes back over the cable.
      npub = await restoreIdentity(provisionLabel(name))
      rememberProvisioned()
      status = 'idle'
      finish()
    } catch (e) {
      status = 'error'
      error = e instanceof Error ? e.message : 'The device could not restore that phrase.'
      step = 'naming'
    }
  }

  function finish() {
    step = 'done'
    ondone?.()
  }

  async function manageWifi() {
    if (!handoff) return
    handoffConnecting = true
    handoffError = ''
    try {
      await connectRelay(handoff.hex, handoff.relays, friendlyLabel(name))
    } catch (e) {
      handoffError = e instanceof Error ? e.message
        : 'Could not reach it yet: give it ~10s to reboot and join WiFi, then retry.'
    } finally {
      handoffConnecting = false
    }
  }
</script>

<section class="fi" aria-label="Set up your signer">
  {#if step === 'intro'}
    <span class="badge">New signer</span>
    <h2 class="fi-title">Let's give your signer its identity</h2>
    <p class="fi-lede">
      Your device is connected but doesn't have an identity yet. We'll have the device
      <strong>create its own recovery phrase and show it on its own screen</strong>. The secret
      never appears on this computer. Do this once; afterwards you connect apps and manage it
      from your phone.
    </p>
    <div class="fi-actions">
      <button class="btn btn-primary" onclick={startCreate}>Create a fresh identity →</button>
      <button class="btn btn-secondary" onclick={startRestore}>Restore from my 12 words</button>
    </div>
    <button class="fi-advanced" onclick={() => onadvanced?.()}>Advanced: use a raw key (nsec/bunker)</button>

  {:else if step === 'naming'}
    <h2 class="fi-title">Name your signer</h2>
    <p class="fi-lede">
      {#if mode === 'restore'}
        Give it a friendly name (optional), then we'll ask the device to take your recovery phrase.
        You'll type your <strong>12 words on the device's screen</strong> using its button, never here.
      {:else}
        Give it a friendly name (optional), then we'll ask the device to make its identity.
        The recovery phrase appears <strong>on the device's screen</strong>, not here.
      {/if}
    </p>
    <label class="field">
      <span class="field-label">Name this signer (optional)</span>
      <input type="text" class="field-input" bind:value={name} placeholder="e.g. My signer" maxlength="32" />
    </label>
    {#if nameError(name)}<p class="error-text">{nameError(name)}</p>{/if}
    {#if error}<p class="error-text">{error}</p>{/if}
    {#if status === 'generating'}
      <p class="fi-working">⏳ Your device is creating its keys. This takes a few seconds. Watch its
        screen; the 12 words appear there when it's ready.</p>
    {/if}
    <div class="fi-actions">
      <button class="btn btn-secondary" onclick={() => (step = 'intro')} disabled={status === 'generating'}>Back</button>
      {#if mode === 'restore'}
        <button class="btn btn-primary" disabled={!nameOk(name)} onclick={restoreOnDevice}>
          Restore on my device →
        </button>
      {:else}
        <button class="btn btn-primary" disabled={!nameOk(name) || status === 'generating'} onclick={generateOnDevice}>
          {status === 'generating' ? 'Creating on device…' : 'Create it on my device →'}
        </button>
      {/if}
    </div>

  {:else if step === 'writedown'}
    <h2 class="fi-title">Write down the words on your device</h2>
    <p class="fi-lede">
      Your signer is showing its <strong>12-word recovery phrase, one big word at a time</strong>.
      <strong>Tap the button on the signer to step through them</strong>, writing each one down in
      order. Keep them safe: they're the only way to recover this signer, and
      <strong>anyone who has them controls it</strong>. They appear only on the device, never here.
    </p>
    <p class="fi-lede">
      After the last word, <strong>press and hold the button</strong> until the screen says it's
      saved. A WiFi signer then reboots and joins your network, so give it about 10 seconds.
    </p>
    {#if npub}
      <div class="uri-box"><code>{npub}</code></div>
      <p class="hint-sm">↑ your signer's public address, safe to share</p>
    {/if}
    <label class="confirm-save">
      <input type="checkbox" bind:checked={saved} />
      <span>I've stepped through all 12 words, written them down, and held the button to save.</span>
    </label>
    <div class="fi-actions">
      <button class="btn btn-primary" disabled={!saved} onclick={finish}>Continue</button>
    </div>

  {:else if step === 'restoring'}
    <h2 class="fi-title">Enter your 12 words on the device</h2>
    <p class="fi-lede">
      Your signer is now asking for your recovery phrase <strong>on its own screen</strong>. Enter each
      word there with the button. Nothing is typed on this computer.
    </p>
    {#if twoButton}
      <ul class="fi-gestures">
        <li><strong>A</strong> and <strong>B</strong> move through the letters</li>
        <li><strong>Hold B</strong> to pick the highlighted letter (the word fills in once it's certain)</li>
        <li><strong>Hold A</strong> to delete the last letter, or step back a word</li>
      </ul>
      <p class="fi-lede">
        After the 12th word, the device shows the account it worked out: check it's the right one,
        then <strong>hold B to save</strong>. We'll confirm here when it's done.
      </p>
    {:else}
      <ul class="fi-gestures">
        <li><strong>Tap</strong> the button to change the highlighted letter</li>
        <li><strong>Double-tap</strong> to choose it (the word fills in once it's certain)</li>
        <li><strong>Hold</strong> to delete the last letter or step back a word</li>
      </ul>
      <p class="fi-lede">
        After the 12th word, the device shows the account it worked out: check it's the right one,
        then <strong>hold the button to save</strong>. We'll confirm here when it's done.
      </p>
    {/if}
    <p class="fi-working">⏳ Waiting for you to finish on the device…</p>

  {:else if step === 'done'}
    <div class="done-head">
      <span class="done-dot"></span>
      <h2 class="fi-title">Your signer has an identity</h2>
    </div>
    {#if handoff}
      <p class="fi-lede">
        This is a WiFi signer, so from here on you can manage it over the network, no cable
        needed. Give it about 10 seconds to reboot and join WiFi, then connect:
      </p>
      {#if device.mode === 'relay'}
        <p class="success-text">✓ Connected over WiFi. You can connect your apps now.</p>
      {:else}
        <button class="btn btn-primary" onclick={manageWifi} disabled={handoffConnecting}>
          {handoffConnecting ? 'Connecting…' : 'Manage over WiFi'}
        </button>
        {#if handoffError}<p class="warn-text">{handoffError}</p>{/if}
      {/if}
    {:else}
      <p class="fi-lede">It's ready. You can connect your first app now.</p>
      <div class="fi-actions">
        <button class="btn btn-primary" onclick={() => ondone?.()}>Continue</button>
      </div>
    {/if}
    <button class="fi-another" onclick={() => navigate('flash')}>
      + Set up another device
    </button>
  {/if}
</section>

<style>
  .fi {
    background: var(--surface-raised);
    border: 1px solid var(--green-dim);
    border-radius: 8px;
    padding: 1.5rem;
  }
  .badge {
    display: inline-block; font-size: 0.66rem; letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--green); background: #08130d; border: 1px solid var(--green-dim);
    border-radius: 999px; padding: 0.1rem 0.6rem; margin-bottom: 0.7rem;
  }
  .fi-title { font-size: 1.35rem; font-weight: 700; color: #fff; margin: 0 0 0.6rem; letter-spacing: 0.01em; }
  .fi-lede { font-size: 0.92rem; color: var(--text-dim); line-height: 1.65; margin: 0 0 1.2rem; }
  .fi-lede strong { color: var(--text); }
  .fi-working { font-size: 0.85rem; color: var(--green-dim); line-height: 1.55; margin: 0.6rem 0 0; }

  .fi-advanced {
    display: block; margin: 1rem 0 0; padding: 0; width: 100%;
    border: none; background: none; color: var(--text-muted);
    cursor: pointer; font-family: inherit; font-size: 0.8rem; text-align: center;
  }
  .fi-advanced:hover { color: var(--text-dim); text-decoration: underline; }

  .fi-gestures {
    margin: 0 0 1.2rem; padding: 0.8rem 1rem 0.8rem 2.2rem;
    background: #08130d; border: 1px solid var(--green-dim); border-radius: 6px;
    font-size: 0.88rem; color: var(--text-dim); line-height: 1.7;
  }
  .fi-gestures li { margin: 0; }
  .fi-gestures strong { color: var(--green); }

  .confirm-save {
    display: flex; align-items: flex-start; gap: 0.6rem; margin: 0.4rem 0 1.1rem;
    font-size: 0.88rem; color: var(--text); line-height: 1.5; cursor: pointer;
  }
  .confirm-save input { margin-top: 0.2rem; accent-color: var(--green); width: 1.1rem; height: 1.1rem; flex-shrink: 0; }

  .uri-box { margin: 0 0 0.4rem; }

  .done-head { display: flex; align-items: center; gap: 0.55rem; margin-bottom: 0.5rem; }
  .done-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--green); box-shadow: var(--green-glow); flex-shrink: 0; }
  .done-head .fi-title { margin: 0; }

  .fi-actions { display: flex; gap: 0.6rem; justify-content: flex-end; flex-wrap: wrap; margin-top: 1.3rem; }

  .fi-another {
    display: block; margin-top: 1.4rem; padding-top: 1.1rem; width: 100%;
    border: none; border-top: 1px solid var(--border); background: none;
    color: var(--text-dim); cursor: pointer; font-family: inherit; font-size: 0.85rem; text-align: left;
  }
  .fi-another:hover { color: var(--green); }

  @media (max-width: 640px) {
    .fi { padding: 1.2rem; }
    .fi-actions { flex-direction: column-reverse; }
    .fi-actions .btn { width: 100%; }
  }
</style>

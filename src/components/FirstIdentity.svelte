<script lang="ts">
  // The guided "give your signer its first identity" flow, shown on Home when a
  // device is connected over USB but has no master yet. The DEVICE generates its
  // own seed from its hardware RNG and shows the 12-word recovery phrase on its
  // OWN screen — the phrase is never generated or displayed in the browser. We
  // only ask it to generate and then show the resulting public npub. Power users
  // with an existing key take the "I already have one" door to Advanced › Provision.
  import { device, connectRelay, generateIdentity } from '../lib/device.svelte.js'
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
  let name = $state('')
  let saved = $state(false) // owner confirmed they wrote down the on-screen phrase
  let npub = $state('')
  let status = $state<'idle' | 'generating' | 'error'>('idle')
  let error = $state('')

  // The just-provisioned wifi device's relays, if any — drives the handoff at the end.
  let handoff = $state<{ hex: string; relays: string[] } | null>(null)
  let handoffConnecting = $state(false)
  let handoffError = $state('')

  function startCreate() {
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
        : 'Could not reach it yet — give it ~10s to reboot and join WiFi, then retry.'
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
      <strong>create its own recovery phrase and show it on its own screen</strong> — the secret
      never appears on this computer. Do this once; afterwards you connect apps and manage it
      from your phone.
    </p>
    <div class="fi-actions">
      <button class="btn primary" onclick={startCreate}>Create a fresh identity →</button>
      <button class="btn ghost" onclick={() => onadvanced?.()}>I already have a recovery phrase or key</button>
    </div>

  {:else if step === 'naming'}
    <h2 class="fi-title">Name your signer</h2>
    <p class="fi-lede">
      Give it a friendly name (optional), then we'll ask the device to make its identity.
      The recovery phrase appears <strong>on the device's screen</strong>, not here.
    </p>
    <label class="field">
      <span>Name this signer (optional)</span>
      <input type="text" bind:value={name} placeholder="e.g. My signer" maxlength="32" />
    </label>
    {#if nameError(name)}<p class="fi-error">{nameError(name)}</p>{/if}
    {#if error}<p class="fi-error">{error}</p>{/if}
    <div class="fi-actions">
      <button class="btn ghost" onclick={() => (step = 'intro')} disabled={status === 'generating'}>Back</button>
      <button class="btn primary" disabled={!nameOk(name) || status === 'generating'} onclick={generateOnDevice}>
        {status === 'generating' ? 'Creating on device…' : 'Create it on my device →'}
      </button>
    </div>

  {:else if step === 'writedown'}
    <h2 class="fi-title">Write down the words on your device</h2>
    <p class="fi-lede">
      Your signer is showing its <strong>12-word recovery phrase, one big word at a time</strong>.
      <strong>Tap the button on the signer to step through them</strong>, writing each one down in
      order. Keep them safe — they're the only way to recover this signer, and
      <strong>anyone who has them controls it</strong>. They appear only on the device, never here.
    </p>
    <p class="fi-lede">
      After the last word, <strong>press and hold the button</strong> until the screen says it's
      saved. A WiFi signer then reboots and joins your network — give it about 10 seconds.
    </p>
    {#if npub}
      <p class="npub">{npub}</p>
      <p class="fi-hint">↑ your signer's public address — safe to share</p>
    {/if}
    <label class="confirm-save">
      <input type="checkbox" bind:checked={saved} />
      <span>I've stepped through all 12 words, written them down, and held the button to save.</span>
    </label>
    <div class="fi-actions">
      <button class="btn primary" disabled={!saved} onclick={finish}>Continue</button>
    </div>

  {:else if step === 'done'}
    <div class="done-head">
      <span class="done-dot"></span>
      <h2 class="fi-title">Your signer has an identity</h2>
    </div>
    {#if handoff}
      <p class="fi-lede">
        This is a WiFi signer, so you manage it over the network from here on — not the cable.
        Give it about 10 seconds to reboot and join WiFi, then connect:
      </p>
      {#if device.mode === 'relay'}
        <p class="fi-ok">✓ Connected over WiFi — you can connect your apps now.</p>
      {:else}
        <button class="btn primary" onclick={manageWifi} disabled={handoffConnecting}>
          {handoffConnecting ? 'Connecting…' : 'Manage over WiFi'}
        </button>
        {#if handoffError}<p class="fi-warn">{handoffError}</p>{/if}
      {/if}
    {:else}
      <p class="fi-lede">It's ready. You can connect your first app now.</p>
      <div class="fi-actions">
        <button class="btn primary" onclick={() => ondone?.()}>Continue</button>
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
  .fi-warn { font-size: 0.8rem; color: var(--amber); line-height: 1.5; margin: 0.8rem 0 0; }
  .fi-error { font-size: 0.85rem; color: var(--red); margin: 0.6rem 0 0; }
  .fi-ok { font-size: 0.9rem; color: var(--green); margin: 0; }
  .fi-hint { font-size: 0.75rem; color: var(--text-muted); margin: 0.3rem 0 1rem; }

  .confirm-save {
    display: flex; align-items: flex-start; gap: 0.6rem; margin: 0.4rem 0 1.1rem;
    font-size: 0.88rem; color: var(--text); line-height: 1.5; cursor: pointer;
  }
  .confirm-save input { margin-top: 0.2rem; accent-color: var(--green); width: 1.1rem; height: 1.1rem; flex-shrink: 0; }

  .field { display: flex; flex-direction: column; gap: 0.35rem; }
  .field span { font-size: 0.75rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; }
  .field input {
    background: #0e0e0e; border: 1px solid var(--border-bright); color: #eee;
    padding: 0.7rem 0.85rem; border-radius: 5px; font-family: inherit; font-size: 1rem;
  }
  .field input:focus { outline: none; border-color: var(--green); }
  .field input::placeholder { color: #555; }

  .npub {
    font-size: 0.78rem; color: var(--green); word-break: break-all; user-select: all;
    background: #050505; border: 1px solid var(--border); border-radius: 5px; padding: 0.7rem 0.8rem; margin: 0 0 0.4rem;
  }

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

  .btn {
    font-family: inherit; font-size: 0.92rem; font-weight: 500; padding: 0.65rem 1.4rem;
    border-radius: 5px; cursor: pointer; border: 1px solid transparent; transition: all 0.15s;
  }
  .btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .btn.primary { background: var(--green); color: #050505; border-color: var(--green); font-weight: 600; }
  .btn.primary:hover:not(:disabled) { background: #00ff88; box-shadow: var(--green-glow); }
  .btn.ghost { background: transparent; color: var(--text-dim); border-color: var(--border-bright); }
  .btn.ghost:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); }

  @media (max-width: 640px) {
    .fi { padding: 1.2rem; }
    .fi-actions { flex-direction: column-reverse; }
    .fi-actions .btn { width: 100%; }
  }
</style>

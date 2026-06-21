<script lang="ts">
  // The guided "give your signer its first identity" flow. Shown on Home when a
  // device is connected over USB but has no master provisioned yet — the gap a
  // brand-new device falls into right after flashing. Walks a newcomer from
  // "you need an identity" to a created master, generating a fresh recovery
  // phrase for them. Power users with an existing key take the "I already have
  // one" door to Advanced › Provision. Crypto lives in provision.ts; the step
  // machine + name validation in first-identity.ts. This holds the reactive UI.
  import { device, serialTransport, refreshMasters, connectRelay } from '../lib/device.svelte.js'
  import { FrameType } from '../lib/frame.js'
  import {
    generateMnemonic, deriveFromMnemonic, buildProvisionFrame, zeroize,
  } from '../lib/provision.js'
  import { rememberDevice } from '../lib/known-devices.js'
  import {
    type IdentityStep, nameOk, nameError, provisionLabel, friendlyLabel, phraseWords,
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
  let mnemonic = $state('')
  let name = $state('')
  let saved = $state(false) // owner confirmed they wrote the phrase down
  let copied = $state(false)
  let npubPreview = $state('')
  let status = $state<'idle' | 'deriving' | 'sending' | 'error'>('idle')
  let error = $state('')

  // The just-flashed wifi device's relays, if any — drives the handoff at the end.
  let handoff = $state<{ hex: string; relays: string[] } | null>(null)
  let handoffConnecting = $state(false)
  let handoffError = $state('')

  let pendingSecret: Uint8Array | null = null

  const words = $derived(phraseWords(mnemonic))

  function createFresh() {
    mnemonic = generateMnemonic(128) // 12 words
    name = ''
    saved = false
    error = ''
    step = 'backup'
  }

  async function copyPhrase() {
    try {
      await navigator.clipboard.writeText(mnemonic)
      copied = true
      setTimeout(() => (copied = false), 1600)
    } catch { /* clipboard blocked — they can still read the words */ }
  }

  async function toConfirm() {
    if (!saved || !nameOk(name)) return
    status = 'deriving'
    error = ''
    try {
      const result = await deriveFromMnemonic(mnemonic, '')
      npubPreview = result.npub
      pendingSecret = result.secret
      status = 'idle'
      step = 'confirm'
    } catch (e) {
      status = 'error'
      error = e instanceof Error ? e.message : 'Could not derive the identity.'
    }
  }

  /** Remember this device + decide whether a WiFi handoff applies. */
  function rememberProvisioned() {
    try {
      const decoded = nip19.decode(npubPreview)
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

  async function createIdentity() {
    if (!pendingSecret) return
    status = 'sending'
    error = ''
    try {
      const frame = buildProvisionFrame(pendingSecret, provisionLabel(name), 'tree-mnemonic')
      const resp = await serialTransport.sendAndReceive(frame, [FrameType.ACK, FrameType.NACK], 30_000)
      if (resp.type !== FrameType.ACK) {
        status = 'error'
        error = 'The device did not accept the identity (CRC error or storage write failure). Try again.'
        return
      }
      rememberProvisioned()
      // The device may already be rebooting into wifi (USB dropped); refresh is
      // best-effort — the handoff below is how a wifi signer is reached next.
      try { await refreshMasters() } catch { /* expected if USB just dropped */ }
      status = 'idle'
      step = 'done'
      ondone?.()
    } catch (e) {
      status = 'error'
      error = e instanceof Error ? e.message : 'Could not write the identity to the device.'
    } finally {
      if (pendingSecret) { zeroize(pendingSecret); pendingSecret = null }
      mnemonic = '' // the phrase has done its job; don't keep it in memory
    }
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
      Your device is connected but doesn't have an identity yet. Creating one makes a
      <strong>recovery phrase</strong> — the master key every account on this signer is built from.
      Do this once; afterwards you connect apps and manage it from your phone.
    </p>
    <div class="fi-actions">
      <button class="btn primary" onclick={createFresh}>Create a fresh identity →</button>
      <button class="btn ghost" onclick={() => onadvanced?.()}>I already have a recovery phrase or key</button>
    </div>

  {:else if step === 'backup'}
    <h2 class="fi-title">Write down your recovery phrase</h2>
    <p class="fi-lede">
      These {words.length} words are the only way to recover this signer. Write them on paper in order
      and keep them somewhere safe. <strong>Anyone who has them controls your signer.</strong>
    </p>
    <ol class="phrase" aria-label="recovery phrase">
      {#each words as w, i (i)}
        <li><span class="w-num">{i + 1}</span><span class="w-word">{w}</span></li>
      {/each}
    </ol>
    <button class="btn copy" class:copied onclick={copyPhrase}>
      {copied ? 'Copied ✓' : 'Copy phrase'}
    </button>
    <p class="fi-warn">
      Don't store this in a screenshot, email, or cloud note where it could leak. Paper is safest.
    </p>

    <label class="confirm-save">
      <input type="checkbox" bind:checked={saved} />
      <span>I've written these {words.length} words down somewhere safe.</span>
    </label>

    <label class="field">
      <span>Name this signer (optional)</span>
      <input type="text" bind:value={name} placeholder="e.g. My signer" maxlength="32" />
    </label>
    {#if nameError(name)}<p class="fi-error">{nameError(name)}</p>{/if}

    <div class="fi-actions">
      <button class="btn ghost" onclick={() => (step = 'intro')}>Back</button>
      <button class="btn primary" disabled={!saved || !nameOk(name) || status === 'deriving'} onclick={toConfirm}>
        {status === 'deriving' ? 'Working…' : 'Continue'}
      </button>
    </div>

  {:else if step === 'confirm'}
    <h2 class="fi-title">Create this identity?</h2>
    <p class="fi-lede">
      This writes the identity to your device over the USB cable. Its public address — safe to share —
      will be:
    </p>
    <p class="npub">{npubPreview}</p>
    {#if error}<p class="fi-error">{error}</p>{/if}
    <div class="fi-actions">
      <button class="btn ghost" onclick={() => (step = 'backup')} disabled={status === 'sending'}>Back</button>
      <button class="btn primary" onclick={createIdentity} disabled={status === 'sending'}>
        {status === 'sending' ? 'Creating…' : 'Create identity'}
      </button>
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

  .phrase {
    list-style: none; padding: 0; margin: 0 0 0.9rem;
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem;
  }
  .phrase li {
    display: flex; align-items: baseline; gap: 0.45rem;
    background: var(--surface); border: 1px solid var(--border-bright); border-radius: 5px;
    padding: 0.5rem 0.6rem;
  }
  .w-num { font-size: 0.7rem; color: var(--text-muted); min-width: 1.1rem; text-align: right; }
  .w-word { font-size: 0.92rem; color: #fff; font-weight: 600; word-break: break-all; }

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

  .btn {
    font-family: inherit; font-size: 0.92rem; font-weight: 500; padding: 0.65rem 1.4rem;
    border-radius: 5px; cursor: pointer; border: 1px solid transparent; transition: all 0.15s;
  }
  .btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .btn.primary { background: var(--green); color: #050505; border-color: var(--green); font-weight: 600; }
  .btn.primary:hover:not(:disabled) { background: #00ff88; box-shadow: var(--green-glow); }
  .btn.ghost { background: transparent; color: var(--text-dim); border-color: var(--border-bright); }
  .btn.ghost:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); }
  .btn.copy {
    background: var(--surface); border: 1px solid var(--border-bright); color: var(--text);
    padding: 0.5rem 1.1rem; font-size: 0.85rem;
  }
  .btn.copy:hover { background: var(--surface-hover); }
  .btn.copy.copied { border-color: var(--green-dim); color: var(--green); }

  @media (max-width: 640px) {
    .fi { padding: 1.2rem; }
    .phrase { grid-template-columns: repeat(2, 1fr); }
    .fi-actions { flex-direction: column-reverse; }
    .fi-actions .btn { width: 100%; }
  }
</style>

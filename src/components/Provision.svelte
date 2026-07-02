<script lang="ts">
  import { device, serialTransport, refreshMasters, connectRelay } from '../lib/device.svelte.js'
  import { FrameType } from '../lib/frame.js'
  import {
    deriveFromMnemonic,
    deriveFromNsec,
    useRawNsec,
    decodeNsec,
    buildProvisionFrame,
    zeroize,
    type ProvisionMode,
  } from '../lib/provision.js'
  import { rememberDevice } from '../lib/known-devices.js'
  import { nip19 } from 'nostr-tools'
  import PasswordReveal from './PasswordReveal.svelte'

  // The just-provisioned wifi device, if any — drives the "Manage over WiFi"
  // handoff. Only set when this device was flashed in wifi mode (lastRelays present).
  let handoff = $state<{ hex: string; relays: string[] } | null>(null)
  let handoffConnecting = $state(false)
  let handoffError = $state('')

  /** Remember a just-provisioned master so it's connectable over the relay later. */
  function rememberProvisioned(npub: string, deviceLabel: string) {
    try {
      const decoded = nip19.decode(npub)
      if (decoded.type !== 'npub') return
      const hex = decoded.data as string
      let relays: string[] | null = null
      try {
        const saved = JSON.parse(localStorage.getItem('heartwood.lastRelays') ?? '[]')
        if (Array.isArray(saved) && saved.length) relays = saved
      } catch { /* not a wifi flash */ }
      rememberDevice(hex, relays ?? ['wss://relay.trotters.cc'], deviceLabel || undefined)
      // Only offer the WiFi handoff for devices flashed in wifi mode.
      handoff = relays ? { hex, relays } : null
    } catch { /* non-fatal */ }
  }

  async function handleManageWifi() {
    if (!handoff) return
    handoffConnecting = true
    handoffError = ''
    try {
      await connectRelay(handoff.hex, handoff.relays, label)
      // device.mode is now 'relay'; the Masters/Clients tabs work over the relay.
    } catch (e) {
      handoffError = e instanceof Error ? e.message : 'Could not reach the device yet — give it ~10s to reboot and join wifi, then retry.'
    } finally {
      handoffConnecting = false
    }
  }

  let mode = $state<ProvisionMode>('tree-mnemonic')
  let label = $state('default')
  let secret = $state('')
  let passphrase = $state('')
  let showPassphrase = $state(false)
  let showSecret = $state(false)

  // Plain-English explanation of each style, including the one thing that trips
  // people up: whether the device keeps your existing npub or gets a new one.
  const MODE_INFO: Record<ProvisionMode, { title: string; body: string; address: string; addressKind: 'same' | 'new' }> = {
    'tree-mnemonic': {
      title: 'Recovery phrase (12 or 24 words)',
      body: 'Build the signer from a BIP-39 recovery phrase. The device makes a tree of keys from it, so one phrase can run several named accounts. Generate a fresh phrase on the Home setup flow, or paste an existing one here. An optional passphrase adds a secret 25th word.',
      address: 'A new address, derived from the phrase.',
      addressKind: 'new',
    },
    'bunker': {
      title: 'Existing nsec — sign as-is',
      body: 'Use an nsec you already have directly. The device signs AS that exact identity — no derivation. Pick this if you want this signer to BE your existing key.',
      address: 'The SAME npub as your nsec.',
      addressKind: 'same',
    },
    'tree-nsec': {
      title: 'Existing nsec — derive a new key',
      body: 'Bring an nsec you already have, but the device derives a brand-new master key from it (a tree root). You get the multi-account tree from a secret you already hold.',
      address: 'A NEW, different address — not your nsec’s npub.',
      addressKind: 'new',
    },
  }
  const modeInfo = $derived(MODE_INFO[mode])
  let status = $state<'idle' | 'deriving' | 'confirming' | 'sending' | 'done' | 'error'>('idle')
  let message = $state('')
  let npubPreview = $state('')

  async function handleDerive() {
    status = 'deriving'
    message = ''
    npubPreview = ''

    try {
      let result
      if (mode === 'tree-mnemonic') {
        result = await deriveFromMnemonic(secret, passphrase)
      } else if (mode === 'tree-nsec') {
        const nsecBytes = decodeNsec(secret)
        result = deriveFromNsec(nsecBytes)
      } else {
        const nsecBytes = decodeNsec(secret)
        result = useRawNsec(nsecBytes)
      }

      npubPreview = result.npub
      status = 'confirming'
      message = `Derived pubkey: ${result.npub}`

      // Store the secret temporarily for the send step.
      // It gets zeroized after sending or on cancel.
      pendingSecret = result.secret
    } catch (e) {
      status = 'error'
      message = e instanceof Error ? e.message : 'Derivation failed'
    }
  }

  let pendingSecret: Uint8Array | null = null

  async function handleSend() {
    if (!pendingSecret) return

    status = 'sending'
    message = 'Sending to device...'

    try {
      const frame = buildProvisionFrame(pendingSecret, label, mode)
      const resp = await serialTransport.sendAndReceive(
        frame,
        [FrameType.ACK, FrameType.NACK],
        30_000,
      )

      if (resp.type === FrameType.ACK) {
        status = 'done'
        message = `Identity '${label}' added to the signer.`
        // Remember this device so it can be managed over the relay once it
        // boots into wifi-standalone mode (Connect WiFi in the top bar).
        rememberProvisioned(npubPreview, label)
        await refreshMasters()
      } else {
        status = 'error'
        message = 'Device rejected the provision (CRC error or NVS write failure).'
      }
    } catch (e) {
      status = 'error'
      message = e instanceof Error ? e.message : 'Provision failed'
    } finally {
      zeroize(pendingSecret!)
      pendingSecret = null
      secret = ''
      passphrase = ''
    }
  }

  function handleCancel() {
    if (pendingSecret) {
      zeroize(pendingSecret)
      pendingSecret = null
    }
    status = 'idle'
    message = ''
    npubPreview = ''
    secret = ''
    passphrase = ''
    handoff = null
    handoffError = ''
  }
</script>

<div class="provision">
  {#if status === 'done'}
    <!-- Checked before the USB guard: the device may have already rebooted into
         wifi mode (USB dropped), but the operator still needs this result + handoff. -->
    <p class="success-text">{message}</p>
    {#if npubPreview}
      <div class="field provisioned-npub">
        <span class="field-label">Device identity</span>
        <div class="uri-box"><code class="mono">{npubPreview}</code></div>
      </div>
    {/if}
    {#if handoff}
      <div class="card card--live handoff">
        <p class="handoff-hint">
          This is now a wifi signer — it manages over the relay, not USB. Give it ~10s to reboot
          and join wifi, then:
        </p>
        {#if device.mode === 'relay'}
          <p class="success-text handoff-ok">Connected over WiFi — open the Identity or Apps tab.</p>
        {:else}
          <button class="btn btn-primary manage-wifi" onclick={handleManageWifi} disabled={handoffConnecting}>
            {handoffConnecting ? 'Connecting…' : 'Manage over WiFi'}
          </button>
        {/if}
        {#if handoffError}<p class="error-text handoff-error">{handoffError}</p>{/if}
      </div>
    {/if}
    <button class="btn btn-secondary" onclick={handleCancel}>Add another</button>
  {:else if device.mode !== 'serial'}
    <div class="card card--warn usb-gate">
      <p class="usb-gate-lead">🔌 Plug in a USB cable to set up this device.</p>
      <p class="usb-gate-why">
        Setting up creates the device's <strong>master key</strong> — the one secret that
        every identity on it is built from. Think of it as the master key to a whole building:
        if it ever gets out, every door is open and you can't change the locks.
      </p>
      <p class="usb-gate-why">
        Because it matters that much, we only ever hand it over down a <strong>cable you can
        see and hold</strong> — never over WiFi or the internet, where it would pass through
        routers and computers you don't control. Once the device is set up, everything else
        (adding apps, approving, revoking) <em>can</em> be done over WiFi — just not this.
      </p>
      <p class="usb-gate-todo">→ Connect the device to this computer with a USB cable, then come back to this tab.</p>
    </div>
  {:else if status === 'confirming'}
    <div class="confirm">
      <p class="info">
        {#if mode === 'bunker'}
          This should be the <strong>same npub</strong> as the nsec you entered — check it matches before sending:
        {:else}
          This is the <strong>new address</strong> your signer will have — check it before sending:
        {/if}
      </p>
      <div class="uri-box confirm-npub"><code class="mono">{npubPreview}</code></div>
      <div class="actions">
        <button class="btn btn-primary" onclick={handleSend}>Send to device</button>
        <button class="btn-ghost" onclick={handleCancel}>Cancel</button>
      </div>
    </div>
  {:else}
    <div class="form">
      <label class="field">
        <span class="field-label">How do you want to set up this signer?</span>
        <select class="field-input" bind:value={mode} disabled={status !== 'idle'}>
          <option value="tree-mnemonic">Recovery phrase (12/24 words)</option>
          <option value="bunker">Existing nsec — sign as-is (keeps your npub)</option>
          <option value="tree-nsec">Existing nsec — derive a new key (new npub)</option>
        </select>
      </label>

      <div class="mode-info" class:same={modeInfo.addressKind === 'same'}>
        <p class="mode-info-body">{modeInfo.body}</p>
        <p class="mode-info-addr">
          <span class="addr-chip">{modeInfo.addressKind === 'same' ? 'Same npub' : 'New npub'}</span>
          {modeInfo.address}
        </p>
      </div>

      <label class="field">
        <span class="field-label">Label</span>
        <input class="field-input" type="text" bind:value={label} placeholder="default" maxlength="32" disabled={status !== 'idle'} />
      </label>

      {#if mode === 'tree-mnemonic'}
        <label class="field">
          <span class="field-label">Mnemonic</span>
          <textarea
            class="field-input"
            bind:value={secret}
            placeholder="12 or 24 words"
            rows="3"
            disabled={status !== 'idle'}
            autocomplete="off"
            spellcheck="false"
          ></textarea>
        </label>
        <label class="field">
          <span class="field-label">Passphrase</span>
          <div class="pw-wrap">
            <input type={showPassphrase ? 'text' : 'password'} class="field-input" bind:value={passphrase} placeholder="Optional" disabled={status !== 'idle'} />
            <PasswordReveal bind:shown={showPassphrase} disabled={status !== 'idle'} />
          </div>
        </label>
      {:else}
        <label class="field">
          <span class="field-label">{mode === 'tree-nsec' ? 'nsec (tree derivation)' : 'nsec (raw, no derivation)'}</span>
          <div class="pw-wrap">
            <input
              type={showSecret ? 'text' : 'password'}
              class="field-input"
              bind:value={secret}
              placeholder="nsec1..."
              disabled={status !== 'idle'}
              autocomplete="off"
            />
            <PasswordReveal bind:shown={showSecret} disabled={status !== 'idle'} />
          </div>
        </label>
      {/if}

      <button
        class="btn btn-primary derive"
        disabled={!device.connected || device.mode !== 'serial' || status === 'deriving' || !secret.trim()}
        onclick={handleDerive}
      >
        {status === 'deriving' ? 'Deriving...' : 'Derive and Preview'}
      </button>
    </div>

    {#if status === 'error'}
      <p class="error-text">{message}</p>
    {/if}
  {/if}

  <p class="security-note">
    The secret is derived in your browser and sent directly to the device over USB. It is never stored, never logged, and never sent over the network.
  </p>
</div>

<style>
  .form { display: flex; flex-direction: column; gap: 0.75rem; }
  .derive { align-self: flex-start; margin-top: 0.25rem; }

  .confirm { margin: 1rem 0; }
  .confirm-npub { margin: 0.5rem 0; }
  .actions { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.75rem; }

  .info { font-size: 0.8rem; color: var(--text-dim); margin: 0; }
  .info strong { color: var(--text); }

  .mode-info {
    border: 1px solid #243; border-left: 3px solid #4a9; border-radius: 4px;
    padding: 0.6rem 0.8rem; background: #08120e; margin: -0.25rem 0 0.25rem;
  }
  .mode-info.same { border-left-color: var(--green); }
  .mode-info-body { font-size: 0.78rem; color: var(--text-dim); line-height: 1.5; margin: 0 0 0.5rem; }
  .mode-info-addr { font-size: 0.78rem; color: var(--text-dim); margin: 0; display: flex; align-items: center; gap: 0.45rem; }
  .addr-chip {
    font-size: 0.62rem; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600;
    color: #cba24a; border: 1px solid #5a4a20; border-radius: 3px; padding: 0.1rem 0.4rem; flex-shrink: 0;
  }
  .mode-info.same .addr-chip { color: var(--green); border-color: var(--green-dim); }

  .usb-gate-lead { font-size: 0.9rem; color: var(--amber); font-weight: 600; margin: 0 0 0.7rem; }
  .usb-gate-why { font-size: 0.8rem; color: var(--text-dim); line-height: 1.55; margin: 0 0 0.6rem; }
  .usb-gate-why strong { color: var(--amber); font-weight: 600; }
  .usb-gate-why em { color: var(--green-dim); font-style: normal; }
  .usb-gate-todo { font-size: 0.8rem; color: var(--green-dim); line-height: 1.45; margin: 0.4rem 0 0; }

  .security-note { font-size: 0.7rem; color: var(--text-muted); margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 0.75rem; }

  .provisioned-npub { margin: 0.75rem 0; }
  .handoff { margin: 0.75rem 0; }
  .handoff-hint { font-size: 0.78rem; color: var(--text-dim); margin: 0 0 0.6rem; line-height: 1.4; }
  .handoff-ok { margin: 0; }
  .handoff-error { margin: 0.5rem 0 0; }
  .manage-wifi { margin-top: 0.25rem; }
</style>

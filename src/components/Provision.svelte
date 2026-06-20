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
        message = `Master '${label}' provisioned.`
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
  <h2>Provision Master</h2>

  {#if status === 'done'}
    <!-- Checked before the USB guard: the device may have already rebooted into
         wifi mode (USB dropped), but the operator still needs this result + handoff. -->
    <p class="success">{message}</p>
    {#if npubPreview}
      <div class="provisioned-npub">
        <span class="np-label">Device identity</span>
        <code class="np-value">{npubPreview}</code>
      </div>
    {/if}
    {#if handoff}
      <div class="handoff">
        <p class="handoff-hint">
          This is now a wifi signer — it manages over the relay, not USB. Give it ~10s to reboot
          and join wifi, then:
        </p>
        {#if device.mode === 'relay'}
          <p class="handoff-ok">✓ Connected over WiFi — open the Masters or Clients tab.</p>
        {:else}
          <button class="btn manage-wifi" onclick={handleManageWifi} disabled={handoffConnecting}>
            {handoffConnecting ? 'Connecting…' : 'Manage over WiFi'}
          </button>
        {/if}
        {#if handoffError}<p class="handoff-error">{handoffError}</p>{/if}
      </div>
    {/if}
    <button class="btn" onclick={handleCancel}>Provision Another</button>
  {:else if device.mode !== 'serial'}
    <p class="warning">Provisioning requires a direct USB connection. Secrets never travel over the network.</p>
  {:else if status === 'confirming'}
    <div class="confirm">
      <p class="info">Confirm this is the correct pubkey:</p>
      <p class="npub">{npubPreview}</p>
      <div class="actions">
        <button class="btn send" onclick={handleSend}>Send to Device</button>
        <button class="btn cancel" onclick={handleCancel}>Cancel</button>
      </div>
    </div>
  {:else}
    <div class="form">
      <label class="field">
        <span>Mode</span>
        <select bind:value={mode} disabled={status !== 'idle'}>
          <option value="tree-mnemonic">Tree (mnemonic)</option>
          <option value="tree-nsec">Tree (nsec)</option>
          <option value="bunker">Bunker (raw nsec)</option>
        </select>
      </label>

      <label class="field">
        <span>Label</span>
        <input type="text" bind:value={label} placeholder="default" maxlength="32" disabled={status !== 'idle'} />
      </label>

      {#if mode === 'tree-mnemonic'}
        <label class="field">
          <span>Mnemonic</span>
          <textarea
            bind:value={secret}
            placeholder="12 or 24 words"
            rows="3"
            disabled={status !== 'idle'}
            autocomplete="off"
            spellcheck="false"
          ></textarea>
        </label>
        <label class="field">
          <span>Passphrase</span>
          <input type="password" bind:value={passphrase} placeholder="Optional" disabled={status !== 'idle'} />
        </label>
      {:else}
        <label class="field">
          <span>{mode === 'tree-nsec' ? 'nsec (tree derivation)' : 'nsec (raw, no derivation)'}</span>
          <input
            type="password"
            bind:value={secret}
            placeholder="nsec1..."
            disabled={status !== 'idle'}
            autocomplete="off"
          />
        </label>
      {/if}

      <button
        class="btn derive"
        disabled={!device.connected || device.mode !== 'serial' || status === 'deriving' || !secret.trim()}
        onclick={handleDerive}
      >
        {status === 'deriving' ? 'Deriving...' : 'Derive and Preview'}
      </button>
    </div>

    {#if status === 'error'}
      <p class="error">{message}</p>
    {/if}
  {/if}

  <p class="security-note">
    The secret is derived in your browser and sent directly to the device over USB. It is never stored, never logged, and never sent over the network.
  </p>
</div>

<style>
  h2 { font-size: 1rem; font-weight: 600; margin: 0 0 1rem; color: #ccc; }

  .form { display: flex; flex-direction: column; gap: 0.75rem; }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .field span {
    font-size: 0.75rem;
    color: #666;
  }

  .field select, .field input, .field textarea {
    background: #0a0a0a;
    border: 1px solid #333;
    color: #ccc;
    padding: 0.35rem 0.5rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.8rem;
    resize: vertical;
  }

  .field select { cursor: pointer; }
  .field input:disabled, .field textarea:disabled, .field select:disabled { opacity: 0.4; }
  .field input::placeholder, .field textarea::placeholder { color: #444; }

  .btn {
    background: #1a1a1a;
    border: 1px solid #333;
    color: #ccc;
    padding: 0.4rem 1rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .btn:hover:not(:disabled) { background: #222; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.derive { border-color: #4a9; color: #4a9; align-self: flex-start; margin-top: 0.25rem; }
  .btn.send { border-color: #4a9; color: #4a9; }
  .btn.cancel { color: #666; }

  .confirm { margin: 1rem 0; }
  .npub { font-size: 0.7rem; color: #4a9; word-break: break-all; margin: 0.5rem 0; background: #111; padding: 0.5rem; border-radius: 3px; }
  .actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; }

  .info { font-size: 0.8rem; color: #888; margin: 0; }
  .warning { font-size: 0.8rem; color: #a93; }
  .error { font-size: 0.8rem; color: #a44; margin-top: 0.5rem; }
  .success { font-size: 0.85rem; color: #4a9; }
  .security-note { font-size: 0.7rem; color: #444; margin-top: 1.5rem; border-top: 1px solid #1a1a1a; padding-top: 0.75rem; }

  .provisioned-npub { display: flex; flex-direction: column; gap: 0.25rem; margin: 0.75rem 0; }
  .np-label { font-size: 0.7rem; color: #666; letter-spacing: 0.08em; text-transform: uppercase; }
  .np-value { font-size: 0.72rem; color: #4a9; word-break: break-all; background: #111; padding: 0.5rem; border-radius: 3px; user-select: all; }
  .handoff { border: 1px solid #1c3a2a; border-radius: 4px; padding: 0.75rem 1rem; margin: 0.75rem 0; background: #06120e; }
  .handoff-hint { font-size: 0.78rem; color: #9a9; margin: 0 0 0.6rem; line-height: 1.4; }
  .handoff-ok { font-size: 0.82rem; color: #4a9; margin: 0; }
  .handoff-error { font-size: 0.75rem; color: #a93; margin: 0.5rem 0 0; line-height: 1.4; }
  .manage-wifi { border-color: #4a9; color: #4a9; }
</style>

<script lang="ts">
  import { device, serialTransport, refreshMasters, serialDeriveIdentity, relayDeriveIdentity, relayProvisionIdentity } from '../lib/device.svelte.js'
  import { FrameType } from '../lib/frame.js'
  import {
    deriveFromMnemonic,
    deriveNamedFromMnemonic,
    deriveNamedFromNsec,
    deriveFromNsec,
    useRawNsec,
    decodeNsec,
    buildProvisionFrame,
    nameDeriveError,
    zeroize,
    type ProvisionMode,
  } from '../lib/provision.js'
  import { isKeyBackupCandidate, keyToWords, wordsToKey, decryptNcryptsec } from '../lib/restore.js'
  import { rememberDevice } from '../lib/known-devices.js'
  import { nip19 } from 'nostr-tools'
  import PasswordReveal from './PasswordReveal.svelte'

  // The just-provisioned wifi device, if any — only set when this device was
  // flashed in wifi mode (lastRelays present); drives the network-reachable note.
  let handoff = $state<{ hex: string; relays: string[] } | null>(null)

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

  // Over the relay the recommended path is the on-signer derive (no secret in
  // the browser), so it opens on that mode with an empty name. All other modes
  // work remotely too: the secret travels NIP-44 encrypted end-to-end.
  let mode = $state<ProvisionMode>(device.mode === 'relay' ? 'named-child' : 'tree-mnemonic')
  let label = $state(device.mode === 'relay' ? '' : 'default')
  let secret = $state('')
  let passphrase = $state('')
  let ncryptPassword = $state('')
  let showPassphrase = $state(false)
  let showSecret = $state(false)
  const isNcryptsec = $derived(secret.trim().startsWith('ncryptsec1'))

  // Named-identity source. The signer already holds the master's tree root, so
  // by default IT derives the child (frame 0x60 over USB, mgmt derive_identity
  // over the relay — no key material crosses the wire either way). The
  // phrase/nsec path stays for older firmware and off-signer roots.
  let deriveSource = $state<'signer' | 'secret'>('signer')
  let parentSlot = $state(0)
  // Any master can be the parent: over the relay the request is simply
  // addressed to the chosen master's own pubkey.
  const signerParents = $derived(device.masters.filter((m) => !m.persona))
  const canDeriveOnSigner = $derived(
    (device.mode === 'serial' || device.mode === 'relay') && signerParents.length > 0)
  const overRelay = $derived(device.mode === 'relay')
  const onSigner = $derived(mode === 'named-child'
    && deriveSource === 'signer' && canDeriveOnSigner)
  $effect(() => {
    if (canDeriveOnSigner && !signerParents.some((m) => m.slot === parentSlot)) {
      parentSlot = signerParents[0]!.slot
    }
  })

  /** Ask the signer to derive label as a named child of the chosen master. */
  async function handleDeriveOnSigner() {
    status = 'deriving'
    message = ''
    npubPreview = ''
    try {
      label = label.trim()
      let res
      if (device.mode === 'relay') {
        // Address the chosen parent directly: the firmware derives from
        // whichever of its identities the request is addressed to.
        const parent = signerParents.find((m) => m.slot === parentSlot)
        let parentHex: string | undefined
        try {
          const decoded = parent ? nip19.decode(parent.npub) : null
          if (decoded?.type === 'npub') parentHex = decoded.data as string
        } catch { /* fall back to the session's primary identity */ }
        res = await relayDeriveIdentity(label, parentHex)
      } else {
        res = await serialDeriveIdentity(parentSlot, label)
      }
      npubPreview = res.npub
      status = 'done'
      message = res.existing
        ? `“${res.label}” was already on this signer (slot ${res.slot}).`
        : device.mode === 'relay'
          ? `Identity '${res.label}' derived on the signer. It restarts briefly to start serving it; reconnect from the front page in a few seconds.`
          : `Identity '${res.label}' derived on the signer.`
      rememberProvisioned(res.npub, res.label)
    } catch (e) {
      status = 'error'
      message = e instanceof Error ? e.message : 'Derivation failed'
    }
  }

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
      body: 'Use an nsec you already have directly. The device signs AS that exact identity: no derivation. Pick this if you want this signer to BE your existing key. A 24-word key backup made by Sapwood pastes here too.',
      address: 'The SAME npub as your nsec.',
      addressKind: 'same',
    },
    'tree-nsec': {
      title: 'Existing nsec — derive a new key',
      body: 'Bring an nsec you already have, but the device derives a brand-new master key from it (a tree root). You get the multi-account tree from a secret you already hold.',
      address: 'A NEW, different address, not your nsec’s npub.',
      addressKind: 'new',
    },
    'named-child': {
      title: 'Named identity from your master',
      body: 'Derive a member of your identity tree by name (for example work, social, or a project name). The name picks a branch of the tree: the same master and name always recreate the same identity, here or with the nsec-tree tools. Names are case-sensitive.',
      address: 'A new address, derived from your master and the name.',
      addressKind: 'new',
    },
  }
  const modeInfo = $derived(MODE_INFO[mode])
  let status = $state<'idle' | 'deriving' | 'confirming' | 'sending' | 'done' | 'error'>('idle')
  let message = $state('')
  let npubPreview = $state('')

  /** Decode an nsec1… or password-protected ncryptsec1… input to key bytes. */
  function nsecOrNcryptBytes(trimmed: string): Uint8Array {
    if (trimmed.startsWith('ncryptsec1')) {
      if (!ncryptPassword.trim()) throw new Error('Enter the password for this encrypted key.')
      return decryptNcryptsec(trimmed, ncryptPassword)
    }
    return decodeNsec(trimmed)
  }

  async function handleDerive() {
    status = 'deriving'
    message = ''
    npubPreview = ''

    try {
      let result
      if (mode === 'tree-mnemonic') {
        result = await deriveFromMnemonic(secret, passphrase)
      } else if (mode === 'named-child') {
        // The label IS the derivation name: one field, one concept. Trim it so
        // the name that derives the key is exactly the label sent to the device.
        label = label.trim()
        const trimmedSecret = secret.trim()
        if (trimmedSecret.startsWith('nsec1') || trimmedSecret.startsWith('ncryptsec1')) {
          // Master made from an nsec (sign-as-is or tree): same root nsec-tree
          // fromNsec() builds, so the named child matches the CLI's. Words are
          // always read as a recovery phrase here; a 24-word key backup must be
          // pasted as its nsec, since valid 24 words are indistinguishable
          // from a real phrase.
          const nsecBytes = nsecOrNcryptBytes(trimmedSecret)
          try {
            result = deriveNamedFromNsec(nsecBytes, label)
          } finally {
            zeroize(nsecBytes)
          }
        } else {
          result = await deriveNamedFromMnemonic(secret, passphrase, label)
        }
      } else {
        // An nsec, an ncryptsec, or the 24 backup words Sapwood writes out.
        const trimmedSecret = secret.trim()
        const nsecBytes = trimmedSecret.startsWith('ncryptsec1')
          ? nsecOrNcryptBytes(trimmedSecret)
          : isKeyBackupCandidate(secret) ? wordsToKey(secret) : decodeNsec(secret)
        try {
          result = mode === 'tree-nsec' ? deriveFromNsec(nsecBytes) : useRawNsec(nsecBytes)
        } finally {
          zeroize(nsecBytes)
        }
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

  // Optional 24-word backup of a pasted nsec, offered while confirming.
  let backupWords = $state('')
  let showBackup = $state(false)

  /** Write the entered nsec/ncryptsec out as 24 words, computed only when asked for. */
  function toggleBackupWords() {
    if (!showBackup && !backupWords) {
      try {
        const bytes = nsecOrNcryptBytes(secret.trim())
        try { backupWords = keyToWords(bytes) } finally { zeroize(bytes) }
      } catch { return }
    }
    showBackup = !showBackup
  }

  async function handleSend() {
    if (!pendingSecret) return

    status = 'sending'
    message = 'Sending to device...'

    try {
      if (device.mode === 'relay') {
        // The secret travels NIP-44 encrypted end-to-end to the signer; the
        // signer restarts shortly after storing to serve the new identity.
        const res = await relayProvisionIdentity(pendingSecret, label, mode)
        status = 'done'
        message = res.existing
          ? `“${res.label}” was already on this signer (slot ${res.slot}).`
          : `Identity '${res.label}' added to the signer. It restarts briefly to start serving it; reconnect from the front page in a few seconds.`
        rememberProvisioned(res.npub, res.label)
      } else {
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
      }
    } catch (e) {
      status = 'error'
      message = e instanceof Error ? e.message : 'Provision failed'
    } finally {
      zeroize(pendingSecret!)
      pendingSecret = null
      secret = ''
      passphrase = ''
      ncryptPassword = ''
      backupWords = ''
      showBackup = false
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
    ncryptPassword = ''
    backupWords = ''
    showBackup = false
    handoff = null
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
      <!-- No "hop to WiFi" ceremony: current firmware answers the cable in every
           mode, and the front page's one-tap connect now remembers this signer. -->
      <p class="hint handoff-hint">
        This signer is on your network. Keep managing it here over the cable, or from any
        browser via <strong>Connect to “{label}”</strong> on the front page.
      </p>
    {/if}
    {#if mode === 'named-child'}
      <p class="hint">
        To connect an app to this identity, open <strong>Apps</strong>, pick “{label}” in the
        identity selector, and create the connection there.
      </p>
    {/if}
    <button class="btn btn-secondary" onclick={handleCancel}>Add another</button>
  {:else if device.mode !== 'serial' && device.mode !== 'relay'}
    <div class="card card--warn usb-gate">
      <p class="usb-gate-lead">🔌 Plug in a USB cable to set up this device.</p>
      <p class="usb-gate-why">
        Setting up creates the device's <strong>master key</strong>: the one secret that
        every identity on it is built from. Think of it as the master key to a whole building:
        if it ever gets out, every door is open and you can't change the locks.
      </p>
      <p class="usb-gate-why">
        Because it matters that much, we only ever hand it over down a <strong>cable you can
        see and hold</strong>, never over WiFi or the internet, where it would pass through
        routers and computers you don't control. Once the device is set up, everything else
        (adding apps, approving, revoking) <em>can</em> be done over WiFi, just not this.
      </p>
      <p class="usb-gate-todo">→ Connect the device to this computer with a USB cable, then come back to this tab.</p>
    </div>
  {:else if status === 'confirming'}
    <div class="confirm">
      <p class="info">
        {#if mode === 'bunker'}
          This should be the <strong>same npub</strong> as the nsec you entered, so check it matches before sending:
        {:else}
          This is the <strong>new address</strong> your signer will have, so check it before sending:
        {/if}
      </p>
      <div class="uri-box confirm-npub"><code class="mono">{npubPreview}</code></div>
      {#if (mode === 'bunker' || mode === 'tree-nsec') && !isKeyBackupCandidate(secret)}
        <div class="backup">
          <button class="backup-toggle" onclick={toggleBackupWords}>
            {showBackup ? 'Hide the backup words' : 'Back up this nsec as 24 words first'}
          </button>
          {#if showBackup}
            <p class="backup-note">
              These 24 words are the nsec itself, unencrypted. Anyone who has them controls the
              identity. To restore, paste them where an nsec goes, or mark them as a key backup
              in the guided flow.
            </p>
            <ol class="backup-words">
              {#each backupWords.split(' ') as word}
                <li>{word}</li>
              {/each}
            </ol>
          {/if}
        </div>
      {/if}
      <div class="actions">
        <button class="btn btn-primary" onclick={handleSend}>Send to device</button>
        <button class="btn-ghost" onclick={handleCancel}>Cancel</button>
      </div>
    </div>
  {:else}
    <div class="form">
      <label class="field">
        <span class="field-label">How do you want to set up this signer?</span>
        <select
          class="field-input"
          bind:value={mode}
          disabled={status === 'deriving' || status === 'sending'}
          onchange={() => { if (mode === 'named-child' && label === 'default') label = '' }}
        >
          <option value="tree-mnemonic">Recovery phrase (12/24 words)</option>
          <option value="named-child">Name: derive a named identity from your master</option>
          <option value="bunker">Existing nsec: sign as-is (keeps your npub)</option>
          <option value="tree-nsec">Existing nsec: derive a new key (new npub)</option>
        </select>
        {#if overRelay}
          <span class="hint-sm name-hint">Over WiFi, deriving by name needs no secret at all: the signer already holds your master. The other styles send the secret to the signer encrypted end-to-end (NIP-44); relays only ever carry ciphertext.</span>
        {/if}
      </label>

      <div class="mode-info" class:same={modeInfo.addressKind === 'same'}>
        <p class="mode-info-body">{modeInfo.body}</p>
        <p class="mode-info-addr">
          <span class="addr-chip">{modeInfo.addressKind === 'same' ? 'Same npub' : 'New npub'}</span>
          {modeInfo.address}
        </p>
      </div>

      {#if mode === 'named-child' && canDeriveOnSigner}
        <div class="source-toggle" role="radiogroup" aria-label="Where to derive">
          <button
            class="source-opt"
            class:on={deriveSource === 'signer'}
            onclick={() => (deriveSource = 'signer')}
            disabled={status === 'deriving'}
          >
            <span class="source-title">On this signer</span>
            <span class="source-desc">The signer holds the master, so it derives the child itself. No secret is entered.</span>
          </button>
          <button
            class="source-opt"
            class:on={deriveSource === 'secret'}
            onclick={() => (deriveSource = 'secret')}
            disabled={status === 'deriving'}
          >
            <span class="source-title">From a phrase or nsec</span>
            <span class="source-desc">Derive in the browser from the master secret, then send the child to the signer.</span>
          </button>
        </div>
      {/if}

      {#if onSigner && signerParents.length > 1}
        <label class="field">
          <span class="field-label">Derive from</span>
          <select class="field-input" bind:value={parentSlot} disabled={status === 'deriving'}>
            {#each signerParents as parent (parent.npub)}
              <option value={parent.slot}>{parent.label ?? `slot ${parent.slot}`}</option>
            {/each}
          </select>
        </label>
      {/if}

      <label class="field">
        <span class="field-label">{mode === 'named-child' ? 'Name' : 'Label'}</span>
        <input
          class="field-input"
          type="text"
          bind:value={label}
          placeholder={mode === 'named-child' ? 'e.g. work, social, pallasite' : 'default'}
          maxlength="32"
          disabled={status === 'deriving' || status === 'sending'}
        />
        {#if mode === 'named-child'}
          <span class="hint-sm name-hint">The name selects the derived key. Write it down with your master's backup: both are needed to recreate this identity.</span>
        {/if}
      </label>

      <!-- Secret inputs. NONE render for an on-signer derive: the whole point
           is that the browser never sees a secret, so only the Name applies. -->
      {#if (mode === 'tree-mnemonic' || mode === 'named-child') && !onSigner}
        <label class="field">
          <span class="field-label">{mode === 'named-child' ? 'Recovery phrase, nsec or ncryptsec' : 'Mnemonic'}</span>
          <textarea
            class="field-input"
            bind:value={secret}
            placeholder={mode === 'named-child' ? '12 or 24 words, nsec1… or ncryptsec1…' : '12 or 24 words'}
            rows="3"
            disabled={status === 'deriving' || status === 'sending'}
            autocomplete="off"
            spellcheck="false"
          ></textarea>
        </label>
        {#if isNcryptsec}
          <label class="field">
            <span class="field-label">Password for the encrypted key</span>
            <div class="pw-wrap">
              <input type={showPassphrase ? 'text' : 'password'} class="field-input" bind:value={ncryptPassword} placeholder="ncryptsec password" disabled={status === 'deriving' || status === 'sending'} autocomplete="off" />
              <PasswordReveal bind:shown={showPassphrase} disabled={status === 'deriving' || status === 'sending'} />
            </div>
          </label>
        {:else}
          <label class="field">
            <span class="field-label">{mode === 'named-child' ? 'Passphrase (phrase input only)' : 'Passphrase'}</span>
            <div class="pw-wrap">
              <input type={showPassphrase ? 'text' : 'password'} class="field-input" bind:value={passphrase} placeholder="Optional" disabled={status === 'deriving' || status === 'sending'} />
              <PasswordReveal bind:shown={showPassphrase} disabled={status === 'deriving' || status === 'sending'} />
            </div>
          </label>
        {/if}
      {:else if mode === 'bunker' || mode === 'tree-nsec'}
        <label class="field">
          <span class="field-label">{mode === 'tree-nsec' ? 'nsec (tree derivation)' : 'nsec (raw, no derivation)'}</span>
          <div class="pw-wrap">
            <input
              type={showSecret ? 'text' : 'password'}
              class="field-input"
              bind:value={secret}
              placeholder="nsec1…, ncryptsec1… or a 24-word key backup"
              disabled={status === 'deriving' || status === 'sending'}
              autocomplete="off"
            />
            <PasswordReveal bind:shown={showSecret} disabled={status === 'deriving' || status === 'sending'} />
          </div>
        </label>
        {#if isNcryptsec}
          <label class="field">
            <span class="field-label">Password for the encrypted key</span>
            <div class="pw-wrap">
              <input type={showPassphrase ? 'text' : 'password'} class="field-input" bind:value={ncryptPassword} placeholder="ncryptsec password" disabled={status === 'deriving' || status === 'sending'} autocomplete="off" />
              <PasswordReveal bind:shown={showPassphrase} disabled={status === 'deriving' || status === 'sending'} />
            </div>
          </label>
        {/if}
      {/if}

      {#if onSigner}
        <button
          class="btn btn-primary derive"
          disabled={!device.connected || (device.mode !== 'serial' && device.mode !== 'relay')
            || status === 'deriving' || nameDeriveError(label) !== null}
          onclick={handleDeriveOnSigner}
        >
          {status === 'deriving' ? 'Deriving on signer...' : 'Derive on signer'}
        </button>
      {:else}
        <button
          class="btn btn-primary derive"
          disabled={!device.connected || (device.mode !== 'serial' && device.mode !== 'relay')
            || status === 'deriving' || !secret.trim()
            || (mode === 'named-child' && nameDeriveError(label) !== null)}
          onclick={handleDerive}
        >
          {status === 'deriving' ? 'Deriving...' : 'Derive and Preview'}
        </button>
      {/if}
    </div>

    {#if status === 'error'}
      <p class="error-text">{message}</p>
    {/if}
  {/if}

  <p class="security-note">
    {#if onSigner}
      The identity is derived inside the signer from the master it already holds. No secret enters or leaves this browser.
    {:else if overRelay}
      The secret is derived in your browser and sent to the signer encrypted end-to-end (NIP-44). Relays and every network hop only ever carry ciphertext; nothing is stored or logged.
    {:else}
      The secret is derived in your browser and sent directly to the device over USB. It is never stored, never logged, and never sent over the network.
    {/if}
  </p>
</div>

<style>
  .form { display: flex; flex-direction: column; gap: 0.75rem; }
  .derive { align-self: flex-start; margin-top: 0.25rem; }

  .confirm { margin: 1rem 0; }
  .confirm-npub { margin: 0.5rem 0; }
  .actions { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.75rem; }

  /* Optional 24-word backup of the entered nsec, while confirming */
  .backup { margin: 0.75rem 0 0; }
  .backup-toggle {
    background: none; border: none; padding: 0; cursor: pointer;
    font-family: inherit; font-size: 0.78rem; color: var(--green-dim); text-decoration: underline;
  }
  .backup-toggle:hover { color: var(--green); }
  .backup-note { font-size: 0.75rem; color: var(--text-dim); line-height: 1.5; margin: 0.5rem 0 0; }
  .backup-words {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.2rem 1.4rem;
    margin: 0.6rem 0 0; padding: 0.7rem 0.9rem 0.7rem 2.2rem;
    background: #08120e; border: 1px solid var(--green-dim); border-radius: 6px;
    font-size: 0.82rem; color: var(--text);
  }
  @media (max-width: 640px) {
    .backup-words { grid-template-columns: repeat(2, 1fr); }
  }

  .info { font-size: 0.8rem; color: var(--text-dim); margin: 0; }
  .info strong { color: var(--text); }

  .name-hint { display: block; margin-top: 0.35rem; }

  /* Where a named identity derives: on the signer (default) or in the browser */
  .source-toggle { display: flex; flex-direction: column; gap: 0.5rem; }
  .source-opt {
    display: flex; flex-direction: column; gap: 0.2rem; text-align: left;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 0.7rem 0.9rem; cursor: pointer; font-family: inherit;
    transition: border-color 0.12s, background 0.12s;
  }
  .source-opt:hover { border-color: #444; }
  .source-opt.on { border-color: var(--green-dim); background: #08130d; }
  .source-title { font-size: 0.88rem; font-weight: 600; color: #fff; }
  .source-opt.on .source-title { color: var(--green); }
  .source-desc { font-size: 0.76rem; color: var(--text-dim); line-height: 1.45; }
  @media (max-width: 640px) {
    .source-toggle { flex-direction: column; }
  }

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
  .handoff-hint { margin: 0.75rem 0 1rem; font-size: 0.82rem; }
</style>

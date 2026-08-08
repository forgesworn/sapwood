<script lang="ts">
  // The guided "give your signer its first identity" flow, shown on Home when a
  // device is connected over USB but has no identity yet. Two doors:
  //   Create   — the DEVICE generates its own seed and shows the 12-word phrase
  //              on its OWN screen; the secret never appears in the browser.
  //   Restore  — an existing key. Most private: type the 12 words on the device.
  //              Or paste a phrase / nsec / ncryptsec here; it is derived in the
  //              browser and sent straight to the device over USB (never stored,
  //              never networked), exactly as Advanced › Provision does.
  import { device, connectRelay, generateIdentity, restoreIdentity, provisionSecret, getFirmwareVersion } from '../lib/device.svelte.js'
  import { rememberDevice } from '../lib/known-devices.js'
  import { navigate } from '../lib/route.svelte.js'
  import {
    type IdentityStep, nameOk, nameError, provisionLabel, friendlyLabel,
  } from '../lib/first-identity.js'
  import {
    resolveRestore, isValidNsec, isValidNcryptsec, isValidPhrase,
    isKeyBackupCandidate, keyToWords, decryptNcryptsec,
  } from '../lib/restore.js'
  import { zeroize, decodeNsec, type ProvisionMode } from '../lib/provision.js'
  import PasswordReveal from './PasswordReveal.svelte'
  import { nip19 } from 'nostr-tools'

  interface Props {
    /** Jump to the advanced cockpit (the raw panels, for power users). */
    onadvanced?: () => void
    /** Called once the identity is created (so Home can refresh). */
    ondone?: () => void
  }
  let { onadvanced, ondone }: Props = $props()

  // 'create'         — device makes a fresh seed
  // 'restore-device' — owner re-enters an existing phrase on the device itself
  // 'restore-*'      — owner pastes a phrase / nsec / ncryptsec here (over USB)
  type Mode = 'create' | 'restore-device' | 'restore-phrase' | 'restore-nsec' | 'restore-ncryptsec'
  // The extra steps beyond the on-device flow: pick a restore source, paste the
  // secret, confirm the derived address before it is sent.
  type Step = IdentityStep | 'restore-source' | 'paste' | 'confirm'

  let step = $state<Step>('intro')
  let mode = $state<Mode>('create')
  let name = $state('')
  let saved = $state(false) // owner confirmed they wrote down the on-screen phrase
  let npub = $state('')
  let status = $state<'idle' | 'generating' | 'restoring' | 'deriving' | 'sending' | 'error'>('idle')
  let error = $state('')

  // Paste-restore inputs. Cleared the moment the secret reaches the device.
  let phrase = $state('')
  let passphrase = $state('')
  let showPassphrase = $state(false)
  let nsecInput = $state('')
  let showNsec = $state(false)
  let ncryptsecInput = $state('')
  let password = $state('')
  let showPassword = $state(false)
  // nsec / ncryptsec / key-words only: keep the key's own npub (bunker) vs
  // derive a new tree (tree-nsec).
  let derive = $state(false)
  // A pasted 24-word phrase is ambiguous: the usual seed to derive from, or a
  // key backup made here (the words are the key itself). The owner says which.
  let phraseKind = $state<'seed' | 'key'>('seed')
  // The optional 24-word backup of a pasted nsec/ncryptsec, shown on confirm.
  let backupWords = $state('')
  let showBackup = $state(false)

  // Held between derive-and-preview and send; zeroized after send or on cancel.
  let pendingSecret: Uint8Array | null = null
  let pendingMode: ProvisionMode | null = null

  // The connected board (from FIRMWARE_INFO), so the on-device entry
  // instructions match its buttons. The T-Display has two buttons and a
  // different restore vocabulary; every other board is single-button.
  let deviceBoard = $state('')
  const twoButton = $derived(deviceBoard === 'tdisplay')

  // The just-provisioned wifi device's relays, if any — drives the handoff at the end.
  let handoff = $state<{ hex: string; relays: string[] } | null>(null)
  let handoffConnecting = $state(false)
  let handoffError = $state('')

  // A freshly-provisioned WiFi signer reboots and joins WiFi (~10s); connecting
  // before it's back just errors, so hold the button and count the wait down so
  // it reads as "nearly ready", not a dead control.
  let wifiCountdown = $state(0)
  $effect(() => {
    if (step !== 'done' || !handoff || device.mode === 'relay') return
    wifiCountdown = 10
    const t = setInterval(() => {
      wifiCountdown -= 1
      if (wifiCountdown <= 0) clearInterval(t)
    }, 1000)
    return () => clearInterval(t)
  })

  const usesNsecKey = $derived(mode === 'restore-nsec' || mode === 'restore-ncryptsec')
  // The pasted phrase is being treated as a key backup, not a seed.
  const wordsAreKey = $derived(mode === 'restore-phrase' && phraseKind === 'key' && isKeyBackupCandidate(phrase))
  const keepsNpub = $derived((usesNsecKey || wordsAreKey) && !derive)

  // Whether the pasted material is well-formed enough to derive from.
  const pasteValid = $derived(
    mode === 'restore-phrase' ? isValidPhrase(phrase)
    : mode === 'restore-nsec' ? isValidNsec(nsecInput)
    : mode === 'restore-ncryptsec' ? (isValidNcryptsec(ncryptsecInput) && password.length > 0)
    : false,
  )

  function resetInputs() {
    name = ''; saved = false; error = ''; npub = ''
    phrase = ''; passphrase = ''; nsecInput = ''; ncryptsecInput = ''; password = ''
    derive = false; phraseKind = 'seed'; backupWords = ''; showBackup = false; status = 'idle'
  }

  function startCreate() { mode = 'create'; resetInputs(); step = 'naming' }
  function startRestore() { resetInputs(); step = 'restore-source' }

  function pickWordsDevice() { mode = 'restore-device'; resetInputs(); step = 'naming' }
  function pickWordsPaste() { mode = 'restore-phrase'; resetInputs(); step = 'paste' }
  function pickNsec() { mode = 'restore-nsec'; resetInputs(); step = 'paste' }
  function pickNcryptsec() { mode = 'restore-ncryptsec'; resetInputs(); step = 'paste' }

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

  // Phrase length for on-device generation: 12 words (128-bit) or 24 (256-bit).
  let genWords = $state<12 | 24>(12)

  async function generateOnDevice() {
    if (!nameOk(name)) return
    status = 'generating'
    error = ''
    try {
      // The device makes the seed and shows the phrase on its screen; only the
      // public npub comes back.
      npub = await generateIdentity(provisionLabel(name), genWords)
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

  /** Derive the key from the pasted material and show its address for confirmation. */
  async function deriveAndPreview() {
    if (!nameOk(name) || !pasteValid) return
    status = 'deriving'
    error = ''
    try {
      const resolved = await resolveRestore(
        mode === 'restore-phrase'
          ? (wordsAreKey ? { kind: 'key-words', phrase, derive } : { kind: 'phrase', phrase, passphrase })
        : mode === 'restore-nsec' ? { kind: 'nsec', nsec: nsecInput, derive }
        : { kind: 'ncryptsec', ncryptsec: ncryptsecInput, password, derive },
      )
      pendingSecret = resolved.result.secret
      pendingMode = resolved.mode
      npub = resolved.result.npub
      status = 'idle'
      step = 'confirm'
    } catch (e) {
      status = 'error'
      error = friendlyRestoreError(e)
    }
  }

  /** A specific, calm message for the common paste failures. */
  function friendlyRestoreError(e: unknown): string {
    if (mode === 'restore-ncryptsec') return 'That password did not unlock this key. Check it and try again.'
    if (mode === 'restore-nsec') return 'That does not look like a valid nsec. Check it and try again.'
    return e instanceof Error && e.message ? e.message : 'Could not read that recovery phrase.'
  }

  /** Send the confirmed secret to the device over USB, then finish. */
  async function sendPaste() {
    if (!pendingSecret || !pendingMode) return
    status = 'sending'
    error = ''
    try {
      await provisionSecret(pendingSecret, provisionLabel(name), pendingMode)
      rememberProvisioned()
      // The key is on the device now — wipe the raw material from the form.
      phrase = ''; passphrase = ''; nsecInput = ''; ncryptsecInput = ''; password = ''
      backupWords = ''; showBackup = false
      finish()
    } catch (e) {
      status = 'error'
      error = e instanceof Error ? e.message : 'The device did not accept the key. Try again.'
      step = 'paste'
    } finally {
      if (pendingSecret) { zeroize(pendingSecret); pendingSecret = null }
      pendingMode = null
    }
  }

  function cancelConfirm() {
    if (pendingSecret) { zeroize(pendingSecret); pendingSecret = null }
    pendingMode = null
    backupWords = ''; showBackup = false
    status = 'idle'
    step = 'paste'
  }

  /** Write the pasted key out as 24 words, computed only when asked for. The
   *  words encode the nsec itself (before any derive choice), so they restore
   *  it exactly; the derived tree comes back by making the same choice again. */
  function toggleBackupWords() {
    if (!showBackup && !backupWords) {
      try {
        const bytes = mode === 'restore-ncryptsec'
          ? decryptNcryptsec(ncryptsecInput, password)
          : decodeNsec(nsecInput)
        try { backupWords = keyToWords(bytes) } finally { zeroize(bytes) }
      } catch { return }
    }
    showBackup = !showBackup
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
      Your device is connected but doesn't have an identity yet. Create a fresh key, or restore
      one you already have. Do this once; afterwards you connect apps and manage it from your phone.
    </p>
    <div class="fi-actions">
      <button class="btn btn-primary" onclick={startCreate}>Create a fresh key →</button>
      <button class="btn btn-secondary" onclick={startRestore}>Restore a key I already have</button>
    </div>
    <p class="fi-guide">
      Writing down your recovery words is what brings an identity back later. See
      <a href="https://github.com/forgesworn/sapwood/blob/main/docs/backup-and-restore.md"
        target="_blank" rel="noopener">the backup and restore guide</a>.
    </p>
    <button class="fi-advanced" onclick={() => onadvanced?.()}>Open the advanced console</button>

  {:else if step === 'restore-source'}
    <h2 class="fi-title">Restore a key you already have</h2>
    <p class="fi-lede">
      How is your key held? The most private option types your words on the device itself, so no
      secret ever touches this computer.
    </p>
    <div class="source-list">
      <button class="source" onclick={pickWordsDevice}>
        <span class="source-body">
          <span class="source-label">12 or 24 words, typed on the device</span>
          <span class="source-desc">Most private. Enter your recovery phrase on the signer's own
            screen with its button. Nothing is typed here.</span>
        </span>
        <span class="source-tag good">recommended</span>
      </button>
      <button class="source" onclick={pickWordsPaste}>
        <span class="source-body">
          <span class="source-label">12 or 24 words, pasted here</span>
          <span class="source-desc">Faster. Paste your recovery phrase into this browser; it goes to
            the device over the cable and is never stored. Takes a 24-word key backup made here too.</span>
        </span>
      </button>
      <button class="source" onclick={pickNsec}>
        <span class="source-body">
          <span class="source-label">An nsec (nsec1...)</span>
          <span class="source-desc">Paste a raw private key. Keep its npub, or derive a fresh key from it.</span>
        </span>
      </button>
      <button class="source" onclick={pickNcryptsec}>
        <span class="source-body">
          <span class="source-label">An encrypted key (ncryptsec1...)</span>
          <span class="source-desc">A NIP-49 password-encrypted key. You enter its password to unlock it here.</span>
        </span>
      </button>
    </div>
    <div class="fi-actions">
      <button class="btn btn-secondary" onclick={() => (step = 'intro')}>Back</button>
    </div>

  {:else if step === 'naming'}
    <h2 class="fi-title">Name your signer</h2>
    <p class="fi-lede">
      {#if mode === 'restore-device'}
        Give it a friendly name (optional), then we'll ask the device to take your recovery phrase.
        You'll type your <strong>12 words on the device's screen</strong> using its button, never here.
      {:else}
        Give it a friendly name (optional), then we'll ask the device to make its identity.
        The device first offers a <strong>quick button game</strong> — your timing adds extra
        randomness to the key (tap to play, hold to skip). The recovery phrase then appears
        <strong>on the device's screen</strong>, not here.
      {/if}
    </p>
    <label class="field">
      <span class="field-label">Name this signer (optional)</span>
      <input type="text" class="field-input" bind:value={name} placeholder="e.g. My signer" maxlength="32"
        autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
        data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" />
    </label>
    {#if mode === 'create'}
      <fieldset class="word-count">
        <legend class="field-label">Recovery phrase length</legend>
        <label class="word-opt" class:on={genWords === 12}>
          <input type="radio" name="gen-words" checked={genWords === 12} onchange={() => (genWords = 12)} disabled={status === 'generating'} />
          <span>12 words — 128-bit, quicker to write down</span>
        </label>
        <label class="word-opt" class:on={genWords === 24}>
          <input type="radio" name="gen-words" checked={genWords === 24} onchange={() => (genWords = 24)} disabled={status === 'generating'} />
          <span>24 words — 256-bit, maximum strength</span>
        </label>
      </fieldset>
    {/if}
    {#if nameError(name)}<p class="error-text">{nameError(name)}</p>{/if}
    {#if error}<p class="error-text">{error}</p>{/if}
    {#if status === 'generating'}
      <!-- The OLED is small, so the full instructions live here while the
           device shows just the essentials. -->
      <div class="fi-game-guide">
        <p class="fi-working">⏳ On the device's screen now:</p>
        <ol class="fi-game-steps">
          <li><strong>Entropy game</strong> — blocks roll in; <strong>tap the button to jump</strong>
            them. Your tap timing is mixed into the key's randomness. <strong>Hold</strong> to skip
            and use the chip's generator alone.</li>
          <li><strong>Working…</strong> — the key is created inside the signer.</li>
          <li><strong>Write down the {genWords} words</strong>, one per screen — tap for the next,
            hold on the last screen to confirm. They only appear this once.</li>
        </ol>
      </div>
    {/if}
    <div class="fi-actions">
      <button class="btn btn-secondary" onclick={() => (step = mode === 'create' ? 'intro' : 'restore-source')} disabled={status === 'generating'}>Back</button>
      {#if mode === 'restore-device'}
        <button class="btn btn-primary" disabled={!nameOk(name)} onclick={restoreOnDevice}>
          Restore on my device →
        </button>
      {:else}
        <button class="btn btn-primary" disabled={!nameOk(name) || status === 'generating'} onclick={generateOnDevice}>
          {status === 'generating' ? 'Creating on device…' : 'Create it on my device →'}
        </button>
      {/if}
    </div>

  {:else if step === 'paste'}
    <h2 class="fi-title">
      {#if mode === 'restore-phrase'}Enter your recovery phrase
      {:else if mode === 'restore-nsec'}Enter your nsec
      {:else}Enter your encrypted key{/if}
    </h2>
    <p class="fi-lede">
      This is typed into your browser and sent straight to the device over the USB cable. It is
      never stored, never logged, and never sent over the network.
    </p>

    <label class="field">
      <span class="field-label">Name this signer (optional)</span>
      <input type="text" class="field-input" bind:value={name} placeholder="e.g. My signer" maxlength="32"
        autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
        data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" />
    </label>
    {#if nameError(name)}<p class="error-text">{nameError(name)}</p>{/if}

    {#if mode === 'restore-phrase'}
      <label class="field">
        <span class="field-label">Recovery phrase (12 or 24 words)</span>
        <textarea class="field-input" bind:value={phrase} rows="3" placeholder="12 or 24 words"
          autocomplete="off" autocapitalize="off" spellcheck="false"
          data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"></textarea>
      </label>
      {#if isKeyBackupCandidate(phrase)}
        <fieldset class="derive-choice">
          <legend class="field-label">Which kind of words are these?</legend>
          <label class="derive-opt" class:on={phraseKind === 'seed'}>
            <input type="radio" name="phrase-kind" checked={phraseKind === 'seed'} onchange={() => (phraseKind = 'seed')} />
            <span class="derive-body">
              <span class="derive-label">A recovery phrase (seed)</span>
              <span class="derive-desc">The usual kind. Your signer grows its key from these words,
                the way wallets do.</span>
            </span>
          </label>
          <label class="derive-opt" class:on={phraseKind === 'key'}>
            <input type="radio" name="phrase-kind" checked={phraseKind === 'key'} onchange={() => (phraseKind = 'key')} />
            <span class="derive-body">
              <span class="derive-label">A key backup made here</span>
              <span class="derive-desc">24 words written down when a key was added to a signer. The
                words are the key itself, so it comes back exactly as it was.</span>
            </span>
          </label>
        </fieldset>
      {/if}
      {#if phraseKind === 'seed' || !isKeyBackupCandidate(phrase)}
        <label class="field">
          <span class="field-label">Passphrase (optional 25th word)</span>
          <div class="pw-wrap">
            <input type="text" class="field-input" class:masked={!showPassphrase} bind:value={passphrase} placeholder="Optional"
              autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
              data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" />
            <PasswordReveal bind:shown={showPassphrase} />
          </div>
        </label>
      {/if}
    {:else if mode === 'restore-nsec'}
      <label class="field">
        <span class="field-label">nsec</span>
        <div class="pw-wrap">
          <input type="text" class="field-input" class:masked={!showNsec} bind:value={nsecInput} placeholder="nsec1..."
            autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
            data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" />
          <PasswordReveal bind:shown={showNsec} />
        </div>
      </label>
    {:else}
      <label class="field">
        <span class="field-label">Encrypted key</span>
        <input type="text" class="field-input" bind:value={ncryptsecInput} placeholder="ncryptsec1..."
          autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
          data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" />
      </label>
      <label class="field">
        <span class="field-label">Password</span>
        <div class="pw-wrap">
          <input type="text" class="field-input" class:masked={!showPassword} bind:value={password} placeholder="The password for this key"
            autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
            data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" />
          <PasswordReveal bind:shown={showPassword} />
        </div>
      </label>
    {/if}

    {#if usesNsecKey || wordsAreKey}
      <fieldset class="derive-choice">
        <legend class="field-label">What should the signer's address be?</legend>
        <label class="derive-opt" class:on={!derive}>
          <input type="radio" name="derive" checked={!derive} onchange={() => (derive = false)} />
          <span class="derive-body">
            <span class="derive-label"><span class="addr-chip good">Same npub</span> Keep this key's address</span>
            <span class="derive-desc">The signer becomes this exact key and signs as it. Pick this to
              make the signer <em>be</em> your existing identity.</span>
          </span>
        </label>
        <label class="derive-opt" class:on={derive}>
          <input type="radio" name="derive" checked={derive} onchange={() => (derive = true)} />
          <span class="derive-body">
            <span class="derive-label"><span class="addr-chip">New npub</span> Derive a fresh key</span>
            <span class="derive-desc">The device derives a brand-new key from it (a tree root). You get
              a new, different address.</span>
          </span>
        </label>
      </fieldset>
    {/if}

    {#if error}<p class="error-text">{error}</p>{/if}
    <div class="fi-actions">
      <button class="btn btn-secondary" onclick={() => (step = 'restore-source')} disabled={status === 'deriving'}>Back</button>
      <button class="btn btn-primary" disabled={!pasteValid || !nameOk(name) || status === 'deriving'} onclick={deriveAndPreview}>
        {status === 'deriving' ? 'Checking…' : 'Continue →'}
      </button>
    </div>

  {:else if step === 'confirm'}
    <h2 class="fi-title">Check the address</h2>
    <p class="fi-lede">
      {#if keepsNpub}
        This should be the <strong>same npub</strong> as the key you entered. Check it matches before
        sending it to the signer.
      {:else}
        This is the <strong>new address</strong> your signer will have. Check it before sending.
      {/if}
    </p>
    <div class="confirm-addr" class:same={keepsNpub}>
      <span class="addr-chip" class:good={keepsNpub}>{keepsNpub ? 'Same npub' : 'New npub'}</span>
      <div class="uri-box"><code>{npub}</code></div>
    </div>
    {#if usesNsecKey}
      <div class="backup">
        <button class="backup-toggle" onclick={toggleBackupWords}>
          {showBackup ? 'Hide the backup words' : 'Back up this key as 24 words first'}
        </button>
        {#if showBackup}
          <p class="backup-note">
            These 24 words are this key, written out in full and not protected by any password.
            Anyone who has them controls the identity, so write them down and keep them offline.
            {#if derive}
              You chose to derive a fresh key: pick that same option when you restore these words,
              and the same new address comes back.
            {:else}
              To restore, choose "12 or 24 words, pasted here" and mark them as a key backup.
            {/if}
          </p>
          <ol class="backup-words">
            {#each backupWords.split(' ') as word}
              <li>{word}</li>
            {/each}
          </ol>
        {/if}
      </div>
    {/if}
    {#if error}<p class="error-text">{error}</p>{/if}
    <div class="fi-actions">
      <button class="btn btn-secondary" onclick={cancelConfirm} disabled={status === 'sending'}>Back</button>
      <button class="btn btn-primary" onclick={sendPaste} disabled={status === 'sending'}>
        {status === 'sending' ? 'Sending to device…' : 'Send to my signer →'}
      </button>
    </div>

  {:else if step === 'writedown'}
    <h2 class="fi-title">Write down the words on your device</h2>
    <p class="fi-lede">
      Your signer is showing its <strong>{genWords}-word recovery phrase, one big word at a time</strong>.
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
      <span>I've stepped through all {genWords} words, written them down, and held the button to save.</span>
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
        <button class="btn btn-primary" onclick={manageWifi} disabled={handoffConnecting || wifiCountdown > 0}>
          {#if wifiCountdown > 0}Ready in {wifiCountdown}s…
          {:else if handoffConnecting}Connecting…
          {:else}Manage over WiFi{/if}
        </button>
        {#if handoffError}<p class="warn-text">{handoffError}</p>{/if}
      {/if}
    {:else}
      <p class="fi-lede">It's ready. Your name and picture sync to the signer automatically. You can
        connect your first app now.</p>
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
  .fi-guide { font-size: 0.8rem; color: var(--text-muted); line-height: 1.55; margin: 0 0 1rem; }
  .fi-guide a { color: var(--green); }
  .fi-lede strong { color: var(--text); }
  .fi-working { font-size: 0.85rem; color: var(--green-dim); line-height: 1.55; margin: 0.6rem 0 0; }

  .word-count { border: none; margin: 0.4rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
  .word-opt { display: flex; align-items: center; gap: 0.55rem; font-size: 0.85rem; color: var(--text-dim); cursor: pointer; }
  .word-opt input { accent-color: var(--green); }
  .word-opt.on span { color: var(--text); }

  /* Full game instructions while the device runs (its OLED is too small) */
  .fi-game-guide {
    margin-top: 0.7rem; padding: 0.7rem 0.9rem;
    background: #08130d; border: 1px solid var(--green-dim); border-radius: 6px;
  }
  .fi-game-guide .fi-working { margin: 0 0 0.4rem; }
  .fi-game-steps { margin: 0; padding-left: 1.2rem; }
  .fi-game-steps li { font-size: 0.82rem; color: var(--text-dim); line-height: 1.5; margin-bottom: 0.4rem; }
  .fi-game-steps strong { color: var(--green); }

  .fi-advanced {
    display: block; margin: 1rem 0 0; padding: 0; width: 100%;
    border: none; background: none; color: var(--text-muted);
    cursor: pointer; font-family: inherit; font-size: 0.8rem; text-align: center;
  }
  .fi-advanced:hover { color: var(--text-dim); text-decoration: underline; }

  /* Restore source picker */
  .source-list { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.4rem; }
  .source {
    display: flex; align-items: flex-start; gap: 0.75rem; text-align: left; width: 100%;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 0.85rem 1rem; cursor: pointer; font-family: inherit;
    transition: border-color 0.12s, background 0.12s;
  }
  .source:hover { border-color: var(--green-dim); background: #08130d; }
  .source-body { display: flex; flex-direction: column; gap: 0.2rem; flex: 1; min-width: 0; }
  .source-label { font-size: 0.95rem; font-weight: 600; color: #fff; }
  .source-desc { font-size: 0.8rem; color: var(--text-dim); line-height: 1.45; }
  .source-tag {
    flex-shrink: 0; font-size: 0.6rem; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;
    border-radius: 3px; padding: 0.12rem 0.4rem; align-self: center;
  }
  .source-tag.good { color: var(--green); border: 1px solid var(--green-dim); background: #08130d; }

  /* Derive choice (nsec / ncryptsec) */
  .derive-choice { border: none; margin: 0.2rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .derive-choice legend { padding: 0; margin-bottom: 0.5rem; }
  .derive-opt {
    display: flex; align-items: flex-start; gap: 0.6rem; cursor: pointer;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 0.7rem 0.85rem;
    transition: border-color 0.12s, background 0.12s;
  }
  .derive-opt.on { border-color: var(--green-dim); background: #08130d; }
  .derive-opt input { margin-top: 0.2rem; accent-color: var(--green); flex-shrink: 0; }
  .derive-body { display: flex; flex-direction: column; gap: 0.25rem; }
  .derive-label { font-size: 0.9rem; font-weight: 600; color: #fff; display: flex; align-items: center; gap: 0.45rem; }
  .derive-desc { font-size: 0.78rem; color: var(--text-dim); line-height: 1.45; }
  .derive-desc em { color: var(--green-dim); font-style: normal; }

  .addr-chip {
    font-size: 0.6rem; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600;
    color: #cba24a; border: 1px solid #5a4a20; border-radius: 3px; padding: 0.1rem 0.4rem; flex-shrink: 0;
  }
  .addr-chip.good { color: var(--green); border-color: var(--green-dim); }

  .confirm-addr { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.4rem; }

  /* Optional 24-word backup of a pasted key, on the confirm step */
  .backup { margin: 0.9rem 0 0.2rem; }
  .backup-toggle {
    background: none; border: none; padding: 0; cursor: pointer;
    font-family: inherit; font-size: 0.82rem; color: var(--green-dim); text-decoration: underline;
  }
  .backup-toggle:hover { color: var(--green); }
  .backup-note { font-size: 0.8rem; color: var(--text-dim); line-height: 1.55; margin: 0.6rem 0 0; }
  .backup-words {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.25rem 1.4rem;
    margin: 0.8rem 0 0.2rem; padding: 0.8rem 1rem 0.8rem 2.4rem;
    background: #08130d; border: 1px solid var(--green-dim); border-radius: 6px;
    font-size: 0.88rem; color: var(--text);
  }
  .backup-words li { padding: 0.1rem 0; }
  @media (max-width: 640px) {
    .backup-words { grid-template-columns: repeat(2, 1fr); }
  }

  /* Mask secrets without a type="password" input — a password field here makes
     the browser's manager autofill a saved WiFi credential and offer to SAVE the
     nsec to the OS password store. text-security masks in the dots without any of
     that (this flow is Chrome/Edge-only: it needs Web Serial). The reveal eye
     drops the class to show the value. */
  :global(.field-input).masked { -webkit-text-security: disc; }

  .confirm-save {
    display: flex; align-items: flex-start; gap: 0.6rem; margin: 0.4rem 0 1.1rem;
    font-size: 0.88rem; color: var(--text); line-height: 1.5; cursor: pointer;
  }
  .confirm-save input { margin-top: 0.2rem; accent-color: var(--green); width: 1.1rem; height: 1.1rem; flex-shrink: 0; }

  .uri-box { margin: 0 0 0.4rem; }

  .fi-gestures {
    margin: 0 0 1.2rem; padding: 0.8rem 1rem 0.8rem 2.2rem;
    background: #08130d; border: 1px solid var(--green-dim); border-radius: 6px;
    font-size: 0.88rem; color: var(--text-dim); line-height: 1.7;
  }
  .fi-gestures li { margin: 0; }
  .fi-gestures strong { color: var(--green); }

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

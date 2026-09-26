<script lang="ts">
  // Phones that can unlock: the phones (running Cambium) that may unlock this
  // signer after a restart with a tap. Add one by scanning the code Cambium
  // shows, list them, revoke one. No secret passes through Sapwood: the board
  // seals each phone's unlock secret to a key only that phone holds.
  import { onDestroy, tick, untrack } from 'svelte'
  import { SimplePool } from 'nostr-tools/pool'
  import { encodeQR } from '@paulmillr/qr'
  import {
    device, listUnlockPhones, revokeUnlockPhone, setAnnounceOperator, enrolUnlockPhone,
    PhoneUnlockAuthRequired, supportsPhoneEnrolRelay,
  } from '../lib/device.svelte.js'
  import {
    parseEnrolmentCode, enrolPhone, HandOffUndelivered, markCodeSpent, isCodeSpent,
    requestWords, fitLabel, friendlyEnrolRefusal, findOrphanedPhoneId, openRelays,
    HANDOFF_KIND,
    type EnrolmentCode, type EnrolResult, type UnlockPhoneList,
  } from '../lib/phone-unlock.js'
  import {
    createInvite, openInviteReply, reduceInvite, initialInviteState, zeroInviteSecret,
    type Invite, type InviteCollectorState, type InviteReplyEvent,
  } from '../lib/enrol-invite.js'
  import ConfirmButton from './ConfirmButton.svelte'
  import QrScanner from './QrScanner.svelte'
  import WordPairs from './WordPairs.svelte'
  import TogglePair from './TogglePair.svelte'

  /** Fallback relays for a fresh invite: the ones Sapwood already uses for
   *  this signer over the relay, its USB-reported WiFi relays, or failing
   *  both the project relay (the same one Cambium's own enrolment code
   *  defaults to). */
  function defaultInviteRelays(): string[] {
    if (device.mode === 'relay' && device.relayConfiguredRelays?.length) return [...device.relayConfiguredRelays]
    if (device.mode === 'serial' && device.usbNetworkState?.relays?.length) return [...device.usbNetworkState.relays]
    return ['wss://relay.trotters.cc']
  }

  function formatCountdown(totalSeconds: number): string {
    const clamped = Math.max(0, totalSeconds)
    const m = Math.floor(clamped / 60)
    const s = clamped % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  interface Props {
    /** Enrolled phones, or null while unknown (for the mode chooser). */
    count?: number | null
    /** Bumped by the page when something else changed the phones, such as
     *  turning encryption off (which drops every phone). */
    refresh?: number
  }
  let { count = $bindable(null), refresh = 0 }: Props = $props()

  const overUsb = $derived(device.mode === 'serial')
  // Older firmware has no route to enrol_unlock_phone over the relay at all
  // (a NIP-46 client, and every management method, is refused before the
  // capability check even runs), so this stays cable-only until it does.
  const overRelay = $derived(device.mode === 'relay' && supportsPhoneEnrolRelay())
  const canAdd = $derived(overUsb || overRelay)
  // A locked signer answers almost nothing, and its empty refusal would read
  // as firmware without phone unlock.
  const locked = $derived(device.masters.some((m) => m.locked === true))

  type Support = 'checking' | 'unsupported' | 'locked' | 'needs-auth' | 'ready' | 'error'
  let support = $state<Support>('checking')
  let list = $state<UnlockPhoneList | null>(null)
  let loadError = $state<string | null>(null)
  let loading = $state(false)

  $effect(() => { count = support === 'ready' && list ? list.phones.length : null })

  async function load(authenticate = false) {
    loading = true
    loadError = null
    try {
      const answer = await listUnlockPhones({ authenticate: authenticate || device.bridgeAuthed })
      if (answer === null) {
        support = 'unsupported'
        list = null
      } else {
        support = 'ready'
        list = answer
      }
    } catch (e) {
      if (e instanceof PhoneUnlockAuthRequired) {
        support = 'needs-auth'
      } else {
        support = 'error'
        loadError = e instanceof Error ? e.message : 'The signer did not list its phones.'
      }
    } finally {
      loading = false
    }
  }

  // Reload on a new connection, a change of lock state, or a refresh from the
  // page; nothing load() reads (the relay status poll, the bridge session)
  // may re-run it, or the list is fetched again every few seconds.
  $effect(() => {
    const live = device.connected && (device.mode === 'serial' || device.mode === 'relay')
    const isLocked = locked
    void device.connectionGeneration
    void refresh
    untrack(() => {
      if (!live) {
        support = 'unsupported'
        list = null
      } else if (isLocked) {
        support = 'locked'
        list = null
      } else {
        void load()
      }
    })
  })

  // --- Revoke ---
  let revoking = $state<number | null>(null)
  let revokeStatus = $state<string | null>(null)

  const lastPhoneWarning = $derived(list && list.phones.length === 1 && !list.announceOperator
    ? ' It is the last phone, and Sapwood\'s own unlock message is off, so after a restart only the USB cable could unlock it.'
    : '')

  async function revoke(id: number, label: string) {
    revoking = id
    revokeStatus = null
    try {
      await revokeUnlockPhone(id)
      revokeStatus = `Revoked ${label} (record ${id}). It can no longer unlock this signer.`
      await load(true)
    } catch (e) {
      revokeStatus = e instanceof Error ? e.message : 'Revoking failed.'
    } finally {
      revoking = null
    }
  }

  // --- Operator announcement ---
  let announcePending = $state(false)
  let announceStatus = $state<string | null>(null)

  async function changeAnnounce(on: boolean) {
    announcePending = true
    announceStatus = null
    try {
      await setAnnounceOperator(on)
      announceStatus = on
        ? 'From its next locked restart, the signer also asks Sapwood.'
        : 'From its next locked restart, the signer asks only its phones.'
      await load(true)
    } catch (e) {
      announceStatus = e instanceof Error ? e.message : 'The setting was not changed.'
    } finally {
      announcePending = false
    }
  }

  // --- Add a phone ---
  type Step =
    | 'idle' | 'invite' | 'invite-expired' | 'invite-aborted'
    | 'scan' | 'paste' | 'confirm' | 'working' | 'done' | 'failed' | 'orphan'
  let step = $state<Step>('idle')
  let pasted = $state('')
  let code = $state<EnrolmentCode | null>(null)
  let working = $state<string | null>(null)
  let result = $state<EnrolResult | null>(null)
  let addError = $state<string | null>(null)
  /** Which of the two "invite-aborted" stories to tell: someone else answered,
   *  or nobody did. */
  let abortReason = $state<'two-phones' | 'no-relays' | null>(null)
  /** Set once the board has been asked: its enrolment key is then spent. */
  let codeSpent = $state(false)
  /** A record the board may have kept with nobody holding its secret: the
   *  relay request timed out with no reply (see `add`'s catch). */
  let orphanId = $state<number | null>(null)
  let orphanBusy = $state(false)

  const pastedCode = $derived(pasted.trim() ? parseEnrolmentCode(pasted) : null)

  const pastedSpent = $derived(pastedCode ? isCodeSpent(pastedCode) : false)
  let scanSpent = $state(false)

  // --- Invite: Sapwood shows a QR, the phone scans it and replies over the
  // relay (the default "Add a phone" path, see enrol-invite.ts). ---
  // $state.raw, not $state: this holds a Uint8Array secret, and identity
  // (not deep reactivity) is what the invite-superseded checks below rely on.
  let invite = $state.raw<Invite | null>(null)
  let inviteState = $state<InviteCollectorState>(initialInviteState)
  let invitePool: SimplePool | null = null
  let inviteCloser: { close: () => void } | null = null
  let inviteTicker: ReturnType<typeof setInterval> | null = null
  let inviteNow = $state(Date.now())

  const inviteQr = $derived(invite ? encodeQR(invite.uri, 'svg') : '')
  const inviteSecondsLeft = $derived(invite ? Math.ceil((invite.expiresAt * 1000 - inviteNow) / 1000) : 0)

  /** Close the invite's subscription and pool, and zero its secret. Safe to
   *  call at any time, including when no invite is open. */
  function stopInvite(): void {
    if (inviteTicker) { clearInterval(inviteTicker); inviteTicker = null }
    try { inviteCloser?.close() } catch { /* already closed */ }
    inviteCloser = null
    try { invitePool?.destroy() } catch { /* already closed */ }
    invitePool = null
    if (invite) zeroInviteSecret(invite)
    invite = null
    inviteState = initialInviteState
  }

  function handleInviteEvent(event: InviteReplyEvent, forInvite: Invite): void {
    if (invite !== forInvite) return // superseded or already closed
    const parsed = openInviteReply(event, forInvite)
    if (!parsed) return
    inviteState = reduceInvite(inviteState, { type: 'reply', code: parsed })
    if (inviteState.status === 'received' && step === 'invite') {
      code = inviteState.code
      step = 'confirm'
    } else if (inviteState.status === 'aborted') {
      addError = 'Someone else may have seen the code. Nothing was added. Cancel on your phone, then make a new code.'
      abortReason = 'two-phones'
      stopInvite()
      step = 'invite-aborted'
    }
  }

  async function startInvite(): Promise<void> {
    stopInvite()
    step = 'invite'
    pasted = ''
    code = null
    result = null
    addError = null
    abortReason = null
    codeSpent = false
    scanSpent = false
    orphanId = null
    inviteState = initialInviteState

    const relays = defaultInviteRelays()
    const made = createInvite(relays)
    const pool = new SimplePool()
    invitePool = pool
    const live = await openRelays(pool, relays)
    if (step !== 'invite' || invitePool !== pool) {
      try { pool.destroy() } catch { /* already closed */ }
      return // cancelled, or superseded by a newer invite, while opening
    }
    if (!live.length) {
      zeroInviteSecret(made)
      stopInvite()
      addError = 'None of the relays answered, so the phone could not reply. Check this computer\'s connection and try again.'
      abortReason = 'no-relays'
      step = 'invite-aborted'
      return
    }
    invite = made
    const since = Math.floor(Date.now() / 1000) - 60
    inviteCloser = pool.subscribe(
      relays,
      { kinds: [HANDOFF_KIND], '#h': [made.rendezvous], since },
      { onevent: (event) => handleInviteEvent(event, made) },
    )
    inviteNow = Date.now()
    inviteTicker = setInterval(() => {
      inviteNow = Date.now()
      if (invite !== made || inviteNow < made.expiresAt * 1000) return
      inviteState = reduceInvite(inviteState, { type: 'expire' })
      if (inviteState.status === 'expired') {
        stopInvite()
        step = 'invite-expired'
      }
    }, 1000)
  }

  onDestroy(stopInvite)

  function startAdd(mode: 'scan' | 'paste') {
    stopInvite()
    step = mode
    pasted = ''
    code = null
    result = null
    addError = null
    abortReason = null
    codeSpent = false
    scanSpent = false
    orphanId = null
  }

  function accept(text: string): boolean {
    const parsed = parseEnrolmentCode(text)
    if (!parsed) return false
    if (isCodeSpent(parsed)) {
      scanSpent = true
      return false
    }
    code = parsed
    step = 'confirm'
    return true
  }

  /**
   * Look for a phone id the enrolment left behind: the relay timed out with
   * no reply, but the board may still have written a record before its
   * answer failed to reach any live session. Nobody holds that record's
   * secret, so it unlocks nothing; offering to revoke it is the only useful
   * next step ("Not sent / revoke id N" on the board's own screen).
   */
  async function checkOrphan(before: UnlockPhoneList['phones']): Promise<void> {
    try {
      const after = await listUnlockPhones({ authenticate: true })
      if (after) list = after
      const id = after ? findOrphanedPhoneId(before, after.phones) : null
      if (id !== null) {
        orphanId = id
        step = 'orphan'
      } else {
        addError = 'The signer never answered in time. It may not have added anything: check the list above, then start again with a new code.'
        step = 'failed'
      }
    } catch {
      addError = 'The signer never answered in time, and Sapwood could not re-check its phones. Refresh this page, check the list above for a stray record, then start again with a new code.'
      step = 'failed'
    }
  }

  async function revokeOrphan(id: number): Promise<void> {
    orphanBusy = true
    try {
      await revokeUnlockPhone(id)
      await load(true)
      step = 'idle'
      orphanId = null
    } catch (e) {
      addError = e instanceof Error ? e.message : 'Revoking failed.'
    } finally {
      orphanBusy = false
    }
  }

  /** Continue from the confirm step: the invite (if this code came from one)
   *  is single-use, so its subscription closes and its secret is zeroed
   *  before the existing enrol path runs, unchanged. */
  function continueFromConfirm() {
    stopInvite()
    void add()
  }

  async function add() {
    if (!code) return
    step = 'working'
    addError = null
    working = 'Reaching the phone\'s relays…'
    const pool = new SimplePool()
    const isRelay = overRelay
    const before = list?.phones ?? []
    const label = fitLabel(code.label)
    try {
      result = await enrolPhone(code, {
        pool,
        enrol: async (enrolPubkey) => {
          codeSpent = true
          if (code) markCodeSpent(code)
          return enrolUnlockPhone(enrolPubkey, label, 'Signer: compare the five words, then hold its button.')
        },
        onBoard: () => {
          working = isRelay
            ? 'Waiting on the signer\'s card. This can take up to about two and a half minutes: it queues behind any other approval, then holds on screen for a press.'
            : 'Waiting for the signer\'s button…'
        },
      })
      step = 'done'
    } catch (e) {
      if (isRelay && /timeout waiting for device/i.test(e instanceof Error ? e.message : '')) {
        await checkOrphan(before)
      } else {
        addError = e instanceof HandOffUndelivered
          ? e.message
          : friendlyEnrolRefusal(e instanceof Error ? e.message : 'Adding the phone failed.')
        step = 'failed'
      }
    } finally {
      working = null
      try { pool.destroy() } catch { /* already closed */ }
      if (codeSpent) void load(true)
    }
  }

  // --- 7.2 Add a phone: the constant enrolment card ---
  // The heading and live region exist from the first render of the card (any
  // step but 'idle'). Every step change sets both and moves focus to the
  // heading, so the compare-and-confirm bench flow announces itself to
  // assistive tech without the owner hunting for what changed.
  const confirmWords = $derived(code ? requestWords(code.enrolPubkey) : [])

  const phase = $derived(
    step === 'invite' ? (invite ? 'invite-ready' : 'invite-opening') : step,
  )

  let cardHeadingEl = $state<HTMLHeadingElement | null>(null)
  let cardHeadingText = $state('')
  let liveText = $state('')

  $effect(() => {
    const p = phase
    const label = code?.label ?? 'The phone'
    if (p === 'invite-opening') { cardHeadingText = 'Add a phone'; liveText = 'Opening relays.' }
    else if (p === 'invite-ready') { cardHeadingText = 'Scan this with Cambium'; liveText = 'Code ready. It expires in 10 minutes.' }
    else if (p === 'invite-expired') { cardHeadingText = 'Code expired'; liveText = 'Code expired.' }
    else if (p === 'invite-aborted') {
      cardHeadingText = abortReason === 'no-relays' ? 'Could not reach the relays' : 'Two phones answered'
      liveText = abortReason === 'no-relays' ? 'Could not reach the relays.' : 'Stopped: two phones answered.'
    } else if (p === 'scan' || p === 'paste') { cardHeadingText = 'Add a phone'; liveText = '' }
    else if (p === 'confirm') { cardHeadingText = `${label} wants to unlock this signer`; liveText = `${label} answered. Compare the five words.` }
    else if (p === 'working') { cardHeadingText = 'Check the signer'; liveText = 'Sent to the signer. Hold its button when the words match.' }
    else if (p === 'done') { cardHeadingText = `${label} added`; liveText = result ? `${label} added. Check code ${result.checkCode}.` : '' }
    else if (p === 'orphan') { cardHeadingText = 'A stray record may be left'; liveText = '' }
    else if (p === 'failed') { cardHeadingText = 'Not added'; liveText = '' }
    if (p !== 'idle') void tick().then(() => cardHeadingEl?.focus())
  })

  // Announce the countdown only at its two milestones and at expiry (the
  // heading effect above covers expiry): a live region that spoke every
  // second would be unusable.
  $effect(() => {
    const s = inviteSecondsLeft
    if (phase !== 'invite-ready') return
    if (s === 300) liveText = 'Five minutes left to scan the code.'
    else if (s === 60) liveText = 'One minute left to scan the code.'
  })
</script>

<div class="unlock-phones">
  <h3 class="sub-title">Phones that can unlock</h3>
  <p class="hint">A phone running Cambium can unlock this signer after a power cut. Nothing on the
    wire names the phone. Revoking a lost phone changes nothing else.</p>

  {#if support === 'checking'}
    <p class="hint-sm">Asking the signer…</p>
  {:else if support === 'unsupported'}
    <p class="hint-sm">This signer's firmware has no phone unlock. It arrived in 0.18.0-beta.17.</p>
  {:else if support === 'locked'}
    <p class="hint-sm">Unlock the signer to see its phones.</p>
  {:else if support === 'needs-auth'}
    <p class="hint-sm">The signer lists its phones once this browser authenticates over USB.</p>
    <button class="btn btn-secondary btn-sm" disabled={loading} onclick={() => load(true)}>
      {loading ? 'Asking…' : 'Show the phones'}
    </button>
  {:else if support === 'error'}
    <p class="warn-text">{loadError}</p>
    <button class="btn btn-secondary btn-sm" disabled={loading} onclick={() => load(true)}>Try again</button>
  {:else if list}
    {#if list.phones.length === 0}
      <p class="hint-sm">No phones yet.</p>
    {:else}
      <ul class="phone-list">
        {#each list.phones as phone (phone.id)}
          <li class="phone-row">
            <span class="phone-name">{phone.label}</span>
            <span class="mono phone-id">record {phone.id}</span>
            <ConfirmButton
              label="Revoke"
              question={`Stop ${phone.label} unlocking this signer?${lastPhoneWarning}`}
              confirmLabel="Yes, revoke"
              busyLabel="Revoking…"
              busy={revoking === phone.id}
              disabled={revoking !== null}
              onconfirm={() => revoke(phone.id, phone.label)}
            />
          </li>
        {/each}
      </ul>
      <p class="hint-sm">{list.phones.length} of {list.max} phones.{#if list.phones.length === 1}
        Add a second device (a spare, or a family member's phone) so losing this one abroad does not
        leave the signer locked.{:else if list.phones.length >= list.max}
        This signer holds {list.max} phones, its limit. Revoke one to add another.{/if}</p>
    {/if}
    {#if revokeStatus}<p class="hint-sm status">{revokeStatus}</p>{/if}

    {#if step === 'idle'}
      {#if canAdd}
        <div class="inline-form">
          <button class="btn btn-primary add-phone-btn" disabled={list.phones.length >= list.max}
            onclick={startInvite}>Add a phone</button>
        </div>
        <details class="disclosure">
          <summary>Phone shows a code instead? Paste it</summary>
          <div class="inline-form">
            <button class="btn btn-secondary btn-sm" disabled={list.phones.length >= list.max}
              onclick={() => startAdd('paste')}>Paste a code</button>
            <button class="btn btn-ghost btn-sm" disabled={list.phones.length >= list.max}
              onclick={() => startAdd('scan')}>Scan the phone's code</button>
          </div>
        </details>
      {:else}
        <p class="hint-sm">Adding a phone needs the signer on the USB cable, or over the relay once its firmware serves that, and a press on its button.</p>
      {/if}
    {/if}

    {#if step !== 'idle'}
      <div class="enrol card">
        <h4 class="enrol-heading" tabindex="-1" bind:this={cardHeadingEl}>{cardHeadingText}</h4>
        <p role="status" aria-live="polite" class="hint-sm enrol-live">{liveText}</p>

        {#if step === 'invite'}
          {#if !invite}
            <p class="hint-sm">Opening relays…</p>
          {:else}
            <div class="invite-layout">
              <div class="qr invite-qr">{@html inviteQr}</div>
              <div class="invite-steps">
                <ol class="hint-sm">
                  <li>Open Cambium on the phone.</li>
                  <li>Open this signer's screen.</li>
                  <li>Tap Set up phone unlock, then Scan Sapwood's code.</li>
                </ol>
                <p class="hint-sm countdown">Expires in {formatCountdown(inviteSecondsLeft)}</p>
                <button class="btn btn-secondary btn-sm" onclick={() => { stopInvite(); step = 'idle' }}>Cancel</button>
              </div>
            </div>
          {/if}
        {:else if step === 'invite-expired'}
          <p class="hint-sm">Codes last 10 minutes. Cancel on the phone, then make a new code.</p>
          <div class="inline-form">
            <button class="btn btn-primary btn-sm" onclick={startInvite}>New code</button>
            <button class="btn btn-ghost btn-sm" onclick={() => { step = 'idle' }}>Close</button>
          </div>
        {:else if step === 'invite-aborted'}
          <p class="warn-text">{addError}</p>
          <div class="inline-form">
            <button class="btn btn-primary btn-sm" onclick={startInvite}>New code</button>
            <button class="btn btn-ghost btn-sm" onclick={() => { step = 'idle' }}>Close</button>
          </div>
        {:else if step === 'scan' || step === 'paste'}
          <p class="hint-sm">On the phone, open Cambium and tap “Set up phone unlock” under this
            signer. It shows a code; nothing in it is secret. Its “Copy code” button gives the text
            to paste here.</p>
          {#if step === 'scan'}
            <QrScanner onresult={accept} oncancel={() => { step = 'paste' }} />
            {#if scanSpent}
              <p class="warn-text">That code was already used here. Start again on the phone for a new one.</p>
            {/if}
          {:else}
            <textarea class="field-input code-input" rows="3" spellcheck="false" autocomplete="off"
              placeholder="heartwood-unlock:enrol?v=1&amp;…" bind:value={pasted}></textarea>
            {#if pasted.trim() && !pastedCode}
              <p class="warn-text">That is not a phone-unlock code from Cambium.</p>
            {:else if pastedSpent}
              <p class="warn-text">This code was already used here. Start again on the phone for a new one.</p>
            {/if}
            <div class="inline-form">
              <button class="btn btn-secondary btn-sm" disabled={!pastedCode || pastedSpent}
                onclick={() => accept(pasted)}>Use this code</button>
              <button class="btn btn-ghost btn-sm" onclick={() => startAdd('scan')}>Scan instead</button>
            </div>
          {/if}
          <button class="btn btn-ghost btn-sm" onclick={() => { step = 'idle' }}>Cancel</button>
        {:else if step === 'confirm' && code}
          <p class="hint-sm">Check Cambium shows these five words, in this order.</p>
          <WordPairs words={confirmWords} />
          <p class="hint-sm">Next, the signer shows the same words, two at a time. Hold its button
            only if all three screens match.</p>
          <div class="inline-form">
            <button class="btn btn-primary btn-sm" onclick={continueFromConfirm}>Send to the signer</button>
            <button class="btn btn-ghost btn-sm" onclick={() => { stopInvite(); step = 'idle' }}>Cancel</button>
          </div>
          <details class="disclosure">
            <summary>Why compare with the phone, not only this page?</summary>
            <p class="hint-sm">Whoever relayed the request could have swapped the words shown here.
              The phone and the signer cannot both be swapped, so their match is the check that
              counts. The check code afterwards only confirms the phone received the hand-off.</p>
            <table class="kv-table"><tbody>
              <tr><td class="label">Phone</td><td>{code.label}</td></tr>
              <tr><td class="label">Relays</td><td>
                {#each code.relays as relay}<div class="mono">{relay}</div>{/each}
              </td></tr>
            </tbody></table>
          </details>
        {:else if step === 'working'}
          <p class="hint-sm">Wait for ADD PHONE. When its five words match these and the phone, hold
            its button.</p>
          <WordPairs words={confirmWords} />
          {#if overRelay}
            <p class="hint-sm">This can take up to about two and a half minutes: the card queues
              behind any other approval.</p>
          {/if}
          {#if working}<p class="hint-sm status">{working}</p>{/if}
        {:else if step === 'done' && result}
          <p class="hint-sm">Check code</p>
          <p class="check-code mono">{result.checkCode}</p>
          <p class="hint-sm">Cambium and the signer show the same code. If all three match, confirm
            on the phone with its screen lock.</p>
          <div class="inline-form">
            <button class="btn btn-secondary btn-sm" onclick={() => { step = 'idle' }}>Done</button>
            <ConfirmButton
              label="Codes don't match: revoke"
              question={`Revoke record ${result.id}? The phone that answered can no longer unlock this signer.`}
              confirmLabel="Yes, revoke"
              busyLabel="Revoking…"
              busy={revoking === result.id}
              buttonClass="btn btn-secondary btn-sm"
              onconfirm={() => {
                const r = result
                const label = code?.label ?? 'the phone'
                if (r) void revoke(r.id, label)
                step = 'idle'
              }}
            />
          </div>
        {:else if step === 'orphan' && orphanId !== null}
          <p class="warn-text">{addError ?? `The signer never answered in time, but it may have kept a record nobody holds (record ${orphanId}): its secret never reached this browser, so it cannot reach the phone either.`}</p>
          <p class="hint-sm">Revoke it, then start again with a new code from the phone.</p>
          <div class="inline-form">
            <button class="btn btn-secondary btn-sm" disabled={orphanBusy}
              onclick={() => revokeOrphan(orphanId!)}>{orphanBusy ? 'Revoking…' : `Revoke record ${orphanId}`}</button>
            <button class="btn btn-ghost btn-sm" onclick={() => { step = 'idle'; orphanId = null }}>Close</button>
          </div>
        {:else if step === 'failed'}
          <p class="warn-text">{addError}</p>
          <div class="inline-form">
            {#if codeSpent}
              <button class="btn btn-secondary btn-sm" onclick={() => startAdd('scan')}>Scan a new code</button>
            {:else}
              <button class="btn btn-secondary btn-sm" onclick={add}>Try again</button>
            {/if}
            <button class="btn btn-ghost btn-sm" onclick={() => { step = 'idle' }}>Close</button>
          </div>
        {/if}
      </div>
    {/if}

    <details class="disclosure announce">
      <summary>Sapwood's own unlock message</summary>
      <p class="hint-sm">When it is locked, the signer also posts a message tagged with your operator
        key, so Sapwood can offer to unlock it over WiFi. That tag is the same every time, so a relay
        can link the signer's restarts. Phone messages carry no such tag. If your phones are enough,
        turn it off; Sapwood can still unlock over USB. It stays on while no phone is set up, or a
        locked signer could only be unlocked over the cable.</p>
      <TogglePair
        label="Sapwood's own unlock message"
        onLabel="On"
        offLabel="Off"
        value={list.announceOperator}
        pending={announcePending}
        onDisabled={list.phones.length === 0}
        onchange={changeAnnounce}
      />
      {#if announceStatus}<p class="hint-sm status">{announceStatus}</p>{/if}
    </details>
  {/if}
</div>

<style>
  .sub-title { font-size: 0.9rem; font-weight: 600; color: var(--text); margin: 0 0 0.4rem; }
  .phone-list { list-style: none; margin: 0.6rem 0; padding: 0; }
  .phone-row {
    display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
    padding: 0.5rem 0; border-top: 1px solid var(--border);
  }
  .phone-row:last-child { border-bottom: 1px solid var(--border); }
  .phone-name { font-weight: 600; color: var(--text); }
  .phone-id { color: var(--text-dim); font-size: 0.8rem; flex: 1; }
  .inline-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-top: 0.6rem; }
  .add-phone-btn { width: 100%; }
  .enrol { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.8rem; align-items: flex-start; }
  .enrol-heading { font-size: 1.1rem; font-weight: 700; margin: 0; color: var(--text); }
  .enrol-heading:focus { outline: 2px solid var(--green); outline-offset: 2px; }
  .enrol-live:empty { display: none; }
  .code-input { width: 100%; box-sizing: border-box; font-size: 0.8rem; resize: vertical; }
  .check-code { font-size: 2rem; font-weight: 600; letter-spacing: 0.2em; color: var(--green); margin: 0.2rem 0; font-variant-numeric: slashed-zero; }
  .status { margin-top: 0.6rem; color: var(--text-dim); }
  .announce { margin-top: 1rem; }
  .qr { width: 220px; padding: 12px; background: #fff; border-radius: 6px; margin: 0.4rem 0; flex: none; }
  .qr :global(svg) { display: block; width: 100%; height: auto; }
  .countdown { font-weight: 600; }
  .invite-layout { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-start; }
  .invite-steps { display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-start; min-width: 12rem; flex: 1; }
  .invite-steps ol { margin: 0; padding-left: 1.1rem; }

  @media (max-height: 500px) {
    .qr { width: 180px; }
  }
</style>

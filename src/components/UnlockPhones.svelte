<script lang="ts">
  // Phones that can unlock: the phones (running Cambium) that may unlock this
  // signer after a restart with a tap. Add one by scanning the code Cambium
  // shows, list them, revoke one. No secret passes through Sapwood: the board
  // seals each phone's unlock secret to a key only that phone holds.
  import { SimplePool } from 'nostr-tools/pool'
  import {
    device, listUnlockPhones, revokeUnlockPhone, setAnnounceOperator, enrolUnlockPhone,
    PhoneUnlockAuthRequired,
  } from '../lib/device.svelte.js'
  import {
    parseEnrolmentCode, enrolPhone, HandOffUndelivered,
    type EnrolmentCode, type EnrolResult, type UnlockPhoneList,
  } from '../lib/phone-unlock.js'
  import ConfirmButton from './ConfirmButton.svelte'
  import QrScanner from './QrScanner.svelte'

  interface Props {
    /** Enrolled phones, or null while unknown (for the mode chooser). */
    count?: number | null
  }
  let { count = $bindable(null) }: Props = $props()

  const overUsb = $derived(device.mode === 'serial')

  type Support = 'checking' | 'unsupported' | 'needs-auth' | 'ready' | 'error'
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

  $effect(() => {
    if (device.connected && (device.mode === 'serial' || device.mode === 'relay')) {
      void load()
    } else {
      support = 'unsupported'
      list = null
    }
  })

  // --- Revoke ---
  let revoking = $state<number | null>(null)
  let revokeStatus = $state<string | null>(null)

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
  type Step = 'idle' | 'scan' | 'paste' | 'confirm' | 'working' | 'done' | 'failed'
  let step = $state<Step>('idle')
  let pasted = $state('')
  let code = $state<EnrolmentCode | null>(null)
  let working = $state<string | null>(null)
  let result = $state<EnrolResult | null>(null)
  let addError = $state<string | null>(null)
  /** Set once the board has been asked: its enrolment key is then spent. */
  let codeSpent = $state(false)

  const pastedCode = $derived(pasted.trim() ? parseEnrolmentCode(pasted) : null)

  function startAdd(mode: 'scan' | 'paste') {
    step = mode
    pasted = ''
    code = null
    result = null
    addError = null
    codeSpent = false
  }

  function accept(text: string): boolean {
    const parsed = parseEnrolmentCode(text)
    if (!parsed) return false
    code = parsed
    step = 'confirm'
    return true
  }

  function friendly(reason: string): string {
    if (/set a PIN or vault key first/i.test(reason)) {
      return 'Phone unlock opens encrypted storage, and this signer is not encrypted. Turn on Encrypt at rest (Security, below) or set a boot PIN, then add the phone with a new code.'
    }
    if (/declined on the board/i.test(reason)) {
      return 'Declined on the signer, so nothing was added. Each code works once: start again on the phone for a new one.'
    }
    if (/already used/i.test(reason)) {
      return 'The signer has already seen this code. Start again on the phone for a new one.'
    }
    if (/relays configured/i.test(reason)) {
      return 'The signer has no WiFi relays set, so it could never reach a phone. Set its network up first (Network, above).'
    }
    if (/unlock the board first/i.test(reason)) {
      return 'Unlock the signer first.'
    }
    return reason
  }

  async function add() {
    if (!code) return
    step = 'working'
    addError = null
    working = 'Reaching the phone\'s relays…'
    const pool = new SimplePool()
    try {
      result = await enrolPhone(code, {
        pool,
        enrol: async (enrolPubkey, label) => {
          codeSpent = true
          device.awaitingButton = `Confirm on your signer: it shows “Add unlock phone?” and ${label}. Hold its button within 30 seconds.`
          try {
            return await enrolUnlockPhone(enrolPubkey, label)
          } finally {
            device.awaitingButton = null
          }
        },
        onBoard: () => { working = 'Waiting for the signer\'s button…' },
      })
      step = 'done'
    } catch (e) {
      addError = e instanceof HandOffUndelivered
        ? e.message
        : friendly(e instanceof Error ? e.message : 'Adding the phone failed.')
      step = 'failed'
    } finally {
      working = null
      try { pool.destroy() } catch { /* already closed */ }
      if (codeSpent) void load(true)
    }
  }
</script>

<div class="unlock-phones">
  <h3 class="sub-title">Phones that can unlock</h3>
  <p class="hint">A phone running Cambium can unlock this signer after a power cut: it shows
    a notification, and one tap plus the phone's screen lock sends the unlock. Nothing on the
    wire names the phone. A lost phone is revoked here without changing anything else.</p>

  {#if support === 'checking'}
    <p class="hint-sm">Asking the signer…</p>
  {:else if support === 'unsupported'}
    <p class="hint-sm">This signer's firmware has no phone unlock. It arrived in 0.18.0-beta.17.</p>
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
              question={`Stop ${phone.label} unlocking this signer?`}
              confirmLabel="Yes, revoke"
              busyLabel="Revoking…"
              busy={revoking === phone.id}
              disabled={revoking !== null}
              onconfirm={() => revoke(phone.id, phone.label)}
            />
          </li>
        {/each}
      </ul>
      <p class="hint-sm">{list.phones.length} of {list.max}.{#if list.phones.length === 1}
        Add a second device (a spare, or a family member's phone) so losing this one abroad does not
        leave the signer locked.{/if}</p>
    {/if}
    {#if revokeStatus}<p class="hint-sm status">{revokeStatus}</p>{/if}

    {#if step === 'idle'}
      {#if overUsb}
        <div class="inline-form">
          <button class="btn btn-secondary btn-sm" disabled={list.phones.length >= list.max}
            onclick={() => startAdd('scan')}>Add a phone</button>
          <button class="btn btn-ghost btn-sm" disabled={list.phones.length >= list.max}
            onclick={() => startAdd('paste')}>Paste a code instead</button>
        </div>
      {:else}
        <p class="hint-sm">Adding a phone needs the signer on the USB cable and a press on its button.</p>
      {/if}
    {:else}
      <div class="add card">
        {#if step === 'scan' || step === 'paste'}
          <p class="hint-sm">On the phone, open Cambium and tap “Set up phone unlock” under this
            signer. It shows a code; nothing in it is secret. Its “Copy code” button gives the text
            to paste here.</p>
          {#if step === 'scan'}
            <QrScanner onresult={accept} oncancel={() => { step = 'paste' }} />
          {:else}
            <textarea class="field-input code-input" rows="3" spellcheck="false" autocomplete="off"
              placeholder="heartwood-unlock:enrol?v=1&amp;…" bind:value={pasted}></textarea>
            {#if pasted.trim() && !pastedCode}
              <p class="warn-text">That is not a phone-unlock code from Cambium.</p>
            {/if}
            <div class="inline-form">
              <button class="btn btn-secondary btn-sm" disabled={!pastedCode}
                onclick={() => accept(pasted)}>Use this code</button>
              <button class="btn btn-ghost btn-sm" onclick={() => startAdd('scan')}>Scan instead</button>
            </div>
          {/if}
          <button class="btn btn-ghost btn-sm" onclick={() => { step = 'idle' }}>Cancel</button>
        {:else if step === 'confirm' && code}
          <table class="kv-table"><tbody>
            <tr><td class="label">Phone</td><td>{code.label}</td></tr>
            <tr><td class="label">Waiting on</td><td>
              {#each code.relays as relay}<div class="mono">{relay}</div>{/each}
            </td></tr>
          </tbody></table>
          <p class="hint-sm">The signer will show “Add unlock phone?” with this name. Hold its button
            to agree. The signer then seals the phone's unlock secret to the phone, and Sapwood passes
            it on without being able to read it.</p>
          <div class="inline-form">
            <button class="btn btn-primary btn-sm" onclick={add}>Add {code.label}</button>
            <button class="btn btn-ghost btn-sm" onclick={() => { step = 'idle' }}>Cancel</button>
          </div>
        {:else if step === 'working'}
          <p class="hint-sm">{working}</p>
        {:else if step === 'done' && result}
          <p class="success-text">The signer added {code?.label} as record {result.id}.</p>
          <p class="hint-sm">The phone should now show these six characters:</p>
          <p class="check-code mono">{result.checkCode}</p>
          <p class="hint-sm">If they match, confirm on the phone with its screen lock. If they do
            not, someone else answered the phone first: revoke record {result.id} now and start
            again.</p>
          <button class="btn btn-secondary btn-sm" onclick={() => { step = 'idle' }}>Finished</button>
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
        turn it off; Sapwood can still unlock over USB.</p>
      <div class="lq-buttons">
        <button class="btn btn-sm" class:btn-secondary={!list.announceOperator} class:lq-on={list.announceOperator}
          disabled={announcePending || list.announceOperator} onclick={() => changeAnnounce(true)}>On</button>
        <button class="btn btn-sm" class:btn-secondary={list.announceOperator} class:lq-on={!list.announceOperator}
          disabled={announcePending || !list.announceOperator} onclick={() => changeAnnounce(false)}>Off</button>
      </div>
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
  .add { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.8rem; align-items: flex-start; }
  .code-input { width: 100%; box-sizing: border-box; font-size: 0.8rem; resize: vertical; }
  .check-code { font-size: 2rem; letter-spacing: 0.2em; color: var(--green); margin: 0.2rem 0; }
  .status { margin-top: 0.6rem; color: var(--text-dim); }
  .announce { margin-top: 1rem; }
  .lq-buttons { display: flex; gap: 0.5rem; margin: 0.4rem 0; }
  .lq-on { border-color: var(--green-dim); color: var(--green); background: #08130d; }
</style>

<script lang="ts">
  // Locked-signer banner — encrypted-at-rest ("vault key") unlock.
  //
  // USB: a PROVISION_LIST row with locked:true means the signer booted into
  //   "Locked — Await unlock" and refuses everything until VAULT_UNLOCK lands
  //   over an authenticated bridge session.
  // WiFi: a locked signer can't answer management at all; it announces on
  //   kind 24135 (one-time unlock keypair, p-tagged to the operator) and we
  //   answer with a kind-24136 NIP-44 delivery. Delivery is manual-tap only,
  //   never automatic: an announcement proves someone powered the device on,
  //   not that the owner did.
  import {
    device, serialTransport, ensureBridgeAuth, refreshMasters, sendVaultKeyOverRelay,
  } from '../lib/device.svelte.js'
  import { npubToHex } from '../lib/known-devices.js'
  import { loadVaultKey, storeVaultKey, normaliseVaultKeyHex, serialVaultUnlock } from '../lib/vault.js'

  // Announcements re-publish about every 60s while locked; older than this
  // and the signer has either unlocked or gone quiet — stop asking.
  const ANNOUNCE_STALE_MS = 150_000

  let now = $state(Date.now())
  $effect(() => {
    const tick = setInterval(() => { now = Date.now() }, 15_000)
    return () => clearInterval(tick)
  })

  const usbLocked = $derived(device.mode === 'serial' && device.masters.some((m) => m.locked === true))
  const relayAsking = $derived(
    device.mode === 'relay'
    && !!device.vaultUnlockRequest
    && now - device.vaultUnlockRequest.lastSeen < ANNOUNCE_STALE_MS,
  )

  // The identity the vault key is stored against: the signer's master pubkey
  // (first non-persona row over USB; the management address over WiFi).
  const deviceKey = $derived(
    device.mode === 'relay'
      ? device.relayDevicePub || null
      : npubToHex(device.masters.find((m) => !m.persona)?.npub ?? ''),
  )

  let storedKey = $state<string | null>(null)
  $effect(() => { storedKey = deviceKey ? loadVaultKey(deviceKey) : null })

  let pasteValue = $state('')
  let busy = $state(false)
  let status = $state<string | null>(null)
  let sent = $state(false)

  // A fresh announcement (new one-time pubkey) resets any stale "sent" note;
  // the same one re-publishing does not.
  let lastUnlockPub = $state<string | null>(null)
  $effect(() => {
    const pub = device.vaultUnlockRequest?.unlockPub ?? null
    if (pub !== lastUnlockPub) {
      lastUnlockPub = pub
      if (pub) sent = false
    }
  })

  function pastedKey(): string | null {
    return normaliseVaultKeyHex(pasteValue)
  }

  /** Unlock over USB: SESSION_AUTH (pairing hold if first time) then VAULT_UNLOCK. */
  async function unlockUsb(keyHex: string, remember: boolean) {
    if (!deviceKey) { status = 'The signer did not name an identity to unlock.'; return }
    busy = true
    status = null
    try {
      await ensureBridgeAuth()
      await serialVaultUnlock(serialTransport, keyHex)
      if (remember) {
        storeVaultKey(deviceKey, keyHex)
        storedKey = keyHex
      }
      pasteValue = ''
      status = 'Unlocked. The signer is resuming normally.'
      try { await refreshMasters() } catch { /* the signer may reboot to resume */ }
    } catch (e) {
      status = e instanceof Error ? e.message : 'Unlock failed.'
    } finally {
      busy = false
    }
  }

  /** Unlock over WiFi: kind-24136 delivery to the announced one-time pubkey. */
  async function unlockRelay(keyHex: string | undefined, remember: boolean) {
    busy = true
    status = null
    try {
      await sendVaultKeyOverRelay(keyHex)
      if (remember && keyHex && deviceKey) {
        storeVaultKey(deviceKey, keyHex)
        storedKey = keyHex
      }
      pasteValue = ''
      sent = true
    } catch (e) {
      status = e instanceof Error ? e.message : 'Could not deliver the vault key.'
    } finally {
      busy = false
    }
  }
</script>

{#if usbLocked}
  <section class="card card--warn vault-banner" role="alert">
    <h2 class="vault-title">Signer is locked</h2>
    <p class="hint no-gap">
      Its keys are encrypted at rest, so it signs nothing until it is unlocked.
      It shows <strong>“Locked — Await unlock”</strong>.
    </p>
    {#if storedKey}
      <div class="vault-actions">
        <button class="btn btn-warn" disabled={busy} onclick={() => unlockUsb(storedKey!, false)}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </div>
      <p class="hint-sm vault-sub">Uses the vault key held by this browser.</p>
    {:else}
      <p class="hint-sm vault-sub">
        This browser doesn't hold the vault key. Paste the copy you escrowed to unlock.
      </p>
      <div class="vault-actions">
        <input
          class="field-input vault-key-input"
          bind:value={pasteValue}
          placeholder="64 hex characters"
          maxlength="64"
          spellcheck="false"
          autocomplete="off"
          disabled={busy}
        />
        <button class="btn btn-warn" disabled={busy || !pastedKey()} onclick={() => unlockUsb(pastedKey()!, true)}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </div>
    {/if}
    {#if status}<p class="hint-sm vault-status">{status}</p>{/if}
  </section>
{:else if relayAsking}
  <section class="card card--warn vault-banner" role="alert">
    <h2 class="vault-title">Signer is locked</h2>
    <p class="hint no-gap">
      Your signer is locked and asking for its vault key — unlock? Only do this if you know
      it just rebooted.
    </p>
    {#if storedKey}
      <div class="vault-actions">
        <button class="btn btn-warn" disabled={busy} onclick={() => unlockRelay(undefined, false)}>
          {busy ? 'Sending…' : 'Unlock'}
        </button>
      </div>
      <p class="hint-sm vault-sub">
        Sends the vault key held by this browser, encrypted so only the signer's one-time
        unlock key can read it.
      </p>
    {:else}
      <p class="hint-sm vault-sub">
        This browser doesn't hold the vault key. Paste the copy you escrowed to unlock.
      </p>
      <div class="vault-actions">
        <input
          class="field-input vault-key-input"
          bind:value={pasteValue}
          placeholder="64 hex characters"
          maxlength="64"
          spellcheck="false"
          autocomplete="off"
          disabled={busy}
        />
        <button class="btn btn-warn" disabled={busy || !pastedKey()} onclick={() => unlockRelay(pastedKey()!, true)}>
          {busy ? 'Sending…' : 'Unlock'}
        </button>
      </div>
    {/if}
    {#if status}<p class="hint-sm vault-status">{status}</p>{/if}
  </section>
{:else if sent && device.mode === 'relay'}
  <section class="card card--live vault-banner" role="status">
    <p class="hint no-gap">
      Vault key sent. The signer should unlock within a few seconds; this screen recovers
      on its own once it does.
    </p>
  </section>
{/if}

<style>
  .vault-banner { padding: 1.2rem 1.4rem; }
  .vault-title { font-size: 1.05rem; font-weight: 700; color: var(--amber); margin: 0 0 0.5rem; }
  .vault-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-top: 0.8rem; }
  .vault-key-input { font-size: 0.85rem; padding: 0.45rem 0.7rem; flex: 1; min-width: 16rem; }
  .vault-sub { margin: 0.5rem 0 0; }
  .vault-status { margin: 0.6rem 0 0; color: var(--text-dim); }
</style>

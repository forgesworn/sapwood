<script lang="ts">
  // The Apps section of the advanced console — one surface for every transport.
  // Over WiFi and USB it manages apps through the mgmt* layer; over a bridge it
  // talks HTTP. The transport only changes the plumbing and a few capabilities
  // (pending approvals and per-app links exist only on the bridge; pre-approval
  // needs operator authority), never the vocabulary.
  import {
    device, refreshSlots, httpTransport,
    mgmtCreateClient, mgmtApproveSigning, mgmtRevokeClient, mgmtUpdateClient,
    mgmtCanApproveSigning, mgmtClientUri, mgmtApplyKithmootPermissions, mgmtWithdrawConsent,
  } from '../lib/device.svelte.js'
  import { kindLabelPlain as kindLabel } from '../lib/kinds.js'
  import KindPermissions from './KindPermissions.svelte'
  import ClientConsent from './ClientConsent.svelte'
  import ApprovalQueue from './ApprovalQueue.svelte'
  import ConfirmButton from './ConfirmButton.svelte'
  import type { ConnectSlot } from '../lib/types.js'
  import { identityKey } from '../lib/identity-key.js'
  import { ensureProfiles, profileName } from '../lib/profiles.svelte.js'
  import { copyText } from '../lib/clipboard.js'
  import { bunkerHasRelay } from '../lib/bunker.js'
  import { exactPolicyFromSlot, fullClientPolicy } from '../lib/client-policy.js'
  import {
    kithmootUpgradeBlockedReason,
    kithmootPermissionChanges,
    permissionSlotUnchanged,
    type KithmootPermissionReview,
  } from '../lib/client-permission-upgrade.js'
  import { nip19 } from 'nostr-tools'

  const overBridge = $derived(device.mode === 'http')
  const overUsb = $derived(device.mode === 'serial')
  const overUsbRelay = $derived(device.mode === 'serial' || device.mode === 'relay')
  const canApprove = $derived(mgmtCanApproveSigning())
  // Master slots only: derived personas share their owner's slot table, so
  // they are not separate targets for app connections here.
  const identities = $derived(device.masters.filter((m) => !m.persona))
  const hasIdentity = $derived(device.masters.length > 0)
  // A USB device with no identity is the just-fell-through-from-setup state: an
  // app needs an identity to connect to, so point at Identity rather than show a
  // create form that cannot work. Over WiFi/bridge a signer always has one.
  const noIdentityUsb = $derived(device.connected && device.mode === 'serial' && !hasIdentity)

  // --- Create a connection ---
  let creating = $state(false)
  let newLabel = $state('')
  let preApprove = $state(true)
  let createError = $state<string | null>(null)
  // The created connection — the ONE time the link/secret is shown.
  let created = $state<{ bunker_uri: string; secret?: string; signing_approved?: boolean } | null>(null)
  let copied = $state<string | null>(null)

  // --- Existing apps ---
  let updatingSlot = $state<number | null>(null)
  let approvingSlot = $state<number | null>(null)
  let revokingSlot = $state<number | null>(null)

  // Per-app link reveal. USB/bridge re-issue the URI on demand; over WiFi the
  // signer emits a slot's secret only once, so after a reload there is nothing
  // to re-show — uriError carries that, and a fresh link can be minted in place.
  let uriForSlot = $state<number | null>(null)
  let uriValue = $state('')
  let uriError = $state<string | null>(null)
  let replacingSlot = $state<number | null>(null)

  // --- KithMoot private-rooms permission review (USB/relay only) ---
  let review = $state<KithmootPermissionReview | null>(null)
  let reviewBusy = $state(false)
  let reviewError = $state<string | null>(null)
  let reviewStatus = $state<string | null>(null)
  let reviewStatusSlot = $state<number | null>(null)

  function kithmootBlockedReason(slot: ConnectSlot): string | null {
    if (overBridge) return null
    return kithmootUpgradeBlockedReason(slot)
  }

  function openKithmootReview(slot: ConnectSlot) {
    if (reviewBusy) return
    const reason = kithmootUpgradeBlockedReason(slot)
    if (reason) return
    reviewError = null
    reviewStatus = null
    reviewStatusSlot = null
    // Explicit plain snapshot: the review is pinned to exactly this slot copy,
    // the master slot, the connection generation and the transport mode.
    review = {
      slot: JSON.parse(JSON.stringify(slot)) as ConnectSlot,
      masterSlot: device.selectedSlot,
      connectionGeneration: device.connectionGeneration,
      mode: device.mode === 'serial' ? 'serial' : 'relay',
    }
  }

  function closeKithmootReview() {
    if (reviewBusy) return
    review = null
    reviewError = null
  }

  async function confirmKithmootReview() {
    const r = review
    if (!r || reviewBusy) return
    // Abort a stale review before calling: it must still match the identity,
    // connection generation and transport it was opened under.
    if (
      r.masterSlot !== device.selectedSlot ||
      r.connectionGeneration !== device.connectionGeneration ||
      r.mode !== (device.mode === 'serial' ? 'serial' : 'relay')
    ) {
      reviewError = "This connection changed since the review opened. Close it and start again."
      return
    }
    // Check the cached slot too; the backend then reads the signer before writing.
    const fresh = device.slots.find((s) => s.slot_index === r.slot.slot_index)
    if (!fresh || !permissionSlotUnchanged(r.slot, fresh)) {
      reviewError = "This app's permissions changed since the review opened. Close it and start again."
      return
    }
    reviewBusy = true
    reviewError = null
    try {
      await mgmtApplyKithmootPermissions(r)
      // The backend verifies the pinned context and applies the change before
      // returning, so the call resolving is the success signal. No local
      // refresh: a refresh failure must not turn a successful write into a
      // contradictory UI, and the device table is authoritative on next read.
      review = null
      reviewError = null
      reviewStatus = 'KithMoot rooms enabled. Existing permissions were kept.'
      reviewStatusSlot = r.slot.slot_index
    } catch (e) {
      reviewError = e instanceof Error ? e.message : 'Could not apply the permission change on the device.'
    } finally {
      reviewBusy = false
    }
  }

  function methodLabel(m: string): string {
    switch (m) {
      case 'get_public_key': return 'Read the public key'
      case 'sign_event': return 'Sign events'
      case 'nip44_encrypt': return 'Encrypt messages (NIP-44)'
      case 'nip44_decrypt': return 'Decrypt messages (NIP-44)'
      case 'connect': return 'Connect'
      case 'ping': return 'Ping'
      default: return m
    }
  }

  // Advanced raw bunker URI (bridge multi-instance mode only).
  const selectedBunkerUri = $derived(
    device.masters.find((m) => m.slot === device.selectedSlot)?.bunkerUri ?? ''
  )

  $effect(() => { if (device.connected) refreshSlots() })

  // Resolve display names for the connected app pubkeys.
  $effect(() => {
    const pubkeys = [
      ...device.pendingClients.map((p) => p.pubkey),
      ...device.slots.map((s) => s.current_pubkey).filter((pk): pk is string => !!pk),
      ...device.slots.flatMap((s) => s.authorized_pubkeys ?? []),
    ]
    if (pubkeys.length) ensureProfiles(pubkeys)
  })

  async function handleCreate() {
    const label = newLabel.trim()
    if (!label) { createError = 'Name is required.'; return }
    creating = true
    createError = null
    created = null
    try {
      if (overBridge) {
        const result = await httpTransport.createSlot(device.selectedSlot, label)
        let uri = (result.bunker_uri as string) ?? ''
        // heartwoodd returns { slot_index, secret, npub } without bunker_uri —
        // fetch the full URI from the slot endpoint.
        if (!uri && result.slot_index !== undefined) {
          try { uri = await httpTransport.getSlotUri(device.selectedSlot, result.slot_index as number) }
          catch { /* non-fatal */ }
        }
        created = { bunker_uri: uri, secret: result.secret as string | undefined }
      } else {
        const res = await mgmtCreateClient(label, fullClientPolicy(canApprove && preApprove))
        created = { bunker_uri: res.bunker_uri, secret: res.secret, signing_approved: res.signing_approved }
      }
      newLabel = ''
    } catch (e) {
      createError = e instanceof Error ? e.message : 'Could not create the connection.'
    } finally {
      creating = false
    }
  }

  function dismissCreated() {
    created = null
    refreshSlots()
  }

  async function handleApprove(slot: ConnectSlot) {
    if (reviewBusy) return
    approvingSlot = slot.slot_index
    try { await mgmtApproveSigning(slot.slot_index, slot.secret_fingerprint) }
    catch (e) { device.error = e instanceof Error ? e.message : 'Approve failed' }
    finally { approvingSlot = null }
  }

  async function handleRevoke(slot: ConnectSlot) {
    if (reviewBusy) return
    revokingSlot = slot.slot_index
    try {
      if (overBridge) {
        await httpTransport.revokeSlot(device.selectedSlot, slot.slot_index)
        await refreshSlots()
      } else {
        await mgmtRevokeClient(slot.slot_index, slot.secret_fingerprint)
      }
    } catch (e) {
      device.error = e instanceof Error ? e.message : 'Disconnect failed'
    } finally {
      revokingSlot = null
    }
  }

  async function handleUpdate(slot: ConnectSlot, changes: { label?: string; allowed_kinds?: number[] | null; auto_approve?: boolean }) {
    if (reviewBusy) return
    updatingSlot = slot.slot_index
    try {
      if (overBridge) {
        await httpTransport.updateSlot(device.selectedSlot, slot.slot_index, changes)
        await refreshSlots()
      } else {
        // The mgmt layer expects an explicit list; empty means unrestricted.
        const mapped = { ...changes, ...(changes.allowed_kinds !== undefined ? { allowed_kinds: changes.allowed_kinds ?? [] } : {}) }
        await mgmtUpdateClient(
          slot.slot_index,
          mapped as { label?: string; allowed_kinds?: number[]; auto_approve?: boolean },
          slot.secret_fingerprint,
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Update failed'
      device.error = /denied/i.test(msg) ? 'Update denied on device.'
        : /timeout/i.test(msg) ? 'Timed out waiting for the device to confirm.'
        : msg
    } finally {
      updatingSlot = null
    }
  }

  // Bridge-only: rename via the approve endpoint (it upserts the label).
  async function renameSlot(slot: ConnectSlot, next: string) {
    const trimmed = next.trim()
    if (!trimmed || trimmed === slot.label || !slot.current_pubkey) return
    const ok = await httpTransport.approveClient(device.selectedSlot, slot.current_pubkey, trimmed)
    if (ok) await refreshSlots()
  }

  async function approveWithLabel(pubkey: string, label: string) {
    const ok = await httpTransport.approveClient(device.selectedSlot, pubkey, label.trim() || 'approved')
    if (ok) await refreshSlots()
  }

  async function toggleUri(slot: ConnectSlot) {
    if (reviewBusy) return
    if (uriForSlot === slot.slot_index) {
      uriForSlot = null
      uriValue = ''
      uriError = null
      return
    }
    uriForSlot = slot.slot_index
    uriValue = ''
    uriError = null
    try { uriValue = await mgmtClientUri(slot.slot_index, slot.secret_fingerprint) }
    catch {
      // Older WiFi firmware may not be able to re-show a link after a reload.
      // Current firmware can reissue it because the slot secret is reusable.
      uriError = slot.current_pubkey
        ? 'This firmware could not reissue the link. Update the signer, or create a fresh connection for this app.'
        : 'This pending link could not be fetched from the signer. Create a fresh one to finish pairing.'
    }
  }

  // Mint a replacement pairing link for a slot whose link cannot be fetched
  // (older WiFi firmware, post-reload). Preserves the name, permissions and
  // signing setting, then removes the stale pending slot. The fresh link surfaces in the
  // "Connection ready" box above, ready to copy into the app.
  async function replaceLink(slot: ConnectSlot) {
    if (reviewBusy) return
    replacingSlot = slot.slot_index
    uriError = null
    try {
      const label = slot.label || `app ${slot.slot_index}`
      const res = await mgmtCreateClient(label, exactPolicyFromSlot(slot))
      // Best-effort: drop the stale pending slot so it doesn't linger.
      try { await mgmtRevokeClient(slot.slot_index, slot.secret_fingerprint) } catch { /* leave the orphan */ }
      created = { bunker_uri: res.bunker_uri, secret: res.secret, signing_approved: res.signing_approved }
      uriForSlot = null
      await refreshSlots()
    } catch (e) {
      uriError = e instanceof Error ? e.message : 'Could not create a fresh link.'
    } finally {
      replacingSlot = null
    }
  }

  function handleIdentityChange(e: Event) {
    device.selectedSlot = parseInt((e.target as HTMLSelectElement).value)
    created = null
    uriForSlot = null
    // Closing the review on identity switch is safe: the backend re-checks the
    // pinned context anyway.
    review = null
    reviewError = null
    refreshSlots(device.selectedSlot)
  }

  async function copy(text: string, which: string) {
    if (await copyText(text)) {
      copied = which
      setTimeout(() => { if (copied === which) copied = null }, 1800)
    }
  }

  function shortPubkey(hex: string): string {
    return hex.slice(0, 8) + ' · ' + hex.slice(-8)
  }

  function connectedKeyCount(slot: ConnectSlot): number {
    return new Set([
      ...(slot.current_pubkey ? [slot.current_pubkey] : []),
      ...(slot.authorized_pubkeys ?? []),
    ]).size
  }

  // Read-only display of the identities this slot has been physically
  // approved to act as (heartwood_list_identities / identity-scope). No
  // revoke UI, no new frame calls: `slot.approved_identities` (relay path,
  // already split) or `slot.ids` (USB/backup path, 16-hex-char tags
  // concatenated with no separator) are whatever the device/backup handed us.
  function identityTags(slot: ConnectSlot): string[] {
    if (slot.approved_identities?.length) return slot.approved_identities
    const raw = slot.ids ?? ''
    const tags: string[] = []
    for (let i = 0; i + 16 <= raw.length; i += 16) tags.push(raw.slice(i, i + 16))
    return tags
  }

  // Match a tag (first 8 bytes of an x-only pubkey, as lower hex) to a known
  // persona/master's npub; falls back to the raw tag if nothing matches.
  function identityTagLabel(tag: string): string {
    for (const m of device.masters) {
      try {
        const decoded = nip19.decode(m.npub)
        if (decoded.type === 'npub' && (decoded.data as string).toLowerCase().startsWith(tag.toLowerCase())) {
          return m.label || m.npub.slice(0, 12)
        }
      } catch { /* unparsable npub: skip */ }
    }
    return tag.length > 16 ? shortPubkey(tag) : tag
  }

  function timeAgo(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime()
    if (ms < 60_000) return 'just now'
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
    return `${Math.floor(ms / 86_400_000)}d ago`
  }
</script>

<div class="apps">
  <div class="head">
    <h2 class="section-title head-title">Apps</h2>
    <div class="head-controls">
      <button class="btn btn-secondary btn-sm" onclick={() => refreshSlots()}>Refresh</button>
    </div>
  </div>

  {#if noIdentityUsb}
    <section class="card card--warn no-identity">
      <h3 class="ni-title">This signer has no identity yet</h3>
      <p class="hint no-gap">An app connects to an identity, so add one first: open the
        <strong>Identity</strong> tab and use “Add an identity to this signer”. Then come back here
        to connect your apps.</p>
    </section>
  {/if}

  <!-- Every app binds to ONE identity: this bar names it, switches it, and
       scopes both the create form and the list below. Works on every
       transport — over the relay each management request is simply addressed
       to the selected identity's own pubkey. -->
  {#if identities.length > 1}
    <section class="identity-bar">
      <span class="identity-bar-label">Apps below connect and sign as</span>
      <select class="field-input identity-pick" aria-label="Identity apps sign as" value={device.selectedSlot} onchange={handleIdentityChange}>
        {#each identities as master (identityKey(master))}
          <option value={master.slot}>{master.label ?? master.slot}{typeof master.apps === 'number' ? ` · ${master.apps} app${master.apps === 1 ? '' : 's'}` : ''}</option>
        {/each}
      </select>
    </section>
  {/if}

  <!-- New connection -->
  {#if !noIdentityUsb}
  <section class="card card--raised new-connection">
    {#if created}
      <div class="created-head">
        <span class="dot"></span>
        <span class="created-title">Connection ready{created.signing_approved ? ', signing allowed' : ''}</span>
        <button class="btn-link" onclick={dismissCreated}>Dismiss</button>
      </div>
      {#if created.bunker_uri && bunkerHasRelay(created.bunker_uri)}
        <p class="hint">Paste this link into the app (or scan it there). It carries the connection secret, shown once.</p>
        <div class="uri-box">
          <code>{created.bunker_uri}</code>
          <button class="btn btn-secondary btn-sm" onclick={() => copy(created!.bunker_uri, 'created')}>
            {copied === 'created' ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      {:else}
        <p class="warn-text">Created, but the link names no relay, so a remote app like Primal cannot
          reach the signer (it reports “no relays specified”). Set the signer's relays under
          Device › Network, then reopen the connection.
          {#if created.secret}The secret is <code class="inline-secret">{created.secret}</code>.{/if}</p>
      {/if}
      {#if created.signing_approved === false}
        <p class="warn-text">Signing is not allowed yet. The app can connect, but its first signature needs
          {overUsb ? 'one press of the button on the device' : 'approval (use “Allow signing” below)'}.</p>
      {/if}
    {:else}
      <form class="create-form" onsubmit={(e) => { e.preventDefault(); handleCreate() }}>
        <input
          type="text"
          class="field-input"
          bind:value={newLabel}
          placeholder="Name this connection (e.g. Damus on my phone)"
          disabled={creating}
        />
        <button type="submit" class="btn btn-primary" disabled={creating || !newLabel.trim()}>
          {creating ? 'Creating…' : 'New connection'}
        </button>
      </form>
      {#if !overBridge}
        {#if canApprove}
          <label class="approve-toggle">
            <input type="checkbox" bind:checked={preApprove} disabled={creating} />
            <span>Allow any event to be signed straight away (unrestricted). Use the guided connection above for a narrower policy.</span>
          </label>
        {:else}
          <p class="hint-sm usb-note">Over USB the first management action, and each app's first signature,
            are approved with a press of the button on the device.</p>
        {/if}
      {/if}
      {#if createError}<p class="error-text">{createError}</p>{/if}
    {/if}
  </section>
  {/if}

  <!-- Bridge approval queue (renders nothing when empty) -->
  <ApprovalQueue />

  <!-- Apps awaiting approval (bridge TOFU) -->
  {#if device.pendingClients.length > 0}
    <section class="card card--warn">
      <h3 class="section-label section-label--amber">Awaiting approval</h3>
      {#each device.pendingClients as pc (pc.pubkey)}
        {@const ago = pc.lastSeen ? timeAgo(pc.lastSeen) : ''}
        {@const pname = profileName(pc.pubkey)}
        <div class="pending-row">
          <div class="pending-left">
            <code class="pending-pk">{pc.pubkey}</code>
            {#if pname}<span class="profile-name">{pname}</span>{/if}
            <span class="hint-sm">{pc.attempts} attempt{pc.attempts !== 1 ? 's' : ''}{ago ? ` · ${ago}` : ''}</span>
          </div>
          <div class="pending-right">
            <input
              class="field-input pending-label"
              type="text"
              placeholder="name"
              onkeydown={(e) => { if (e.key === 'Enter') { const el = e.target as HTMLInputElement; approveWithLabel(pc.pubkey, el.value) } }}
            />
            <button class="btn btn-primary btn-sm" onclick={(e) => {
              const input = (e.target as HTMLElement).closest('.pending-right')?.querySelector('input') as HTMLInputElement | null
              approveWithLabel(pc.pubkey, input?.value ?? '')
            }}>Approve</button>
          </div>
        </div>
      {/each}
    </section>
  {/if}

  <!-- Connected apps -->
  {#if !device.connected}
    <p class="empty centred">Connect to your signer to see its apps.</p>
  {:else if noIdentityUsb}
    <!-- The no-identity notice above already says what to do; don't also claim there's a form here. -->
  {:else if device.slots.length === 0 && device.pendingClients.length === 0 && !created}
    <p class="empty centred">No apps connected yet. Create a connection above and paste the link into your app.</p>
  {:else if device.slots.length > 0}
    <section>
      <h3 class="section-label">Connected</h3>
      {#each device.slots as slot (slot.slot_index)}
        <div class="card app-card">
          <div class="app-row">
            <div class="app-identity">
              {#if overBridge}
                <input
                  class="app-name-input"
                  type="text"
                  value={slot.label}
                  onblur={(e) => renameSlot(slot, (e.target as HTMLInputElement).value)}
                  onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                />
              {:else}
                <span class="app-name">{slot.label || `app ${slot.slot_index}`}</span>
              {/if}
              {#if slot.current_pubkey}
                {@const pname = profileName(slot.current_pubkey)}
                <span class="app-pk" title="slot {slot.slot_index}">{shortPubkey(slot.current_pubkey)}</span>
                {#if connectedKeyCount(slot) > 1}
                  <span class="app-pk">{connectedKeyCount(slot)} client keys remembered</span>
                {/if}
                {#if pname}<span class="profile-name">{pname}</span>{/if}
              {:else}
                <span class="app-pk waiting">waiting for the app to connect</span>
              {/if}
            </div>
            <div class="app-actions">
              {#if slot.signing_approved}
                <span class="tag tag--blue" title="This app is allowed to sign">CAN SIGN</span>
              {:else if canApprove && !slot.strict_permissions}
                <button class="btn btn-secondary btn-sm allow" disabled={approvingSlot === slot.slot_index || reviewBusy} onclick={() => handleApprove(slot)}>
                  {approvingSlot === slot.slot_index ? 'Allowing…' : 'Allow signing'}
                </button>
              {:else if slot.strict_permissions && !(slot.allowed_methods ?? []).includes('sign_event')}
                <span class="tag" title="Signing is outside this app's exact policy">NO SIGNING</span>
              {:else if !overBridge}
                <span class="tag" title="First signature approved by a press of the button on the device">BUTTON</span>
              {/if}
              {#if slot.signing_approved || !slot.strict_permissions}
                <button
                  class="tag"
                  class:tag--green={slot.auto_approve}
                  title={slot.auto_approve ? 'Signs without asking. Click to require the button per signature' : 'Each signature needs the button. Click to sign automatically'}
                  disabled={updatingSlot === slot.slot_index || reviewBusy}
                  onclick={() => handleUpdate(slot, { auto_approve: !slot.auto_approve })}
                >
                  {slot.auto_approve ? 'AUTO' : 'MANUAL'}
                </button>
              {/if}
              <button class="btn btn-secondary btn-sm" disabled={reviewBusy} onclick={() => toggleUri(slot)}>
                {uriForSlot === slot.slot_index ? 'Hide link' : 'Link'}
              </button>
              <ConfirmButton
                label="Disconnect"
                question="Disconnect “{slot.label || `app ${slot.slot_index}`}”?"
                confirmLabel="Yes, disconnect"
                busyLabel="Disconnecting…"
                busy={revokingSlot === slot.slot_index}
                onconfirm={() => handleRevoke(slot)}
              />
            </div>
          </div>

          {#if uriForSlot === slot.slot_index && uriValue && bunkerHasRelay(uriValue)}
            <div class="uri-box slot-uri">
              <code>{uriValue}</code>
              <button class="btn btn-secondary btn-sm" onclick={() => copy(uriValue, `slot-${slot.slot_index}`)}>
                {copied === `slot-${slot.slot_index}` ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            <p class="hint-sm slot-uri-note">This link is reusable for this app slot. The signer remembers each client key that connects with it.</p>
          {:else if uriForSlot === slot.slot_index && uriValue}
            <div class="link-gone">
              <p class="warn-text no-gap">This link names no relay, so a remote app cannot reach the
                signer. Set the signer's relays under Device › Network, then reopen the connection.</p>
            </div>
          {:else if uriForSlot === slot.slot_index && uriError}
            <div class="link-gone">
              <p class="warn-text no-gap">{uriError}</p>
              {#if !slot.current_pubkey}
                <button class="btn btn-secondary btn-sm" disabled={replacingSlot === slot.slot_index} onclick={() => replaceLink(slot)}>
                  {replacingSlot === slot.slot_index ? 'Creating…' : 'Replace with a fresh link'}
                </button>
              {/if}
            </div>
          {/if}

          {#key `${device.connectionGeneration}:${device.selectedSlot}:${slot.secret_fingerprint ?? slot.slot_index}`}
            <ClientConsent {slot} canRevoke={overUsbRelay && !reviewBusy}
              identityLabel={identityTagLabel}
              onrevoke={(client, identity) => mgmtWithdrawConsent(slot, client, identity)} />
          {/key}

          <KindPermissions
            allowedKinds={slot.allowed_kinds}
            unrestricted={slot.allowed_kinds.length === 0}
            signingApproved={slot.signing_approved ?? true}
            autoApprove={slot.auto_approve}
            strictPermissions={slot.strict_permissions ?? false}
            signingIncluded={(slot.allowed_methods ?? []).includes('sign_event')}
            updating={updatingSlot === slot.slot_index || (reviewBusy && review?.slot.slot_index === slot.slot_index)}
            onchange={(kinds) => handleUpdate(slot, { allowed_kinds: kinds })}
          />

          {#if overUsbRelay}
            <div class="km-block">
              {#if review && review.masterSlot === device.selectedSlot && review.slot.slot_index === slot.slot_index}
                {@const changes = kithmootPermissionChanges(review.slot)}
                <div class="km-review">
                  <h4>Add KithMoot private rooms to “{review.slot.label || `app ${review.slot.slot_index}`}”?</h4>
                  <p class="km-note">Final signing methods:</p>
                  <ul class="km-list">
                    {#each changes.allowed_methods as m (m)}
                      <li>{methodLabel(m)} <code class="km-tech">{m}</code></li>
                    {/each}
                  </ul>
                  <p class="km-note">Final event kinds:</p>
                  {#if changes.allowed_kinds.length === 0}
                    <p class="km-note" role="status">All event kinds already allowed.</p>
                  {:else}
                    <ul class="km-list">
                      {#each changes.allowed_kinds as k (k)}
                        <li>{kindLabel(k)} <code class="km-tech">kind {k}</code></li>
                      {/each}
                    </ul>
                  {/if}
                  <p class="km-note">This adds account sign-in proofs (kind 21236), device credentials including person scope (kind 20460), and encrypted account settings including bookmarks and read positions (kind 30078). Whole-kind and NIP-44 permissions are not limited to KithMoot tags, rooms or recipients: the shared Bark, Cambium and My Signet pairing applies to every app it allows.</p>
                  <p class="km-note">Existing permissions, key and persona approvals and the manual-signing setting are kept. This adds no public posting, profile or deletion powers; any broader extras shown above remain.</p>
                  {#if review.slot.auto_approve === false}
                    <p class="km-note" role="status">Manual signing is kept: each signature still needs a press of the button on the device.</p>
                  {/if}
                  {#if reviewError}<p class="error-text" role="alert">{reviewError}</p>{/if}
                  <div class="km-actions">
                    <button class="btn btn-primary btn-sm" disabled={reviewBusy} onclick={confirmKithmootReview}>
                      {reviewBusy ? 'Applying…' : 'Confirm'}
                    </button>
                    <button class="btn btn-secondary btn-sm" disabled={reviewBusy} onclick={closeKithmootReview}>Cancel</button>
                  </div>
                </div>
              {:else}
                <div class="km-actions">
                  <button
                    class="btn btn-secondary btn-sm"
                    disabled={!!kithmootBlockedReason(slot) || reviewBusy}
                    onclick={() => openKithmootReview(slot)
                  }>Add KithMoot rooms</button>
                  {#if kithmootBlockedReason(slot)}
                    <span class="hint-sm" role="status">{kithmootBlockedReason(slot)}</span>
                  {/if}
                </div>
                {#if reviewStatus && reviewStatusSlot === slot.slot_index}
                  <p class="hint-sm km-ok" role="status">{reviewStatus}</p>
                {/if}
              {/if}
            </div>
          {:else}
            <p class="hint-sm km-guidance" role="status">Adding KithMoot rooms needs a USB or WiFi connection. Connect over USB or WiFi to change this app's permissions.</p>
          {/if}

          {#if identityTags(slot).length > 0}
            <p class="hint-sm identity-approved">Approved identities: {identityTags(slot).length} ({identityTags(slot).map(identityTagLabel).join(', ')})</p>
          {/if}
        </div>
      {/each}
    </section>
  {/if}

  <!-- Advanced: raw bunker URI (bridge multi-instance mode only) -->
  {#if overBridge && device.connected && selectedBunkerUri}
    <details class="disclosure">
      <summary>Advanced: raw bunker URI (no pre-authorisation)</summary>
      <div class="uri-box uri-box--muted">
        <code>{selectedBunkerUri}</code>
        <button class="btn btn-secondary btn-sm" onclick={() => copy(selectedBunkerUri, 'raw')}>
          {copied === 'raw' ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
    </details>
  {/if}
</div>

<style>
  .apps { display: flex; flex-direction: column; gap: 1.5rem; }

  .head { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; }
  .head-title { margin: 0; font-size: 1.3rem; }
  .head-controls { display: flex; align-items: center; gap: 0.75rem; }
  .identity-pick { width: auto; padding: 0.35rem 0.75rem; font-size: 0.85rem; }

  /* Which identity the create form and app list belong to */
  .identity-bar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem;
    border: 1px solid var(--green-dim); border-radius: 6px; background: #08130d;
    padding: 0.65rem 0.9rem; margin-bottom: 1rem;
  }
  .identity-bar-label { font-size: 0.85rem; color: var(--text-dim); }

  .new-connection { display: flex; flex-direction: column; }
  .create-form { display: flex; gap: 0.5rem; align-items: center; }
  .create-form input { flex: 1; }

  .approve-toggle {
    display: flex; gap: 0.5rem; align-items: flex-start; margin-top: 0.75rem;
    font-size: 0.78rem; color: var(--text-dim); line-height: 1.4;
  }
  .approve-toggle input { margin-top: 0.15rem; accent-color: var(--green); }
  .usb-note { margin-top: 0.6rem; }
  .inline-secret { color: var(--green); word-break: break-all; user-select: all; }

  .created-head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: var(--green-glow); }
  .created-title { font-weight: 600; font-size: 0.9rem; color: var(--green); flex: 1; }

  .pending-row {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem;
    padding: 0.6rem 0; border-top: 1px solid #221c00;
  }
  .pending-row:first-of-type { border-top: none; }
  .pending-left { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
  .pending-pk { font-size: 0.7rem; color: var(--text-dim); word-break: break-all; line-height: 1.4; }
  .pending-right { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
  .pending-label { width: 110px; padding: 0.3rem 0.6rem; font-size: 0.8rem; }

  .app-card { margin-bottom: 0.5rem; }
  .app-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .app-identity { min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }
  .app-name { color: #fff; font-size: 1rem; font-weight: 600; }
  .app-name-input {
    display: block; background: transparent; border: 1px solid transparent; border-radius: 3px;
    color: #fff; font-family: inherit; font-size: 1rem; font-weight: 600;
    padding: 0.1rem 0.35rem; margin: -0.1rem -0.35rem; max-width: 260px;
  }
  .app-name-input:hover { border-color: var(--border); }
  .app-name-input:focus { border-color: var(--green-dim); outline: none; background: #080808; }
  .app-pk { font-size: 0.8rem; color: var(--text-muted); letter-spacing: 0.02em; }
  .app-pk.waiting { font-style: italic; }
  .profile-name { font-size: 0.8rem; color: var(--green-dim); }
  .app-actions { display: flex; gap: 0.4rem; flex-shrink: 0; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .allow { color: var(--green); border-color: var(--green-dim); }
  .allow:hover:not(:disabled) { background: #002a12; border-color: var(--green); }

  .slot-uri { margin-top: 0.75rem; }
  .slot-uri-note { margin-top: 0.45rem; }
  .link-gone { margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.6rem; align-items: flex-start; }

  .empty.centred { text-align: center; padding: 2rem 0; }

  .km-block { margin-top: 0.75rem; border-top: 1px solid var(--border); padding-top: 0.75rem; }
  .km-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .km-review {
    display: flex; flex-direction: column; gap: 0.5rem;
    border: 1px solid var(--green-dim); border-radius: 6px; background: #08130d;
    padding: 0.75rem 0.9rem;
  }
  .km-review h4 { margin: 0; font-size: 0.95rem; color: var(--green); }
  .km-list {
    margin: 0; padding-left: 1.1rem; font-size: 0.82rem; color: var(--text-dim);
    display: flex; flex-direction: column; gap: 0.15rem;
  }
  .km-tech { font-size: 0.72rem; color: var(--text-muted); margin-left: 0.4rem; }
  .km-note { margin: 0; font-size: 0.78rem; color: var(--text-dim); line-height: 1.45; }
  .km-guidance { margin: 0.4rem 0 0; }
  .km-ok { color: var(--green); margin: 0.4rem 0 0; }
  @media (max-width: 640px) {
    .km-review { padding: 0.65rem 0.7rem; }
  }

  .no-identity { padding: 1.3rem 1.4rem; }
  .ni-title { font-size: 1.1rem; font-weight: 700; color: #cba24a; margin: 0 0 0.5rem; }

  @media (max-width: 640px) {
    .head { flex-wrap: wrap; }
    .create-form { flex-direction: column; align-items: stretch; }
    .create-form .btn { width: 100%; }
    .app-row { flex-wrap: wrap; }
    .app-actions { width: 100%; }
    .uri-box { flex-direction: column; }
    .uri-box .btn { width: 100%; }
  }
</style>

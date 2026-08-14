<script lang="ts">
  // Identity — everything about keys: the identities held on the signer, adding
  // one, the signer's public profile, and this browser's operator key.
  // Replaces the old Masters, Provision and half the Settings tab.
  import {
    device, refreshMasters, syncIdentityMeta, removeIdentity,
    serialDerivePersona, serialRemovePersona, serialRenamePersona,
  } from '../lib/device.svelte.js'
  import { httpTransport } from '../lib/http.js'
  import { identityKey } from '../lib/identity-key.js'
  import Provision from './Provision.svelte'
  import RecoveryWizard from './RecoveryWizard.svelte'
  import OperatorKey from './OperatorKey.svelte'
  import ProfileRelays from './ProfileRelays.svelte'
  import Nip05Card from './Nip05Card.svelte'

  const MODE_LABELS: Record<number, string> = {
    0: 'BUNKER',
    1: 'TREE-MNEMONIC',
    2: 'TREE-NSEC',
  }

  // --- Identity removal (destructive; button-gated on the signer) ---
  let confirmingSlot = $state<number | null>(null)
  let removeBusy = $state(false)
  let removeError = $state<string | null>(null)

  async function handleRemove(slot: number) {
    removeBusy = true
    removeError = null
    try {
      if (device.mode === 'serial') {
        await removeIdentity(slot)
      } else {
        await httpTransport.deleteMaster(slot)
        // The signer reboots after a removal, so a refresh can briefly fail.
        try { await refreshMasters() } catch { /* rebooting */ }
      }
      confirmingSlot = null
    } catch (e) {
      removeError = e instanceof Error ? e.message : 'Could not remove the identity.'
    } finally {
      removeBusy = false
    }
  }

  // --- Personas (registry entries; the signer derives, stores metadata only) ---
  // Create/rename/remove ride the NIP-46-over-USB path. The first use pairs
  // Sapwood as a manager client, which the signer confirms with its button.
  let personaName = $state('')
  let personaBusy = $state(false)
  let personaStatus = $state<string | null>(null)
  let personaError = $state<string | null>(null)
  let confirmingPersona = $state<string | null>(null)
  let renamingPersona = $state<string | null>(null)
  let renameValue = $state('')

  function personaNameError(name: string): string | null {
    const s = name.trim()
    if (!s) return 'Give the persona a name, for example gaming or work.'
    if (new TextEncoder().encode(s).length > 64) return 'Keep the name under 64 characters.'
    if (s.includes('|') || s.includes('\0')) return 'The name cannot contain the | character.'
    return null
  }

  async function handleCreatePersona() {
    const name = personaName.trim()
    const invalid = personaNameError(name)
    if (invalid) { personaError = invalid; return }
    personaBusy = true
    personaError = null
    personaStatus = 'Asking the signer to derive the persona. The first time, confirm the Sapwood pairing on its screen.'
    try {
      const persona = await serialDerivePersona(name)
      personaStatus = `Created ${persona.personaName}. It is addressable at ${persona.npub.slice(0, 16)}… and survives reboot.`
      personaName = ''
    } catch (e) {
      personaStatus = null
      personaError = e instanceof Error ? e.message : 'Could not create the persona.'
    } finally {
      personaBusy = false
    }
  }

  async function handleRemovePersona(npub: string) {
    personaBusy = true
    personaError = null
    try {
      await serialRemovePersona(npub)
      confirmingPersona = null
    } catch (e) {
      personaError = e instanceof Error ? e.message : 'Could not remove the persona.'
    } finally {
      personaBusy = false
    }
  }

  async function handleRenamePersona(npub: string) {
    personaBusy = true
    personaError = null
    try {
      await serialRenamePersona(npub, renameValue.trim())
      renamingPersona = null
      renameValue = ''
    } catch (e) {
      personaError = e instanceof Error ? e.message : 'Could not rename the persona.'
    } finally {
      personaBusy = false
    }
  }

  // --- Identity card (name + avatar) push to the signer ---
  let profileStatus = $state<string | null>(null)
  let profilePending = $state(false)

  async function handleSyncProfile() {
    if (device.mode !== 'serial' && device.mode !== 'relay') {
      profileStatus = 'Syncing the identity card needs a USB or WiFi connection.'
      return
    }
    profilePending = true
    profileStatus = 'Fetching the profile and resizing the picture…'
    try {
      const name = await syncIdentityMeta()
      profileStatus = name
        ? `Sent "${name}" and its picture to the signer.`
        : 'No profile found for this identity on the profile relays yet.'
    } catch (e) {
      profileStatus = e instanceof Error ? e.message : 'Could not sync the profile.'
    } finally {
      profilePending = false
    }
  }
</script>

<div class="identity-panel">
  <!-- Identities held on the signer -->
  <section>
    <div class="head">
      <h2 class="section-title head-title">Identities on this signer</h2>
      {#if device.connected}
        <button class="btn btn-secondary btn-sm" onclick={() => refreshMasters()}>Refresh</button>
      {/if}
    </div>

    {#if !device.connected}
      <p class="empty">Connect to your signer to see its identities.</p>
    {:else if device.mode === 'relay' && device.relayStatus === null && !device.error && device.masters.length === 0}
      <p class="empty">Loading identities over the relay…</p>
    {:else if device.mode === 'relay' && device.relayStatus === null && device.error && device.masters.length === 0}
      <!-- Connected over the relay but get_status never came back. A WiFi signer
           always has an identity, so this is a round-trip failure, not an empty
           list. Surface it instead of a misleading "no identities". -->
      <div class="card card--warn relay-error">
        <p class="err-lead">⚠ Connected to the relay, but the signer isn't answering.</p>
        <p class="err-detail">{device.error}</p>
        <p class="hint-sm">Sapwood is asking on <code class="mono">{device.portInfo}</code>
          with operator key <code class="mono">{device.operatorPub}</code>.</p>
        <div class="restore-callout">
          <strong>If Primal still signs, WiFi is alive and Sapwood is missing the management key.</strong>
          Restore the matching recovery phrase in <a href="#operator-key">Operator key</a>, or connect
          by USB and use <strong>Set this browser as operator</strong>. That physical-confirmed action
          preserves the WiFi password and relays.
        </div>
        <details class="disclosure">
          <summary>Why this happens</summary>
          <ul class="err-causes">
            <li><strong>Different relays.</strong> Sapwood and the signer must share at least one relay.
              Check the signer booted onto the relay shown above (its boot log prints
              “WiFi-standalone mode — entering relay loop”).</li>
            <li><strong>Operator-key mismatch.</strong> The signer only accepts management signed by the
              operator key set when it was flashed. If this browser's key differs (flashed from a
              different browser or machine, or storage was cleared), the signer silently ignores it.
              The USB Operator key panel can replace that key with physical confirmation.</li>
          </ul>
        </details>
      </div>
    {:else if device.masters.length === 0}
      <p class="empty">No identities yet. Add one below, or use the guided setup on Home.</p>
    {:else}
      <!-- Keyed by identityKey: neither slot nor npub is unique on its own
           (personas carry their owner's slot; one secret can fill two slots). -->
      {#each device.masters as master (identityKey(master))}
        <div class="card id-card">
          <div class="id-head">
            <span class="id-slot">{master.persona ? `FROM SLOT ${master.slot}` : `SLOT ${master.slot}`}</span>
            <span class="id-mode">{master.persona ? 'DERIVED' : master.modeLabel ?? MODE_LABELS[master.mode ?? -1] ?? `MODE ${master.mode}`}</span>
          </div>
          {#if master.label}<div class="id-label">{master.label}</div>{/if}
          <div class="id-npub">{master.npub}</div>
          <!-- Removal: masters only (personas disappear with their tree). USB or
               heartwoodd — and in Hard mode the signer itself shows this npub and
               waits for a physical hold, so a cable request alone can never
               delete a key. -->
          {#if master.persona && device.mode === 'serial'}
            {#if confirmingPersona === master.npub}
              <div class="remove-confirm">
                <p class="hint-sm">
                  Removing <strong>{master.label || master.npub.slice(0, 12) + '…'}</strong> only clears it
                  from the signer's registry: apps paired to it stop working, but deriving the same name
                  again reproduces the identity exactly.
                </p>
                {#if personaError}<p class="error-text">{personaError}</p>{/if}
                <div class="remove-actions">
                  <button class="btn btn-danger btn-sm" disabled={personaBusy} onclick={() => handleRemovePersona(master.npub)}>
                    {personaBusy ? 'Removing…' : 'Remove it'}
                  </button>
                  <button class="btn btn-secondary btn-sm" disabled={personaBusy} onclick={() => { confirmingPersona = null; personaError = null }}>
                    Keep it
                  </button>
                </div>
              </div>
            {:else if renamingPersona === master.npub}
              <div class="remove-confirm">
                <input class="input" placeholder="New label (empty clears it)" bind:value={renameValue} disabled={personaBusy} />
                {#if personaError}<p class="error-text">{personaError}</p>{/if}
                <div class="remove-actions">
                  <button class="btn btn-secondary btn-sm" disabled={personaBusy} onclick={() => handleRenamePersona(master.npub)}>
                    {personaBusy ? 'Saving…' : 'Save label'}
                  </button>
                  <button class="btn btn-secondary btn-sm" disabled={personaBusy} onclick={() => { renamingPersona = null; personaError = null }}>
                    Cancel
                  </button>
                </div>
              </div>
            {:else}
              <div class="persona-actions">
                <button class="btn-link remove-link" onclick={() => { renamingPersona = master.npub; renameValue = master.label ?? ''; confirmingPersona = null; personaError = null }}>Rename…</button>
                <button class="btn-link remove-link" onclick={() => { confirmingPersona = master.npub; renamingPersona = null; personaError = null }}>Remove…</button>
              </div>
            {/if}
          {/if}
          {#if !master.persona && (device.mode === 'serial' || device.mode === 'http')}
            {#if confirmingSlot === master.slot}
              <div class="remove-confirm">
                <p class="hint-sm">
                  Without a recovery phrase or backup, <strong>{master.label || master.npub.slice(0, 12) + '…'}</strong>
                  is gone for good. Check the npub on the signer's screen, then hold its button to confirm.
                </p>
                {#if removeError}<p class="error-text">{removeError}</p>{/if}
                <div class="remove-actions">
                  <button class="btn btn-danger btn-sm" disabled={removeBusy} onclick={() => handleRemove(master.slot)}>
                    {removeBusy ? 'Waiting for the signer…' : 'Remove it'}
                  </button>
                  <button class="btn btn-secondary btn-sm" disabled={removeBusy} onclick={() => { confirmingSlot = null; removeError = null }}>
                    Keep it
                  </button>
                </div>
              </div>
            {:else}
              <button class="btn-link remove-link" onclick={() => { confirmingSlot = master.slot; removeError = null }}>Remove…</button>
            {/if}
          {/if}
        </div>
      {/each}
    {/if}
  </section>

  <!-- Personas: registry identities derived from the selected master. Distinct
       from "Add an identity" below, which fills a whole master slot: a persona
       shares its owner's tree, is addressable by its own bunker URI, and is
       removable without touching the tree. -->
  {#if device.mode === 'serial' && device.masters.some((m) => !m.persona)}
    <section>
      <details class="disclosure">
        <summary>Add a persona to this identity</summary>
        <p class="hint">
          A persona is a separate public identity derived from the selected identity's tree, for
          example gaming or work. The signer derives and stores it; the same name always reproduces
          the same keys, and apps pair to it like any other identity. The first persona action pairs
          Sapwood with the signer, confirmed once on its button.
        </p>
        <div class="persona-create">
          <input class="input" placeholder="Persona name, e.g. gaming" bind:value={personaName}
            disabled={personaBusy}
            onkeydown={(e) => { if (e.key === 'Enter' && !personaBusy) void handleCreatePersona() }} />
          <button class="btn btn-secondary" disabled={personaBusy || !personaName.trim()} onclick={handleCreatePersona}>
            {personaBusy ? 'Waiting for the signer…' : 'Create persona'}
          </button>
        </div>
        {#if personaStatus}<p class="hint-sm status">{personaStatus}</p>{/if}
        {#if personaError && confirmingPersona === null && renamingPersona === null}
          <p class="error-text">{personaError}</p>
        {/if}
      </details>
    </section>
  {/if}

  <!-- Identity card sync -->
  {#if (device.mode === 'serial' || device.mode === 'relay') && device.masters.length > 0}
    <section>
      <h2 class="section-title">Identity card</h2>
      <p class="hint">
        The signer's name and picture sync automatically when it connects. Use this to push them
        again, for example after you change your profile. The picture is shrunk in your browser;
        the signer never fetches images itself.
      </p>
      <button class="btn btn-secondary" onclick={handleSyncProfile} disabled={profilePending}>
        {profilePending ? 'Syncing…' : 'Re-sync profile to signer'}
      </button>
      {#if profileStatus}<p class="hint-sm status">{profileStatus}</p>{/if}
    </section>
  {/if}

  <!-- Short address (NIP-05): nostr.json generator for bunker discovery. -->
  <Nip05Card />

  <!-- Add an identity (USB-gated inside). Open by default when the signer has
       none yet, so a device that fell through to the console from setup lands
       with the one thing it needs already unfolded. -->
  <section>
    <details class="disclosure" open={device.mode === 'serial' && device.masters.length === 0}>
      <summary>Add an identity to this signer</summary>
      <Provision />
    </details>
  </section>

  <!-- Family recovery (Path B): words-only rebuild of a My Signet family onto
       this signer, from the encrypted roster on the sync relay. USB only: the
       ceremony rides the Sapwood manager pairing. -->
  {#if device.mode === 'serial'}
    <section>
      <details class="disclosure">
        <summary>Recover a family from its words</summary>
        <RecoveryWizard />
      </details>
    </section>
  {/if}

  <div class="rule"></div>

  <OperatorKey />

  <div class="rule"></div>

  <ProfileRelays />
</div>

<style>
  .identity-panel { display: flex; flex-direction: column; gap: 1.75rem; }

  .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .head-title { margin: 0; font-size: 1.3rem; }

  .id-card { margin-bottom: 0.75rem; }
  .id-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .id-slot { font-weight: 700; color: var(--green); font-size: 0.95rem; letter-spacing: 0.08em; }
  .id-mode { font-size: 0.78rem; color: var(--text-muted); letter-spacing: 0.1em; }
  .id-label { font-size: 1.15rem; font-weight: 500; color: #fff; margin-bottom: 0.4rem; }
  .id-npub { font-size: 0.82rem; color: var(--text-dim); word-break: break-all; line-height: 1.4; user-select: all; }

  .relay-error .err-lead { color: var(--amber); font-weight: 600; margin: 0 0 0.6rem; }
  .relay-error .err-detail {
    font-size: 0.8rem; color: #c77; background: #0a0a0a; border-radius: 3px;
    padding: 0.4rem 0.6rem; margin: 0 0 0.6rem; word-break: break-word;
  }
  .err-causes { margin: 0; padding-left: 1.2rem; }
  .err-causes li { font-size: 0.8rem; color: var(--text-dim); line-height: 1.5; margin-bottom: 0.5rem; }
  .err-causes strong { color: var(--text); }
  .restore-callout {
    background: #120f06;
    border: 1px solid #3a3320;
    border-radius: 6px;
    color: var(--text-dim);
    font-size: 0.82rem;
    line-height: 1.55;
    margin: 0.8rem 0;
    padding: 0.7rem 0.8rem;
  }
  .restore-callout strong { color: var(--amber); font-weight: 700; }
  .restore-callout a { color: var(--green); }

  .status { margin-top: 0.6rem; color: var(--text-dim); }

  .remove-link { margin-top: 0.5rem; font-size: 0.8rem; color: var(--text-dim); }
  .remove-link:hover { color: var(--red); }
  .persona-actions { display: flex; gap: 1rem; }
  .persona-create { display: flex; gap: 0.5rem; margin-top: 0.6rem; }
  .persona-create .input { flex: 1; }
  .remove-confirm {
    margin-top: 0.6rem; padding: 0.7rem 0.8rem;
    border: 1px solid #4a2a2a; border-radius: 6px; background: #140a0a;
  }
  .remove-confirm .hint-sm { margin: 0 0 0.6rem; }
  .remove-actions { display: flex; gap: 0.5rem; }

  .rule { border-top: 1px solid var(--border); }
</style>

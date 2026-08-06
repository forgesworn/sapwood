<script lang="ts">
  // Identity — everything about keys: the identities held on the signer, adding
  // one, the signer's public profile, and this browser's operator key.
  // Replaces the old Masters, Provision and half the Settings tab.
  import { device, refreshMasters, syncIdentityMeta } from '../lib/device.svelte.js'
  import { identityKey } from '../lib/identity-key.js'
  import Provision from './Provision.svelte'
  import OperatorKey from './OperatorKey.svelte'
  import ProfileRelays from './ProfileRelays.svelte'
  import Nip05Card from './Nip05Card.svelte'

  const MODE_LABELS: Record<number, string> = {
    0: 'BUNKER',
    1: 'TREE-MNEMONIC',
    2: 'TREE-NSEC',
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
        </div>
      {/each}
    {/if}
  </section>

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

  .rule { border-top: 1px solid var(--border); }
</style>

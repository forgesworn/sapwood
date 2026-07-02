<script lang="ts">
  // Where app names (kind-0 profiles) are looked up. Extracted from Settings.
  import { getProfileRelays, setProfileRelays, isValidRelayUrl } from '../lib/profile-relays.js'
  import { clearProfileCache } from '../lib/profiles.svelte.js'

  let profileRelays = $state(getProfileRelays())
  let newProfileRelay = $state('')
  let profileRelayError = $state<string | null>(null)

  function persist() {
    setProfileRelays(profileRelays)
    profileRelays = getProfileRelays() // reflect validation + de-dupe
    clearProfileCache() // names re-resolve from the new relays
  }

  function add() {
    const url = newProfileRelay.trim()
    if (!isValidRelayUrl(url)) {
      profileRelayError = 'Enter a wss:// relay URL.'
      return
    }
    if (profileRelays.some((r) => r.url === url)) {
      profileRelayError = 'That relay is already listed.'
      return
    }
    // New relays default to read-only; writing is an explicit opt-in per relay.
    profileRelays = [...profileRelays, { url, write: false }]
    newProfileRelay = ''
    profileRelayError = null
    persist()
  }

  function toggleWrite(index: number) {
    profileRelays = profileRelays.map((r, i) => (i === index ? { ...r, write: !r.write } : r))
    persist()
  }

  function remove(index: number) {
    if (profileRelays.length <= 1) return
    profileRelays = profileRelays.filter((_, i) => i !== index)
    persist()
  }
</script>

<section class="profile-relays">
  <h2 class="section-title">Profile relays</h2>
  <p class="hint">
    Where app names are looked up. Profiles found anywhere are re-published to the relays marked
    <strong>read + write</strong> so they resolve faster next time; read-only relays are never
    written to.
  </p>
  <div class="relay-list">
    {#each profileRelays as relay, i (relay.url)}
      <div class="relay-row">
        <span class="mono relay-url">{relay.url}</span>
        <button
          class="btn btn-secondary btn-sm mode-toggle"
          class:rw={relay.write}
          title={relay.write ? 'Profiles found elsewhere are re-published here. Click to make read-only.' : 'Read-only. Click to also write found profiles here.'}
          onclick={() => toggleWrite(i)}
        >{relay.write ? 'read + write' : 'read-only'}</button>
        <button class="btn btn-secondary btn-sm" disabled={profileRelays.length <= 1} onclick={() => remove(i)}>Remove</button>
      </div>
    {/each}
  </div>
  <div class="inline-form">
    <input
      type="url"
      class="field-input"
      bind:value={newProfileRelay}
      placeholder="wss://relay.example.com"
      spellcheck="false"
      autocomplete="off"
      onkeydown={(e) => { if (e.key === 'Enter') add() }}
    />
    <button class="btn btn-secondary btn-sm" onclick={add}>Add</button>
  </div>
  {#if profileRelayError}<p class="error-text">{profileRelayError}</p>{/if}
</section>

<style>
  .profile-relays { display: flex; flex-direction: column; gap: 0.75rem; }
  .profile-relays .section-title, .profile-relays .hint { margin-bottom: 0; }
  .relay-list { display: flex; flex-direction: column; gap: 0.35rem; }
  .relay-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .relay-url { flex: 1; }
  .mode-toggle { min-width: 6.5rem; color: var(--text-muted); }
  .mode-toggle.rw { color: var(--green-dim); border-color: var(--green-dim); }
  .inline-form { display: flex; gap: 0.4rem; align-items: center; }
  .inline-form input { flex: 1; padding: 0.4rem 0.6rem; font-size: 0.82rem; }
</style>

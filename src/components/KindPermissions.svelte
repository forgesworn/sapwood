<script lang="ts">
  import { COMMON_KINDS, riskColour, type KindInfo } from '../lib/kinds.js'

  interface Props {
    allowedKinds: number[]
    unrestricted: boolean
    onchange: (kinds: number[]) => void
  }

  let { allowedKinds, unrestricted, onchange }: Props = $props()

  const categories: { label: string; kinds: KindInfo[] }[] = [
    { label: 'IDENTITY', kinds: COMMON_KINDS.filter(k => k.category === 'identity') },
    { label: 'SOCIAL', kinds: COMMON_KINDS.filter(k => k.category === 'social') },
    { label: 'ENCRYPTED', kinds: COMMON_KINDS.filter(k => k.category === 'crypto') },
    { label: 'PAYMENTS', kinds: COMMON_KINDS.filter(k => k.category === 'payment') },
    { label: 'RELAY', kinds: COMMON_KINDS.filter(k => k.category === 'relay') },
  ]

  function isAllowed(kind: number): boolean {
    if (unrestricted) return true
    return allowedKinds.includes(kind)
  }

  function toggle(kind: number) {
    if (unrestricted) {
      // First click from unrestricted: block this kind, allow everything else.
      const allExcept = COMMON_KINDS.map(k => k.kind).filter(k => k !== kind)
      onchange(allExcept)
    } else if (isAllowed(kind)) {
      // Turn off: remove from allowed list.
      const next = allowedKinds.filter(k => k !== kind)
      onchange(next)
    } else {
      // Turn on: add to allowed list.
      onchange([...allowedKinds, kind])
    }
  }

  function allowAll() {
    onchange([]) // empty = unrestricted
  }
</script>

<div class="kind-perms">
  <div class="perm-header">
    <span class="perm-title">AUTO-SIGN PERMISSIONS</span>
    {#if !unrestricted}
      <button class="allow-all-btn" onclick={allowAll}>Allow All</button>
    {/if}
  </div>

  <p class="perm-desc">
    {#if unrestricted}
      All event kinds auto-sign. <strong>Click a kind to block it</strong> -- blocked kinds require button press on the device.
    {:else}
      Green kinds auto-sign. Dim kinds require <strong>button press</strong> on the device. Click to toggle.
    {/if}
  </p>

  <div class="categories">
    {#each categories as cat}
      <div class="category">
        <span class="cat-label">{cat.label}</span>
        <div class="kind-grid">
          {#each cat.kinds as ki}
            {@const allowed = isAllowed(ki.kind)}
            <button
              class="kind-toggle"
              class:allowed
              class:blocked={!allowed}
              onclick={() => toggle(ki.kind)}
              title={allowed ? `${ki.label} (${ki.kind}) -- auto-signs. Click to require button.` : `${ki.label} (${ki.kind}) -- requires button. Click to auto-sign.`}
            >
              <span class="kind-indicator" style="background: {allowed ? riskColour(ki.risk) : '#333'}"></span>
              <span class="kind-name">{ki.label}</span>
              <span class="kind-num">{ki.kind}</span>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .kind-perms {
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .perm-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .perm-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-dim);
    letter-spacing: 0.12em;
  }

  .allow-all-btn {
    background: none;
    border: 1px solid var(--border-bright);
    color: var(--text-dim);
    padding: 0.25rem 0.75rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .allow-all-btn:hover { background: var(--surface-hover); }

  .perm-desc {
    font-size: 0.9rem;
    color: var(--text-muted);
    margin: 0 0 1rem;
    line-height: 1.5;
  }

  .perm-desc strong { color: var(--text-dim); }

  .categories {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .cat-label {
    display: block;
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.1em;
    margin-bottom: 0.4rem;
  }

  .kind-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .kind-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.45rem 0.85rem;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }

  .kind-toggle.allowed {
    border-color: var(--border-bright);
  }

  .kind-toggle.blocked {
    opacity: 0.35;
  }

  .kind-toggle:hover {
    opacity: 1;
    border-color: #444;
    background: var(--surface-hover);
  }

  .kind-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .kind-name {
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--text);
  }

  .kind-toggle.blocked .kind-name {
    color: var(--text-muted);
  }

  .kind-num {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
</style>

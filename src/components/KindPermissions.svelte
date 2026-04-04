<script lang="ts">
  import { COMMON_KINDS, riskColour, type KindInfo } from '../lib/kinds.js'

  interface Props {
    allowedKinds: number[]
    unrestricted: boolean
    onchange: (kinds: number[]) => void
  }

  let { allowedKinds, unrestricted, onchange }: Props = $props()

  // Group kinds by category for the UI.
  const categories: { label: string; kinds: KindInfo[] }[] = [
    { label: 'IDENTITY', kinds: COMMON_KINDS.filter(k => k.category === 'identity' || k.category === 'relay') },
    { label: 'SOCIAL', kinds: COMMON_KINDS.filter(k => k.category === 'social') },
    { label: 'ENCRYPTED', kinds: COMMON_KINDS.filter(k => k.category === 'crypto') },
    { label: 'PAYMENTS', kinds: COMMON_KINDS.filter(k => k.category === 'payment') },
  ]

  function isAllowed(kind: number): boolean {
    if (unrestricted) return true
    return allowedKinds.includes(kind)
  }

  function toggle(kind: number) {
    let next: number[]
    if (unrestricted) {
      // Switching from unrestricted to restricted: enable all EXCEPT this one.
      next = COMMON_KINDS.map(k => k.kind).filter(k => k !== kind)
    } else if (isAllowed(kind)) {
      next = allowedKinds.filter(k => k !== kind)
    } else {
      next = [...allowedKinds, kind]
    }
    onchange(next)
  }

  function setAll(enabled: boolean) {
    if (enabled) {
      // Empty array = unrestricted (all kinds).
      onchange([])
    } else {
      // Restrict to nothing.
      onchange([_placeholder])
      // Actually, restrict to only low-risk kinds.
      onchange(COMMON_KINDS.filter(k => k.risk === 'low').map(k => k.kind))
    }
  }

  // Dummy to satisfy TypeScript.
  const _placeholder = -1
</script>

<div class="kind-perms">
  <div class="perm-header">
    <span class="perm-title">SIGNING PERMISSIONS</span>
    {#if unrestricted}
      <button class="restrict-btn" onclick={() => setAll(false)}>
        Restrict
      </button>
    {:else}
      <button class="unrestrict-btn" onclick={() => setAll(true)}>
        Allow all
      </button>
    {/if}
  </div>

  {#if unrestricted}
    <div class="unrestricted-warning">
      All event kinds permitted. This client can sign anything.
    </div>
  {/if}

  <div class="categories">
    {#each categories as cat}
      <div class="category">
        <span class="cat-label">{cat.label}</span>
        <div class="kind-grid">
          {#each cat.kinds as ki}
            <button
              class="kind-toggle"
              class:on={isAllowed(ki.kind)}
              class:off={!isAllowed(ki.kind)}
              style="--risk-color: {riskColour(ki.risk)}"
              onclick={() => toggle(ki.kind)}
            >
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
    margin-bottom: 0.75rem;
  }

  .perm-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.12em;
  }

  .restrict-btn, .unrestrict-btn {
    background: none;
    border: 1px solid var(--border-bright);
    color: var(--text-dim);
    padding: 0.25rem 0.75rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .restrict-btn { border-color: #442800; color: var(--amber); }
  .restrict-btn:hover { background: #1a0e00; }
  .unrestrict-btn:hover { background: var(--surface-hover); }

  .unrestricted-warning {
    background: #1a0e00;
    border: 1px solid #442800;
    border-radius: 4px;
    padding: 0.6rem 1rem;
    color: var(--amber);
    font-size: 0.9rem;
    font-weight: 500;
    margin-bottom: 0.75rem;
  }

  .categories {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .category {}

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
    gap: 0.4rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.4rem 0.75rem;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }

  .kind-toggle.on {
    border-color: var(--risk-color);
    background: color-mix(in srgb, var(--risk-color) 8%, var(--surface));
  }

  .kind-toggle.off {
    opacity: 0.4;
  }

  .kind-toggle:hover {
    border-color: var(--border-bright);
    opacity: 1;
  }

  .kind-name {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text);
  }

  .kind-toggle.off .kind-name {
    color: var(--text-muted);
  }

  .kind-num {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .kind-toggle.on .kind-num {
    color: var(--risk-color);
  }
</style>

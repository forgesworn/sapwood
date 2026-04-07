<script lang="ts">
  import { COMMON_KINDS, type KindInfo } from '../lib/kinds.js'

  // Two-state permission model per kind:
  //   'auto'    = sign immediately (green)
  //   'blocked' = reject (amber) — on ESP32 this would be "prompt for button"

  interface Props {
    allowedKinds: number[]
    unrestricted: boolean
    onchange: (kinds: number[] | null) => void
  }

  let { allowedKinds, unrestricted, onchange }: Props = $props()

  let expanded = $state(false)

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
      // First restriction: allow everything except this kind.
      const allExcept = COMMON_KINDS.map(k => k.kind).filter(k => k !== kind)
      onchange(allExcept)
    } else if (isAllowed(kind)) {
      // Remove from allowed.
      const next = allowedKinds.filter(k => k !== kind)
      onchange(next.length > 0 ? next : null)
    } else {
      // Add to allowed.
      onchange([...allowedKinds, kind])
    }
  }

  function allowAll() {
    onchange(null as unknown as number[])
  }

  const blockedCount = $derived(
    unrestricted ? 0 : COMMON_KINDS.filter(k => !allowedKinds.includes(k.kind)).length
  )

  const summaryText = $derived(
    unrestricted
      ? 'All kinds auto-signed'
      : `${allowedKinds.length} auto-signed, ${blockedCount} blocked`
  )
</script>

<div class="perms">
  <button class="perms-toggle" onclick={() => expanded = !expanded}>
    <span class="perms-chevron" class:open={expanded}>{'\u25B8'}</span>
    <span class="perms-label">Signing</span>
    <span class="perms-summary" class:restricted={!unrestricted}>{summaryText}</span>
    {#if !unrestricted}
      <button class="perms-reset" onclick={(e) => { e.stopPropagation(); allowAll() }}>Allow all</button>
    {/if}
  </button>

  {#if expanded}
    <div class="perms-grid">
      {#each categories as cat}
        {#each cat.kinds as ki}
          {@const allowed = isAllowed(ki.kind)}
          <button
            class="kind-chip"
            class:allowed
            class:blocked={!allowed}
            onclick={() => toggle(ki.kind)}
            title="{ki.label} (kind {ki.kind}) — {allowed ? 'auto-sign' : 'blocked'}"
          >
            <span class="chip-dot" style="background: {allowed ? 'var(--green)' : 'var(--amber)'}"></span>
            {ki.label}
          </button>
        {/each}
      {/each}
    </div>
  {/if}
</div>

<style>
  .perms {
    margin-top: 0.75rem;
    border-top: 1px solid var(--border);
    padding-top: 0.5rem;
  }

  .perms-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: none;
    padding: 0.3rem 0;
    cursor: pointer;
    width: 100%;
    text-align: left;
    font-family: inherit;
  }
  .perms-toggle:hover .perms-label { color: #ccc; }

  .perms-chevron {
    font-size: 0.65rem;
    color: var(--text-muted);
    transition: transform 0.15s;
    width: 0.8rem;
    flex-shrink: 0;
  }
  .perms-chevron.open { transform: rotate(90deg); }

  .perms-label {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-dim);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .perms-summary {
    font-size: 0.8rem;
    color: var(--text-muted);
    flex: 1;
  }
  .perms-summary.restricted { color: var(--amber); }

  .perms-reset {
    background: none;
    border: 1px solid var(--border-bright);
    color: var(--text-dim);
    padding: 0.2rem 0.6rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.75rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .perms-reset:hover { background: var(--surface-hover); color: #fff; }

  .perms-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.6rem;
    padding-bottom: 0.25rem;
  }

  .kind-chip {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.3rem 0.65rem;
    font-family: inherit;
    font-size: 0.8rem;
    color: var(--text);
    cursor: pointer;
    transition: all 0.12s;
  }
  .kind-chip:hover { border-color: #444; background: var(--surface-hover); }
  .kind-chip.allowed { border-color: #1a3a22; }
  .kind-chip.blocked { border-color: #3a2a00; opacity: 0.7; }

  .chip-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
</style>

<script lang="ts">
  import { COMMON_KINDS, type KindInfo } from '../lib/kinds.js'

  // Three-state permission model per kind:
  //   'auto'   = sign immediately (green)
  //   'prompt' = show on OLED, wait for button (amber)
  //   'block'  = reject immediately (red)
  //
  // Stored as allowed_kinds on the ESP32:
  //   empty array = all kinds auto-sign (unrestricted)
  //   [1, 7] = only kind 1 and 7 auto-sign, everything else prompts
  //   (block is not yet in the firmware -- maps to prompt for now)

  interface Props {
    allowedKinds: number[]
    unrestricted: boolean
    onchange: (kinds: number[]) => void
  }

  let { allowedKinds, unrestricted, onchange }: Props = $props()

  type Tier = 'auto' | 'prompt' | 'block'

  const categories: { label: string; kinds: KindInfo[] }[] = [
    { label: 'IDENTITY', kinds: COMMON_KINDS.filter(k => k.category === 'identity') },
    { label: 'SOCIAL', kinds: COMMON_KINDS.filter(k => k.category === 'social') },
    { label: 'ENCRYPTED', kinds: COMMON_KINDS.filter(k => k.category === 'crypto') },
    { label: 'PAYMENTS', kinds: COMMON_KINDS.filter(k => k.category === 'payment') },
    { label: 'RELAY', kinds: COMMON_KINDS.filter(k => k.category === 'relay') },
  ]

  function getTier(kind: number): Tier {
    if (unrestricted) return 'auto'
    if (allowedKinds.includes(kind)) return 'auto'
    // TODO: when firmware supports block, check a blocked_kinds list.
    // For now, anything not in allowed_kinds = prompt.
    return 'prompt'
  }

  function cycleTier(kind: number) {
    const current = getTier(kind)
    // Cycle: auto -> prompt -> block -> auto
    // Block maps to prompt in firmware for now.
    const next: Tier = current === 'auto' ? 'prompt' : 'auto'

    if (unrestricted && next === 'prompt') {
      // First restriction from unrestricted: allow everything except this kind.
      const allExcept = COMMON_KINDS.map(k => k.kind).filter(k => k !== kind)
      onchange(allExcept)
    } else if (next === 'auto') {
      // Add to allowed list.
      if (unrestricted) {
        onchange([]) // stay unrestricted
      } else {
        onchange([...allowedKinds, kind])
      }
    } else {
      // Remove from allowed list (prompt).
      onchange(allowedKinds.filter(k => k !== kind))
    }
  }

  function allowAll() {
    onchange([])
  }

  function tierColour(tier: Tier): string {
    switch (tier) {
      case 'auto': return 'var(--green)'
      case 'prompt': return 'var(--amber)'
      case 'block': return 'var(--red)'
    }
  }

  function tierLabel(tier: Tier): string {
    switch (tier) {
      case 'auto': return 'auto-sign'
      case 'prompt': return 'prompt'
      case 'block': return 'blocked'
    }
  }
</script>

<div class="kind-perms">
  <div class="perm-header">
    <span class="perm-title">SIGNING PERMISSIONS</span>
    {#if !unrestricted}
      <button class="allow-all-btn" onclick={allowAll}>Allow All</button>
    {/if}
  </div>

  <div class="legend">
    <span class="legend-item"><span class="legend-dot" style="background: var(--green)"></span> Auto-sign</span>
    <span class="legend-item"><span class="legend-dot" style="background: var(--amber)"></span> Prompt (button)</span>
  </div>

  <div class="categories">
    {#each categories as cat}
      <div class="category">
        <span class="cat-label">{cat.label}</span>
        <div class="kind-grid">
          {#each cat.kinds as ki}
            {@const tier = getTier(ki.kind)}
            <button
              class="kind-toggle"
              class:auto={tier === 'auto'}
              class:prompt={tier === 'prompt'}
              class:block={tier === 'block'}
              onclick={() => cycleTier(ki.kind)}
              title="{ki.label} ({ki.kind}) -- {tierLabel(tier)}. Click to change."
            >
              <span class="kind-dot" style="background: {tierColour(tier)}"></span>
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
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-dim);
    letter-spacing: 0.12em;
  }

  .allow-all-btn {
    background: none;
    border: 1px solid var(--border-bright);
    color: var(--text-dim);
    padding: 0.3rem 0.85rem;
    border-radius: 3px;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .allow-all-btn:hover { background: var(--surface-hover); }

  .legend {
    display: flex;
    gap: 1.5rem;
    margin-bottom: 1rem;
    font-size: 0.85rem;
    color: var(--text-dim);
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .categories {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .cat-label {
    display: block;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    letter-spacing: 0.1em;
    margin-bottom: 0.4rem;
  }

  .kind-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .kind-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 0.5rem 1rem;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }

  .kind-toggle:hover {
    border-color: #444;
    background: var(--surface-hover);
  }

  .kind-toggle.auto {
    border-color: #1a4422;
  }

  .kind-toggle.prompt {
    border-color: #443300;
    opacity: 0.7;
  }

  .kind-toggle.block {
    border-color: #441111;
    opacity: 0.4;
  }

  .kind-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .kind-name {
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--text);
  }

  .kind-toggle.prompt .kind-name,
  .kind-toggle.block .kind-name {
    color: var(--text-dim);
  }

  .kind-num {
    font-size: 0.75rem;
    color: var(--text-muted);
    min-width: 2ch;
  }
</style>

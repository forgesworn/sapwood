<script lang="ts">
  import { COMMON_KINDS, kindLabel, type KindInfo } from '../lib/kinds.js'

  // Three-state permission model per kind (when signing_approved is true):
  //   'auto'   = kind in allowed_kinds → sign immediately (green)
  //   'prompt' = kind NOT in allowed_kinds → ESP32 shows on OLED, waits for button press (amber)
  //
  // When signing_approved is false (TOFU state): no signing possible yet.

  interface Props {
    allowedKinds: number[]
    unrestricted: boolean
    signingApproved: boolean
    updating: boolean
    onchange: (kinds: number[] | null) => void
  }

  let { allowedKinds, unrestricted, signingApproved, updating, onchange }: Props = $props()

  let expanded = $state(false)
  let customKind = $state('')
  let customError = $state<string | null>(null)

  const commonKindSet = new Set(COMMON_KINDS.map(k => k.kind))

  const categories: { label: string; kinds: KindInfo[] }[] = [
    { label: 'IDENTITY', kinds: COMMON_KINDS.filter(k => k.category === 'identity') },
    { label: 'SOCIAL', kinds: COMMON_KINDS.filter(k => k.category === 'social') },
    { label: 'APP', kinds: COMMON_KINDS.filter(k => k.category === 'app') },
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
      // Remove from allowed — kind will now require button press.
      const next = allowedKinds.filter(k => k !== kind)
      onchange(next.length > 0 ? next : null)
    } else {
      // Add to allowed — kind will now auto-sign.
      onchange([...allowedKinds, kind])
    }
  }

  function parseKind(value: string): number | null {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) return null
    const kind = Number(trimmed)
    return Number.isSafeInteger(kind) ? kind : null
  }

  function addCustomKind() {
    const kind = parseKind(customKind)
    if (kind === null) {
      customError = 'Enter a kind number'
      return
    }
    customKind = ''
    customError = null
    if (unrestricted) return
    if (allowedKinds.includes(kind)) return
    onchange([...allowedKinds, kind].sort((a, b) => a - b))
  }

  function allowAll() {
    onchange(null as unknown as number[])
  }

  const customAllowedKinds = $derived(
    unrestricted
      ? []
      : allowedKinds.filter(k => !commonKindSet.has(k)).sort((a, b) => a - b)
  )

  const promptCount = $derived(
    unrestricted ? 0 : COMMON_KINDS.filter(k => !allowedKinds.includes(k.kind)).length
  )

  const summaryText = $derived(
    unrestricted
      ? 'All kinds auto-signed'
      : `${allowedKinds.length} auto-signed, ${promptCount} prompted`
  )
</script>

<div class="perms">
  {#if !signingApproved}
    <div class="perms-tofu">
      <span class="perms-tofu-dot"></span>
      <span class="perms-tofu-label">Awaiting first approval on device</span>
    </div>
  {:else}
    <div class="perms-header">
      <button class="perms-toggle" onclick={() => expanded = !expanded} disabled={updating}>
        <span class="perms-chevron" class:open={expanded}>{'\u25B8'}</span>
        <span class="perms-label">Signing</span>
        {#if updating}
          <span class="perms-waiting">Confirm on device\u2026</span>
        {:else}
          <span class="perms-summary" class:restricted={!unrestricted}>{summaryText}</span>
        {/if}
      </button>
      {#if !updating && !unrestricted}
        <button class="btn btn-secondary btn-sm perms-reset" onclick={allowAll}>Allow all</button>
      {/if}
    </div>

    {#if expanded && !updating}
      <div class="perms-grid">
        {#each categories as cat}
          {#each cat.kinds as ki}
            {@const allowed = isAllowed(ki.kind)}
            <button
              class="kind-chip"
              class:allowed
              class:prompt={!allowed}
              onclick={() => toggle(ki.kind)}
              title="{ki.label} (kind {ki.kind}): {allowed ? 'auto-sign' : 'prompt (button)'}"
            >
              <span class="chip-dot" style="background: {allowed ? 'var(--green)' : 'var(--amber)'}"></span>
              {ki.label}
            </button>
          {/each}
        {/each}
        {#each customAllowedKinds as kind}
          <button
            class="kind-chip allowed"
            onclick={() => toggle(kind)}
            title="{kindLabel(kind)}: auto-sign"
          >
            <span class="chip-dot" style="background: var(--green)"></span>
            {kindLabel(kind)}
          </button>
        {/each}
      </div>

      {#if !unrestricted}
        <div class="custom-kind">
          <input
            class="custom-kind-input"
            value={customKind}
            placeholder="Kind number"
            inputmode="numeric"
            pattern="[0-9]*"
            aria-label="Kind number"
            oninput={(e) => { customKind = (e.target as HTMLInputElement).value; customError = null }}
            onkeydown={(e) => { if (e.key === 'Enter') addCustomKind() }}
          />
          <button class="btn btn-secondary btn-sm" disabled={!customKind.trim()} onclick={addCustomKind}>Add kind</button>
        </div>
        {#if customError}
          <div class="custom-kind-error">{customError}</div>
        {/if}
      {/if}

      <div class="perms-legend">
        <span class="legend-item"><span class="legend-dot" style="background: var(--green)"></span>Auto-sign</span>
        <span class="legend-item"><span class="legend-dot" style="background: var(--amber)"></span>Prompt (button)</span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .perms {
    margin-top: 0.75rem;
    border-top: 1px solid var(--border);
    padding-top: 0.5rem;
  }

  /* TOFU banner */
  .perms-tofu {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0;
  }

  .perms-tofu-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }

  .perms-tofu-label {
    font-size: 0.8rem;
    color: var(--text-muted);
    font-style: italic;
  }

  /* Collapsible toggle */
  .perms-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .perms-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: none;
    padding: 0.3rem 0;
    cursor: pointer;
    flex: 1;
    min-width: 0;
    text-align: left;
    font-family: inherit;
  }
  .perms-toggle:hover .perms-label { color: #ccc; }
  .perms-toggle:disabled { cursor: default; opacity: 0.8; }

  .perms-waiting {
    font-size: 0.8rem;
    color: var(--amber);
    animation: pulse-amber 1.5s ease-in-out infinite;
  }
  @keyframes pulse-amber {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }

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

  .perms-reset { flex-shrink: 0; }

  /* Kind chip grid */
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
  .kind-chip.prompt { border-color: #3a2a00; opacity: 0.7; }

  .chip-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .custom-kind {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.55rem;
    align-items: center;
  }

  .custom-kind-input {
    min-width: 8.5rem;
    max-width: 12rem;
    flex: 1 1 8.5rem;
    height: 2rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 0.8rem;
    padding: 0 0.6rem;
  }

  .custom-kind-input:focus {
    outline: none;
    border-color: #444;
  }

  .custom-kind-error {
    margin-top: 0.3rem;
    color: var(--red);
    font-size: 0.75rem;
  }

  /* Legend */
  .perms-legend {
    display: flex;
    gap: 1rem;
    margin-top: 0.5rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--border);
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .legend-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
</style>

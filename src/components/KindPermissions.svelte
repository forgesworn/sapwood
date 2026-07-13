<script lang="ts">
  import { COMMON_KINDS, kindLabel, type KindInfo } from '../lib/kinds.js'

  // Effective permission model per kind (when signing_approved is true):
  // strict v2: listed = automatic/button according to auto_approve; unlisted = denied.
  // legacy:    listed = automatic/button; unlisted falls back to the device button.
  // When signing_approved is false (TOFU state), no signing is possible yet.

  interface Props {
    allowedKinds: number[]
    unrestricted: boolean
    signingApproved: boolean
    autoApprove?: boolean
    strictPermissions?: boolean
    /** Whether the exact method ceiling includes sign_event at all. */
    signingIncluded?: boolean
    updating: boolean
    onchange: (kinds: number[] | null) => void
  }

  let {
    allowedKinds, unrestricted, signingApproved,
    autoApprove = true, strictPermissions = false, signingIncluded = true,
    updating, onchange,
  }: Props = $props()

  let expanded = $state(false)
  let customKind = $state('')
  let customError = $state<string | null>(null)
  let permissionNote = $state<string | null>(null)

  const commonKindSet = new Set(COMMON_KINDS.map(k => k.kind))
  const allCommonKinds = COMMON_KINDS.map(k => k.kind)

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

  function cleanKinds(kinds: number[]): number[] {
    return [...new Set(kinds)]
      .filter((kind) => Number.isSafeInteger(kind) && kind >= 0)
      .sort((a, b) => a - b)
  }

  function knownWhitelist(extraKinds: number[] = []): number[] {
    return cleanKinds([...allCommonKinds, ...extraKinds])
  }

  function toggle(kind: number) {
    customError = null
    permissionNote = null
    if (unrestricted) {
      // First restriction: allow known/common kinds except this one; unknown
      // and future kinds then fall back to the signer's button prompt.
      const allExcept = knownWhitelist().filter(k => k !== kind)
      onchange(allExcept)
    } else if (isAllowed(kind)) {
      // Remove from allowed — kind will now require button press.
      const next = allowedKinds.filter(k => k !== kind)
      if (next.length === 0) {
        permissionNote = strictPermissions
          ? 'An empty kind list means Allow all. Keep at least one allowed kind.'
          : 'To prompt for every kind, use Ask each time.'
        return
      }
      onchange(next)
    } else {
      // Add to allowed — kind will now auto-sign.
      onchange(cleanKinds([...allowedKinds, kind]))
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
    permissionNote = null
    if (unrestricted) {
      onchange(knownWhitelist([kind]))
      return
    }
    if (allowedKinds.includes(kind)) return
    onchange(cleanKinds([...allowedKinds, kind]))
  }

  function allowAll() {
    customError = null
    permissionNote = null
    onchange(null)
  }

  const customAllowedKinds = $derived(
    unrestricted
      ? []
      : allowedKinds.filter(k => !commonKindSet.has(k)).sort((a, b) => a - b)
  )

  const promptCount = $derived(
    unrestricted ? 0 : COMMON_KINDS.filter(k => !allowedKinds.includes(k.kind)).length
  )

  type EffectiveKindState = 'auto' | 'button' | 'denied'

  function effectiveState(kind: number): EffectiveKindState {
    const listed = isAllowed(kind)
    if (!listed && strictPermissions) return 'denied'
    return listed && autoApprove ? 'auto' : 'button'
  }

  const summaryText = $derived.by(() => {
    if (unrestricted) return autoApprove ? 'All kinds auto-signed' : 'All kinds require button'
    if (strictPermissions) {
      return autoApprove
        ? `${allowedKinds.length} auto-signed, ${promptCount} denied`
        : `${allowedKinds.length} button-approved, ${promptCount} denied`
    }
    if (!autoApprove) return 'Every signature needs button'
    return promptCount > 0
      ? `${allowedKinds.length} auto-signed, ${promptCount} prompted`
      : `${allowedKinds.length} auto-signed, unknown prompted`
  })
</script>

<div class="perms">
  {#if strictPermissions && !signingIncluded}
    <div class="perms-no-signing">
      <span class="perms-tofu-label">Signing is not included in this app's exact policy.</span>
      <span class="perms-guidance">Reconnect it with a signing preset that names the event kinds it may sign; legacy “Allow signing” would be unrestricted.</span>
    </div>
  {:else if !signingApproved}
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
      <div class="perms-note" class:warn={unrestricted}>
        {unrestricted
          ? 'Allow all includes unknown and future kinds.'
          : strictPermissions
            ? 'Unknown or unlisted kinds are denied by this exact policy.'
            : 'Unknown or unlisted kinds prompt on the signer.'}
      </div>

      <div class="perms-grid">
        {#each categories as cat}
          {#each cat.kinds as ki}
            {@const allowed = isAllowed(ki.kind)}
            {@const state = effectiveState(ki.kind)}
            <button
              class="kind-chip"
              class:allowed
              class:prompt={state === 'button'}
              class:denied={state === 'denied'}
              onclick={() => toggle(ki.kind)}
              title="{ki.label} (kind {ki.kind}): {state === 'auto' ? 'auto-sign' : state === 'button' ? 'button required' : 'denied (exact policy)'}"
            >
              <span class="chip-dot" style="background: {state === 'auto' ? 'var(--green)' : state === 'button' ? 'var(--amber)' : 'var(--red)'}"></span>
              {ki.label}
            </button>
          {/each}
        {/each}
        {#each customAllowedKinds as kind}
          {@const state = effectiveState(kind)}
          <button
            class="kind-chip allowed"
            class:prompt={state === 'button'}
            onclick={() => toggle(kind)}
            title="{kindLabel(kind)}: {state === 'auto' ? 'auto-sign' : 'button required'}"
          >
            <span class="chip-dot" style="background: {state === 'auto' ? 'var(--green)' : 'var(--amber)'}"></span>
            {kindLabel(kind)}
          </button>
        {/each}
      </div>

      <div class="custom-kind">
        <input
          class="custom-kind-input"
          value={customKind}
          placeholder="Custom kind number"
          inputmode="numeric"
          pattern="[0-9]*"
          aria-label="Kind number"
          oninput={(e) => { customKind = (e.target as HTMLInputElement).value; customError = null; permissionNote = null }}
          onkeydown={(e) => { if (e.key === 'Enter') addCustomKind() }}
        />
        <button class="btn btn-secondary btn-sm" disabled={!customKind.trim()} onclick={addCustomKind}>Add kind</button>
      </div>
      {#if customError}
        <div class="custom-kind-error">{customError}</div>
      {/if}
      {#if permissionNote}
        <div class="custom-kind-note">{permissionNote}</div>
      {/if}

      <div class="perms-legend">
        {#if autoApprove}
          <span class="legend-item"><span class="legend-dot" style="background: var(--green)"></span>Auto-sign</span>
        {/if}
        <span class="legend-item"><span class="legend-dot" style="background: var(--amber)"></span>Button required</span>
        {#if strictPermissions && !unrestricted}
          <span class="legend-item"><span class="legend-dot" style="background: var(--red)"></span>Denied</span>
        {/if}
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
  .perms-no-signing { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.4rem 0; }
  .perms-guidance { font-size: 0.75rem; color: var(--text-muted); line-height: 1.4; }

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

  .perms-note {
    margin-top: 0.55rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.35;
  }
  .perms-note.warn { color: var(--amber); }

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
  .kind-chip.denied { border-color: #3a1515; opacity: 0.55; }

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

  .custom-kind-note {
    margin-top: 0.3rem;
    color: var(--amber);
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

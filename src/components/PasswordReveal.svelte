<script lang="ts">
  // The little eye on a password field: flips it between hidden and readable.
  // Positions itself inside the host's `.pw` wrapper (position: relative), so
  // the input keeps the host component's own styling untouched.
  let {
    shown = $bindable(false),
    disabled = false,
  }: { shown?: boolean; disabled?: boolean } = $props()
</script>

<button
  type="button"
  class="eye"
  {disabled}
  aria-label={shown ? 'Hide password' : 'Show password'}
  aria-pressed={shown}
  onclick={() => (shown = !shown)}
>
  {#if shown}
    <!-- eye with a strike: it's visible, click to hide -->
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  {:else}
    <!-- open eye: it's hidden, click to show -->
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  {/if}
</button>

<style>
  .eye {
    position: absolute;
    right: 0.45rem;
    top: 50%;
    transform: translateY(-50%);
    display: grid;
    place-items: center;
    background: none;
    border: none;
    padding: 0.3rem;
    cursor: pointer;
    color: var(--text-muted, #777);
  }
  .eye:hover:not(:disabled) { color: var(--text, #ccc); }
  .eye:disabled { opacity: 0.4; cursor: not-allowed; }
  svg { width: 1.05rem; height: 1.05rem; display: block; }
  @media (pointer: coarse) {
    .eye { padding: 0.55rem; right: 0.2rem; }
  }
</style>

<script lang="ts">
  // The one confirmation pattern for destructive actions: the button swaps
  // in place for a short question with explicit yes/cancel. No native dialogs.
  interface Props {
    /** The resting button text, e.g. "Disconnect". */
    label: string
    /** The inline question, e.g. "Disconnect this app?" */
    question: string
    /** The confirming button text, e.g. "Yes, disconnect". */
    confirmLabel: string
    /** Shown on the confirm button while the action runs. */
    busyLabel?: string
    busy?: boolean
    disabled?: boolean
    /** Extra classes for the resting button (default: danger text button). */
    buttonClass?: string
    onconfirm: () => void
  }
  let {
    label, question, confirmLabel, busyLabel,
    busy = false, disabled = false,
    buttonClass = 'btn btn-danger btn-sm',
    onconfirm,
  }: Props = $props()

  let confirming = $state(false)

  function yes() {
    confirming = false
    onconfirm()
  }
</script>

{#if confirming || busy}
  <span class="confirm-inline">
    <span class="confirm-q">{question}</span>
    <button class="btn btn-danger btn-sm" disabled={busy} onclick={yes}>
      {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
    </button>
    {#if !busy}
      <button class="btn-link confirm-cancel" onclick={() => (confirming = false)}>Cancel</button>
    {/if}
  </span>
{:else}
  <button class={buttonClass} {disabled} onclick={() => (confirming = true)}>
    {label}
  </button>
{/if}

<style>
  .confirm-inline { display: inline-flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .confirm-q { font-size: 0.8rem; color: var(--text-dim); }
  .confirm-cancel { font-size: 0.8rem; }
</style>

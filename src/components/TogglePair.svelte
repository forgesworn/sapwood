<script lang="ts">
  // Two mutually exclusive states shown as a pressed/unpressed button pair
  // (Upright/Flipped, Detailed/Quiet, On/Off): the selected option stays
  // enabled and full-opacity, with aria-pressed carrying state to assistive
  // tech instead of colour or disablement alone.
  interface Props {
    label: string
    onLabel: string
    offLabel: string
    /** true selects onLabel, false selects offLabel. */
    value: boolean
    pending?: boolean
    /** Disables switching to "on" specifically (e.g. no phones to turn the
     *  announcement off for). */
    onDisabled?: boolean
    onchange: (value: boolean) => void
  }
  let { label, onLabel, offLabel, value, pending = false, onDisabled = false, onchange }: Props = $props()

  function press(next: boolean) {
    if (next === value) return // pressing the pressed button does nothing
    onchange(next)
  }
</script>

<div class="toggle-pair" role="group" aria-label={label}>
  <button
    type="button"
    class="btn btn-sm"
    class:btn-secondary={!value}
    class:lq-on={value}
    aria-pressed={value}
    disabled={pending}
    onclick={() => press(true)}
  >{onLabel}</button>
  <button
    type="button"
    class="btn btn-sm"
    class:btn-secondary={value}
    class:lq-on={!value}
    aria-pressed={!value}
    disabled={pending || onDisabled}
    onclick={() => press(false)}
  >{offLabel}</button>
</div>

<style>
  .toggle-pair { display: flex; gap: 0.5rem; }
  .lq-on { border-color: var(--green-dim); color: var(--green); background: #08130d; opacity: 1; }
</style>

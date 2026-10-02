<script lang="ts">
  // The last step of every USB flash: restart the board so it runs what was
  // just written. Large and full contrast on purpose; it used to live in small
  // dim text or a log line, and a tester missed it (2026-10-02).
  import { resetButtonHint } from '../lib/reset-hint.js'

  let { boardId = null, label = null }: { boardId?: string | null; label?: string | null } = $props()
</script>

<div class="reset-callout" role="status">
  <p class="reset-title">Last step: press RESET on the board</p>
  <p class="reset-body">
    {label ?? 'Your signer'} has the new firmware, but keeps running the old one until it restarts.
    <strong>{resetButtonHint(boardId)}</strong>, or unplug the cable and plug it back in.
    Its screen comes back on when the new firmware starts. If it has already restarted,
    pressing RESET again does no harm.
  </p>
</div>

<style>
  .reset-callout {
    border: 1px solid var(--amber); border-left: 4px solid var(--amber);
    border-radius: 6px; padding: 1rem 1.2rem; background: #1a1206; margin: 0.8rem 0 1.1rem;
  }
  .reset-title { font-size: 1.2rem; font-weight: 700; color: var(--amber); margin: 0 0 0.5rem; }
  .reset-body { font-size: 1rem; color: var(--text); line-height: 1.6; margin: 0; }
  .reset-body strong { color: var(--amber); }
</style>

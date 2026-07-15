<script lang="ts">
  import { device, type SignerActivityEntry } from '../lib/device.svelte.js'

  const entries = $derived([...device.signerActivity].reverse())

  function statusLabel(entry: SignerActivityEntry): string {
    if (entry.outcome.startsWith('error:')) return 'Failed'
    if (entry.method === 'sign_event' && entry.outcome === 'signed') return 'Signed'
    if (entry.outcome === 'ok') return 'OK'
    return entry.outcome || 'Handled'
  }

  function statusTone(entry: SignerActivityEntry): 'ok' | 'warn' | 'bad' {
    if (entry.outcome.startsWith('error:')) return 'bad'
    if (entry.outcome === 'denied' || entry.outcome === 'timeout') return 'warn'
    return 'ok'
  }

  function sourceLabel(entry: SignerActivityEntry): string {
    return entry.source === 'relay-audit' ? 'relay audit' : 'device log'
  }

  function timeLabel(iso: string): string {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
</script>

<section class="activity" aria-live="polite">
  <div class="activity-head">
    <h2 class="section-title">Signer Activity</h2>
    <span class="count">{device.signerActivity.length} events</span>
  </div>
  <p class="hint-sm retention-note">The signer keeps its most recent requests in memory (up to 32).
    The list starts fresh each time it restarts; nothing is written to storage.</p>

  {#if entries.length === 0}
    <p class="empty">{device.connected ? 'No signing activity yet.' : 'Connect to view signer activity.'}</p>
  {:else}
    <div class="activity-list">
      {#each entries as entry (entry.id)}
        <article class="activity-row" class:activity-row--bad={statusTone(entry) === 'bad'} class:activity-row--warn={statusTone(entry) === 'warn'}>
          <div class="activity-main">
            <span class="status" class:status--bad={statusTone(entry) === 'bad'} class:status--warn={statusTone(entry) === 'warn'}>
              {statusLabel(entry)}
            </span>
            <span class="app">{entry.app}</span>
            {#if entry.kindText}
              <span class="kind">{entry.kindText}</span>
            {:else}
              <span class="kind">{entry.method}</span>
            {/if}
          </div>

          <div class="activity-meta">
            <span>{timeLabel(entry.at)}</span>
            <span>{entry.method}</span>
            {#if entry.client}
              <span>client {entry.client}</span>
            {/if}
            <span>{sourceLabel(entry)}</span>
          </div>

          {#if entry.preview}
            <code class="preview">{entry.preview}</code>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .activity {
    margin-bottom: 1rem;
  }

  .activity-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .activity-head .section-title {
    margin: 0;
  }

  .count {
    font-size: 0.7rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .activity-list {
    display: grid;
    gap: 0.5rem;
  }

  .activity-row {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    padding: 0.75rem 0.85rem;
  }

  .activity-row--warn {
    border-color: #4d3a0a;
    background: #100e00;
  }

  .activity-row--bad {
    border-color: #442222;
    background: #120808;
  }

  .activity-main {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .status {
    flex: 0 0 auto;
    min-width: 4.4rem;
    text-align: center;
    padding: 0.18rem 0.45rem;
    border: 1px solid #003a1a;
    border-radius: 3px;
    background: #001a0a;
    color: var(--green);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .status--warn {
    border-color: #3a2200;
    background: #1a0e00;
    color: var(--amber);
  }

  .status--bad {
    border-color: #442222;
    background: #1a0808;
    color: var(--red);
  }

  .app {
    color: #fff;
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .kind {
    color: var(--text-dim);
    font-size: 0.78rem;
    overflow-wrap: anywhere;
  }

  .activity-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.85rem;
    margin-top: 0.35rem;
    color: var(--text-muted);
    font-size: 0.72rem;
  }

  .preview {
    display: block;
    margin-top: 0.45rem;
    color: var(--green-dim);
    font-size: 0.72rem;
    line-height: 1.45;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .retention-note { margin: -0.4rem 0 0.8rem; }

  .empty {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    padding: 0.9rem;
  }

  @media (max-width: 640px) {
    .activity-main {
      align-items: flex-start;
      flex-direction: column;
      gap: 0.35rem;
    }

    .status {
      min-width: 0;
    }
  }
</style>

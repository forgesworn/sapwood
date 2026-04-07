<script lang="ts">
  import { device, httpTransport } from '../lib/device.svelte.js'

  async function resolve(id: string, action: 'approve' | 'deny') {
    const ok = await httpTransport.resolveApproval(id, action)
    if (ok) {
      device.approvals = device.approvals.filter(a => a.id !== id)
    }
  }
</script>

{#if device.approvals.length > 0}
  <section class="approval-queue">
    <h3 class="section-label section-label--amber">Pending approval</h3>
    {#each device.approvals as req}
      <div class="approval-card">
        <div class="approval-info">
          <span class="approval-method">{req.method ?? 'sign_event'}</span>
          {#if req.kind !== undefined}
            <span class="approval-kind">kind {req.kind}</span>
          {/if}
          {#if req.client_label}
            <span class="approval-client">{req.client_label}</span>
          {/if}
        </div>
        <div class="approval-actions">
          <button class="btn-approve" onclick={() => resolve(req.id as string, 'approve')}>Approve</button>
          <button class="btn-deny" onclick={() => resolve(req.id as string, 'deny')}>Deny</button>
        </div>
      </div>
    {/each}
  </section>
{/if}

<style>
  .approval-queue {
    background: #100e00;
    border: 1px solid #33290a;
    border-radius: 6px;
    padding: 1rem 1.25rem;
  }

  .section-label {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0 0 0.75rem;
  }
  .section-label--amber { color: var(--amber); }

  .approval-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.6rem 0;
    border-top: 1px solid #221c00;
  }
  .approval-card:first-of-type { border-top: none; }

  .approval-info {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
    flex: 1;
  }

  .approval-method {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--amber);
    font-family: inherit;
  }

  .approval-kind {
    font-size: 0.75rem;
    color: var(--text-dim);
    background: #1a1500;
    border: 1px solid #2a2000;
    border-radius: 3px;
    padding: 0.15rem 0.45rem;
  }

  .approval-client {
    font-size: 0.75rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .approval-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .btn-approve {
    background: var(--green);
    color: #050505;
    border: none;
    border-radius: 3px;
    padding: 0.35rem 0.85rem;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.12s;
  }
  .btn-approve:hover { background: #00ff88; }

  .btn-deny {
    background: transparent;
    color: var(--red);
    border: 1px solid #3a0808;
    border-radius: 3px;
    padding: 0.35rem 0.85rem;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.12s, border-color 0.12s;
  }
  .btn-deny:hover { background: #1a0808; border-color: var(--red); }
</style>

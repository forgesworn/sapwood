<script lang="ts">
  import { device, httpTransport } from '../lib/device.svelte.js'

  let errors = $state<Record<string, string>>({})

  async function resolve(id: string, action: 'approve' | 'deny') {
    const result = await httpTransport.resolveApproval(id, action)
    if (result.ok) {
      const { [id]: _gone, ...rest } = errors
      errors = rest
      device.approvals = device.approvals.filter(a => a.id !== id)
    } else {
      const verb = action === 'deny' ? 'deny' : 'approve'
      errors = { ...errors, [id]: `Could not ${verb}: ${result.error}` }
    }
  }
</script>

{#if device.approvals.length > 0}
  <section class="card card--warn">
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
          <button class="btn btn-primary btn-sm" onclick={() => resolve(req.id as string, 'approve')}>Approve</button>
          <button class="btn btn-danger btn-sm" onclick={() => resolve(req.id as string, 'deny')}>Deny</button>
        </div>
        {#if errors[req.id as string]}
          <p class="error-text approval-error" role="alert">{errors[req.id as string]}</p>
        {/if}
      </div>
    {/each}
  </section>
{/if}

<style>
  .approval-card {
    display: flex;
    flex-wrap: wrap;
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

  .approval-error { flex-basis: 100%; margin: 0; }

  .approval-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }
</style>

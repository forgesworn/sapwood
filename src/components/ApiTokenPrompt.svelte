<script lang="ts">
  import { device, submitApiToken, dismissApiTokenPrompt } from '../lib/device.svelte.js'

  // Token-entry prompt, shown when the bridge answers 401. The token is never
  // logged or displayed back; it goes straight to the transport on save.
  let tokenInput = $state('')
  let saving = $state(false)

  async function save() {
    if (!tokenInput.trim() || saving) return
    saving = true
    try {
      await submitApiToken(tokenInput)
      tokenInput = ''
    } finally {
      saving = false
    }
  }

  function cancel() {
    dismissApiTokenPrompt()
    tokenInput = ''
  }
</script>

<div class="token-prompt" role="alertdialog" aria-modal="true" aria-labelledby="token-prompt-title">
  <h2 id="token-prompt-title">This bridge requires an API token</h2>
  <p>
    The bridge rejected an unauthenticated request. Paste the API token from the
    machine running the bridge (it is printed by <code>heartwoodd</code> when the
    API is enabled). The token is stored in this browser only.
  </p>
  <label class="field-label" for="api-token">API token</label>
  <input
    id="api-token"
    type="password"
    class="field-input"
    bind:value={tokenInput}
    placeholder="API token"
    autocomplete="off"
    autocapitalize="off"
    autocorrect="off"
    spellcheck="false"
    data-1p-ignore
    data-lpignore="true"
    onkeydown={(e) => { if (e.key === 'Enter') save() }}
  />
  {#if device.apiTokenRejected}
    <p class="error-text">That token wasn't accepted — check it and try again.</p>
  {/if}
  <div class="token-prompt-actions">
    <button class="btn btn-secondary" onclick={cancel} disabled={saving}>Cancel</button>
    <button class="btn btn-primary" onclick={save} disabled={!tokenInput.trim() || saving}>
      {saving ? 'Checking…' : 'Save'}
    </button>
  </div>
</div>

<style>
  .token-prompt {
    background: #0b1206;
    border: 1px solid var(--green-dim);
    border-radius: 6px;
    padding: 1rem 1.1rem;
    margin-bottom: 1rem;
    color: var(--text);
  }
  .token-prompt h2 { margin: 0 0 0.5rem; font-size: 1rem; color: #fff; }
  .token-prompt p { margin: 0 0 0.8rem; font-size: 0.85rem; color: var(--text-dim); line-height: 1.55; }
  .token-prompt code { color: var(--green-dim); }
  .token-prompt .field-input { width: 100%; margin-top: 0.35rem; box-sizing: border-box; }
  .token-prompt-actions { display: flex; gap: 0.6rem; justify-content: flex-end; margin-top: 0.9rem; }
</style>

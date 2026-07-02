<script lang="ts">
  // The operator key — this browser's authority to manage signers over relays.
  // Extracted from the old Settings tab; lives under Identity in the console.
  import {
    getOrCreateOperator,
    regenerateOperator,
    importOperator,
    getOperatorMnemonic,
    importOperatorMnemonic,
  } from '../lib/op-mgmt.js'
  import { copyText } from '../lib/clipboard.js'
  import ConfirmButton from './ConfirmButton.svelte'

  let operator = $state(getOrCreateOperator())
  let opMnemonic = $state(getOperatorMnemonic())
  let opReveal = $state(false)
  let opPhraseReveal = $state(false)
  let opImportValue = $state('')
  let opPhraseImport = $state('')
  let opStatus = $state<string | null>(null)

  async function handleCopySecret() {
    opStatus = (await copyText(operator.skHex))
      ? 'Operator secret copied to clipboard.'
      : 'Copy failed — reveal and copy manually.'
  }

  async function handleCopyPhrase() {
    if (!opMnemonic) return
    opStatus = (await copyText(opMnemonic))
      ? 'Recovery phrase copied to clipboard.'
      : 'Copy failed — reveal and write the words down manually.'
  }

  function handleImport() {
    try {
      operator = importOperator(opImportValue)
      opMnemonic = getOperatorMnemonic()
      opImportValue = ''
      opReveal = false
      opStatus = `Imported. Operator pubkey is now ${operator.pubHex.slice(0, 16)}… — reconnect over WiFi.`
    } catch (e) {
      opStatus = e instanceof Error ? e.message : 'Import failed'
    }
  }

  function handleImportPhrase() {
    try {
      operator = importOperatorMnemonic(opPhraseImport)
      opMnemonic = getOperatorMnemonic()
      opPhraseImport = ''
      opPhraseReveal = false
      opStatus = `Restored from phrase. Operator pubkey is now ${operator.pubHex.slice(0, 16)}… — reconnect over WiFi.`
    } catch (e) {
      opStatus = e instanceof Error ? e.message : 'Restore failed'
    }
  }

  function handleRegenerate() {
    operator = regenerateOperator()
    opMnemonic = getOperatorMnemonic()
    opReveal = false
    opPhraseReveal = false
    opImportValue = ''
    opStatus = 'New operator key generated — write down its recovery phrase below.'
  }
</script>

<section class="operator">
  <h2 class="section-title">Operator key</h2>
  <p class="hint">
    Your authority to manage signers over WiFi. A signer learns its operator when you flash it —
    management only works if this key matches. (This is <em>not</em> the master seed; it's a
    separate, lower-stakes key.) <strong>Back it up</strong>: write down the recovery phrase and
    you can restore this exact key in any browser.
  </p>
  <table class="kv-table"><tbody>
    <tr><td class="label">Pubkey</td><td class="mono">{operator.pubHex}</td></tr>
    <tr>
      <td class="label">Recovery phrase</td>
      <td>
        {#if opMnemonic}
          {#if opPhraseReveal}
            <span class="mono phrase">{opMnemonic}</span>
            <div class="op-buttons">
              <button class="btn btn-secondary btn-sm" onclick={handleCopyPhrase}>Copy</button>
              <button class="btn btn-secondary btn-sm" onclick={() => opPhraseReveal = false}>Hide</button>
            </div>
          {:else}
            <span class="mono mono--masked">•••• •••• •••• •••• (12 words)</span>
            <div class="op-buttons">
              <button class="btn btn-secondary btn-sm" onclick={() => opPhraseReveal = true}>Reveal</button>
              <button class="btn btn-secondary btn-sm" onclick={handleCopyPhrase}>Copy</button>
            </div>
          {/if}
        {:else}
          <span class="hint-sm">No phrase — this is a legacy key. <strong class="amber">Regenerate</strong> to create a phrase-backed key (needs a re-flash).</span>
        {/if}
      </td>
    </tr>
    <tr>
      <td class="label">Secret</td>
      <td>
        {#if opReveal}
          <span class="mono secret">{operator.skHex}</span>
          <div class="op-buttons">
            <button class="btn btn-secondary btn-sm" onclick={handleCopySecret}>Copy</button>
            <button class="btn btn-secondary btn-sm" onclick={() => opReveal = false}>Hide</button>
          </div>
        {:else}
          <span class="mono mono--masked">••••••••••••••••••••••••••••••••</span>
          <div class="op-buttons">
            <button class="btn btn-secondary btn-sm" onclick={() => opReveal = true}>Reveal</button>
            <button class="btn btn-secondary btn-sm" onclick={handleCopySecret}>Copy</button>
          </div>
        {/if}
      </td>
    </tr>
  </tbody></table>

  <div class="inline-form">
    <input
      type="text"
      class="field-input"
      bind:value={opPhraseImport}
      placeholder="Restore: type your 12/24-word recovery phrase"
      spellcheck="false"
      autocomplete="off"
    />
    <button class="btn btn-secondary btn-sm" disabled={opPhraseImport.trim().split(/\s+/).length < 12} onclick={handleImportPhrase}>Restore</button>
    <ConfirmButton
      label="Regenerate"
      question="Replace your operator key? Signers flashed with the current one will refuse this browser until re-flashed."
      confirmLabel="Yes, replace it"
      onconfirm={handleRegenerate}
    />
  </div>

  <details class="disclosure">
    <summary>Advanced: import a raw 64-hex secret</summary>
    <div class="inline-form">
      <input
        type="text"
        class="field-input"
        bind:value={opImportValue}
        placeholder="Paste 64-hex operator secret"
        maxlength="64"
        spellcheck="false"
        autocomplete="off"
      />
      <button class="btn btn-secondary btn-sm" disabled={opImportValue.trim().length !== 64} onclick={handleImport}>Import</button>
    </div>
    <p class="hint-sm">A raw secret has no recovery phrase. Use this only to match a signer flashed elsewhere.</p>
  </details>

  {#if opStatus}<p class="hint-sm status">{opStatus}</p>{/if}
</section>

<style>
  .operator { display: flex; flex-direction: column; gap: 0.75rem; }
  .operator .section-title, .operator .hint { margin-bottom: 0; }
  .op-buttons { display: flex; gap: 0.35rem; margin-top: 0.4rem; }
  .mono.secret { color: var(--amber); }
  .mono.phrase { color: var(--text); line-height: 1.7; word-spacing: 0.25rem; display: inline-block; }
  .amber { color: var(--amber); }
  .inline-form { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
  .inline-form input { flex: 1; min-width: 12rem; padding: 0.4rem 0.6rem; font-size: 0.82rem; }
  .status { color: var(--text-dim); }

  @media (max-width: 640px) {
    .kv-table td.label { width: auto; }
  }
</style>

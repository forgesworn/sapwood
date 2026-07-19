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
  import { device, setOperatorOverUsb } from '../lib/device.svelte.js'
  import ConfirmButton from './ConfirmButton.svelte'

  let operator = $state(getOrCreateOperator())
  let opMnemonic = $state(getOperatorMnemonic())
  let opReveal = $state(false)
  let opPhraseReveal = $state(false)
  let opImportValue = $state('')
  let opPhraseImport = $state('')
  let opStatus = $state<string | null>(null)
  let settingOperator = $state(false)
  const signerOperator = $derived(
    device.mode === 'serial' && device.usbNetworkState?.configured
      ? (device.usbNetworkState.op_mgmt ?? '')
      : '',
  )
  const operatorMatchesSigner = $derived(!!signerOperator && signerOperator === operator.pubHex)

  async function handleCopySecret() {
    opStatus = (await copyText(operator.skHex))
      ? 'Operator secret copied to clipboard.'
      : 'Copy failed. Reveal and copy manually.'
  }

  async function handleCopyPhrase() {
    if (!opMnemonic) return
    opStatus = (await copyText(opMnemonic))
      ? 'Recovery phrase copied to clipboard.'
      : 'Copy failed. Reveal and write the words down manually.'
  }

  function handleImport() {
    try {
      operator = importOperator(opImportValue)
      opMnemonic = getOperatorMnemonic()
      opImportValue = ''
      opReveal = false
      opStatus = `Imported. Operator pubkey is now ${operator.pubHex.slice(0, 16)}… Reconnect over WiFi.`
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
      opStatus = `Restored from phrase. Operator pubkey is now ${operator.pubHex.slice(0, 16)}… Reconnect over WiFi.`
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
    opStatus = 'New operator key generated. Write down its recovery phrase below.'
  }

  async function handleSetOperator() {
    settingOperator = true
    opStatus = null
    try {
      await setOperatorOverUsb(operator.pubHex)
      opStatus = 'Confirmed after reboot. This signer now accepts this browser as its management operator.'
    } catch (e) {
      opStatus = e instanceof Error ? e.message : 'Operator change failed'
    } finally {
      settingOperator = false
    }
  }
</script>

<section class="operator" id="operator-key">
  <h2 class="section-title">Operator key</h2>
  <p class="hint">
    Your authority to manage signers over WiFi. A signer learns its operator when you flash it.
    Management only works if this key matches. (This is <em>not</em> the master seed; it's a
    separate, lower-stakes key.) <strong>Back it up</strong>: write down the recovery phrase and
    you can restore this exact key in any browser.
  </p>
  <p class="restore-note">
    If Sapwood reaches the relay but the signer never answers, restore the operator recovery phrase
    created when that signer was flashed. After restoring, disconnect and reconnect over WiFi.
  </p>
  <p class="hint-sm op-guide">
    See <a href="https://github.com/forgesworn/sapwood/blob/main/docs/backup-and-restore.md"
      target="_blank" rel="noopener">the backup and restore guide</a> for this operator key, your
    identities, and what a factory reset does not keep.
  </p>

  {#if device.mode === 'serial'}
    <div class="card operator-binding" class:operator-binding--ok={operatorMatchesSigner}>
      <strong>Operator trusted by this signer</strong>
      {#if device.usbNetworkSupport === 'unknown'}
        <p class="hint-sm">Reading the public operator binding from the device…</p>
      {:else if device.usbNetworkSupport === 'unsupported'}
        <p class="hint-sm">This firmware cannot expose or rotate the operator safely. Update it over USB first; Sapwood will not rewrite the network as a workaround.</p>
      {:else if !device.usbNetworkState?.configured}
        <p class="hint-sm">No network/operator configuration is stored yet. Initial setup establishes it.</p>
      {:else}
        <p class="mono binding-key">{signerOperator || 'none configured'}</p>
        {#if operatorMatchesSigner}
          <p class="hint-sm success-text">This browser has the matching operator key.</p>
        {:else}
          <p class="hint-sm error-text">This browser's key does not match. Restore the matching operator phrase above if you have it. Deliberately replacing it requires the signer in your hand.</p>
          <ConfirmButton
            label="Set this browser as operator"
            question="Replace only this signer's management operator? Its WiFi password and relays are preserved."
            confirmLabel="Yes, show device confirmation"
            busyLabel="Waiting for the signer…"
            busy={settingOperator}
            buttonClass="btn btn-warn btn-sm"
            onconfirm={handleSetOperator}
          />
        {/if}
      {/if}
    </div>
  {/if}
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
          <span class="hint-sm">No phrase. This is a legacy key. <strong class="amber">Regenerate</strong> to create a phrase-backed key (needs a re-flash).</span>
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
      placeholder="Paste the matching 12/24-word operator recovery phrase"
      spellcheck="false"
      autocomplete="off"
    />
    <button class="btn btn-secondary btn-sm" disabled={opPhraseImport.trim().split(/\s+/).length < 12} onclick={handleImportPhrase}>Restore key</button>
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
  .restore-note {
    margin: 0;
    background: #120f06;
    border: 1px solid #3a3320;
    border-radius: 6px;
    color: var(--amber);
    font-size: 0.84rem;
    line-height: 1.55;
    padding: 0.65rem 0.8rem;
  }
  .op-buttons { display: flex; gap: 0.35rem; margin-top: 0.4rem; }
  .mono.secret { color: var(--amber); }
  .mono.phrase { color: var(--text); line-height: 1.7; word-spacing: 0.25rem; display: inline-block; }
  .amber { color: var(--amber); }
  .inline-form { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
  .inline-form input { flex: 1; min-width: 12rem; padding: 0.4rem 0.6rem; font-size: 0.82rem; }
  .status { color: var(--text-dim); }
  .op-guide a { color: var(--green); }
  .operator-binding { display: flex; flex-direction: column; gap: 0.5rem; }
  .operator-binding p { margin: 0; }
  .operator-binding--ok { border-color: var(--green); }
  .binding-key { overflow-wrap: anywhere; }

  @media (max-width: 640px) {
    .kv-table td.label { width: auto; }
  }
</style>

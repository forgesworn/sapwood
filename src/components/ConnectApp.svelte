<script lang="ts">
  // The "connect an app" guided flow — the one task the admin Home makes trivial.
  //   name → what it can do (presets) → a QR to scan into the app.
  // Wraps the existing mgmt actions (mgmtCreateClient / mgmtUpdateClient) so it
  // works identically over WiFi (relay) and USB. Logic lives in connect-flow.ts
  // and client-presets.ts (both pure + unit-tested); this holds the reactive UI.
  import { encodeQR } from '@paulmillr/qr'
  import {
    device, mgmtCreateClient, mgmtUpdateClient, mgmtCanApproveSigning,
  } from '../lib/device.svelte.js'
  import { COMMON_KINDS } from '../lib/kinds.js'
  import { nameError, canCreate, type ConnectStep } from '../lib/connect-flow.js'
  import {
    PERMISSION_PRESETS, resolveKinds, isRestricted, type PresetId,
  } from '../lib/client-presets.js'

  interface Props {
    /** Called after the operator finishes (dismisses the result). */
    ondone?: () => void
  }
  let { ondone }: Props = $props()

  let open = $state(false)
  let step = $state<ConnectStep>('name')
  let name = $state('')
  let presetId = $state<PresetId>('everything')
  let customKinds = $state<number[]>([])
  let creating = $state(false)
  let error = $state<string | null>(null)
  let permNote = $state<string | null>(null)

  // The created connection — the one time the bunker URI/secret is shown.
  let created = $state<{ bunker_uri: string; secret: string } | null>(null)
  let copied = $state(false)

  const overUsb = $derived(device.mode === 'serial')
  const qr = $derived(created?.bunker_uri ? encodeQR(created.bunker_uri, 'svg') : '')

  function reset() {
    step = 'name'
    name = ''
    presetId = 'everything'
    customKinds = []
    error = null
    permNote = null
    created = null
  }

  function start() {
    reset()
    open = true
  }

  function cancel() {
    open = false
    reset()
  }

  function toggleKind(kind: number) {
    customKinds = customKinds.includes(kind)
      ? customKinds.filter((k) => k !== kind)
      : [...customKinds, kind]
  }

  async function create() {
    if (!canCreate(name)) { error = nameError(name); return }
    creating = true
    error = null
    permNote = null
    try {
      // Over relay we hold operator authority, so pre-approve signing; over USB
      // the first sign is approved by a physical button press instead.
      const res = await mgmtCreateClient(name.trim(), mgmtCanApproveSigning())

      // Apply the permission preset (skip when "everything" — unrestricted).
      if (isRestricted(presetId, customKinds)) {
        const kinds = resolveKinds(presetId, customKinds)!
        try {
          await mgmtUpdateClient(res.slot_index, { allowed_kinds: kinds })
        } catch (e) {
          // The connection still exists; only the limit failed to apply.
          permNote = overUsb
            ? 'Connection made, but applying the limit needs a button press on the device — set it under Advanced › Clients.'
            : `Connection made, but the permission limit could not be applied: ${e instanceof Error ? e.message : 'unknown error'}.`
        }
      }

      created = { bunker_uri: res.bunker_uri, secret: res.secret }
      step = 'result'
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not create the connection.'
    } finally {
      creating = false
    }
  }

  async function copyLink() {
    if (!created?.bunker_uri) return
    let ok = false
    try {
      await navigator.clipboard.writeText(created.bunker_uri)
      ok = true
    } catch {
      // clipboard API can be blocked (insecure context / permissions) — fall
      // back to a hidden textarea + execCommand so copy still works.
      try {
        const ta = document.createElement('textarea')
        ta.value = created.bunker_uri
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch { /* the URI is shown as selectable text below — copy by hand */ }
    }
    if (ok) {
      copied = true
      setTimeout(() => (copied = false), 1600)
    }
  }

  function finish() {
    open = false
    reset()
    ondone?.()
  }
</script>

{#if !open}
  <button class="hero" onclick={start}>
    <span class="hero-plus">+</span>
    <span class="hero-text">
      <span class="hero-title">Connect an app</span>
      <span class="hero-sub">Let a Nostr app sign with this device</span>
    </span>
    <span class="hero-arrow">→</span>
  </button>
{:else}
  <section class="flow" aria-label="Connect an app">
    {#if step === 'name'}
      <h3 class="flow-title">What are you connecting?</h3>
      <p class="flow-hint">Give it a name you will recognise — the app and where it runs.</p>
      <input
        type="text"
        class="text-input"
        bind:value={name}
        placeholder="e.g. Damus on my phone"
        onkeydown={(e) => { if (e.key === 'Enter' && canCreate(name)) step = 'permissions' }}
        disabled={creating}
      />
      {#if error}<p class="flow-error">{error}</p>{/if}
      <div class="flow-actions">
        <button class="btn-ghost" onclick={cancel}>Cancel</button>
        <button class="btn-primary" disabled={!canCreate(name)} onclick={() => { error = null; step = 'permissions' }}>
          Continue
        </button>
      </div>

    {:else if step === 'permissions'}
      <h3 class="flow-title">What can “{name.trim()}” do?</h3>
      <p class="flow-hint">You can change this later under Advanced.</p>
      <div class="presets">
        {#each PERMISSION_PRESETS as preset (preset.id)}
          <button
            class="preset"
            class:selected={presetId === preset.id}
            onclick={() => (presetId = preset.id)}
          >
            <span class="preset-radio" class:on={presetId === preset.id}></span>
            <span class="preset-body">
              <span class="preset-label">{preset.label}</span>
              <span class="preset-desc">{preset.description}</span>
            </span>
          </button>
        {/each}
      </div>

      {#if presetId === 'custom'}
        <div class="kind-grid">
          {#each COMMON_KINDS as ki (ki.kind)}
            <button
              class="kind-chip"
              class:on={customKinds.includes(ki.kind)}
              onclick={() => toggleKind(ki.kind)}
            >{ki.label}</button>
          {/each}
        </div>
      {/if}

      {#if overUsb}
        <p class="flow-note">Over USB the first signature is approved by a physical button press on the device.</p>
      {/if}
      {#if error}<p class="flow-error">{error}</p>{/if}
      <div class="flow-actions">
        <button class="btn-ghost" onclick={() => { error = null; step = 'name' }} disabled={creating}>Back</button>
        <button class="btn-primary" onclick={create} disabled={creating}>
          {creating ? 'Creating…' : 'Create connection'}
        </button>
      </div>

    {:else if step === 'result' && created}
      <div class="result-head">
        <span class="result-dot"></span>
        <h3 class="flow-title">Connection ready</h3>
      </div>
      {#if created.bunker_uri}
        <p class="flow-hint">Scan this with the app — or copy the link below and paste it in. It works once.</p>
        <div class="qr">{@html qr}</div>
        <div class="uri-box"><code>{created.bunker_uri}</code></div>
        <button class="btn-copy" class:copied onclick={copyLink}>{copied ? 'Link copied ✓' : 'Copy link'}</button>
        <p class="flow-warn">This link carries the connection secret. Anyone who has it can sign as this app.</p>
      {:else}
        <p class="flow-warn">
          Created, but this device has no relay set, so there is no link to scan yet. Set a relay
          (Advanced › Connectivity), then reopen the connection. The secret is
          <code class="inline-secret">{created.secret}</code>.
        </p>
      {/if}
      {#if permNote}<p class="flow-note">{permNote}</p>{/if}
      <div class="flow-actions">
        <button class="btn-primary" onclick={finish}>Done</button>
      </div>
    {/if}
  </section>
{/if}

<style>
  /* Hero call-to-action */
  .hero {
    display: flex;
    align-items: center;
    gap: 1rem;
    width: 100%;
    text-align: left;
    background: var(--green);
    color: #050505;
    border: none;
    border-radius: 8px;
    padding: 1.1rem 1.4rem;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s, box-shadow 0.15s;
  }
  .hero:hover { background: #00ff88; box-shadow: var(--green-glow); }
  .hero-plus { font-size: 1.8rem; font-weight: 700; line-height: 1; }
  .hero-text { display: flex; flex-direction: column; gap: 0.15rem; flex: 1; }
  .hero-title { font-size: 1.1rem; font-weight: 700; }
  .hero-sub { font-size: 0.82rem; opacity: 0.75; }
  .hero-arrow { font-size: 1.3rem; font-weight: 700; }

  /* The flow */
  .flow {
    background: var(--surface-raised);
    border: 1px solid var(--border-bright);
    border-radius: 8px;
    padding: 1.4rem;
  }
  .flow-title { font-size: 1.1rem; font-weight: 600; color: #fff; margin: 0 0 0.35rem; }
  .flow-hint { font-size: 0.86rem; color: var(--text-dim); margin: 0 0 1rem; line-height: 1.5; }
  .flow-note { font-size: 0.78rem; color: var(--text-dim); margin: 0.9rem 0 0; line-height: 1.45; }
  .flow-warn { font-size: 0.78rem; color: var(--amber); margin: 0.9rem 0 0; line-height: 1.45; }
  .flow-error { font-size: 0.85rem; color: var(--red); margin: 0.6rem 0 0; }
  .inline-secret { color: var(--green); word-break: break-all; user-select: all; }

  .text-input {
    width: 100%;
    background: #0e0e0e;
    border: 1px solid #3a3a3a;
    color: #eee;
    padding: 0.7rem 0.9rem;
    border-radius: 5px;
    font-family: inherit;
    font-size: 1rem;
  }
  .text-input:focus { outline: none; border-color: var(--green); }
  .text-input::placeholder { color: #666; }

  .presets { display: flex; flex-direction: column; gap: 0.5rem; }
  .preset {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.8rem 1rem;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.12s, background 0.12s;
  }
  .preset:hover { border-color: #444; }
  .preset.selected { border-color: var(--green-dim); background: #08130d; }
  .preset-radio {
    width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; margin-top: 0.2rem;
    border: 2px solid #444; transition: all 0.12s;
  }
  .preset-radio.on { border-color: var(--green); background: var(--green); box-shadow: var(--green-glow); }
  .preset-body { display: flex; flex-direction: column; gap: 0.2rem; }
  .preset-label { font-size: 0.95rem; font-weight: 600; color: #fff; }
  .preset-desc { font-size: 0.8rem; color: var(--text-dim); line-height: 1.45; }

  .kind-grid { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.9rem; }
  .kind-chip {
    background: var(--surface); border: 1px solid var(--border); border-radius: 4px;
    padding: 0.35rem 0.7rem; font-family: inherit; font-size: 0.8rem; color: var(--text);
    cursor: pointer; transition: all 0.12s;
  }
  .kind-chip:hover { border-color: #444; }
  .kind-chip.on { border-color: var(--green); color: var(--green); background: #08130d; }

  .result-head { display: flex; align-items: center; gap: 0.55rem; margin-bottom: 0.35rem; }
  .result-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--green); box-shadow: var(--green-glow); }
  .result-head .flow-title { margin: 0; }
  .qr { width: 196px; max-width: 100%; padding: 12px; background: #fff; border-radius: 6px; margin: 0.25rem 0 0.9rem; }
  .qr :global(svg) { display: block; width: 100%; height: auto; }

  /* The bunker link as selectable text — always copyable by hand, even if the
     clipboard button is blocked. Tap/click selects the whole URI. */
  .uri-box {
    background: #050505; border: 1px solid var(--border); border-radius: 5px;
    padding: 0.6rem 0.7rem; margin: 0 0 0.7rem;
  }
  .uri-box code {
    display: block; font-size: 0.76rem; color: var(--green); line-height: 1.5;
    word-break: break-all; user-select: all;
  }

  .flow-actions { display: flex; gap: 0.6rem; justify-content: flex-end; margin-top: 1.2rem; }

  .btn-primary {
    background: var(--green); color: #050505; border: none; padding: 0.6rem 1.4rem;
    border-radius: 5px; font-family: inherit; font-size: 0.92rem; font-weight: 600;
    cursor: pointer; transition: background 0.15s, box-shadow 0.15s;
  }
  .btn-primary:hover:not(:disabled) { background: #00ff88; box-shadow: var(--green-glow); }
  .btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }

  .btn-ghost {
    background: transparent; color: var(--text-dim); border: 1px solid var(--border-bright);
    padding: 0.6rem 1.2rem; border-radius: 5px; font-family: inherit; font-size: 0.92rem; cursor: pointer;
  }
  .btn-ghost:hover:not(:disabled) { color: var(--text); border-color: #444; }
  .btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-copy {
    background: var(--surface); border: 1px solid var(--border-bright); color: var(--text);
    padding: 0.5rem 1.1rem; border-radius: 5px; font-family: inherit; font-size: 0.85rem; cursor: pointer;
  }
  .btn-copy:hover { background: var(--surface-hover); }
  .btn-copy.copied { border-color: var(--green-dim); color: var(--green); }

  @media (max-width: 640px) {
    .flow { padding: 1.1rem; }
    .flow-actions { flex-direction: column-reverse; }
    .flow-actions button { width: 100%; }
  }
</style>

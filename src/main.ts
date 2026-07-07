// Self-hosted JetBrains Mono — bundled and served from our own origin, so the
// app makes no third-party font request (no IP leak). Enforced by the CSP in
// vite.config.ts. Weights match the old Google Fonts request (400/500/600/700).
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import './app.css'
import { mount } from 'svelte'
import Root from './Root.svelte'
import { consumeImportLink } from './lib/import-link.svelte.js'
import { migrateOperatorStorage } from './lib/op-mgmt.js'

// Purge any malformed legacy operator record before anything reads it.
migrateOperatorStorage()

// Load an operator key from a "connect your phone" deep link, if present, before
// the app mounts (and strip it from the URL).
consumeImportLink()

const app = mount(Root, { target: document.getElementById('app')! })

export default app

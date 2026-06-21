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

const app = mount(Root, { target: document.getElementById('app')! })

export default app

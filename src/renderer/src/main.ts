import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { ensureApi } from './lib/rpc'

// In the desktop app the preload already put `window.api` in place. Served from
// localhost there is no preload, so connect the WebSocket transport first —
// every component assumes the API is simply there.
await ensureApi()

const app = mount(App, { target: document.getElementById('app')! })

export default app

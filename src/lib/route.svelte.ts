// Hash-based routing. Static-host friendly (GitHub Pages serves the SPA at a
// subpath), and keeps the two surfaces — the /flash wizard and the admin app —
// as one build. `#/flash` -> flasher; anything else -> admin.

export type Route = 'flash' | 'admin'

/** Map a location hash to a route. Exported for testing. */
export function parseRoute(hash: string): Route {
  return hash.replace(/^#\/?/, '').toLowerCase().startsWith('flash') ? 'flash' : 'admin'
}

export const router = $state<{ route: Route }>({
  route: typeof location !== 'undefined' ? parseRoute(location.hash) : 'admin',
})

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    router.route = parseRoute(location.hash)
  })
}

/** Navigate to a route by setting the hash (fires hashchange). */
export function navigate(route: Route): void {
  location.hash = route === 'flash' ? '#/flash' : '#/'
}

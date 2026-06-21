// Detect whether an origin actually serves a Heartwood bridge API, used by the
// auto-connect probe. A static host (GitHub Pages, sapwood.forgesworn.dev)
// answers unknown paths with the SPA's index.html — an HTML 200 that must NOT be
// mistaken for a bridge, or the client tries to parse "<!DOCTYPE …" as JSON.

/** True only if the response is a real bridge reply: a JSON 200. */
export async function looksLikeBridge(res: Response | null): Promise<boolean> {
  if (!res || !res.ok) return false
  if (!(res.headers.get('content-type') ?? '').includes('json')) return false
  try {
    await res.clone().json()
    return true
  } catch {
    return false
  }
}

/**
 * Probe an origin for a bridge API. Returns true only on a JSON 200 from
 * /api/info or /api/bridge/info. `fetchImpl` is injectable for testing.
 */
export async function probeBridge(origin: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  for (const path of ['/api/info', '/api/bridge/info']) {
    const res = await fetchImpl(`${origin}${path}`, { cache: 'no-store' }).catch(() => null)
    if (await looksLikeBridge(res)) return true
  }
  return false
}

/**
 * Keep the first item for each key, preserving order.
 *
 * Lists that reach a keyed `{#each}` must not repeat a key: Svelte throws
 * `each_key_duplicate`, which unmounts the whole surrounding component and
 * leaves a blank panel. Where a repeat carries no information for the user
 * (the same identity reported twice, the same SSID from a second radio),
 * collapsing it here is both the correct display and the crash guard.
 */
export function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

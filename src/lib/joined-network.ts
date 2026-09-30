/** The SSID the signer actually joined, or `undefined` when unknown. With a
 * fallback list this can be a network other than the primary. `joined_index`
 * is the firmware's `wifi_index`: `0` for `ssid`, `n` for `networks[n - 1]`. */
export function joinedSsid(
  state: { ssid?: string; networks?: Array<{ ssid: string }>; joined_index?: number },
): string | undefined {
  const index = state.joined_index
  if (index === undefined) return undefined
  const ssid = index === 0 ? state.ssid : state.networks?.[index - 1]?.ssid
  return ssid || undefined
}

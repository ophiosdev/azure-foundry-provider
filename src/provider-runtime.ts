import type { FetchFunction } from "@ai-sdk/provider-utils"

function hasAuthHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false
  for (const key in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, key)) continue
    if (key === "authorization" || key === "Authorization") return true
    if (key === "api-key" || key === "Api-Key") return true
    const lower = key.toLowerCase()
    if (lower === "authorization" || lower === "api-key") return true
  }
  return false
}

function mergeSignals(existing: AbortSignal | null | undefined, timeout: number): AbortSignal {
  if (!existing) return AbortSignal.timeout(timeout)
  return AbortSignal.any([existing, AbortSignal.timeout(timeout)])
}

function wrapFetch(
  fetchFn: FetchFunction | undefined,
  timeout: number | false | undefined,
): FetchFunction | undefined {
  const baseFetch = fetchFn ?? fetch
  if (timeout === undefined) return baseFetch

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (timeout === false) return baseFetch(input, init)

    const signal = mergeSignals(init?.signal, timeout)
    return baseFetch(input, {
      ...init,
      signal,
    })
  }

  return Object.assign(wrapped, {
    preconnect: fetch.preconnect,
  }) as FetchFunction
}

export { hasAuthHeader, mergeSignals, wrapFetch }

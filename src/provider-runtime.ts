import type { FetchFunction } from "@ai-sdk/provider-utils"

function hasAuthHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false
  return Object.keys(headers).some((key) => {
    const lower = key.toLowerCase()
    return lower === "authorization" || lower === "api-key"
  })
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

/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FetchFunction } from "@ai-sdk/provider-utils"

class AuthenticationFailure extends Error {
  constructor(readonly original: unknown) {
    super("Authentication failed", { cause: original })
  }
}

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

function requestSignal(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): AbortSignal | undefined {
  if (init?.signal !== undefined) return init.signal ?? undefined
  return input instanceof Request ? input.signal : undefined
}

function requestHeaders(input: RequestInfo | URL, init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
}

function waitForSignal<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  // Fetch permits arbitrary AbortSignal reasons, so preserve them verbatim.
  if (signal.aborted) return Promise.reject(signal.reason as Error)

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = () => {
      signal.removeEventListener("abort", onAbort)
      settled = true
    }
    const onAbort = () => {
      if (settled) return
      finish()
      reject(signal.reason as Error)
    }

    signal.addEventListener("abort", onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        if (settled) {
          try {
            onLateValue?.(value)
          } catch {
            // Late-result cleanup must not create an unhandled rejection.
          }
          return
        }
        finish()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        finish()
        // Preserve arbitrary rejection values from caller-provided fetch functions.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error)
      },
    )
  })
}

function wrapResponseBody(response: Response, onDone: () => void, signal?: AbortSignal): Response {
  if (!response.body) {
    onDone()
    return response
  }

  const reader = response.body.getReader()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let terminal = false
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    signal?.removeEventListener("abort", abort)
    onDone()
  }
  const abort = () => {
    if (terminal) return
    terminal = true
    const reason = signal?.reason ?? new DOMException("The operation was aborted", "AbortError")
    controller?.error(reason)
    void reader.cancel(reason).catch(() => {})
    cleanup()
  }

  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      if (signal?.aborted) {
        abort()
      } else {
        signal?.addEventListener("abort", abort, { once: true })
      }
    },
    async pull(value) {
      if (terminal) return
      try {
        const chunk = await reader.read()
        if (terminal) return
        if (chunk.done) {
          terminal = true
          value.close()
          cleanup()
          return
        }
        value.enqueue(chunk.value)
      } catch (error) {
        if (terminal) return
        terminal = true
        value.error(error)
        void reader.cancel(error).catch(() => {})
        cleanup()
      }
    },
    cancel(reason) {
      if (terminal) return
      terminal = true
      void reader.cancel(reason).catch(() => {})
      cleanup()
    },
  })

  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  })
  return wrapped
}

function wrapFetch(
  fetchFn: FetchFunction | undefined,
  timeout: number | false | undefined,
): FetchFunction {
  const baseFetch = fetchFn ?? fetch
  if (timeout === undefined || timeout === false) return baseFetch
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new RangeError("timeout must be a finite non-negative number or false")
  }

  const timeoutMs = Math.floor(timeout)

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const callerSignal = requestSignal(input, init)
    if (callerSignal?.aborted) throw callerSignal.reason

    const controller = new AbortController()
    let timedOut = false
    const onCallerAbort = () => {
      controller.abort(callerSignal?.reason)
    }
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true })
    if (callerSignal?.aborted) onCallerAbort()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException("The operation timed out", "TimeoutError"))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", onCallerAbort)
    }

    try {
      const pending = baseFetch(input, { ...init, signal: controller.signal })
      const response = await waitForSignal(pending, controller.signal, (lateResponse) => {
        void lateResponse.body?.cancel().catch(() => {})
      })
      return wrapResponseBody(response, cleanup, controller.signal)
    } catch (error) {
      cleanup()
      if (callerSignal?.aborted) throw callerSignal.reason
      if (timedOut) throw controller.signal.reason
      throw error
    }
  }

  return Object.assign(wrapped, { preconnect: baseFetch.preconnect })
}

export {
  AuthenticationFailure,
  hasAuthHeader,
  requestHeaders,
  requestSignal,
  waitForSignal,
  wrapFetch,
  wrapResponseBody,
}

/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { hasAuthHeader, requestHeaders, requestSignal, wrapFetch } from "../src/provider-runtime"

describe("provider-runtime hasAuthHeader", () => {
  test("detects auth headers through lowercase normalization", () => {
    expect(hasAuthHeader({ AUTHORIZATION: "Bearer x" })).toBe(true)
    expect(hasAuthHeader({ "API-KEY": "k" })).toBe(true)
  })

  test("returns false when no auth headers are present", () => {
    expect(hasAuthHeader({ "content-type": "application/json" })).toBe(false)
    expect(hasAuthHeader(undefined)).toBe(false)
  })
})

describe("provider-runtime wrapFetch", () => {
  test("keeps timeout active until the response body finishes", async () => {
    const fetchFn = Object.assign(
      async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise<void>(() => {}),
          }),
        ),
      { preconnect: fetch.preconnect },
    ) as typeof fetch
    const wrapped = wrapFetch(fetchFn, 30)
    if (!wrapped) throw new Error("missing fetch wrapper")

    const response = await wrapped("https://example.com")

    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      await expect(
        Promise.race([
          response.text(),
          new Promise<never>((_resolve, reject) => {
            guard = setTimeout(() => reject(new Error("timeout guard")), 100)
          }),
        ]),
      ).rejects.toMatchObject({ name: "TimeoutError" })
    } finally {
      if (guard) clearTimeout(guard)
    }
  })

  test("preserves a Request input signal when applying timeout", async () => {
    const controller = new AbortController()
    let attemptSignal: AbortSignal | undefined
    let resolveFetch: ((response: Response) => void) | undefined
    const fetchFn = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        attemptSignal = init?.signal ?? undefined
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch
    const wrapped = wrapFetch(fetchFn, 1000)
    if (!wrapped) throw new Error("missing fetch wrapper")
    const request = new Request("https://example.com", { signal: controller.signal })

    const pending = wrapped(request)
    controller.abort("caller-stop")

    expect(attemptSignal?.aborted).toBe(true)
    expect(attemptSignal?.reason).toBe("caller-stop")
    await expect(pending).rejects.toBe("caller-stop")
    resolveFetch?.(new Response(null))
    await Promise.resolve()
  })

  test("inherits Request headers unless RequestInit replaces them", () => {
    const request = new Request("https://example.com", {
      headers: { authorization: "Bearer input", "x-input": "kept" },
    })
    const override = new AbortController().signal

    expect(requestHeaders(request, undefined).get("x-input")).toBe("kept")
    expect(requestHeaders(request, { headers: { "x-override": "set" } }).get("x-input")).toBeNull()
    expect(requestSignal(request, undefined)).toBe(request.signal)
    expect(requestSignal(request, { signal: override })).toBe(override)
    expect(requestSignal(request, { signal: null })).toBeUndefined()
  })

  test("clears attempt timeout when response body finishes", async () => {
    let attemptSignal: AbortSignal | undefined
    const fetchFn = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        attemptSignal = init?.signal ?? undefined
        return new Response("done")
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch
    const wrapped = wrapFetch(fetchFn, 20)
    if (!wrapped) throw new Error("missing fetch wrapper")

    const response = await wrapped("https://example.com")
    expect(await response.text()).toBe("done")
    await Bun.sleep(30)

    expect(attemptSignal?.aborted).toBe(false)
  })

  test("aborting caller cancels response body with the caller reason", async () => {
    const controller = new AbortController()
    let cancelReason: unknown
    const fetchFn = Object.assign(
      async () =>
        new Response(
          new ReadableStream({
            cancel(reason) {
              cancelReason = reason
            },
            pull: () => new Promise<void>(() => {}),
          }),
        ),
      { preconnect: fetch.preconnect },
    ) as typeof fetch
    const wrapped = wrapFetch(fetchFn, 1000)
    if (!wrapped) throw new Error("missing fetch wrapper")
    const response = await wrapped("https://example.com", { signal: controller.signal })
    const reading = response.text()

    controller.abort("caller-stop")

    await expect(reading).rejects.toBe("caller-stop")
    expect(cancelReason).toBe("caller-stop")
  })

  test("forwards custom preconnect and bypasses wrapper when timeout is disabled", () => {
    const preconnect = () => {}
    const fetchFn = Object.assign(async () => new Response(null), { preconnect }) as typeof fetch

    expect(wrapFetch(fetchFn, 100)?.preconnect).toBe(preconnect)
    expect(wrapFetch(fetchFn, false)).toBe(fetchFn)
    expect(wrapFetch(fetchFn, undefined)).toBe(fetchFn)
  })

  test("rejects invalid timeout values", () => {
    const fetchFn = Object.assign(async () => new Response(null), {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    expect(() => wrapFetch(fetchFn, Number.NaN)).toThrow(RangeError)
    expect(() => wrapFetch(fetchFn, Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => wrapFetch(fetchFn, -1)).toThrow(RangeError)
  })
})

/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { __test } from "../src/quota"

describe("phase 2 window queue behavior", () => {
  test("prunes old entries from request/token windows", async () => {
    let now = 0
    const governor = __test.createGovernor(
      {
        quota: {
          default: {
            rpm: 3,
            tpm: 50,
            maxConcurrent: 1,
          },
        },
      },
      {
        now: () => now,
        wait: async () => {},
        windowMs: 100,
      },
    )

    const r1 = await governor.acquire("m1", 10)
    r1()
    now = 20
    const r2 = await governor.acquire("m1", 10)
    r2()
    now = 40
    const r3 = await governor.acquire("m1", 10)
    r3()

    now = 250
    const r4 = await governor.acquire("m1", 10)
    r4()

    const state = __test.debugWindowState(governor, "m1")
    expect(state).toBeDefined()
    if (!state) throw new Error("missing window state")
    expect(state.requestsLength).toBeLessThanOrEqual(1)
    expect(state.tokensLength).toBeLessThanOrEqual(1)
  })

  test("prunes and compacts large request and token histories after window expiry", async () => {
    let now = 0

    const governor = __test.createGovernor(
      {
        quota: {
          default: {
            rpm: 5000,
            tpm: 500000,
          },
        },
      },
      {
        now: () => now,
        wait: async () => {},
        windowMs: 100,
      },
    )

    for (let i = 0; i < 1200; i += 1) {
      now = Math.floor(i / 20)
      const release = await governor.acquire("m", 5)
      release()
    }

    let state = __test.debugWindowState(governor, "m")
    expect(state).toBeDefined()
    if (!state) throw new Error("missing window state")
    expect(state.requestsLength).toBeGreaterThan(1000)
    expect(state.tokensLength).toBeGreaterThan(1000)

    now = 2000
    const releaseFinal = await governor.acquire("m", 5)
    releaseFinal()

    state = __test.debugWindowState(governor, "m")
    expect(state).toBeDefined()
    if (!state) throw new Error("missing window state after prune")

    expect(state.requestsLength).toBeLessThanOrEqual(1)
    expect(state.tokensLength).toBeLessThanOrEqual(1)
    expect(state.tokenSum).toBe(5)
  })

  test("rolling token sum stays correct across large prune boundaries", async () => {
    let now = 0

    const governor = __test.createGovernor(
      {
        quota: {
          default: { tpm: 100000 },
        },
      },
      {
        now: () => now,
        wait: async () => {},
        windowMs: 100,
      },
    )

    for (let i = 0; i < 200; i += 1) {
      now = Math.floor(i / 3)
      const tokens = (i % 3) + 1
      const release = await governor.acquire("m", tokens)
      release()
    }

    now = 260
    let release = await governor.acquire("m", 7)
    release()

    now = 270
    release = await governor.acquire("m", 11)
    release()

    const state = __test.debugWindowState(governor, "m")
    expect(state).toBeDefined()
    if (!state) throw new Error("missing window state")

    expect(state.tokensLength).toBe(2)
    expect(state.tokenSum).toBe(18)
  })
})

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
})

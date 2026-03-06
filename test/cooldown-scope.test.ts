/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { __test } from "../src/quota"

describe("phase 5 cooldown scope", () => {
  test("per-model scope applies cooldown only to targeted model", async () => {
    let now = 0
    const waits: number[] = []

    const governor = __test.createGovernor(
      {
        quota: {
          default: { rpm: 10 },
        },
        // currently ignored until phase 5 implementation
        cooldownScope: "per-model" as never,
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          waits.push(ms)
          now += ms
        },
        windowMs: 100,
      },
    )

    // expected phase-5 behavior: cooldown can target model A only.
    // pre-phase behavior: this argument is ignored and cooldown is global.
    ;(
      governor as unknown as { setCooldown: (delayMs: number, modelId?: string) => void }
    ).setCooldown(100, "A")

    const releaseB = await governor.acquire("B", 1)
    releaseB()

    // RED expectation: model B should not wait when cooldown targets model A.
    expect(waits.length).toBe(0)
  })
})

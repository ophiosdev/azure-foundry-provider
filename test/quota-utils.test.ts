/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { getTpmWaitMs, jitterDelay, readTextLength } from "../src/quota-utils"

describe("quota-utils readTextLength", () => {
  test("returns 0 for non-array non-string content", () => {
    expect(readTextLength({ text: "x" })).toBe(0)
    expect(readTextLength(123)).toBe(0)
    expect(readTextLength(null)).toBe(0)
  })

  test("sums text lengths from array object parts only", () => {
    const content = [
      { text: "abc" },
      { text: "de" },
      { text: 1 },
      null,
      "plain-string-part",
      { other: "ignored" },
    ]

    expect(readTextLength(content)).toBe(5)
  })
})

describe("quota-utils jitterDelay", () => {
  test("returns a bounded jittered delay when jitterRatio is positive", () => {
    const originalRandom = Math.random
    try {
      Math.random = () => 0
      expect(jitterDelay(100, 0.2)).toBe(80)

      Math.random = () => 1
      expect(jitterDelay(100, 0.2)).toBe(121)

      Math.random = () => 0.5
      const value = jitterDelay(100, 0.2)
      expect(value).toBeGreaterThanOrEqual(80)
      expect(value).toBeLessThanOrEqual(120)
    } finally {
      Math.random = originalRandom
    }
  })
})

describe("quota-utils getTpmWaitMs", () => {
  test("returns 0 when total would stay within TPM", () => {
    const wait = getTpmWaitMs(
      100,
      [
        { at: 0, tokens: 3 },
        { at: 10, tokens: 2 },
      ],
      20,
      10,
      4,
    )

    expect(wait).toBe(0)
  })

  test("returns wait based on the event that releases enough tokens", () => {
    const wait = getTpmWaitMs(
      100,
      [
        { at: 0, tokens: 6 },
        { at: 10, tokens: 5 },
      ],
      20,
      10,
      3,
    )

    expect(wait).toBe(80)
  })

  test("falls back to full window when tokens still would not fit", () => {
    const wait = getTpmWaitMs(100, [{ at: 0, tokens: 2 }], 20, 1, 5)

    expect(wait).toBe(100)
  })

  test("wait is clamped to at least 1 when release boundary is already current", () => {
    const wait = getTpmWaitMs(100, [{ at: 0, tokens: 6 }], 100, 5, 1)

    expect(wait).toBe(1)
  })
})

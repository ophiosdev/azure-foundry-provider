/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { estimateRequestedTokens, jitterDelay, readTextLength } from "../src/quota-utils"

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

describe("quota-utils estimateRequestedTokens", () => {
  test("preserves Chat estimate fields and output-token precedence", () => {
    expect(
      estimateRequestedTokens({
        messages: [{ role: "user", content: "abcdefgh" }],
        max_tokens: 20,
        max_completion_tokens: 40,
      }),
    ).toBe(22)
    expect(
      estimateRequestedTokens({
        messages: [{ role: "user", content: "abcdefgh" }],
        max_completion_tokens: 40,
      }),
    ).toBe(42)
  })

  test("counts Responses instructions, text parts, and textual tool content only", () => {
    expect(
      estimateRequestedTokens({
        instructions: "rules!",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "hello" },
              { type: "input_image", image_url: "x".repeat(20_000) },
              { type: "input_file", file_data: "y".repeat(20_000) },
            ],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "world" }],
          },
          { type: "function_call", arguments: '{"x":1}' },
          { type: "function_call_output", output: "done" },
          { type: "custom_tool_call", input: "q" },
          {
            type: "custom_tool_call_output",
            output: [{ type: "input_text", text: "ok" }],
          },
        ],
        max_output_tokens: 100,
      }),
    ).toBe(108)
  })

  test("uses Responses max_output_tokens and conservative empty-input minimum", () => {
    expect(estimateRequestedTokens({ input: "prompt", max_output_tokens: 300 })).toBe(302)
    expect(
      estimateRequestedTokens({
        input: [{ type: "message", content: [{ type: "input_image" }] }],
        max_output_tokens: 0,
      }),
    ).toBe(1)
  })
})

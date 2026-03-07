/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { hasAuthHeader } from "../src/provider-runtime"

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

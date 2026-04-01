/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, mock, test } from "bun:test"

describe("credential", () => {
  test("reuses a shared DefaultAzureCredential instance", async () => {
    await mock.module("@azure/identity", () => {
      class FakeCredential {
        readonly id = Symbol("credential")
      }

      return {
        DefaultAzureCredential: FakeCredential,
      }
    })

    const auth = await import("../src/auth")
    const first = auth.credential()
    const second = auth.credential()

    expect(first).toBe(second)
    expect(first.constructor.name).toBe("FakeCredential")
  })
})

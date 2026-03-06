import { describe, expect, test } from "bun:test"
import { __test } from "../src/quota"

describe("phase 4 token window accounting", () => {
  test("maintains rolling token sum after window pruning", async () => {
    let now = 0
    const governor = __test.createGovernor(
      {
        quota: {
          default: { tpm: 20 },
        },
      },
      {
        now: () => now,
        wait: async () => {},
        windowMs: 100,
      },
    )

    const r1 = await governor.acquire("m", 8)
    r1()
    now = 20
    const r2 = await governor.acquire("m", 7)
    r2()

    now = 250
    const r3 = await governor.acquire("m", 5)
    r3()

    const state = __test.debugWindowState(governor, "m")
    expect(state).toBeDefined()
    if (!state) throw new Error("missing window state")

    // RED expectation for Phase 4: tokenSum should only reflect active window tokens.
    expect(state.tokenSum).toBe(5)
  })
})

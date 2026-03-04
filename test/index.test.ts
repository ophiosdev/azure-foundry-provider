import { describe, expect, test } from "bun:test"
import { azureFoundryProvider, createAzureFoundryProvider, parseEndpoint } from "../src/index"

describe("index exports", () => {
  test("re-exports factory and parser", () => {
    expect(typeof createAzureFoundryProvider).toBe("function")
    expect(typeof parseEndpoint).toBe("function")
  })

  test("default provider export exists", () => {
    expect(typeof azureFoundryProvider).toBe("function")
  })
})

import { describe, expect, test } from "bun:test"
import { __test } from "../src/provider"

describe("provider internals", () => {
  test("getValidationMode prefers divergent model mode over global", () => {
    expect(__test.getValidationMode({ apiMode: "chat" })).toBe("chat")
    expect(
      __test.getValidationMode({
        apiMode: "chat",
        modelOptions: {
          a: { apiMode: "responses" },
        },
      }),
    ).toBe("responses")

    expect(
      __test.getValidationMode({
        apiMode: "chat",
        modelOptions: {
          a: { apiMode: "chat" },
        },
      }),
    ).toBe("chat")

    expect(
      __test.getValidationMode({
        modelOptions: {
          a: { apiMode: "responses" },
        },
      }),
    ).toBe("responses")
  })

  test("status extractor reads status from top-level and response", () => {
    const mismatch = __test.isChatOperationMismatchError({
      status: 400,
      data: {
        error: {
          code: "operation_not_supported",
          operation: "/chat/completions",
          message: "chat completions operation not supported",
        },
      },
    })
    expect(mismatch).toBe(true)
  })

  test("chat operation mismatch text detector is specific", () => {
    expect(
      __test.isChatOperationMismatchError({
        status: 400,
        message: "The chatCompletion operation does not work",
      }),
    ).toBe(true)
    expect(
      __test.isChatOperationMismatchError({
        status: 400,
        message: "content_filter",
      }),
    ).toBe(false)
  })

  test("structured signals with top-level detail are detected", () => {
    const mismatch = __test.isChatOperationMismatchError({
      status: 400,
      detail: [
        {
          code: "operation_not_supported",
          operation: "/chat/completions",
        },
      ],
    })

    expect(mismatch).toBe(true)
  })

  test("structured signals with loc chat token are detected", () => {
    const mismatch = __test.isChatOperationMismatchError({
      status: 400,
      data: {
        detail: [
          {
            code: "operation_not_supported",
            loc: ["body", "chat_completions"],
          },
        ],
      },
    })

    expect(mismatch).toBe(true)
  })

  test("operation_not_supported without chat context does not match", () => {
    const mismatch = __test.isChatOperationMismatchError({
      status: 400,
      data: {
        error: {
          code: "operation_not_supported",
          operation: "/responses",
        },
      },
    })

    expect(mismatch).toBe(false)
  })

  test("small responseBody JSON can trigger mismatch detection", () => {
    const mismatch = __test.isChatOperationMismatchError({
      status: 400,
      responseBody: JSON.stringify({
        error: {
          code: "operation_not_supported",
          message: "chat completions operation not supported",
        },
      }),
    })

    expect(mismatch).toBe(true)
  })

  test("large responseBody does not force parse-based mismatch", () => {
    const huge = `{"error":{"message":"${"x".repeat(70_000)}"}}`
    const mismatch = __test.isChatOperationMismatchError({
      status: 400,
      responseBody: huge,
    })

    expect(mismatch).toBe(false)
  })

  test("getValidationMode returns undefined without explicit modes", () => {
    expect(__test.getValidationMode({})).toBeUndefined()
    expect(__test.getValidationMode({ modelOptions: { a: {} } })).toBeUndefined()
  })

  test("structured mismatch extraction prefers explicit codes and context", () => {
    const s1 = __test.extractStructuredMismatchSignals({
      data: {
        error: {
          code: "operation_not_supported",
          operation: "/chat/completions",
        },
      },
    })
    expect(s1.operationNotSupported).toBe(true)
    expect(s1.chatContext).toBe(true)

    const s2 = __test.extractStructuredMismatchSignals({
      detail: [
        {
          code: "operation_not_supported",
          loc: ["body", "chat_completions"],
        },
      ],
    })
    expect(s2.operationNotSupported).toBe(true)
    expect(s2.chatContext).toBe(true)
  })

  test("chat operation mismatch detector handles structured and message errors", () => {
    expect(__test.isChatOperationMismatchError(null)).toBe(false)
    expect(__test.isChatOperationMismatchError({ message: 42 })).toBe(false)
    expect(
      __test.isChatOperationMismatchError({
        status: 400,
        message: "The chatCompletion operation does not work with the specified model",
      }),
    ).toBe(true)
    expect(
      __test.isChatOperationMismatchError({
        status: 400,
        data: {
          error: {
            code: "operation_not_supported",
            message: "chat completions operation not supported for this model",
          },
        },
      }),
    ).toBe(true)

    expect(
      __test.isChatOperationMismatchError({
        status: 400,
        data: {
          error: {
            code: "operation_not_supported",
            operation: "/chat/completions",
          },
        },
      }),
    ).toBe(true)

    expect(
      __test.isChatOperationMismatchError({
        status: 400,
        data: {
          error: {
            code: "operation_not_supported",
            operation: "/responses",
          },
        },
      }),
    ).toBe(false)

    expect(
      __test.isChatOperationMismatchError({
        status: 500,
        message: "The chatCompletion operation does not work with the specified model",
      }),
    ).toBe(false)
    expect(__test.isChatOperationMismatchError({ status: 400, message: "content_filter" })).toBe(
      false,
    )
  })

  test("responses fallback guard handles mode and URL cases", () => {
    expect(
      __test.shouldTryResponsesFallback("https://x/openai/v1/chat/completions", "chat", undefined),
    ).toBe(false)
    expect(
      __test.shouldTryResponsesFallback(
        "https://x/openai/v1/chat/completions",
        "responses",
        undefined,
      ),
    ).toBe(false)
    expect(
      __test.shouldTryResponsesFallback("https://x/openai/v1/chat/completions", undefined, "chat"),
    ).toBe(false)
    expect(
      __test.shouldTryResponsesFallback(
        "https://x/openai/v1/chat/completions",
        undefined,
        undefined,
      ),
    ).toBe(true)
    expect(
      __test.shouldTryResponsesFallback("https://x/openai/v1/responses", undefined, undefined),
    ).toBe(false)
    expect(__test.shouldTryResponsesFallback("not-a-url", undefined, undefined)).toBe(false)
  })
})

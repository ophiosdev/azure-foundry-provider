/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { __test } from "../src/provider"

type MismatchFixture = {
  name: string
  error: unknown
  expected: boolean
}

const mismatchPositiveFixtures: MismatchFixture[] = [
  {
    name: "top-level message with chatCompletion does not work",
    error: {
      status: 400,
      message: "The chatCompletion operation does not work with the specified model",
    },
    expected: true,
  },
  {
    name: "nested error message with chat completions not supported",
    error: {
      status: 400,
      error: {
        message: "chat completions operation not supported for this model",
      },
    },
    expected: true,
  },
  {
    name: "structured target carries chat path",
    error: {
      status: 400,
      data: {
        error: {
          code: "operation_not_supported",
          target: "/chat/completions",
        },
      },
    },
    expected: true,
  },
  {
    name: "structured param carries chat token",
    error: {
      status: 400,
      data: {
        error: {
          code: "operation_not_supported",
          param: "chat_completions",
        },
      },
    },
    expected: true,
  },
  {
    name: "structured path carries chat path",
    error: {
      status: 400,
      detail: [
        {
          code: "operation_not_supported",
          path: "/chat/completions",
        },
      ],
    },
    expected: true,
  },
  {
    name: "structured loc carries chat path token",
    error: {
      status: 400,
      detail: [
        {
          code: "operation_not_supported",
          loc: ["body", "/chat/completions"],
        },
      ],
    },
    expected: true,
  },
  {
    name: "statusCode path is accepted",
    error: {
      statusCode: 400,
      data: {
        error: {
          code: "operation_not_supported",
          operation: "/chat/completions",
        },
      },
    },
    expected: true,
  },
  {
    name: "response.status path is accepted",
    error: {
      response: { status: 400 },
      data: {
        error: {
          code: "operation_not_supported",
          operation: "/chat/completions",
        },
      },
    },
    expected: true,
  },
  {
    name: "small responseBody json object positive",
    error: {
      status: 400,
      responseBody: JSON.stringify({
        error: {
          code: "operation_not_supported",
          message: "chat completions operation not supported",
        },
      }),
    },
    expected: true,
  },
  {
    name: "invalid json responseBody still matches plain-text heuristic",
    error: {
      status: 400,
      responseBody:
        '{"error":{"message":"The chatCompletion operation does not work with the specified model"}',
    },
    expected: true,
  },
]

const mismatchNegativeFixtures: MismatchFixture[] = [
  {
    name: "operation_not_supported for responses only",
    error: {
      status: 400,
      data: {
        error: {
          code: "operation_not_supported",
          operation: "/responses",
        },
      },
    },
    expected: false,
  },
  {
    name: "unsupported wording without chat context",
    error: {
      status: 400,
      message: "This operation is not supported for the selected deployment",
    },
    expected: false,
  },
  {
    name: "chat context without unsupported wording",
    error: {
      status: 400,
      message: "chat completions request received",
    },
    expected: false,
  },
  {
    name: "content filter is always excluded",
    error: {
      status: 400,
      message: "content_filter and chatCompletion operation does not work",
    },
    expected: false,
  },
  {
    name: "non-400 status blocks mismatch detection",
    error: {
      status: 500,
      message: "The chatCompletion operation does not work with the specified model",
    },
    expected: false,
  },
  {
    name: "structured unsupported code without chat context",
    error: {
      status: 400,
      detail: [
        {
          code: "operation_not_supported",
          loc: ["body", "messages", 0],
        },
      ],
    },
    expected: false,
  },
  {
    name: "valid json array responseBody still matches plain-text heuristic",
    error: {
      status: 400,
      responseBody: JSON.stringify([
        {
          message: "chat completions operation not supported",
        },
      ]),
    },
    expected: true,
  },
  {
    name: "docs-like advisory text currently matches broad text heuristic",
    error: {
      status: 400,
      message: "See docs: chat completions is not supported in this example configuration",
    },
    expected: true,
  },
]

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

  test("chat operation mismatch corpus positives", () => {
    for (const fixture of mismatchPositiveFixtures) {
      expect(__test.isChatOperationMismatchError(fixture.error), fixture.name).toBe(
        fixture.expected,
      )
    }
  })

  test("chat operation mismatch corpus negatives", () => {
    for (const fixture of mismatchNegativeFixtures) {
      expect(__test.isChatOperationMismatchError(fixture.error), fixture.name).toBe(
        fixture.expected,
      )
    }
  })

  test("mismatch detector reads message text from data.detail entries", () => {
    const mismatch = __test.isChatOperationMismatchError({
      status: 400,
      data: {
        detail: [
          {
            message: "The chatCompletion operation does not work with the specified model",
          },
        ],
      },
    })

    expect(mismatch).toBe(true)
  })

  test("mismatch detector reads msg and type text from data.detail entries", () => {
    const mismatch = __test.isChatOperationMismatchError({
      status: 400,
      data: {
        detail: [
          {
            msg: "chat completions operation not supported for this deployment",
            type: "operation_not_supported",
          },
        ],
      },
    })

    expect(mismatch).toBe(true)
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

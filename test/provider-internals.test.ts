/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { __test } from "../src/provider"

type MismatchFixture = {
  name: string
  error: unknown
  expected: "chat" | "responses" | undefined
}

const mismatchPositiveFixtures: MismatchFixture[] = [
  {
    name: "top-level message with chatCompletion does not work",
    error: {
      status: 400,
      message: "The chatCompletion operation does not work with the specified model",
    },
    expected: "chat",
  },
  {
    name: "nested error message with chat completions not supported",
    error: {
      status: 400,
      error: {
        message: "chat completions operation not supported for this model",
      },
    },
    expected: "chat",
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
    expected: "chat",
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
    expected: "chat",
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
    expected: "chat",
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
    expected: "chat",
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
    expected: "chat",
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
    expected: "chat",
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
    expected: "chat",
  },
  {
    name: "invalid json responseBody still matches plain-text heuristic",
    error: {
      status: 400,
      responseBody:
        '{"error":{"message":"The chatCompletion operation does not work with the specified model"}',
    },
    expected: "chat",
  },
  {
    name: "top-level message with responses not supported",
    error: {
      status: 400,
      message: "The responses operation is not supported for the specified model",
    },
    expected: "responses",
  },
  {
    name: "nested error message with responses not available",
    error: {
      status: 400,
      error: {
        message: "responses operation not available for this model",
      },
    },
    expected: "responses",
  },
  {
    name: "structured target carries responses path",
    error: {
      status: 400,
      data: {
        error: {
          code: "operation_not_supported",
          target: "/responses",
        },
      },
    },
    expected: "responses",
  },
  {
    name: "structured param carries responses token",
    error: {
      status: 400,
      data: {
        error: {
          code: "operation_not_supported",
          param: "responses",
        },
      },
    },
    expected: "responses",
  },
  {
    name: "structured path carries responses path",
    error: {
      status: 400,
      detail: [
        {
          code: "operation_not_supported",
          path: "/responses",
        },
      ],
    },
    expected: "responses",
  },
  {
    name: "structured loc carries responses token",
    error: {
      status: 400,
      detail: [
        {
          code: "operation_not_supported",
          loc: ["body", "responses"],
        },
      ],
    },
    expected: "responses",
  },
  {
    name: "small responseBody json object detects responses mismatch",
    error: {
      status: 400,
      responseBody: JSON.stringify({
        error: {
          code: "operation_not_supported",
          message: "responses operation not supported",
        },
      }),
    },
    expected: "responses",
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
    expected: "responses",
  },
  {
    name: "unsupported wording without chat context",
    error: {
      status: 400,
      message: "This operation is not supported for the selected deployment",
    },
    expected: undefined,
  },
  {
    name: "chat context without unsupported wording",
    error: {
      status: 400,
      message: "chat completions request received",
    },
    expected: undefined,
  },
  {
    name: "content filter is always excluded",
    error: {
      status: 400,
      message: "content_filter and chatCompletion operation does not work",
    },
    expected: undefined,
  },
  {
    name: "non-400 status blocks mismatch detection",
    error: {
      status: 500,
      message: "The chatCompletion operation does not work with the specified model",
    },
    expected: undefined,
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
    expected: undefined,
  },
  {
    name: "valid json array responseBody without structured object is ignored",
    error: {
      status: 400,
      responseBody: JSON.stringify([
        {
          message: "chat completions operation not supported",
        },
      ]),
    },
    expected: undefined,
  },
  {
    name: "docs-like advisory text is ignored",
    error: {
      status: 400,
      message: "See docs: chat completions is not supported in this example configuration",
    },
    expected: undefined,
  },
  {
    name: "generic validation error mentioning responses is ignored",
    error: {
      status: 400,
      message: "Validation failed for responses payload: missing field messages",
    },
    expected: undefined,
  },
  {
    name: "assistant reasoning validation is ignored",
    error: {
      status: 400,
      message: "reasoning_content is not supported for chat completions requests",
    },
    expected: undefined,
  },
  {
    name: "oversized responseBody without structured top-level signals is ignored",
    error: {
      status: 400,
      responseBody: `prefix ${"responses operation not supported ".repeat(4000)}`,
    },
    expected: undefined,
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
    const mismatch = __test.detectOperationMismatch({
      status: 400,
      data: {
        error: {
          code: "operation_not_supported",
          operation: "/chat/completions",
          message: "chat completions operation not supported",
        },
      },
    })
    expect(mismatch).toBe("chat")
  })

  test("directional mismatch detector identifies rejected chat operation", () => {
    expect(
      __test.detectOperationMismatch({
        status: 400,
        message: "The chatCompletion operation does not work",
      }),
    ).toBe("chat")
    expect(
      __test.detectOperationMismatch({
        status: 400,
        message: "content_filter",
      }),
    ).toBeUndefined()
  })

  test("directional mismatch detector identifies rejected responses operation", () => {
    const mismatch = __test.detectOperationMismatch({
      status: 400,
      data: {
        error: {
          code: "operation_not_supported",
          operation: "/responses",
          message: "responses operation not supported",
        },
      },
    })

    expect(mismatch).toBe("responses")
  })

  test("structured signals with top-level detail are detected", () => {
    const mismatch = __test.detectOperationMismatch({
      status: 400,
      detail: [
        {
          code: "operation_not_supported",
          operation: "/chat/completions",
        },
      ],
    })

    expect(mismatch).toBe("chat")
  })

  test("structured signals with loc chat token are detected", () => {
    const mismatch = __test.detectOperationMismatch({
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

    expect(mismatch).toBe("chat")
  })

  test("operation_not_supported without chat context does not match", () => {
    const mismatch = __test.detectOperationMismatch({
      status: 400,
      data: {
        error: {
          code: "operation_not_supported",
          operation: "/responses",
        },
      },
    })

    expect(mismatch).toBe("responses")
  })

  test("small responseBody JSON can trigger mismatch detection", () => {
    const mismatch = __test.detectOperationMismatch({
      status: 400,
      responseBody: JSON.stringify({
        error: {
          code: "operation_not_supported",
          message: "chat completions operation not supported",
        },
      }),
    })

    expect(mismatch).toBe("chat")
  })

  test("large responseBody does not force parse-based mismatch", () => {
    const huge = `{"error":{"message":"${"x".repeat(70_000)}"}}`
    const mismatch = __test.detectOperationMismatch({
      status: 400,
      responseBody: huge,
    })

    expect(mismatch).toBeUndefined()
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
    expect(s1.rejectedMode).toBe("chat")

    const s2 = __test.extractStructuredMismatchSignals({
      detail: [
        {
          code: "operation_not_supported",
          loc: ["body", "responses"],
        },
      ],
    })
    expect(s2.operationNotSupported).toBe(true)
    expect(s2.rejectedMode).toBe("responses")
  })

  test("directional mismatch detector ignores generic 400 validation errors", () => {
    expect(__test.detectOperationMismatch(null)).toBeUndefined()
    expect(__test.detectOperationMismatch({ message: 42 })).toBeUndefined()
    expect(
      __test.detectOperationMismatch({
        status: 400,
        message: "The chatCompletion operation does not work with the specified model",
      }),
    ).toBe("chat")
    expect(
      __test.detectOperationMismatch({
        status: 400,
        data: {
          error: {
            code: "operation_not_supported",
            message: "chat completions operation not supported for this model",
          },
        },
      }),
    ).toBe("chat")

    expect(
      __test.detectOperationMismatch({
        status: 400,
        data: {
          error: {
            code: "operation_not_supported",
            operation: "/chat/completions",
          },
        },
      }),
    ).toBe("chat")

    expect(
      __test.detectOperationMismatch({
        status: 400,
        message: "Validation error for chat payload",
      }),
    ).toBeUndefined()

    expect(
      __test.detectOperationMismatch({
        status: 500,
        message: "The chatCompletion operation does not work with the specified model",
      }),
    ).toBeUndefined()
    expect(__test.detectOperationMismatch({ status: 400, message: "content_filter" })).toBe(
      undefined,
    )
  })

  test("directional mismatch corpus positives", () => {
    for (const fixture of mismatchPositiveFixtures) {
      expect(__test.detectOperationMismatch(fixture.error), fixture.name).toBe(fixture.expected)
    }
  })

  test("directional mismatch corpus negatives", () => {
    for (const fixture of mismatchNegativeFixtures) {
      expect(__test.detectOperationMismatch(fixture.error), fixture.name).toBe(fixture.expected)
    }
  })

  test("mismatch detector reads message text from data.detail entries", () => {
    const mismatch = __test.detectOperationMismatch({
      status: 400,
      data: {
        detail: [
          {
            message: "The chatCompletion operation does not work with the specified model",
          },
        ],
      },
    })

    expect(mismatch).toBe("chat")
  })

  test("mismatch detector reads msg and type text from data.detail entries", () => {
    const mismatch = __test.detectOperationMismatch({
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

    expect(mismatch).toBe("chat")
  })
})

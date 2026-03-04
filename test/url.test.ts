import { describe, expect, test } from "bun:test"
import { parseEndpoint } from "../src/url"

describe("parseEndpoint", () => {
  test("parses services.ai chat endpoint", () => {
    const parsed = parseEndpoint(
      "https://foo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview&x=1",
    )

    expect(parsed.hostType).toBe("foundry-services")
    expect(parsed.pathType).toBe("models-chat-completions")
    expect(parsed.mode).toBe("chat")
    expect(parsed.inferredMode).toBe("chat")
    expect(parsed.apiVersion).toBe("2024-05-01-preview")
    expect(parsed.requestURL).toBe(
      "https://foo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview&x=1",
    )
  })

  test("parses cognitive responses endpoint", () => {
    const parsed = parseEndpoint(
      "https://res.cognitiveservices.azure.com/openai/responses?api-version=preview",
    )

    expect(parsed.hostType).toBe("cognitive-services")
    expect(parsed.pathType).toBe("responses")
    expect(parsed.mode).toBe("responses")
    expect(parsed.operationPath).toBe("/openai/responses")
    expect(parsed.requestURL).toBe(
      "https://res.cognitiveservices.azure.com/openai/responses?api-version=preview",
    )
  })

  test("apiMode override rewrites operation path", () => {
    const parsed = parseEndpoint(
      "https://res.cognitiveservices.azure.com/openai/chat/completions?api-version=preview",
      "responses",
    )

    expect(parsed.inferredMode).toBe("chat")
    expect(parsed.mode).toBe("responses")
    expect(parsed.operationPath).toBe("/openai/responses")
    expect(parsed.requestURL).toBe(
      "https://res.cognitiveservices.azure.com/openai/responses?api-version=preview",
    )
  })

  test("parses openai.azure v1 chat endpoint without api-version", () => {
    const parsed = parseEndpoint("https://foo.openai.azure.com/openai/v1/chat/completions")

    expect(parsed.hostType).toBe("openai-azure")
    expect(parsed.pathType).toBe("v1-chat-completions")
    expect(parsed.mode).toBe("chat")
    expect(parsed.inferredMode).toBe("chat")
    expect(parsed.apiVersion).toBeUndefined()
    expect(parsed.requestURL).toBe("https://foo.openai.azure.com/openai/v1/chat/completions")
  })

  test("parses services.ai v1 responses endpoint without api-version", () => {
    const parsed = parseEndpoint("https://foo.services.ai.azure.com/openai/v1/responses")

    expect(parsed.hostType).toBe("foundry-services")
    expect(parsed.pathType).toBe("v1-responses")
    expect(parsed.mode).toBe("responses")
    expect(parsed.inferredMode).toBe("responses")
    expect(parsed.requestURL).toBe("https://foo.services.ai.azure.com/openai/v1/responses")
  })

  test("parses v1 base endpoint when apiMode is chat", () => {
    const parsed = parseEndpoint("https://foo.openai.azure.com/openai/v1", "chat")

    expect(parsed.hostType).toBe("openai-azure")
    expect(parsed.pathType).toBe("v1-base")
    expect(parsed.mode).toBe("chat")
    expect(parsed.operationPath).toBe("/openai/v1/chat/completions")
    expect(parsed.requestURL).toBe("https://foo.openai.azure.com/openai/v1/chat/completions")
  })

  test("parses v1 base endpoint when apiMode is responses", () => {
    const parsed = parseEndpoint("https://foo.openai.azure.com/openai/v1", "responses")

    expect(parsed.hostType).toBe("openai-azure")
    expect(parsed.pathType).toBe("v1-base")
    expect(parsed.mode).toBe("responses")
    expect(parsed.operationPath).toBe("/openai/v1/responses")
    expect(parsed.requestURL).toBe("https://foo.openai.azure.com/openai/v1/responses")
  })

  test("v1 base endpoint requires apiMode", () => {
    expect(() => parseEndpoint("https://foo.openai.azure.com/openai/v1")).toThrow(
      "Endpoint path /openai/v1 requires apiMode",
    )
  })

  test("apiMode override rewrites v1 chat to v1 responses", () => {
    const parsed = parseEndpoint(
      "https://foo.openai.azure.com/openai/v1/chat/completions",
      "responses",
    )

    expect(parsed.inferredMode).toBe("chat")
    expect(parsed.mode).toBe("responses")
    expect(parsed.operationPath).toBe("/openai/v1/responses")
    expect(parsed.requestURL).toBe("https://foo.openai.azure.com/openai/v1/responses")
  })

  test("apiMode override rewrites v1 responses to v1 chat", () => {
    const parsed = parseEndpoint("https://foo.openai.azure.com/openai/v1/responses", "chat")

    expect(parsed.inferredMode).toBe("responses")
    expect(parsed.mode).toBe("chat")
    expect(parsed.operationPath).toBe("/openai/v1/chat/completions")
    expect(parsed.requestURL).toBe("https://foo.openai.azure.com/openai/v1/chat/completions")
  })

  test("rejects non-https endpoint", () => {
    expect(() =>
      parseEndpoint("http://foo.services.ai.azure.com/models/chat/completions?api-version=1"),
    ).toThrow("Endpoint must use https://")
  })

  test("rejects unsupported path", () => {
    expect(() => parseEndpoint("https://foo.openai.azure.com/openai?api-version=preview")).toThrow(
      "Unsupported endpoint path",
    )
    expect(() => parseEndpoint("https://foo.openai.azure.com/openai?api-version=preview")).toThrow(
      "/openai/v1",
    )
  })

  test("requires api-version for models chat completions", () => {
    expect(() =>
      parseEndpoint("https://foo.services.ai.azure.com/models/chat/completions"),
    ).toThrow("Missing required api-version")
  })
})

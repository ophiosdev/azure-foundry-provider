/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3DataContent,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3Source,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4File,
  LanguageModelV4FinishReason,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4Source,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
  SharedV4FileData,
  SharedV4ProviderMetadata,
  SharedV4ProviderReference,
} from "@ai-sdk/provider"

type V3Metadata = NonNullable<Extract<LanguageModelV3Content, { type: "text" }>["providerMetadata"]>
type V4ToolResultContentPart = Extract<
  LanguageModelV4ToolResultOutput,
  { type: "content" }
>["value"][number]

/** Adapts SDK 7's V4 transports to OpenCode V2's V3 model boundary. */
export function adaptLanguageModelV4ToV3(model: LanguageModelV4): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      const result = await model.doGenerate(toV4CallOptions(options, model.provider))
      return {
        // V3 has no separate structured-output field; its host consumes generated content directly.
        content: result.content.flatMap(toV3Content),
        finishReason: toV3FinishReason(result.finishReason),
        usage: result.usage,
        warnings: result.warnings as LanguageModelV3GenerateResult["warnings"],
        ...(result.providerMetadata === undefined
          ? {}
          : { providerMetadata: toV3Metadata(result.providerMetadata) }),
        ...(result.request === undefined ? {} : { request: result.request }),
        ...(result.response === undefined ? {} : { response: result.response }),
      }
    },
    async doStream(options) {
      const result = await model.doStream(toV4CallOptions(options, model.provider))
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV3StreamPart>({
            transform(part, controller) {
              for (const converted of toV3StreamParts(part)) {
                controller.enqueue(converted)
              }
            },
          }),
        ),
      }
    },
  }
}

function toV4CallOptions(
  options: LanguageModelV3CallOptions,
  provider: string,
): LanguageModelV4CallOptions {
  const { prompt, providerOptions, tools, ...rest } = options
  return {
    ...rest,
    prompt: toV4Prompt(prompt, provider),
    ...(providerOptions === undefined
      ? {}
      : {
          providerOptions,
        }),
    ...(tools === undefined ? {} : { tools }),
  }
}

function toV4Prompt(prompt: LanguageModelV3Prompt, provider: string): LanguageModelV4Prompt {
  return prompt.map((message) => {
    if (message.role === "system") {
      return message
    }

    const content = message.content.map((part) => {
      if (part.type === "file") return { ...part, data: toV4FileData(part.data) }
      if (part.type === "tool-result") {
        return { ...part, output: toV4ToolResultOutput(part.output, provider) }
      }
      return part
    })

    // V4 changes file data to a tagged union and provider option aliases by SDK version.
    return { ...message, content } as unknown as LanguageModelV4Message
  })
}

function toV4FileData(data: LanguageModelV3DataContent): SharedV4FileData {
  return data instanceof URL ? { type: "url", url: data } : { type: "data", data }
}

function toV4ToolResultOutput(
  output: LanguageModelV3ToolResultOutput,
  provider: string,
): LanguageModelV4ToolResultOutput {
  if (output.type !== "content") {
    return output
  }

  return {
    ...output,
    value: output.value.map((part): V4ToolResultContentPart => {
      switch (part.type) {
        case "text":
          return part
        case "file-data":
          return {
            type: "file",
            data: { type: "data", data: part.data },
            mediaType: part.mediaType,
            ...(part.filename === undefined ? {} : { filename: part.filename }),
          }
        case "file-url":
          return {
            type: "file",
            data: { type: "url", url: new URL(part.url) },
            mediaType: "application/octet-stream",
          }
        case "file-id":
          return {
            type: "file",
            data: { type: "reference", reference: openAIReference(part.fileId, provider) },
            mediaType: "application/octet-stream",
          }
        case "image-data":
          return {
            type: "file",
            data: { type: "data", data: part.data },
            mediaType: part.mediaType,
          }
        case "image-url":
          return {
            type: "file",
            data: { type: "url", url: new URL(part.url) },
            mediaType: "image",
          }
        case "image-file-id":
          return {
            type: "file",
            data: { type: "reference", reference: openAIReference(part.fileId, provider) },
            mediaType: "image",
          }
        case "custom":
          return part
      }
    }),
  }
}

function openAIReference(
  fileId: string | Record<string, string>,
  provider: string,
): SharedV4ProviderReference {
  if (typeof fileId !== "string") return fileId
  const referenceProvider = provider.endsWith(".responses")
    ? provider.includes("azure")
      ? "azure"
      : "openai"
    : provider
  return { [referenceProvider]: fileId }
}

function toV3Content(content: LanguageModelV4Content): LanguageModelV3Content[] {
  switch (content.type) {
    case "text":
      return [
        {
          type: "text",
          text: content.text,
          ...(content.providerMetadata === undefined
            ? {}
            : { providerMetadata: toV3Metadata(content.providerMetadata) }),
        },
        // V3 retains cited sources but has no citation ranges or cited-text fields.
        ...(content.citations ?? []).map((citation) => toV3Source(citation.source)),
      ]
    case "reasoning":
      return [
        {
          type: "reasoning",
          text: content.text,
          ...(content.providerMetadata === undefined
            ? {}
            : { providerMetadata: toV3Metadata(content.providerMetadata) }),
        },
      ]
    case "file":
      return [
        {
          type: "file",
          mediaType: content.mediaType,
          data: toV3FileData(content.data),
          ...(content.providerMetadata === undefined
            ? {}
            : { providerMetadata: toV3Metadata(content.providerMetadata) }),
        },
      ]
    case "source":
      return [toV3Source(content)]
    case "tool-call":
      return [
        {
          ...content,
          ...(content.providerMetadata === undefined
            ? {}
            : { providerMetadata: toV3Metadata(content.providerMetadata) }),
        },
      ]
    case "tool-result":
    case "tool-approval-request":
      return [
        {
          ...content,
          ...(content.providerMetadata === undefined
            ? {}
            : { providerMetadata: toV3Metadata(content.providerMetadata) }),
        },
      ]
    case "custom":
    case "reasoning-file":
      throw new Error(`AI SDK V4 ${content.type} output cannot be represented by the V3 host`)
  }
}

function toV3FileData(data: LanguageModelV4File["data"]): string | Uint8Array {
  if (data.type === "data") return data.data
  throw new Error("AI SDK V4 URL file output cannot be represented by the V3 host")
}

function toV3Source(source: LanguageModelV4Source): LanguageModelV3Source {
  return {
    ...source,
    ...(source.providerMetadata === undefined
      ? {}
      : { providerMetadata: toV3Metadata(source.providerMetadata) }),
  }
}

function toV3FinishReason(reason: LanguageModelV4FinishReason): LanguageModelV3FinishReason {
  return {
    ...reason,
    unified: reason.unified === "interrupted" ? "other" : reason.unified,
  }
}

function toV3StreamParts(part: LanguageModelV4StreamPart): LanguageModelV3StreamPart[] {
  switch (part.type) {
    case "text-end":
      return [
        { type: "text-end", id: part.id, ...metadata(part.providerMetadata) },
        ...(part.citations ?? []).map((citation) => toV3Source(citation.source)),
      ]
    case "finish":
      return [
        {
          ...part,
          finishReason: toV3FinishReason(part.finishReason),
          usage: part.usage,
          ...metadata(part.providerMetadata),
        },
      ]
    case "file":
    case "source":
    case "tool-call":
    case "tool-result":
    case "tool-approval-request":
      return toV3Content(part) as LanguageModelV3StreamPart[]
    case "tool-input-start":
      if (part.inputEncoding === "text") {
        return [
          {
            type: "error",
            error: new Error(
              "AI SDK V4 text-encoded tool input cannot be represented by the V3 host",
            ),
          },
        ]
      }
      return [
        {
          type: "tool-input-start",
          id: part.id,
          toolName: part.toolName,
          ...(part.providerExecuted === undefined
            ? {}
            : { providerExecuted: part.providerExecuted }),
          ...(part.dynamic === undefined ? {} : { dynamic: part.dynamic }),
          ...(part.title === undefined ? {} : { title: part.title }),
          ...metadata(part.providerMetadata),
        },
      ]
    case "custom":
    case "reasoning-file":
      return [
        {
          type: "error",
          error: new Error(
            `AI SDK V4 ${part.type} stream output cannot be represented by the V3 host`,
          ),
        },
      ]
    case "text-start":
    case "text-delta":
    case "reasoning-start":
    case "reasoning-delta":
    case "reasoning-end":
    case "tool-input-delta":
    case "tool-input-end":
    case "stream-start":
    case "response-metadata":
    case "raw":
    case "error":
      return [part as LanguageModelV3StreamPart]
  }
}

function metadata(providerMetadata: SharedV4ProviderMetadata | undefined): {
  providerMetadata?: V3Metadata
} {
  return providerMetadata === undefined ? {} : { providerMetadata: toV3Metadata(providerMetadata) }
}

function toV3Metadata(providerMetadata: SharedV4ProviderMetadata): V3Metadata {
  return providerMetadata
}

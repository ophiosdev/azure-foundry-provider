/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { renderHtmlReport } from "../src/render-html"
import type { Output, RateLimitsOutput } from "../src/types"

describe("renderHtmlReport", () => {
  test("renders a full HTML document", async () => {
    const html = await renderHtmlReport({
      resource: {
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        accountName: "acct-1",
        location: "eastus2",
      },
      deployments: [],
    } satisfies Output)

    expect(html).toContain("<!doctype html>")
    expect(html).toContain("<title>Azure Foundry Inspect - acct-1</title>")
    expect(html).toContain("acct-1")
  })

  test("renders deployment details in normal mode", async () => {
    const html = await renderHtmlReport({
      resource: {
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        accountName: "acct-1",
        accountId:
          "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/acct-1",
      },
      deployments: [
        {
          name: "FW-GLM-5",
          model: { format: "Fireworks", name: "FW-GLM-5", version: "1" },
          capabilities: { chatCompletion: "true", responses: "true" },
          limits: { maxContextTokens: 128000, maxOutputTokens: 16384 },
          deployment: {
            sku: { name: "DataZoneStandard", capacity: 25 },
            currentCapacity: 25,
            rateLimits: [{ key: "token", count: 25000, renewalPeriod: 60 }],
            provisioningState: "Succeeded",
            deploymentState: "Running",
          },
        },
      ],
    } satisfies Output)

    expect(html).toContain("FW-GLM-5")
    expect(html).toContain("DataZoneStandard")
    expect(html).toContain("128000")
    expect(html).toContain("25k")
    expect(html).toContain("Running")
    expect(html).toContain("https://acct-1.cognitiveservices.azure.com/openai/v1/chat/completions")
    expect(html).toContain("https://acct-1.cognitiveservices.azure.com/openai/v1/responses")
    expect(html).toContain('class="kv kv-wide"')
  })

  test("renders simplified cards in only-ratelimits mode", async () => {
    const html = await renderHtmlReport({
      resource: {
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        accountName: "acct-1",
      },
      deployments: [
        {
          name: "FW-GLM-5",
          model: { format: "Fireworks", name: "FW-GLM-5", version: "1" },
          limits: { maxContextTokens: 128000 },
          rateLimits: [{ key: "request", count: 25, renewalPeriod: 60 }],
        },
      ],
    } satisfies RateLimitsOutput)

    expect(html).toContain("FW-GLM-5")
    expect(html).toContain("128000")
    expect(html).toContain("25")
    expect(html).not.toContain("RAI policy")
    expect(html).not.toContain("Current capacity")
  })

  test("renders RPM/TPM labels, abbreviates counts, and includes hover text", async () => {
    const html = await renderHtmlReport({
      resource: {
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        accountName: "acct-1",
      },
      deployments: [
        {
          name: "FW-GLM-5",
          model: { format: "Fireworks", name: "FW-GLM-5", version: "1" },
          rateLimits: [
            { key: "request", count: 25, renewalPeriod: 60 },
            { key: "token", count: 10000, renewalPeriod: 60 },
          ],
        },
      ],
    } satisfies RateLimitsOutput)

    expect(html).toContain('title="RPM: about 25 requests per 60 seconds."')
    expect(html).toContain('title="TPM: about 10k tokens per 60 seconds."')
    expect(html).toContain(">RPM<")
    expect(html).toContain(">TPM<")
    expect(html).toContain(">10k<")
    expect(html).toContain('title="Window resets every 60 seconds."')
    expect(html).toContain(">60s<")
  })

  test("renders hover help for reported limits", async () => {
    const html = await renderHtmlReport({
      resource: {
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        accountName: "acct-1",
      },
      deployments: [
        {
          name: "FW-GLM-5",
          model: { format: "Fireworks", name: "FW-GLM-5", version: "1" },
          limits: { maxContextTokens: 128000, maxOutputTokens: 16384 },
          deployment: {
            rateLimits: [],
          },
        },
      ],
    } satisfies Output)

    expect(html).toContain('title="Maximum context/input token window reported by Azure."')
    expect(html).toContain('title="Maximum output/completion token window reported by Azure."')
  })

  test("renders capability-derived endpoint URLs in deployment details", async () => {
    const html = await renderHtmlReport({
      resource: {
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        accountName: "acct-1",
      },
      deployments: [
        {
          name: "chat-only",
          model: { format: "OpenAI", name: "chat-only", version: "1" },
          capabilities: { chatCompletion: "true" },
          deployment: { rateLimits: [] },
        },
        {
          name: "responses-only",
          model: { format: "OpenAI", name: "responses-only", version: "1" },
          capabilities: { responses: "true" },
          deployment: { rateLimits: [] },
        },
      ],
    } satisfies Output)

    expect(html).toContain("https://acct-1.cognitiveservices.azure.com/openai/v1/chat/completions")
    expect(html).toContain("https://acct-1.cognitiveservices.azure.com/openai/v1/responses")
  })

  test("renders provider config button and dialog with preferred responses snippet", async () => {
    const html = await renderHtmlReport({
      resource: {
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        accountName: "acct-1",
      },
      deployments: [
        {
          name: "FW-GLM-5",
          model: { format: "Fireworks", name: "FW-GLM-5", version: "1" },
          capabilities: { chatCompletion: "true", responses: "true" },
          deployment: { rateLimits: [] },
        },
      ],
    } satisfies Output)

    expect(html).toContain("View provider config")
    expect(html).toContain("<dialog")
    expect(html).toContain('data-config-copy="provider-config-0"')
    expect(html).toContain('class="json-container"')
    expect(html).toContain('class="config-raw-copy"')
    expect(html).not.toContain('data-config-tab="pretty"')
    expect(html).not.toContain('data-config-tab="raw"')
    expect(html).not.toContain('data-config-panel="pretty"')
    expect(html).not.toContain('data-config-panel="raw"')
    expect(html).toContain("&#34;provider&#34;: {")
    expect(html).toContain(
      "&#34;endpoint&#34;: &#34;https://acct-1.cognitiveservices.azure.com/openai/v1&#34;",
    )
    expect(html).toContain("&#34;modelOptions&#34;: {")
    expect(html).toContain("&#34;FW-GLM-5&#34;: {")
    expect(html).toContain("&#34;apiMode&#34;: &#34;responses&#34;")
    expect(html).not.toContain("&#34;apiMode&#34;: &#34;chat&#34;")
    expect(html).toContain('<span class=json-key>"provider"</span>')
    expect(html).toContain('<span class=json-key>"azure-foundry"</span>')
  })

  test("does not render provider config button when no supported mode is inferable", async () => {
    const html = await renderHtmlReport({
      resource: {
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        accountName: "acct-1",
      },
      deployments: [
        {
          name: "opaque-model",
          model: { format: "Other", name: "opaque-model", version: "1" },
          capabilities: { embeddings: "true" },
          deployment: { rateLimits: [] },
        },
      ],
    } satisfies Output)

    expect(html).not.toContain("View provider config")
    expect(html).not.toContain("<dialog")
  })

  test("keeps unknown rate-limit keys raw and escaped", async () => {
    const html = await renderHtmlReport({
      resource: {
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        accountName: "acct-1",
      },
      deployments: [
        {
          name: "FW-GLM-5",
          model: { format: "Fireworks", name: "FW-GLM-5", version: "1" },
          rateLimits: [{ key: "<opaque&key>", count: "10000", renewalPeriod: 30 }],
        },
      ],
    } satisfies RateLimitsOutput)

    expect(html).toContain("&lt;opaque&amp;key&gt;")
    expect(html).not.toContain(">RPM<")
  })

  test("escapes HTML-sensitive values", async () => {
    const html = await renderHtmlReport({
      resource: {
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        accountName: '<script>alert("x")</script>',
      },
      deployments: [],
    } satisfies Output)

    expect(html).toContain("&lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt;")
    expect(html).not.toContain('<script>alert("x")</script>')
  })
})

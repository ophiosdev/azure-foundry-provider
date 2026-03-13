/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import type { Output, RateLimitsOutput } from "../src/types"
import { inspectResource } from "../src/index"

describe("inspectResource", () => {
  test("returns normalized account and deployment-centric details", async () => {
    const out = (await inspectResource({
      subscriptionId: "sub-1",
      resourceGroup: "rg-1",
      accountName: "acct-1",
      client: {
        account: () =>
          Promise.resolve({
            id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/acct-1",
            name: "acct-1",
            kind: "OpenAI",
            location: "eastus2",
            sku: { name: "S0", tier: "Standard" },
          }),
        deployments: () =>
          Promise.resolve([
            {
              id: "dep-1-id",
              name: "dep-1",
              sku: { name: "Standard", tier: "Standard", capacity: 25 },
              properties: {
                provisioningState: "Succeeded",
                deploymentState: "Running",
                currentCapacity: 25,
                raiPolicyName: "Microsoft.Default",
                capabilities: {
                  chatCompletion: "true",
                  maxContextToken: "128000",
                  maxOutputToken: "16384",
                },
                model: { format: "OpenAI", name: "glm-5", version: "2026-02-11" },
                rateLimits: [
                  { key: "request", count: 25, renewalPeriod: 60 },
                  { key: "token", count: 25000, renewalPeriod: 60 },
                ],
              },
            },
          ]),
      },
    })) as Output

    expect(out.resource.accountName).toBe("acct-1")
    expect(out.deployments).toHaveLength(1)
    expect(out.deployments[0]?.model.name).toBe("glm-5")
    expect(out.deployments[0]?.deployment?.currentCapacity).toBe(25)
    expect(out.deployments[0]?.deployment?.deploymentState).toBe("Running")
    expect(out.deployments[0]?.deployment?.sku?.capacity).toBe(25)
    expect(out.deployments[0]?.deployment?.rateLimits).toHaveLength(2)
    expect(out.deployments[0]?.limits).toEqual({ maxContextTokens: 128000, maxOutputTokens: 16384 })
  })

  test("accepts resource id", async () => {
    const out = (await inspectResource({
      resourceId:
        "/subscriptions/a27f8c37-847b-4c1d-8152-630455cfaae1/resourceGroups/rg-aifoundry/providers/Microsoft.CognitiveServices/accounts/ais5434653589451882810",
      client: {
        account: () =>
          Promise.resolve({
            id: "/subscriptions/a27f8c37-847b-4c1d-8152-630455cfaae1/resourceGroups/rg-aifoundry/providers/Microsoft.CognitiveServices/accounts/ais5434653589451882810",
            name: "ais5434653589451882810",
            location: "eastus2",
          }),
        deployments: () => Promise.resolve([{ id: "dep-2-id", name: "dep-2", properties: {} }]),
      },
    })) as Output

    expect(out.resource.subscriptionId).toBe("a27f8c37-847b-4c1d-8152-630455cfaae1")
    expect(out.deployments).toHaveLength(1)
  })

  test("returns only deployment rate limits when requested", async () => {
    const out = (await inspectResource({
      subscriptionId: "sub-1",
      resourceGroup: "rg-1",
      accountName: "acct-1",
      onlyRatelimits: true,
      client: {
        account: () =>
          Promise.resolve({
            id: "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/acct-1",
            name: "acct-1",
          }),
        deployments: () =>
          Promise.resolve([
            {
              id: "dep-1-id",
              name: "dep-1",
              properties: {
                model: { format: "OpenAI", name: "glm-5", version: "2026-02-11" },
                capabilities: { maxContextToken: "128000" },
                rateLimits: [{ key: "token", count: 25000, renewalPeriod: 60 }],
              },
            },
          ]),
      },
    })) as RateLimitsOutput

    expect(out).toEqual({
      resource: {
        subscriptionId: "sub-1",
        resourceGroup: "rg-1",
        accountName: "acct-1",
        accountId:
          "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/acct-1",
      },
      deployments: [
        {
          id: "dep-1-id",
          name: "dep-1",
          model: { format: "OpenAI", name: "glm-5", version: "2026-02-11" },
          limits: { maxContextTokens: 128000 },
          rateLimits: [{ key: "token", count: 25000, renewalPeriod: 60 }],
        },
      ],
    })
  })
})

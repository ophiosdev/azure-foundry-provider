/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { mock } from "bun:test"
import type { TokenCredential } from "@azure/core-auth"
import { azure } from "../src/azure"
import type { ClientFactory } from "../src/types"

describe("azure", () => {
  test("uses the factory client for account and deployment access", async () => {
    const calls: Array<unknown> = []
    const credential = {} as TokenCredential

    const factory = ((receivedCredential: TokenCredential, subscriptionId: string) => {
      calls.push({ receivedCredential, subscriptionId })
      return {
        accounts: {
          get(resourceGroup: string, accountName: string) {
            calls.push({ resourceGroup, accountName, type: "account" })
            return Promise.resolve({ id: "acct-id", name: accountName })
          },
        },
        deployments: {
          async *list(resourceGroup: string, accountName: string) {
            calls.push({ resourceGroup, accountName, type: "deployments" })
            yield { id: "dep-1", name: "b" }
            yield { id: "dep-2", name: "a" }
          },
        },
      }
    }) as unknown as ClientFactory

    const client = azure(credential, "sub-1", factory)

    const account = await client.account({
      subscriptionId: "sub-1",
      resourceGroup: "rg-1",
      accountName: "acct-1",
    })
    const deployments = await client.deployments({
      subscriptionId: "sub-1",
      resourceGroup: "rg-1",
      accountName: "acct-1",
    })

    expect(account).toEqual({ id: "acct-id", name: "acct-1" })
    expect(deployments).toEqual([
      { id: "dep-1", name: "b" },
      { id: "dep-2", name: "a" },
    ])
    expect(calls).toEqual([
      { receivedCredential: credential, subscriptionId: "sub-1" },
      { resourceGroup: "rg-1", accountName: "acct-1", type: "account" },
      { resourceGroup: "rg-1", accountName: "acct-1", type: "deployments" },
    ])
  })

  test("default factory constructs CognitiveServicesManagementClient", async () => {
    const calls: Array<unknown> = []

    await mock.module("@azure/arm-cognitiveservices", () => ({
      CognitiveServicesManagementClient: class FakeClient {
        constructor(credential: TokenCredential, subscriptionId: string) {
          calls.push({ credential, subscriptionId, type: "construct" })
        }

        accounts = {
          get: async (resourceGroup: string, accountName: string) => {
            calls.push({ resourceGroup, accountName, type: "account" })
            return { id: "acct-id", name: accountName }
          },
        }

        deployments = {
          list: async function* (resourceGroup: string, accountName: string) {
            calls.push({ resourceGroup, accountName, type: "deployments" })
            yield { id: "dep-1", name: "dep-1" }
          },
        }
      },
    }))

    const azureModule = await import("../src/azure")
    const credential = {} as TokenCredential
    const client = azureModule.azure(credential, "sub-2")

    await client.account({ subscriptionId: "sub-2", resourceGroup: "rg-2", accountName: "acct-2" })
    await client.deployments({
      subscriptionId: "sub-2",
      resourceGroup: "rg-2",
      accountName: "acct-2",
    })

    expect(calls).toEqual([
      { credential, subscriptionId: "sub-2", type: "construct" },
      { resourceGroup: "rg-2", accountName: "acct-2", type: "account" },
      { resourceGroup: "rg-2", accountName: "acct-2", type: "deployments" },
    ])
  })
})

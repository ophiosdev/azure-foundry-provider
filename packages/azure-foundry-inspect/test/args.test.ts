/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, mock, test } from "bun:test"
import {
  isHelpArg,
  parseArgs,
  parseResourceId,
  renderHelp,
  resolveArgs,
  validateAccountName,
  validateResourceGroup,
  validateSubscriptionId,
} from "../src/args"

describe("parseResourceId", () => {
  test("parses a cognitive services account id", () => {
    expect(
      parseResourceId(
        "/subscriptions/a27f8c37-847b-4c1d-8152-630455cfaae1/resourceGroups/rg-aifoundry/providers/Microsoft.CognitiveServices/accounts/ais5434653589451882810",
      ),
    ).toEqual({
      subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
      resourceGroup: "rg-aifoundry",
      accountName: "ais5434653589451882810",
    })
  })

  test("rejects malformed ids", () => {
    expect(() =>
      parseResourceId("/subscriptions/sub-1/resourceGroups/rg-1/providers/foo/bar"),
    ).toThrow("Invalid Cognitive Services resource id")
  })

  test("rejects wrong provider and missing parts", () => {
    expect(() =>
      parseResourceId(
        "/subscriptions/a27f8c37-847b-4c1d-8152-630455cfaae1/resourceGroups/rg/providers/Microsoft.Storage/accounts/acct",
      ),
    ).toThrow("Invalid Cognitive Services resource id")

    expect(() =>
      parseResourceId(
        "/subscriptions//resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct",
      ),
    ).toThrow("Invalid Cognitive Services resource id")
  })
})

describe("help and validation helpers", () => {
  test("detects help flags", () => {
    expect(isHelpArg(["--help"])).toBe(true)
    expect(isHelpArg(["-h"])).toBe(true)
    expect(isHelpArg(["-?"])).toBe(true)
    expect(isHelpArg(["--subscription", "x"])).toBe(false)
  })

  test("renders help text", () => {
    const help = renderHelp([])
    expect(help).toContain("Options:")
    expect(help).toContain("--resource-id")
    expect(help).toContain("--subscription")
  })

  test("validates primitive identifiers", () => {
    expect(validateSubscriptionId("a27f8c37-847b-4c1d-8152-630455cfaae1")).toBe(
      "a27f8c37-847b-4c1d-8152-630455cfaae1",
    )
    expect(validateResourceGroup("rg.valid_(1)")).toBe("rg.valid_(1)")
    expect(validateAccountName("acct-1")).toBe("acct-1")
  })

  test("rejects invalid primitive identifiers", () => {
    expect(() => validateSubscriptionId("bad")).toThrow("Invalid Azure subscription ID")
    expect(() => validateResourceGroup("")).toThrow("Invalid Azure resource group name")
    expect(() => validateResourceGroup("a".repeat(91))).toThrow("Invalid Azure resource group name")
    expect(() => validateAccountName("a")).toThrow("Invalid Cognitive Services account name")
  })
})

describe("parseArgs", () => {
  test("parses explicit coordinates", () => {
    expect(
      parseArgs([
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "ais5434653589451882810",
      ]),
    ).toEqual({
      format: "json",
      output: undefined,
      pretty: false,
      onlyRatelimits: false,
      target: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
    })
  })

  test("parses resource id", () => {
    expect(
      parseArgs([
        "--resource-id",
        "/subscriptions/a27f8c37-847b-4c1d-8152-630455cfaae1/resourceGroups/rg-aifoundry/providers/Microsoft.CognitiveServices/accounts/ais5434653589451882810",
      ]),
    ).toEqual({
      format: "json",
      output: undefined,
      pretty: false,
      onlyRatelimits: false,
      target: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
    })
  })

  test("rejects mixed selector modes", () => {
    expect(() =>
      parseArgs([
        "--resource-id",
        "/subscriptions/a27f8c37-847b-4c1d-8152-630455cfaae1/resourceGroups/rg-aifoundry/providers/Microsoft.CognitiveServices/accounts/ais5434653589451882810",
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
      ]),
    ).toThrow("Use either --resource-id or --subscription/--resource-group/--account")
  })

  test("rejects unknown args through yargs", () => {
    expect(() => parseArgs(["--nope"])).toThrow()
  })

  test("rejects incomplete triple selectors", () => {
    expect(() =>
      parseArgs([
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
      ]),
    ).toThrow("Use either --resource-id or --subscription/--resource-group/--account")
  })

  test("rejects malformed subscription ids early", () => {
    expect(() =>
      parseArgs([
        "--subscription",
        "sdjkfajsdfkas",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "ais5434653589451882810",
      ]),
    ).toThrow("Invalid Azure subscription ID")
  })

  test("rejects invalid resource group names early", () => {
    expect(() =>
      parseArgs([
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "bad/group",
        "--account",
        "ais5434653589451882810",
      ]),
    ).toThrow("Invalid Azure resource group name")
  })

  test("rejects invalid account names early", () => {
    expect(() =>
      parseArgs([
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "BAD_NAME",
      ]),
    ).toThrow("Invalid Cognitive Services account name")
  })

  test("rejects malformed resource ids with invalid embedded subscription id", () => {
    expect(() =>
      parseArgs([
        "--resource-id",
        "/subscriptions/not-a-guid/resourceGroups/rg-aifoundry/providers/Microsoft.CognitiveServices/accounts/ais5434653589451882810",
      ]),
    ).toThrow("Invalid Azure subscription ID")
  })

  test("parses only-ratelimits boolean option", () => {
    expect(
      parseArgs([
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "ais5434653589451882810",
        "--only-ratelimits",
      ]),
    ).toEqual({
      format: "json",
      output: undefined,
      pretty: false,
      onlyRatelimits: true,
      target: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
    })
  })

  test("parses html format option", () => {
    expect(
      parseArgs([
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "ais5434653589451882810",
        "--format",
        "html",
      ]),
    ).toEqual({
      format: "html",
      output: undefined,
      pretty: false,
      onlyRatelimits: false,
      target: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
    })
  })

  test("rejects --pretty with --format html", () => {
    expect(() =>
      parseArgs([
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "ais5434653589451882810",
        "--format",
        "html",
        "--pretty",
      ]),
    ).toThrow("--pretty can only be used with --format json")
  })

  test("parses output file option with long and short forms", () => {
    expect(
      parseArgs([
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "ais5434653589451882810",
        "--output",
        "report.json",
      ]),
    ).toEqual({
      format: "json",
      output: "report.json",
      pretty: false,
      onlyRatelimits: false,
      target: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
    })

    expect(
      parseArgs([
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "ais5434653589451882810",
        "-o",
        "report.html",
      ]),
    ).toEqual({
      format: "json",
      output: "report.html",
      pretty: false,
      onlyRatelimits: false,
      target: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
    })
  })
})

describe("resolveArgs", () => {
  test("returns parsed args without prompting when argv is complete", async () => {
    const prompt = async () => {
      throw new Error("prompt should not run")
    }

    await expect(
      resolveArgs(
        [
          "--subscription",
          "a27f8c37-847b-4c1d-8152-630455cfaae1",
          "--resource-group",
          "rg-aifoundry",
          "--account",
          "ais5434653589451882810",
        ],
        prompt,
      ),
    ).resolves.toEqual({
      format: "json",
      output: undefined,
      pretty: false,
      onlyRatelimits: false,
      target: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
    })
  })

  test("prompts for resource id when argv is incomplete", async () => {
    await expect(
      resolveArgs([], async () => ({
        mode: "resource-id",
        resourceId:
          "/subscriptions/a27f8c37-847b-4c1d-8152-630455cfaae1/resourceGroups/rg-aifoundry/providers/Microsoft.CognitiveServices/accounts/ais5434653589451882810",
      })),
    ).resolves.toEqual({
      format: "json",
      output: undefined,
      pretty: false,
      onlyRatelimits: false,
      target: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
    })
  })

  test("prompts for triple coordinates when argv is incomplete", async () => {
    await expect(
      resolveArgs(["--format", "html", "--only-ratelimits"], async () => ({
        mode: "triple",
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      })),
    ).resolves.toEqual({
      format: "html",
      output: undefined,
      pretty: false,
      onlyRatelimits: true,
      target: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
    })
  })

  test("interactive prompt resource-id mode works through real prompt functions", async () => {
    await mock.module("@inquirer/prompts", () => ({
      select: async () => "resource-id",
      input: async (question: { validate?: (value: string) => true | string }) => {
        const value =
          "/subscriptions/a27f8c37-847b-4c1d-8152-630455cfaae1/resourceGroups/rg-aifoundry/providers/Microsoft.CognitiveServices/accounts/ais5434653589451882810"
        expect(question.validate?.("bad-id")).toBe("Invalid Cognitive Services resource id")
        expect(question.validate?.(value)).toBe(true)
        return value
      },
    }))

    const argsModule = await import("../src/args")
    await expect(argsModule.resolveArgs([])).resolves.toEqual({
      format: "json",
      output: undefined,
      pretty: false,
      onlyRatelimits: false,
      target: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
    })
  })

  test("interactive prompt triple mode works through real prompt functions", async () => {
    const answers = [
      "triple",
      "a27f8c37-847b-4c1d-8152-630455cfaae1",
      "rg-aifoundry",
      "ais5434653589451882810",
    ]

    await mock.module("@inquirer/prompts", () => ({
      select: async () => answers.shift(),
      input: async (question: {
        message?: string
        validate?: (value: string) => true | string
      }) => {
        if (question.message === "Azure subscription ID") {
          expect(question.validate?.("bad")).toBe("Invalid Azure subscription ID")
        }
        if (question.message === "Azure resource group") {
          expect(question.validate?.("bad/group")).toBe("Invalid Azure resource group name")
        }
        if (question.message === "Cognitive Services account name") {
          expect(question.validate?.("BAD_NAME")).toBe("Invalid Cognitive Services account name")
        }
        const next = answers.shift()
        if (!next) throw new Error("missing mocked answer")
        expect(question.validate?.(next)).toBe(true)
        return next
      },
    }))

    const argsModule = await import("../src/args")
    await expect(argsModule.resolveArgs([])).resolves.toEqual({
      format: "json",
      output: undefined,
      pretty: false,
      onlyRatelimits: false,
      target: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
    })
  })
})

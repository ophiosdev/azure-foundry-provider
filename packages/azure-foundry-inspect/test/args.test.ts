/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { parseArgs, parseResourceId } from "../src/args"

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

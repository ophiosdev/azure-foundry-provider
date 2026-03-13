/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { run } from "../src/cli"

describe("cli run", () => {
  test("writes JSON to stdout on success", async () => {
    let out = ""
    let err = ""
    const code = await run(
      [
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "ais5434653589451882810",
      ],
      {
        stdout: { write: (txt: string) => void (out += txt) },
        stderr: { write: (txt: string) => void (err += txt) },
        inspect: () =>
          Promise.resolve({
            resource: {
              subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
              resourceGroup: "rg-aifoundry",
              accountName: "ais5434653589451882810",
            },
            deployments: [],
          }),
      },
    )

    expect(code).toBe(0)
    expect(err).toBe("")
    expect(JSON.parse(out)).toEqual({
      resource: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
      deployments: [],
    })
  })

  test("passes only-ratelimits through to inspect", async () => {
    let received: unknown
    const code = await run(
      [
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "ais5434653589451882810",
        "--only-ratelimits",
      ],
      {
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        inspect: (opts) => {
          received = opts
          return Promise.resolve({
            resource: {
              subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
              resourceGroup: "rg-aifoundry",
              accountName: "ais5434653589451882810",
            },
            deployments: [],
          })
        },
      },
    )

    expect(code).toBe(0)
    expect(received).toEqual({
      subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
      resourceGroup: "rg-aifoundry",
      accountName: "ais5434653589451882810",
      onlyRatelimits: true,
    })
  })

  test("writes JSON output to file when --output is provided", async () => {
    let writtenPath = ""
    let writtenContent = ""
    let out = ""
    const code = await run(
      [
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "ais5434653589451882810",
        "--output",
        "report.json",
      ],
      {
        stdout: { write: (txt: string) => void (out += txt) },
        stderr: { write: () => undefined },
        writeFile: async (path, content) => {
          writtenPath = path
          writtenContent = content
        },
        inspect: () =>
          Promise.resolve({
            resource: {
              subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
              resourceGroup: "rg-aifoundry",
              accountName: "ais5434653589451882810",
            },
            deployments: [],
          }),
      },
    )

    expect(code).toBe(0)
    expect(out).toBe("")
    expect(writtenPath).toBe("report.json")
    expect(JSON.parse(writtenContent)).toEqual({
      resource: {
        subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
        resourceGroup: "rg-aifoundry",
        accountName: "ais5434653589451882810",
      },
      deployments: [],
    })
  })

  test("writes HTML output to file when --output is provided", async () => {
    let writtenPath = ""
    let writtenContent = ""
    const code = await run(
      [
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "ais5434653589451882810",
        "--format",
        "html",
        "-o",
        "report.html",
      ],
      {
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        writeFile: async (path, content) => {
          writtenPath = path
          writtenContent = content
        },
        inspect: () =>
          Promise.resolve({
            resource: {
              subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
              resourceGroup: "rg-aifoundry",
              accountName: "ais5434653589451882810",
            },
            deployments: [],
          }),
      },
    )

    expect(code).toBe(0)
    expect(writtenPath).toBe("report.html")
    expect(writtenContent).toContain("<!doctype html>")
  })

  test("writes actionable errors to stderr", async () => {
    let out = ""
    let err = ""
    const code = await run([], {
      stdout: { write: (txt: string) => void (out += txt) },
      stderr: { write: (txt: string) => void (err += txt) },
      resolveArgs: () =>
        Promise.reject(
          new Error("Use either --resource-id or --subscription/--resource-group/--account"),
        ),
      inspect: () =>
        Promise.resolve({
          resource: { subscriptionId: "sub-1", resourceGroup: "rg-1", accountName: "acct-1" },
          deployments: [],
        }),
    })

    expect(code).toBe(1)
    expect(out).toBe("")
    expect(err).toContain("Use either --resource-id")
  })

  test("gracefully handles Ctrl+C prompt cancellation", async () => {
    let out = ""
    let err = ""
    const code = await run([], {
      stdout: { write: (txt: string) => void (out += txt) },
      stderr: { write: (txt: string) => void (err += txt) },
      resolveArgs: () =>
        Promise.reject(Object.assign(new Error("cancelled"), { name: "ExitPromptError" })),
      inspect: () =>
        Promise.resolve({
          resource: { subscriptionId: "sub-1", resourceGroup: "rg-1", accountName: "acct-1" },
          deployments: [],
        }),
    })

    expect(code).toBe(130)
    expect(out).toBe("")
    expect(err).toContain("Cancelled.")
  })

  test("prints help with --help", async () => {
    let out = ""
    let err = ""
    const code = await run(["--help"], {
      stdout: { write: (txt: string) => void (out += txt) },
      stderr: { write: (txt: string) => void (err += txt) },
      resolveArgs: () => Promise.reject(new Error("HELP_SHOULD_NOT_REACH_RESOLVE")),
      inspect: () =>
        Promise.resolve({
          resource: {
            subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
            resourceGroup: "rg-aifoundry",
            accountName: "ais5434653589451882810",
          },
          deployments: [],
        }),
    })

    expect(code).toBe(0)
    expect(err).toBe("")
    expect(out).toContain("--resource-id")
  })

  test("prints help with -h", async () => {
    let out = ""
    let err = ""
    const code = await run(["-h"], {
      stdout: { write: (txt: string) => void (out += txt) },
      stderr: { write: (txt: string) => void (err += txt) },
    })

    expect(code).toBe(0)
    expect(err).toBe("")
    expect(out).toContain("--account")
  })

  test("prints help with -?", async () => {
    let out = ""
    let err = ""
    const code = await run(["-?"], {
      stdout: { write: (txt: string) => void (out += txt) },
      stderr: { write: (txt: string) => void (err += txt) },
    })

    expect(code).toBe(0)
    expect(err).toBe("")
    expect(out).toContain("--subscription")
  })

  test("renders HTML when format is html", async () => {
    let out = ""
    const code = await run(
      [
        "--subscription",
        "a27f8c37-847b-4c1d-8152-630455cfaae1",
        "--resource-group",
        "rg-aifoundry",
        "--account",
        "ais5434653589451882810",
        "--format",
        "html",
      ],
      {
        stdout: { write: (txt: string) => void (out += txt) },
        stderr: { write: () => undefined },
        inspect: () =>
          Promise.resolve({
            resource: {
              subscriptionId: "a27f8c37-847b-4c1d-8152-630455cfaae1",
              resourceGroup: "rg-aifoundry",
              accountName: "ais5434653589451882810",
            },
            deployments: [],
          }),
      },
    )

    expect(code).toBe(0)
    expect(out).toContain("<!doctype html>")
    expect(out).toContain("Azure Foundry Inspect")
  })
})

# AGENTS: azure-foundry-provider

This document is the operational guide for any coding agent modifying `azure-foundry-provider`.

## Purpose

`azure-foundry-provider` is a URL-first AI SDK provider for Azure Foundry / Azure OpenAI-compatible endpoints.

Primary goals:

- deterministic routing from endpoint URL and explicit mode configuration
- compatibility with OpenCode/Kilo custom provider loading
- robust runtime behavior across transport selection, retries, throttling, abort handling, and sanitization
- regression-safe evolution through deterministic tests and documented evidence

## Workspace scope

This package is rooted at `/work` in the current workspace. Run package commands from `/work`.

Primary layout:

- `src/`: package source
- `test/`: package tests
- `package.json`: scripts and package metadata

## Source of truth

`AGENTS.md` is the committed operational guide for coding agents in this repository.

- `README.md` is the user-facing source of truth for public behavior and examples.
- Temporary planning or evidence files may exist locally during active work, but contributors must not depend on them being committed.

## Key files

- `src/url.ts`: endpoint parsing, validation, mode inference/override path rewriting
- `src/provider.ts`: provider factory, mode resolution, transport selection, fallback behavior, endpoint variant caching
- `src/request.ts`: tool policy middleware
- `src/quota.ts`: retry, quota, adaptive throttling, sanitization retry wiring, fetch wrapping, governor `__test` hooks
- `src/provider-errors.ts`: chat-operation mismatch detection heuristics and bounded responseBody parsing
- `src/provider-runtime.ts`: timeout, abort, and auth-header handling
- `src/quota-sanitize.ts`: sanitization retry detection and assistant-message sanitization helpers
- `src/quota-utils.ts`: quota math and rate-limit helper logic
- `src/index.ts`: public exports
- `test/provider.test.ts`: provider integration and fallback behavior
- `test/provider-internals.test.ts`: mismatch detector and provider internal helpers
- `test/quota.test.ts`: retry, governor, sanitization, and deterministic runtime tests
- `test/window-queue.test.ts`: pruning and compaction tests
- `.pre-commit-config.yaml`: enforced local and pre-push checks
- `README.md`: user-facing contract and source of truth for documented behavior

## Hard invariants (do not break)

### 1) URL-first routing

Never route by model-name heuristics. Routing must come from endpoint parsing plus configured mode.

Supported endpoint paths:

- `/models/chat/completions`
- `/chat/completions`
- `/responses`
- `/openai/v1/chat/completions`
- `/openai/v1/responses`
- `/openai/v1` (base root; requires effective `apiMode`)

### 2) Query param preservation

Always preserve original query params, including ordering and `api-version` when present.

### 3) `/openai/v1` requirements

`/openai/v1` is supported only with effective API mode:

- global `options.apiMode`, or
- per-model `options.modelOptions[modelId].apiMode`

Do not add extra base-root guesswork (`/openai`, `/`).

### 4) Mode precedence

Effective mode resolution must remain:

1. `modelOptions[modelId].apiMode`
2. global `apiMode`
3. inferred from endpoint operation path

### 5) Transport behavior

- Chat transport: `@ai-sdk/openai-compatible`
- Responses transport: `@ai-sdk/openai/internal`

Keep this split unless there is a strong, tested reason to change.

### 6) Chat fallback guardrails

The provider may fallback from chat -> responses only for known operation-mismatch errors.

Fallback must stay disabled when chat mode is explicitly forced (`apiMode: "chat"` globally or per model).

Mismatch detection is heuristic and regression-locked by corpus tests in `test/provider-internals.test.ts` and integration tests in `test/provider.test.ts`. Do not broaden or tighten heuristics casually.

### 7) Assistant reasoning sanitization

Policy precedence:

1. `modelOptions[modelId].assistantReasoningSanitization`
2. global `assistantReasoningSanitization`
3. default `auto`

`auto` behavior:

- first call unsanitized
- on matching `400` schema-like forbidden reasoning fields, retry once sanitized
- remember strict path for that model in-process

Do not force global sanitization without policy checks.

Retry detection and assistant-only field stripping are regression-locked by corpus tests in `test/quota.test.ts`.

### 8) Quota / retry / adaptive throttling

Do not remove:

- bounded retries
- 429 handling with optional `Retry-After`
- adaptive ratelimit header cooldown
- abort-aware waiting and queueing

### 9) Cooldown scope default

Default cooldown behavior must remain global unless `cooldownScope` is explicitly changed.

## OpenCode/Kilo integration facts

- OpenCode loads this provider via local module path and calls the exported factory.
- OpenCode model metadata (`modalities`, `tool_call`, `reasoning`) is mostly orchestration-level; this provider does not enforce those fields directly.
- Provider-relevant per-model knobs live in `options.modelOptions`.
- Provider internals should not rely on orchestration-level metadata for routing or transport selection.

## Change strategy

When implementing a change:

1. Preserve public behavior unless explicitly changing contract.
2. Add or update tests first or in the same change.
3. Keep docs (`README.md`) in sync for any user-visible behavior.
4. Prefer small, deterministic changes over broad refactors.
5. Prefer test-only hardening first when tightening heuristics or invariants; change runtime code only when a failing test reveals an intended behavioral gap.

## Non-negotiable engineering rules

### 1) Prefer reducing code

- When behavior can be preserved with less code, choose the smaller implementation.
- Remove obsolete code in the same change when safe.
- If code size increases, include a short justification for why net-new code is necessary.

### 2) Mandatory multi-agent contest and consensus (for `src/` changes)

- Before changing any file under `src/`, at least two separate sub-agent analyses/reviews must be produced.
- Prompts for the two analyses must use materially distinct framing (for example perf-first vs maintainability-first).
- The two analyses must not be superficial rewrites of the same plan.
- Each analysis should critique at least one plausible alternative path.
- A consensus decision must be recorded before implementation starts, including:
  - selected approach
  - rejected alternatives with reasons
  - invariant/risk check
- If the two analyses converge too closely without real tradeoff discussion, regenerate them.

### 3) Strict RED-GREEN TDD gate (for `src/` changes)

- Before any code is added or changed in `src/`, tests must be implemented first (RED).
- RED must be demonstrated before the first `src/` modification in the phase.
- RED should identify intended failing tests and distinguish intended failures from unrelated breakage.
- Implementation then proceeds minimally to make tests pass (GREEN).
- Refactor is optional and must keep tests green.

### 4) Evidence artifacts (for substantial `src/` changes)

Before closing substantial work that touches `src/`, store evidence under `.evidence/phase-<nn>/` or an equivalent clearly named work-scope directory:

- `subagent-a.md`
- `subagent-b.md`
- `consensus.md`
- `red.txt`
- `green.txt`
- `reduction.md`
- `bench.md` for optimization phases

Minimum expectations:

- sub-agent prompts recorded verbatim with timestamp and tool/model identity
- consensus records selected approach, rejected alternatives, invariant check, and rollback trigger
- RED records exact commands, expected failing tests, and concise failure mapping
- GREEN records passing tests and command summaries
- reduction records code removed vs added and justification for any net increase

### 5) Benchmark policy (optimization phases only)

Optimization work on admission, contention, token accounting, retry overhead, detector parsing, model construction, or call-path overhead requires benchmarks.

Benchmark requirements:

- at least 5 baseline runs and 5 post-change runs in the same environment
- compare medians as the primary decision metric
- if coefficient of variation exceeds 10%, rerun up to 15 total runs or mark the benchmark inconclusive
- an inconclusive benchmark blocks optimization-phase closeout
- benchmark thresholds must be pre-registered in `consensus.md`
- store the benchmark artifact at `.evidence/phase-<nn>/bench.md`

Benchmark area map:

- admission path: CPU proxy and p50 latency
- contention: wakeups and p95 latency
- TPM decision path: CPU proxy and p50 latency
- retry path: allocation/latency proxy
- detector/error path: parse cost and detector correctness
- model construction: latency
- call path: micro-overhead

### 6) Quota-path sequencing constraints

The following optimization tracks overlap heavily in `src/quota.ts` and shared runtime behavior, and should not be implemented in parallel:

- Phase 2 -> Phase 3 -> Phase 4 -> Phase 6 -> Phase 7 -> Phase 8

Parallel-safe historical tracks:

- Phase 1 and Phase 5 only when they do not overlap active `src/` edits
- Phase 9 and Phase 10 only after Phase 8 closeout

## Repository enforcement

Pre-commit and pre-push hooks are defined in `.pre-commit-config.yaml`. Treat them as part of the contract, not optional tooling.

Pre-commit enforcement includes:

- formatting via `bun run format:staged`
- eslint autofix via `bun run lint:staged`
- YAML linting
- Markdown linting
- actionlint
- typos checks
- large-file and merge-conflict checks
- staged secret scanning with gitleaks

Pre-push enforcement includes:

- `bun run typecheck`
- `bun test`
- secret scanning with TruffleHog

Practical implications:

- expect formatting or lint autofixes on touched files
- do not introduce secrets in code, fixtures, docs, or tests
- run the local equivalents proactively before claiming completion

## Testing requirements

Always run package commands from `/work`.

Required before closeout for meaningful code or test changes:

- `bun run lint`
- `bun run typecheck`
- targeted `bun test` covering touched behavior

Required at runtime-behavior phase closeout:

- `bun test`

Required at milestone or release boundaries:

- `bun test --coverage`

When failures come from unrelated workspace state, missing external tooling, or non-package paths, record that clearly instead of silently ignoring it.

Current quality target:

- overall line coverage >= 90%
- do not merge behavior changes without regression tests

## Coverage notes

- `src/quota.ts` has deterministic runtime-injection hooks for testing via `__test.createGovernor(..., runtime)`.
- Use fake clocks and waits to test RPM, TPM, cooldown, and queue branches deterministically.
- Use `maxAttempts: 1` in tests when you only want single-attempt behavior.
- Keep `__test` exports minimal and focused on deterministic behavior that cannot be validated through public provider APIs.
- Avoid adding utility-level exports to `__test` when equivalent behavior can be covered via integration tests.
- Heuristic detectors are guarded by table-driven corpora in `test/provider-internals.test.ts` and `test/quota.test.ts`. When changing detector behavior, add both true-positive and adversarial near-miss fixtures.
- Concurrency fairness and pruning behavior are covered by deterministic stress-style tests. Extend them with fake clocks and waits rather than real-time load tests.
- Use integration tests in `test/provider.test.ts` to verify detector outcomes map to actual fallback behavior.

## Error handling principles

- Prefer actionable errors that mention expected path and mode requirements.
- Do not swallow transport errors silently.
- Keep fallback rules narrow and explicit.
- When adjusting heuristic detectors, prefer reducing false positives without widening fallback or sanitization retries accidentally; update corpus tests first.

## Security and safety

- Never log or hardcode API secrets.
- Respect explicit auth headers (do not override with `api-key`).
- Keep timeout and abort behavior intact to avoid hanging requests.
- Secret scanning is enforced by gitleaks and TruffleHog; test fixtures and docs must avoid realistic secrets.

## Style and implementation notes

- Keep logic local unless reuse is clear.
- Avoid introducing `any`.
- Keep exports minimal and intentional.
- Test hooks (`__test`) are acceptable for deterministic coverage, but should expose helpers only and must not alter runtime behavior.
- Prefer table-driven fixtures for heuristic detectors and scheduler or state-machine coverage when many near-duplicate cases exist.

## TypeScript best practices

- Prefer `type` aliases for package-local shapes and unions; use `interface` only when declaration merging is needed.
- Model finite states with string literal unions instead of free-form `string`.
- Keep function signatures narrow; prefer `unknown` over `any` at boundaries and refine via type guards.
- Use explicit return types on exported functions and public factories.
- Avoid type assertions unless unavoidable; if needed, keep the cast at the edge and document why.
- Preserve readonly intent where possible (`const`, readonly tuples/arrays for static maps).
- Keep discriminated unions stable when adding new cases; update switch branches and tests together.
- Avoid optional-chaining chains that hide logic errors in critical routing code; validate required values early and fail with actionable errors.
- Co-locate parsing and normalization helpers with runtime checks so type narrowing follows control flow.
- Do not widen external contract types casually; changes to exported option types require README and test updates.
- In tests, prefer strongly typed fixtures and named fixture tables over inline `as any` payloads.
- Use descriptive fixture names so failing assertions identify the case directly.
- Keep test-only utilities behind `__test` exports; do not leak internals into runtime call paths.
- The linting profile in this repo prioritizes safety and correctness over style-only churn; do not introduce broad stylistic rewrites just to satisfy lint.

## Common pitfalls

- Assuming the package lives under `/work/azure-foundry-provider`; the active package root is `/work`.
- Breaking `/openai/v1` base endpoint handling by requiring explicit operation path.
- Reintroducing OpenAI reasoning heuristics that map `system` -> `developer` for chat payloads.
- Sending unsupported assistant reasoning fields to strict chat endpoints without policy.
- Accidentally dropping query params when rewriting operation paths.
- Changing mismatch or sanitization heuristics without updating the corpus tests.
- Interpreting current broad heuristic matches as accidental unless tests and docs are intentionally changed together.
- Replacing deterministic governor tests with real-time or flaky timing-based tests.

## Release checklist for behavior changes

- [ ] `bun run lint` passes
- [ ] `bun run typecheck` passes
- [ ] Targeted tests pass
- [ ] `bun test` passes when runtime behavior changed
- [ ] `bun test --coverage` checked at milestone or release boundaries
- [ ] README updated for user-visible behavior or public type changes
- [ ] No unsupported endpoint/path regressions
- [ ] `/openai/v1` base + per-model mode override behavior still verified
- [ ] RED-GREEN TDD evidence captured for all `src/` changes
- [ ] Two independent sub-agent analyses completed for all `src/` changes
- [ ] Consensus note recorded before implementation for all `src/` changes
- [ ] Evidence artifacts stored under `.evidence/phase-<nn>/...` or an equivalent clearly named work-scope directory
- [ ] Benchmark artifact recorded for optimization phases
- [ ] Phase sequencing constraints respected
- [ ] Heuristic corpus updated when mismatch or sanitization behavior changes
- [ ] Code reduction assessment documented (or justified net increase)

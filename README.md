# Azure Foundry AI Provider

`azure-foundry-provider` is a highly specialized, production-grade AI SDK provider designed for Azure AI Foundry and Azure OpenAI-compatible endpoints.

## Principals

### URL-First Determinism

While many providers rely on fragile model-name heuristics to decide how to route requests, this provider is built on a **URL-first routing architecture**. By treating the full Azure endpoint URL (including query parameters) as the absolute source of truth, routing, API versions, and operation modes are handled with mathematical determinism. This eliminates "magic" string matching and makes it the preferred choice for enterprise environments where reliability is non-negotiable.

### Advanced Throttling & The "Governor"

The implementation features a sophisticated quota management system known as the **Governor**. It goes beyond static limits by implementing **adaptive throttling** that parses real-time `x-ratelimit-*` headers directly from Azure responses. This allows the provider to dynamically apply "soft" or "hard" cooldowns, preventing 429 failures before they occur. Combined with jittered exponential backoff and abort-aware request queueing, the Governor ensures robust performance even under high-concurrency workloads.

### Intelligent Error Recovery

A standout feature of the provider is its **Chat-to-Responses fallback**. Azure's model-operation compatibility can vary; if a request is routed to a Chat endpoint but the model rejects the operation, the provider intelligently detects the specific error payload and automatically retries through the Responses transport. This recovery is carefully balanced to respect explicit developer intent, remaining disabled when a specific mode is strictly forced.

### Engineered for Reliability

The codebase adheres to the highest standards of modern TypeScript development, utilizing strict compiler configurations to eliminate boundary errors between the Azure API and your application. The architecture is highly modular, with specialized components for request sanitization and error analysis, and is backed by a comprehensive test suite (>90% coverage) that utilizes deterministic time-injection to verify complex throttling logic.

## Highlights

- URL-first routing from copied Azure endpoint URLs (no model-name endpoint heuristics)
- Supports both chat and responses operation paths
- Supports Azure v1 operation paths and `/openai/v1` base root with mode-driven routing
- Chat transport uses OpenAI-compatible semantics (system role remains `system`, `max_tokens` is used)
- Request policy control for tools (`auto`, `off`, `on`)
- Built-in retries and 429 handling with exponential backoff + jitter
- Event-driven waiter queue for `maxConcurrent` admission (wake-on-release, abort-aware waits)
- Optional static quota controls (`rpm`, `tpm`, `maxConcurrent`, `maxOutputTokensCap`)
- Adaptive throttling from Azure `x-ratelimit-*` headers
- Request sanitization for chat history compatibility (removes assistant `reasoning_content`/`reasoning` fields)
- Automatic chat->responses fallback for model/operation mismatch errors (when mode is not explicitly forced to chat)
- Optional observability callbacks (`onRetry`, `onAdaptiveCooldown`, `onSanitizedRetry`, `onFallback`)
- Timeout support via `AbortSignal`

## Supported endpoint patterns

Accepted hostnames:

- `*.services.ai.azure.com`
- `*.cognitiveservices.azure.com`
- `*.openai.azure.com`

Accepted operation suffixes:

- `/models/chat/completions`
- `/chat/completions`
- `/responses`
- `/openai/v1/chat/completions`
- `/openai/v1/responses`
- `/openai/v1` (base root, requires `apiMode` configuration)

Examples:

- `https://<id>.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview`
- `https://<res>.cognitiveservices.azure.com/openai/chat/completions?api-version=preview`
- `https://<res>.cognitiveservices.azure.com/openai/responses?api-version=preview`
- `https://<res>.openai.azure.com/openai/chat/completions?api-version=2024-05-01-preview`
- `https://<res>.openai.azure.com/openai/v1/chat/completions`
- `https://<res>.services.ai.azure.com/openai/v1/responses`
- `https://<res>.cognitiveservices.azure.com/openai/v1`

Note on `api-version`:

- `/models/chat/completions` requires `api-version`.
- `/openai/v1/*` endpoints do not require `api-version`.
- `/openai/v1` base endpoint requires effective `apiMode` (global `apiMode` or per-model `modelOptions[modelId].apiMode`).

## Quick start (TypeScript)

```ts
import { createAzureFoundryProvider } from "azure-foundry-provider"

const provider = createAzureFoundryProvider({
  endpoint:
    "https://my-resource.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
  apiKey: process.env.AZURE_API_KEY,
})

const model = provider.languageModel("DeepSeek-V3.1")
```

## OpenCode/Kilo integration example

```json
{
  "provider": {
    "azure-foundry": {
      "name": "Azure Foundry",
      "npm": "file:///usr/local/bun/providers/azure-foundry-provider/src/index.ts",
      "models": {
        "deepseek-v3.1": {
          "id": "DeepSeek-V3.1",
          "name": "DeepSeek V3.1",
          "tool_call": false,
          "reasoning": false,
          "limit": { "context": 64000, "output": 1024 },
          "modalities": { "input": ["text"], "output": ["text"] }
        }
      },
      "options": {
        "endpoint": "https://<id>.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
        "apiKey": "{env:AZURE_API_KEY}",
        "timeout": 90000,
        "quota": {
          "adaptive": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

## API

### `createAzureFoundryProvider(options?)`

Creates a provider that implements AI SDK `ProviderV2` plus convenience methods:

- `provider(modelId)`
- `provider.languageModel(modelId)`
- `provider.chat(modelId)`
- `provider.responses(modelId)`

Unsupported model families intentionally throw `NoSuchModelError`:

- `provider.textEmbeddingModel(modelId)`
- `provider.imageModel(modelId)`

### Options reference

```ts
type AzureFoundryOptions = {
  endpoint?: string
  apiKey?: string
  headers?: Record<string, string>
  apiMode?: "chat" | "responses"
  toolPolicy?: "auto" | "off" | "on"
  timeout?: number | false
  quota?: QuotaOptions
  cooldownScope?: "global" | "per-model"
  assistantReasoningSanitization?: "auto" | "always" | "never"
  modelOptions?: Record<
    string,
    {
      apiMode?: "chat" | "responses"
      assistantReasoningSanitization?: "auto" | "always" | "never"
    }
  >
  onRetry?: (event: RetryEvent) => void
  onAdaptiveCooldown?: (event: AdaptiveCooldownEvent) => void
  onSanitizedRetry?: (event: SanitizedRetryEvent) => void
  onFallback?: (event: FallbackEvent) => void
  fetch?: FetchFunction
  name?: string
}
```

- `endpoint`:
  - Full URL to Azure endpoint.
  - If omitted, loads from `AZURE_FOUNDRY_ENDPOINT`.
  - Must use `https://`.
  - `/models/chat/completions` requires `api-version` query.
- `apiKey`:
  - API key value.
  - If omitted, loads from `AZURE_API_KEY`.
- `headers`:
  - Extra headers to include on every request.
  - If `Authorization` or `api-key` is present, provider does not inject `api-key` automatically.
- `apiMode`:
  - Optional override: `"chat"` or `"responses"`.
  - If omitted, mode is inferred from URL path.
  - Override rewrites only operation suffix while preserving origin, path prefix, and query params.
- `toolPolicy` (default `"auto"`):
  - `"auto"`: pass-through.
  - `"off"`: strips tools and enforces `toolChoice: { type: "none" }`.
  - `"on"`: if tools exist and tool choice is not fixed, forces `toolChoice: { type: "required" }`.
- `timeout`:
  - `number`: request timeout in milliseconds.
  - `false`: explicitly disables timeout.
  - `undefined`: no timeout wrapper.
- `quota`:
  - Static quota limits + retry + adaptive throttling options.
- `cooldownScope` (default `"global"`):
  - Controls how cooldown is applied after rate-limit pressure.
  - `"global"`: one cooldown can pause all models using this provider instance.
  - `"per-model"`: cooldown is isolated to the model that triggered it.
- `assistantReasoningSanitization` (default `"auto"`):
  - Global policy for assistant reasoning field sanitization.
  - `"always"`: sanitize before first request.
  - `"auto"`: send raw first, sanitize only when endpoint rejects reasoning fields.
  - `"never"`: never sanitize.
- `modelOptions`:
  - Model-specific overrides for provider behavior.
  - Supports per-model `apiMode` and `assistantReasoningSanitization`.
- `onRetry`:
  - Optional callback emitted before retry waits on retryable responses.
  - Use it to understand retry pressure and tune retry/quota settings.
  - Event contract: `{ eventVersion: "v1", phase: "retry", attempt, reason, status?, retryAfterMs?, modelId? }`.
- `onAdaptiveCooldown`:
  - Optional callback emitted when adaptive ratelimit headers trigger cooldown.
  - Use it to correlate cooldown windows with endpoint pressure.
  - Event contract: `{ eventVersion: "v1", phase: "adaptive_cooldown", cooldownMs, reason, remainingRequests?, remainingTokens?, modelId? }`.
- `onSanitizedRetry`:
  - Optional callback emitted when `assistantReasoningSanitization: "auto"` retries after schema rejection.
  - Use it to identify strict endpoints/models that should move to per-model `"always"` sanitization.
  - Event contract: `{ eventVersion: "v1", phase: "sanitized_retry", reason, sanitizedFields, status?, modelId? }`.
- `onFallback`:
  - Optional callback emitted when chat transport falls back to responses on operation mismatch.
  - Use it to find models that should be explicitly configured for responses mode.
  - Event contract: `{ eventVersion: "v1", phase: "fallback", fromMode: "chat", toMode: "responses", reason, status?, modelId? }`.
  - Fallback guardrails are unchanged: disabled when chat mode is explicitly forced.
- `fetch`:
  - Custom fetch implementation.
- `name` (default `"azure-foundry"`):
  - Provider id prefix in `model.provider` (for diagnostics).

## Mode behavior

### Inference

- `/chat/completions` or `/models/chat/completions` -> `chat`
- `/responses` -> `responses`

### Override behavior (`apiMode`)

If the URL path and `apiMode` differ, the provider rewrites the operation suffix and keeps:

- hostname/origin
- any path prefix before operation suffix
- all query parameters in original order

Per-model mode override is also supported via `modelOptions[modelId].apiMode` and takes precedence over global `apiMode`.

### Operation mismatch fallback

When a request is routed to chat and Azure returns a model/operation mismatch error like:

- `The chatCompletion operation does not work with the specified model ...`

the provider can retry once through responses transport for the same model. This behavior is enabled only when chat mode is not explicitly forced:

- fallback allowed: inferred mode or non-chat global/per-model mode context
- fallback disabled: explicit global `apiMode: "chat"` or per-model `apiMode: "chat"`

This keeps strict explicit chat configurations deterministic while improving resilience for mixed model setups.

## Observability callbacks

The provider can emit callback events for retry, adaptive cooldown, sanitization retry, and chat->responses fallback decisions.

Why these callbacks exist:

- explain provider decisions in production without changing transport behavior
- help tune retry/quota/sanitization settings from real runtime signals
- make it easier to detect model/endpoint mismatches early

Callbacks are optional. If you do not set them, behavior is unchanged.

### Event reference (`eventVersion: "v1"`)

| Callback             | Required fields                                         | Optional fields                                   | Typical reasons                                         |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| `onRetry`            | `eventVersion`, `phase`, `attempt`, `reason`            | `status`, `retryAfterMs`, `modelId`               | `status_429`, `retryable_status`                        |
| `onAdaptiveCooldown` | `eventVersion`, `phase`, `cooldownMs`, `reason`         | `remainingRequests`, `remainingTokens`, `modelId` | `requests_depleted`, `tokens_depleted`, `low_watermark` |
| `onSanitizedRetry`   | `eventVersion`, `phase`, `reason`, `sanitizedFields`    | `status`, `modelId`                               | `schema_rejection`                                      |
| `onFallback`         | `eventVersion`, `phase`, `fromMode`, `toMode`, `reason` | `status`, `modelId`                               | `chat_operation_mismatch`                               |

### Security and data boundaries

Callback payloads are metadata-only. They intentionally exclude:

- raw headers
- raw request/response bodies
- API keys and bearer tokens

### Example: structured logging

```ts
import { createAzureFoundryProvider } from "azure-foundry-provider"

const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  onRetry: (event) => {
    console.info("provider.retry", event)
  },
  onAdaptiveCooldown: (event) => {
    console.info("provider.cooldown", event)
  },
  onSanitizedRetry: (event) => {
    console.info("provider.sanitized_retry", event)
  },
  onFallback: (event) => {
    console.info("provider.fallback", event)
  },
})
```

### Example: metrics integration

```ts
import { createAzureFoundryProvider } from "azure-foundry-provider"

type Metrics = {
  count: (name: string, tags?: Record<string, string>) => void
  histogram: (name: string, value: number, tags?: Record<string, string>) => void
}

const metrics: Metrics = {
  count: (name, tags) => {
    // wire to your metrics backend
  },
  histogram: (name, value, tags) => {
    // wire to your metrics backend
  },
}

const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  onRetry: (event) => {
    metrics.count("azure_provider_retry_total", {
      reason: event.reason,
      status: String(event.status ?? "none"),
      model: event.modelId ?? "unknown",
    })
  },
  onAdaptiveCooldown: (event) => {
    metrics.histogram("azure_provider_cooldown_ms", event.cooldownMs, {
      reason: event.reason,
      model: event.modelId ?? "unknown",
    })
  },
  onFallback: (event) => {
    metrics.count("azure_provider_fallback_total", {
      reason: event.reason,
      from: event.fromMode,
      to: event.toMode,
      model: event.modelId ?? "unknown",
    })
  },
})
```

### Example: config tuning workflow

Use callbacks to turn runtime observations into explicit config:

1. If `onFallback` fires repeatedly for a model, set `modelOptions[modelId].apiMode = "responses"`.
2. If `onSanitizedRetry` fires repeatedly for a model, set `modelOptions[modelId].assistantReasoningSanitization = "always"`.
3. If `onRetry` + `onAdaptiveCooldown` rates are high, tune `quota.retry` and review endpoint capacity.

## Auth behavior

Priority:

1. Use `headers.Authorization` or `headers["api-key"]` if explicitly provided.
2. Else inject `api-key` from `apiKey` option.
3. Else inject `api-key` from `AZURE_API_KEY`.

`User-Agent` suffix is automatically appended as `azure-foundry-provider/<version>`.

## Chat compatibility behavior

For chat requests, provider applies compatibility safeguards:

- Preserves `system` role (no remap to `developer`)
- Uses `max_tokens` for output budget

Assistant reasoning field sanitization is configurable:

- Global: `assistantReasoningSanitization`
- Per model: `modelOptions[modelId].assistantReasoningSanitization`
- Effective policy precedence:
  1. per-model override
  2. global policy
  3. default `auto`

When sanitization is active, the provider removes assistant fields that break strict endpoints:

- `reasoning_content`
- `reasoning`

In `auto` mode, provider retries once with sanitized assistant fields after `400` schema-like rejections for reasoning fields and then remembers this path for that model in-process.

### Why this exists

Some orchestration stacks include prior assistant thinking in conversation history using fields such as `reasoning_content` (or similar metadata). Several Azure Foundry chat endpoints reject those assistant fields as unknown/forbidden input. When that happens, requests fail even though the rest of the payload is valid.

### Why keeping assistant thinking can be useful

When an endpoint supports assistant reasoning fields, preserving them can improve multi-turn behavior:

- Better continuity across long tasks: the model can reuse its prior intermediate plan instead of rebuilding context from scratch.
- More stable tool workflows: follow-up calls can align with earlier tool-selection rationale, reducing unnecessary tool churn.
- Fewer repeated clarifications: prior reasoning state can help the model avoid re-asking already resolved constraints.
- Better long-horizon decomposition: complex tasks that span many turns often benefit when the model can reference previous internal decomposition.

Trade-off: compatibility varies by endpoint/model. Strict validators (notably some Mistral Foundry chat paths) reject `reasoning_content`/`reasoning`, so pass-through is not universally safe.

Practical recommendation:

- Use global `assistantReasoningSanitization: "auto"`.
- Set strict models to `"always"` via `modelOptions`.
- Use `"never"` only when you know the endpoint accepts reasoning fields and you explicitly want pass-through behavior.

Typical failure pattern on strict models/endpoints (for example Mistral via strict Foundry chat validation):

- HTTP `400 Bad Request`
- validation details mention forbidden extra fields
- error details reference assistant reasoning fields in message history, for example:
  - `type: "extra_forbidden"`
  - location like `messages[*].assistant.reasoning_content`

Concrete example observed:

```json
{
  "detail": [
    {
      "type": "extra_forbidden",
      "loc": ["body", "messages", 2, "assistant", "reasoning_content"],
      "msg": "Extra inputs are not permitted"
    },
    {
      "type": "extra_forbidden",
      "loc": ["body", "messages", 4, "assistant", "reasoning_content"],
      "msg": "Extra inputs are not permitted"
    }
  ]
}
```

If you observe this class of error, set model-specific sanitization to `always` for that model to skip the first failing roundtrip and improve latency.

```ts
const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  assistantReasoningSanitization: "auto",
  modelOptions: {
    "Mistral-Large-3": {
      assistantReasoningSanitization: "always",
    },
  },
})
```

Policy guidance:

- `auto`: best default when model behavior is mixed/unknown.
- `always`: best for models you know reject assistant reasoning fields (avoids one failed HTTP 400 attempt).
- `never`: only use when endpoint explicitly supports these fields and you require exact pass-through.

## Quota and throttling

### Types

```ts
type QuotaRule = {
  rpm?: number
  tpm?: number
  maxConcurrent?: number
  maxOutputTokensCap?: number
}

type QuotaRetryOptions = {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
  honorRetryAfter?: boolean
  cooldownOn429Ms?: number
}

type QuotaAdaptiveOptions = {
  enabled?: boolean
  minCooldownMs?: number
  lowWatermarkRatio?: number
  lowCooldownMs?: number
}

type QuotaOptions = {
  default?: QuotaRule
  models?: Record<string, QuotaRule>
  retry?: QuotaRetryOptions
  adaptive?: QuotaAdaptiveOptions
}
```

### Built-in defaults

Retry defaults (used unless overridden):

- `maxAttempts: 4`
- `baseDelayMs: 1200`
- `maxDelayMs: 30000`
- `jitterRatio: 0.25`
- `honorRetryAfter: true`
- `cooldownOn429Ms: 10000`

Adaptive defaults (used unless overridden):

- `enabled: true`
- `minCooldownMs: 1000`
- `lowWatermarkRatio: 0.1`
- `lowCooldownMs: 250`

Static limits (`default` and `models`) are opt-in only.

### What the governor does

- Queues requests when any configured limit would be exceeded.
- Supports per-model overrides by model id string in request body.
- Applies output token clamping via `maxOutputTokensCap`.
- Retries retryable statuses (`429`, `408`, `500`, `502`, `503`, `504`) with bounded backoff.
- Honors `Retry-After` on `429` when enabled.
- Uses adaptive cooldown from headers when near/at budget floor:
  - `x-ratelimit-limit-requests`
  - `x-ratelimit-limit-tokens`
  - `x-ratelimit-remaining-requests`
  - `x-ratelimit-remaining-tokens`
- Waits are abort-aware; canceled requests do not stay queued indefinitely.

### Head-index queue pruning

The governor maintains sliding windows for request-rate and token-rate accounting. These windows are pruned frequently, so their data structure matters for both throughput and latency.

#### Why this exists

In a naive FIFO queue, pruning old entries with `shift()` repeatedly can become expensive because each `shift()` reindexes the remaining array. Under sustained load, this adds avoidable CPU overhead in a hot path.

To avoid that, the provider uses head-index pruning:

- events are appended to arrays (`requests`, `tokens`)
- pruning advances a head pointer (`requestHead`, `tokenHead`) instead of shifting array elements
- active window length is computed from `array.length - head`
- periodic compaction trims consumed prefixes when head growth crosses thresholds

This keeps pruning cost proportional to the number of expired entries without repeated reindexing work.

#### How it works in this provider

For each model window, the governor tracks:

- `requests`: request timestamps for RPM checks
- `requestHead`: start index of currently active request timestamps
- `tokens`: `{ at, tokens }` events for TPM checks
- `tokenHead`: start index of currently active token events

At each acquire loop:

1. Calculate the minimum active timestamp (`now - windowMs`).
2. Advance `requestHead` while old request timestamps are out of window.
3. Advance `tokenHead` while old token events are out of window.
4. Evaluate waits (`maxConcurrent`, RPM, TPM) against active slices.
5. Append current event on successful admission.

Compaction policy:

- when head index grows large relative to array size, the window compacts the live slice and resets head to `0`
- this avoids unbounded stale prefix growth while preserving simple, predictable behavior

#### Operational impact

- Lower CPU churn in prune-heavy workloads.
- Better tail latency stability when many requests age out in bursts.
- No change to external quota semantics; this is an internal queue-maintenance optimization.

#### Conceptual example

```ts
type TokenEvent = { at: number; tokens: number }

let requests: number[] = []
let requestHead = 0

let tokens: TokenEvent[] = []
let tokenHead = 0

function prune(now: number, windowMs: number) {
  const min = now - windowMs

  while (requestHead < requests.length && requests[requestHead]! < min) {
    requestHead += 1
  }

  while (tokenHead < tokens.length && tokens[tokenHead]!.at < min) {
    tokenHead += 1
  }
}

function activeRequests() {
  return requests.slice(requestHead)
}

function activeTokens() {
  return tokens.slice(tokenHead)
}
```

The real implementation also adds bounded compaction and integrates these active windows directly into RPM/TPM wait calculations.

### Event-driven waiter queue (`maxConcurrent`)

When `maxConcurrent` is configured, the governor must decide when waiting requests are allowed to start. The provider uses an event-driven waiter queue for this path.

#### Why this exists

A polling approach (for example waking every fixed interval) adds avoidable wakeups and increases contention jitter. Under sustained load, polling can make latency less predictable because many wait cycles are spent checking unchanged state.

The event-driven queue removes that polling loop:

- if capacity is available, request is admitted immediately
- if capacity is full, request registers a waiter and sleeps
- when a running request releases capacity, one waiter is signaled

This converts concurrency waiting from timer-driven checks to release-driven notifications.

#### How it works in this provider

For each model window, the governor keeps a FIFO waiter list used only for `maxConcurrent` contention.

Acquire path (simplified):

1. Check current `active` count against `maxConcurrent`.
2. If at capacity, enqueue a waiter callback.
3. If `AbortSignal` triggers while queued, remove waiter and reject with `AbortError`.
4. On wakeup, re-enter admission checks and proceed when allowed.

Release path (simplified):

1. Decrement `active` count.
2. Pop the next waiter from the FIFO queue.
3. Signal exactly one waiter to continue.

This preserves deterministic queueing behavior while avoiding broadcast wakeups.

#### Abort behavior while queued

Queued waits remain abort-aware:

- aborted waiters are removed from the queue
- aborted requests do not hold a slot and do not block later waiters

This avoids stale waiters accumulating during client-side timeouts or cancellations.

#### Operational impact

- Fewer unnecessary timer wakeups in `maxConcurrent` contention scenarios.
- Better tail latency stability compared with fixed-interval polling.
- No change to public quota semantics; only the internal waiting strategy is changed.

#### Conceptual example

```ts
const waiters: Array<() => void> = []
let active = 0
const maxConcurrent = 1

async function acquire(signal?: AbortSignal) {
  while (active >= maxConcurrent) {
    await new Promise<void>((resolve, reject) => {
      const onWake = () => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }
      const onAbort = () => {
        const i = waiters.indexOf(onWake)
        if (i >= 0) waiters.splice(i, 1)
        reject(new DOMException("aborted", "AbortError"))
      }

      waiters.push(onWake)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  active += 1

  return () => {
    active = Math.max(0, active - 1)
    const next = waiters.shift()
    next?.()
  }
}
```

In the provider, this waiter mechanism is integrated with RPM/TPM checks, adaptive cooldown, retry behavior, and abort-aware request handling.

### O(1) token-window accounting

Token-per-minute (TPM) limiting can become expensive if each admission check re-sums all active token events in the window. To keep the hot path stable under load, the provider maintains a rolling token sum per model window.

#### Why this exists

A scan-based TPM check often looks like this:

- prune old token events
- sum all remaining token values
- compare `sum + pendingTokens` against `tpm`

That repeated summation adds avoidable work at high request rates.

The provider avoids this by tracking a running aggregate:

- append token events on admit
- keep `tokenSum` as the current active-window total
- subtract evicted event values during prune

This makes the common-path accounting constant-time with amortized pruning work.

#### How it works in this provider

For each model window, the governor tracks:

- `tokens`: token events (`{ at, tokens }`)
- `tokenHead`: index of first active token event
- `tokenSum`: running total of active-window token usage

Admission flow for TPM (simplified):

1. Prune expired token events (`at < now - windowMs`).
2. For each evicted event, decrement `tokenSum`.
3. Fast check: if `tokenSum + pendingTokens <= tpm`, admit immediately.
4. If over limit, compute the next admissible time by walking forward from `tokenHead` until the projected sum fits.
5. On admit, append event and increment `tokenSum`.

The fast check is O(1). The fallback walk only occurs when the request is currently over budget.

#### Correctness behavior

- The running sum always reflects active-window token usage after prune.
- Each committed token event is added once and removed once.
- Oversized single requests (`pendingTokens > tpm`) keep existing behavior and are not blocked by TPM wait logic.
- No external API/contract changes: this is internal governor accounting behavior.

#### Operational impact

- Lower CPU overhead in TPM-heavy workloads.
- More predictable latency during sustained token traffic.
- Fewer full-window token summations in steady-state admission checks.

#### Conceptual example

```ts
type TokenEvent = { at: number; tokens: number }

let tokenEvents: TokenEvent[] = []
let tokenHead = 0
let tokenSum = 0

function prune(now: number, windowMs: number) {
  const min = now - windowMs
  while (tokenHead < tokenEvents.length && tokenEvents[tokenHead]!.at < min) {
    tokenSum -= tokenEvents[tokenHead]!.tokens
    tokenHead += 1
  }
}

function canAdmit(now: number, windowMs: number, tpm: number, pendingTokens: number) {
  prune(now, windowMs)
  return pendingTokens > tpm || tokenSum + pendingTokens <= tpm
}

function commit(now: number, pendingTokens: number) {
  tokenEvents.push({ at: now, tokens: pendingTokens })
  tokenSum += pendingTokens
}
```

The provider combines this accounting with head-index pruning, event-driven `maxConcurrent` waiting, adaptive cooldown, and retry behavior in one admission loop.

### Cooldown scope (`global` vs `per-model`)

Cooldown is the governor's temporary pause mechanism when rate-limit pressure is detected (for example from `429` handling or adaptive header signals). `cooldownScope` controls who the pause applies to.

#### Why this setting matters

In mixed-model workloads, one model can be much noisier than another. Without scope control, a cooldown triggered by one model can slow unrelated traffic.

Use `cooldownScope` to choose behavior explicitly:

- `"global"` (default): conservative shared backpressure across the provider instance
- `"per-model"`: isolate cooldown impact to the model that triggered it

#### How the two modes behave

`"global"`:

- one cooldown window is shared by all models using the provider instance
- simplest and most conservative behavior for shared quotas
- best when all models map to the same constrained upstream budget

`"per-model"`:

- cooldown windows are tracked per model id
- model `A` can be paused while model `B` continues if `B` has available budget
- best for mixed-model deployments where isolation matters

#### When to use each mode

Use `"global"` when:

- you want strict backpressure for the whole provider
- your deployment has one shared quota envelope and fairness between models is less important than global stability

Use `"per-model"` when:

- one model is frequently rate-limited and should not slow all others
- you run heterogeneous model traffic and want better isolation

#### Interaction with adaptive throttling and retries

- Adaptive throttling (`x-ratelimit-*`) still decides when to apply cooldown.
- Retry policy (`Retry-After`, jitter/backoff, `cooldownOn429Ms`) still decides delay magnitudes.
- `cooldownScope` changes only the cooldown target (all models vs triggering model).

#### Precedence and defaults

- Default is `"global"` for backward-compatible behavior.
- Scope is configured per provider instance via `cooldownScope`.
- If omitted, behavior is identical to prior global cooldown behavior.

#### Example: global cooldown (default)

```ts
const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  quota: {
    adaptive: { enabled: true },
    retry: { maxAttempts: 4, cooldownOn429Ms: 10_000 },
  },
  // cooldownScope defaults to "global"
})
```

#### Example: per-model cooldown isolation

```ts
const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  cooldownScope: "per-model",
  quota: {
    adaptive: { enabled: true },
    retry: { maxAttempts: 4, cooldownOn429Ms: 10_000 },
  },
})
```

#### Observability tips

To validate your choice in production:

- track `onAdaptiveCooldown` and `onRetry` by `modelId`
- compare cooldown and retry rates before/after changing `cooldownScope`
- if unrelated models are throttled together too often, switch to `"per-model"`

## Examples

### 1) Minimal (adaptive-only)

```ts
const provider = createAzureFoundryProvider({
  endpoint:
    "https://ais123.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
  apiKey: process.env.AZURE_API_KEY,
  quota: {
    adaptive: { enabled: true },
  },
})
```

### 2) Fully static quota controls

```ts
const provider = createAzureFoundryProvider({
  endpoint:
    "https://ais123.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
  apiKey: process.env.AZURE_API_KEY,
  timeout: 90_000,
  quota: {
    default: {
      rpm: 6,
      tpm: 20_000,
      maxConcurrent: 1,
      maxOutputTokensCap: 1024,
    },
    models: {
      "Kimi-K2.5": {
        rpm: 3,
        tpm: 12_000,
        maxConcurrent: 1,
        maxOutputTokensCap: 768,
      },
      "Kimi-K2-Thinking": {
        rpm: 2,
        tpm: 8_000,
        maxConcurrent: 1,
        maxOutputTokensCap: 640,
      },
      "Mistral-Large-3": {
        rpm: 4,
        tpm: 16_000,
        maxConcurrent: 1,
        maxOutputTokensCap: 1024,
      },
    },
  },
})
```

### 3) Retry tuning

```ts
const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  quota: {
    retry: {
      maxAttempts: 5,
      baseDelayMs: 800,
      maxDelayMs: 20_000,
      jitterRatio: 0.2,
      honorRetryAfter: true,
      cooldownOn429Ms: 5000,
    },
  },
})
```

### 4) Adaptive tuning from Azure response headers

```ts
const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  quota: {
    adaptive: {
      enabled: true,
      minCooldownMs: 1000,
      lowWatermarkRatio: 0.1,
      lowCooldownMs: 250,
    },
  },
})
```

### 5) Disable adaptive throttling

```ts
const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  quota: {
    adaptive: { enabled: false },
  },
})
```

### 6) Force responses mode on a chat URL

```ts
const provider = createAzureFoundryProvider({
  endpoint: "https://myres.cognitiveservices.azure.com/openai/chat/completions?api-version=preview",
  apiMode: "responses",
  apiKey: process.env.AZURE_API_KEY,
})

const model = provider.languageModel("gpt-4.1")
```

### 7) Disable tool calls regardless of prompt/tool list

```ts
const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  toolPolicy: "off",
})
```

### 8) Require tool calls when tools are present

```ts
const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  toolPolicy: "on",
})
```

### 9) Use bearer token instead of API key header

```ts
const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  headers: {
    Authorization: `Bearer ${process.env.AZURE_ACCESS_TOKEN}`,
  },
})
```

### 10) Custom timeout behavior

```ts
// 45s timeout
const providerA = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  timeout: 45_000,
})

// explicitly disable timeout wrapper
const providerB = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  timeout: false,
})
```

### 11) Custom fetch for instrumentation

```ts
const tracedFetch: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const start = Date.now()
    const response = await fetch(input, init)
    const ms = Date.now() - start
    console.log("Azure call", response.status, `${ms}ms`)
    return response
  },
  { preconnect: fetch.preconnect },
)

const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  fetch: tracedFetch,
})
```

### 12) Validate/inspect endpoint parsing

```ts
import { parseEndpoint } from "azure-foundry-provider"

const parsed = parseEndpoint(
  "https://foo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview&x=1",
)

console.log(parsed.mode) // chat
console.log(parsed.requestURL)
```

### 13) Global assistant reasoning sanitization policy

```ts
const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  assistantReasoningSanitization: "auto",
})
```

### 14) Per-model override under provider options

```ts
const provider = createAzureFoundryProvider({
  endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!,
  apiKey: process.env.AZURE_API_KEY,
  apiMode: "chat",
  assistantReasoningSanitization: "auto",
  modelOptions: {
    "DeepSeek-V3.1": {
      apiMode: "responses",
    },
    "Mistral-Large-3": {
      assistantReasoningSanitization: "always",
    },
  },
})
```

### 15) v1 base endpoint with mixed per-model protocol overrides

```ts
const provider = createAzureFoundryProvider({
  endpoint: "https://YOUR-RESOURCE.cognitiveservices.azure.com/openai/v1",
  apiKey: process.env.AZURE_API_KEY,
  apiMode: "chat",
  modelOptions: {
    "gpt-5.3-codex": {
      apiMode: "responses",
    },
    "Kimi-K2.5": {
      apiMode: "responses",
    },
  },
})
```

This pattern is useful when a provider points to a single v1 base root but individual models must use different operations.

## Environment variables

- `AZURE_FOUNDRY_ENDPOINT`: fallback for `options.endpoint`
- `AZURE_API_KEY`: fallback for `options.apiKey`

## Troubleshooting

### Identifying Operation Mismatches

If you see an error like `The chatCompletion operation does not work with the specified model`, it means the model you've deployed doesn't support the standard chat endpoint.

- **Fix:** Either update your `endpoint` to a `/responses` path or set `modelOptions[modelId].apiMode = "responses"`.
- **Note:** The provider includes an automatic fallback for this error, but explicit configuration is always preferred for latency optimization.

### Dealing with `400 Bad Request` and `reasoning_content`

Some strict Azure Foundry endpoints (notably Mistral-based ones) reject assistant messages that contain `reasoning_content` or `reasoning` fields in their history.

- **Symptom:** You receive an `extra_forbidden` validation error.
- **Fix:** Use `assistantReasoningSanitization: "auto"` (default) or set it to `"always"` for that specific model in `modelOptions` to skip the failing round-trip.

### Rate Limits and 429 Errors

The provider handles `429` errors automatically via retries and adaptive throttling.

- **If you are still hitting limits:** Check your `rpm` and `tpm` settings in the `quota` block.
- **Adaptive Throttling:** Ensure `quota.adaptive.enabled` is `true` (default) to allow the provider to react to Azure's ratelimit headers before a failure occurs.

### common Errors Reference

- **`Unsupported Azure hostname`**: Ensure your host matches `*.services.ai.azure.com`, `*.cognitiveservices.azure.com`, or `*.openai.azure.com`.
- **`Unsupported endpoint path`**: Path must end with `/chat/completions`, `/responses`, `/models/chat/completions`, or a supported `/openai/v1` variant.
- **`Missing required api-version`**: Add `?api-version=...` to your Foundry URL if using `/models/chat/completions`.
- **`Endpoint path /openai/v1 requires apiMode`**: When using the base v1 root, you must explicitly set `apiMode` globally or per-model.
- **`content_filter` / `ResponsibleAIPolicyViolation`**: This is Azure's content policy, not a transport error. Adjust the prompt and retry.

## Operational notes

- Query parameters are preserved as provided in the endpoint URL.
- Chat and responses requests route deterministically from endpoint parsing + `apiMode` override.
- Retry/backoff is active even if you do not configure static quota limits.
- Adaptive throttling is enabled by default and uses Azure ratelimit headers when available.

## Exports

- `createAzureFoundryProvider`
- `azureFoundryProvider` (default instance with environment-based settings)
- `parseEndpoint`
- Types:
  - `AzureFoundryOptions`
  - `AzureFoundryProvider`
  - `ApiMode`, `HostType`, `PathType`, `ParsedEndpoint`
  - `ToolPolicy`
  - `QuotaOptions`, `QuotaRule`, `QuotaRetryOptions`, `QuotaAdaptiveOptions`
  - `AssistantReasoningSanitizationPolicy`, `ModelRequestOptions`, `RequestPolicyOptions`

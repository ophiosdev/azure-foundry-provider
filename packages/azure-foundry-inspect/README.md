# Azure Foundry Inspect

`azure-foundry-inspect` is a small read-only utility to inspect one Azure Cognitive Services / Azure Foundry account and print JSON for:

- account resource metadata
- deployments

It is intentionally standalone and not wired into the root package scripts.

## HTML output

Use `--format html` to render a standalone HTML report instead of JSON.

Example:

```bash
bun run inspect -- --resource-id "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>" --format html > report.html
```

The generated page is self-contained and works well as a local inspection report.

You can combine it with `--only-ratelimits` if you want a smaller report focused on throttling data.

## Rate-limits-only mode

If you only care about request/token throttling for deployed models, use `--only-ratelimits`.

This keeps the top-level `resource` object, but reduces each deployment entry to just:

- `name`
- `id`
- `model`
- `limits` (only when Azure reports token-limit hints)
- `rateLimits`

Example:

```bash
bun run inspect -- --subscription "<sub>" --resource-group "<rg>" --account "<account>" --only-ratelimits
```

Sample output:

```json
{
  "resource": {
    "subscriptionId": "a27f8c37-847b-4c1d-8152-630455cfaae1",
    "resourceGroup": "rg-aifoundry",
    "accountName": "ais5434653589451882810",
    "accountId": "/subscriptions/a27f8c37-847b-4c1d-8152-630455cfaae1/resourceGroups/rg-aifoundry/providers/Microsoft.CognitiveServices/accounts/ais5434653589451882810"
  },
  "deployments": [
    {
      "name": "FW-GLM-5",
      "id": "/subscriptions/a27f8c37-847b-4c1d-8152-630455cfaae1/resourceGroups/rg-aifoundry/providers/Microsoft.CognitiveServices/accounts/ais5434653589451882810/deployments/FW-GLM-5",
      "model": {
        "format": "Fireworks",
        "name": "FW-GLM-5",
        "version": "1"
      },
      "limits": {
        "maxContextTokens": 128000,
        "maxOutputTokens": 16384
      },
      "rateLimits": [
        { "key": "request", "renewalPeriod": 60, "count": 25 },
        { "key": "token", "renewalPeriod": 60, "count": 25000 }
      ]
    }
  ]
}
```

Use this mode when you want a smaller JSON payload for quota/throttling inspection or when you plan to feed only the rate-limit data into another tool.

If Azure doesn't report token-limit hints for a deployment, the `limits` object is omitted.

## Interpreting deployment output

The tool is intentionally deployment-centric. The most important values come from the deployment resource itself, because those values describe how the model is actually configured in the inspected account.

### Top-level structure

The JSON output contains:

- `resource`: metadata about the parent Cognitive Services / Foundry account
- `deployments`: one object per deployment under that account

In practice, the `deployments` array is the main thing you usually care about when configuring clients or debugging throughput.

### Per-deployment fields

Each deployment entry can contain:

- `name`
- `id`
- `model.format`
- `model.name`
- `model.version`
- `limits.maxContextTokens`
- `limits.maxOutputTokens`
- `capabilities`
- `deployment.sku`
- `deployment.currentCapacity`
- `deployment.rateLimits`
- `deployment.provisioningState`
- `deployment.deploymentState`
- `deployment.raiPolicyName`

### `name` and `id`

- `name` is the deployment name inside the Azure resource, for example `FW-GLM-5`
- `id` is the full Azure Resource Manager resource ID for that deployment

Use `name` when matching what you see in Azure Foundry or when relating the output to deployment-specific configuration and troubleshooting.

### `model.format`, `model.name`, `model.version`

These identify the backing model Azure attached to the deployment.

- `format` tells you the model family/provider classification, for example `OpenAI` or `Fireworks`
- `name` is the deployed model name as Azure reports it
- `version` is the deployed model version

This is useful because the deployment name and the underlying model identity are not always the same thing.

### `limits.maxContextTokens` and `limits.maxOutputTokens`

These fields are optional token-limit hints derived from Azure-reported deployment capabilities.

Important:

- they only appear when Azure actually reports usable token-limit values for that deployment
- the tool does not guess these values from model documentation tables
- if Azure doesn't include the relevant capability keys, the `limits` object is omitted

You can think of them as capability-derived hints rather than guaranteed universal deployment fields.

Typical meanings:

- `limits.maxContextTokens` is the reported maximum context or input window hint
- `limits.maxOutputTokens` is the reported maximum output/completion window hint

### `limits` versus `rateLimits`

These two sections answer different questions:

- `limits` tells you how large a single request or response can be, when Azure reports that information
- `rateLimits` tells you how much throughput Azure allows over time, such as requests per minute or tokens per minute

In other words:

- `limits` is about per-request size ceilings
- `rateLimits` is about throughput throttling over time

### `deployment.sku`

This describes the deployment SKU as Azure reports it.

Common things to watch:

- `deployment.sku.name` often tells you the deployment class, such as `Standard`, `DataZoneStandard`, or another SKU name
- `deployment.sku.capacity` is the provisioned capacity value assigned to the deployment

Microsoft documents `sku.capacity` as the deployment capacity / quota assignment field for `Microsoft.CognitiveServices/accounts/deployments` resources.

Important:

- for Azure OpenAI quota-managed deployments, capacity is often expressed in units that map to TPM
- Microsoft explicitly warns that RPM-to-TPM ratios vary by model and deployment class
- so treat `sku.capacity` as the configured capacity unit, not as a universal throughput formula by itself

### `deployment.currentCapacity`

This is the current capacity Azure reports for the deployment.

In many cases, this will match `deployment.sku.capacity`, but it is still worth surfacing separately because it is reported independently by Azure and represents the current effective deployment capacity state.

### `deployment.rateLimits`

This is usually the most directly useful section when you want to understand throttling behavior.

Azure reports an array of rate-limit entries such as:

```json
[
  { "key": "request", "renewalPeriod": 60, "count": 25 },
  { "key": "token", "renewalPeriod": 60, "count": 25000 }
]
```

Interpretation:

- `key: "request"` means request-rate limit information
- `key: "token"` means token-rate limit information
- `count` is the allowed amount in the stated renewal window
- `renewalPeriod` is the reset period, typically in seconds

For example:

- `request` + `count: 25` + `renewalPeriod: 60` means about 25 requests per 60 seconds
- `token` + `count: 25000` + `renewalPeriod: 60` means about 25,000 tokens per 60 seconds

Important Microsoft nuance:

- TPM is enforced from Azure's estimated processed-token count at request admission time
- that estimate is not the same thing as billing token usage
- rate limiting may therefore occur earlier than a naive exact-token expectation suggests
- RPM may also be enforced over shorter evaluation windows than a full minute, such as 1-second or 10-second sub-intervals

So when you interpret `rateLimits`, think of them as operational throttling limits, not as billing data.

### `deployment.provisioningState`

This is the Azure resource provisioning state, such as `Succeeded` or `Updating`.

Use it to answer questions like:

- was the deployment creation/update completed successfully?
- is Azure still processing a deployment change?

If this is not `Succeeded`, be careful about assuming the deployment is fully ready.

### `deployment.deploymentState`

This is the traffic-handling state of the deployment.

Microsoft’s resource documentation describes values such as:

- `Running` — the deployment is accepting inference requests
- `Paused` — the deployment is paused and not actively serving requests

This is different from `provisioningState`:

- `provisioningState` is about Azure resource lifecycle/update state
- `deploymentState` is about whether the deployment is functionally serving traffic

### `deployment.raiPolicyName`

This is the Responsible AI policy name attached to the deployment.

You usually do not need this for throughput tuning, but it is important for governance, policy comparisons, and explaining differences between otherwise similar deployments.

### `capabilities`

`capabilities` is an Azure-provided bag of capability flags and metadata. It can vary by model family, provider, API version, and deployment type.

Examples include things like:

- whether chat completion is supported
- auxiliary flags such as `agentsV2`
- provider/model-specific fields
- model limits or hints in some deployment types, such as context or output-token related values

Interpret these fields as descriptive metadata, not as a guaranteed stable cross-model schema.

### Example interpretation

Given a deployment like:

```json
{
  "name": "FW-GLM-5",
  "model": {
    "format": "Fireworks",
    "name": "FW-GLM-5",
    "version": "1"
  },
  "deployment": {
    "sku": {
      "name": "DataZoneStandard",
      "capacity": 25
    },
    "currentCapacity": 25,
    "rateLimits": [
      { "key": "request", "renewalPeriod": 60, "count": 25 },
      { "key": "token", "renewalPeriod": 60, "count": 25000 }
    ],
    "provisioningState": "Succeeded",
    "deploymentState": "Running",
    "raiPolicyName": "Microsoft.Default"
  }
}
```

you can read it as:

- this account has a deployment named `FW-GLM-5`
- it is backed by Fireworks model `FW-GLM-5` version `1`
- Azure shows a `DataZoneStandard` deployment SKU with capacity `25`
- the deployment currently has capacity `25`
- the deployment is active and serving traffic (`Running`)
- Azure resource provisioning completed successfully (`Succeeded`)
- request throttling is about 25 requests per minute-sized window
- token throttling is about 25,000 tokens per minute-sized window

### What these values are not

Some common interpretation mistakes:

- `TPM` is not the same as the model's maximum input token context window
- `RPM` is not guaranteed to be enforced only as a smooth full-minute average
- `rateLimits` are not billing metrics
- `sku.capacity` is not a universal cross-model formula without considering model/deployment class
- `capabilities` fields should not be assumed to be identical across providers or model families

## Microsoft documentation for interpreting deployment fields

The following sources are the most useful references for understanding the values that appear in deployment output:

- Azure OpenAI quota management and rate-limit interpretation:
  `https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/quota`
- Azure OpenAI quotas and limits reference:
  `https://learn.microsoft.com/en-us/azure/ai-foundry/openai/quotas-limits`
- Working with models and deployment upgrade behavior:
  `https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/working-with-models`
- ARM/Bicep/Terraform resource schema for `Microsoft.CognitiveServices/accounts/deployments`:
  `https://learn.microsoft.com/en-us/azure/templates/microsoft.cognitiveservices/accounts/deployments`

## Additional notes on documentation quality

Microsoft documentation is strongest on:

- quota/TPM/RPM concepts
- deployment resource schema
- deployment update and version-upgrade settings

It is thinner on:

- exact semantics of every provider-specific capability flag
- partner-model-specific operational nuances
- how every preview/runtime surface maps to what the portal currently renders

For those cases, the safest approach is:

- treat the deployment resource as the primary source of truth
- compare with Azure Foundry portal output for the same deployment
- avoid assuming undocumented capability keys are stable contracts

## Authentication to Azure

`azure-foundry-inspect` authenticates against the Azure management plane through the Azure SDK. It does not use Azure OpenAI API keys or inference endpoints for authentication.

The package constructs `CognitiveServicesManagementClient` with `DefaultAzureCredential`:

```ts
import { CognitiveServicesManagementClient } from "@azure/arm-cognitiveservices"
import { DefaultAzureCredential } from "@azure/identity"

const client = new CognitiveServicesManagementClient(new DefaultAzureCredential(), subscriptionId)
```

That means authentication follows the Azure Identity credential chain rather than any custom auth logic in this repository.

### What `DefaultAzureCredential` tries

According to Microsoft, `DefaultAzureCredential` is a chained credential. In Node.js, it can try several credential sources in order, including:

- environment-based service principal credentials
- workload identity
- managed identity
- Visual Studio Code credential support
- Azure CLI login
- Azure PowerShell login
- Azure Developer CLI login

This is convenient for local development, but Microsoft also notes that it can be less deterministic in production than using a specific credential directly.

### Recommended authentication modes

For this tool, the most practical options are:

- `Azure CLI` for local/manual use
- `service principal via environment variables` for CI or automation
- `managed identity` when the tool runs on Azure-hosted infrastructure

## Local development with Azure CLI

This is the easiest setup for ad hoc usage.

1. Install the Azure CLI.
2. Sign in:

   ```bash
   az login
   ```

3. If you have multiple subscriptions, select the one you want the tool to use:

   ```bash
   az account set --subscription "<subscription-id-or-name>"
   ```

4. Run the tool:

   ```bash
   bun run inspect -- --resource-id "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>"
   ```

### When Azure CLI auth is a good fit

- interactive local troubleshooting
- one-off inspection runs
- portal/CLI-driven developer workflows

### What can go wrong

- `az login` authenticated the wrong tenant or subscription
- your signed-in user lacks RBAC permissions on the target account
- `DefaultAzureCredential` finds a different credential earlier in the chain than you expected

If behavior looks surprising, Microsoft recommends enabling Azure SDK logging.

## Service principal via environment variables

This is the most straightforward non-interactive setup for CI, automation, or isolated local testing.

Set these environment variables:

```bash
export AZURE_CLIENT_ID="<client-id>"
export AZURE_TENANT_ID="<tenant-id>"
export AZURE_CLIENT_SECRET="<client-secret>"
```

Then run the tool normally:

```bash
bun run inspect -- --subscription "<sub>" --resource-group "<rg>" --account "<account>"
```

### Notes

- this uses the Azure Identity `EnvironmentCredential` path inside `DefaultAzureCredential`
- the service principal must have RBAC permission to read the target Cognitive Services account and related metadata
- do not commit secrets to source control

### Example `.env` workflow

If you prefer a local `.env` file for development:

```bash
AZURE_CLIENT_ID=<client-id>
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_SECRET=<client-secret>
```

Then load it with your preferred shell/tooling before running the command.

## Managed identity on Azure-hosted infrastructure

If you run the tool on an Azure VM, App Service, Container App, Function, or another Azure host with managed identity enabled, `DefaultAzureCredential` can authenticate through that identity.

This is the preferred production-style authentication model because it avoids stored secrets.

### System-assigned managed identity

If the host has a system-assigned managed identity and that identity has the required permissions, no extra credential environment variables are required.

### User-assigned managed identity

For user-assigned managed identity, Azure guidance often recommends being explicit. In practice, that usually means supplying the identity client ID:

```bash
export AZURE_CLIENT_ID="<user-assigned-managed-identity-client-id>"
```

Then run the tool normally.

### Important production caveat

Microsoft recommends using a deterministic credential such as `ManagedIdentityCredential` directly in production services when you need strict predictability. This tool currently uses `DefaultAzureCredential` because it is designed as a flexible operator/developer utility.

## Restricting the credential chain

Microsoft documents the `AZURE_TOKEN_CREDENTIALS` environment variable as a way to narrow which credentials `DefaultAzureCredential` will consider.

Examples:

```bash
export AZURE_TOKEN_CREDENTIALS="dev"
```

This keeps the chain focused on developer credentials.

```bash
export AZURE_TOKEN_CREDENTIALS="prod"
```

This keeps the chain focused on deployed-service credentials.

You can also target a specific credential name, for example:

```bash
export AZURE_TOKEN_CREDENTIALS="AzureCliCredential"
```

or:

```bash
export AZURE_TOKEN_CREDENTIALS="ManagedIdentityCredential"
```

This can be very helpful when troubleshooting which credential path is actually being used.

## Permissions and RBAC

Authentication alone is not enough. The authenticated principal must also have permission to read the resource metadata queried by the tool.

At minimum, the identity should be able to read:

- the Cognitive Services account
- deployments under that account

If authentication succeeds but the tool still fails, RBAC is one of the first things to verify.

## Troubleshooting authentication

Common failure modes:

- not logged in with `az login`
- wrong subscription selected in Azure CLI
- service principal environment variables missing or mismatched
- managed identity enabled, but lacking RBAC rights
- `DefaultAzureCredential` selecting an unexpected credential earlier in the chain

### Enable Azure SDK logs

The Cognitive Services management SDK documentation points to Azure SDK logging for troubleshooting. You can enable logs like this:

```bash
export AZURE_LOG_LEVEL="info"
```

Then rerun the tool.

For deeper credential-chain debugging, Microsoft also documents verbose Azure Identity logging.

## Microsoft documentation

The following Microsoft references are especially relevant to this tool's authentication model:

- Azure Cognitive Services management SDK for JavaScript:
  `https://learn.microsoft.com/en-us/javascript/api/overview/azure/arm-cognitiveservices-readme?view=azure-node-latest`
- Credential chains in the Azure Identity library for JavaScript:
  `https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/credential-chains`
- Azure Identity authentication best practices for JavaScript:
  `https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/best-practices`
- Local development with developer accounts:
  `https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/local-development-environment-developer-account`
- Local development with service principals:
  `https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/local-development-environment-service-principal`
- System-assigned managed identity guidance:
  `https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/system-assigned-managed-identity`
- User-assigned managed identity guidance:
  `https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/user-assigned-managed-identity`

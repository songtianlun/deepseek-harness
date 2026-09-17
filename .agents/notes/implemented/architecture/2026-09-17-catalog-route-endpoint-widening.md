# Agent Note: Widening a catalog route's models from its own endpoint

Status: implemented

English | [中文](2026-09-17-catalog-route-endpoint-widening.zh.md)
## Problem

Model discovery answered a route the installed catalog ships from that catalog alone. The catalog is generated when pi-ai is published, while a provider keeps adding models to a route that already exists, so the Models page offered fewer models than the route could serve and offered no way to find the rest. A user could not adopt what discovery did not report either: a profile's `models` list replaces the route's catalog wholesale, so adding one model means restating every other one and its capacities by hand.

The gap is not hypothetical. pi-ai 0.85.1 ships 27 models for `opencode-go`; `GET https://opencode.ai/zen/go/v1/models` listed 38 on 2026-09-17, missing `minimax-m2.5`, `kimi-k2.5`, `glm-5`, `deepseek-flash`, `deepseek-v4.1-flash`, `qwen3.5-plus`, `mimo-v2-pro`, `mimo-v2-omni`, `union-alpha`, `hy3-preview`, and `grok-4.5`. The same endpoint listed 39 an hour earlier, so no snapshot of it can be current either.

## Decision

A route the installed catalog ships is answered from that catalog and then widened by the endpoint the route resolves. The catalog keeps every id it describes, because its entries carry context windows and output caps a listing endpoint does not disclose, and the endpoint contributes the ids it serves that the catalog has not caught up with, in endpoint order.

The widening is best-effort: a credential that does not resolve, an endpoint that refuses or cannot be reached, a reply that is not a model listing, a protocol whose listing this build cannot read, or a route with no single endpoint leaves the catalog answer standing, because that answer is already complete. Caller cancellation is not one of those faults and still fails the operation.

### Where the listing endpoint comes from

A request naming a route may omit the endpoint and protocol, as the curated Models page does when it sends a draft of a stored profile; the Host supplies them from the route, beside the stored credential and deployment headers it already supplied. [`modelEndpoints`](../../../../packages/llm/llm-pi-ai/src/catalog.ts) reports the endpoint each wire protocol serves that route's models from — the endpoint is per protocol because a route pi-ai stores per model, such as `opencode-go`, has no single one — and the protocol asked is the one the profile states, else the first of [`LISTING_PROTOCOLS`](../../../../packages/llm/llm-pi-ai/src/discovery.ts) the route speaks. A protocol whose models name different endpoints, such as Bedrock's regional ones, is absent from that map, and a route with none is left at the catalog answer.

## Alternatives considered

**Ask the pi-ai provider-level endpoint inside discovery.** Many providers declare a `baseUrl` on the provider itself, so the adapter could resolve the question without any Host input and keep the endpoint out of the discovery request. It loses because the routes that most need widening have no such endpoint: `opencode-go` and `opencode` store the address on every model, and a directory entry with no profile has nothing else to resolve.

**Widen every catalog route, configured or not.** This is simpler to state and would refresh a provider on the same look that adds it. It loses because a route with no profile has no credential to offer, so the action would send unauthenticated requests to every installed provider's endpoint and report the resulting refusals as providers that serve nothing.

**Ship the missing models here, or upgrade pi-ai.** Either would have fixed the list observed today, without a network call. It loses because 0.85.1 is the newest release and its catalog still lagged the endpoint, and a hand-maintained overlay duplicates pi-ai's job while going stale on pi-ai's own schedule.

**Answer from the endpoint instead of from the catalog.** The provider is the authority on what it serves right now, and its answer would never be stale. It loses twice: a listing is often scoped to the account, so an entitled subset would hide models the route can serve, and a listing discloses no capacities, so every adopted row would need them entered by hand.

**Change `models` to extend the catalog instead of replacing it.** This is the other half of the difficulty above. It loses because the replacement semantics are documented, tested, and how a route is narrowed, and because it still leaves the user to know every new id by hand — discovering the ids is the step that is missing.

## Consequences

The Models page can now refresh a configured catalog route from the provider that serves it: newly released models arrive as candidates, and adopting one writes the profile's explicit `models` list, which replaces the catalog from then on. What it costs is that the action performs a network request where it previously performed none, and that a widening failing is reported as nothing at all, because the reply carries candidates rather than a warning. Capacities the endpoint does not disclose still fall to the route's `defaultContextWindow` and `defaultMaxTokens`, so an adopted model newer than the catalog usually wants its real numbers filled in.

## Testing

`packages/llm/llm-pi-ai/tests/discovery.spec.ts` covers the widened answer, the catalog answer surviving a broken endpoint, an unreadable protocol, an unresolvable credential, and cancellation still failing the operation, and replays the reply `opencode-go` published on 2026-09-17 to show the models pi-ai 0.85.1 lacks arriving as candidates. `packages/llm/llm-pi-ai/tests/catalog.spec.ts` covers the endpoint each protocol resolves, including a protocol whose models disagree. `packages/llm/llm-pi-ai/tests/loader-composition.spec.ts` boots the real Loader composition and proves a catalog route repointed in settings is widened through the Host-supplied endpoint with its stored credential.

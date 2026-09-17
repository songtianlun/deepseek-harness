/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * A route the installed pi-ai catalog ships is answered from that catalog
 * first: pi-ai's registry carries the capacities a listing endpoint does not
 * disclose. Its answer is then widened by the route's own endpoint, because
 * the catalog is a snapshot taken when pi-ai was published and the provider
 * keeps releasing models into a route that already exists. An endpoint fault
 * of any kind leaves the catalog answer standing, since that answer is
 * already complete on its own.
 *
 * Only a route the catalog does not describe — a gateway, a self-hosted
 * server — depends on the interrogation for its answer.
 *
 * Neither path is a catalog refresh. Nothing here is stored: the request
 * carries a draft the user is still editing, and the reply is candidate
 * metadata the surface offers for adoption. `settings.yaml` remains the only
 * thing that decides what a route serves.
 *
 * OpenAI-compatible and Anthropic Messages protocols are interrogated through
 * their native model-listing endpoints. The parser accepts the standard
 * `data` array and the enriched `models` map some compatible gateways expose.
 * Every other protocol reports that it cannot be interrogated so the surface
 * falls back to hand-entry rather than guessing its response fields.
 *
 * @module dsh-llm-pi-ai/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryOperation } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { catalogModels } from './catalog.ts'

/**
 * Protocols whose model listing this module can read, most preferred first.
 * OpenAI protocols use bearer auth at `GET {baseURL}/models`; Anthropic
 * Messages uses `x-api-key` and `anthropic-version` at its native
 * `GET /v1/models`. Azure is absent despite its OpenAI lineage — it
 * authenticates with an `api-key` header and requires an `api-version` query —
 * and Codex authenticates through OAuth; guessing at either would report an
 * authentication failure as a provider with no models. pi-ai's remaining
 * protocols are absent for the same reason.
 *
 * The order is also the preference for asking a catalog route's own endpoint.
 * A route whose models speak several protocols is asked through the one whose
 * listing path is the most widely published — `openai-completions` and
 * `openai-responses` share `GET {baseURL}/models` — rather than through
 * whichever protocol the catalog happens to list first, so a mixed route is
 * not interrogated through a contract its gateway may not implement.
 */
export const LISTING_PROTOCOLS: readonly string[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]

/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Largest model-list page accepted by Anthropic's public endpoint; discovery reads one page and does not follow `has_more`. */
const ANTHROPIC_MODEL_LIMIT = 1000

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Capacity fields nested by enriched model-directory replies. */
interface ListingLimit {
  context?: unknown
  output?: unknown
}

/** Per-route capacities OpenRouter nests under each entry. */
interface ListingTopProvider {
  max_completion_tokens?: unknown
}

/** One entry of a supported `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  maxOutputTokens?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  maxTokens?: unknown
  limit?: ListingLimit | null
  top_provider?: ListingTopProvider | null
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Join the endpoint base with the protocol's listing path. The base is
 * treated as a prefix rather than a URL to resolve against, so a deployment
 * path such as `https://gateway.example/openai/v1` keeps its segments instead
 * of losing them to `URL` resolution. OpenAI protocols list at
 * `{baseURL}/models`. Anthropic lists at `{root}/v1/models`, where the root is
 * the base without trailing slashes and without one trailing `/v1` segment:
 * gateway documentation publishes both spellings of the same root. Only this
 * listing URL normalizes that segment; model requests receive the configured
 * `baseURL` unchanged.
 */
function listingUrl(baseURL: string, api: string): string {
  const base = baseURL.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one supported model-listing reply. The standard `data` array takes
 * precedence when both supported formats are present. An enriched `models`
 * map uses each property key as the endpoint-facing id; its nested `id` is
 * only a fallback for an empty key because gateways may put a canonical model
 * identity there instead of the alias they accept on requests. Only
 * object-valued map entries are models; primitive properties are ignored
 * because they may be directory metadata rather than model records.
 *
 * Entries without a usable id are skipped rather than failing the whole
 * interrogation: a single malformed row should not deny the user the rest of
 * a working endpoint's catalog. Missing names fall back to the adopted id so
 * the Web form receives a complete human-readable row.
 */
function readListing(body: unknown): LlmDiscoveredModel[] {
  const listing = body as { data?: unknown; models?: unknown } | null
  const data = listing?.data
  let listed: { readonly key?: string; readonly raw: unknown }[]
  if (Array.isArray(data)) {
    const rows = data as readonly unknown[]
    listed = rows.map(raw => ({ raw }))
  } else {
    const models = listing?.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new LlmError(
        'the endpoint\'s model listing has neither a "data" array nor a "models" object; '
        + 'enter this provider\'s models by hand',
        'DISCOVERY_FAILED',
      )
    }
    listed = Object.entries(models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  }
  const models: LlmDiscoveredModel[] = []
  for (const { key, raw } of listed) {
    const entry = raw as ListingEntry | null
    const id = label(key, entry?.id)
    if (id === undefined) continue
    const name = label(entry?.name, entry?.display_name, entry?.displayName) ?? id
    const contextWindow = capacity(
      entry?.contextWindow,
      entry?.context_window,
      entry?.context_length,
      entry?.max_input_tokens,
      entry?.limit?.context,
    )
    const maxTokens = capacity(
      entry?.maxOutputTokens,
      entry?.max_output_tokens,
      entry?.maxTokens,
      entry?.max_tokens,
      entry?.limit?.output,
      entry?.top_provider?.max_completion_tokens,
    )
    models.push({
      id,
      name,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/** Host-owned profile inputs that a configuration draft deliberately omits. */
export interface StoredModelDiscoveryProfile {
  /** Deployment headers configured on the named route. */
  readonly headers: Readonly<Record<string, string>> | undefined
  /**
   * Endpoint the named route resolves when the draft names none — its own
   * `baseURL`, or else the endpoint the installed catalog serves its models
   * from. Absent for a route with no endpoint to resolve.
   */
  readonly baseURL: string | undefined
  /** Wire protocol that endpoint publishes its listing under, when the route resolves one. */
  readonly api: string | undefined
  /** Resolve the named route's credential only when the draft carries none. */
  readonly resolveApiKey: () => Promise<string | undefined>
}

/**
 * Interrogate one provider endpoint for the models it advertises.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @param storedProfile - Host-owned endpoint, headers, and lazy credential
 *   resolution for the named route. Its credential resolver is read only on
 *   the path that reaches the network, and only when the draft carries none.
 * @returns the advertised models in endpoint order.
 * @throws LlmError when a route the catalog does not describe has no readable
 *   listing, the endpoint refuses or fails the request, or the reply is not a
 *   model listing. None of these can fail a route the catalog describes.
 */
export async function discoverModels(
  request: LlmModelDiscoveryOperation,
  storedProfile?: () => StoredModelDiscoveryProfile | undefined,
): Promise<readonly LlmDiscoveredModel[]> {
  const stored = storedProfile?.()
  // What the draft states wins over what the named route resolves: a form whose
  // endpoint was edited but not yet saved must interrogate the edited one.
  const baseURL = request.baseURL ?? stored?.baseURL
  // The named route's own protocol, when the Host resolves one, describes the
  // endpoint it resolved. What is left is a request naming no protocol at all,
  // which is asked as OpenAI Chat Completions: it is the shape a gateway is
  // overwhelmingly likely to speak, and the alternative — refusing until the
  // field is filled — would withhold the action from the case it exists for.
  // The cost is a misdirected message when the endpoint speaks something else
  // (an Anthropic gateway answers 401, which reads as a credential problem),
  // and hand-entry remains the way out.
  const api = request.api ?? stored?.api ?? 'openai-completions'
  // A catalog route already has its answer, and a better one: the installed
  // entries carry context windows and output caps no listing endpoint reports.
  const installed = request.provider === undefined ? undefined : catalogModels(request.provider)
  if (installed !== undefined && installed.size > 0) {
    const answer = [...installed.values()].map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }))
    // The installed catalog is a snapshot taken when pi-ai was published, so a
    // route that resolves an endpoint this build can read is asked as well,
    // and its answer widens the snapshot with whatever the provider added
    // since. Every way that can fail leaves the snapshot standing: it is a
    // complete answer about this route, and the endpoint is the enrichment.
    if (baseURL === undefined || baseURL.length === 0 || !LISTING_PROTOCOLS.includes(api)) return answer
    try {
      return widened(answer, await interrogate(baseURL, api, request, stored))
    } catch (error: unknown) {
      // Cancellation is the caller's own decision about this operation, not a
      // fault of the endpoint, and must not be reported as a catalog answer.
      if (request.signal?.aborted) throw error
      return answer
    }
  }
  if (baseURL === undefined || baseURL.length === 0) {
    throw new LlmError(
      `pi-ai ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
      + " endpoint; set a baseURL, or enter this provider's models by hand",
      'DISCOVERY_FAILED',
    )
  }
  if (!LISTING_PROTOCOLS.includes(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  return interrogate(baseURL, api, request, stored)
}

/**
 * The catalog answer widened by the endpoint's own listing. The catalog keeps
 * every id it describes — it is the richer metadata — and the endpoint
 * contributes the ids it serves that the catalog has not caught up with, in
 * endpoint order.
 * @param answer - the installed catalog's models.
 * @param listed - the endpoint's own listing.
 * @returns the two lists merged by id, catalog entries first.
 */
function widened(
  answer: readonly LlmDiscoveredModel[],
  listed: readonly LlmDiscoveredModel[],
): LlmDiscoveredModel[] {
  const seen = new Set(answer.map(model => model.id))
  const models = [...answer]
  for (const model of listed) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/**
 * Read one endpoint's model listing.
 * @param baseURL - endpoint the listing is published from.
 * @param api - wire protocol the endpoint speaks.
 * @param request - the draft, for its one-shot credential and cancellation.
 * @param stored - the named route's headers and credential, when one is named.
 * @returns the listing's models in endpoint order.
 * @throws LlmError naming the endpoint when it cannot be reached, refuses the
 *   request, or answers with something other than a model listing.
 */
async function interrogate(
  baseURL: string,
  api: string,
  request: LlmModelDiscoveryOperation,
  stored: StoredModelDiscoveryProfile | undefined,
): Promise<LlmDiscoveredModel[]> {
  const url = listingUrl(baseURL, api)
  // A key typed into the form wins: it may replace the stored key that is
  // failing. The resolver stays lazy so a typed key cannot fail over a stored
  // credential it supersedes. A route may still authenticate through a
  // deployment-owned Authorization header when neither key exists.
  const supplied = request.apiKey ?? await stored?.resolveApiKey()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  let response: Response
  try {
    const headers = new Headers(stored?.headers === undefined ? undefined : Object.entries(stored.headers))
    headers.set('accept', 'application/json')
    if (api === 'anthropic-messages') {
      headers.set('anthropic-version', ANTHROPIC_VERSION)
      if (apiKey !== undefined) headers.set('x-api-key', apiKey)
    } else if (apiKey !== undefined) {
      headers.set('authorization', `Bearer ${apiKey}`)
    }
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
    response = await fetch(url, {
      method: 'GET',
      headers,
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    // Cancellation during the body read rejects with the abort reason, which
    // may be any value; the caller gets the same coded failure it would have
    // for a cancellation before the request went out.
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body)
}

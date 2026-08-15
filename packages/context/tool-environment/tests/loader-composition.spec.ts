// Proves the environment allowlist is real configurability and not a constant:
// the allowlist is set in a cordis.yml booted through the real Loader, and the
// tool reports exactly the configured names, while a boot that omits the config
// falls back to the safe default allowlist.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolEnvironment from '@deepseek-ai/dsh-tool-environment'
import { DEFAULT_ENVIRONMENT_VARIABLES } from '@deepseek-ai/dsh-tool-environment'

let root: string | undefined
let context: Context | undefined

/** Marker env var the loader test sets to prove the allowlist is honored. */
const MARKER_ENV_VAR = 'DSH_ENV_TOOL_COMPOSITION_MARKER'

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the given tool-environment config block.
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-environment-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-environment'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-environment', ToolEnvironment],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

async function callEnvironmentInfo(ctx: Context): Promise<{ value: unknown; isError: boolean }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('loader-env'),
    name: 'environment_info',
    arguments: {},
  })
  return { value: result.value, isError: result.isError }
}

describe('tool-environment real Loader composition through cordis.yml', () => {
  it('reports exactly the configured allowlisted variable end to end', async () => {
    const original = process.env[MARKER_ENV_VAR]
    process.env[MARKER_ENV_VAR] = 'composed'
    try {
      const ctx = await boot(['    environmentVariables:', `      - ${MARKER_ENV_VAR}`])
      const { value, isError } = await callEnvironmentInfo(ctx)
      expect(isError).toBe(false)
      const env = (value as { environmentVariables: Record<string, string | null> }).environmentVariables
      expect(Object.keys(env)).toEqual([MARKER_ENV_VAR])
      expect(env[MARKER_ENV_VAR]).toBe('composed')
    } finally {
      if (original === undefined) delete process.env.DSH_ENV_TOOL_COMPOSITION_MARKER
      else process.env[MARKER_ENV_VAR] = original
    }
  }, 30_000)

  it('falls back to the safe default allowlist when config is omitted', async () => {
    const ctx = await boot()
    const { value, isError } = await callEnvironmentInfo(ctx)
    expect(isError).toBe(false)
    const env = (value as { environmentVariables: Record<string, string | null> }).environmentVariables
    expect(Object.keys(env).sort()).toEqual([...DEFAULT_ENVIRONMENT_VARIABLES].sort())
  }, 30_000)
})

import { describe, expect, it } from 'vitest'
import { homedir, hostname, release, type as osType, userInfo } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { type Agent } from '@deepseek-ai/dsh-agent'

import * as tool from '../src/index.ts'
import { DEFAULT_ENVIRONMENT_VARIABLES } from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** A parent Agent backed by a real Session — the tool reads `agent.session.header.cwd`. */
function agentWithSession(id = 'parent-1', cwd = '/abs/workspace'): Agent & { session: Session } {
  const session = Session.create(SessionId(id), undefined, {
    version: 0,
    id: SessionId(id),
    createdAt: 0,
    cwd,
  })
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(config?: tool.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, config)
  return ctx
}

let callCounter = 0
function callInfo(ctx: Context, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'environment_info',
    arguments: {},
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-tool-environment', () => {
  it('registers an `environment_info` tool with no parameters', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'environment_info')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toEqual([])
  })

  it('reports the runtime environment with the owning session cwd', async () => {
    const ctx = await setup()
    const cwd = '/abs/workspace'
    const result = await callInfo(ctx, { agent: agentWithSession('env-1', cwd) })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected environment_info success')
    expect(result.value).toMatchObject({
      cwd,
      platform: process.platform,
      os: osType(),
      osRelease: release(),
      architecture: process.arch,
      hostname: hostname(),
      username: userInfo().username,
      homeDirectory: homedir(),
      shell: process.env.SHELL ?? '',
      nodeVersion: process.version,
    })
  })

  it('falls back to process.cwd() when the caller has no owning session', async () => {
    const ctx = await setup()
    const result = await callInfo(ctx, { agent: undefined })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected environment_info success')
    expect((result.value as { cwd: string }).cwd).toBe(process.cwd())
  })

  it('reports an empty shell when SHELL is unset and renders the fallback', async () => {
    const originalShell = process.env.SHELL
    try {
      delete process.env.SHELL
      const ctx = await setup({ environmentVariables: [] })
      const result = await callInfo(ctx, { agent: undefined })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected environment_info success')
      expect((result.value as { shell: string }).shell).toBe('')
      expect(text(result)).toContain('shell: (unset)')
    } finally {
      if (originalShell === undefined) delete process.env.SHELL
      else process.env.SHELL = originalShell
    }
  })

  it('reports only the allowlisted environment variables, absent names as null', async () => {
    const ctx = await setup({ environmentVariables: ['LANG', 'SHOULD_NOT_EXIST_DEFINITELY'] })
    const result = await callInfo(ctx)
    expect(result.isError).toBe(false)
    const env = (result.value as { environmentVariables: Record<string, string | null> }).environmentVariables
    expect(Object.keys(env).sort()).toEqual(['LANG', 'SHOULD_NOT_EXIST_DEFINITELY'])
    expect(env.LANG).toBe(process.env.LANG ?? null)
    expect(env.SHOULD_NOT_EXIST_DEFINITELY).toBe(null)
  })

  it('defaults to the safe allowlist when config omits environmentVariables', async () => {
    const ctx = await setup()
    const result = await callInfo(ctx)
    expect(result.isError).toBe(false)
    const env = (result.value as { environmentVariables: Record<string, string | null> }).environmentVariables
    expect(Object.keys(env).sort()).toEqual([...DEFAULT_ENVIRONMENT_VARIABLES].sort())
  })

  it('returns an empty environment map when configured with an empty allowlist', async () => {
    const ctx = await setup({ environmentVariables: [] })
    const result = await callInfo(ctx)
    expect(result.isError).toBe(false)
    expect((result.value as { environmentVariables: Record<string, string | null> }).environmentVariables).toEqual({})
  })

  it('renders the environment as human-readable text', async () => {
    const ctx = await setup({ environmentVariables: [] })
    const result = await callInfo(ctx, { agent: undefined })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain(process.cwd())
  })

  it('presents the call as a generic inspect card', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('environment_info')!
    expect(def.presentCall?.({})).toEqual({ card: 'generic', title: 'Inspect environment', kind: 'search' })
  })

  it('presents a successful result as a generic environment card', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('environment_info')!
    const result = await callInfo(ctx, { agent: undefined })
    expect(result.isError).toBe(false)
    const view = def.presentResult?.({}, result)
    expect(view).toBeDefined()
    if (view?.card !== 'generic') throw new Error('expected generic presentResult view')
    const rendered = (view.content ?? []).filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered[0]?.text).toContain(process.cwd())
  })

  it('presents no result card for an errored result (generic fallback)', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('environment_info')!
    expect(def.presentResult?.({}, { content: [{ type: 'text', text: 'boom' }], isError: true })).toBeUndefined()
  })

  it('unregisters the tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(tool, { environmentVariables: [] })
    expect(ctx.tools.schemas().some(s => s.name === 'environment_info')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'environment_info')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-environment')
    expect(tool.inject).toEqual(['tools'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-environment')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})

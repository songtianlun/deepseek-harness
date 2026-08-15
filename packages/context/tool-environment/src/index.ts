/**
 * Model-facing `environment_info` tool. Reporting the runtime the agent runs in —
 * current working directory, operating system, platform, architecture, hostname,
 * username, home directory, shell, and Node.js version, plus a deployment-vetted
 * allowlist of environment variables. Call it before path or command decisions that
 * depend on where the agent is running or the host OS. Named exports preserve loader
 * injection metadata.
 * @module @deepseek-ai/dsh-tool-environment
 */

import { homedir, hostname, release, type as osType, userInfo } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-environment'
export const inject = ['tools']

/**
 * Environment variables a deployment consents to exposing to the model. Values are
 * reported exactly as present in the process environment; absent names are reported
 * as `null` so the model can tell "unset" from an empty string. A deployment that
 * wants none set this to `[]`; names naming secrets must be left out of this list.
 */
export interface Config {
  environmentVariables: string[]
}

/** Default safe allowlist: locale, identity, and harness-home hints, never secrets. */
export const DEFAULT_ENVIRONMENT_VARIABLES = ['LANG', 'SHELL', 'USER', 'DSH_AGENTS_HOME'] as const

/** Schemastery configuration for the environment-info tool consumer. */
export const Config: z<Config> = z.object({
  environmentVariables: z.array(z.string()).default([...DEFAULT_ENVIRONMENT_VARIABLES]),
})

/**
 * Resolve the working directory a relative path should be read against: the calling
 * agent's session `cwd` when one exists, else the host process working directory.
 * @param sessionCwd - the owning session's recorded working directory, if any.
 * @returns the absolute working directory for this call.
 */
function resolveCwd(sessionCwd: string | undefined): string {
  return sessionCwd ?? process.cwd()
}

/**
 * Register the `environment_info` tool on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the deployment's env-var allowlist.
 */
export function apply(ctx: Context, config: Config): void {
  const allowlist = new Set(config.environmentVariables.map(name => name.toUpperCase()))
  ctx.tools.register(defineTool({
    name: 'environment_info',
    description: 'Report the runtime environment the agent runs in: current working '
      + 'directory, operating system, platform, architecture, hostname, username, home '
      + 'directory, shell, Node.js version, and a small allowlist of environment '
      + 'variables. Call this before choosing paths or commands that depend on where the '
      + 'agent is running or on the host OS.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cwd: { type: 'string', required: true, description: 'Absolute working directory for relative paths.' },
          platform: { type: 'string', required: true, description: 'Node.js platform, e.g. darwin | linux | win32.' },
          os: { type: 'string', required: true, description: 'Operating system name, e.g. Darwin | Linux.' },
          osRelease: { type: 'string', required: true, description: 'Operating system release version.' },
          architecture: { type: 'string', required: true, description: 'CPU architecture, e.g. arm64 | x64.' },
          hostname: { type: 'string', required: true, description: 'Machine hostname.' },
          username: { type: 'string', required: true, description: 'Account running the agent.' },
          homeDirectory: { type: 'string', required: true, description: 'Home directory of that account.' },
          shell: { type: 'string', required: true, description: 'Default shell, or an empty string when unset.' },
          nodeVersion: { type: 'string', required: true, description: 'Node.js version, e.g. v22.23.1.' },
          environmentVariables: {
            type: 'object',
            additionalProperties: true,
            required: true,
            description: 'Allowlisted environment variable values; absent names are null.',
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Working directory: ${value.cwd}\n`
          + `${value.os} ${value.osRelease} (${value.platform}/${value.architecture})\n`
          + `user ${value.username}@${value.hostname}, home ${value.homeDirectory}\n`
          + `shell: ${value.shell || '(unset)'}, node ${value.nodeVersion}\n`
          + `environment: ${JSON.stringify(value.environmentVariables)}`,
      }],
    },
    execute(_args: Record<string, never>, exec) {
      const cwd = resolveCwd(exec.agent?.session.header.cwd)
      const { username } = userInfo()
      const env: Record<string, string | null> = {}
      for (const name of allowlist) env[name] = process.env[name] ?? null
      return Promise.resolve({
        cwd,
        platform: process.platform,
        os: osType(),
        osRelease: release(),
        architecture: process.arch,
        hostname: hostname(),
        username,
        homeDirectory: homedir(),
        shell: process.env.SHELL ?? '',
        nodeVersion: process.version,
        environmentVariables: env,
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect environment', kind: 'search' }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined
      return { card: 'generic', title: 'Environment', content: result.content }
    },
  }))
}

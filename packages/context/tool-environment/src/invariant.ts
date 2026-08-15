/** Package-owned invariant companion for the environment-info tool. @module @deepseek-ai/dsh-tool-environment/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-environment'

/** Cordis companion plugin name. */
export const name = 'tool-environment-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: this stateless tool writes no durable session events, so there is nothing to validate. */
const install: InvariantInstaller = () => {}

/**
 * Register the environment-info invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

# Agent Note: environment_info — a model-facing runtime report

Status: implemented

English | [中文](2026-08-15-tool-environment.zh.md)

## Problem

An agent that is grounded in a real host makes many path and command decisions on facts it cannot observe: the absolute working directory relative paths resolve against, the host OS and platform, the CPU architecture, and the identity (hostname, user, home directory, shell) of the account running it. The harness's filesystem tools resolve relative to a per-session `cwd`, and `context` plugins inject time and workspace-instruction context, but no model-facing tool reports the runtime environment itself. The model guessed or asked for these facts, or hard-coded host assumptions.

## Decision

Add `@deepseek-ai/dsh-tool-environment` (in the `context` group) registering one tool, `environment_info()` (no parameters), on `ctx.tools`. It returns a canonical snapshot: `cwd` (the owning agent session's header `cwd`, else `process.cwd()`), `platform`, `os`/`osRelease`/`architecture`, `hostname`, `username`, `homeDirectory`, `shell` (from `SHELL`, empty string when unset), `nodeVersion`, and an `environmentVariables` map limited to a Config allowlist.

Environment variables are a deliberate scope gate, not a free read: nothing is reported until a deployment names it in `Config.environmentVariables`, whose default is the safe allowlist `['LANG', 'SHELL', 'USER', 'DSH_AGENTS_HOME']`. Names match case-insensitively and are reported uppercase; a name absent from the process environment is `null` so the model can tell "unset" from an empty string. The tool writes no session events, so it ships a no-op invariant companion only to satisfy the package-companion convention.

The plugin is exposed in the `standard`, `code`, and `cordis` agent presets and in `apps/cli` dependencies; the generator boot manifest and the bilingual tool catalog were regenerated to document it. It registers on the existing `ctx.tools.register` extension point and changes no core architecture.

## Alternatives considered

**Read the whole `process.env`** — rejected. Environment variables routinely carry secrets; reporting them wholesale would leak credentials into every tool call and the session log. The Config allowlist makes exposure an explicit deployment decision.

**Report only path and OS facts, no environment variables** — partially adopted. The core snapshot keeps cwd/OS/platform/architecture/identity; a small allowlisted env map was retained because locale and harness-home hints (`LANG`, `DSH_AGENTS_HOME`) are genuinely useful and safe.

**Rely on the shell or filesystem tools to discover the environment** — rejected. `bash`/`pwsh` output is unstructured and host-shell-dependent; a purpose-built tool gives the model a single canonical, schema-typed report.

## Consequences

The model can now ground path and command decisions in the actual runtime, which removes a class of host-assumption mistakes and eliminates guess-the-`cwd` turnarounds. Because the env surface is allowlisted with a safe default, no new secret-exposure path exists; a deployment that wants none sets `[]`. The cost is one more tool in the model-facing schema (small, parameterless, fixed-shape, and prefix-stable for KV-cache reuse).

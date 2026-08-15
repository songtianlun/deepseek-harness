# @deepseek-ai/dsh-tool-environment

English | [中文](README.zh.md)

The model-facing `environment_info` tool: the agent's report on the runtime it runs in.

## What it does

Registers one tool, `environment_info()`, on `ctx.tools`. It takes no arguments and returns a canonical snapshot of the host the agent executes on:

- `cwd` — the absolute working directory relative paths resolve against: the calling agent's session `cwd` when one exists, else the host `process.cwd()`.
- `platform` / `os` / `osRelease` / `architecture` — host platform, OS name, OS release, and CPU architecture (e.g. `darwin` / `Darwin` / `23.6.0` / `arm64`).
- `hostname` / `username` / `homeDirectory` — machine and account identity.
- `shell` — the default shell from `SHELL`, or an empty string when unset.
- `nodeVersion` — the runtime version, e.g. `v22.23.1`.
- `environmentVariables` — a small allowlist of non-secret environment variable values; absent names are `null`.

Use it before path or command decisions that depend on where the agent is running or on the host OS — for example choosing `bash` vs `pwsh`, deciding whether a relative path is safe, or formatting platform-specific output.

## Configuration

`environmentVariables` is an array of environment variable names the deployment consents to exposing. Its default is the safe allowlist `['LANG', 'SHELL', 'USER', 'DSH_AGENTS_HOME']` — locale, identity, and harness-home hints, never secrets. Names are matched case-insensitively and reported under their uppercase form; a name absent from the process environment is reported as `null` so the model can tell "unset" from an empty string. A deployment that wants none sets `[]`.

This is a deliberate scope gate, not a fixed rule: environment variables can carry secrets, so nothing is reported until a deployment names it in this allowlist.

## Rendering

The canonical result is the object above; its Native renderer emits a compact multi-line summary, and `presentCall` / `presentResult` present a generic "Inspect environment" / "Environment" card for capable UIs. No session events are written, so there is no durable-log invariant companion.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`environment_info` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-environment).

#### Token effect

Fixed, argument-free schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each call returns the environment snapshot described above. It is small and fixed-shape; there are no stable error paths for well-formed calls.

#### Token effect

Fixed-shape result; the `environmentVariables` map scales with the configured allowlist.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No secrets are ever reported** — only names in the configured allowlist, whose default is deliberately minimal; this is a safety property, not a feature gap.
- **Host-only, not container-aware** — values come from the host process, not from any sandbox or container the agent may run in; a confined agent reports the host's environment.
- **No workspace enumeration** — the tool reports `cwd` but does not list workspace membership or mounted providers; the harness already exposes provider inspection via the `cordis_inspect_*` tools.

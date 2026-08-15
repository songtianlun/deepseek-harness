# Agent Note：environment_info —— 面向模型的运行时报告

Status: implemented

[English](2026-08-15-tool-environment.md) | 中文

## Problem

一个锚定在真实宿主上的 agent（智能体）会针对它无法观测的事实做出许多路径与命令决策：相对路径所解析的绝对工作目录、宿主操作系统与平台、CPU 架构，以及运行它的账户身份（主机名、用户、主目录、shell）。harness 的文件系统工具会基于会话级 `cwd` 解析路径，`context` 插件会注入时间与工作区指令上下文，但没有任何面向模型的工具报告运行时环境本身。模型只能猜测或询问这些事实，或硬编码宿主假设。

## Decision

新增 `@deepseek-ai/dsh-tool-environment`（位于 `context` 分组），在 `ctx.tools` 上注册一个无参数的 `environment_info()` 工具。它返回规范化快照：`cwd`（所属 agent 会话头部的 `cwd`，否则为 `process.cwd()`）、`platform`、`os`/`osRelease`/`architecture`、`hostname`、`username`、`homeDirectory`、`shell`（取自 `SHELL`，未设置时为空字符串）、`nodeVersion`，以及一个仅包含 Config 允许清单的环境变量映射。

环境变量是有意的范围闸门，而非自由读取：除非部署方在 `Config.environmentVariables` 中指名，否则不会报告任何变量；其默认值是一份安全的允许清单 `['LANG', 'SHELL', 'USER', 'DSH_AGENTS_HOME']`。变量名不区分大小写匹配，并以大写形式上报；进程环境中不存在的名称上报为 `null`，以便模型区分「未设置」与「空字符串」。该工具不写入会话事件，因此仅附带一个空操作的不变量伴生模块以遵循包伴生约定。

该插件已暴露在 `standard`、`code`、`cordis` 三个 agent 预设与 `apps/cli` 依赖中；生成器启动清单与双语工具目录也已重新生成以记录它。它注册在既有的 `ctx.tools.register` 扩展点上，不改变任何核心架构。

## Alternatives considered

**读取整个 `process.env`** —— 拒绝。环境变量常携带机密，整体上报会把凭证泄漏进每一次工具调用与会话日志。Config 允许清单把暴露变成明确的部署决策。

**只报告路径与操作系统事实，不报告环境变量** —— 部分采纳。核心快照保留了 cwd/OS/platform/architecture/身份；保留了一小份允许清单映射，因为语言环境与 harness 主目录提示（`LANG`、`DSH_AGENTS_HOME`）确实有用且安全。

**依赖 shell 或文件系统工具去发现环境** —— 拒绝。`bash`/`pwsh` 输出是非结构化的，且依赖宿主 shell；专门工具能给模型一个单一、schema 类型化的报告。

## Consequences

模型如今可以依据真实运行时而非宿主假设来锚定路径与命令决策，消除一类宿主假设错误，并省去「猜 `cwd`」的往返。由于环境面是带安全默认值的允许清单，不引入新的机密暴露路径；希望完全不暴露的部署可设为 `[]`。代价是面向模型的 schema 中多一个工具（体积小、无参数、形态固定，且前缀稳定，利于 KV-cache 复用）。

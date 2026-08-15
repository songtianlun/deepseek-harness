# @deepseek-ai/dsh-tool-environment

[English](README.md) | 中文

面向模型的 `environment_info` 工具：agent（智能体）所运行环境的报告。

## 功能

在 `ctx.tools` 上注册一个工具 `environment_info()`。它不接受参数，返回 agent 所在宿主机的规范化快照：

- `cwd` —— 相对路径解析所依据的绝对工作目录：存在所属 agent 会话的 `cwd` 时取其值，否则取宿主机的 `process.cwd()`。
- `platform` / `os` / `osRelease` / `architecture` —— 宿主平台、操作系统名称、系统版本、CPU 架构（例如 `darwin` / `Darwin` / `23.6.0` / `arm64`）。
- `hostname` / `username` / `homeDirectory` —— 机器与账户标识。
- `shell` —— `SHELL` 环境变量给出的默认 shell，未设置时为空字符串。
- `nodeVersion` —— 运行时版本，例如 `v22.23.1`。
- `environmentVariables` —— 一小份非机密环境变量的允许清单；不存在的变量名为 `null`。

在做出依赖运行位置或宿主操作系统的路径、命令决策前调用它——例如在 `bash` 与 `pwsh` 之间选择、判断相对路径是否安全，或格式化平台相关的输出。

## 配置

`environmentVariables` 是部署方同意暴露的环境变量名数组。其默认值是一份安全的允许清单 `['LANG', 'SHELL', 'USER', 'DSH_AGENTS_HOME']`——语言环境、身份与 harness 主目录提示，绝不含机密。变量名不区分大小写匹配，并以其大写形式上报；进程环境中不存在的名称上报为 `null`，以便模型区分「未设置」与「空字符串」。不希望暴露任何变量的部署可设为 `[]`。

这是一个有意的范围闸门，而非固定规则：环境变量可能携带机密，因此只有部署方在该允许清单中指名时才会被上报。

## 渲染

规范化结果是上文的对象；其 Native 渲染器输出紧凑的多行摘要，`presentCall` / `presentResult` 为支持能力的 UI 呈现通用的「检查环境」/「环境」卡片。本工具不写入会话事件，因此没有持久化日志的不变量伴生模块。

## 导出形态

函数/命名空间插件：导出 `name` / `inject` / `apply`，且没有默认导出。若出现 `export default`，加载器的 `unwrapExports` 会折叠该模块并丢弃 `inject`（参见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 schema

#### 模型所见

模型看到生成的 [`environment_info` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-environment)。

#### Token 影响

在该工具可见的每次请求上，产生固定的、无参数的 schema 开销。

#### KV Cache 影响

在定义与可见性不变的前提下前缀稳定。插件生命周期或作用域限制可能使该 schema 的复用失效。

### 工具调用历史与结果

#### 模型所见

每次调用返回上文所述的环境快照。它体积小、形态固定；对结构合法的调用而言不存在稳定的错误路径。

#### Token 影响

结果形态固定；`environmentVariables` 映射随配置的允许清单规模伸缩。

#### KV Cache 影响

追加式；新可见内容跟在可复用请求前缀之后，不会使既有 KV-cache 条目失效。

## 已知限制与后续工作

- **绝不报告机密** —— 只上报配置允许清单中的名字，其默认值刻意保持最小；这是安全属性，而非功能缺口。
- **仅宿主视角，不感知容器** —— 取值来自宿主进程，而非 agent 可能运行于其中的沙箱或容器；被隔离的 agent 仍上报宿主环境。
- **不做工作区枚举** —— 该工具报告 `cwd`，但不列出工作区成员或已挂载的提供者；harness 已通过 `cordis_inspect_*` 工具暴露提供者检查。

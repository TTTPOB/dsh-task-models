# dsh-task-models

给 DeepSeek Harness 用的插件，让你在运行时给子代理任务指定模型和 reasoning effort。它对应 OpenCode 版 [`opencode-task-models`](https://github.com/TTTPOB/opencode-task-plugin) 的 DSH 移植：一个 `task` 工具在启动子代理时按任务选模型与推理档位，一个 `task_models` 工具用来发现已注册的 provider、模型和档位，避免把整个模型目录塞进每个 prompt。

## 和 OpenCode 版的差别

- DSH 里“模型”是 `provider/model-id`，reasoning effort 对应 OpenCode 的 variant。
- DSH 内置 `AgentOptions` 没有 reasoning effort 字段。本插件扩展这个 merge-extensible interface，把选中的 effort 随子代理选项传入，并通过全局 `agent/request` 钩子写入模型请求。
- 这条路径适用于 DSH 本地 Agent Loop 驱动的进程内 provider（`spawn`、`fork`）。ACP、Codex、Claude Code 等外部进程 provider 需要各自的远端协议支持。

## 要求

- 已安装 `dsh` CLI
- 至少一个已注册的 LLM provider

## 安装

### 本地目录

```bash
cd dsh-task-models
pnpm install
pnpm build
dsh plugin add ./dsh-task-models
```

### git 仓库

```bash
dsh plugin --profile web add github:TTTPOB/dsh-task-models#main
```

git 安装只拉源码不跑构建，插件靠 `prepare` 脚本在安装后编译。pnpm ≥10 需要先在 profile 的 `pnpm-workspace.yaml` 里放行构建：

```yaml
allowBuilds:
  dsh-task-models: true
```

然后重跑 `add`。

### tarball

```bash
pnpm pack
dsh plugin add ./dsh-task-models-0.1.0.tgz
```

装完重启 dsh。

## 工具

### `task`

前台启动一个子代理，参数：

- `description`：任务的简短描述（3-5 个词）
- `prompt`：完整、自包含的任务描述
- `model`：可选，`provider/model-id`，按第一个 `/` 拆分，模型 id 里可以带 `/`。省略时继承当前会话的模型
- `reasoning_effort`：可选，目标模型支持的 effort id；传 `default` 时强制使用 adapter/model 默认值。省略且不换模型时继承调用方的显式 effort，换模型时使用目标模型默认值

选择规则：

| 参数 | 选择 |
| --- | --- |
| 不传 `model` | 调用方当前请求头里的模型；会继承调用方的显式 effort，不把 adapter 自动默认值固化成显式值 |
| 传 `model`，不传 effort | 指定的 provider/model，使用目标模型默认档位 |
| 只传 `reasoning_effort` | 调用方当前模型，加指定档位 |
| `reasoning_effort: "default"` | adapter/model 默认档位，并清除 `fork` 历史里继承的显式档位 |
| 传具体 effort id | 子代理显式使用该档位，模型不支持时在创建前报错 |

示例：

```ts
task({
  description: "Review the authentication flow",
  prompt: "Find correctness and security issues in the authentication flow.",
  model: "openrouter/anthropic/claude-sonnet-4.6",
  reasoning_effort: "high",
})
```

插件前台执行一次性任务，没有 background 参数。显式 effort 会在创建子代理前经过 `ctx.llm.resolveCallConfig()` 校验；Agent Loop 随后把它写入子代理自己的 `request/header`。

### `task_models`

在需要另一个模型时，先调它：

```ts
task_models({ provider: "openrouter", query: "claude" })
```

不带参数时返回各 provider 的 id、名称和模型数。带 `provider` / `query` 过滤时，返回最多 50 条匹配的 `provider/model`，含每个模型的推理档位。

## 配置

`cordis.patch.yml` 里可以覆盖：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `provider` | `spawn` | 委托的 `ctx.subagents` provider |
| `toolName` | `task` | 模型可见的工具名 |
| `maxDepth` | `3` | 子代理最大嵌套深度，或 `provider-managed` 表示不设上限 |

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

测试用 mock 的 `ctx.llm` / `ctx.subagents` 覆盖模型选择、provider 校验、发现和异常路径。

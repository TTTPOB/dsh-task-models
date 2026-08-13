# dsh-task-models

给 DeepSeek Harness 用的插件，让你在运行时给子代理任务指定模型。它对应 OpenCode 版 [`opencode-task-models`](../opencode-task-plugin/README.md) 的 DSH 移植：一个 `task` 工具在启动子代理时可以按任务选模型，一个 `task_models` 工具用来发现已注册的 provider、模型和推理档位，避免把整个模型目录塞进每个 prompt。

## 和 OpenCode 版的差别

- DSH 里“模型”是 `provider/model-id`，推理档位对应 OpenCode 的 variant。
- DSH 的子代理通道（`ctx.subagents`）只透传 `provider` / `model` / `maxTokens`，不按子代理单独透传 reasoning effort。所以 `task` 工具只选 provider 和模型，推理档位沿用模型默认值；`task_models` 仍会列出推理档位供你参考。

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
dsh plugin add github:you/dsh-task-models
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

选模型规则：

| 参数 | 选择 |
| --- | --- |
| 不传 `model` | 调用方当前模型 |
| 传 `model` | 指定的 provider 和模型 |

示例：

```ts
task({
  description: "Review the authentication flow",
  prompt: "Find correctness and security issues in the authentication flow.",
  model: "openrouter/anthropic/claude-sonnet-4.6",
})
```

插件前台执行任务，没有 background 参数。

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

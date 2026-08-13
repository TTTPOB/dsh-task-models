# dsh-task-models

给 DeepSeek Harness 的原生 `subagent` / `subagent_fork` 增加逐次调用的模型和 reasoning-effort 选择。插件保留原生的 continuable、Jobs、前后台、fork 历史、provider 生命周期、递归深度和系统提示语义，同时提供 `task_models` 发现工具。

## 工具

### `subagent`

使用 `spawn` provider，新建不含父对话历史的子会话。默认后台 continuable，返回 durable subagent id；后续可用 `send_message` 继续对话。传 `run_in_background: false` 时前台等待一次性结果。

```ts
subagent({
  description: "Review authentication",
  prompt: "Review the authentication flow and report correctness issues.",
  model: "opencode-go/deepseek-v4-pro",
  reasoning_effort: "xhigh",
})
```

### `subagent_fork`

使用 `fork` provider，继承父会话已经完成的 turns，不包含当前正在执行的 turn。插件沿用当前 preset 的调度策略：DSH Web 内置 preset 使用后台 continuable，返回 durable subagent id；rosterless/headless 的 host 配置使用前台 one-shot，显式后台时返回普通 job id。

```ts
subagent_fork({
  description: "Verify prior analysis",
  prompt: "Check the previous conclusion and identify counterexamples.",
  model: "opencode-go/deepseek-v4-flash",
  reasoning_effort: "high",
})
```

两个工具共同增加：

- `model`：可选，格式为 `provider/model-id`，只按第一个 `/` 拆分
- `reasoning_effort`：可选，模型支持的 effort id；`default` 强制使用 adapter/model 默认值

选择顺序：

| 调用 | 子代理选择 |
| --- | --- |
| 不传 model/effort | 继承调用方当前 route 和显式 effort；adapter 自动默认值不会固化 |
| 只传 model | 指定 route，使用目标模型默认 effort |
| 只传 effort | 调用方当前 route，加指定 effort |
| `reasoning_effort: "default"` | 清除 fork 历史里的显式 effort，重新解析模型默认值 |
| 工具静态配置了 `agentOptions` | 调用参数优先，其次静态配置，再次调用方当前 route |

模型和 effort 会在创建 Job、continuable session 或 one-shot child 之前经过 `ctx.llm.resolveCallConfig()` 校验。

### `task_models`

```ts
task_models({ provider: "opencode-go", query: "deepseek" })
```

不带参数时返回 provider 名称和模型数。带 `provider` / `query` 时返回最多 50 个匹配模型，包括支持的 reasoning efforts 和默认 effort。

## 原生行为兼容

插件 bundle 会禁用 DSH host 平面的两个 model-facing tool rows，再以同名工具注册增强版本。DSH Web 把工具挂在 agent preset scope；插件在 `agent/created` 时只覆盖该 preset 已授予的同名工具，并保留 preset 的后台策略。子代理 tool filter 删除工具后，插件不会把它重新加入。

以下原生能力保持不变：

- `subagent` 默认后台 continuable、settlement notice 和 `send_message`
- `subagent_fork` 沿用当前 preset/host 的 continuable 或 one-shot 策略
- `run_in_background` 三态规则
- 完整 ContentBlock 前台输出
- foreground result/disposal 错误处理
- provider add/remove 和 HMR 生命周期
- `maxDepth`、persona、toolFilter 与 provider capability 检查
- continuable system-prompt 调度说明
- sibling delegation 并发安全

reasoning-effort 注入依赖 DSH 本地 Agent Loop，因此适用于 `spawn` 和 `fork`。ACP、Codex、Claude Code 等外部进程 provider 需要各自的远端协议支持。

## 安装

### GitHub Release（推荐）

Release tarball 已包含 `dist/`，不运行依赖构建脚本，也不需要 `allowBuilds`：

```bash
dsh plugin --profile web add dsh-task-models@https://github.com/TTTPOB/dsh-task-models/releases/download/v0.2.0/dsh-task-models-0.2.0.tgz
```

安装后重启 `dsh web`。

### 本地目录

```bash
git clone https://github.com/TTTPOB/dsh-task-models.git
cd dsh-task-models
pnpm install
pnpm build
dsh plugin --profile web add "$PWD"
```

### Git 源码

```bash
dsh plugin --profile web add github:TTTPOB/dsh-task-models#v0.2.0
```

Git 安装需要运行 `prepare`；pnpm 10 默认拦截依赖构建脚本。优先使用 Release tarball。

## Bundle 配置

默认 bundle 等价于：

```yaml
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true
- insert:
    - id: task-model-routing
      name: dsh-task-models
    - id: enhanced-tool-subagent
      name: dsh-task-models/delegation
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable
    - id: enhanced-tool-subagent-fork
      name: dsh-task-models/delegation
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: one-shot
```

增强委托入口还接受原生静态配置：

- `enableRunInBackground`
- `agentOptions.provider` / `agentOptions.model` / `agentOptions.maxTokens`
- `persona`
- `toolFilter.allow` / `toolFilter.deny`
- `maxDepth`，默认 `3`，也可设为 `provider-managed`

## 从 0.1.x 升级

0.2.0 删除独立的前台 `task` 工具，直接增强并替换 `subagent` / `subagent_fork`。调用方应把 `task({...})` 改为 `subagent({... , run_in_background: false})`，或按需求使用原生默认后台行为。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

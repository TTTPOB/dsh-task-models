/**
 * DeepSeek Harness plugin: per-task model selection for subagent delegation.
 *
 * Mirrors the `opencode-task-models` plugin for OpenCode: a `task` tool that
 * launches a foreground subagent with optional `provider/model-id` and
 * reasoning-effort selection (defaulting to the caller's active selection),
 * plus a `task_models` tool that lists providers, models, and efforts without
 * placing the full catalog in every prompt.
 *
 * @module dsh-task-models
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  ContentBlock,
  LlmCallConfig,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
} from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'

export const name = 'task-models'
export const inject = ['tools', 'subagents', 'llm']

/**
 * Private plugin extension carried through the merge-extensible AgentOptions.
 * The agent loop preserves it; this plugin's global request hook consumes it.
 */
declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Explicit task effort; null means clear inherited effort and use the model default. */
    taskModelReasoningEffort?: ReasoningEffortIdType | null
  }
}

/** Config: which subagent provider to delegate to, plus tool naming and depth. */
export interface Config {
  /** The `ctx.subagents` provider to start runs on (default `spawn`). */
  provider?: string
  /** Model-facing tool name (default `task`). */
  toolName?: string
  /** Maximum child depth (default 3), or `'provider-managed'` for no cap. */
  maxDepth?: number | 'provider-managed'
}

interface ResolvedConfig {
  provider: string
  toolName: string
  maxDepth: number | 'provider-managed'
}

/** The parts of the LLM runtime the tools consume, structural for testability. */
export interface LlmDep {
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>
}

/** The parts of the subagent runtime the task tool consumes. */
export interface SubagentsDep {
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
}

/** The dependencies the tool bodies read at execution time. */
export interface ToolsDeps {
  llm: LlmDep
  subagents: SubagentsDep
}

interface ModelRoute {
  provider: string
  model: string
}

type TaskModelAgent = Pick<Agent, 'options'>

/** Apply the private AgentOptions extension to one model request. */
export async function applyTaskModelReasoningEffort(
  agent: TaskModelAgent,
  next: () => Promise<LlmCallConfig>,
): Promise<LlmCallConfig> {
  const config = await next()
  const selected = agent.options.taskModelReasoningEffort
  if (selected === undefined) return config
  const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = config
  return selected === null
    ? withoutInheritedEffort
    : { ...withoutInheritedEffort, reasoningEffort: selected }
}

/** Split `provider/model-id` on the first slash so model ids may contain `/`. */
export function parseModel(value: string): ModelRoute {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Invalid model "${value}"; expected provider/model-id`)
  }
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

function textOf(output: ContentBlock[]): string {
  return output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

function withPartialText(error: string, output: ContentBlock[]): string {
  const text = textOf(output)
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

/** Collect one foreground run, preserving the child's real failure over disposal. */
async function settleForegroundRun(run: SubagentRun): Promise<{ runId: string; output: string }> {
  const [execution] = await Promise.allSettled([run.result])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  const result = execution.value
  const error = stopReasonError(result)
  if (error !== undefined) throw new Error(withPartialText(error, result.output))
  return { runId: String(run.id), output: textOf(result.output) }
}

export function createTools(deps: ToolsDeps, config: ResolvedConfig) {
  const task = defineTool({
    name: config.toolName,
    description:
      'Launch a foreground subagent task with optional per-task model and reasoning-effort selection. '
      + 'Select a registered model as `provider/model-id` (split on the first `/`) and an adapter-owned '
      + 'reasoning effort. Call task_models first when you need to discover available values.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description:
          'The complete, self-contained task for the subagent. It does not share this conversation, '
          + 'so include everything it needs.',
      },
      model: {
        type: 'string',
        description: 'Optional model as `provider/model-id`. Omit to inherit the calling agent\'s current model.',
      },
      reasoning_effort: {
        type: 'string',
        description:
          'Optional reasoning effort id for the selected model, or `default` to force the adapter/model default. '
          + 'When both model and effort are omitted, inherit the caller\'s explicit effort. Call task_models to discover ids.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          output: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.output }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('task tool requires a calling agent (exec.agent was undefined)')
      }
      if (args.description.trim().length === 0) throw new Error('description must be non-empty')
      if (args.prompt.trim().length === 0) throw new Error('prompt must be non-empty')

      const parentHeader = parent.session.requestHeader()
      const activeParentConfig = parentHeader?.config
      const route: ModelRoute = args.model !== undefined
        ? parseModel(args.model)
        : activeParentConfig !== undefined
          ? { provider: activeParentConfig.provider, model: activeParentConfig.model }
          : parent.options.provider !== undefined && parent.options.model !== undefined
            ? { provider: parent.options.provider, model: parent.options.model }
            : (() => {
              throw new Error('no model selected and the calling agent has no model to inherit')
            })()

      const requestedEffort = args.reasoning_effort?.trim()
      if (args.reasoning_effort !== undefined && requestedEffort?.length === 0) {
        throw new Error('reasoning_effort must be non-empty')
      }
      const inheritedEffort = args.model === undefined
        && activeParentConfig?.provider === route.provider
        && activeParentConfig.model === route.model
        && parentHeader?.adapterDefaults?.reasoningEffort !== true
        ? activeParentConfig.reasoningEffort
        : undefined
      const reasoningEffort: ReasoningEffortIdType | null = args.reasoning_effort === undefined
        ? (inheritedEffort ?? null)
        : requestedEffort === 'default'
          ? null
          : ReasoningEffortId(requestedEffort as string)

      // Resolve the complete explicit selection before delegation so an unknown
      // provider, model, or effort fails as a clear tool error instead of a child
      // startup failure. `default` deliberately validates without an effort;
      // the request hook clears any effort inherited through a fork seed.
      await deps.llm.resolveCallConfig({
        ...route,
        ...reasoningEffort === null ? {} : { reasoningEffort },
      })

      const run = await deps.subagents.start(config.provider, {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        agentOptions: {
          ...route,
          taskModelReasoningEffort: reasoningEffort,
        },
        ...(config.maxDepth !== 'provider-managed' ? { maxDepth: config.maxDepth } : {}),
        signal: exec.signal,
      })
      return settleForegroundRun(run)
    },
  })

  const taskModels = defineTool({
    name: 'task_models',
    description:
      'List registered providers, task models, and model reasoning efforts. Call before '
      + `\`${config.toolName}\` when you need another model.`,
    parameters: {
      provider: {
        type: 'string',
        description: 'Optional provider route to restrict the listing to.',
      },
      query: {
        type: 'string',
        description: 'Optional case-insensitive substring matched against `provider/model-id`.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const providers = deps.llm.listProviders()
      if (args.provider !== undefined && !providers.some((p) => p.id === args.provider)) {
        throw new Error(`Unknown provider: ${args.provider}`)
      }

      if (args.provider === undefined && args.query === undefined) {
        const rows = await Promise.all(providers.map(async (p) => ({
          id: p.id,
          name: p.name,
          modelCount: (await deps.llm.listModels(p.id)).length,
        })))
        return JSON.stringify({ providers: rows }, null, 2)
      }

      const scope = args.provider !== undefined ? providers.filter((p) => p.id === args.provider) : providers
      const query = args.query?.toLowerCase()
      const matches: { provider: string; model: LlmModelInfo }[] = []
      for (const p of scope) {
        const models = await deps.llm.listModels(p.id)
        for (const model of models) {
          if (query !== undefined && !`${p.id}/${model.id}`.toLowerCase().includes(query)) continue
          matches.push({ provider: p.id, model })
        }
      }

      const models = []
      for (const { provider, model } of matches.slice(0, 50)) {
        const resolved = await deps.llm.resolveModelInfo(provider, model.id)
        models.push({
          provider,
          id: model.id,
          name: model.name,
          ...(model.description !== undefined ? { description: model.description } : {}),
          reasoningEfforts: resolved.reasoning?.efforts.map((effort) => effort.id) ?? [],
          ...(resolved.reasoning?.defaultEffort !== undefined ? { defaultEffort: resolved.reasoning.defaultEffort } : {}),
        })
      }
      return JSON.stringify(
        {
          models,
          remaining: matches.length - models.length,
        },
        null,
        2,
      )
    },
  })

  return { task, taskModels }
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved: ResolvedConfig = {
    provider: config.provider ?? 'spawn',
    toolName: config.toolName ?? 'task',
    maxDepth: config.maxDepth ?? 3,
  }
  if (resolved.maxDepth !== 'provider-managed') assertSubagentMaxDepth(resolved.maxDepth)

  const deps: ToolsDeps = { llm: ctx.llm, subagents: ctx.subagents }
  const { task, taskModels } = createTools(deps, resolved)

  // AgentOptions is intentionally merge-extensible. In-process subagent
  // providers preserve this plugin's private effort field; this unscoped
  // listener sees every Agent request and applies it before exact-model
  // validation and request-header persistence.
  ctx.on('agent/request', ({ agent }, next) => applyTaskModelReasoningEffort(agent, next))

  // task_models only needs ctx.llm, which is always present once injected.
  ctx.tools.register(taskModels)

  // Mirror the subagent provider lifecycle so the task tool appears only once
  // its provider can actually start runs (same pattern as dsh-tool-subagent).
  let disposeTask: (() => void) | undefined
  const mount = (): void => {
    disposeTask = ctx.tools.register(task)
  }
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === resolved.provider && disposeTask === undefined) mount()
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== resolved.provider || disposeTask === undefined) return
    disposeTask()
    disposeTask = undefined
  })
  if (ctx.subagents.getProvider(resolved.provider) !== undefined) {
    mount()
  } else {
    ctx.logger.info(
      `subagent provider "${resolved.provider}" not registered yet; the "${resolved.toolName}" tool will register when it appears`,
    )
  }
}

export default apply

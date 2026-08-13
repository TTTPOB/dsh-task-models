/**
 * Shared model discovery and per-child request routing for enhanced DSH
 * subagent tools.
 *
 * @module dsh-task-models
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  LlmCallConfig,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
} from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export const name = 'task-model-routing'
export const inject = ['tools', 'llm']

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Explicit enhanced-subagent effort; null clears inherited effort. */
    taskModelReasoningEffort?: ReasoningEffortIdType | null
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared model discovery and selection service for enhanced subagent tools. */
    taskModelRouting: TaskModelRouting
  }
}

/** The LLM-runtime methods needed by selection and discovery. */
export interface LlmDep {
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>
}

/** Model-facing selection fields shared by both enhanced delegation tools. */
export interface RuntimeModelSelectionArgs {
  model?: string
  reasoning_effort?: string
}

interface ModelRoute {
  provider: string
  model: string
}

type RoutedAgent = Pick<Agent, 'options'>

/** Apply the private AgentOptions extension to one Agent request. */
export async function applyTaskModelReasoningEffort(
  agent: RoutedAgent,
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

/** Build the task_models definition without coupling tests to Cordis setup. */
export function createTaskModelsTool(llm: LlmDep) {
  return defineTool({
    name: 'task_models',
    description:
      'List registered providers, models, and model reasoning efforts. Call before subagent or '
      + 'subagent_fork when you need another model or effort.',
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
      const providers = llm.listProviders()
      if (args.provider !== undefined && !providers.some(provider => provider.id === args.provider)) {
        throw new Error(`Unknown provider: ${args.provider}`)
      }

      if (args.provider === undefined && args.query === undefined) {
        const rows = await Promise.all(providers.map(async provider => ({
          id: provider.id,
          name: provider.name,
          modelCount: (await llm.listModels(provider.id)).length,
        })))
        return JSON.stringify({ providers: rows }, null, 2)
      }

      const scope = args.provider === undefined
        ? providers
        : providers.filter(provider => provider.id === args.provider)
      const query = args.query?.toLowerCase()
      const matches: { provider: string; model: LlmModelInfo }[] = []
      for (const provider of scope) {
        const models = await llm.listModels(provider.id)
        for (const model of models) {
          if (query !== undefined && !`${provider.id}/${model.id}`.toLowerCase().includes(query)) continue
          matches.push({ provider: provider.id, model })
        }
      }

      const models = []
      for (const { provider, model } of matches.slice(0, 50)) {
        const resolved = await llm.resolveModelInfo(provider, model.id)
        models.push({
          provider,
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          reasoningEfforts: resolved.reasoning?.efforts.map(effort => effort.id) ?? [],
          ...(resolved.reasoning?.defaultEffort === undefined
            ? {}
            : { defaultEffort: resolved.reasoning.defaultEffort }),
        })
      }
      return JSON.stringify({ models, remaining: matches.length - models.length }, null, 2)
    },
  })
}

/** Resolve one enhanced delegation's complete child AgentOptions. */
export async function resolveChildOptions(
  llm: LlmDep,
  parent: Agent,
  args: RuntimeModelSelectionArgs,
  configured: AgentOptions | undefined,
  signal?: AbortSignal,
): Promise<AgentOptions> {
  const parentHeader = parent.session.requestHeader()
  const activeParentConfig = parentHeader?.config
  const parentProvider = activeParentConfig?.provider ?? parent.options.provider
  const parentModel = activeParentConfig?.model ?? parent.options.model
  const explicitRoute = args.model === undefined ? undefined : parseModel(args.model)
  const provider = explicitRoute?.provider ?? configured?.provider ?? parentProvider
  const model = explicitRoute?.model ?? configured?.model ?? parentModel
  if (provider === undefined || model === undefined) {
    throw new Error('no model selected and the calling agent has no complete provider/model route to inherit')
  }

  const requestedEffort = args.reasoning_effort?.trim()
  if (args.reasoning_effort !== undefined && requestedEffort?.length === 0) {
    throw new Error('reasoning_effort must be non-empty')
  }
  const selectedAnotherRoute = explicitRoute !== undefined
    || configured?.provider !== undefined
    || configured?.model !== undefined
  const inheritedEffort = !selectedAnotherRoute
    && activeParentConfig?.provider === provider
    && activeParentConfig.model === model
    && parentHeader?.adapterDefaults?.reasoningEffort !== true
    ? activeParentConfig.reasoningEffort
    : undefined
  const reasoningEffort: ReasoningEffortIdType | null = args.reasoning_effort === undefined
    ? (inheritedEffort ?? null)
    : requestedEffort === 'default'
      ? null
      : ReasoningEffortId(requestedEffort as string)

  await llm.resolveCallConfig({
    provider,
    model,
    ...(reasoningEffort === null ? {} : { reasoningEffort }),
  }, signal)

  return {
    ...configured,
    provider,
    model,
    taskModelReasoningEffort: reasoningEffort,
  }
}

/**
 * Service that serializes runtime selection rules for every enhanced delegation
 * tool and owns the single model-discovery tool/request hook.
 */
export class TaskModelRouting extends Service {
  constructor(ctx: Context) {
    super(ctx, 'taskModelRouting')
    ctx.on('agent/request', ({ agent }, next) => applyTaskModelReasoningEffort(agent, next))
    ctx.tools.register(createTaskModelsTool(ctx.llm))
  }

  resolveChildOptions(
    parent: Agent,
    args: RuntimeModelSelectionArgs,
    configured: AgentOptions | undefined,
    signal?: AbortSignal,
  ): Promise<AgentOptions> {
    return resolveChildOptions(this.ctx.llm, parent, args, configured, signal)
  }
}

/** Mount the shared service; named export preserves Cordis inject metadata. */
export function apply(ctx: Context): void {
  new TaskModelRouting(ctx)
}

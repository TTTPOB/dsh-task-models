/**
 * Enhanced drop-in replacement for DSH's model-facing subagent tools.
 * Preserves native scheduling and lifecycle semantics while adding per-call
 * model and reasoning-effort selection.
 *
 * @module dsh-task-models/delegation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { assertSubagentMaxDepth, settleRun } from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from './index.js'

export const name = 'enhanced-tool-subagent'
export const inject = ['agents', 'tools', 'subagents', 'systemPrompt', 'taskModelRouting']

const SUBAGENT_SECTION_ORDER = 116.5

/** Native tool-subagent configuration, preserved by the replacement. */
export interface Config {
  provider: string
  toolName?: string
  enableRunInBackground?: boolean
  backgroundMode?: 'one-shot' | 'continuable'
  agentOptions?: AgentOptions
  persona?: string
  toolFilter?: {
    allow?: string[]
    deny?: string[]
  }
  maxDepth?: number | 'provider-managed'
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  enableRunInBackground: z.boolean().default(true),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('one-shot'),
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as { provider: string; model: string; maxTokens: number }),
  persona: z.string(),
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default(3),
})

function outputValueText(values: JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

export async function settleStart(start: Promise<SubagentRun>, signal: AbortSignal): Promise<JobOutcome> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    return signal.aborted
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

function withPartialText(error: string, output: ContentBlock[]): string {
  const text = output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

type ForegroundToolResult = {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
}

export async function settleForegroundRun(run: SubagentRun): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withPartialText(error, result.output))
      return {
        kind: 'foreground',
        runId: run.id,
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
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
  return execution.value
}

export function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, a review, a continuation — without '
        + 'consuming this conversation\'s context for the work itself. You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped implementation, an analysis — so it does '
      + 'not consume this conversation\'s context. The subagent returns its result, not its intermediate steps. '
      + 'Give it a complete, standalone prompt: it does not see this conversation.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this conversation\'s context, '
      + 'so include everything it needs.',
  }
}

export function resolveDelegationRun(
  request: { readonly run_in_background?: boolean },
  options: { readonly backgroundEnabled: boolean; readonly continuable: boolean },
): { readonly runInBackground: boolean } {
  if (!options.backgroundEnabled) {
    if (request.run_in_background === true) {
      throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)')
    }
    return { runInBackground: false }
  }
  return { runInBackground: request.run_in_background ?? options.continuable }
}

/** Create one provider-specific definition; provider HMR rebuilds it. */
export function createDelegationTool(ctx: Context, config: Config, provider: SubagentProvider) {
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const toolName = config.toolName ?? 'subagent'
  const wording = providerWording(provider.inheritsParentContext)

  return defineTool({
    name: toolName,
    description: wording.description + (backgroundEnabled
      ? continuable
        ? ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` starts a later turn in the same child conversation. Set `run_in_background: false` only when your next action depends on receiving the result.'
        : ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
      : ' This call waits for the subagent and returns its result.')
      + ' Select a per-call model as `provider/model-id` and an adapter-owned reasoning effort. Call `task_models` to discover values.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: wording.promptDescription,
      },
      ...backgroundEnabled ? {
        run_in_background: {
          type: 'boolean' as const,
          description: continuable
            ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.'
            : 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.',
        },
      } : {},
      model: {
        type: 'string',
        description:
          'Optional model as `provider/model-id`. Omit to use the configured route or inherit the caller\'s active route.',
      },
      reasoning_effort: {
        type: 'string',
        description:
          'Optional reasoning effort id, or `default` to force the adapter/model default. When model and effort '
          + 'are omitted, inherit the caller\'s explicit effort. Call task_models to discover ids.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'continuable' },
              subagentId: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              runId: { type: 'string', required: true },
              output: { type: 'array', required: true, items: { type: 'json' } },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background subagent task ${value.jobId}`
          : value.kind === 'continuable'
            ? `started subagent ${value.subagentId}`
            : outputValueText(value.output),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
      const runSpec = resolveDelegationRun(args, { backgroundEnabled, continuable })
      const agentOptions = await ctx.taskModelRouting.resolveChildOptions(parent, args, config.agentOptions, exec.signal)
      exec.signal.throwIfAborted()
      const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined
      const request = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
        parent,
        agentOptions,
        ...config.persona === undefined ? {} : { persona: config.persona },
        ...config.toolFilter === undefined ? {} : { toolFilter: config.toolFilter },
        ...maxDepth === undefined ? {} : { maxDepth },
      }

      if (runSpec.runInBackground) {
        if (continuable) {
          const started = await ctx.subagents.startContinuable({
            provider: config.provider,
            label: args.description,
            request,
            signal: exec.signal,
          })
          return { kind: 'continuable' as const, subagentId: started.childId }
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        const id = jobs.start({
          kind: 'subagent',
          label: args.description,
          owner: parent,
          run: () => {
            const controller = new AbortController()
            const start = ctx.subagents.start(config.provider, { ...request, signal: controller.signal })
            return {
              cancel: (reason?: string) => controller.abort(reason ?? 'background subagent task killed'),
              done: settleStart(start, controller.signal),
            }
          },
        })
        return { kind: 'background' as const, jobId: id }
      }

      const run = await ctx.subagents.start(config.provider, { ...request, signal: exec.signal })
      return settleForegroundRun(run)
    },
  })
}

/** Fail at provider mount when configured guarantees cannot be honored. */
export function assertProviderCompatibility(provider: SubagentProvider, config: Config): void {
  if (typeof config.maxDepth === 'number' && !provider.capabilities.depthLimit) {
    throw new Error(
      `enhanced-tool-subagent: provider "${provider.name}" cannot enforce maxDepth; `
      + 'set maxDepth: \'provider-managed\'',
    )
  }
  if ((config.backgroundMode ?? 'one-shot') === 'continuable' && provider.prepareContinuable === undefined) {
    throw new Error(
      `enhanced-tool-subagent: provider "${provider.name}" does not support backgroundMode: continuable`,
    )
  }
}

/**
 * Preserve the visible preset tool's scheduling contract when shadowing it in
 * the concrete agent scope. DSH presets can choose a different policy from the
 * host bundle, notably continuable fork tools in Web.
 */
export function configForScopedShadow(config: Config, existing: ToolDefinition): Config {
  const parameters = existing.parameters as {
    properties?: { run_in_background?: { description?: unknown } }
  }
  const runInBackground = parameters.properties?.run_in_background
  if (runInBackground === undefined) {
    return { ...config, enableRunInBackground: false, backgroundMode: 'one-shot' }
  }
  const description = typeof runInBackground.description === 'string'
    ? runInBackground.description
    : ''
  return {
    ...config,
    enableRunInBackground: true,
    backgroundMode: description.includes('Defaults to true') ? 'continuable' : 'one-shot',
  }
}

/** Mount one enhanced delegation instance and mirror provider lifecycle. */
export function apply(ctx: Context, config: Config): void {
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  if (config.toolFilter !== undefined && config.toolFilter.allow === undefined && config.toolFilter.deny === undefined) {
    throw new Error('enhanced-tool-subagent: `toolFilter` names neither `allow` nor `deny`')
  }
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const toolName = config.toolName ?? 'subagent'
  const scopedTools = new Map<Agent, () => void>()
  let disposeGlobal: (() => void) | undefined
  let activeProvider: SubagentProvider | undefined
  let presetScoped = false
  let presetGeneration = 0
  let syncQueued = false
  let disposed = false

  const disposeScoped = (agent: Agent): void => {
    scopedTools.get(agent)?.()
    scopedTools.delete(agent)
  }
  const disposeScopedAll = (): void => {
    for (const dispose of scopedTools.values()) dispose()
    scopedTools.clear()
  }
  const disposeGlobalTool = (): void => {
    disposeGlobal?.()
    disposeGlobal = undefined
  }
  const mountGlobal = (provider: SubagentProvider): void => {
    if (disposeGlobal !== undefined) return
    assertProviderCompatibility(provider, config)
    disposeGlobal = ctx.tools.register(createDelegationTool(ctx, config, provider))
  }
  const syncScoped = (agent: Agent, provider: SubagentProvider): void => {
    // Remove our own nearest-layer definition before resolving the preset's
    // current generation after a recompose or provider HMR.
    disposeScoped(agent)
    const existing = ctx.tools.get(toolName, agent)
    // A preset has to grant this tool. A missing tool, or a host-only tool,
    // stays missing so a custom preset and a child tool filter remain authoritative.
    if (existing === undefined || existing === ctx.tools.get(toolName)) return
    const scopedConfig = configForScopedShadow(config, existing)
    assertProviderCompatibility(provider, scopedConfig)
    scopedTools.set(agent, agent.ctx.tools.register(createDelegationTool(ctx, scopedConfig, provider)))
  }
  const syncAll = (): void => {
    const provider = activeProvider
    if (!presetScoped || provider === undefined) return
    for (const agent of ctx.agents.list()) syncScoped(agent, provider)
  }
  const scheduleSync = (): void => {
    if (syncQueued) return
    syncQueued = true
    queueMicrotask(() => {
      syncQueued = false
      if (disposed) return
      try {
        syncAll()
      } catch (error: unknown) {
        ctx.logger.error(`failed to synchronize enhanced "${toolName}" tools: ${String(error)}`)
      }
    })
  }
  const mount = (provider: SubagentProvider): void => {
    activeProvider = provider
    if (presetScoped) scheduleSync()
    else mountGlobal(provider)
  }

  ctx.on('agent/created', ({ agent }) => {
    if (presetScoped && activeProvider !== undefined) syncScoped(agent, activeProvider)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    disposeScoped(agent)
  })
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === config.provider && activeProvider === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (providerName) => {
    if (providerName !== config.provider || activeProvider === undefined) return
    activeProvider = undefined
    disposeGlobalTool()
    disposeScopedAll()
  })

  // Agent presets are optional and may arrive after this sibling plugin. Enter
  // scoped mode through dynamic injection, then return to the host/global mode
  // if that service is hot-reloaded away.
  ctx.inject(['agentPresets'], (presetCtx) => {
    const generation = ++presetGeneration
    presetScoped = true
    disposeGlobalTool()
    syncAll()
    presetCtx.on('agent-preset/selected', (sessionId) => {
      const agent = ctx.agents.get(sessionId)
      if (agent !== undefined && activeProvider !== undefined) syncScoped(agent, activeProvider)
    })
    presetCtx.effect(() => () => {
      if (generation !== presetGeneration) return
      presetScoped = false
      disposeScopedAll()
      // Once this deployment exposes presets, do not broaden capabilities to
      // the host layer during a preset-service HMR gap. The next generation
      // resynchronizes the agent scopes.
    })
  })
  ctx.effect(() => () => {
    disposed = true
    activeProvider = undefined
    disposeGlobalTool()
    disposeScopedAll()
  })

  const present = ctx.subagents.getProvider(config.provider)
  if (present === undefined) {
    ctx.logger.info(
      `subagent provider "${config.provider}" not registered yet; the "${toolName}" tool will register when it appears`,
    )
  } else {
    mount(present)
  }

  // Preset tools already own a scope-matched section with their scheduling
  // policy. This host section stays registered but renders empty in preset mode.
  if (backgroundEnabled && continuable) {
    ctx.systemPrompt.section({
      name: `tool:${toolName}`,
      order: SUBAGENT_SECTION_ORDER,
      text: context => presetScoped || disposeGlobal === undefined || ctx.tools.get(toolName, context.scope) === undefined
        ? ''
        : `Use ${toolName} in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.`,
    })
  }
}

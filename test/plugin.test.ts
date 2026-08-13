import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'
import { applyTaskModelReasoningEffort, createTools, parseModel } from '../src/index.js'
import type { LlmCallConfig, LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'

const config = { provider: 'spawn', toolName: 'task', maxDepth: 3 } as const

describe('plugin export shape', () => {
  it('keeps inject metadata on the namespace loaded by Cordis', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('task-models')
    expect(plugin.inject).toEqual(['tools', 'subagents', 'llm'])
    expect(typeof plugin.apply).toBe('function')
  })
})

function model(provider: string, id: string, name = id): LlmModelInfo {
  return { provider, id, name }
}

function resolved(provider: string, id: string, efforts: string[] = []): LlmResolvedModelInfo {
  return {
    provider,
    id,
    name: id,
    ...(efforts.length > 0
      ? { reasoning: { efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })) } }
      : {}),
  }
}

function setup() {
  const listProviders = vi.fn(() => [
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'openrouter', name: 'OpenRouter' },
  ])
  const listModels = vi.fn(async (provider: string): Promise<LlmModelInfo[]> => {
    if (provider === 'deepseek') return [model('deepseek', 'v4-pro'), model('deepseek', 'v4-flash')]
    if (provider === 'openrouter') return [model('openrouter', 'vendor/model')]
    return []
  })
  const resolveModelInfo = vi.fn(async (provider: string, id: string) => resolved(provider, id, ['low', 'high']))
  const resolveCallConfig = vi.fn(async (c: unknown) => c)
  const start = vi.fn()
  const deps = {
    llm: { listProviders, listModels, resolveModelInfo, resolveCallConfig },
    subagents: { start },
  }
  return { deps, listProviders, listModels, resolveModelInfo, resolveCallConfig, start }
}

function run(output: string, stopReason: 'completed' | 'aborted' = 'completed'): SubagentRun {
  return {
    id: 'child-1',
    result: Promise.resolve({ output: [{ type: 'text', text: output }], stopReason }),
    dispose: async () => {},
  } as unknown as SubagentRun
}

function execWith(
  provider?: string,
  model?: string,
  header?: { config: LlmCallConfig; adapterDefaults?: { reasoningEffort?: true } },
) {
  return {
    agent: {
      options: { provider, model },
      session: { requestHeader: () => header },
    },
    signal: new AbortController().signal,
  }
}

describe('parseModel', () => {
  it('splits provider/model-id on the first slash', () => {
    expect(parseModel('openrouter/anthropic/claude-sonnet-4.6')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
    })
  })

  it('rejects a value without a slash or with an empty side', () => {
    expect(() => parseModel('deepseek')).toThrow(/Invalid model/)
    expect(() => parseModel('/model')).toThrow(/Invalid model/)
    expect(() => parseModel('provider/')).toThrow(/Invalid model/)
  })
})

describe('task', () => {
  it('delegates with the explicit model and returns the child output', async () => {
    const { deps, start, resolveCallConfig } = setup()
    start.mockResolvedValue(run('done'))
    const { task } = createTools(deps as never, config)

    const result = await (task as never as { execute: (a: unknown, e: unknown) => Promise<{ runId: string; output: string }> })
      .execute({ description: 'review auth', prompt: 'review', model: 'openrouter/vendor/model' }, execWith('deepseek', 'v4-pro'))

    expect(resolveCallConfig).toHaveBeenCalledWith({ provider: 'openrouter', model: 'vendor/model' })
    expect(start).toHaveBeenCalledTimes(1)
    const request = start.mock.calls[0]?.[1]
    expect(request?.agentOptions).toEqual({
      provider: 'openrouter',
      model: 'vendor/model',
      taskModelReasoningEffort: null,
    })
    expect(result).toEqual({ runId: 'child-1', output: 'done' })
  })

  it('validates and carries an explicit reasoning effort to the child AgentOptions', async () => {
    const { deps, start, resolveCallConfig } = setup()
    start.mockResolvedValue(run('high effort'))
    const { task } = createTools(deps as never, config)

    await (task as never as { execute: (a: unknown, e: unknown) => Promise<unknown> })
      .execute(
        { description: 'd', prompt: 'p', model: 'deepseek/v4-pro', reasoning_effort: 'high' },
        execWith('deepseek', 'v4-flash'),
      )

    expect(resolveCallConfig).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'v4-pro',
      reasoningEffort: 'high',
    })
    expect(start.mock.calls[0]?.[1].agentOptions).toEqual({
      provider: 'deepseek',
      model: 'v4-pro',
      taskModelReasoningEffort: 'high',
    })
  })

  it('uses the adapter default when reasoning_effort is default', async () => {
    const { deps, start, resolveCallConfig } = setup()
    start.mockResolvedValue(run('default effort'))
    const { task } = createTools(deps as never, config)

    await (task as never as { execute: (a: unknown, e: unknown) => Promise<unknown> })
      .execute(
        { description: 'd', prompt: 'p', model: 'deepseek/v4-pro', reasoning_effort: 'default' },
        execWith('deepseek', 'v4-flash'),
      )

    expect(resolveCallConfig).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-pro' })
    expect(start.mock.calls[0]?.[1].agentOptions).toEqual({
      provider: 'deepseek',
      model: 'v4-pro',
      taskModelReasoningEffort: null,
    })
  })

  it('rejects an empty reasoning effort before delegating', async () => {
    const { deps, start } = setup()
    const { task } = createTools(deps as never, config)

    await expect(
      (task as never as { execute: (a: unknown, e: unknown) => Promise<unknown> })
        .execute(
          { description: 'd', prompt: 'p', model: 'deepseek/v4-pro', reasoning_effort: '   ' },
          execWith('deepseek', 'v4-flash'),
        ),
    ).rejects.toThrow(/reasoning_effort must be non-empty/)
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects an unsupported reasoning effort before delegating', async () => {
    const { deps, start, resolveCallConfig } = setup()
    resolveCallConfig.mockRejectedValue(new Error('does not support reasoning effort "impossible"'))
    const { task } = createTools(deps as never, config)

    await expect(
      (task as never as { execute: (a: unknown, e: unknown) => Promise<unknown> })
        .execute(
          { description: 'd', prompt: 'p', model: 'deepseek/v4-pro', reasoning_effort: 'impossible' },
          execWith('deepseek', 'v4-flash'),
        ),
    ).rejects.toThrow(/does not support reasoning effort/)
    expect(start).not.toHaveBeenCalled()
  })

  it('inherits the calling agent model when no model is given', async () => {
    const { deps, start } = setup()
    start.mockResolvedValue(run('inherited'))
    const { task } = createTools(deps as never, config)

    await (task as never as { execute: (a: unknown, e: unknown) => Promise<unknown> })
      .execute({ description: 'd', prompt: 'p' }, execWith('deepseek', 'v4-flash'))

    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]?.[1].agentOptions).toEqual({
      provider: 'deepseek',
      model: 'v4-flash',
      taskModelReasoningEffort: null,
    })
  })

  it('inherits the active parent route and explicit effort from its request header', async () => {
    const { deps, start, resolveCallConfig } = setup()
    start.mockResolvedValue(run('active route'))
    const { task } = createTools(deps as never, config)

    await (task as never as { execute: (a: unknown, e: unknown) => Promise<unknown> })
      .execute(
        { description: 'd', prompt: 'p' },
        execWith('deepseek', 'old-model', {
          config: {
            provider: 'openrouter',
            model: 'active/model',
            reasoningEffort: ReasoningEffortId('high'),
          },
        }),
      )

    expect(resolveCallConfig).toHaveBeenCalledWith({
      provider: 'openrouter',
      model: 'active/model',
      reasoningEffort: 'high',
    })
    expect(start.mock.calls[0]?.[1].agentOptions).toEqual({
      provider: 'openrouter',
      model: 'active/model',
      taskModelReasoningEffort: 'high',
    })
  })

  it('does not turn an adapter default from the parent header into an explicit child effort', async () => {
    const { deps, start, resolveCallConfig } = setup()
    start.mockResolvedValue(run('adapter default'))
    const { task } = createTools(deps as never, config)

    await (task as never as { execute: (a: unknown, e: unknown) => Promise<unknown> })
      .execute(
        { description: 'd', prompt: 'p' },
        execWith('deepseek', 'v4-pro', {
          config: {
            provider: 'deepseek',
            model: 'v4-pro',
            reasoningEffort: ReasoningEffortId('high'),
          },
          adapterDefaults: { reasoningEffort: true },
        }),
      )

    expect(resolveCallConfig).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-pro' })
    expect(start.mock.calls[0]?.[1].agentOptions).toEqual({
      provider: 'deepseek',
      model: 'v4-pro',
      taskModelReasoningEffort: null,
    })
  })

  it('rejects an unknown provider before delegating', async () => {
    const { deps, start, resolveCallConfig } = setup()
    resolveCallConfig.mockRejectedValue(new Error('no adapter registered for provider "nope"'))
    const { task } = createTools(deps as never, config)

    await expect(
      (task as never as { execute: (a: unknown, e: unknown) => Promise<unknown> })
        .execute({ description: 'd', prompt: 'p', model: 'nope/model' }, execWith('deepseek', 'v4-pro')),
    ).rejects.toThrow(/no adapter/)
    expect(start).not.toHaveBeenCalled()
  })

  it('surfaces a non-completed stop reason with partial output', async () => {
    const { deps, start } = setup()
    start.mockResolvedValue(run('partial', 'aborted'))
    const { task } = createTools(deps as never, config)

    await expect(
      (task as never as { execute: (a: unknown, e: unknown) => Promise<unknown> })
        .execute({ description: 'd', prompt: 'p' }, execWith('deepseek', 'v4-pro')),
    ).rejects.toThrow(/subagent run was cancelled[\s\S]*partial/)
  })
})

describe('reasoning effort request hook', () => {
  it('overrides an inherited request effort from the child AgentOptions', async () => {
    const next = vi.fn(async () => ({
      provider: 'deepseek',
      model: 'v4-pro',
      reasoningEffort: ReasoningEffortId('low'),
    }))

    const result = await applyTaskModelReasoningEffort(
      { options: { taskModelReasoningEffort: ReasoningEffortId('high') } } as never,
      next,
    )

    expect(result).toEqual({ provider: 'deepseek', model: 'v4-pro', reasoningEffort: 'high' })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('clears a fork-inherited effort when the task requested the default', async () => {
    const result = await applyTaskModelReasoningEffort(
      { options: { taskModelReasoningEffort: null } } as never,
      () => Promise.resolve({
        provider: 'deepseek',
        model: 'v4-pro',
        reasoningEffort: ReasoningEffortId('high'),
      }),
    )
    expect(result).toEqual({ provider: 'deepseek', model: 'v4-pro' })
  })

  it('preserves the request when the plugin did not select an effort', async () => {
    const config = { provider: 'deepseek', model: 'v4-pro' }
    const result = await applyTaskModelReasoningEffort(
      { options: {} } as never,
      () => Promise.resolve(config),
    )
    expect(result).toBe(config)
  })
})

describe('task_models', () => {
  it('lists providers with model counts when unfiltered', async () => {
    const { deps } = setup()
    const { taskModels } = createTools(deps as never, config)

    const value = await (taskModels as never as { execute: (a: unknown, e: unknown) => Promise<string> })
      .execute({}, {})

    expect(JSON.parse(value)).toEqual({
      providers: [
        { id: 'deepseek', name: 'DeepSeek', modelCount: 2 },
        { id: 'openrouter', name: 'OpenRouter', modelCount: 1 },
      ],
    })
  })

  it('filters by provider and includes reasoning efforts', async () => {
    const { deps } = setup()
    const { taskModels } = createTools(deps as never, config)

    const value = await (taskModels as never as { execute: (a: unknown, e: unknown) => Promise<string> })
      .execute({ provider: 'deepseek' }, {})

    const parsed = JSON.parse(value)
    expect(parsed.models).toHaveLength(2)
    expect(parsed.models[0]).toMatchObject({
      provider: 'deepseek',
      id: 'v4-pro',
      reasoningEfforts: ['low', 'high'],
    })
    expect(parsed.remaining).toBe(0)
  })

  it('rejects an unknown provider filter', async () => {
    const { deps } = setup()
    const { taskModels } = createTools(deps as never, config)

    await expect(
      (taskModels as never as { execute: (a: unknown, e: unknown) => Promise<unknown> })
        .execute({ provider: 'missing' }, {}),
    ).rejects.toThrow(/Unknown provider/)
  })
})

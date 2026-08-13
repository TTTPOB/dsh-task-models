import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'
import {
  applyTaskModelReasoningEffort,
  createTaskModelsTool,
  parseModel,
  resolveChildOptions,
} from '../src/index.js'
import type { LlmCallConfig, LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

function model(provider: string, id: string, name = id): LlmModelInfo {
  return { provider, id, name }
}

function resolved(provider: string, id: string, efforts: string[] = []): LlmResolvedModelInfo {
  return {
    provider,
    id,
    name: id,
    ...(efforts.length === 0
      ? {}
      : { reasoning: { efforts: efforts.map(effort => ({ id: ReasoningEffortId(effort), name: effort })) } }),
  }
}

function llm() {
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
  const resolveCallConfig = vi.fn(async (config: LlmCallConfig) => config)
  return { listProviders, listModels, resolveModelInfo, resolveCallConfig }
}

function parent(
  provider = 'deepseek',
  modelId = 'v4-pro',
  header?: { config: LlmCallConfig; adapterDefaults?: { reasoningEffort?: true } },
) {
  return {
    options: { provider, model: modelId, maxTokens: 4096 },
    session: { requestHeader: () => header },
  }
}

describe('plugin export shape', () => {
  it('keeps Cordis metadata on a namespace with no default export', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('task-model-routing')
    expect(plugin.inject).toEqual(['tools', 'llm'])
    expect(typeof plugin.apply).toBe('function')
  })
})

describe('model selection', () => {
  it('splits provider/model-id on the first slash', () => {
    expect(parseModel('openrouter/anthropic/claude-sonnet-4.6')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
    })
  })

  it('rejects malformed model values', () => {
    expect(() => parseModel('deepseek')).toThrow(/Invalid model/)
    expect(() => parseModel('/model')).toThrow(/Invalid model/)
    expect(() => parseModel('provider/')).toThrow(/Invalid model/)
  })

  it('resolves an explicit per-call model and effort over static defaults', async () => {
    const runtime = llm()
    const options = await resolveChildOptions(
      runtime,
      parent() as never,
      { model: 'openrouter/vendor/model', reasoning_effort: 'high' },
      { provider: 'deepseek', model: 'configured', maxTokens: 8192 },
    )
    expect(runtime.resolveCallConfig).toHaveBeenCalledWith({
      provider: 'openrouter',
      model: 'vendor/model',
      reasoningEffort: 'high',
    }, undefined)
    expect(options).toEqual({
      provider: 'openrouter',
      model: 'vendor/model',
      maxTokens: 8192,
      taskModelReasoningEffort: 'high',
    })
  })

  it('inherits the caller active route and explicit effort', async () => {
    const runtime = llm()
    const options = await resolveChildOptions(
      runtime,
      parent('deepseek', 'old', {
        config: {
          provider: 'openrouter',
          model: 'active/model',
          reasoningEffort: ReasoningEffortId('high'),
        },
      }) as never,
      {},
      undefined,
    )
    expect(options).toMatchObject({
      provider: 'openrouter',
      model: 'active/model',
      taskModelReasoningEffort: 'high',
    })
  })

  it('does not freeze an adapter default as an explicit child effort', async () => {
    const runtime = llm()
    const options = await resolveChildOptions(
      runtime,
      parent('deepseek', 'v4-pro', {
        config: {
          provider: 'deepseek',
          model: 'v4-pro',
          reasoningEffort: ReasoningEffortId('high'),
        },
        adapterDefaults: { reasoningEffort: true },
      }) as never,
      {},
      undefined,
    )
    expect(options.taskModelReasoningEffort).toBeNull()
    expect(runtime.resolveCallConfig).toHaveBeenCalledWith({ provider: 'deepseek', model: 'v4-pro' }, undefined)
  })

  it('rejects an unsupported effort before delegation', async () => {
    const runtime = llm()
    runtime.resolveCallConfig.mockRejectedValue(new Error('unsupported effort'))
    await expect(resolveChildOptions(
      runtime,
      parent() as never,
      { reasoning_effort: 'impossible' },
      undefined,
    )).rejects.toThrow(/unsupported effort/)
  })
})

describe('request hook', () => {
  it('writes an explicit effort after downstream listeners', async () => {
    const result = await applyTaskModelReasoningEffort(
      { options: { taskModelReasoningEffort: ReasoningEffortId('high') } } as never,
      () => Promise.resolve({
        provider: 'deepseek',
        model: 'v4-pro',
        reasoningEffort: ReasoningEffortId('low'),
      }),
    )
    expect(result.reasoningEffort).toBe('high')
  })

  it('clears fork-inherited effort for default selection', async () => {
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
})

describe('task_models', () => {
  it('lists provider counts when unfiltered', async () => {
    const tool = createTaskModelsTool(llm()) as never as {
      execute: (args: unknown, exec: unknown) => Promise<string>
    }
    expect(JSON.parse(await tool.execute({}, {}))).toEqual({
      providers: [
        { id: 'deepseek', name: 'DeepSeek', modelCount: 2 },
        { id: 'openrouter', name: 'OpenRouter', modelCount: 1 },
      ],
    })
  })

  it('lists matching models and efforts', async () => {
    const tool = createTaskModelsTool(llm()) as never as {
      execute: (args: unknown, exec: unknown) => Promise<string>
    }
    const value = JSON.parse(await tool.execute({ provider: 'deepseek', query: 'pro' }, {}))
    expect(value.models).toEqual([
      { provider: 'deepseek', id: 'v4-pro', name: 'v4-pro', reasoningEfforts: ['low', 'high'] },
    ])
    expect(value.remaining).toBe(0)
  })
})

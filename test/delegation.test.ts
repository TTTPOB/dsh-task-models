import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as delegation from '../src/delegation.js'
import {
  assertProviderCompatibility,
  configForScopedShadow,
  createDelegationTool,
  providerWording,
  resolveDelegationRun,
  settleForegroundRun,
} from '../src/delegation.js'
import type { SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent'

function provider(inheritsParentContext = false, continuable = true): SubagentProvider {
  return {
    name: inheritsParentContext ? 'fork' : 'spawn',
    inheritsParentContext,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    start: vi.fn(),
    ...(continuable ? { prepareContinuable: vi.fn(async () => ({})) } : {}),
  }
}

function run(output: unknown[] = [{ type: 'text', text: 'done' }]): SubagentRun {
  return {
    id: 'child-1',
    result: Promise.resolve({ output, stopReason: 'completed' }),
    dispose: vi.fn(async () => {}),
  } as unknown as SubagentRun
}

function harness(options?: { jobs?: { start: ReturnType<typeof vi.fn> } }) {
  const resolveChildOptions = vi.fn(async () => ({
    provider: 'deepseek',
    model: 'v4-pro',
    taskModelReasoningEffort: 'high',
  }))
  const start = vi.fn(async () => run())
  const startContinuable = vi.fn(async () => ({ childId: 'continuable-1', messageId: 'message-1' }))
  const ctx = {
    taskModelRouting: { resolveChildOptions },
    subagents: { start, startContinuable },
    get: (name: string) => name === 'jobs' ? options?.jobs : undefined,
  }
  const parent = {
    options: { provider: 'deepseek', model: 'v4-pro' },
    session: { requestHeader: () => undefined },
  }
  const exec = { agent: parent, signal: new AbortController().signal }
  return { ctx, parent, exec, resolveChildOptions, start, startContinuable }
}

function execute(tool: unknown, args: unknown, exec: unknown): Promise<unknown> {
  return (tool as { execute: (args: unknown, exec: unknown) => Promise<unknown> }).execute(args, exec)
}

const ScopeOwnerFixture = Object.assign(() => {}, { inject: ['tools', 'systemPrompt'] })

class AgentPresetsFixture extends Service {
  constructor(ctx: Context) { super(ctx, 'agentPresets') }
}

class TaskModelRoutingFixture extends Service {
  constructor(ctx: Context) { super(ctx, 'taskModelRouting') }

  async resolveChildOptions(): Promise<Record<string, string>> {
    return { provider: 'deepseek', model: 'v4-pro' }
  }
}

function nativeDelegationTool(name: string, continuable: boolean) {
  return defineTool({
    name,
    description: 'native fixture',
    parameters: {
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
      run_in_background: {
        type: 'boolean',
        description: continuable ? 'Defaults to true.' : 'Defaults to false.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() { return 'native' },
  })
}

async function scopedHarness(restrict = false, latePresets = false) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SubagentRuntime)
  if (!latePresets) await ctx.plugin(AgentPresetsFixture)
  await ctx.plugin(TaskModelRoutingFixture)
  const providerDescriptor = provider(true)
  const disposeProvider = ctx.subagents.registerProvider(providerDescriptor)

  const scopeOwner = ctx.plugin(ScopeOwnerFixture)
  await scopeOwner
  const presetKey = {}
  const preset = createScope(scopeOwner.ctx, presetKey)
  const disposeNative = preset.ctx.tools.register(nativeDelegationTool('subagent_fork', true))
  preset.ctx.systemPrompt.section({
    name: 'tool:subagent_fork',
    order: 116.5,
    text: 'native preset fork guidance',
  })

  await ctx.plugin(delegation, {
    provider: 'fork',
    toolName: 'subagent_fork',
    backgroundMode: 'one-shot',
    maxDepth: 3,
  })
  if (latePresets) await ctx.plugin(AgentPresetsFixture)

  const id = SessionId(restrict ? 'restricted-agent' : 'visible-agent')
  const agent = {
    id,
    options: { provider: 'deepseek', model: 'v4-pro' },
    session: { id, requestHeader: () => undefined },
  } as unknown as Agent
  const agentScope = createScope(scopeOwner.ctx, agent)
  const presetBinding = bindScopeParent(agent, presetKey)
  const agentCtx = agentScope.ctx.extend({ agent })
  Object.assign(agent, { ctx: agentCtx })
  if (restrict) agentCtx.tools.restrict({ deny: ['subagent_fork'] })
  const disposeAgent = ctx.agents.register(agent)
  return {
    ctx,
    agent,
    disposeAgent,
    disposeProvider,
    providerDescriptor,
    disposeNative,
    preset,
    presetBinding,
    scopeOwner,
    agentScope,
  }
}

describe('delegation export shape', () => {
  it('keeps Cordis metadata and Config without a default export', () => {
    expect('default' in delegation).toBe(false)
    expect(delegation.name).toBe('enhanced-tool-subagent')
    expect(delegation.inject).toEqual(['agents', 'tools', 'subagents', 'systemPrompt', 'taskModelRouting'])
    expect(delegation.Config).toBeDefined()
    expect(typeof delegation.apply).toBe('function')
  })
})

describe('preset-scoped replacement', () => {
  it('shadows a preset tool in the agent scope and preserves continuable fork mode', async () => {
    const mounted = await scopedHarness()
    try {
      const schema = mounted.ctx.tools.schemas(mounted.agent).find(tool => tool.name === 'subagent_fork')
      const properties = (schema?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      expect(Object.keys(properties)).toEqual([
        'description', 'prompt', 'run_in_background', 'model', 'reasoning_effort',
      ])
      expect((properties.run_in_background as { description: string }).description).toContain('Defaults to true')
      const prompt = await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })
      expect(prompt.sections.find(section => section.name === 'tool:subagent_fork')?.text)
        .toBe('native preset fork guidance')
    } finally {
      mounted.disposeAgent()
      mounted.disposeProvider()
      await mounted.agentScope.dispose()
      await mounted.preset.dispose()
    }
  })

  it('switches from global to scoped mode when agentPresets loads later', async () => {
    const mounted = await scopedHarness(false, true)
    try {
      expect(mounted.ctx.tools.get('subagent_fork')).toBeUndefined()
      const schema = mounted.ctx.tools.schemas(mounted.agent).find(tool => tool.name === 'subagent_fork')
      const properties = (schema?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      expect(properties).toHaveProperty('model')
      expect(properties).toHaveProperty('reasoning_effort')
    } finally {
      mounted.disposeAgent()
      mounted.disposeProvider()
      await mounted.agentScope.dispose()
      await mounted.preset.dispose()
    }
  })

  it('does not restore a preset tool removed by a child restriction', async () => {
    const mounted = await scopedHarness(true)
    try {
      expect(mounted.ctx.tools.schemas(mounted.agent).some(tool => tool.name === 'subagent_fork')).toBe(false)
    } finally {
      mounted.disposeAgent()
      mounted.disposeProvider()
      await mounted.agentScope.dispose()
      await mounted.preset.dispose()
    }
  })

  it('drops the shadow after preset recompose removes the native capability', async () => {
    const mounted = await scopedHarness()
    const emptyPresetKey = {}
    const emptyPreset = createScope(mounted.scopeOwner.ctx, emptyPresetKey)
    try {
      mounted.presetBinding.rebind(emptyPresetKey)
      mounted.ctx.emit('agent-preset/selected', mounted.agent.id, 'minimal')
      expect(mounted.ctx.tools.schemas(mounted.agent).some(tool => tool.name === 'subagent_fork')).toBe(false)
    } finally {
      mounted.disposeAgent()
      mounted.disposeProvider()
      await mounted.agentScope.dispose()
      await emptyPreset.dispose()
      await mounted.preset.dispose()
    }
  })

  it('resynchronizes after provider HMR regardless of native listener order', async () => {
    const mounted = await scopedHarness()
    try {
      mounted.disposeProvider()
      mounted.disposeNative()
      const replacement = provider(true)
      const disposeReplacement = mounted.ctx.subagents.registerProvider(replacement)
      mounted.preset.ctx.tools.register(nativeDelegationTool('subagent_fork', true))
      await Promise.resolve()
      const schema = mounted.ctx.tools.schemas(mounted.agent).find(tool => tool.name === 'subagent_fork')
      const properties = (schema?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      expect(properties).toHaveProperty('model')
      expect(properties).toHaveProperty('reasoning_effort')
      disposeReplacement()
    } finally {
      mounted.disposeAgent()
      await mounted.agentScope.dispose()
      await mounted.preset.dispose()
    }
  })
})

describe('native wording and scheduling', () => {
  it('uses standalone wording for spawn and completed-history wording for fork', () => {
    expect(providerWording(false).description).toMatch(/does not see this conversation/)
    expect(providerWording(true).description).toMatch(/completed turns/)
    expect(providerWording(true).description).toMatch(/current in-flight turn/)
  })

  it('rejects providers that cannot honor depth or continuable guarantees', () => {
    const base = provider(false, false)
    const incapable = {
      ...base,
      capabilities: { ...base.capabilities, depthLimit: false },
    }
    expect(() => assertProviderCompatibility(incapable, {
      provider: 'remote',
      maxDepth: 3,
    })).toThrow(/cannot enforce maxDepth/)
    expect(() => assertProviderCompatibility(provider(false, false), {
      provider: 'spawn',
      maxDepth: 'provider-managed',
      backgroundMode: 'continuable',
    })).toThrow(/does not support backgroundMode/)
  })

  it('derives the scoped preset scheduling contract before shadowing', () => {
    const h = harness()
    const continuableTool = createDelegationTool(h.ctx as never, {
      provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable',
    }, provider(true))
    expect(configForScopedShadow({
      provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'one-shot',
    }, continuableTool).backgroundMode).toBe('continuable')

    const foregroundOnly = createDelegationTool(h.ctx as never, {
      provider: 'fork', toolName: 'subagent_fork', enableRunInBackground: false,
    }, provider(true))
    expect(configForScopedShadow({ provider: 'fork' }, foregroundOnly)).toMatchObject({
      enableRunInBackground: false,
      backgroundMode: 'one-shot',
    })
  })

  it('preserves the native run_in_background matrix', () => {
    expect(resolveDelegationRun({}, { backgroundEnabled: true, continuable: false })).toEqual({ runInBackground: false })
    expect(resolveDelegationRun({}, { backgroundEnabled: true, continuable: true })).toEqual({ runInBackground: true })
    expect(resolveDelegationRun({ run_in_background: false }, { backgroundEnabled: true, continuable: true }))
      .toEqual({ runInBackground: false })
    expect(() => resolveDelegationRun(
      { run_in_background: true },
      { backgroundEnabled: false, continuable: false },
    )).toThrow(/disabled/)
  })
})

describe('enhanced delegation execution', () => {
  it('preserves the native output union, rendering, and concurrency declaration', () => {
    const h = harness()
    const tool = createDelegationTool(h.ctx as never, {
      provider: 'spawn',
      toolName: 'subagent',
      backgroundMode: 'continuable',
    }, provider()) as never as {
      parameters: { properties: Record<string, unknown> }
      output: {
        schema: { oneOf: Array<{ properties: { kind: { const: string } } }> }
        render: (args: unknown, value: unknown) => unknown
      }
      isConcurrencySafe: (args: unknown) => boolean
    }
    expect(Object.keys(tool.parameters.properties)).toEqual([
      'description', 'prompt', 'run_in_background', 'model', 'reasoning_effort',
    ])
    expect(tool.output.schema.oneOf.map(branch => branch.properties.kind.const))
      .toEqual(['background', 'continuable', 'foreground'])
    expect(tool.isConcurrencySafe({ description: 'd', prompt: 'p' })).toBe(true)
    expect(tool.output.render({}, { kind: 'continuable', subagentId: 'child-9' }))
      .toEqual([{ type: 'text', text: 'started subagent child-9' }])
  })

  it('omits disabled background input and rejects a forced true value', async () => {
    const h = harness()
    const tool = createDelegationTool(h.ctx as never, {
      provider: 'spawn',
      toolName: 'subagent',
      enableRunInBackground: false,
    }, provider()) as never as {
      parameters: { properties: Record<string, unknown> }
      execute: (args: unknown, exec: unknown) => Promise<unknown>
    }
    expect(tool.parameters.properties).not.toHaveProperty('run_in_background')
    await expect(tool.execute({
      description: 'd', prompt: 'p', run_in_background: true,
    }, h.exec)).rejects.toThrow(/disabled/)
    expect(h.resolveChildOptions).not.toHaveBeenCalled()
  })

  it('adds model and reasoning_effort to the continuable native tool', async () => {
    const h = harness()
    const tool = createDelegationTool(h.ctx as never, {
      provider: 'spawn',
      toolName: 'subagent',
      backgroundMode: 'continuable',
      maxDepth: 3,
    }, provider())

    const result = await execute(tool, {
      description: 'review auth',
      prompt: 'review it',
      model: 'deepseek/v4-pro',
      reasoning_effort: 'high',
    }, h.exec)

    expect(h.resolveChildOptions).toHaveBeenCalledWith(
      h.parent,
      expect.objectContaining({ model: 'deepseek/v4-pro', reasoning_effort: 'high' }),
      undefined,
      h.exec.signal,
    )
    expect(h.startContinuable).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'spawn',
      label: 'review auth',
      request: expect.objectContaining({
        agentOptions: expect.objectContaining({ taskModelReasoningEffort: 'high' }),
        maxDepth: 3,
      }),
      signal: h.exec.signal,
    }))
    expect(result).toEqual({ kind: 'continuable', subagentId: 'continuable-1' })
  })

  it('uses the foreground path when continuable run_in_background is false', async () => {
    const h = harness()
    const child = run([{ type: 'text', text: 'answer' }, { type: 'reasoning', text: 'hidden' }])
    h.start.mockResolvedValue(child)
    const tool = createDelegationTool(h.ctx as never, {
      provider: 'spawn',
      toolName: 'subagent',
      backgroundMode: 'continuable',
    }, provider())

    const result = await execute(tool, {
      description: 'd',
      prompt: 'p',
      run_in_background: false,
    }, h.exec)

    expect(h.startContinuable).not.toHaveBeenCalled()
    expect(h.start).toHaveBeenCalledWith('spawn', expect.objectContaining({ signal: h.exec.signal }))
    expect(result).toEqual({
      kind: 'foreground',
      runId: 'child-1',
      output: [{ type: 'text', text: 'answer' }, { type: 'reasoning', text: 'hidden' }],
    })
    expect(child.dispose).toHaveBeenCalledTimes(1)
  })

  it('keeps fork one-shot foreground by default', async () => {
    const h = harness()
    const tool = createDelegationTool(h.ctx as never, {
      provider: 'fork',
      toolName: 'subagent_fork',
      backgroundMode: 'one-shot',
    }, provider(true))
    const result = await execute(tool, { description: 'd', prompt: 'p' }, h.exec)
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.startContinuable).not.toHaveBeenCalled()
    expect(result).toMatchObject({ kind: 'foreground', runId: 'child-1' })
  })

  it('starts one-shot background work only inside the job producer', async () => {
    let producer: (() => { done: Promise<unknown> }) | undefined
    const jobs = {
      start: vi.fn((spec: { run: () => { done: Promise<unknown> } }) => {
        producer = spec.run
        return 'subagent-1'
      }),
    }
    const h = harness({ jobs })
    const tool = createDelegationTool(h.ctx as never, {
      provider: 'fork',
      toolName: 'subagent_fork',
      backgroundMode: 'one-shot',
    }, provider(true))

    const result = await execute(tool, {
      description: 'd',
      prompt: 'p',
      run_in_background: true,
    }, h.exec)

    expect(result).toEqual({ kind: 'background', jobId: 'subagent-1' })
    expect(h.start).not.toHaveBeenCalled()
    expect(producer).toBeDefined()
    const started = producer?.()
    expect(h.start).toHaveBeenCalledTimes(1)
    await started?.done
  })

  it('reports missing Jobs only for one-shot background execution', async () => {
    const h = harness()
    const tool = createDelegationTool(h.ctx as never, {
      provider: 'fork',
      toolName: 'subagent_fork',
      backgroundMode: 'one-shot',
    }, provider(true))
    await expect(execute(tool, {
      description: 'd',
      prompt: 'p',
      run_in_background: true,
    }, h.exec)).rejects.toThrow(/background jobs unavailable/)
    expect(h.start).not.toHaveBeenCalled()
  })

  it('validates model selection before creating a continuable child or job', async () => {
    const jobs = { start: vi.fn() }
    const h = harness({ jobs })
    h.resolveChildOptions.mockRejectedValue(new Error('unsupported effort'))
    const tool = createDelegationTool(h.ctx as never, {
      provider: 'spawn',
      toolName: 'subagent',
      backgroundMode: 'continuable',
    }, provider())

    await expect(execute(tool, {
      description: 'd',
      prompt: 'p',
      reasoning_effort: 'bad',
    }, h.exec)).rejects.toThrow(/unsupported effort/)
    expect(h.start).not.toHaveBeenCalled()
    expect(h.startContinuable).not.toHaveBeenCalled()
    expect(jobs.start).not.toHaveBeenCalled()
  })

  it('settles and disposes a foreground failure while preserving partial text', async () => {
    const child = {
      id: 'child-2',
      result: Promise.resolve({
        output: [{ type: 'text', text: 'partial' }],
        stopReason: 'max-tokens',
      }),
      dispose: vi.fn(async () => {}),
    } as unknown as SubagentRun
    await expect(settleForegroundRun(child)).rejects.toThrow(/token limit[\s\S]*partial/)
    expect(child.dispose).toHaveBeenCalledTimes(1)
  })
})

import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { DshRobotAdapter, probeDsh } from '../../packages/robot/src/adapters/dsh/index.ts';
import type { DshRobotBinding, RobotRuntimePolicy, RobotAgentIdentity } from '../../packages/robot/src/adapters/dsh/index.ts';

const binding: DshRobotBinding = {
  robotId: 'review', revisionId: 'v1-hash', presetId: 'robot-review-v1-hash', name: 'Reviewer', cwd: '/tmp/repo',
  model: { provider: 'fake', model: 'review-model' },
};

function fixture(hasDelegation = true) {
  const lifecycle = new Set<(value: { agent: Agent; source: string }) => Promise<void>>();
  const selected = new Set<(sessionId: string, presetId: string) => void>();
  const guards: Array<(exec: ToolExecution) => string | undefined> = [];
  const steps: Array<(input: { agent: Agent; modelSelection: ModelSelection }, next: () => Promise<{ kind: 'enter'; messages: [] }>) => Promise<unknown>> = [];
  const agents = new Map<string, Agent>();
  const disposers = vi.fn(async () => {});
  let sequence = 0;
  const instantiate = async (preset: string | undefined, origin?: 'subagent') => {
    const id = `session-${++sequence}`;
    const scoped = {
      tools: { guard: vi.fn((guard: typeof guards[number]) => { guards.push(guard); return vi.fn(); }) },
      on: vi.fn((_event: string, fn: typeof steps[number]) => { steps.push(fn); return vi.fn(); }),
    };
    const agent = { id, ctx: scoped, session: { header: { agentPreset: preset, origin } }, model: { select: vi.fn() } } as unknown as Agent;
    agents.set(id, agent);
    for (const listener of lifecycle) await listener({ agent, source: 'startup' });
    return agent;
  };
  const services = {
    agentPresets: { register: vi.fn(async () => disposers), resolve: vi.fn(async (id: string) => ({ id, broken: undefined as string | undefined })), presetForSession: vi.fn((session: Agent['session']) => session.header.agentPreset ?? null) },
    agents: { get: vi.fn((id: string) => agents.get(id)) },
    sessionController: { create: vi.fn(async (request: { agentPreset: string }) => {
      const agent = await instantiate(request.agentPreset);
      return { sessionId: agent.id, agentPreset: request.agentPreset };
    }), selectModel: vi.fn() },
    subagents: { startActivation: vi.fn(async (spec: { agentPreset: string }) => {
      const agent = await instantiate(spec.agentPreset, 'subagent');
      return { childId: agent.id, name: 'child', result: Promise.resolve({}), dispose: vi.fn() };
    }) },
    tools: { guard: vi.fn() },
  };
  const ctx = { ...services,
    get: (name: keyof typeof services) => name === 'subagents' && !hasDelegation ? undefined : services[name],
    on: (event: string, listener: any) => {
      if (event === 'agent/created') lifecycle.add(listener);
      if (event === 'agent-preset/selected') selected.add(listener);
      return () => { lifecycle.delete(listener); selected.delete(listener); };
    },
  } as unknown as Context;
  const policy: RobotRuntimePolicy = { decideTool: vi.fn(() => undefined), admitStep: vi.fn(() => undefined), onDenied: vi.fn() };
  const prepare = vi.fn(async (_binding: DshRobotBinding, _identity: RobotAgentIdentity) => policy);
  const adapter = new DshRobotAdapter(ctx, { hostVersion: '0.2.2-rc.3', prepareRun: prepare });
  const selectPreset = (agent: Agent, presetId: string) => { for (const listener of selected) listener(agent.id, presetId); };
  return { adapter, ctx, services, policy, prepare, guards, steps, agents, instantiate, disposers, selectPreset };
}

describe('DSH public adapter contract', () => {
  it('probes capabilities separately from the validated baseline version', () => {
    const f = fixture();
    expect(probeDsh(f.ctx, '0.3.0')).toMatchObject({ compatible: true, versionValidated: false });
    const incomplete = { get: () => undefined } as unknown as Context;
    expect(probeDsh(incomplete, '0.2.2-rc.3').missing).toContain('agentPresets');
  });

  it('creates an empty session with a fixed revision/model without modifying the global model default', async () => {
    const f = fixture();
    await f.adapter.register(binding, []);
    const created = await f.adapter.createSession(binding.presetId);
    const agent = f.agents.get(created.sessionId)!;
    expect(f.services.sessionController.create).toHaveBeenCalledWith({ cwd: '/tmp/repo', agentPreset: binding.presetId });
    expect(agent.model.select).toHaveBeenCalledWith(binding.model);
    expect(f.services.sessionController.selectModel).not.toHaveBeenCalled();
    expect(f.prepare).toHaveBeenCalledWith(binding, { agentId: created.sessionId, origin: 'session', resumed: false });
  });

  it('keeps direct robot sessions available when the optional spawn service is absent', async () => {
    const f = fixture(false);
    await f.adapter.register(binding, []);
    const session = await f.adapter.createSession(binding.presetId);
    expect(f.adapter.compatibility.delegationAvailable).toBe(false);
    await expect(f.adapter.spawn(binding.presetId, {
      parent: f.agents.get(session.sessionId)!, prompt: [], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'HOST_CAPABILITY_MISSING' });
  });

  it('uses independent spawn with explicit model and preset and prepares policy before publication returns', async () => {
    const f = fixture();
    await f.adapter.register(binding, []);
    const parent = await f.instantiate(undefined);
    const signal = new AbortController().signal;
    const activation = await f.adapter.spawn(binding.presetId, { parent, prompt: [{ type: 'text', text: 'review' }], signal });
    expect(f.services.subagents.startActivation).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'spawn', delivery: 'caller', agentPreset: binding.presetId, agentOptions: binding.model, parent, signal,
    }));
    expect(f.prepare).toHaveBeenLastCalledWith(binding, { agentId: activation.childId, origin: 'subagent', resumed: false });
    expect(f.guards).toHaveLength(1);
  });

  it('does not silently accept a registered but broken preset', async () => {
    const f = fixture();
    f.services.agentPresets.resolve.mockResolvedValue({ id: binding.presetId, broken: 'missing tool executor' });
    await expect(f.adapter.register(binding, [])).rejects.toMatchObject({ code: 'PRESET_BROKEN' });
    expect(f.disposers).toHaveBeenCalledOnce();
    await expect(f.adapter.createSession(binding.presetId)).rejects.toMatchObject({ code: 'REVISION_NOT_REGISTERED' });
  });

  it('preserves immutable binding snapshots and rejects duplicate revision replacement', async () => {
    const f = fixture();
    const mutable = structuredClone(binding);
    await f.adapter.register(mutable, []);
    (mutable.model as { model: string }).model = 'changed';
    await expect(f.adapter.register(binding, [])).rejects.toMatchObject({ code: 'DUPLICATE_REVISION' });
    await f.adapter.createSession(binding.presetId);
    expect(f.prepare.mock.calls[0]?.[0]).toEqual(binding);
  });

  it('checks native and nested tool execution and fails closed on a broken policy', async () => {
    const f = fixture();
    await f.adapter.register(binding, []);
    const result = await f.adapter.createSession(binding.presetId);
    const agent = f.agents.get(result.sessionId)!;
    const exec = { agent, name: 'robot_read_file', arguments: { path: 'a.ts' }, callId: 'inner', rootCallId: 'outer', parent: Symbol() } as unknown as ToolExecution;
    expect(f.guards[0]!(exec)).toBeUndefined();
    expect(f.policy.decideTool).toHaveBeenCalledWith({ name: exec.name, arguments: exec.arguments, callId: 'inner', rootCallId: 'outer', nested: true });
    vi.mocked(f.policy.decideTool).mockReturnValue('needs approval');
    expect(f.guards[0]!(exec)).toBe('needs approval');
    vi.mocked(f.policy.decideTool).mockImplementation(() => { throw new Error('unexpected'); });
    expect(f.guards[0]!(exec)).toBe('Robot policy evaluation failed');
  });

  it('rejects a UI model switch and a blocked phase before admitting any model step', async () => {
    const f = fixture();
    await f.adapter.register(binding, []);
    const created = await f.adapter.createSession(binding.presetId);
    const agent = f.agents.get(created.sessionId)!;
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [] as [] }));
    expect(await f.steps[0]!({ agent, modelSelection: { provider: 'fake', model: 'other' } }, next)).toEqual({ kind: 'reject' });
    vi.mocked(f.policy.admitStep).mockReturnValue('waiting_user');
    expect(await f.steps[0]!({ agent, modelSelection: { provider: 'fake', model: 'review-model' } }, next)).toEqual({ kind: 'reject' });
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves unrelated blank sessions untouched and active guards deny after adapter shutdown', async () => {
    const f = fixture();
    await f.instantiate(undefined);
    expect(f.prepare).not.toHaveBeenCalled();
    await f.adapter.register(binding, []);
    const created = await f.adapter.createSession(binding.presetId);
    await f.adapter.dispose();
    const agent = f.agents.get(created.sessionId)!;
    expect(f.guards[0]!({ agent } as ToolExecution)).toBe('Robot run is not ready');
    await expect(f.adapter.createSession(binding.presetId)).rejects.toMatchObject({ code: 'DISPOSED' });
  });

  it('guards a blank-session preset selection synchronously before asynchronous run preparation', async () => {
    const f = fixture();
    await f.adapter.register(binding, []);
    const agent = await f.instantiate(undefined);
    let release!: (value: RobotRuntimePolicy) => void;
    f.prepare.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    f.selectPreset(agent, binding.presetId);
    expect(f.guards).toHaveLength(1);
    const exec = { agent, name: 'robot_state', callId: 'call', rootCallId: 'call' } as unknown as ToolExecution;
    expect(f.guards[0]!(exec)).toBe('Robot run is not ready');
    release(f.policy);
    await Promise.resolve();
    expect(f.guards[0]!(exec)).toBeUndefined();
    f.selectPreset(agent, 'default');
    expect(f.guards[0]!(exec)).toBe('Robot run is not ready');
  });
});

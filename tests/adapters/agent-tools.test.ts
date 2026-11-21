import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition, ToolRegistrationOptions, ToolRunContext, ToolExecution } from '@deepseek-ai/dsh-tools';
import { apply, ROBOT_TOOL_NAMES } from '../../packages/robot/src/agent.ts';

function fixture() {
  const registrations = new Map<string, { tool: ToolDefinition; options: ToolRegistrationOptions }>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const guards: Array<(exec: ToolExecution) => string | undefined> = [];
  const management = { describePreset: vi.fn(() => 'Frozen knowledge {{do_not_interpolate}}'), executeAgentTool: vi.fn(async () => '{"status":"needs_input"}') };
  const ctx = {
    robotManagement: management,
    tools: { register: (tool: ToolDefinition, options: ToolRegistrationOptions) => { registrations.set(tool.name, { tool, options }); }, guard: (guard: typeof guards[number]) => { guards.push(guard); } },
    systemPrompt: { section: vi.fn() },
    agentPresets: { presetForSession: (session: { preset: string }) => session.preset },
    on: (event: string, handler: (...args: any[]) => unknown) => { handlers.set(event, handler); },
  };
  apply(ctx as unknown as Context, { presetId: 'robot-one-v1' });
  const restrict = vi.fn();
  const agent = { id: 'session-1', session: { preset: 'robot-one-v1' }, ctx: { tools: { restrict } } } as unknown as Agent;
  return { registrations, handlers, guards, management, ctx, agent, restrict };
}

describe('scoped robot proxy tools', () => {
  it('registers only the controlled capabilities and makes every call exclusive', () => {
    const f = fixture();
    expect([...f.registrations.keys()]).toEqual(ROBOT_TOOL_NAMES);
    for (const { tool } of f.registrations.values()) expect(tool.isConcurrencySafe?.({})).toBe(false);
    expect(f.guards[0]!({ name: 'bash' } as ToolExecution)).toContain('only expose');
    expect(f.guards[0]!({ name: 'robot_state' } as ToolExecution)).toBeUndefined();
  });

  it('restricts at the actual agent scope and keeps tools out of other presets', async () => {
    const f = fixture();
    f.handlers.get('agent/created')!({ agent: f.agent });
    await f.handlers.get('agent/pre-step')!({ agent: f.agent }, async () => ({ kind: 'enter' }));
    expect(f.restrict).toHaveBeenCalledOnce();
    expect(f.restrict).toHaveBeenCalledWith({ allow: ROBOT_TOOL_NAMES });
    const when = f.registrations.get('robot_state')!.options.when!;
    expect(when({ agent: f.agent } as Parameters<typeof when>[0])).toBe(true);
    const other = { session: { preset: 'default' } } as unknown as Agent;
    expect(when({ agent: other } as Parameters<typeof when>[0])).toBe(false);
    expect(f.ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({ interpolate: false, text: 'Frozen knowledge {{do_not_interpolate}}' }));
  });

  it('uses direct declared arguments, delegates cancellation, and concludes a successful pending question', async () => {
    const f = fixture();
    const concludeTurn = vi.fn();
    const signal = new AbortController().signal;
    const exec = { agent: f.agent, signal, concludeTurn } as unknown as ToolRunContext;
    const result = await f.registrations.get('robot_ask')!.tool.execute({ question: 'Which scope?' }, exec);
    expect(result).toBe('{"status":"needs_input"}');
    expect(f.management.executeAgentTool).toHaveBeenCalledWith('session-1', 'robot_ask', { question: 'Which scope?' }, signal);
    expect(concludeTurn).toHaveBeenCalledOnce();
  });

  it('declares exact draft and workflow keys and rejects missing required arguments', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const exec = { agent: f.agent, signal } as unknown as ToolRunContext;
    const draft = f.registrations.get('robot_save_draft')!.tool;
    expect(draft.parameters).toHaveProperty('properties.specJson.type', 'string');
    expect(draft.parameters).toHaveProperty('required', ['specJson']);
    expect(draft.parameters).not.toHaveProperty('properties.input');
    expect(f.registrations.get('robot_advance')!.tool.parameters).toHaveProperty('required', ['outcome']);
    await expect(draft.execute({ input: '{"name":"wrong shape"}' }, exec)).rejects.toThrow();
    await expect(f.registrations.get('robot_state')!.tool.execute({}, {} as ToolRunContext)).rejects.toThrow();
    expect(f.management.executeAgentTool).not.toHaveBeenCalled();
  });
});

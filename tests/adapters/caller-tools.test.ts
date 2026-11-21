import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { registerCallerTools } from '../../packages/robot/src/host/caller-tools.ts';

describe('main-Agent robot invocation tools', () => {
  it('forwards the exact live agent and cancellation, never accepts a caller-supplied principal', async () => {
    const registered = new Map<string, ToolDefinition>();
    const ctx = { tools: { register: (tool: ToolDefinition) => { registered.set(tool.name, tool); } } } as unknown as Context;
    const service = { catalogForAgent: vi.fn(() => []), invokeFromAgent: vi.fn(async () => ({ runId: 'r1' })), getAgentRun: vi.fn(() => ({ status: 'waiting_input' })), getAgentArtifact: vi.fn(async () => ({ artifacts: [] })), cancelAgentRun: vi.fn(() => ({ status: 'cancelled' })) };
    registerCallerTools(ctx, service);
    const agent = { id: 'parent' } as Agent;
    const signal = new AbortController().signal;
    const exec = { agent, signal } as ToolRunContext;
    expect(await registered.get('robot_invoke')!.execute({ robotId: 'review', prompt: 'review change' }, exec)).toBe('{"runId":"r1"}');
    expect(service.invokeFromAgent).toHaveBeenCalledWith(agent, 'review', 'review change', signal);
    await registered.get('robot_task_status')!.execute({ runId: 'r1' }, exec);
    await registered.get('robot_cancel')!.execute({ runId: 'r1' }, exec);
    await registered.get('robot_task_result')!.execute({ runId: 'r1', artifactKey: 'report' }, exec);
    expect(service.getAgentArtifact).toHaveBeenCalledWith(agent, 'r1', 'report');
    expect(service.getAgentRun).toHaveBeenCalledWith(agent, 'r1');
    expect(service.cancelAgentRun).toHaveBeenCalledWith(agent, 'r1');
    await expect(registered.get('robot_catalog')!.execute({}, { signal } as ToolRunContext)).rejects.toThrow();
    expect(service.catalogForAgent).not.toHaveBeenCalled();
  });
});

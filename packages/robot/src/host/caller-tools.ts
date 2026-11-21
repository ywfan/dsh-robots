import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools';

/** The host validates calling-agent ownership; a caller may never supply a human principal. */
export interface RobotCallerBridge {
  catalogForAgent(agent: Agent): unknown | Promise<unknown>;
  invokeFromAgent(agent: Agent, robotId: string, prompt: string, signal: AbortSignal): Promise<unknown>;
  getAgentRun(agent: Agent, runId: string): unknown | Promise<unknown>;
  getAgentArtifact(agent: Agent, runId: string, artifactKey: string): Promise<unknown>;
  cancelAgentRun(agent: Agent, runId: string): unknown | Promise<unknown>;
}

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
};
function serialize(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/** Global tools for a normal main Agent; scoped robot restrictions hide these from robot runs. */
export function registerCallerTools(ctx: Context, management: RobotCallerBridge): void {
  ctx.tools.register(defineTool({
    name: 'robot_catalog', description: 'List prepared published robots available to this calling Agent.', parameters: {}, output,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      if (!exec.agent) throw new ToolContextUnavailableError('robot_catalog requires an agent');
      exec.signal.throwIfAborted();
      return serialize(await management.catalogForAgent(exec.agent));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'robot_invoke', description: 'Start a prepared robot in an independent context. The robot may return needs_input or needs_confirmation; pass those decisions to the human owner. Never fabricate user approval.',
    parameters: {
      robotId: { type: 'string', required: true, description: 'Published robot identifier from robot_catalog.' },
      prompt: { type: 'string', required: true, description: 'Concrete task for the robot.' },
    }, output, isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!exec.agent) throw new ToolContextUnavailableError('robot_invoke requires an agent');
      exec.signal.throwIfAborted();
      return serialize(await management.invokeFromAgent(exec.agent, args.robotId, args.prompt, exec.signal));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'robot_task_result',
    description: 'Read a recorded artifact from this Agent’s robot run. Get its key with robot_task_status.',
    parameters: {
      runId: { type: 'string', required: true, description: 'Run identifier returned by robot_invoke.' },
      artifactKey: { type: 'string', required: true, description: 'Artifact key in the run evidence.' },
    },
    output,
    async execute(args, exec) {
      if (!exec.agent) throw new ToolContextUnavailableError('robot_task_result requires an agent');
      exec.signal.throwIfAborted();
      return serialize(await management.getAgentArtifact(exec.agent, args.runId, args.artifactKey));
    },
  }));
  for (const name of ['robot_task_status', 'robot_cancel'] as const) {
    ctx.tools.register(defineTool({
      name,
      description: name === 'robot_task_status' ? 'Read the current status, pending question and artifact keys of this Agent’s robot run.' : 'Cancel a robot run owned by this calling Agent.',
      parameters: { runId: { type: 'string', required: true, description: 'Run identifier returned by robot_invoke.' } },
      output, isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (!exec.agent) throw new ToolContextUnavailableError(`${name} requires an agent`);
        exec.signal.throwIfAborted();
        return serialize(await (name === 'robot_task_status'
          ? management.getAgentRun(exec.agent, args.runId)
          : management.cancelAgentRun(exec.agent, args.runId)));
      },
    }));
  }
}

import type { Context } from '@deepseek-ai/cordis';
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import type { RobotRuntimePolicy } from './contracts.ts';

export function sameModel(actual: Readonly<ModelSelection>, expected: Readonly<ModelSelection>): boolean {
  return actual.provider === expected.provider && actual.model === expected.model
    && actual.reasoningEffort === expected.reasoningEffort;
}

/** Install before any model turn; all children of run_code still pass the host guard. */
export function installRobotGuards(
  agent: Agent,
  expected: Readonly<ModelSelection>,
  currentPolicy: () => RobotRuntimePolicy | undefined,
): () => void {
  const ctx: Context = agent.ctx;
  const deny = (reason: string): string => {
    try { currentPolicy()?.onDenied?.(reason); } catch { /* diagnostics cannot permit an operation */ }
    return reason;
  };
  const guard = ctx.tools.guard(exec => {
    if (exec.agent !== agent) return deny('Robot execution identity mismatch');
    const policy = currentPolicy();
    if (!policy) return deny('Robot run is not ready');
    try {
      const reason = policy.decideTool({
        name: exec.name, arguments: exec.arguments,
        callId: exec.callId, rootCallId: exec.rootCallId, nested: exec.parent !== undefined,
      });
      return reason === undefined ? undefined : deny(reason);
    } catch { return deny('Robot policy evaluation failed'); }
  });
  const step = ctx.on('agent/pre-step', async ({ agent: current, modelSelection }, next) => {
    if (current !== agent) return { kind: 'reject' };
    if (!sameModel(modelSelection, expected)) {
      deny('Robot model selection differs from the published revision');
      return { kind: 'reject' };
    }
    const policy = currentPolicy();
    if (!policy) { deny('Robot run is not ready'); return { kind: 'reject' }; }
    try {
      const reason = policy.admitStep();
      if (reason !== undefined) { deny(reason); return { kind: 'reject' }; }
    } catch { deny('Robot step admission failed'); return { kind: 'reject' }; }
    return next();
  });
  return () => { step(); guard(); };
}

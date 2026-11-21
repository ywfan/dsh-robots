import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DshRobotAdapter } from '../../packages/robot/src/adapters/dsh/index.ts';

export const name = 'robot-compatibility-probe';
export const inject = ['agentPresets', 'agents', 'sessionController', 'subagents', 'tools'];

export function apply(ctx) {
  const report = { version: process.env.ROBOT_COMPAT_VERSION, checks: {}, errors: [], modelRequests: 0 };
  const bindings = [];
  let denyTools = false;
  ctx.on('session/event', (_session, event) => { if (event.type === 'request/header') report.modelRequests++; });
  async function run() {
    let adapter;
    try {
      adapter = new DshRobotAdapter(ctx, {
        hostVersion: report.version,
        prepareRun(binding, identity) {
          bindings.push({ binding, identity, model: ctx.agents.get(identity.agentId)?.model.current() });
          return { decideTool: () => denyTools ? 'compatibility-probe-denial' : undefined, admitStep: () => 'compatibility probe never contacts a model' };
        },
      });
      report.capabilities = adapter.compatibility;
      const binding = { robotId: 'compat', revisionId: 'immutable-v1', presetId: 'robot-compat-immutable-v1', name: 'Compatibility probe', cwd: process.env.ROBOT_COMPAT_WORKSPACE, model: { provider: 'robot-no-network', model: 'never-requested' } };
      await adapter.register(binding, [
        { id: 'probe-native-executor', name: '@deepseek-ai/dsh-tool-executor-native' },
        { id: 'probe-capability', name: join(process.env.ROBOT_COMPAT_ROOT, 'capability.mjs') },
      ]);
      report.checks.registerPreset = (await ctx.agentPresets.resolve(binding.presetId)).broken === undefined;
      const created = await adapter.createSession(binding.presetId);
      const agent = ctx.agents.get(created.sessionId);
      report.checks.createSession = Boolean(agent && created.presetId === binding.presetId);
      report.checks.modelBinding = agent?.model.current()?.model === binding.model.model;
      const signal = new AbortController().signal;
      const execute = id => ctx.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id, name: 'robot_probe', arguments: '{}' }] });
      const allowed = await execute('compat-allow');
      report.checks.nativeToolAllowed = allowed.results[0]?.result.isError === false;
      denyTools = true;
      const denied = await execute('compat-deny');
      report.checks.finalGuardDenied = denied.results[0]?.result.isError === true;
      denyTools = false;
      const child = await adapter.spawn(binding.presetId, { parent: agent, prompt: [{ type: 'text', text: 'Do not run a model. Admission is denied by the host.' }], signal });
      report.checks.spawnIndependentPreset = bindings.some(row => row.identity.agentId === child.childId && row.identity.origin === 'subagent' && row.binding.presetId === binding.presetId && row.model?.model === binding.model.model);
      const childResult = await child.result;
      report.childStopReason = childResult.stopReason;
      await child.dispose();
      report.checks.noModelRequest = report.modelRequests === 0;
      report.bindings = bindings.map(row => ({ origin: row.identity.origin, revisionId: row.binding.revisionId, model: row.model }));
      report.passed = Object.values(report.checks).every(Boolean);
    } catch (error) {
      report.errors.push({ name: error.name, code: error.code, message: error.message });
      report.passed = false;
    } finally {
      try { await adapter?.dispose(); } catch (error) { report.errors.push({ message: error.message }); report.passed = false; }
      await writeFile(process.env.ROBOT_COMPAT_REPORT, JSON.stringify(report, null, 2) + '\n');
    }
  }
  // Return from plugin activation first; preset diagnostics may wait for loader settlement.
  ctx.effect(() => { const timer = setTimeout(() => { void run(); }, 300); return () => clearTimeout(timer); });
}

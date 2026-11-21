import { isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand';
import type { DshAdapterOptions, DshRobotBinding, RobotRuntimePolicy } from './contracts.ts';
import { DshAdapterError } from './contracts.ts';
import { installRobotGuards } from './guards.ts';
import { requireDshCapabilities } from './probe.ts';

export * from './contracts.ts';
export * from './probe.ts';
export * from './guards.ts';

function modelSelection(binding: DshRobotBinding): ModelSelection {
  return { provider: binding.model.provider, model: binding.model.model,
    ...(binding.model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(binding.model.reasoningEffort) }) };
}

/** Keep the Cordis/DSH dependency surface in this module. The application owns durable revisions and runs. */
export class DshRobotAdapter {
  readonly compatibility;
  private readonly bindings = new Map<string, Readonly<DshRobotBinding>>();
  private readonly presetDisposers = new Map<string, () => Promise<void>>();
  private readonly attached = new WeakSet<Agent>();
  private readonly activePresets = new WeakMap<Agent, string>();
  private readonly stopCreated: () => void;
  private readonly stopSelected: () => void;
  private disposed = false;

  constructor(private readonly ctx: Context, private readonly options: DshAdapterOptions) {
    this.compatibility = requireDshCapabilities(ctx, options.hostVersion);
    const attach = async (agent: Agent, presetId: string | undefined, resumed: boolean) => {
      if (this.activePresets.has(agent)) {
        if (this.activePresets.get(agent) !== presetId) this.activePresets.set(agent, '');
        return;
      }
      const binding = presetId === undefined ? undefined : this.bindings.get(presetId);
      if (!binding) return;
      this.activePresets.set(agent, binding.presetId);
      let policy: RobotRuntimePolicy | undefined;
      const selected = modelSelection(binding);
      installRobotGuards(agent, selected, () => this.disposed || this.activePresets.get(agent) !== binding.presetId ? undefined : policy);
      agent.model.select(selected);
      policy = await options.prepareRun(binding, {
        agentId: agent.id,
        origin: agent.session.header.origin === 'subagent' ? 'subagent' : 'session',
        resumed,
      });
      if (!policy || typeof policy.decideTool !== 'function' || typeof policy.admitStep !== 'function') {
        throw new DshAdapterError('RUN_POLICY_MISSING', 'Robot run did not provide an execution policy');
      }
      this.attached.add(agent);
    };
    this.stopCreated = ctx.on('agent/created', async ({ agent, source }) => {
      const presetId = ctx.agentPresets.presetForSession(agent.session) ?? agent.session.header.agentPreset;
      await attach(agent, presetId, source === 'resume');
    });
    this.stopSelected = ctx.on('agent-preset/selected', (sessionId, presetId) => {
      const agent = ctx.agents.get(sessionId);
      if (!agent) return;
      // The host emits this event synchronously. attach installs a denying guard
      // before its first await, so a prompt cannot race run initialization.
      void attach(agent, presetId, false).catch(() => { this.activePresets.set(agent, ''); });
    });
  }

  /** plugins must be generated from trusted published content, never accepted verbatim from an imported robot. */
  async register(binding: DshRobotBinding, plugins: PresetDefinition['plugins']): Promise<void> {
    this.assertActive();
    if (!binding.robotId || !binding.revisionId || !binding.presetId || !binding.model.provider || !binding.model.model || !isAbsolute(binding.cwd)) {
      throw new DshAdapterError('INVALID_BINDING', 'Robot binding requires identifiers, a model route, and absolute cwd');
    }
    if (this.bindings.has(binding.presetId)) throw new DshAdapterError('DUPLICATE_REVISION', `Preset ${binding.presetId} is already registered`);
    const snapshot = Object.freeze({ ...binding, model: Object.freeze({ ...binding.model }) });
    this.bindings.set(binding.presetId, snapshot);
    let dispose: (() => Promise<void>) | undefined;
    try {
      dispose = await this.ctx.agentPresets.register({ id: binding.presetId, name: binding.name, description: binding.description, plugins });
      const resolved = await this.ctx.agentPresets.resolve(binding.presetId);
      if (resolved.broken !== undefined) throw new DshAdapterError('PRESET_BROKEN', `Robot preset ${binding.presetId}: ${resolved.broken}`);
      this.assertActive();
      this.presetDisposers.set(binding.presetId, dispose);
    } catch (error) {
      this.bindings.delete(binding.presetId);
      if (dispose) await dispose();
      throw error;
    }
  }

  /** Create an empty session. Prompt admission is separate so the caller can display the run before execution. */
  async createSession(presetId: string): Promise<{ sessionId: string; presetId: string }> {
    const binding = this.requireBinding(presetId);
    const created = await this.ctx.sessionController.create({ cwd: binding.cwd, agentPreset: presetId });
    const agent = this.ctx.agents.get(created.sessionId);
    if (!agent || !this.attached.has(agent) || created.agentPreset !== presetId) {
      throw new DshAdapterError('UNBOUND_SESSION', 'Host created a session without the expected robot policy');
    }
    return { sessionId: created.sessionId, presetId };
  }

  /** Compensate a prepared-but-unpublished revision after its durable publish CAS fails.
   * Existing live scopes keep their guards; durable published revisions must be
   * retired through application lifecycle rules, not this preparation helper.
   */
  async unregister(presetId: string): Promise<void> {
    this.assertActive();
    const dispose = this.presetDisposers.get(presetId);
    if (!dispose) {
      if (this.bindings.has(presetId)) throw new DshAdapterError('REGISTRATION_PENDING', 'Cannot unregister an unfinished preset registration');
      return;
    }
    await dispose();
    this.presetDisposers.delete(presetId);
    this.bindings.delete(presetId);
  }

  /** New independent context, explicit model and preset; approval requests travel back to the owning application. */
  async spawn(presetId: string, request: { parent: Agent; prompt: readonly ContentBlock[]; signal: AbortSignal; label?: string }): Promise<SubagentActivation> {
    const binding = this.requireBinding(presetId);
    request.signal.throwIfAborted();
    const subagents = this.ctx.get('subagents');
    if (typeof subagents?.startActivation !== 'function') throw new DshAdapterError('HOST_CAPABILITY_MISSING', 'This host cannot delegate robot tasks. Start the robot directly instead.');
    return subagents.startActivation({
      provider: this.options.spawnProvider ?? 'spawn', delivery: 'caller',
      label: request.label ?? binding.name, parent: request.parent,
      prompt: structuredClone([...request.prompt]), signal: request.signal,
      cwd: binding.cwd, agentPreset: presetId, agentOptions: modelSelection(binding),
    });
  }

  /** Runtime registration ends with its plugin owner; immutable revision files remain application-owned. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Keep existing live-agent guards installed until their scopes end.
    this.stopCreated();
    this.stopSelected();
    const results = await Promise.allSettled([...this.presetDisposers.values()].map(dispose => dispose()));
    this.presetDisposers.clear();
    this.bindings.clear();
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(r => r.reason), 'Robot preset disposal failed');
  }

  private assertActive(): void {
    if (this.disposed) throw new DshAdapterError('DISPOSED', 'Robot adapter has been disposed');
  }

  private requireBinding(id: string): Readonly<DshRobotBinding> {
    this.assertActive();
    const binding = this.bindings.get(id);
    if (!binding) throw new DshAdapterError('REVISION_NOT_REGISTERED', `Robot revision preset ${id} is not registered`);
    return binding;
  }
}

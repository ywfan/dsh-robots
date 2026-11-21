import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError, digest, type ActionAttempt, type Principal, type Run, type RobotSpec, RobotWorkflow } from '../domain/index.js';
export interface ControlledActionContext { runId: string; revisionId: string; actionId: string; idempotencyKey: string; signal: AbortSignal }
export interface ControlledActionResult { outcome: 'success' | 'failure'; reference: string }
/** Trusted host plugin contract, never model-supplied configuration or executable import. */
export interface ControlledAction {
  name: string;
  external: boolean;
  version?: string;
  validate(input: unknown): unknown;
  execute(input: unknown, context: ControlledActionContext): Promise<ControlledActionResult>;
  query?(input: unknown, context: ControlledActionContext): Promise<ControlledActionResult | undefined>;
}
interface PersistedActionInput { schemaVersion: 1; runId: string; revisionId: string; actionId: string; action: string; inputDigest: string; executorVersion: string; input: unknown }
/** One persistent payload per attempt; approvals and outcomes remain in the domain Run. */
export class RobotActionRegistry {
  private readonly handlers = new Map<string, ControlledAction>();
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly directory: string, private readonly workflow: RobotWorkflow, private readonly updated: (run: Run) => void) {}
  register(handler: ControlledAction): void {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(handler.name) || handler.name.startsWith('robot_') || this.handlers.has(handler.name)) throw new DomainError('INVALID', 'Action name is invalid, reserved, or already registered');
    if (typeof handler.external !== 'boolean' || typeof handler.validate !== 'function' || typeof handler.execute !== 'function') throw new DomainError('INVALID', 'Action handler must define validation and execution');
    this.handlers.set(handler.name, Object.freeze({ ...handler }));
  }
  names(): string[] { return [...this.handlers.keys()]; }
  validateSpec(spec: RobotSpec): void {
    for (const name of spec.workflow.steps.flatMap(s => s.allowedActions)) {
      const handler = this.handlers.get(name);
      if (handler?.external && !spec.externalActions.includes(name)) throw new DomainError('NOT_READY', `External executor ${name} must require explicit approval in this robot`);
    }
    for (const name of spec.externalActions) if (!this.handlers.has(name)) throw new DomainError('NOT_READY', `No controlled executor installed for ${name}`);
  }
  private file(run: Run, action: ActionAttempt): string { return join(this.directory, run.id, `${action.id}.json`); }
  private async payload(run: Run): Promise<PersistedActionInput> {
    const attempt = run.pendingAction; if (!attempt) throw new DomainError('BAD_STATE', 'No pending action');
    let record: PersistedActionInput;
    try { record = JSON.parse(await readFile(this.file(run, attempt), 'utf8')) as PersistedActionInput; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DomainError('NOT_READY', 'Action input is not durable; cancel and prepare a new attempt'); throw error; }
    if (record.schemaVersion !== 1 || record.runId !== run.id || record.revisionId !== run.revisionId || record.actionId !== attempt.id || record.action !== attempt.action || record.inputDigest !== attempt.inputDigest || digest(record.input) !== attempt.inputDigest) throw new DomainError('INVALID', 'Persisted action does not match the approved attempt');
    return record;
  }
  async detail(run: Run): Promise<{ attempt: ActionAttempt; input: unknown }> { const record = await this.payload(run); return { attempt: structuredClone(run.pendingAction!), input: structuredClone(record.input) }; }
  async prepare(principal: Principal, run: Run, spec: RobotSpec, name: string, input: unknown, summary: string): Promise<Run> {
    const handler = this.handlers.get(name); if (!handler) throw new DomainError('NOT_READY', `No controlled executor installed for ${name}`);
    if (!summary.trim() || summary.length > 4000) throw new DomainError('INVALID', 'A bounded concrete action summary is required');
    if (handler.external && !spec.externalActions.includes(name)) throw new DomainError('FORBIDDEN', 'This external executor was not declared as approval-required');
    let normalized: unknown;
    try { const validated = handler.validate(structuredClone(input)), json = JSON.stringify(validated); if (!json || json.length > 200_000) throw new Error('Action input must be bounded JSON'); normalized = JSON.parse(json); }
    catch (error) { throw new DomainError('INVALID', `Invalid action input: ${String(error)}`); }
    const next = await this.workflow.requestAction(principal, run.id, run.version, name, randomUUID(), { input: normalized, summary }); this.updated(next);
    const record: PersistedActionInput = { schemaVersion: 1, runId: next.id, revisionId: next.revisionId, actionId: next.pendingAction!.id, action: name, inputDigest: next.pendingAction!.inputDigest, executorVersion: handler.version ?? '1', input: normalized };
    const directory = join(this.directory, next.id); await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(this.file(next, next.pendingAction!), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    return next.pendingAction!.status === 'approved' ? this.dispatch(principal, next) : next;
  }
  private handler(record: PersistedActionInput): ControlledAction {
    const handler = this.handlers.get(record.action);
    if (!handler || (handler.version ?? '1') !== record.executorVersion) throw new DomainError('NOT_READY', 'The approved executor version is unavailable');
    return handler;
  }
  async dispatch(principal: Principal, original: Run): Promise<Run> {
    let run = await this.workflow.getRun(principal, original.id);
    if (run.pendingAction?.id !== original.pendingAction?.id || run.pendingAction?.status !== 'approved') throw new DomainError('BAD_STATE', 'Only the exact approved attempt may dispatch');
    const record = await this.payload(run), handler = this.handler(record), controller = new AbortController();
    // Persist dispatched before invoking user-owned code. A thrown error may follow a real side effect.
    run = await this.workflow.markDispatched(run.id, run.version, record.actionId, record.input); this.updated(run); this.active.set(run.id, controller);
    const context: ControlledActionContext = { runId: run.id, revisionId: run.revisionId, actionId: record.actionId, idempotencyKey: run.pendingAction!.idempotencyKey, signal: controller.signal };
    try {
      const result = await handler.execute(structuredClone(record.input), context);
      if (!result || !['success', 'failure'].includes(result.outcome) || !result.reference?.trim()) throw new Error('Executor returned no verifiable result receipt');
      const current = await this.workflow.getRun(principal, run.id);
      run = await this.workflow.resolveAction(current.id, current.version, record.actionId, result.outcome, result.reference); this.updated(run); return run;
    } catch (error) {
      const current = await this.workflow.getRun(principal, run.id);
      if (current.pendingAction?.status === 'dispatched') run = await this.workflow.markUncertain(current.id, current.version, `Executor outcome unknown: ${String(error)}`); else run = current;
      this.updated(run); return run;
    } finally { this.active.delete(run.id); }
  }
  async reconcile(principal: Principal, original: Run): Promise<Run> {
    let run = await this.workflow.getRun(principal, original.id);
    if (run.status !== 'uncertain' || run.pendingAction?.status !== 'uncertain') throw new DomainError('BAD_STATE', 'Only an uncertain action may be reconciled');
    const record = await this.payload(run), handler = this.handler(record);
    if (!handler.query) throw new DomainError('NOT_READY', 'This executor has no authoritative status query; no retry is allowed');
    const result = await handler.query(structuredClone(record.input), { runId: run.id, revisionId: run.revisionId, actionId: record.actionId, idempotencyKey: run.pendingAction.idempotencyKey, signal: new AbortController().signal });
    if (!result) return run;
    if (!['success','failure'].includes(result.outcome) || !result.reference?.trim()) throw new DomainError('INVALID', 'Reconciliation needs a verifiable result');
    const current = await this.workflow.getRun(principal, run.id);
    run = await this.workflow.resolveAction(current.id, current.version, record.actionId, result.outcome, result.reference); this.updated(run); return run;
  }
  cancel(runId: string): void { this.active.get(runId)?.abort(); }
}

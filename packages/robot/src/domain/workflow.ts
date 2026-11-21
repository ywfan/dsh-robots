import { digest } from './validation.js';
import { randomUUID } from 'node:crypto';
import { DomainError, type Principal, type RobotStore, type Run, type Revision, type RuntimeBinding, type ActionAttempt, type EvidenceReceipt } from './types.js';
/** All model-callable operations check persisted state. Host receipt methods must stay off tool/HTTP public surfaces. */
export class RobotWorkflow {
    constructor(private readonly store: RobotStore) { }
    private async context(id: string, version?: number) {
        const run = await this.store.readRun(id);
        if (!run)
            throw new DomainError('NOT_FOUND', 'Run not found');
        if (version !== undefined && run.version !== version)
            throw new DomainError('CONFLICT', 'Run changed; reload before retry');
        const aggregate = await this.store.readRobot(run.robotId);
        const revision = aggregate?.revisions.find(r => r.id === run.revisionId);
        if (!revision)
            throw new DomainError('NOT_FOUND', 'Pinned revision not found');
        const step = revision.spec.workflow.steps.find(s => s.id === run.stepId)!;
        return { run, revision, step };
    }
    private caller(principal: Principal, run: Run, human = false): void { if (principal.id !== run.principalId || (human && principal.kind !== 'human'))
        throw new DomainError('FORBIDDEN', human ? 'Caller’s human confirmation required' : 'Run belongs to another caller'); }
    private running(run: Run): void { if (run.status !== 'running')
        throw new DomainError('BAD_STATE', `Run is ${run.status}`); }
    private idle(run: Run): void { this.running(run); if (run.pendingAction)
        throw new DomainError('BAD_STATE', 'Finish or reconcile the pending action first'); }
    private async save(run: Run): Promise<Run> { const previous = run.version; run.version++; await this.store.saveRun(run, previous); return structuredClone(run); }
    async start(principal: Principal, robotId: string, revisionId?: string, binding?: RuntimeBinding, invokerId?: string): Promise<Run> {
        const value = await this.store.readRobot(robotId);
        if (!value)
            throw new DomainError('NOT_FOUND', 'Robot not found');
        if (value.robot.ownerId !== principal.id && !value.robot.invokePrincipalIds.includes(principal.id))
            throw new DomainError('FORBIDDEN', 'Invocation not shared with this principal');
        if (value.robot.disabled)
            throw new DomainError('NOT_READY', 'Robot is disabled');
        // Shared callers may invoke only the currently published version.
        if (revisionId && revisionId !== value.robot.currentRevisionId && principal.id !== value.robot.ownerId)
            throw new DomainError('FORBIDDEN', 'Historical version is not shared');
        const revision = value.revisions.find(r => r.id === (revisionId ?? value.robot.currentRevisionId));
        if (!revision)
            throw new DomainError('NOT_READY', 'Robot has no published revision');
        if (binding)
            this.validateBinding(revision, binding);
        const entry = revision.spec.workflow.entry;
        const run: Run = { id: randomUUID(), robotId, revisionId: revision.id, principalId: principal.id, ...(invokerId ? { invokerId } : {}), status: binding ? 'running' : 'preparing', stepId: entry, visits: { [entry]: 1 }, version: 1, evidence: [], actionHistory: [], questionHistory: [], ...(binding ? { binding: structuredClone(binding) } : {}) };
        await this.store.saveRun(run, null);
        return run;
    }
    private validateBinding(revision: Revision, binding: RuntimeBinding): void { if (!binding.sessionId || !binding.adapter || !binding.adapterVersion || !binding.harnessVersion || binding.provider !== revision.spec.model.provider || binding.model !== revision.spec.model.model)
        throw new DomainError('NOT_READY', 'Binding does not match the pinned model or lacks provenance'); }
    async getRun(principal: Principal, id: string): Promise<Run> { const { run } = await this.context(id); this.caller(principal, run); return run; }
    async listRuns(principal: Principal): Promise<Run[]> { return (await this.store.listRuns()).filter(r => r.principalId === principal.id); }
    async attachBinding(principal: Principal, id: string, version: number, binding: RuntimeBinding): Promise<Run> { const { run, revision } = await this.context(id, version); this.caller(principal, run); if (run.status !== 'preparing')
        throw new DomainError('BAD_STATE', 'Run already bound'); this.validateBinding(revision, binding); run.binding = structuredClone(binding); run.status = 'running'; return this.save(run); }
    async advance(principal: Principal, id: string, version: number, outcome: string): Promise<Run> {
        const { run, step, revision } = await this.context(id, version);
        this.caller(principal, run);
        this.idle(run);
        if (!Object.hasOwn(step.transitions, outcome))
            throw new DomainError('BAD_STATE', 'Unknown outcome; ask the user before changing the workflow');
        const receipts = run.evidence.filter(e => e.stepId === step.id && e.visit === run.visits[step.id] && e.outcome === 'success');
        for (const check of step.checks) {
            const present = receipts.some(e => check.kind === 'action-succeeded' ? e.kind === 'action-result' && e.key === check.action : check.kind === 'artifact' ? e.kind === 'artifact' && e.key === check.key : e.kind === 'human-confirmation' && e.key === check.id);
            if (!present)
                throw new DomainError('NOT_READY', `Check not satisfied: ${check.id}`);
        }
        const next = step.transitions[outcome];
        if (next === null)
            run.status = 'succeeded';
        else {
            const nextStep = revision.spec.workflow.steps.find(s => s.id === next)!;
            const visits = (run.visits[next!] ?? 0) + 1;
            if (visits > nextStep.maxVisits)
                throw new DomainError('BAD_STATE', 'Workflow visit limit reached; user decision required');
            run.stepId = next!;
            run.visits[next!] = visits;
        }
        return this.save(run);
    }
    async requestQuestion(principal: Principal, id: string, version: number, text: string): Promise<Run> { const { run } = await this.context(id, version); this.caller(principal, run); this.idle(run); if (!text.trim())
        throw new DomainError('INVALID', 'Question is empty'); run.pendingQuestion = { id: randomUUID(), text }; run.status = 'waiting-user'; return this.save(run); }
    async answerQuestion(principal: Principal, id: string, version: number, questionId: string, answer: string): Promise<Run> { const { run } = await this.context(id, version); this.caller(principal, run, true); if (run.status !== 'waiting-user' || run.pendingQuestion?.id !== questionId)
        throw new DomainError('BAD_STATE', 'Question is not current'); if (!answer.trim())
        throw new DomainError('INVALID', 'Answer is empty'); run.questionHistory.push({ ...run.pendingQuestion!, answer, answeredBy: principal.id }); delete run.pendingQuestion; run.status = 'running'; return this.save(run); }
    async confirmCheck(principal: Principal, id: string, version: number, checkId: string): Promise<Run> { const { run, step } = await this.context(id, version); this.caller(principal, run, true); this.idle(run); if (!step.checks.some(c => c.id === checkId && c.kind === 'human-confirmation'))
        throw new DomainError('INVALID', 'Unknown human check'); run.evidence.push(this.receipt(run, 'human-confirmation', checkId, 'success', `human:${principal.id}`)); return this.save(run); }
    /** Trusted host only: verify the actual artifact before recording, never relay model assertions. */
    async recordArtifact(id: string, version: number, key: string, reference: string): Promise<Run> { const { run, step } = await this.context(id, version); this.idle(run); if (!step.checks.some(c => c.kind === 'artifact' && c.key === key) || !reference.trim())
        throw new DomainError('INVALID', 'Unknown artifact check or empty reference'); run.evidence.push(this.receipt(run, 'artifact', key, 'success', reference)); return this.save(run); }
    private receipt(run: Run, kind: EvidenceReceipt['kind'], key: string, outcome: 'success' | 'failure', reference: string): EvidenceReceipt { return { id: randomUUID(), runId: run.id, stepId: run.stepId, visit: run.visits[run.stepId]!, kind, key, outcome, reference }; }
    async requestAction(principal: Principal, id: string, version: number, action: string, idempotencyKey: string, details: {
        input: unknown;
        summary: string;
    } = { input: null, summary: action }): Promise<Run> {
        const { run, revision, step } = await this.context(id, version);
        this.caller(principal, run);
        this.idle(run);
        if (!step.allowedActions.includes(action))
            throw new DomainError('FORBIDDEN', 'Action is not allowed in this step');
        if (!idempotencyKey.trim() || run.actionHistory.some(a => a.idempotencyKey === idempotencyKey))
            throw new DomainError('CONFLICT', 'Action key is empty or was already used; do not blindly repeat it');
        const external = revision.spec.externalActions.includes(action);
        run.pendingAction = { id: randomUUID(), action, idempotencyKey, inputDigest: digest(details.input), summary: details.summary, status: external ? 'awaiting-approval' : 'approved' };
        if (external)
            run.status = 'awaiting-approval';
        return this.save(run);
    }
    async approveAction(principal: Principal, id: string, version: number, attemptId: string): Promise<Run> { const { run } = await this.context(id, version); this.caller(principal, run, true); if (run.status !== 'awaiting-approval' || run.pendingAction?.id !== attemptId || run.pendingAction.status !== 'awaiting-approval')
        throw new DomainError('BAD_STATE', 'Approval is not for the pending action'); run.pendingAction.status = 'approved'; run.pendingAction.approvalId = randomUUID(); run.status = 'running'; return this.save(run); }
    async rejectAction(principal: Principal, id: string, version: number, attemptId: string): Promise<Run> { const { run } = await this.context(id, version); this.caller(principal, run, true); if (run.status !== 'awaiting-approval' || run.pendingAction?.id !== attemptId)
        throw new DomainError('BAD_STATE', 'Action is not pending approval'); run.actionHistory.push({ ...run.pendingAction, status: 'failed', resultReference: 'human-rejected' }); delete run.pendingAction; run.status = 'running'; return this.save(run); }
    /** Trusted host only. Persist this state BEFORE the external operation starts. */
    async markDispatched(id: string, version: number, attemptId: string, input: unknown = null): Promise<Run> { const { run } = await this.context(id, version); this.running(run); if (run.pendingAction?.id !== attemptId || run.pendingAction.status !== 'approved' || run.pendingAction.inputDigest !== digest(input))
        throw new DomainError('BAD_STATE', 'Action has not been approved or was already dispatched'); run.pendingAction.status = 'dispatched'; return this.save(run); }
    /** Trusted host only. Supply a verifiable receipt, including when reconciling uncertainty. */
    async resolveAction(id: string, version: number, attemptId: string, outcome: 'success' | 'failure', reference: string): Promise<Run> { const { run } = await this.context(id, version); const pending = run.pendingAction; if (!pending || pending.id !== attemptId || !['dispatched', 'uncertain'].includes(pending.status) || !reference.trim())
        throw new DomainError('BAD_STATE', 'Only a dispatched/uncertain action may be reconciled with evidence'); pending.status = outcome === 'success' ? 'succeeded' : 'failed'; pending.resultReference = reference; run.evidence.push(this.receipt(run, 'action-result', pending.action, outcome, reference)); run.actionHistory.push(pending); delete run.pendingAction; run.status = run.failureReason === 'cancel-requested' ? 'cancelled' : 'running'; return this.save(run); }
    async markUncertain(id: string, version: number, reason: string): Promise<Run> { const { run } = await this.context(id, version); if (run.pendingAction?.status !== 'dispatched')
        throw new DomainError('BAD_STATE', 'No dispatched action to reconcile'); run.pendingAction.status = 'uncertain'; run.status = 'uncertain'; run.failureReason = reason; return this.save(run); }
    async cancel(principal: Principal, id: string, version: number): Promise<Run> { const { run } = await this.context(id, version); this.caller(principal, run); if (['succeeded', 'failed', 'cancelled'].includes(run.status))
        throw new DomainError('BAD_STATE', 'Run is terminal'); if (run.pendingAction && ['dispatched', 'uncertain'].includes(run.pendingAction.status)) {
        run.pendingAction.status = 'uncertain';
        run.status = 'uncertain';
        run.failureReason = 'cancel-requested';
    }
    else {
        if (run.pendingAction)
            run.actionHistory.push({ ...run.pendingAction, status: 'failed', resultReference: 'cancelled-before-dispatch' });
        delete run.pendingAction;
        delete run.pendingQuestion;
        run.status = 'cancelled';
    } return this.save(run); }
    async fail(principal: Principal, id: string, version: number, reason: string): Promise<Run> { const { run } = await this.context(id, version); this.caller(principal, run); if (['succeeded', 'failed', 'cancelled'].includes(run.status))
        throw new DomainError('BAD_STATE', 'Run is terminal'); if (run.pendingAction && ['dispatched', 'uncertain'].includes(run.pendingAction.status))
        throw new DomainError('BAD_STATE', 'Reconcile the action before failing the run'); run.failureReason = reason; run.status = 'failed'; delete run.pendingAction; delete run.pendingQuestion; return this.save(run); }
    /** Startup recovery never repeats an operation. Caller still must reconcile with the external system. */
    async recoverInterruptedRuns(): Promise<Run[]> { const recovered: Run[] = []; for (const run of await this.store.listRuns())
        if (run.pendingAction?.status === 'dispatched')
            recovered.push(await this.markUncertain(run.id, run.version, 'Host restarted before receiving a durable result')); return recovered; }
}

import { randomUUID } from 'node:crypto';
import { DomainError, type Principal, type RobotSpec, type RobotStore, type RobotAggregate, type PublicationCandidate, type ReadinessReceipt, type Revision, type Proposal } from './types.js';
import { assertHumanOwner, digest, resourceDigests, validateSpec } from './validation.js';
const now = () => new Date().toISOString();

/** Workspace bindings use a portable relative path and are kept outside the robot spec. */
export function normalizeWorkspacePath(path?: string): string {
    if (path === undefined) return '.';
    if (typeof path !== 'string' || path.length > 1024 || /[\\:\u0000-\u001f\u007f]/.test(path)) {
        throw new DomainError('INVALID', 'Workspace must be a relative project directory');
    }
    const value = path.trim();
    const parts = value.split('/');
    if (value.startsWith('/') || parts.includes('..')) {
        throw new DomainError('FORBIDDEN', 'Workspace leaves the configured workspace root');
    }
    return parts.filter(part => part !== '.' && part !== '').join('/') || '.';
}

export class RobotCatalog {
    constructor(private readonly store: RobotStore) { }
    private async owned(principal: Principal, id: string, human = false): Promise<RobotAggregate> { const value = await this.store.readRobot(id); if (!value)
        throw new DomainError('NOT_FOUND', 'Robot not found'); if (human)
        assertHumanOwner(principal, value.robot.ownerId);
    else if (principal.id !== value.robot.ownerId)
        throw new DomainError('FORBIDDEN', 'Only the owner may read or edit robot management data'); return value; }
    async createRobot(principal: Principal, input: unknown, idempotencyKey?: string, workspacePath?: string): Promise<RobotAggregate> {
        const spec = validateSpec(input), robotId = idempotencyKey ? `draft-${digest({ owner: principal.id, key: idempotencyKey }).slice(0, 48)}` : randomUUID();
        if (!principal.id)
            throw new DomainError('FORBIDDEN', 'Authenticated principal required');
        const binding = normalizeWorkspacePath(workspacePath);
        const existingDraft = async () => {
            const existing = await this.store.readRobot(robotId);
            if (existing && (existing.robot.workspacePath ?? '.') !== binding) {
                throw new DomainError('CONFLICT', 'Draft request is already bound to another workspace');
            }
            return existing;
        };
        if (idempotencyKey) { const existing = await existingDraft(); if (existing) return existing; }
        const value: RobotAggregate = { schemaVersion: 1, robot: { id: robotId, ownerId: principal.id, ...(workspacePath === undefined ? {} : { workspacePath: binding }), currentRevisionId: null, disabled: false, version: 1, createdAt: now(), invokePrincipalIds: [] }, draft: { id: randomUUID(), robotId, baseRevisionId: null, editVersion: 1, spec, updatedAt: now() }, revisions: [], proposals: [] };
        try { await this.store.saveRobot(value, null); } catch (error) {
            if (idempotencyKey && error instanceof DomainError && error.code === 'CONFLICT') { const existing = await existingDraft(); if (existing) return existing; }
            throw error;
        }
        return structuredClone(value);
    }
    async getRobot(principal: Principal, id: string): Promise<RobotAggregate> { return this.owned(principal, id); }
    async listRobots(principal: Principal) { return (await this.store.listRobots()).filter(v => v.robot.ownerId === principal.id || v.robot.invokePrincipalIds.includes(principal.id)).map(v => { const spec = v.robot.ownerId === principal.id ? v.draft.spec : v.revisions.find(r => r.id === v.robot.currentRevisionId)?.spec; return { robot: v.robot, name: spec?.name ?? 'Unpublished robot', purpose: spec?.purpose ?? '' }; }); }
    async saveDraft(principal: Principal, id: string, expectedEditVersion: number, input: unknown) {
        const spec = validateSpec(input), value = await this.owned(principal, id);
        if (value.draft.editVersion !== expectedEditVersion)
            throw new DomainError('CONFLICT', 'Draft changed');
        const previous = value.robot.version;
        value.draft = { ...value.draft, spec, editVersion: expectedEditVersion + 1, updatedAt: now() };
        value.robot.version++;
        await this.store.saveRobot(value, previous);
        return structuredClone(value.draft);
    }
    async preparePublication(principal: Principal, id: string): Promise<PublicationCandidate> { const value = await this.owned(principal, id); return { draftId: value.draft.id, editVersion: value.draft.editVersion, baseRevisionId: value.draft.baseRevisionId, digest: digest(value.draft.spec), spec: structuredClone(value.draft.spec) }; }
    private appendRevision(value: RobotAggregate, spec: RobotSpec, principal: Principal, readiness: ReadinessReceipt, revisionId: string = randomUUID()): Revision {
        validateSpec(spec);
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(revisionId) || value.revisions.some(r => r.id === revisionId)) throw new DomainError('INVALID', 'Invalid or duplicate revision identity');
        const hash = digest(spec);
        if (readiness.digest !== hash || !Number.isFinite(Date.parse(readiness.checkedAt)) || spec.requiredCapabilities.some(cap => !readiness.capabilities.includes(cap)))
            throw new DomainError('NOT_READY', 'Readiness must cover this exact content and every required capability');
        const revision: Revision = { id: revisionId, robotId: value.robot.id, number: value.revisions.length + 1, schemaVersion: 1, spec: structuredClone(spec), digest: hash, resourceDigests: resourceDigests(spec.resources), createdAt: now(), approvedBy: principal.id };
        value.revisions.push(revision);
        value.robot.currentRevisionId = revision.id;
        value.draft = { id: randomUUID(), robotId: value.robot.id, baseRevisionId: revision.id, editVersion: 1, spec: structuredClone(spec), updatedAt: now() };
        return revision;
    }
    async publish(principal: Principal, id: string, candidate: PublicationCandidate, readiness: ReadinessReceipt, preparedRevisionId?: string): Promise<Revision> {
        const value = await this.owned(principal, id, true);
        if (value.draft.id !== candidate.draftId || value.draft.editVersion !== candidate.editVersion || value.robot.currentRevisionId !== candidate.baseRevisionId || value.draft.baseRevisionId !== candidate.baseRevisionId || digest(value.draft.spec) !== candidate.digest)
            throw new DomainError('CONFLICT', 'Publication candidate is stale; review the current draft');
        const previous = value.robot.version;
        const revision = this.appendRevision(value, value.draft.spec, principal, readiness, preparedRevisionId);
        value.robot.version++;
        await this.store.saveRobot(value, previous);
        return structuredClone(revision);
    }
    async setDisabled(principal: Principal, id: string, disabled: boolean) { const value = await this.owned(principal, id, true), previous = value.robot.version; value.robot.disabled = disabled; value.robot.version++; await this.store.saveRobot(value, previous); return value.robot; }
    async grantInvocation(principal: Principal, id: string, principalIds: string[]) { const value = await this.owned(principal, id, true), previous = value.robot.version; if (principalIds.some(p => !p.trim()) || new Set(principalIds).size !== principalIds.length)
        throw new DomainError('INVALID', 'Invalid share principals'); value.robot.invokePrincipalIds = [...principalIds]; value.robot.version++; await this.store.saveRobot(value, previous); return value.robot; }
    async selectRevision(principal: Principal, id: string, revisionId: string, expectedCurrentRevisionId: string | null) { const value = await this.owned(principal, id, true), previous = value.robot.version; if (value.robot.currentRevisionId !== expectedCurrentRevisionId)
        throw new DomainError('CONFLICT', 'Current revision changed'); const revision = value.revisions.find(r => r.id === revisionId); if (!revision)
        throw new DomainError('NOT_FOUND', 'Revision not found'); value.robot.currentRevisionId = revisionId; value.draft = { id: randomUUID(), robotId: id, baseRevisionId: revisionId, editVersion: 1, spec: structuredClone(revision.spec), updatedAt: now() }; value.robot.version++; await this.store.saveRobot(value, previous); return value.robot; }
    async propose(principal: Principal, input: Pick<Proposal, 'robotId' | 'baseRevisionId' | 'sourceRunIds' | 'sourceEvidenceIds' | 'summary' | 'rationale' | 'proposedSpec'>): Promise<Proposal> {
        const value = await this.store.readRobot(input.robotId);
        if (!value)
            throw new DomainError('NOT_FOUND', 'Robot not found');
        if (!value.revisions.some(r => r.id === input.baseRevisionId))
            throw new DomainError('INVALID', 'Unknown proposal base revision');
        if (!input.summary.trim() || !input.rationale.trim() || input.sourceRunIds.length === 0)
            throw new DomainError('INVALID', 'Proposal needs rationale and source runs');
        const proposedSpec = validateSpec(input.proposedSpec);
        const receipts = new Set<string>();
        for (const id of new Set(input.sourceRunIds)) {
            const run = await this.store.readRun(id);
            if (!run || run.robotId !== input.robotId || run.revisionId !== input.baseRevisionId)
                throw new DomainError('INVALID', 'Proposal source is not from this robot revision');
            if (principal.id !== run.principalId && principal.id !== value.robot.ownerId)
                throw new DomainError('FORBIDDEN', 'Cannot use another caller’s run');
            run.evidence.forEach(e => receipts.add(e.id));
        }
        if (input.sourceEvidenceIds.some(id => !receipts.has(id)))
            throw new DomainError('INVALID', 'Unknown proposal evidence');
        const dedupeKey = digest({ base: input.baseRevisionId, runs: [...new Set(input.sourceRunIds)].sort(), evidence: [...new Set(input.sourceEvidenceIds)].sort(), spec: proposedSpec });
        const existing = value.proposals.find(p => p.dedupeKey === dedupeKey);
        if (existing)
            return existing;
        const proposal: Proposal = { ...structuredClone(input), proposedSpec, id: randomUUID(), dedupeKey, status: input.sourceEvidenceIds.length ? 'pending' : 'needs-evidence' };
        const previous = value.robot.version;
        value.proposals.push(proposal);
        value.robot.version++;
        await this.store.saveRobot(value, previous);
        return proposal;
    }
    async reviewProposals(principal: Principal, id: string, proposalIds: string[], decision: 'accept' | 'reject', expectedBaseRevisionId: string, readiness?: ReadinessReceipt, preparedRevisionId?: string): Promise<Proposal[]> {
        const value = await this.owned(principal, id, true), previous = value.robot.version;
        if (proposalIds.length === 0 || new Set(proposalIds).size !== proposalIds.length)
            throw new DomainError('INVALID', 'Select unique proposal IDs');
        const selected = proposalIds.map(pid => { const p = value.proposals.find(p => p.id === pid); if (!p)
            throw new DomainError('NOT_FOUND', 'Proposal not found'); return p; });
        if (selected.some(p => !['pending', 'needs-evidence'].includes(p.status)))
            throw new DomainError('CONFLICT', 'Proposal was already reviewed');
        if (decision === 'accept') {
            if (value.robot.currentRevisionId !== expectedBaseRevisionId || selected.some(p => p.baseRevisionId !== expectedBaseRevisionId))
                throw new DomainError('CONFLICT', 'Proposal base is stale');
            if (selected.some(p => p.status === 'needs-evidence'))
                throw new DomainError('NOT_READY', 'Proposal has no verifiable evidence');
            if (new Set(selected.map(p => digest(p.proposedSpec))).size !== 1)
                throw new DomainError('CONFLICT', 'Different proposal changes require a combined reviewed draft');
            if (!readiness)
                throw new DomainError('NOT_READY', 'Confirmed changes need exact-content readiness');
            if (digest(value.draft.spec) !== digest(value.revisions.find(r => r.id === expectedBaseRevisionId)!.spec))
                throw new DomainError('CONFLICT', 'Unpublished draft changes exist; combine them before accepting proposals');
            const revision = this.appendRevision(value, selected[0]!.proposedSpec, principal, readiness, preparedRevisionId);
            for (const proposal of selected) {
                proposal.status = 'accepted';
                proposal.acceptedRevisionId = revision.id;
            }
        }
        else
            for (const proposal of selected)
                proposal.status = 'rejected';
        value.robot.version++;
        await this.store.saveRobot(value, previous);
        return structuredClone(selected);
    }
}

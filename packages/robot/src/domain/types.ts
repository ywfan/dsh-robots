/** Host-neutral, JSON-only public contracts. Credentials and host internals never belong here. */
export interface Principal {
    id: string;
    kind: 'human' | 'agent';
}
export interface Resource {
    id: string;
    kind: 'knowledge' | 'skill';
    path: string;
    content: string;
    source?: string;
}
export type StepCheck = {
    id: string;
    kind: 'action-succeeded';
    action: string;
} | {
    id: string;
    kind: 'artifact';
    key: string;
} | {
    id: string;
    kind: 'human-confirmation';
};
export interface WorkflowStep {
    id: string;
    title: string;
    instruction: string;
    skillIds: string[];
    allowedActions: string[];
    checks: StepCheck[];
    transitions: Record<string, string | null>;
    maxVisits: number;
}
export interface RobotSpec {
    name: string;
    purpose: string;
    instructions: string;
    model: {
        provider: string;
        model: string;
    };
    resources: Resource[];
    workflow: {
        entry: string;
        steps: WorkflowStep[];
    };
    requiredCapabilities: string[];
    externalActions: string[];
}
export interface Draft {
    id: string;
    robotId: string;
    baseRevisionId: string | null;
    editVersion: number;
    spec: RobotSpec;
    updatedAt: string;
}
export interface Revision {
    id: string;
    robotId: string;
    number: number;
    schemaVersion: 1;
    spec: RobotSpec;
    digest: string;
    resourceDigests: Record<string, string>;
    createdAt: string;
    approvedBy: string;
}
export interface Robot {
    id: string;
    ownerId: string;
    /** Host-local directory relative to the configured workspace root. Omitted means the root. */
    workspacePath?: string;
    currentRevisionId: string | null;
    disabled: boolean;
    version: number;
    createdAt: string;
    invokePrincipalIds: string[];
}
export interface RuntimeBinding {
    adapter: string;
    adapterVersion: string;
    harnessVersion: string;
    provider: string;
    model: string;
    sessionId: string;
}
export interface EvidenceReceipt {
    id: string;
    runId: string;
    stepId: string;
    visit: number;
    kind: 'action-result' | 'artifact' | 'human-confirmation';
    key: string;
    outcome: 'success' | 'failure';
    reference: string;
}
export interface ActionAttempt {
    id: string;
    action: string;
    idempotencyKey: string;
    inputDigest: string;
    summary: string;
    status: 'awaiting-approval' | 'approved' | 'dispatched' | 'succeeded' | 'failed' | 'uncertain';
    approvalId?: string;
    resultReference?: string;
}
export interface Run {
    id: string;
    robotId: string;
    revisionId: string;
    principalId: string;
    invokerId?: string;
    binding?: RuntimeBinding;
    status: 'preparing' | 'running' | 'waiting-user' | 'awaiting-approval' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
    stepId: string;
    visits: Record<string, number>;
    version: number;
    evidence: EvidenceReceipt[];
    pendingQuestion?: {
        id: string;
        text: string;
    };
    pendingAction?: ActionAttempt;
    actionHistory: ActionAttempt[];
    questionHistory: {
        id: string;
        text: string;
        answer: string;
        answeredBy: string;
    }[];
    failureReason?: string;
}
export interface Proposal {
    id: string;
    robotId: string;
    baseRevisionId: string;
    sourceRunIds: string[];
    sourceEvidenceIds: string[];
    summary: string;
    rationale: string;
    proposedSpec: RobotSpec;
    status: 'pending' | 'accepted' | 'rejected' | 'needs-evidence';
    dedupeKey: string;
    acceptedRevisionId?: string;
}
export interface RobotAggregate {
    schemaVersion: 1;
    robot: Robot;
    draft: Draft;
    revisions: Revision[];
    proposals: Proposal[];
}
export interface PublicationCandidate {
    draftId: string;
    editVersion: number;
    baseRevisionId: string | null;
    digest: string;
    spec: RobotSpec;
}
/** Issued by a trusted host readiness checker, never accepted directly from model/user JSON. */
export interface ReadinessReceipt {
    digest: string;
    capabilities: string[];
    checkedAt: string;
}
export interface RobotExport {
    format: 'dsh-robot';
    schemaVersion: 1;
    spec: RobotSpec;
    digest: string;
    resourceDigests: Record<string, string>;
    sourceRuntime?: { adapter: string; adapterVersion: string; harnessVersion: string };
}
export interface RobotStore {
    readRobot(id: string): Promise<RobotAggregate | undefined>;
    listRobots(): Promise<RobotAggregate[]>;
    saveRobot(value: RobotAggregate, expectedVersion: number | null): Promise<void>;
    readRun(id: string): Promise<Run | undefined>;
    listRuns(): Promise<Run[]>;
    saveRun(value: Run, expectedVersion: number | null): Promise<void>;
}
export class DomainError extends Error {
    constructor(public readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'INVALID' | 'NOT_READY' | 'BAD_STATE' | 'COMMIT_UNCERTAIN', message: string) { super(message); this.name = 'DomainError'; }
}

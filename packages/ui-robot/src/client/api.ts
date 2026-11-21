/** Browser-facing operations share domain data with the Host implementation. */
import type { RobotAggregate, RobotSpec, RobotExport, Proposal, Run, ActionAttempt } from '../../../robot/src/domain/types.ts';

export type RobotFeedbackCategory = 'success' | 'failure' | 'false-positive' | 'missed-finding' | 'correction';

export interface RobotApi {
  list(): Promise<RobotAggregate[]>;
  get(input: { robotId: string }): Promise<RobotAggregate>;
  saveDraft(input: { robotId?: string; expectedEditVersion?: number; spec: RobotSpec; workspacePath?: string }): Promise<RobotAggregate>;
  publish(input: { robotId: string; expectedDraftId: string; expectedEditVersion: number }): Promise<RobotAggregate>;
  archive(input: { robotId: string }): Promise<void>;
  prepareRun(input: { robotId: string; revisionId?: string; cwd?: string }): Promise<{ runId: string; sessionId: string; revisionId: string }>;
  draftAssistant(input: { responsibility: string; sourceEntries: string[]; model: { provider: string; model: string }; workspacePath?: string }): Promise<{ sessionId: string }>;
  listCandidates(input: { robotId: string }): Promise<Proposal[]>;
  reviewCandidates(input: { robotId: string; candidateIds: string[]; decision: 'approve' | 'reject' }): Promise<RobotAggregate>;
  exportRobot(input: { robotId: string; resourceIds?: string[] }): Promise<RobotExport>;
  importRobot(input: { bundle: RobotExport; workspacePath?: string }): Promise<RobotAggregate>;
  listRuns(): Promise<Run[]>;
  runResult(input: { runId: string }): Promise<{ status: Run['status']; artifacts: { id: string; key: string; content: string }[]; findingStatus: 'unconfirmed' }>;
  submitFeedback(input: { runId: string; category: RobotFeedbackCategory; note: string }): Promise<void>;
  answer(input: { runId: string; expectedVersion: number; questionId: string; answer: string }): Promise<Run>;
  approveAction(input: { runId: string; expectedVersion: number; actionId: string }): Promise<Run>;
  cancel(input: { runId: string; expectedVersion: number }): Promise<Run>;
  actionDetail(input: { runId: string }): Promise<{ attempt: ActionAttempt; inputJson: string }>;
  rejectAction(input: { runId: string; expectedVersion: number; actionId: string }): Promise<Run>;
  reconcileAction(input: { runId: string; expectedVersion: number }): Promise<Run>;
  resumeApprovedAction(input: { runId: string; expectedVersion: number; actionId: string }): Promise<Run>;
  confirmCheck(input: { runId: string; expectedVersion: number; checkId: string }): Promise<Run>;
}

export interface RobotSharingApi {
  list(): Promise<{ endpoint: string; invitations: { id: string; label: string; robotIds: string[]; revoked: boolean; expiresAt: string }[] }>;
  invite(input: { label: string; robotIds: string[]; expiresAt: string }): Promise<{ invitationId: string; endpoint: string; token: string }>;
  revoke(input: { invitationId: string }): Promise<void>;
}

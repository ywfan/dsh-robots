/** Request ownership for the robot panel; failed actions preserve visible work. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { RobotAggregate, RobotSpec, RobotExport, Run } from '../../../robot/src/domain/types.ts';
import type { RobotApi, RobotFeedbackCategory } from './api.ts';

export interface RobotPanelState {
  robots: RobotAggregate[];
  selected?: RobotAggregate;
  runs: Run[];
  busy: boolean;
  loaded: boolean;
  error?: string;
}

export class RobotPanelController {
  readonly store = createSnapshotStore<RobotPanelState>({ robots: [], runs: [], busy: false, loaded: false });
  private disposed = false;

  constructor(readonly api: RobotApi, private readonly openSession: (id: string) => void) {}
  dispose(): void { this.disposed = true; }

  async load(): Promise<void> {
    await this.perform(async () => {
      const [robots, runs] = await Promise.all([this.api.list(), this.api.listRuns()]);
      if (this.disposed) return;
      const selectedId = this.store.getSnapshot().selected?.robot.id;
      this.store.update(state => { state.robots = robots; state.runs = runs; state.loaded = true; state.selected = robots.find(robot => robot.robot.id === selectedId); });
    });
  }

  select(robot?: RobotAggregate): void {
    this.store.update(state => { state.selected = robot; state.error = undefined; });
  }

  openRun(run: Run): void { if (!this.disposed && run.binding) this.openSession(run.binding.sessionId); }

  async save(spec: RobotSpec, existing?: RobotAggregate, workspacePath?: string): Promise<boolean> {
    return this.perform(async () => {
      const robot = await this.api.saveDraft({ spec, ...(existing ? { robotId: existing.robot.id, expectedEditVersion: existing.draft.editVersion } : workspacePath === undefined ? {} : { workspacePath }) });
      this.accept(robot);
    });
  }

  async publish(robot: RobotAggregate): Promise<void> {
    await this.perform(async () => { this.accept(await this.api.publish({ robotId: robot.robot.id, expectedDraftId: robot.draft.id, expectedEditVersion: robot.draft.editVersion })); });
  }

  async start(robot: RobotAggregate, cwd?: string): Promise<void> {
    await this.perform(async () => {
      const revisionId = robot.robot.currentRevisionId;
      if (!revisionId) throw new Error('Publish the robot before starting a conversation');
      const run = await this.api.prepareRun({ robotId: robot.robot.id, revisionId, ...(cwd ? { cwd } : {}) });
      if (!this.disposed) this.openSession(run.sessionId);
    });
  }

  async assist(responsibility: string, sourceEntries: string[], model: RobotSpec['model'], workspacePath?: string): Promise<void> {
    await this.perform(async () => {
      const result = await this.api.draftAssistant({ responsibility, sourceEntries, model, ...(workspacePath === undefined ? {} : { workspacePath }) });
      if (!this.disposed) this.openSession(result.sessionId);
    });
  }

  async review(robot: RobotAggregate, candidateIds: string[], decision: 'approve' | 'reject'): Promise<void> {
    await this.perform(async () => { this.accept(await this.api.reviewCandidates({ robotId: robot.robot.id, candidateIds, decision })); });
  }

  async archive(robot: RobotAggregate): Promise<void> {
    await this.perform(async () => {
      await this.api.archive({ robotId: robot.robot.id });
      this.accept(await this.api.get({ robotId: robot.robot.id }));
    });
  }

  async import(bundle: RobotExport, workspacePath?: string): Promise<boolean> {
    return this.perform(async () => { this.accept(await this.api.importRobot({ bundle, ...(workspacePath === undefined ? {} : { workspacePath }) })); });
  }

  async export(robot: RobotAggregate, resourceIds: string[]): Promise<RobotExport | undefined> {
    let result: RobotExport | undefined;
    await this.perform(async () => { result = await this.api.exportRobot({ robotId: robot.robot.id, resourceIds }); });
    return result;
  }

  async answer(run: Run, answer: string): Promise<void> {
    if (!run.pendingQuestion) return;
    const questionId = run.pendingQuestion.id;
    await this.perform(async () => { this.acceptRun(await this.api.answer({ runId: run.id, expectedVersion: run.version, questionId, answer })); });
  }

  async approveAction(run: Run): Promise<void> {
    if (!run.pendingAction) return;
    const actionId = run.pendingAction.id;
    await this.perform(async () => { this.acceptRun(await this.api.approveAction({ runId: run.id, expectedVersion: run.version, actionId })); });
  }

  async cancel(run: Run): Promise<void> {
    await this.perform(async () => { this.acceptRun(await this.api.cancel({ runId: run.id, expectedVersion: run.version })); });
  }

  async submitFeedback(run: Run, category: RobotFeedbackCategory, note: string): Promise<boolean> {
    return this.perform(() => this.api.submitFeedback({ runId: run.id, category, note }));
  }

  async rejectAction(run: Run): Promise<void> {
    if (!run.pendingAction) return;
    const actionId = run.pendingAction.id;
    await this.perform(async () => { this.acceptRun(await this.api.rejectAction({ runId: run.id, expectedVersion: run.version, actionId })); });
  }

  async reconcileAction(run: Run): Promise<void> {
    await this.perform(async () => { this.acceptRun(await this.api.reconcileAction({ runId: run.id, expectedVersion: run.version })); });
  }

  async resumeApprovedAction(run: Run): Promise<void> {
    if (!run.pendingAction) return;
    const actionId = run.pendingAction.id;
    await this.perform(async () => { this.acceptRun(await this.api.resumeApprovedAction({ runId: run.id, expectedVersion: run.version, actionId })); });
  }

  async confirmCheck(run: Run, checkId: string): Promise<void> {
    await this.perform(async () => { this.acceptRun(await this.api.confirmCheck({ runId: run.id, expectedVersion: run.version, checkId })); });
  }

  private accept(robot: RobotAggregate): void {
    if (this.disposed) return;
    this.store.update(state => {
      const index = state.robots.findIndex(item => item.robot.id === robot.robot.id);
      if (index < 0) state.robots.push(robot); else state.robots[index] = robot;
      state.selected = robot;
    });
  }

  private acceptRun(run: Run): void {
    if (this.disposed) return;
    this.store.update(state => { state.runs = state.runs.map(item => item.id === run.id ? run : item); });
  }

  private async perform(operation: () => Promise<void>): Promise<boolean> {
    if (this.disposed || this.store.getSnapshot().busy) return false;
    this.store.update(state => { state.busy = true; state.error = undefined; });
    try { await operation(); return !this.disposed; }
    catch (error) {
      if (!this.disposed) this.store.update(state => { state.error = error instanceof Error ? error.message : String(error); });
      return false;
    } finally { if (!this.disposed) this.store.update(state => { state.busy = false; }); }
  }
}

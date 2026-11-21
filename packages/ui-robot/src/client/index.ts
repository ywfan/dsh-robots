/** Public DSH plugin integration; domain state remains in the Host service. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import robotRemote from '../../../robot/lib/typert.remote-client.js';
import { RobotPage, RobotPanelIcon, type RobotPageInjected } from './RobotPage.tsx';
import { RobotSelector } from './RobotSelector.tsx';
import { RobotPanelController } from './controller.ts';
import type { RobotApi } from './api.ts';
import { en, zh } from './locales.ts';

const PANEL_ID = 'robots' as MainPanelId;
export const inject = ['slots', 'locale', 'remote', 'layout', 'uiWorkspace'];

async function unwrap<T>(request: Promise<RemoteResult<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) throw result.error;
  return result.value;
}

/** Register the owned Remote namespace before rendering any dependent UI. */
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(robotRemote);
  ctx.effect(() => unmount);
  ctx.inject(['remote.robotManagement', 'remote.robotSharing'], scoped => mountUi(scoped));
}

/** Cordis grants service access only inside the scope declaring both dependencies. */
function mountUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('robots', { zh, en }));
  const t = ctx.locale.bind('robots');
  const remote = ctx.remote.robotManagement;
  const api: RobotApi = {
    list: () => unwrap(remote.list()), get: input => unwrap(remote.get(input)),
    saveDraft: input => unwrap(remote.saveDraft(input)), publish: input => unwrap(remote.publish(input)),
    archive: input => unwrap(remote.archive(input)), prepareRun: input => unwrap(remote.prepareRun(input)),
    draftAssistant: input => unwrap(remote.draftAssistant(input)), listCandidates: input => unwrap(remote.listCandidates(input)),
    reviewCandidates: input => unwrap(remote.reviewCandidates(input)), exportRobot: input => unwrap(remote.exportRobot(input)),
    importRobot: input => unwrap(remote.importRobot(input)), listRuns: () => unwrap(remote.listRuns()),
    runResult: input => unwrap(remote.runResult(input)), submitFeedback: input => unwrap(remote.submitFeedback(input)),
    answer: input => unwrap(remote.answer(input)), approveAction: input => unwrap(remote.approveAction(input)),
    cancel: input => unwrap(remote.cancel(input)),
    actionDetail: input => unwrap(remote.actionDetail(input)), rejectAction: input => unwrap(remote.rejectAction(input)),
    reconcileAction: input => unwrap(remote.reconcileAction(input)), resumeApprovedAction: input => unwrap(remote.resumeApprovedAction(input)), confirmCheck: input => unwrap(remote.confirmCheck(input)),
  };
  const controller = new RobotPanelController(api, id => ctx.uiWorkspace.openSession(id as SessionId));
  ctx.effect(() => () => controller.dispose());
  const face: RobotPageInjected = {
    hooks: { robotPanel: controller.store },
    load: () => controller.load(), select: robot => controller.select(robot),
    save: (spec, robot, workspacePath) => controller.save(spec, robot, workspacePath), publish: robot => controller.publish(robot),
    start: (robot, cwd) => controller.start(robot, cwd), assist: (responsibility, sources, model, workspacePath) => controller.assist(responsibility, sources, model, workspacePath),
    review: (robot, ids, decision) => controller.review(robot, ids, decision), archive: robot => controller.archive(robot),
    importRobot: (bundle, workspacePath) => controller.import(bundle, workspacePath), exportRobot: (robot, resourceIds) => controller.export(robot, resourceIds),
    answer: (run, answer) => controller.answer(run, answer), approveAction: run => controller.approveAction(run),
    cancelRun: run => controller.cancel(run),
    openRun: run => controller.openRun(run),
    runResult: input => api.runResult(input), submitFeedback: (run, category, note) => controller.submitFeedback(run, category, note),
    actionDetail: input => api.actionDetail(input), rejectAction: run => controller.rejectAction(run),
    reconcileAction: run => controller.reconcileAction(run), resumeApprovedAction: run => controller.resumeApprovedAction(run), confirmCheck: (run, checkId) => controller.confirmCheck(run, checkId),
    listShares: () => unwrap(ctx.remote.robotSharing.list()), invite: input => unwrap(ctx.remote.robotSharing.invite(input)), revoke: input => unwrap(ctx.remote.robotSharing.revoke(input)),
  };
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: 'robots', inject: () => face }, RobotPage));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 5, locale: 'robots', label: () => t('title') }, RobotPanelIcon));
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({ name: 'conversation.hero.options', id: 'robots', locale: 'robots', inject: () => ({ hooks: face.hooks, start: face.start }) }, RobotSelector));
  ctx.effect(() => ctx.on('connection/reset', () => { void controller.load(); }));
  void controller.load();
}

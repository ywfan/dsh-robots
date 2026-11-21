/** UI behavior around rejected operations and fixed-revision launches. */
import { describe, it, expect, vi } from 'vitest';
import { RobotPanelController } from '../src/client/controller.ts';
import type { RobotApi } from '../src/client/api.ts';
import type { RobotAggregate, RobotSpec } from '../../robot/src/domain/types.ts';

const spec: RobotSpec = {
  name: 'Review', purpose: 'Review this repository', instructions: 'Use evidence', model: { provider: 'mock', model: 'fixture' },
  resources: [], workflow: { entry: 'review', steps: [{ id: 'review', title: 'Review', instruction: 'Review', skillIds: [], allowedActions: [], checks: [], transitions: { done: null }, maxVisits: 1 }] }, requiredCapabilities: [], externalActions: [],
};
const robot: RobotAggregate = {
  schemaVersion: 1,
  robot: { id: 'robot-a', ownerId: 'owner', currentRevisionId: 'revision-1', disabled: false, version: 1, createdAt: '2026-11-15', invokePrincipalIds: [] },
  draft: { id: 'draft', robotId: 'robot-a', baseRevisionId: 'revision-1', editVersion: 2, spec, updatedAt: '2026-11-15' },
  revisions: [], proposals: [],
};

function fixtureApi(): RobotApi {
  return {
    list: vi.fn(async () => [robot]), get: vi.fn(async () => robot), saveDraft: vi.fn(async () => robot), publish: vi.fn(async () => robot), archive: vi.fn(async () => {}),
    prepareRun: vi.fn(async () => ({ runId: 'run', sessionId: 'session', revisionId: 'revision-1' })),
    draftAssistant: vi.fn(async () => ({ sessionId: 'draft-session' })),
    listCandidates: vi.fn(async () => []), reviewCandidates: vi.fn(async () => robot),
    exportRobot: vi.fn(async () => ({ format: 'dsh-robot' as const, schemaVersion: 1 as const, spec, digest: 'digest', resourceDigests: {} })),
    importRobot: vi.fn(async () => robot), listRuns: vi.fn(async () => []),
    runResult: vi.fn(async () => ({ status: 'succeeded' as const, artifacts: [], findingStatus: 'unconfirmed' as const })), submitFeedback: vi.fn(async () => {}),
    answer: vi.fn(async () => { throw new Error('No run'); }), approveAction: vi.fn(async () => { throw new Error('No run'); }),
    cancel: vi.fn(async () => { throw new Error('No run'); }),
    actionDetail: vi.fn(async () => { throw new Error('No action'); }), rejectAction: vi.fn(async () => { throw new Error('No action'); }), reconcileAction: vi.fn(async () => { throw new Error('No action'); }), resumeApprovedAction: vi.fn(async () => { throw new Error('No action'); }), confirmCheck: vi.fn(async () => { throw new Error('No check'); }),
  };
}

describe('robot panel requests', () => {
  it('retains the selected draft after a conflicting save', async () => {
    const api = fixtureApi();
    const controller = new RobotPanelController(api, vi.fn());
    await controller.load(); controller.select(robot);
    vi.mocked(api.saveDraft).mockRejectedValueOnce(new Error('Draft changed; refresh before saving'));
    expect(await controller.save({ ...spec, name: 'Changed' }, robot)).toBe(false);
    expect(controller.store.getSnapshot().selected?.draft.spec.name).toBe('Review');
    expect(controller.store.getSnapshot().error).toContain('Draft changed');
    expect(api.saveDraft).toHaveBeenCalledWith({ robotId: 'robot-a', expectedEditVersion: 2, spec: { ...spec, name: 'Changed' } });
  });

  it('navigates only after a fixed revision is prepared by the Host', async () => {
    const api = fixtureApi(); const open = vi.fn();
    const controller = new RobotPanelController(api, open);
    await controller.start(robot, '/workspace');
    expect(api.prepareRun).toHaveBeenCalledWith({ robotId: 'robot-a', revisionId: 'revision-1', cwd: '/workspace' });
    expect(open).toHaveBeenCalledWith('session');
    vi.mocked(api.prepareRun).mockRejectedValueOnce(new Error('Model unavailable'));
    await controller.start(robot);
    expect(open).toHaveBeenCalledTimes(1);
    expect(controller.store.getSnapshot().error).toBe('Model unavailable');
  });

  it('ignores late load results after the plugin is disposed', async () => {
    const api = fixtureApi(); let resolveList!: (robots: RobotAggregate[]) => void;
    vi.mocked(api.list).mockReturnValueOnce(new Promise(resolve => { resolveList = resolve; }));
    const controller = new RobotPanelController(api, vi.fn());
    const pending = controller.load(); controller.dispose(); resolveList([robot]); await pending;
    expect(controller.store.getSnapshot().robots).toEqual([]);
  });

  it('publishes only the exact draft the reviewer saw', async () => {
    const api = fixtureApi(); const controller = new RobotPanelController(api, vi.fn());
    await controller.publish(robot);
    expect(api.publish).toHaveBeenCalledWith({ robotId: 'robot-a', expectedDraftId: 'draft', expectedEditVersion: 2 });
  });

  it('exports an explicitly empty resource selection without falling back to all resources', async () => {
    const api = fixtureApi(); const controller = new RobotPanelController(api, vi.fn());
    await controller.export(robot, []);
    expect(api.exportRobot).toHaveBeenCalledWith({ robotId: 'robot-a', resourceIds: [] });
  });
});

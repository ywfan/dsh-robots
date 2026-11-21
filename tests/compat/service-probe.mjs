/** Runs the built robot service against real released DSH plugins; all model responses are local fixtures. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const name = 'robot-service-probe';
export const inject = [
  'llm', 'agents', 'agentPresets', 'sessionController', 'tools',
  ...(process.env.ROBOT_SERVICE_STAGE === 'disabled' ? [] : ['robotManagement', 'robotSharing']),
];
const model = { provider: 'robot-service-fixture', model: 'local-script' };

class LocalAdapter extends LlmAdapter {
  constructor(report) { super(); this.report = report; }
  listModels() { return Promise.resolve([{ provider: model.provider, id: model.model, name: 'Local scripted fixture' }]); }
  async *stream(request) {
    assert.deepEqual([request.provider, request.model], [model.provider, model.model]);
    this.report.localFixtureRequests++;
    const userText = request.messages
      .filter(message => message.role === 'user')
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
    const toolResults = request.messages.filter(message => message.role === 'tool').length;
    let nextTool;
    if (userText.includes('Fixture correction: use the narrower method.') && toolResults === 0) {
      nextTool = { name: 'robot_propose', args: {
        summary: 'Use the narrower fixture method',
        rationale: 'The owner correction and the run report identify a reusable method.',
        specJson: JSON.stringify(spec(3)),
      } };
    } else if (userText.includes('Run as a delegated fixture.') || userText.includes('Share fixture') || userText.includes('Run via the direct workflow entry.')) {
      if (toolResults === 0) nextTool = { name: 'robot_artifact', args: { key: 'report', content: 'Scripted task result' } };
      if (toolResults === 1) nextTool = { name: 'robot_advance', args: { outcome: 'done' } };
    }
    if (nextTool) {
      const call = { type: 'tool-call', id: randomUUID(), name: nextTool.name, arguments: JSON.stringify(nextTool.args) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments };
      yield { type: 'block-end', index: 0, block: call };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const text = 'Local fixture response.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

function spec(version) {
  return {
    name: 'Runtime probe',
    purpose: 'Verify DSH host integration',
    instructions: `Immutable instructions v${version}`,
    model,
    resources: [
      { id: 'read-me', kind: 'knowledge', path: 'knowledge/guide.md', content: `Local guidance v${version}` },
      { id: 'optional', kind: 'knowledge', path: 'knowledge/optional.md', content: 'Optional resource' },
    ],
    requiredCapabilities: ['robot_artifact', 'robot_read_file'],
    externalActions: [],
    workflow: { entry: 'check', steps: [{
      id: 'check', title: 'Check', instruction: 'Read fixture, save evidence, finish',
      skillIds: [], allowedActions: ['robot_artifact', 'robot_read_file'],
      checks: [{ id: 'has-report', kind: 'artifact', key: 'report' }],
      transitions: { done: null }, maxVisits: 1,
    }] },
  };
}

async function check(report, name, callback) {
  try {
    await callback();
    report.checks[name] = { passed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.checks[name] = { passed: false, error: message };
    throw error;
  }
}

export function apply(ctx) {
  const report = { version: process.env.ROBOT_SERVICE_VERSION, stage: process.env.ROBOT_SERVICE_STAGE, checks: {}, localFixtureRequests: 0, passed: false };
  ctx.llm.registerAdapter([model.provider], new LocalAdapter(report));
  async function run() {
    const svc = report.stage === 'disabled' ? undefined : ctx.robotManagement;
    const workspace = process.env.ROBOT_SERVICE_WORKSPACE;
    const stateFile = process.env.ROBOT_SERVICE_STATE;
    const signal = AbortSignal.timeout(15_000);
    const agent = id => {
      const result = ctx.agents.get(id);
      assert.ok(result, `No live agent for ${id}`);
      return result;
    };
    const runById = async id => {
      const result = (await svc.listRuns()).find(item => item.id === id);
      assert.ok(result, `No persisted run ${id}`);
      return result;
    };
    const rawTool = async (who, name, args = {}) => {
      const target = agent(who);
      const toolSet = await ctx.tools.resolve({ agent: target, modelSelection: target.model.current(), signal });
      try {
        const calls = [{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }];
        return (await ctx.tools.execute({ agent: target, signal, toolSet, calls })).results[0].result;
      } finally { toolSet.dispose(); }
    };
    const tool = async (who, name, args = {}) => {
      const result = await rawTool(who, name, args);
      assert.equal(result.isError, false, JSON.stringify(result.error));
      return JSON.parse(result.value);
    };
    const publish = draft => svc.publish({
      robotId: draft.robot.id,
      expectedDraftId: draft.draft.id,
      expectedEditVersion: draft.draft.editVersion,
    });
    const prompt = async (id, text) => {
      await ctx.sessionController.prompt({
        sessionId: id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }],
      }, signal);
      await agent(id).whenIdle();
    };
    try {
      if (report.stage === 'disabled') {
        await check(report, 'blankSessionWorksWithPluginDisabled', async () => {
          const blank = await ctx.sessionController.create({ cwd: workspace });
          const ordinary = agent(blank.sessionId);
          assert.ok(!blank.agentPreset?.startsWith('robot-'));
          ordinary.model.select(model);
          await prompt(blank.sessionId, 'Ordinary session after disabling robot plugins.');
          assert.equal(report.localFixtureRequests, 1);
          assert.equal((await rawTool(blank.sessionId, 'robot_catalog')).isError, true);
        });
      } else if (report.stage === 'without-delegation') {
        await check(report, 'directRobotWorksWhenOptionalDelegationIsAbsent', async () => {
          const published = await publish(await svc.saveDraft({ spec: spec(1), workspacePath: 'alpha' }));
          const robotId = published.robot.id;
          const direct = await svc.prepareRun({ robotId });
          await prompt(direct.sessionId, 'Run via the direct workflow entry.');
          assert.equal((await runById(direct.runId)).status, 'succeeded');
          await ctx.agentPresets.register({
            id: 'without-delegation-fixture', name: 'Minimal ordinary session',
            plugins: [{ id: 'native', name: '@deepseek-ai/dsh-tool-executor-native' }],
          });
          const main = await ctx.sessionController.create({ cwd: workspace, agentPreset: 'without-delegation-fixture' });
          agent(main.sessionId).model.select(model);
          await prompt(main.sessionId, 'Authorize the ordinary fixture session.');
          const refused = await rawTool(main.sessionId, 'robot_invoke', { robotId, prompt: 'Try delegation.' });
          assert.equal(refused.isError, true);
          assert.match(JSON.stringify(refused.error), /cannot delegate robot tasks/i);
          assert.equal((await svc.listRuns()).length, 1);
        });
      } else if (report.stage === 'create') {
        const draft = await svc.saveDraft({ spec: spec(1), workspacePath: 'alpha' });
        const robotId = draft.robot.id;
        await check(report, 'draftUnavailableAndStalePublishRejected', async () => {
          await assert.rejects(svc.prepareRun({ robotId }), /publish/i);
          await assert.rejects(svc.publish({ robotId, expectedDraftId: draft.draft.id, expectedEditVersion: draft.draft.editVersion - 1 }), /draft changed/i);
        });
        const published = await publish(draft);
        const revision1 = published.robot.currentRevisionId;
        const first = await svc.prepareRun({ robotId });
        await check(report, 'ownerSessionBindsImmutableRobot', async () => {
          assert.equal(first.revisionId, revision1);
          assert.deepEqual(agent(first.sessionId).model.current(), model);
          assert.equal((await tool(first.sessionId, 'robot_state')).run.revisionId, revision1);
          const nativeSession = await ctx.sessionController.create({ cwd: join(workspace, 'alpha'), agentPreset: `robot-${robotId}-${revision1}` });
          const state = await tool(nativeSession.sessionId, 'robot_state');
          assert.equal(state.run.revisionId, revision1);
        });
        await check(report, 'scopedToolChecksAndPause', async () => {
          assert.equal((await rawTool(first.sessionId, 'robot_catalog')).isError, true);
          assert.equal((await rawTool(first.sessionId, 'robot_advance', { outcome: 'done' })).isError, true);
          assert.match((await tool(first.sessionId, 'robot_read_file', { path: 'proof.txt' })).text, /alpha fixture/);
          await tool(first.sessionId, 'robot_artifact', { key: 'report', content: 'Persisted report' });
          await tool(first.sessionId, 'robot_advance', { outcome: 'not-covered' });
          const run = await runById(first.runId);
          assert.equal(run.status, 'waiting-user');
          assert.equal((await rawTool(first.sessionId, 'robot_advance', { outcome: 'done' })).isError, true);
          assert.equal((await svc.cancel({ runId: run.id, expectedVersion: run.version })).status, 'cancelled');
        });
        const saved = await svc.saveDraft({ robotId, expectedEditVersion: published.draft.editVersion, spec: spec(2) });
        const updated = await publish(saved);
        const revision2 = updated.robot.currentRevisionId;
        await check(report, 'newDefaultAndOlderRevisionRemainSeparate', async () => {
          assert.notEqual(revision1, revision2);
          assert.equal((await svc.prepareRun({ robotId })).revisionId, revision2);
          assert.equal((await svc.prepareRun({ robotId, revisionId: revision1 })).revisionId, revision1);
          assert.equal((await runById(first.runId)).revisionId, revision1);
        });

        await check(report, 'ordinarySessionAndDelegatedAgentToolBridge', async () => {
          const main = await ctx.sessionController.create({ cwd: workspace });
          assert.ok(!main.agentPreset?.startsWith('robot-'));
          assert.equal((await rawTool(main.sessionId, 'robot_catalog')).isError, true);
          assert.equal((await rawTool(main.sessionId, 'robot_state')).isError, true);
          agent(main.sessionId).model.select(model);
          await prompt(main.sessionId, 'Authorize this ordinary fixture session.');
          const entries = await tool(main.sessionId, 'robot_catalog');
          assert.ok(entries.some(entry => entry.robotId === robotId));
          const child = await tool(main.sessionId, 'robot_invoke', { robotId, prompt: 'Run as a delegated fixture.' });
          assert.notEqual(child.sessionId, main.sessionId);
          assert.equal(child.revisionId, revision2);
          let childState = await tool(main.sessionId, 'robot_task_status', { runId: child.runId });
          const deadline = Date.now() + 3000;
          while (childState.status === 'running' && Date.now() < deadline) {
            await delay(25);
            childState = await tool(main.sessionId, 'robot_task_status', { runId: child.runId });
          }
          assert.equal(childState.invokerId, main.sessionId);
          assert.equal(childState.status, 'succeeded');
          assert.deepEqual((await svc.runResult({ runId: child.runId })).artifacts.map(item => item.content), ['Scripted task result']);
          const result = await tool(main.sessionId, 'robot_task_result', { runId: child.runId, artifactKey: 'report' });
          assert.deepEqual(result.artifacts.map(item => item.content), ['Scripted task result']);
          const other = await ctx.sessionController.create({ cwd: workspace });
          agent(other.sessionId).model.select(model);
          await prompt(other.sessionId, 'Authorize another ordinary fixture session.');
          assert.equal((await rawTool(other.sessionId, 'robot_task_status', { runId: child.runId })).isError, true);
          assert.equal((await rawTool(other.sessionId, 'robot_task_result', { runId: child.runId, artifactKey: 'report' })).isError, true);
        });

        await check(report, 'robotsUseSeparateWorkspaceBoundaries', async () => {
          const siblingSpec = spec(42);
          siblingSpec.name = 'Sibling fixture';
          const sibling = await publish(await svc.saveDraft({ spec: siblingSpec, workspacePath: 'beta' }));
          const left = await svc.prepareRun({ robotId });
          const right = await svc.prepareRun({ robotId: sibling.robot.id });
          assert.match((await tool(left.sessionId, 'robot_read_file', { path: 'proof.txt' })).text, /alpha fixture/);
          assert.match((await tool(right.sessionId, 'robot_read_file', { path: 'proof.txt' })).text, /beta fixture/);
          assert.equal((await rawTool(left.sessionId, 'robot_read_file', { path: '../beta/proof.txt' })).isError, true);
          await assert.rejects(svc.prepareRun({ robotId, cwd: join(workspace, 'beta') }), /different prepared workspace/);
          assert.equal((await tool(left.sessionId, 'robot_state')).run.robotId, robotId);
          assert.equal((await tool(right.sessionId, 'robot_state')).run.robotId, sibling.robot.id);
        });
        let portableBundle;
        await check(report, 'exportImportOmitsUnselectedResource', async () => {
          const bundle = await svc.exportRobot({ robotId, resourceIds: ['read-me'] });
          portableBundle = bundle;
          assert.deepEqual(bundle.spec.resources.map(item => item.id), ['read-me']);
          assert.ok(!JSON.stringify(bundle).includes('Optional resource'));
          assert.equal(Object.hasOwn(bundle, 'workspacePath'), false);
          assert.equal(bundle.sourceRuntime.harnessVersion, report.version);
          const imported = await svc.importRobot({ bundle });
          assert.notEqual(imported.robot.id, robotId);
          assert.equal(imported.robot.currentRevisionId, null);
        });
        await check(report, 'loopbackInvitationsIsolateCallerRuns', async () => {
          const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
          const a = await ctx.robotSharing.invite({ label: 'Fixture A', robotIds: [robotId], expiresAt });
          const b = await ctx.robotSharing.invite({ label: 'Fixture B', robotIds: [robotId], expiresAt });
          const headers = { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' };
          const response = await fetch(`${a.endpoint}/runs`, { method: 'POST', headers, body: JSON.stringify({ robotId, prompt: 'Share fixture' }), signal });
          assert.equal(response.status, 201, await response.clone().text());
          const shared = await response.json();
          const resultUrl = `${a.endpoint}/runs/${shared.runId}/result`;
          let result;
          const deadline = Date.now() + 3000;
          do {
            const response = await fetch(resultUrl, { headers, signal });
            assert.equal(response.status, 200);
            result = await response.json();
            if (result.status === 'running') await delay(25);
          } while (result.status === 'running' && Date.now() < deadline);
          assert.equal(result.status, 'succeeded');
          assert.equal(result.findingStatus, 'unconfirmed');
          assert.deepEqual(result.artifacts.map(item => item.content), ['Scripted task result']);
          const foreign = await fetch(`${b.endpoint}/runs/${shared.runId}/result`, { headers: { authorization: `Bearer ${b.token}` }, signal });
          assert.equal(foreign.status, 404);
          await ctx.robotSharing.revoke({ invitationId: a.invitationId });
          const revoked = await fetch(`${a.endpoint}/runs`, { headers, signal });
          assert.equal(revoked.status, 401);
        });
        const completed = await svc.prepareRun({ robotId });
        await tool(completed.sessionId, 'robot_artifact', { key: 'report', content: 'Completed portable report' });
        await tool(completed.sessionId, 'robot_advance', { outcome: 'done' });
        let revision3;
        await check(report, 'feedbackCandidateRequiresOwnerApprovalAndPinsPriorRun', async () => {
          const feedback = { runId: completed.runId, category: 'correction', note: 'Fixture correction: use the narrower method.' };
          await svc.submitFeedback(feedback);
          let proposals = [];
          const deadline = Date.now() + 4000;
          while (proposals.length === 0 && Date.now() < deadline) {
            await delay(50);
            proposals = await svc.listCandidates({ robotId });
          }
          assert.equal(proposals.length, 1);
          assert.equal(proposals[0].status, 'pending');
          assert.equal((await svc.get({ robotId })).robot.currentRevisionId, revision2);
          await svc.submitFeedback(feedback);
          assert.equal((await svc.listCandidates({ robotId })).length, 1);
          const confirmed = await svc.reviewCandidates({ robotId, candidateIds: [proposals[0].id], decision: 'approve' });
          revision3 = confirmed.robot.currentRevisionId;
          assert.notEqual(revision3, revision2);
          assert.equal(confirmed.proposals[0].status, 'accepted');
          assert.equal((await runById(completed.runId)).revisionId, revision2);
          assert.equal((await svc.prepareRun({ robotId })).revisionId, revision3);
        });
        const aggregate = await svc.get({ robotId });
        await writeFile(stateFile, JSON.stringify({
          robotId, revision1, revision2, revision3, runId: first.runId,
          completedRunId: completed.runId, revisionDigests: aggregate.revisions.map(item => item.digest),
          proposals: aggregate.proposals.map(({ id, status, acceptedRevisionId }) => ({ id, status, acceptedRevisionId })), portableBundle,
        }));
      } else {
        const old = JSON.parse(await readFile(stateFile, 'utf8'));
        await check(report, 'publishedVersionsRestoreWithSameIdentityAndDigests', async () => {
          const aggregate = await svc.get({ robotId: old.robotId });
          assert.equal(aggregate.robot.currentRevisionId, old.revision3);
          assert.deepEqual(aggregate.revisions.map(item => item.digest), old.revisionDigests);
          assert.deepEqual(aggregate.proposals.map(({ id, status, acceptedRevisionId }) => ({ id, status, acceptedRevisionId })), old.proposals);
          assert.equal((await runById(old.runId)).revisionId, old.revision1);
          for (const revisionId of [old.revision1, old.revision2, old.revision3]) {
            const preset = await ctx.agentPresets.resolve(`robot-${old.robotId}-${revisionId}`);
            assert.equal(preset.broken, undefined);
          }
        });
        await check(report, 'persistedArtifactReadableAfterRestartOrMove', async () => {
          const result = await svc.runResult({ runId: old.completedRunId });
          assert.equal(result.status, 'succeeded');
          assert.equal(result.findingStatus, 'unconfirmed');
          assert.deepEqual(result.artifacts.map(({ key, content }) => ({ key, content })), [
            { key: 'report', content: 'Completed portable report' },
          ]);
        });
        if (report.stage === 'adjacent') {
          await check(report, 'selectedCopyPublishesAndRunsOnAdjacentHost', async () => {
            const copy = await svc.importRobot({ bundle: old.portableBundle, workspacePath: 'beta' });
            assert.notEqual(copy.robot.id, old.robotId);
            assert.equal(copy.robot.currentRevisionId, null);
            await publish(copy);
            const fresh = await svc.prepareRun({ robotId: copy.robot.id });
            assert.match((await tool(fresh.sessionId, 'robot_read_file', { path: 'proof.txt' })).text, /beta fixture/);
            await tool(fresh.sessionId, 'robot_artifact', { key: 'report', content: 'Independent copy worked' });
            await tool(fresh.sessionId, 'robot_advance', { outcome: 'done' });
            assert.equal((await runById(fresh.runId)).status, 'succeeded');
            assert.equal((await svc.get({ robotId: old.robotId })).robot.currentRevisionId, old.revision3);
          });
        }
        await check(report, 'newSessionExecutesOnRestartOrAdjacentHost', async () => {
          const fresh = await svc.prepareRun({ robotId: old.robotId, revisionId: old.revision1 });
          await tool(fresh.sessionId, 'robot_artifact', { key: 'report', content: 'Restart fixture report' });
          await tool(fresh.sessionId, 'robot_advance', { outcome: 'done' });
          const stored = await runById(fresh.runId);
          assert.equal(stored.status, 'succeeded');
          assert.equal(stored.binding.harnessVersion, report.version);
          assert.equal(stored.revisionId, old.revision1);
        });
      }
      report.passed = true;
    } catch (error) {
      report.error = { name: error.name, message: error.message, stack: error.stack?.split('\n').slice(1, 4) };
    } finally {
      await writeFile(process.env.ROBOT_SERVICE_REPORT, JSON.stringify(report, null, 2) + '\n');
    }
  }
  // Restore is initiated after management readiness and preset registration can complete.
  ctx.effect(() => {
    const controller = new AbortController();
    void delay(450, undefined, { signal: controller.signal }).then(run, () => {});
    return () => controller.abort();
  });
}

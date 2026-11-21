import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { RobotSharingServer, type SharedHostPort } from '../src/host/sharing.js';
import { DomainError, type Run } from '../src/domain/types.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
test('two real HTTP callers have independent identities, sessions and cancellation; revocation survives restart', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'robot-share-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
 const runs = new Map<string, Run>(); let count = 0;
 const port: SharedHostPort = {
  async grantShared() {},
  async startShared(p, robotId) { const id = `run${++count}`; runs.set(id, { id, robotId, revisionId: 'revision-1', principalId: p.id, status: 'running', stepId: 'review', visits: {review:1}, version: 1, evidence: [], actionHistory: [], questionHistory: [] }); return { runId: id, sessionId: `session${count}`, revisionId: 'revision-1' }; },
  async readShared(p, id) { const r = runs.get(id); if (!r || r.principalId !== p.id) throw new DomainError('FORBIDDEN', 'Denied'); return r; },
  async listShared(p) { return [...runs.values()].filter(run => run.principalId === p.id); },
  async answerShared(p, id, answer) { const run = await this.readShared(p, id); if (run.version !== answer.expectedVersion) throw new DomainError('CONFLICT', 'Stale answer'); run.status = 'running'; run.version++; return run; },
  async resultShared(p, id) { const run = await this.readShared(p, id); return { status: run.status, artifacts: [], findingStatus: 'unconfirmed' }; },
  async cancelShared(p, id) { const r = await this.readShared(p,id); r.status='cancelled'; return r; },
 };
 const state = join(dir, 'shares.json'), server = new RobotSharingServer(port, state); const url = await server.open(); cleanup.push(() => server.close());
 const a = await server.invite('A',['robot'], new Date(Date.now()+100_000).toISOString()), b = await server.invite('B',['robot'], new Date(Date.now()+100_000).toISOString());
 const call = (token:string,path:string,method='GET',body?:unknown) => fetch(url+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const [ra,rb] = await Promise.all([call(a.token,'/runs','POST',{robotId:'robot',prompt:'review'}),call(b.token,'/runs','POST',{robotId:'robot',prompt:'review'})]);
 expect(ra.status).toBe(201);expect(rb.status).toBe(201);const va=await ra.json(), vb=await rb.json();expect(va.runId).not.toBe(vb.runId);
 expect((await call(b.token,`/runs/${va.runId}`)).status).toBe(404);
 expect((await call(a.token,`/runs/${va.runId}/cancel`,'POST')).status).toBe(200);expect(runs.get(vb.runId)?.status).toBe('running');
 expect((await call(a.token,'/runs','POST',{robotId:'other',prompt:'review',principalId:'local-owner'})).status).toBe(403);
 expect((await readFile(state,'utf8')).includes(a.token)).toBe(false);
 await server.revoke(a.invitationId);expect((await call(a.token,'/robots')).status).toBe(401);
 await server.close(); const restarted=new RobotSharingServer(port,state); const url2=await restarted.open();cleanup.push(()=>restarted.close());
 expect((await fetch(url2+'/robots',{headers:{Authorization:`Bearer ${a.token}`}})).status).toBe(401);
 expect((await fetch(url2+'/robots',{headers:{Authorization:`Bearer ${b.token}`,Origin:'https://untrusted.example'}})).status).toBe(403);
});

async function fixture() {
 const dir = await mkdtemp(join(tmpdir(), 'robot-share-flow-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
 const runs = new Map<string, Run>(); let count = 0, revision = 'revision-1', cancellations = 0, answers = 0;
 const port: SharedHostPort = {
  async grantShared() {},
  async startShared(principal, robotId) {
   await new Promise<void>(resolve => setImmediate(resolve));
   const id = `run${++count}`;
   runs.set(id, { id, robotId, revisionId: revision, principalId: principal.id, binding: { adapter: 'dsh', adapterVersion: '1', harnessVersion: 'test', provider: 'secret-provider', model: 'private-model', sessionId: `private-session-${id}` }, status: 'running', stepId: 'review', visits: { review: 1 }, version: 1, evidence: [], actionHistory: [], questionHistory: [] });
   return { runId: id, sessionId: `session-${id}`, revisionId: revision };
  },
  async readShared(p, id) { const run = runs.get(id); if (!run || run.principalId !== p.id) throw new DomainError('NOT_FOUND', 'Unavailable'); return run; },
  async listShared(p) { return [...runs.values()].filter(run => run.principalId === p.id); },
  async cancelShared(p, id) { const run = await this.readShared(p, id); cancellations++; run.status = 'cancelled'; run.version++; return run; },
  async answerShared(p, id, answer) {
   const run = await this.readShared(p, id);
   if (run.version !== answer.expectedVersion || run.pendingQuestion?.id !== answer.questionId) throw new DomainError('CONFLICT', 'Stale answer');
   if (run.status !== 'waiting-user') throw new DomainError('BAD_STATE', 'Not waiting');
   answers++; run.questionHistory.push({ id: answer.questionId, text: run.pendingQuestion.text, answer: answer.answer, answeredBy: p.id }); delete run.pendingQuestion; run.status = 'running'; run.version++; return run;
  },
  async resultShared(p, id) { const run = await this.readShared(p, id); return { status: run.status, artifacts: run.status === 'succeeded' ? [{ id: 'artifact-1', key: 'report', content: 'Own task result' }] : [], findingStatus: 'unconfirmed' }; },
 };
 const state = join(dir, 'shares.json'); let server = new RobotSharingServer(port, state), url = await server.open();
 cleanup.push(() => server.close());
 const invite = (label: string) => server.invite(label, ['robot'], new Date(Date.now() + 100_000).toISOString());
 const call = (token: string, path: string, method = 'GET', body?: unknown) => fetch(url + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 return { runs, port, invite, call, counts: () => ({ cancellations, answers }), setRevision: (value: string) => { revision = value; },
  restart: async () => { await server.close(); server = new RobotSharingServer(port, state); url = await server.open(); },
 };
}

test('real HTTP flow resumes an own pending question and retrieves final artifacts, hiding cross-caller results', async () => {
 const f = await fixture(), a = await f.invite('A'), b = await f.invite('B');
 const started = await f.call(a.token, '/runs', 'POST', { robotId: 'robot', prompt: 'review' }); const { runId } = await started.json();
 const run = f.runs.get(runId)!; run.status = 'waiting-user'; run.pendingQuestion = { id: 'question-1', text: 'Which target?' }; run.version = 2;
 run.evidence.push({ id: 'receipt-1', runId, stepId: 'review', visit: 1, kind: 'artifact', key: 'report', outcome: 'success', reference: '/private/owner/data/artifact.json' });
 const status = await (await f.call(a.token, `/runs/${runId}`)).json();
 expect(status.pendingQuestion).toEqual(run.pendingQuestion); expect(JSON.stringify(status)).not.toContain('/private/'); expect(status.binding).toBeUndefined(); expect(status.principalId).toBeUndefined();
 for (const [suffix, method] of [['', 'GET'], ['/result', 'GET'], ['/cancel', 'POST'], ['/answer', 'POST']]) {
  expect((await f.call(b.token, `/runs/${runId}${suffix}`, method, method === 'POST' ? { questionId: 'question-1', expectedVersion: 2, answer: 'forged' } : undefined)).status).toBe(404);
 }
 expect(f.counts()).toEqual({ answers: 0, cancellations: 0 });
 expect((await f.call(a.token, `/runs/${runId}/answer`, 'POST', { expectedVersion: 1, questionId: 'question-1', answer: 'main' })).status).toBe(409);
 expect((await f.call(a.token, `/runs/${runId}/answer`, 'POST', { expectedVersion: 2, questionId: 'question-1', answer: 'main' })).status).toBe(200);
 expect(run.status).toBe('running'); expect(f.counts().answers).toBe(1);
 run.status = 'succeeded';
 const result = await (await f.call(a.token, `/runs/${runId}/result`)).json();
 expect(result).toEqual({ runId, revisionId: 'revision-1', status: 'succeeded', findingStatus: 'unconfirmed', artifacts: [{ id: 'artifact-1', key: 'report', content: 'Own task result' }] });
 expect((await (await f.call(b.token, '/runs')).json()).runs).toEqual([]);
});

test('concurrency limit applies to live tasks and waiting tasks across HTTP disconnect/restart, then cancellation releases a slot', async () => {
 const f = await fixture(), a = await f.invite('A'), b = await f.invite('B');
 const start = (token: string) => f.call(token, '/runs', 'POST', { robotId: 'robot', prompt: 'review' });
 const responses = await Promise.all([start(a.token), start(a.token), start(a.token), start(a.token)]);
 expect(responses.map(r => r.status).sort()).toEqual([201, 201, 429, 429]);
 const own = [...f.runs.values()]; own[0]!.status = 'waiting-user'; own[0]!.pendingQuestion = { id: 'q', text: 'Clarify?' };
 expect((await start(b.token)).status).toBe(201);
 await f.restart();
 const recovered = await (await f.call(a.token, '/runs')).json();
 expect(recovered.runs.map((run: Run) => run.id).sort()).toEqual(own.map(run => run.id).sort());
 expect((await start(a.token)).status).toBe(429);
 expect((await f.call(a.token, `/runs/${own[0]!.id}/cancel`, 'POST')).status).toBe(200);
 expect((await start(a.token)).status).toBe(201);
});

test('revision updates affect only new calls and metadata discloses execution/cost/visibility before calling', async () => {
 const f = await fixture(), a = await f.invite('A');
 const info = await (await f.call(a.token, '/robots')).json();
 expect(info.execution).toMatchObject({ location: 'owner-host', modelCostOwner: 'host-owner', deployment: 'loopback-only' });
 const first = await (await f.call(a.token, '/runs', 'POST', { robotId: 'robot', prompt: 'v1' })).json();
 f.setRevision('revision-2');
 const second = await (await f.call(a.token, '/runs', 'POST', { robotId: 'robot', prompt: 'v2' })).json();
 expect(first.revisionId).toBe('revision-1'); expect(second.revisionId).toBe('revision-2');
 expect((await (await f.call(a.token, `/runs/${first.runId}`)).json()).revisionId).toBe('revision-1');
});

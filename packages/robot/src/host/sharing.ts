import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Principal, Run } from '../domain/types.js';

export interface SharedHostPort {
  grantShared(robotId: string, principalId: string): Promise<void>;
  startShared(principal: Principal, robotId: string, prompt: string): Promise<{ runId: string; sessionId: string; revisionId: string }>;
  readShared(principal: Principal, runId: string): Promise<Run>;
  listShared(principal: Principal): Promise<Run[]>;
  answerShared(principal: Principal, runId: string, answer: { expectedVersion: number; questionId: string; answer: string }): Promise<Run>;
  resultShared(principal: Principal, runId: string): Promise<{ status: Run['status']; artifacts: { id: string; key: string; content: string }[]; findingStatus: 'unconfirmed' }>;
  cancelShared(principal: Principal, runId: string): Promise<Run>;
}
interface Invitation { id: string; label: string; principalId: string; tokenHash: string; robotIds: string[]; revoked: boolean; expiresAt: string }
interface ShareFile { schemaVersion: 1; invitations: Invitation[] }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Optional loopback invitation transport. No management methods or owner token cross this boundary. */
export class RobotSharingServer {
  private invitations: Invitation[] = [];
  private server?: Server;
  private writeTail: Promise<unknown> = Promise.resolve();
  private readonly admission = new Map<string, Promise<unknown>>();
  private readonly recent = new Map<string, number[]>();
  private address?: string;
  constructor(private readonly port: SharedHostPort, private readonly stateFile: string) {}
  async open(port = 0): Promise<string> {
    if (this.server) throw new Error('Sharing server already open');
    try { const file: ShareFile = JSON.parse(await readFile(this.stateFile, 'utf8')); if (file.schemaVersion !== 1 || !Array.isArray(file.invitations) || !file.invitations.every(i => i && typeof i.id === 'string' && i.principalId === `share:${i.id}` && typeof i.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(i.tokenHash) && Array.isArray(i.robotIds) && i.robotIds.every(id => typeof id === 'string') && typeof i.revoked === 'boolean' && typeof i.expiresAt === 'string' && Number.isFinite(Date.parse(i.expiresAt)))) throw new Error('Unsupported sharing schema'); this.invitations = file.invitations; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => this.respond(res, 500, { error: 'Shared request failed' })); });
    this.server.requestTimeout = 15_000; this.server.headersTimeout = 10_000;
    await new Promise<void>((accept, reject) => { this.server!.once('error', reject); this.server!.listen(port, '127.0.0.1', accept); });
    const bound = this.server.address(); if (!bound || typeof bound === 'string') throw new Error('No loopback address');
    this.address = `http://127.0.0.1:${bound.port}`; return this.address;
  }
  private persist(): Promise<void> {
    const snapshot = structuredClone(this.invitations);
    const work = this.writeTail.then(async () => { await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 }); const temp = `${this.stateFile}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify({ schemaVersion: 1, invitations: snapshot }), { mode: 0o600 }); await rename(temp, this.stateFile); });
    this.writeTail = work.catch(() => undefined); return work;
  }
  /** Called only by authenticated owner UI or trusted local setup; token is returned exactly once. */
  async invite(label: string, robotIds: string[], expiresAt: string): Promise<{ invitationId: string; endpoint: string; token: string }> {
    if (!this.address || !label.trim() || robotIds.length === 0 || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw new Error('Invalid invitation');
    const id = randomUUID(), principalId = `share:${id}`, token = randomBytes(32).toString('base64url');
    for (const robotId of new Set(robotIds)) await this.port.grantShared(robotId, principalId);
    const invitation = { id, label, principalId, tokenHash: hash(token), robotIds: [...new Set(robotIds)], revoked: false, expiresAt };
    this.invitations.push(invitation);
    try { await this.persist(); } catch (error) { this.invitations = this.invitations.filter(row => row !== invitation); throw error; }
    return { invitationId: id, endpoint: this.address, token };
  }
  async revoke(id: string): Promise<void> { const invitation = this.invitations.find(i => i.id === id); if (!invitation) throw new Error('Invitation not found'); invitation.revoked = true; await this.persist(); }
  list(): { id: string; label: string; robotIds: string[]; revoked: boolean; expiresAt: string }[] { return this.invitations.map(({ id, label, robotIds, revoked, expiresAt }) => ({ id, label, robotIds: [...robotIds], revoked, expiresAt })); }
  private respond(res: ServerResponse, status: number, data: unknown): void { if (res.headersSent || res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); }
  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const piece of req) { const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece); size += chunk.byteLength; if (size > 64_000) throw new Error('Request too large'); chunks.push(chunk); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required'); return value as Record<string, unknown>;
  }
  private view(run: Run): object {
    // Own-run status only: no absolute paths, model credentials, knowledge, other caller identities or session access token.
    return { id: run.id, robotId: run.robotId, revisionId: run.revisionId, status: run.status, stepId: run.stepId, version: run.version, pendingQuestion: run.pendingQuestion, ...(run.failureReason ? { failureReason: 'Task failed; contact the host owner for diagnostics.' } : {}), evidence: run.evidence.map(({ id, stepId, kind, key, outcome }) => ({ id, stepId, kind, key, outcome })) };
  }
  private valid(invitation: Invitation): boolean { return !invitation.revoked && Date.parse(invitation.expiresAt) > Date.now(); }
  private assertRun(invitation: Invitation, run: Run): void {
    if (run.principalId !== invitation.principalId || !invitation.robotIds.includes(run.robotId)) throw Object.assign(new Error('Run unavailable'), { code: 'NOT_FOUND' });
  }
  /** Serial admission counts durable active runs, including those waiting for input or approval. */
  private async admit<T>(id: string, action: () => Promise<T>): Promise<T> {
    const current = (this.admission.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.admission.set(id, current);
    try { return await current; } finally { if (this.admission.get(id) === current) this.admission.delete(id); }
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Explicit bearer transport, never browser cookies or query tokens. Cross-origin browser access is unsupported.
    if (req.headers.origin) { this.respond(res, 403, { error: 'Origin not accepted' }); return; }
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const supplied = token ? Buffer.from(hash(token), 'hex') : undefined;
    const invitation = supplied ? this.invitations.find(i => timingSafeEqual(Buffer.from(i.tokenHash, 'hex'), supplied) && this.valid(i)) : undefined;
    if (!invitation) { this.respond(res, 401, { error: 'Invalid or expired invitation' }); return; }
    const principal: Principal = { id: invitation.principalId, kind: 'human' }, path = new URL(req.url ?? '/', this.address).pathname;
    try {
      if (req.method === 'GET' && path === '/robots') { this.respond(res, 200, { robotIds: invitation.robotIds, execution: { location: 'owner-host', modelCostOwner: 'host-owner', visibility: 'caller sees own runs and artifacts; host owner can inspect them; task contents are not automatically published as knowledge', deployment: 'loopback-only' }, limits: { activeRuns: 2, startsPerMinute: 10 } }); return; }
      if (req.method === 'GET' && path === '/runs') { const runs = (await this.port.listShared(principal)).filter(run => run.principalId === principal.id && invitation.robotIds.includes(run.robotId)); this.respond(res, 200, { runs: runs.map(run => this.view(run)) }); return; }
      if (req.method === 'POST' && path === '/runs') {
        const body = await this.body(req);
        if (typeof body.robotId !== 'string' || !invitation.robotIds.includes(body.robotId) || typeof body.prompt !== 'string' || !body.prompt.trim()) { this.respond(res, 403, { error: 'Robot or prompt not permitted' }); return; }
        const robotId = body.robotId, prompt = body.prompt;
        await this.admit(principal.id, async () => {
          if (!this.valid(invitation)) { this.respond(res, 401, { error: 'Invalid or expired invitation' }); return; }
          const runs = await this.port.listShared(principal);
          const active = runs.filter(run => run.principalId === principal.id && !['succeeded', 'failed', 'cancelled'].includes(run.status)).length;
          const now = Date.now(), recent = (this.recent.get(principal.id) ?? []).filter(t => now - t < 60_000);
          if (active >= 2 || recent.length >= 10) { this.respond(res, 429, { error: 'Invocation limit reached' }); return; }
          recent.push(now); this.recent.set(principal.id, recent);
          if (!this.valid(invitation)) { this.respond(res, 401, { error: 'Invalid or expired invitation' }); return; }
          const run = await this.port.startShared(principal, robotId, prompt); this.respond(res, 201, { runId: run.runId, revisionId: run.revisionId });
        });
        return;
      }
      const match = /^\/runs\/([A-Za-z0-9_-]+)(?:\/(cancel|answer|result))?$/.exec(path), operation = match?.[2];
      if (match && ((req.method === 'GET' && (operation === undefined || operation === 'result')) || (req.method === 'POST' && (operation === 'cancel' || operation === 'answer')))) {
        const runId = match[1]!, run = await this.port.readShared(principal, runId);
        this.assertRun(invitation, run);
        if (operation === 'result') { const result = await this.port.resultShared(principal, runId); this.respond(res, 200, { runId, revisionId: run.revisionId, status: result.status, findingStatus: result.findingStatus, artifacts: result.artifacts.map(({ id, key, content }) => ({ id, key, content })) }); return; }
        if (operation === 'answer') {
          const body = await this.body(req);
          if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0 || typeof body.questionId !== 'string' || !body.questionId || typeof body.answer !== 'string' || !body.answer.trim()) throw new Error('Invalid answer');
          if (!this.valid(invitation)) { this.respond(res, 401, { error: 'Invalid or expired invitation' }); return; }
          const next = await this.port.answerShared(principal, runId, { expectedVersion: body.expectedVersion as number, questionId: body.questionId, answer: body.answer });
          this.assertRun(invitation, next); this.respond(res, 200, this.view(next)); return;
        }
        if (operation === 'cancel') {
          if (!this.valid(invitation)) { this.respond(res, 401, { error: 'Invalid or expired invitation' }); return; }
          const next = await this.port.cancelShared(principal, runId); this.assertRun(invitation, next); this.respond(res, 200, this.view(next)); return;
        }
        this.respond(res, 200, this.view(run)); return;
      }
      this.respond(res, 404, { error: 'Unknown route' });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      this.respond(res, code === 'FORBIDDEN' || code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' || code === 'BAD_STATE' ? 409 : 400, { error: code === 'FORBIDDEN' || code === 'NOT_FOUND' ? 'Run not found' : 'Request rejected' });
    }
  }
  async close(): Promise<void> { const server = this.server; if (!server) return; this.server = undefined; this.address = undefined; server.closeAllConnections(); await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); await Promise.allSettled([...this.admission.values()]); await this.writeTail; }
}

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { checkDomainBoundary } from '../../scripts/check-domain-boundary.mjs';
import { validateDataDirectory, copyValidatedData } from '../../scripts/migrate-data.mjs';
import { validateIsolatedHome, parseInstallArgs, installIsolated } from '../../scripts/install-isolated.mjs';
import { digest } from '../../packages/robot/src/domain/validation.ts';

function aggregate(name = 'Fixture') {
  const spec = { name, purpose: 'Review', instructions: 'Use evidence', model: { provider: 'mock', model: 'fixture' }, resources: [], workflow: { entry: 'review', steps: [{ id: 'review', title: 'Review', instruction: 'Inspect', skillIds: [], allowedActions: [], checks: [], transitions: { done: null }, maxVisits: 1 }] }, requiredCapabilities: [], externalActions: [] };
  return { schemaVersion: 1, robot: { id: 'robot', ownerId: 'owner', currentRevisionId: 'revision', disabled: false, version: 1 }, draft: { id: 'draft', robotId: 'robot', editVersion: 1, spec }, revisions: [{ schemaVersion: 1, id: 'revision', robotId: 'robot', spec, digest: digest(spec), resourceDigests: {} }], proposals: [] };
}
async function data(directory, value = aggregate()) { await mkdir(join(directory, 'robots'), { recursive: true }); await mkdir(join(directory, 'runs'), { recursive: true }); await writeFile(join(directory, 'robots/robot.json'), JSON.stringify(value)); }

describe('isolated operations', () => {
  it('refuses the regular DSH home and aliases to it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'robot-home-'));
    try {
      await mkdir(join(directory, '.dsh')); await symlink(join(directory, '.dsh'), join(directory, 'alias'));
      await expect(validateIsolatedHome(join(directory, '.dsh'), directory)).rejects.toThrow('separate');
      await expect(validateIsolatedHome(join(directory, 'alias'), directory)).rejects.toThrow('separate');
      expect(await validateIsolatedHome(join(directory, '.dsh-robots'), directory)).toBe(join(await realpath(directory), '.dsh-robots'));
      expect(() => parseInstallArgs(['--version', 'latest'])).toThrow('exact');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('copies schema 1 without changing record bytes and rejects future schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'robot-migration-'));
    try {
      const source = join(directory, 'source'), target = join(directory, 'target'); await data(source);
      const before = await readFile(join(source, 'robots/robot.json'));
      const report = await copyValidatedData(source, target);
      expect(report.robots).toBe(1);
      expect(await readFile(join(target, 'robots/robot.json'))).toEqual(before);
      expect(await readFile(join(source, 'robots/robot.json'))).toEqual(before);
      await writeFile(join(source, 'robots/robot.json'), JSON.stringify({ ...aggregate(), schemaVersion: 9 }));
      await expect(copyValidatedData(source, join(directory, 'future'))).rejects.toThrow('Unsupported schema');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('preserves run evidence, action inputs and retrospective helpers in a validated backup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'robot-aux-copy-'));
    try {
      const source = join(directory, 'source'), target = join(directory, 'target');
      await data(source);
      const content = 'Unconfirmed finding', actionInput = { comment: 'Review this result' };
      const feedback = { category: 'correction', note: 'Evidence distinguishes a suspicion from a defect.' };
      const files = {
        'runs/run.json': { schemaVersion: 1, run: { id: 'run', robotId: 'robot', revisionId: 'revision', principalId: 'owner', version: 1, evidence: [{ kind: 'artifact', key: 'report', stepId: 'review', reference: join(source, 'artifacts/run/artifact.json') }] } },
        'artifacts/run/artifact.json': { key: 'report', content, digest: digest(content), runId: 'run', stepId: 'review' },
        'action-inputs/run/attempt.json': { schemaVersion: 1, runId: 'run', revisionId: 'revision', actionId: 'attempt', action: 'post', input: actionInput, inputDigest: digest(actionInput), executorVersion: '1' },
        'retrospectives/run.json': { content: { sourceRunId: 'run', principal: { id: 'owner' } }, sessionId: 'helper' },
        [`retrospectives/run-feedback-${digest(feedback).slice(0, 32)}.json`]: { content: { sourceRunId: 'run', principal: { id: 'owner' } }, sessionId: 'feedback-helper', feedback },
      };
      for (const [name, value] of Object.entries(files)) {
        await mkdir(dirname(join(source, name)), { recursive: true });
        await writeFile(join(source, name), JSON.stringify(value));
      }
      expect((await copyValidatedData(source, target)).files).toHaveLength(6);
      expect(await readFile(join(target, 'artifacts/run/artifact.json'), 'utf8')).toBe(JSON.stringify(files['artifacts/run/artifact.json']));
      const altered = { ...files['artifacts/run/artifact.json'], content: 'Tampered' };
      await writeFile(join(target, 'artifacts/run/artifact.json'), JSON.stringify(altered));
      await expect(validateDataDirectory(target)).rejects.toThrow('digest mismatch');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a running store or a corrupted immutable revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'robot-live-'));
    try {
      await data(directory); await writeFile(join(directory, 'writer.lock'), '{}');
      await expect(validateDataDirectory(directory)).rejects.toThrow('writer.lock');
      await rm(join(directory, 'writer.lock'));
      const record = aggregate(); record.revisions[0].digest = 'invalid'; await data(directory, record);
      await expect(validateDataDirectory(directory)).rejects.toThrow('digest mismatch');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('detects Host imports through static, type and dynamic syntax', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'robot-boundary-'));
    try {
      await writeFile(join(directory, 'bad.ts'), "import type { Context } from '@deepseek-ai/cordis'; export type T = import('../host/api').T; const m = import('../adapters/dsh');");
      expect(await checkDomainBoundary(directory)).toHaveLength(3);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('restores only owned robot data and configuration while preserving DSH Sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'robot-restore-'));
    try {
      const home = await realpath(directory), oldRelease = join(home, 'old-release'), newRelease = join(home, 'new-release');
      for (const release of [oldRelease, newRelease]) for (const folder of ['robot', 'ui-robot']) await mkdir(join(release, folder), { recursive: true });
      const cli = join(home, 'cli.mjs'); await writeFile(cli, '');
      const previous = { kind: 'dsh-robots-installation', home, version: '0.2.2-rc.3', cli, release: newRelease };
      await writeFile(join(home, 'robot-installation.json'), JSON.stringify(previous));
      await mkdir(join(home, 'profiles/web/node_modules/@fanbo'), { recursive: true });
      for (const [name, folder] of [['dsh-robot', 'robot'], ['dsh-ui-robot', 'ui-robot']]) await symlink(join(newRelease, folder), join(home, 'profiles/web/node_modules/@fanbo', name));
      await writeFile(join(home, 'profiles/web/package.json'), '{"new":true}'); await writeFile(join(home, 'profiles/web/cordis.patch.yml'), '[]');
      await data(join(home, 'robots'), aggregate('New'));
      await mkdir(join(home, 'sessions')); await writeFile(join(home, 'sessions/keep.jsonl'), 'untouched');
      const backup = join(home, 'selected-backup'); await mkdir(backup);
      await writeFile(join(backup, 'robot-installation.json'), JSON.stringify({ ...previous, version: '0.2.2-rc.2', release: oldRelease }));
      await writeFile(join(backup, 'package.json'), '{"old":true}'); await writeFile(join(backup, 'cordis.patch.yml'), '[]'); await data(join(backup, 'robots'), aggregate('Old'));
      const result = await installIsolated({ home, restore: backup, stopped: true });
      expect(result.version).toBe('0.2.2-rc.2');
      expect(JSON.parse(await readFile(join(home, 'robots/robots/robot.json'), 'utf8')).draft.spec.name).toBe('Old');
      expect(await readFile(join(home, 'sessions/keep.jsonl'), 'utf8')).toBe('untouched');
      expect(await realpath(join(home, 'profiles/web/node_modules/@fanbo/dsh-robot'))).toBe(join(oldRelease, 'robot'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

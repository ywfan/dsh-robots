/** Validate and copy schema-1 Robot data without modifying Harness sessions. */
import { readdir, readFile, mkdir, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import { dirname, resolve, join, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';

const domain = await tsImport('../packages/robot/src/domain/validation.ts', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const idPattern = '[A-Za-z0-9][A-Za-z0-9_.-]*';
const rootFiles = new RegExp(`^(robots|runs|retrospectives)/(${idPattern})\\.json$`);
const runFiles = new RegExp(`^(artifacts|action-inputs)/(${idPattern})/(${idPattern})\\.json$`);
const rootDirectories = new Set(['robots', 'runs', 'retrospectives', 'artifacts', 'action-inputs']);
const runDirectories = new Set(['artifacts', 'action-inputs']);
const validId = new RegExp(`^${idPattern}$`);
const descendants = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export async function validateDataDirectory(directory) {
  const root = resolve(directory);
  const files = [];
  const robots = new Map();
  const runs = new Map();
  const auxiliary = new Map();
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Data source must be a real directory');

  async function inspect(parent = '') {
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      const name = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${name}`);
      if (name === 'writer.lock') throw new Error('Robot store has writer.lock; stop the Host and verify stale locks before migration');
      if (entry.isDirectory()) {
        const allowed = parent ? runDirectories.has(parent) && validId.test(entry.name) : rootDirectories.has(entry.name);
        if (!allowed) throw new Error(`Unknown data directory: ${name}`);
        await inspect(name);
        continue;
      }
      const location = rootFiles.exec(name) ?? runFiles.exec(name);
      if (!entry.isFile() || (!location && name !== 'shares.json')) throw new Error(`Unknown data file: ${name}`);
      const bytes = await readFile(join(root, name));
      const value = JSON.parse(bytes.toString('utf8'));
      const [kind, recordId, itemId] = location?.slice(1) ?? [];
      // Old artifact and retrospective records have no schema field. Their shape below is their version-1 contract.
      const legacyAuxiliary = ['artifacts', 'retrospectives'].includes(kind);
      if (value?.schemaVersion !== 1 && !(legacyAuxiliary && value?.schemaVersion === undefined && value)) {
        throw new Error(`Unsupported schema ${String(value?.schemaVersion)} in ${name}; explicit migration required`);
      }
      if (kind === 'robots') {
        if (value.robot?.id !== recordId || !value.draft || !Array.isArray(value.revisions) || !Array.isArray(value.proposals)) throw new Error(`Malformed robot: ${name}`);
        domain.validateSpec(value.draft.spec);
        if (value.draft.robotId !== value.robot.id) throw new Error(`Draft robot mismatch: ${name}`);
        for (const revision of value.revisions) {
          if (revision.schemaVersion !== 1 || revision.robotId !== value.robot.id) throw new Error(`Revision schema/identity mismatch: ${name}`);
          domain.validateSpec(revision.spec);
          if (revision.digest !== domain.digest(revision.spec) || domain.digest(revision.resourceDigests) !== domain.digest(domain.resourceDigests(revision.spec.resources))) throw new Error(`Revision digest mismatch: ${name}`);
        }
        if (value.robot.currentRevisionId && !value.revisions.some(revision => revision.id === value.robot.currentRevisionId)) throw new Error(`Missing current revision: ${name}`);
        for (const proposal of value.proposals) domain.validateSpec(proposal.proposedSpec);
        robots.set(value.robot.id, value);
      } else if (kind === 'runs') {
        if (value.run?.id !== recordId || !Number.isInteger(value.run.version) || !Array.isArray(value.run.evidence)) throw new Error(`Malformed run: ${name}`);
        runs.set(value.run.id, value.run);
      } else if (kind) {
        auxiliary.set(name, { kind, recordId, itemId, value });
      } else if (!Array.isArray(value.invitations)) {
        throw new Error('Malformed sharing invitations');
      }
      files.push({ name, bytes, sha256: hash(bytes) });
    }
  }

  await inspect();
  for (const run of runs.values()) {
    if (!robots.get(run.robotId)?.revisions.some(revision => revision.id === run.revisionId)) throw new Error(`Run ${run.id} refers to a missing robot revision`);
    for (const receipt of run.evidence.filter(item => item.kind === 'artifact')) {
      if (typeof receipt.reference !== 'string') throw new Error(`Invalid artifact reference for run ${run.id}`);
      const reference = receipt.reference.replaceAll('\\', '/');
      const parts = reference.split('/');
      const name = parts.slice(-3).join('/');
      const artifact = auxiliary.get(name);
      if (artifact?.kind !== 'artifacts' || artifact.recordId !== run.id || artifact.value.key !== receipt.key || artifact.value.stepId !== receipt.stepId) throw new Error(`Artifact does not match a receipt for run ${run.id}`);
    }
  }
  for (const [name, record] of auxiliary) {
    const { kind, recordId, itemId, value } = record;
    const run = runs.get(kind === 'retrospectives' ? value.content?.sourceRunId : recordId);
    if (!run) throw new Error(`Missing run for ${name}`);
    if (kind === 'artifacts' && (value.runId !== recordId || typeof value.key !== 'string' || typeof value.stepId !== 'string' || typeof value.content !== 'string' || value.digest !== domain.digest(value.content))) throw new Error(`Artifact identity or digest mismatch: ${name}`);
    if (kind === 'action-inputs' && (value.runId !== recordId || value.revisionId !== run.revisionId || value.actionId !== itemId || typeof value.action !== 'string' || value.input === undefined || value.inputDigest !== domain.digest(value.input) || typeof value.executorVersion !== 'string')) throw new Error(`Action input identity or digest mismatch: ${name}`);
    if (kind === 'retrospectives') {
      const expectedId = value.feedback ? `${run.id}-feedback-${domain.digest(value.feedback).slice(0, 32)}` : run.id;
      if (recordId !== expectedId || value.content?.principal?.id !== run.principalId || typeof value.sessionId !== 'string') throw new Error(`Retrospective identity mismatch: ${name}`);
    }
  }

  return { schemaVersion: 1, robots: robots.size, runs: runs.size, files };
}

export async function copyValidatedData(source, destination) {
  const report = await validateDataDirectory(source);
  const target = resolve(destination);
  const physicalTarget = join(await realpath(dirname(target)), relative(dirname(target), target));
  if (descendants(await realpath(source), physicalTarget)) throw new Error('Migration destination must be outside the source');
  await mkdir(target, { mode: 0o700 });
  try {
    await mkdir(join(target, 'robots'), { mode: 0o700 });
    await mkdir(join(target, 'runs'), { mode: 0o700 });
    for (const file of report.files) {
      const destinationFile = join(target, file.name);
      await mkdir(dirname(destinationFile), { recursive: true, mode: 0o700 });
      await writeFile(destinationFile, file.bytes, { flag: 'wx', mode: 0o600 });
    }
    const checked = await validateDataDirectory(target);
    const originalHashes = new Map(report.files.map(file => [file.name, file.sha256]));
    if (checked.files.length !== report.files.length || checked.files.some(file => originalHashes.get(file.name) !== file.sha256)) throw new Error('Copied data differs from the source');
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return { schemaVersion: 1, robots: report.robots, runs: report.runs, files: report.files.map(({ name, sha256 }) => ({ name, sha256 })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source) throw new Error('Usage: node scripts/migrate-data.mjs SOURCE [FRESH_DESTINATION]');
  const report = destination ? await copyValidatedData(source, destination) : await validateDataDirectory(source);
  console.log(JSON.stringify({ schemaVersion: report.schemaVersion, robots: report.robots, runs: report.runs, files: report.files.map(({ name, sha256 }) => ({ name, sha256 })), mode: destination ? 'identity-copy-verified' : 'read-only-validation' }, null, 2));
}

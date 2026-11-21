/** Exercise the real built service on a keyless rc.3 host, restart, and the adjacent rc.2 host. */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';

const root = resolve(import.meta.dirname, '..');
const sandbox = join(root, '.runtime', 'service-smoke');
await mkdir(sandbox, { recursive: true, mode: 0o700 });
const target = await mkdtemp(join(sandbox, 'run-'));
const baseline = '0.2.2-rc.3';
const adjacent = '0.2.2-rc.2';
const workspace = join(target, 'workspace');
const fixture = join(target, 'service-probe.mjs');
const state = join(target, 'state.json');
for (const folder of ['alpha', 'beta']) {
  await mkdir(join(workspace, folder), { recursive: true });
  await writeFile(join(workspace, folder, 'proof.txt'), `${folder} fixture\n`);
}
await cp(join(root, 'tests/compat/service-probe.mjs'), fixture);
for (const file of ['index.js', 'agent.js', 'sharing.js', 'typert.host.js']) {
  if (!existsSync(join(root, 'packages/robot/lib', file))) throw new Error('Build the robot packages first: pnpm build');
}

async function cliFor(version) {
  if (version === baseline) return join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const dir = join(root, '.compat/rc2');
  const cli = join(dir, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  if (!existsSync(cli)) execFileSync(process.execPath, [join(root, 'scripts/check-dsh-compat.mjs'), version], { cwd: root, stdio: 'inherit' });
  return cli;
}

async function prepareHome(home, version, enabled = true, missingDelegation = false) {
  const profile = join(home, 'profiles/web');
  const scope = join(profile, 'node_modules/@fanbo');
  const pkg = join(root, 'packages/robot');
  await mkdir(scope, { recursive: true, mode: 0o700 });
  const plugin = join(scope, 'dsh-robot');
  if (!existsSync(plugin)) await symlink(pkg, plugin, 'dir');
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'robot-service-probe-profile', private: true,
    dependencies: { '@fanbo/dsh-robot': `link:${pkg}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }));
  const patch = [
    ...['hmr', 'session-title-llm', 'session-log-deepseek', 'llm-deepseek', 'llm-deepseek-account',
      'otel', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics'].map(id => ({ id, disabled: true })),
    ...(missingDelegation ? [{ id: "subagent", disabled: true }] : []),
    { insert: [
      ...(enabled ? [
        { id: 'robot-management', name: '@fanbo/dsh-robot', config: { dataDir: join(home, 'robots'), workspaceRoot: workspace, hostVersion: version, autoRetrospective: false } },
        { id: 'robot-sharing', name: '@fanbo/dsh-robot/sharing' },
      ] : []),
      { id: 'robot-service-probe', name: fixture },
    ] },
  ];
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(patch, null, 2));
}

async function run(home, version, stage) {
  const cli = await cliFor(version);
  const manifest = JSON.parse(await readFile(join(cli, '../../package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error(`Expected installed DSH ${version}, received ${manifest.version}`);
  const reportFile = join(target, `${stage}.json`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DSH|DEEPSEEK|OPENAI|ANTHROPIC|ROBOT_|.*(API_KEY|TOKEN|CREDENTIAL|SECRET))/i.test(key)));
  Object.assign(env, { DSH_HOME: home, ROBOT_SERVICE_VERSION: version,
    ROBOT_SERVICE_WORKSPACE: workspace, ROBOT_SERVICE_STAGE: stage,
    ROBOT_SERVICE_REPORT: reportFile, ROBOT_SERVICE_STATE: state,
  });
  const child = spawn(process.execPath, [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'exit');
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs += bytes; });
  try {
    const deadline = Date.now() + 40_000;
    let report;
    while (child.exitCode === null && Date.now() < deadline) {
      if (existsSync(reportFile)) {
        try { report = JSON.parse(await readFile(reportFile, 'utf8')); break; }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      await delay(100);
    }
    if (!report) throw new Error(`No report for ${stage}; see ${join(target, stage + '.log')}`);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) throw new Error(`${stage} integration failed`);
    return report;
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const grace = AbortSignal.timeout(3000);
      await Promise.race([exit, delay(3000, undefined, { signal: grace }).catch(() => {})]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    }
    await writeFile(join(target, stage + '.log'), logs.replace(/[?&](?:token|auth|key)=[^&\s]+/gi, '?[redacted]'), { mode: 0o600 });
  }
}

const firstHome = join(target, 'baseline');
await prepareHome(firstHome, baseline);
const created = await run(firstHome, baseline, 'create');
const restarted = await run(firstHome, baseline, 'restart');
const olderHome = join(target, 'adjacent');
await prepareHome(olderHome, adjacent);
// Exercise the portable robot data format without copying or downgrading DSH session journals.
await cp(join(firstHome, 'robots'), join(olderHome, 'robots'), {
  recursive: true, filter: path => !path.endsWith('/writer.lock'),
});
const copied = await run(olderHome, adjacent, 'adjacent');
await prepareHome(firstHome, baseline, false);
const disabled = await run(firstHome, baseline, 'disabled');
const minimalHome = join(target, 'without-delegation');
await prepareHome(minimalHome, baseline, true, true);
const degraded = await run(minimalHome, baseline, 'without-delegation');
const reports = [created, restarted, copied, disabled, degraded];
await writeFile(join(target, 'report.json'), JSON.stringify({
  recordedAt: new Date().toISOString(), passed: true, method: 'official DSH web hosts; local scripted LLM fixture; no live model network calls', reports,
}, null, 2) + '\n');
console.log(`Full evidence: ${join(target, 'report.json')}`);

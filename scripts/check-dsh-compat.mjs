import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const version = process.argv[2] ?? '0.2.2-rc.2';
if (!/^0\.2\.2-rc\.[23]$/.test(version)) throw new Error('This fixture accepts the two reviewed adjacent baseline releases only; extend the test matrix explicitly.');
const target = join(root, '.compat', version.endsWith('.2') ? 'rc2' : 'rc3');
await mkdir(join(target, 'workspace'), { recursive: true });
const dependencyNames = ['dsh', 'dsh-llm', 'dsh-tools', 'dsh-tool-executor-native'];
await writeFile(join(target, 'package.json'), JSON.stringify({ name: `robot-dsh-compat-${version}`, private: true, type: 'module', dependencies: Object.fromEntries(dependencyNames.map(name => [`@deepseek-ai/${name}`, version])) }, null, 2) + '\n');
if (!existsSync(join(target, 'node_modules/@deepseek-ai/dsh'))) execFileSync('pnpm', ['--dir', target, 'install', '--ignore-workspace'], { cwd: root, stdio: 'inherit' });
const actual = JSON.parse(await readFile(join(target, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
if (actual !== version) throw new Error(`Expected ${version}; isolated installation contains ${actual}`);
await build({ entryPoints: [join(root, 'tests/compat/runtime-probe.mjs')], outfile: join(target, 'probe.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node24' });
await writeFile(join(target, 'capability.mjs'), `import {defineTool} from '@deepseek-ai/dsh-tools';\nexport const name='robot-probe-capability';export const inject=['tools'];export function apply(ctx){ctx.tools.register(defineTool({name:'robot_probe',description:'Local deterministic compatibility probe.',parameters:{},output:{schema:{type:'string'},render:(_a,value)=>[{type:'text',text:value}]},isConcurrencySafe:()=>false,async execute(){return 'executed';}}));}\n`);
const patch = [
  { id: 'session-title-llm', disabled: true },
  { insert: [{ id: 'robot-compat-probe', name: join(target, 'probe.mjs') }] },
];
await writeFile(join(target, 'probe.patch.yml'), JSON.stringify(patch, null, 2));
const reportFile = join(target, 'runtime-report.json');
await rm(reportFile, { force: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DSH|DEEPSEEK|OPENAI|ANTHROPIC|API_KEY|.*TOKEN)/i.test(key)));
Object.assign(env, { DSH_HOME: join(target, 'home'), ROBOT_COMPAT_VERSION: version, ROBOT_COMPAT_ROOT: target, ROBOT_COMPAT_WORKSPACE: join(target, 'workspace'), ROBOT_COMPAT_REPORT: reportFile });
const child = spawn(process.execPath, [join(target, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', join(target, 'probe.patch.yml'), '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: target, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
let exited = false;
child.once('exit', () => { exited = true; });
const deadline = Date.now() + 45000;
try {
  while (!existsSync(reportFile) && !exited && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  await writeFile(join(target, 'runtime.log'), log);
  if (!existsSync(reportFile)) throw new Error(`Runtime probe produced no report; see ${join(target, 'runtime.log')}`);
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  if (!exited && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
}

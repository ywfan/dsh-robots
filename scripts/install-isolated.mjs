/** Install or restore owned robot configuration in a dedicated, stopped DSH home. */
import { homedir } from 'node:os';
import { resolve, join, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile, rename, lstat, readdir, realpath, symlink, cp, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyValidatedData } from './migrate-data.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const markerName = 'robot-installation.json';
const testedVersions = new Set(['0.2.2-rc.2', '0.2.2-rc.3']);

async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function canonicalFuture(path) {
  try { return await realpath(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return join(await canonicalFuture(dirname(path)), basename(path)); }
}

/** Never install into the conventional DSH home, including symlink aliases. */
export async function validateIsolatedHome(home, userHome = homedir()) {
  const target = await canonicalFuture(resolve(home));
  const protectedHome = await canonicalFuture(join(userHome, '.dsh'));
  const contains = (parent, child) => {
    const path = relative(parent, child);
    return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path));
  };
  if (contains(protectedHome, target) || contains(target, protectedHome)) throw new Error('A separate DSH_HOME is required; ~/.dsh and its ancestors/children are protected');
  return target;
}

export function parseInstallArgs(args) {
  const options = { home: join(homedir(), '.dsh-robots'), version: '0.2.2-rc.3', workspace: projectRoot, stopped: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--stopped') options.stopped = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--experimental') options.experimental = true;
    else if (['--home', '--version', '--workspace', '--restore'].includes(flag)) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      options[flag.slice(2)] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(options.version)) throw new Error('Use an exact released CLI version');
  return options;
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally {
    if (await exists(temp)) await unlink(temp);
  }
}

async function linkRelease(home, release, expectedPrevious) {
  const parent = join(home, 'profiles/web/node_modules/@fanbo');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  for (const [name, folder] of [['dsh-robot', 'robot'], ['dsh-ui-robot', 'ui-robot']]) {
    const target = join(parent, name), source = join(release, folder);
    if (await exists(target)) {
      if (!(await lstat(target)).isSymbolicLink()) throw new Error(`Refusing non-link package: ${target}`);
      const actual = await realpath(target);
      if (actual === await realpath(source)) continue;
      if (!expectedPrevious || actual !== await realpath(join(expectedPrevious, folder))) throw new Error(`Existing package link differs: ${target}`);
      await unlink(target);
    }
    await symlink(source, target, 'dir');
  }
}

async function snapshot(home, marker) {
  const backup = join(home, 'robot-backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  for (const name of ['package.json', 'cordis.patch.yml']) {
    const file = join(home, 'profiles/web', name);
    if (await exists(file)) await writeFile(join(backup, name), await readFile(file), { mode: 0o600 });
  }
  await atomicJson(join(backup, markerName), marker);
  if (await exists(join(home, 'robots'))) await copyValidatedData(join(home, 'robots'), join(backup, 'robots'));
  return backup;
}

export async function installIsolated(options) {
  const home = await validateIsolatedHome(options.home);
  const markerPath = join(home, markerName);
  let previous;
  if (await exists(markerPath)) {
    previous = JSON.parse(await readFile(markerPath, 'utf8'));
    if (previous.kind !== 'dsh-robots-installation' || previous.home !== home) throw new Error('Installation marker does not match this home');
    if (!options.stopped) throw new Error('Stop the Host first, then pass --stopped; the installer never interrupts a running Host');
  } else if (await exists(home) && (await readdir(home)).length) throw new Error('Refusing an existing unowned DSH home; choose a new directory');
  if (await exists(join(home, 'robots/writer.lock'))) throw new Error('writer.lock exists; stop the Host and verify stale locks before continuing');
  if (options.restore) {
    if (!previous || !options.stopped) throw new Error('Restore requires an owned stopped installation');
    const backup = resolve(options.restore);
    const restored = JSON.parse(await readFile(join(backup, markerName), 'utf8'));
    if (restored.kind !== 'dsh-robots-installation' || restored.home !== home) throw new Error('Backup belongs to another installation');
    if (!restored.release || !await exists(restored.cli) || !await exists(restored.release)) throw new Error('Backup CLI or plugin artifacts are unavailable; restore their original installation first');
    if (options.dryRun) return { action: 'restore', home, backup, version: restored.version };
    const profile = join(home, 'profiles/web');
    const config = await Promise.all(['package.json', 'cordis.patch.yml'].map(name => readFile(join(backup, name))));
    const staged = join(home, `robots-restoring-${randomUUID()}`);
    const beforeRestore = await snapshot(home, previous);
    if (await exists(join(backup, 'robots'))) await copyValidatedData(join(backup, 'robots'), staged);
    await linkRelease(home, restored.release, previous.release);
    await writeFile(join(profile, 'package.json'), config[0], { mode: 0o600 });
    await writeFile(join(profile, 'cordis.patch.yml'), config[1], { mode: 0o600 });
    if (await exists(staged)) {
      if (await exists(join(home, 'robots'))) await rename(join(home, 'robots'), join(home, `robots-before-restore-${randomUUID()}`));
      await rename(staged, join(home, 'robots'));
    }
    await atomicJson(markerPath, restored);
    return { action: 'restored', home, version: restored.version, beforeRestore, restartRequired: true };
  }

  if (!testedVersions.has(options.version) && !options.experimental) throw new Error('This DSH version is outside the tested matrix. Use --experimental with a fresh isolated home.');
  if (!testedVersions.has(options.version) && previous) throw new Error('Test a new DSH version in a fresh isolated home before changing this installation.');
  const workspace = await realpath(resolve(options.workspace));
  if (!(await lstat(workspace)).isDirectory()) throw new Error('Workspace must be a directory');
  const toolchain = join(home, 'robot-toolchains', options.version);
  const cli = join(toolchain, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const plan = { action: previous ? 'upgrade' : 'install', home, version: options.version, workspace, toolchain, cli, restartRequired: true, credentialsCopied: false };
  if (options.dryRun) return plan;
  for (const file of ['packages/robot/lib/index.js', 'packages/robot/lib/agent.js', 'packages/robot/lib/sharing.js', 'packages/ui-robot/lib/index.js', 'packages/ui-robot/lib/client.js']) if (!await exists(join(projectRoot, file))) throw new Error(`Missing ${file}; run pnpm build first`);

  await mkdir(home, { recursive: true, mode: 0o700 });
  const backup = previous ? await snapshot(home, previous) : undefined;
  const projectManifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  if (!await exists(cli)) {
    await atomicJson(join(toolchain, 'package.json'), { name: `dsh-robots-cli-${options.version}`, private: true, type: 'module', dependencies: { '@deepseek-ai/dsh': options.version, zod: projectManifest.dependencies.zod, '@deepseek-ai/schemastery': projectManifest.dependencies['@deepseek-ai/schemastery'] } });
    execFileSync('pnpm', ['--dir', toolchain, 'install', '--ignore-workspace'], { cwd: projectRoot, stdio: 'inherit' });
  }
  const installed = JSON.parse(await readFile(join(toolchain, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
  if (installed.version !== options.version) throw new Error('Installed CLI version differs from requested version');
  const profile = join(home, 'profiles/web');
  const release = join(home, 'robot-releases', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  for (const folder of ['robot', 'ui-robot']) {
    const source = join(projectRoot, 'packages', folder), target = join(release, folder);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await cp(join(source, 'lib'), join(target, 'lib'), { recursive: true, errorOnExist: true, force: false });
    await writeFile(join(target, 'package.json'), await readFile(join(source, 'package.json')), { mode: 0o600 });
    await symlink(join(toolchain, 'node_modules'), join(target, 'node_modules'), 'dir');
  }
  await linkRelease(home, release, previous?.release);
  await atomicJson(join(profile, 'package.json'), {
    name: 'dsh-robots-profile-web', private: true,
    dependencies: { '@fanbo/dsh-robot': `link:${join(release, 'robot')}`, '@fanbo/dsh-ui-robot': `link:${join(release, 'ui-robot')}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  });
  await atomicJson(join(profile, 'cordis.patch.yml'), [
    { id: 'hmr', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { insert: [
      { id: 'robot-management', name: '@fanbo/dsh-robot', config: { dataDir: join(home, 'robots'), workspaceRoot: workspace, hostVersion: options.version, autoRetrospective: true } },
      { id: 'robot-sharing', name: '@fanbo/dsh-robot/sharing' },
      { id: 'robot-ui', name: '@fanbo/dsh-ui-robot' },
    ] },
  ]);
  await atomicJson(markerPath, { kind: 'dsh-robots-installation', home, version: options.version, toolchain, cli, release, projectRoot, workspace, installedAt: new Date().toISOString() });
  return { ...plan, release, backup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await installIsolated(parseInstallArgs(process.argv.slice(2))), null, 2));

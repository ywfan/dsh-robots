/** Start the pinned public CLI with the installation's own DSH_HOME. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateIsolatedHome } from './install-isolated.mjs';

const args = process.argv.slice(2);
let requestedHome = join(homedir(), '.dsh-robots');
let port = 0;
let withoutRobots = false;
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  if (option === '--without-robots') {
    withoutRobots = true;
    continue;
  }
  if (option === '--help') {
    console.log('Usage: node scripts/launch-isolated.mjs [--home PATH] [--port NUMBER] [--without-robots]');
    process.exit(0);
  }
  if (!['--home', '--port'].includes(option)) throw new Error('Unknown option: ' + option);
  const value = args[++index];
  if (!value || value.startsWith('--')) throw new Error('Missing value for ' + option);
  if (option === '--home') requestedHome = value;
  else {
    if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error('Port must be 0 to 65535');
    port = Number(value);
  }
}
const home = await validateIsolatedHome(requestedHome);
const marker = JSON.parse(await readFile(join(home, 'robot-installation.json'), 'utf8'));
if (marker.kind !== 'dsh-robots-installation' || marker.home !== home) throw new Error('Invalid robot installation');
const cliArgs = [marker.cli, '--profile', 'web'];
if (withoutRobots) cliArgs.push('--patch', fileURLToPath(new URL('./disable-robots.patch.json', import.meta.url)));
cliArgs.push('--host', '127.0.0.1', '--port', String(port), '--no-open');
const child = spawn(process.execPath, cliArgs, {
  cwd: marker.workspace,
  env: { ...process.env, DSH_HOME: home },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });

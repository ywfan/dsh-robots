import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['scripts/generate-remotes.mjs'], { cwd: root, stdio: 'inherit' });
await build({ entryPoints: ['packages/robot/src/index.ts', 'packages/robot/src/agent.ts', 'packages/robot/src/sharing.ts', 'packages/robot/src/domain/types.ts'], outbase: 'packages/robot/src', outdir: 'packages/robot/lib', bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node24', sourcemap: true });
await build({ entryPoints: ['packages/ui-robot/src/index.ts'], outfile: 'packages/ui-robot/lib/index.js', bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node24' });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'packages/robot/tsconfig.json'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/build-client.mjs'], { cwd: root, stdio: 'inherit' });

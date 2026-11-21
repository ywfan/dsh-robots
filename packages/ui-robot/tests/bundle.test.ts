/** Published browser output must remain lazy and share the host's React identity. */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
// The build entry is intentionally JavaScript, so it runs without a source loader.
// @ts-expect-error The script's exported helper is exercised at the artifact boundary.
import { buildClient } from '../../../scripts/build-client.mjs';

describe('standalone browser bundle', () => {
  it('registers a lazy factory and obtains React from the host module table', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'robot-bundle-'));
    try {
      const entry = join(directory, 'entry.ts');
      const outfile = join(directory, 'client.js');
      await writeFile(entry, "import * as React from 'react'; globalThis.executed = true; export function apply() { return React; }");
      await buildClient({ entry, outfile, id: '@fanbo/robot-test' });
      let registered: { id: string; factory: (require: (id: string) => object) => { apply: () => { createElement: () => null } } } | undefined;
      const sandbox = { window: { __ModuleLoader__: { load: (value: typeof registered) => { registered = value; } } }, executed: false };
      runInNewContext(await readFile(outfile, 'utf8'), sandbox);
      expect(sandbox.executed).toBe(false);
      expect(registered?.id).toBe('@fanbo/robot-test');
      const sharedReact = { createElement: () => null };
      const exported = registered!.factory((specifier) => { expect(specifier).toBe('react'); return sharedReact; });
      expect(sandbox.executed).toBe(true);
      expect(exported.apply().createElement).toBe(sharedReact.createElement);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps CSS installation inside the factory and marks it for DSH cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'robot-css-'));
    try {
      const entry = join(directory, 'entry.ts');
      await writeFile(join(directory, 'page.module.css'), '.page { color: var(--dsw-alias-label-primary); }');
      await writeFile(entry, "import styles from './page.module.css'; export const className = styles.page;");
      const output = await buildClient({ entry, outfile: join(directory, 'client.js'), id: '@fanbo/robot-test' });
      expect(output).toContain('dataset.plugin');
      expect(output.indexOf('factory:')).toBeLessThan(output.indexOf('createElement("style")'));
      expect(output).not.toContain('/deepseek-harness/');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

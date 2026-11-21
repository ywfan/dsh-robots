import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RobotWorkspace } from '../src/host/workspace.js';

it('confines robot files to its own workspace and refuses a replaced scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'robot-workspaces-'));
  try {
    const service = join(root, 'projects', 'service');
    await mkdir(join(service, '.runtime'), { recursive: true });
    await mkdir(join(root, 'other'));
    await writeFile(join(service, 'source.ts'), 'owned source');
    await writeFile(join(service, '.runtime', 'connection.json'), 'private runtime');
    await writeFile(join(root, 'other', 'source.ts'), 'another robot');
    await symlink(join(root, 'other'), join(root, 'alias'), 'dir');
    const workspace = new RobotWorkspace(root);
    const scoped = await workspace.scoped('./projects/service');
    expect(await scoped.read('source.ts')).toBe('owned source');
    expect(await scoped.list()).toEqual(['source.ts']);
    await expect(scoped.read('../../other/source.ts')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(scoped.list('.runtime')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(workspace.scoped('alias')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Replace a scope ancestor with a link. Its leaf remains a real directory.
    await rename(join(root, 'projects'), join(root, 'saved'));
    await symlink(join(root, 'saved'), join(root, 'projects'), 'dir');
    await expect(scoped.read('source.ts')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(scoped.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

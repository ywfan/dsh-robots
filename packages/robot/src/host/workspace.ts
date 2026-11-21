import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { normalizeWorkspacePath } from '../domain/catalog.js';
import { DomainError } from '../domain/types.js';
const excluded = new Set([
  '.git', '.runtime', '.build', '.compat', '.dsh', '.codex', '.claude', '.agents', '.ssh',
  '.npmrc', '.netrc', '.pypirc', 'node_modules', 'artifacts', 'dist', 'lib', 'coverage',
]);
const excludedName = (name: string): boolean => {
  const value = name.toLowerCase();
  return excluded.has(value) || value.startsWith('.env') || value.startsWith('.dsh-') || /credentials|private[-_]key|id_rsa|id_ed25519|\.(pem|key|p12|pfx)$/.test(value);
};
/** Reads only bounded regular project files. Every path component rejects symlinks. */
export class RobotWorkspace {
  private canonicalRoot?: string;

  constructor(readonly root: string, canonical = false) {
    if (canonical) this.canonicalRoot = root;
  }

  /** Capture a validated directory. All subsequent accesses stay below this directory. */
  async scoped(path?: string): Promise<RobotWorkspace> {
    const directory = await this.resolvePath(normalizeWorkspacePath(path));
    if (!(await lstat(directory)).isDirectory()) throw new DomainError('INVALID', 'Workspace must be a directory');
    return new RobotWorkspace(directory, true);
  }

  async resolvePath(path: string): Promise<string> {
    if (!(await lstat(this.root)).isDirectory()) throw new DomainError('FORBIDDEN', 'Workspace root must be a directory and cannot be a symbolic link');
    const base = await realpath(this.root);
    this.canonicalRoot ??= base;
    if (base !== this.canonicalRoot) throw new DomainError('FORBIDDEN', 'Workspace root changed during validation');
    const requested = resolve(base, path), local = relative(base, requested);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new DomainError('FORBIDDEN', 'Path leaves the configured workspace');
    const parts = local.split(sep).filter(Boolean);
    if (parts.some(excludedName)) throw new DomainError('FORBIDDEN', 'Credential or excluded path');
    let cursor = base;
    for (const part of parts) { cursor = resolve(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw new DomainError('FORBIDDEN', 'Symbolic links are not permitted in robot file reads'); }
    if (await realpath(requested) !== requested) throw new DomainError('FORBIDDEN', 'Workspace path changed during validation');
    return requested;
  }
  async read(path: string): Promise<string> {
    const target = await this.resolvePath(path), file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 256_000) throw new DomainError('INVALID', 'Read requires a regular file up to 256 KB');
      const data = Buffer.alloc(256_001), result = await file.read(data, 0, data.length, 0);
      if (result.bytesRead > 256_000) throw new DomainError('INVALID', 'File grew beyond the read limit');
      if (await realpath(target) !== target) throw new DomainError('FORBIDDEN', 'Workspace path changed during read');
      const bounded = data.subarray(0, result.bytesRead);
      if (bounded.includes(0)) throw new DomainError('INVALID', 'Binary file cannot be read as text');
      return bounded.toString('utf8');
    } finally { await file.close(); }
  }
  async list(path = '.'): Promise<string[]> {
    const directory = await this.resolvePath(path), entries = await readdir(directory, { withFileTypes: true });
    if (await this.resolvePath(path) !== directory) throw new DomainError('FORBIDDEN', 'Workspace path changed during listing');
    return entries.filter(e => !excludedName(e.name) && !e.isSymbolicLink()).map(e => `${e.name}${e.isDirectory() ? '/' : ''}`).sort().slice(0, 500);
  }
}

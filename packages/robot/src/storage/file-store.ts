import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError, type RobotAggregate, type RobotStore, type Run } from '../domain/types.js';

const temporaryRecord = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.json\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/;

/** Single writer per data directory; writes use atomic rename. Never run two stores over one directory. */
export class FileRobotStore implements RobotStore {
    private tail: Promise<unknown> = Promise.resolve();
    private closed = false;
    private constructor(readonly directory: string, private readonly lockPath: string) { }
    static async open(directory: string): Promise<FileRobotStore> {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const lockPath = join(directory, 'writer.lock');
        let handle;
        try {
            handle = await open(lockPath, 'wx', 0o600);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST')
                throw new DomainError('CONFLICT', 'Data directory already has a writer (after a crash, verify the old process is stopped before removing writer.lock)');
            throw error;
        }
        try {
            try {
                await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
                await handle.sync();
            } finally {
                await handle.close();
            }
            // The writer lock makes it safe to remove abandoned temporary records.
            for (const kind of ['robots', 'runs']) {
                const recordDirectory = join(directory, kind);
                await mkdir(recordDirectory, { recursive: true, mode: 0o700 });
                for (const entry of await readdir(recordDirectory, { withFileTypes: true })) {
                    if (entry.isFile() && temporaryRecord.test(entry.name)) {
                        await rm(join(recordDirectory, entry.name), { force: true });
                    }
                }
            }
        }
        catch (error) {
            await rm(lockPath, { force: true });
            throw error;
        }
        return new FileRobotStore(directory, lockPath);
    }
    private file(kind: 'robots' | 'runs', id: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id))
        throw new DomainError('INVALID', 'Invalid record ID'); return join(this.directory, kind, `${id}.json`); }
    private async read<T>(kind: 'robots' | 'runs', id: string): Promise<T | undefined> { if (this.closed)
        throw new DomainError('BAD_STATE', 'Store is closed'); try {
        const result = JSON.parse(await readFile(this.file(kind, id), 'utf8'));
        if (result.schemaVersion !== 1)
            throw new DomainError('INVALID', 'Unsupported storage schema; explicit migration required');
        return (kind === 'runs' ? result.run : result) as T;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
        throw error;
    } }
    readRobot(id: string): Promise<RobotAggregate | undefined> { return this.read('robots', id); }
    readRun(id: string): Promise<Run | undefined> { return this.read('runs', id); }
    private async list<T>(kind: 'robots' | 'runs'): Promise<T[]> { const files = await readdir(join(this.directory, kind)); const values = await Promise.all(files.filter(f => f.endsWith('.json')).sort().map(f => this.read<T>(kind, f.slice(0, -5)))); return values.filter(v => v !== undefined) as T[]; }
    listRobots(): Promise<RobotAggregate[]> { return this.list('robots'); }
    listRuns(): Promise<Run[]> { return this.list('runs'); }
    private save(kind: 'robots' | 'runs', value: RobotAggregate | Run, expectedVersion: number | null): Promise<void> {
        const snapshot = structuredClone(value);
        const work = this.tail.then(async () => {
            if (this.closed)
                throw new DomainError('BAD_STATE', 'Store is closed');
            const id = 'robot' in snapshot ? snapshot.robot.id : snapshot.id;
            const current = await this.read<RobotAggregate | Run>(kind, id);
            const previous = current ? ('robot' in current ? current.robot.version : current.version) : null;
            const next = 'robot' in snapshot ? snapshot.robot.version : snapshot.version;
            if (previous !== expectedVersion || next !== (expectedVersion ?? 0) + 1)
                throw new DomainError('CONFLICT', 'Record changed; reload and retry');
            if (current && 'robot' in current && 'robot' in snapshot) {
                if (snapshot.robot.workspacePath !== current.robot.workspacePath)
                    throw new DomainError('INVALID', 'Robot workspace binding is immutable');
                if (snapshot.robot.ownerId !== current.robot.ownerId || snapshot.revisions.length < current.revisions.length || current.revisions.some((r, i) => JSON.stringify(r) !== JSON.stringify(snapshot.revisions[i])))
                    throw new DomainError('INVALID', 'Published revisions and ownership are immutable');
            }
            if (current && !('robot' in current) && !('robot' in snapshot) && (snapshot.robotId !== current.robotId || snapshot.revisionId !== current.revisionId || snapshot.principalId !== current.principalId || snapshot.invokerId !== current.invokerId))
                throw new DomainError('INVALID', 'Run identity and pinned revision are immutable');
            const path = this.file(kind, id);
            const temp = `${path}.${randomUUID()}.tmp`;
            const file = await open(temp, 'wx', 0o600);
            try {
                try {
                    await file.writeFile(JSON.stringify(kind === 'runs' ? { schemaVersion: 1, run: snapshot } : snapshot));
                    await file.sync();
                } finally {
                    await file.close();
                }
                await rename(temp, path);
            } catch (error) {
                try {
                    await rm(temp, { force: true });
                } catch (cleanupError) {
                    throw new AggregateError([error, cleanupError], 'Record write failed and temporary file cleanup failed');
                }
                throw error;
            }
            try {
                const dir = await open(join(this.directory, kind), 'r');
                try {
                    await dir.sync();
                } finally {
                    await dir.close();
                }
            } catch (error) {
                throw new DomainError('COMMIT_UNCERTAIN', `Record was renamed, then directory finalization failed. Reload ${kind}/${id} and compare its version before retrying. Cause: ${String(error)}`);
            }
        });
        this.tail = work.catch(() => undefined);
        return work;
    }
    saveRobot(value: RobotAggregate, expectedVersion: number | null): Promise<void> { return this.save('robots', value, expectedVersion); }
    saveRun(value: Run, expectedVersion: number | null): Promise<void> { return this.save('runs', value, expectedVersion); }
    async close(): Promise<void> { await this.tail; if (this.closed)
        return; this.closed = true; await rm(this.lockPath, { force: true }); }
}

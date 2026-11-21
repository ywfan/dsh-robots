import { z } from 'zod';
import { DomainError, type Revision, type RobotExport } from './types.js';
import { digest, resourceDigests, robotSpecSchema, validateSpec } from './validation.js';
const runtimeLabel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/);
const sourceRuntimeSchema = z.strictObject({ adapter: runtimeLabel, adapterVersion: runtimeLabel, harnessVersion: runtimeLabel });
const archiveSchema = z.strictObject({ sourceRuntime: sourceRuntimeSchema.optional(), format: z.literal('dsh-robot'), schemaVersion: z.literal(1), spec: robotSpecSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), resourceDigests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) });
/** Only declarative selected resources; no local binding, credentials, conversations or ACLs. */
export function exportRobot(revision: Revision, resourceIds: string[], sourceRuntime?: RobotExport['sourceRuntime']): RobotExport {
    if (new Set(resourceIds).size !== resourceIds.length || resourceIds.some(id => !revision.spec.resources.some(r => r.id === id)))
        throw new DomainError('INVALID', 'Unknown or duplicate export resource');
    const spec = structuredClone(revision.spec);
    spec.resources = spec.resources.filter(r => resourceIds.includes(r.id));
    validateSpec(spec);
    for (const resource of spec.resources) {
        if (!resource.source)
            continue;
        try {
            const url = new URL(resource.source);
            if (url.username || url.password || [...url.searchParams.keys()].some(k => /token|secret|password|key|signature/i.test(k)))
                throw new DomainError('INVALID', 'Remove credentials from resource source before export');
        }
        catch (error) {
            if (error instanceof DomainError)
                throw error;
        }
    }
    return { format: 'dsh-robot', schemaVersion: 1, spec, digest: digest(spec), resourceDigests: resourceDigests(spec.resources), ...(sourceRuntime ? { sourceRuntime: sourceRuntimeSchema.parse(sourceRuntime) } : {}) };
}
export function importRobot(input: unknown): RobotExport {
    if (typeof input === 'string') {
        if (input.length > 8000000)
            throw new DomainError('INVALID', 'Import exceeds size limit');
        try {
            input = JSON.parse(input);
        }
        catch {
            throw new DomainError('INVALID', 'Invalid JSON package');
        }
    }
    const parsed = archiveSchema.safeParse(input);
    if (!parsed.success)
        throw new DomainError('INVALID', parsed.error.message);
    const archive = parsed.data;
    const spec = validateSpec(archive.spec);
    if (digest(spec) !== archive.digest || digest(resourceDigests(spec.resources)) !== digest(archive.resourceDigests))
        throw new DomainError('INVALID', 'Package integrity check failed');
    return { ...archive, spec };
}

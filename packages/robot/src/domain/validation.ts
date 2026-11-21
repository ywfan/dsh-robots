import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError, type RobotSpec, type Resource } from './types.js';
const text = z.string().min(1).max(100000);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).refine(s => !['__proto__', 'constructor', 'prototype'].includes(s));
const action = id;
const resource = z.strictObject({ id, kind: z.enum(['knowledge', 'skill']), path: text, content: z.string().max(2000000), source: z.string().max(4000).optional() });
const check = z.discriminatedUnion('kind', [z.strictObject({ id, kind: z.literal('action-succeeded'), action }), z.strictObject({ id, kind: z.literal('artifact'), key: id }), z.strictObject({ id, kind: z.literal('human-confirmation') })]);
export const robotSpecSchema = z.strictObject({
    name: text, purpose: text, instructions: z.string().max(100000),
    model: z.strictObject({ provider: id, model: text }), resources: z.array(resource).max(200),
    workflow: z.strictObject({ entry: id, steps: z.array(z.strictObject({ id, title: text, instruction: text, skillIds: z.array(id).max(200), allowedActions: z.array(action).max(200), checks: z.array(check).max(200), transitions: z.record(id, id.nullable()).refine(x => Object.keys(x).length > 0), maxVisits: z.number().int().min(1).max(1000) })).min(1).max(200) }),
    requiredCapabilities: z.array(action).max(200), externalActions: z.array(action).max(200),
});
function unique(values: string[], label: string): void { if (new Set(values).size !== values.length)
    throw new DomainError('INVALID', `Duplicate ${label}`); }
export function validateSpec(input: unknown): RobotSpec {
    const parsed = robotSpecSchema.safeParse(input);
    if (!parsed.success)
        throw new DomainError('INVALID', parsed.error.message);
    const spec = parsed.data;
    if (JSON.stringify(spec).length > 8000000)
        throw new DomainError('INVALID', 'Robot exceeds size limit');
    unique(spec.resources.map(r => r.id), 'resource ID');
    unique(spec.resources.map(r => r.path.toLowerCase()), 'resource path');
    unique(spec.workflow.steps.map(s => s.id), 'step ID');
    unique(spec.requiredCapabilities, 'capability');
    unique(spec.externalActions, 'external action');
    for (const r of spec.resources) {
        if (!/^[A-Za-z0-9_./-]+$/.test(r.path) || r.path.startsWith('/') || r.path.split('/').some(p => !p || p === '.' || p === '..'))
            throw new DomainError('INVALID', `Unsafe resource path: ${r.path}`);
    }
    const steps = new Map(spec.workflow.steps.map(s => [s.id, s]));
    if (!steps.has(spec.workflow.entry))
        throw new DomainError('INVALID', 'Unknown workflow entry');
    const skills = new Set(spec.resources.filter(r => r.kind === 'skill').map(r => r.id));
    for (const step of spec.workflow.steps) {
        unique(step.skillIds, 'skill reference');
        unique(step.allowedActions, 'allowed action');
        unique(step.checks.map(c => c.id), 'check ID');
        if (step.skillIds.some(s => !skills.has(s)))
            throw new DomainError('INVALID', `Missing skill in ${step.id}`);
        if (Object.values(step.transitions).some(next => next !== null && !steps.has(next)))
            throw new DomainError('INVALID', `Unknown transition in ${step.id}`);
        if (step.checks.some(c => c.kind === 'action-succeeded' && !step.allowedActions.includes(c.action)))
            throw new DomainError('INVALID', `Unreachable check in ${step.id}`);
    }
    const reached = new Set<string>();
    const queue = [spec.workflow.entry];
    while (queue.length) {
        const current = queue.pop()!;
        if (reached.has(current))
            continue;
        reached.add(current);
        queue.push(...Object.values(steps.get(current)!.transitions).filter((v): v is string => v !== null));
    }
    if (reached.size !== steps.size)
        throw new DomainError('INVALID', 'Workflow contains unreachable steps');
    if (!spec.workflow.steps.some(s => Object.values(s.transitions).includes(null)))
        throw new DomainError('INVALID', 'Workflow has no terminal transition');
    const allActions = new Set(spec.workflow.steps.flatMap(s => s.allowedActions));
    if (spec.externalActions.some(a => !allActions.has(a)))
        throw new DomainError('INVALID', 'External action is not used by workflow');
    return spec;
}
function stable(value: unknown): unknown { if (Array.isArray(value))
    return value.map(stable); if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])); return value; }
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
export function resourceDigests(resources: Resource[]): Record<string, string> { return Object.fromEntries(resources.map(r => [r.id, digest(r)])); }
export function assertHumanOwner(principal: {
    id: string;
    kind: string;
}, ownerId: string): void { if (principal.kind !== 'human' || principal.id !== ownerId)
    throw new DomainError('FORBIDDEN', 'Robot owner confirmation required'); }

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-tools';
import { DshAdapterError, VALIDATED_DSH_BASELINE } from './contracts.ts';

export interface DshCapabilityReport {
  hostVersion: string;
  validatedBaseline: string;
  versionValidated: boolean;
  missing: string[];
  delegationAvailable: boolean;
  compatible: boolean;
}

/** Capability probe, deliberately not an exact-version runtime gate. */
export function probeDsh(ctx: Context, hostVersion: string): DshCapabilityReport {
  const missing: string[] = [];
  const required: Array<[string, unknown, string[]]> = [
    ['agentPresets', ctx.get('agentPresets'), ['register', 'resolve', 'presetForSession']],
    ['agents', ctx.get('agents'), ['get']],
    ['sessionController', ctx.get('sessionController'), ['create']],
    ['tools', ctx.get('tools'), ['guard']],
  ];
  for (const [name, service, methods] of required) {
    if (!service) { missing.push(name); continue; }
    for (const method of methods) {
      if (typeof (service as unknown as Record<string, unknown>)[method] !== 'function') missing.push(`${name}.${method}`);
    }
  }
  return { hostVersion, validatedBaseline: VALIDATED_DSH_BASELINE,
    versionValidated: [VALIDATED_DSH_BASELINE, '0.2.2-rc.2'].includes(hostVersion),
    missing, compatible: missing.length === 0, delegationAvailable: typeof ctx.get('subagents')?.startActivation === 'function' };
}

export function requireDshCapabilities(ctx: Context, version: string): DshCapabilityReport {
  const report = probeDsh(ctx, version);
  if (!report.compatible) throw new DshAdapterError('HOST_CAPABILITY_MISSING', `DSH adapter requires: ${report.missing.join(', ')}`);
  return report;
}

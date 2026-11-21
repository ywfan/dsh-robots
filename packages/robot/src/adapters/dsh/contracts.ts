/** Host-neutral inputs at the DSH boundary. No domain object contains a DSH handle. */
export interface DshRobotBinding {
  readonly robotId: string;
  readonly revisionId: string;
  readonly presetId: string;
  readonly name: string;
  readonly description?: string;
  readonly cwd: string;
  readonly model: {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
  };
}

export interface RobotToolAttempt {
  readonly name: string;
  readonly arguments: unknown;
  readonly callId: string;
  readonly rootCallId: string;
  readonly nested: boolean;
}

/** Decisions must be synchronous and fail closed. Approval is owned by the application. */
export interface RobotRuntimePolicy {
  decideTool(attempt: RobotToolAttempt): string | undefined;
  admitStep(): string | undefined;
  /** Receives diagnostics; it is not an authorization path. */
  onDenied?(reason: string): void;
}

export interface RobotAgentIdentity {
  readonly agentId: string;
  readonly origin: 'session' | 'subagent';
  readonly resumed: boolean;
}

export interface DshAdapterOptions {
  readonly hostVersion: string;
  readonly prepareRun: (
    binding: DshRobotBinding,
    identity: RobotAgentIdentity,
  ) => RobotRuntimePolicy | Promise<RobotRuntimePolicy>;
  readonly spawnProvider?: string;
}

export const ADAPTER_VERSION = '0.1.0';
export const VALIDATED_DSH_BASELINE = '0.2.2-rc.3';

export class DshAdapterError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DshAdapterError';
  }
}

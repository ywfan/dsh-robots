import { Context, Service } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { DomainError } from '../domain/types.js';
import { RobotSharingServer } from './sharing.js';
import type {} from './management.js';
declare module '@deepseek-ai/cordis' { interface Context { robotSharing: RobotSharingService } }
/** Management of loopback invitations; actual shared requests use their own authenticated transport. */
export class RobotSharingService extends TypertRemoteService {
  static inject = ['robotManagement'];
  private server!: RobotSharingServer;
  private endpoint = '';
  constructor(ctx: Context) { super(ctx, 'robotSharing', { namespace: 'robotSharing' }); }
  protected async [Service.init](): Promise<void> {
    const management = this.ctx.robotManagement;
    this.server = new RobotSharingServer(management, join(management.config.dataDir, 'shares.json'));
    this.endpoint = await this.server.open();
    this.ctx.effect(() => () => this.server.close());
  }
  private owner(): void { if (this.ctx.invocation && this.ctx.invocation.peer.principal.kind !== 'owner') throw new DomainError('FORBIDDEN', 'Owner only'); }
  @Remote list(): { endpoint: string; invitations: { id: string; label: string; robotIds: string[]; revoked: boolean; expiresAt: string }[] } { this.owner(); return { endpoint: this.endpoint, invitations: this.server.list() }; }
  @Remote async invite(request: { label: string; robotIds: string[]; expiresAt: string }): Promise<{ invitationId: string; endpoint: string; token: string }> { this.owner(); return this.server.invite(request.label, request.robotIds, request.expiresAt); }
  @Remote async revoke(request: { invitationId: string }): Promise<void> { this.owner(); await this.server.revoke(request.invitationId); }
}

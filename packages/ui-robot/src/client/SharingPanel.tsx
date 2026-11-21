/** Owner-managed invitations; one-time secrets remain in local component memory only. */
import { useEffect, useId, useState } from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import type { RobotSharingApi } from './api.ts';
import type { RobotTranslate } from './locales.ts';
import css from './RobotPage.module.css';

export type SharingFace = { listShares: RobotSharingApi['list']; invite: RobotSharingApi['invite']; revoke: RobotSharingApi['revoke'] };
type ShareList = Awaited<ReturnType<RobotSharingApi['list']>>;

export function SharingPanel({ robotId, t, listShares, invite, revoke }: SharingFace & { robotId: string; t: RobotTranslate }) {
  const id = useId();
  const [data, setData] = useState<ShareList>();
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('');
  const [connection, setConnection] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void listShares().then(value => { if (active) setData(value); }, failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [listShares]);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); setData(await listShares()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }

  const invitations = data?.invitations.filter(item => item.robotIds.includes(robotId)) ?? [];
  return <section className={css.card}>
    <h2 className={css.cardTitle}>{t('hosted')}</h2><p className={css.muted}>{t('sharingHint')}</p>
    {data && <p className={css.body}>{t('endpoint')}: {data.endpoint}</p>}
    {error && <p role="alert" className={css.notice}>{error}</p>}
    <div className={css.fields}>
      <div className={css.field}><label htmlFor={`${id}-label`}>{t('inviteLabel')}</label><Input id={`${id}-label`} value={label} onChange={event => setLabel(event.target.value)} /></div>
      <div className={css.field}><label htmlFor={`${id}-expiry`}>{t('expiresAt')}</label><Input id={`${id}-expiry`} type="datetime-local" value={expiry} onChange={event => setExpiry(event.target.value)} /></div>
    </div>
    <Button disabled={busy || !label.trim() || !expiry} onClick={() => void perform(async () => {
      const result = await invite({ label, robotIds: [robotId], expiresAt: new Date(expiry).toISOString() });
      setConnection(JSON.stringify({ endpoint: result.endpoint, token: result.token, robotId }, null, 2)); setCopied(false);
    })}>{t('createInvite')}</Button>
    {connection && <div className={css.field}><p>{t('tokenOnce')}</p><textarea className={css.textarea} readOnly value={connection} aria-label={t('copyConnection')} />
      <div className={css.toolbar}><Button onClick={() => {
        void navigator.clipboard.writeText(connection).then(() => setCopied(true), failure => setError(String(failure)));
      }}>{copied ? t('copied') : t('copyConnection')}</Button><Button onClick={() => setConnection('')}>{t('close')}</Button></div>
    </div>}
    {!invitations.length && <p className={css.muted}>{t('noInvitations')}</p>}
    {invitations.map(item => <div className={css.row} key={item.id}><p>{item.label} · {item.expiresAt}</p><Button disabled={busy || item.revoked} onClick={() => void perform(() => revoke({ invitationId: item.id }))}>{item.revoked ? t('revoked') : t('revoke')}</Button></div>)}
  </section>;
}

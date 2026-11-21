/** Robot management, authoring and reviewed learning in one independent panel. */
import { useEffect, useId, useState } from 'react';
import { Button, Input, Tag, IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { RobotAggregate, RobotSpec, RobotExport, Run } from '../../../robot/src/domain/types.ts';
import type { RobotPanelController, RobotPanelState } from './controller.ts';
import type { RobotTranslate, RobotUiKey } from './locales.ts';
import css from './RobotPage.module.css';
import { SharingPanel, type SharingFace } from './SharingPanel.tsx';
import type { RobotApi, RobotFeedbackCategory } from './api.ts';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { robots: RobotUiKey }
}

export interface RobotPageInjected extends SharingFace {
  hooks: { robotPanel: ObservableSnapshot<RobotPanelState> };
  load: RobotPanelController['load'];
  select: RobotPanelController['select'];
  save: RobotPanelController['save'];
  publish: RobotPanelController['publish'];
  start: RobotPanelController['start'];
  assist: RobotPanelController['assist'];
  review: RobotPanelController['review'];
  archive: RobotPanelController['archive'];
  importRobot: RobotPanelController['import'];
  exportRobot: RobotPanelController['export'];
  answer: RobotPanelController['answer'];
  approveAction: RobotPanelController['approveAction'];
  cancelRun: RobotPanelController['cancel'];
  openRun: RobotPanelController['openRun'];
  runResult: RobotApi['runResult'];
  submitFeedback: RobotPanelController['submitFeedback'];
  actionDetail: RobotApi['actionDetail'];
  rejectAction: RobotPanelController['rejectAction'];
  reconcileAction: RobotPanelController['reconcileAction'];
  resumeApprovedAction: RobotPanelController['resumeApprovedAction'];
  confirmCheck: RobotPanelController['confirmCheck'];
}
export type RobotPageProps = PropsRuntime<'main'> & PropsLocale<'robots'> & InjectFace<RobotPageInjected>;

/** The sidebar owns the button, name and selected state. */
export function RobotPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconAgentPresetOutlineRegular size={size} />;
}

/** Initial authoring structure; publishing still requires Host readiness checks. */
function initialSpec(): RobotSpec {
  return {
    name: '', purpose: '', instructions: '', model: { provider: '', model: '' }, resources: [],
    workflow: { entry: 'work', steps: [{ id: 'work', title: '', instruction: '', skillIds: [], allowedActions: [], checks: [{ id: 'review', kind: 'human-confirmation' }], transitions: { complete: null }, maxVisits: 1 }] },
    requiredCapabilities: [], externalActions: [],
  };
}

/** Main page receives state and narrow callbacks from its Slot registration. */
export function RobotPage(props: RobotPageProps) {
  const { t } = props;
  const state = props.useRobotPanel(value => value);
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [shared, setShared] = useState('');
  const [importWorkspace, setImportWorkspace] = useState('');
  const [exported, setExported] = useState('');
  const [localError, setLocalError] = useState('');
  const [archiveConfirmation, setArchiveConfirmation] = useState(false);
  const [choosingExport, setChoosingExport] = useState(false);
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  useEffect(() => { void props.load(); }, [props.load]);
  const selected = state.selected;
  const published = selected?.revisions.find(revision => revision.id === selected.robot.currentRevisionId);

  async function importBundle() {
    try {
      const bundle: RobotExport = JSON.parse(shared);
      if (await props.importRobot(bundle, importWorkspace || undefined)) { setImporting(false); setShared(''); setLocalError(''); }
    } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); }
  }

  return <div className={css.page}><div className={css.content}>
    <header className={css.header}>
      <div><h1 className={css.title}>{t('title')}</h1><p className={css.subtitle}>{t('description')}</p></div>
      <div className={css.toolbar}>
        <Button disabled={state.busy} onClick={() => void props.load()}>{t('refresh')}</Button>
        <Button disabled={state.busy} onClick={() => { setImporting(true); setShared(''); setImportWorkspace(''); }}>{t('import')}</Button>
        <Button variant="primary" disabled={state.busy} onClick={() => { props.select(undefined); setEditing(true); }}>{t('create')}</Button>
      </div>
    </header>
    {(state.error || localError) && <div className={css.notice} role="alert"><p>{t('operationFailed')}</p><p className={css.body}>{state.error || localError}</p><Button disabled={state.busy} onClick={() => { setLocalError(''); void props.load(); }}>{t('retry')}</Button></div>}
    {state.busy && <p role="status" aria-live="polite" className={css.muted}>{t('loading')}</p>}
    {importing && <section className={css.card}>
      <label>{t('importHint')}<textarea className={css.textarea} value={shared} onChange={event => setShared(event.target.value)} /></label>
      <label className={css.field}>{t('workspace')}<Input value={importWorkspace} maxLength={1024} placeholder="." onChange={event => setImportWorkspace(event.target.value)} /><span className={css.muted}>{t('workspaceHint')}</span></label>
      <div className={css.toolbar}><Button variant="primary" disabled={state.busy || !shared.trim()} onClick={() => void importBundle()}>{t('import')}</Button><Button onClick={() => setImporting(false)}>{t('cancel')}</Button></div>
    </section>}
    {exported && <section className={css.card}>
      <label>{t('exportCopy')}<textarea className={css.textarea} readOnly value={exported} /></label>
      <div className={css.toolbar}><Button onClick={() => {
        const url = URL.createObjectURL(new Blob([exported], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'robot.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>{t('download')}</Button><Button onClick={() => setExported('')}>{t('close')}</Button></div>
    </section>}
    {editing ? <RobotEditor key={selected?.robot.id ?? 'new'} t={t} initial={selected?.draft.spec ?? initialSpec()} existing={selected} busy={state.busy}
      save={async (spec, workspacePath) => { if (await props.save(spec, selected, workspacePath)) setEditing(false); }}
      assist={props.assist} cancel={() => setEditing(false)} />
      : selected ? <>
        <div className={css.toolbar}><Button onClick={() => { props.select(undefined); setArchiveConfirmation(false); }}>{t('back')}</Button></div>
        <section className={css.card}>
          <div className={css.header}><h2 className={css.cardTitle}>{selected.draft.spec.name}</h2><RobotStatus robot={selected} t={t} /></div>
          <p className={css.body}>{selected.draft.spec.purpose}</p>
          <p className={css.muted}>{selected.draft.spec.model.provider} · {selected.draft.spec.model.model}</p>
          <p className={css.body}>{t('workspace')} · <code>{selected.robot.workspacePath ?? '.'}</code></p>
          <div className={css.toolbar}>
            <Button variant="primary" disabled={state.busy || !selected.robot.currentRevisionId || selected.robot.disabled} onClick={() => void props.start(selected)}>{t('start')}</Button>
            <Button disabled={state.busy || selected.robot.disabled} onClick={() => setEditing(true)}>{t('edit')}</Button>
            <Button disabled={state.busy || selected.robot.disabled || Boolean(published && JSON.stringify(published.spec) === JSON.stringify(selected.draft.spec))} onClick={() => void props.publish(selected)}>{t('publish')}</Button>
            <Button disabled={state.busy} onClick={() => { setResourceIds([]); setChoosingExport(true); }}>{t('exportCopy')}</Button>
            <Button disabled={state.busy || selected.robot.disabled} onClick={() => setArchiveConfirmation(true)}>{t('archive')}</Button>
          </div>
          {archiveConfirmation && <div className={css.toolbar}><Button disabled={state.busy} onClick={async () => { await props.archive(selected); setArchiveConfirmation(false); }}>{t('confirmArchive')}</Button><Button onClick={() => setArchiveConfirmation(false)}>{t('cancel')}</Button></div>}
          <p className={css.muted}>{t('permissionHint')}</p><p className={css.muted}>{t('strictHint')}</p>
          {published && <details><summary>{t('publishedConfiguration')}</summary><pre className={css.body}>{JSON.stringify(published.spec, null, 2)}</pre></details>}
          <details><summary>{t('draftConfiguration')}</summary><pre className={css.body}>{JSON.stringify(selected.draft.spec, null, 2)}</pre></details>
        </section>
        {choosingExport && <section className={css.card}><h2 className={css.cardTitle}>{t('exportResources')}</h2>
          {!published?.spec.resources.length && <p className={css.muted}>{t('noResources')}</p>}
          {published?.spec.resources.map(resource => <label className={css.row} key={resource.id}><input type="checkbox" checked={resourceIds.includes(resource.id)} onChange={event => setResourceIds(ids => event.target.checked ? [...ids, resource.id] : ids.filter(id => id !== resource.id))} />{resource.path}</label>)}
          <div className={css.toolbar}><Button disabled={state.busy} onClick={async () => { const bundle = await props.exportRobot(selected, resourceIds); if (bundle) { setExported(JSON.stringify(bundle, null, 2)); setChoosingExport(false); } }}>{t('generateExport')}</Button><Button onClick={() => setChoosingExport(false)}>{t('cancel')}</Button></div>
        </section>}
        <section><h2 className={css.sectionTitle}>{t('candidates')}</h2><div className={css.list}>
          <div className={css.toolbar}><Button disabled={state.busy || !candidateIds.some(id => selected.proposals.some(item => item.id === id && item.status === 'pending'))} onClick={() => void props.review(selected, candidateIds.filter(id => selected.proposals.some(item => item.id === id && item.status === 'pending')), 'approve')}>{t('approveAll')}</Button><Button disabled={state.busy || !candidateIds.some(id => selected.proposals.some(item => item.id === id && ['pending', 'needs-evidence'].includes(item.status)))} onClick={() => void props.review(selected, candidateIds.filter(id => selected.proposals.some(item => item.id === id && ['pending', 'needs-evidence'].includes(item.status))), 'reject')}>{t('reject')}</Button></div>
          {!selected.proposals.some(item => item.status === 'pending' || item.status === 'needs-evidence') && <p className={css.muted}>{t('noCandidates')}</p>}
          {selected.proposals.filter(item => item.status === 'pending' || item.status === 'needs-evidence').map(item => <article key={item.id} className={css.card}>
            <label className={css.row}><input type="checkbox" checked={candidateIds.includes(item.id)} onChange={event => setCandidateIds(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} /><span className={css.cardTitle}>{item.summary}</span></label><p className={css.body}>{item.rationale}</p>
            <p className={css.muted}>{t('evidence')}: {item.sourceRunIds.join(', ')} · {item.sourceEvidenceIds.join(', ')}</p>
            <details><summary>{t('improvement')}</summary><h4>{t('before')}</h4><pre className={css.body}>{JSON.stringify(selected.revisions.find(revision => revision.id === item.baseRevisionId)?.spec ?? null, null, 2)}</pre><h4>{t('after')}</h4><pre className={css.body}>{JSON.stringify(item.proposedSpec, null, 2)}</pre></details>
            <div className={css.toolbar}><Button disabled={state.busy || item.status !== 'pending'} onClick={() => void props.review(selected, [item.id], 'approve')}>{t('approve')}</Button><Button disabled={state.busy} onClick={() => void props.review(selected, [item.id], 'reject')}>{t('reject')}</Button></div>
          </article>)}
        </div></section>
        <section><h2 className={css.sectionTitle}>{t('history')}</h2><div className={css.list}>{state.runs.filter(run => run.robotId === selected.robot.id).map(run => <RunCard key={run.id} run={run} t={t} busy={state.busy} answer={props.answer} approveAction={props.approveAction} cancelRun={props.cancelRun} openRun={props.openRun}
          runResult={props.runResult} submitFeedback={props.submitFeedback}
          actionDetail={props.actionDetail} rejectAction={props.rejectAction} reconcileAction={props.reconcileAction} resumeApprovedAction={props.resumeApprovedAction} confirmCheck={props.confirmCheck}
          checks={selected.revisions.find(revision => revision.id === run.revisionId)?.spec.workflow.steps.find(step => step.id === run.stepId)?.checks.filter(check => check.kind === 'human-confirmation').map(check => check.id) ?? []} />)}</div></section>
        {selected.robot.currentRevisionId && !selected.robot.disabled && <SharingPanel key={selected.robot.id} robotId={selected.robot.id} t={t} listShares={props.listShares} invite={props.invite} revoke={props.revoke} />}
      </> : <div className={css.list}>
        {state.loaded && !state.robots.length && <div className={css.empty}><h2 className={css.cardTitle}>{t('empty')}</h2><p className={css.muted}>{t('emptyHint')}</p></div>}
        {state.robots.map(robot => <article className={css.card} key={robot.robot.id}>
          <div className={css.header}><h2 className={css.cardTitle}>{robot.draft.spec.name}</h2><RobotStatus robot={robot} t={t} /></div>
          <p className={css.body}>{robot.draft.spec.purpose}</p>
          <div className={css.toolbar}><Button onClick={() => props.select(robot)}>{t('detail')}</Button><Button variant="primary" disabled={state.busy || !robot.robot.currentRevisionId || robot.robot.disabled} onClick={() => void props.start(robot)}>{t('start')}</Button></div>
        </article>)}
      </div>}
  </div></div>;
}

function RobotStatus({ robot, t }: { robot: RobotAggregate; t: RobotTranslate }) {
  const published = robot.revisions.find(item => item.id === robot.robot.currentRevisionId);
  const changed = published && JSON.stringify(published.spec) !== JSON.stringify(robot.draft.spec);
  return <div className={css.metadata}><Tag>{robot.robot.disabled ? t('archived') : published ? `${t('ready')} · ${t('revision')} ${published.number}` : t('draft')}</Tag>{changed && <span>{t('unpublishedChanges')}</span>}</div>;
}

interface EditorProps {
  initial: RobotSpec; existing?: RobotAggregate; busy: boolean; t: RobotTranslate;
  save: (spec: RobotSpec, workspacePath?: string) => Promise<void>; assist: RobotPanelController['assist']; cancel: () => void;
}

function RobotEditor({ initial, existing, busy, t, save, assist, cancel }: EditorProps) {
  const id = useId();
  const [spec, setSpec] = useState(initial);
  const [resources, setResources] = useState(JSON.stringify(initial.resources, null, 2));
  const [workflow, setWorkflow] = useState(JSON.stringify(initial.workflow, null, 2));
  const [sources, setSources] = useState('');
  const [workspacePath, setWorkspacePath] = useState(existing ? existing.robot.workspacePath ?? '.' : '');
  const [error, setError] = useState('');
  async function saveEditor() {
    try {
      await save({ ...spec, resources: JSON.parse(resources), workflow: JSON.parse(workflow) }, workspacePath || undefined);
      setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  return <section className={css.card}><form className={css.form} onSubmit={event => { event.preventDefault(); void saveEditor(); }}>
    <div className={css.fields}>
      <div className={css.field}><label htmlFor={`${id}-name`}>{t('name')}</label><Input id={`${id}-name`} required value={spec.name} onChange={event => setSpec({ ...spec, name: event.target.value })} /></div>
      <div className={css.field}><label htmlFor={`${id}-purpose`}>{t('responsibility')}</label><Input id={`${id}-purpose`} required value={spec.purpose} onChange={event => setSpec({ ...spec, purpose: event.target.value })} /></div>
      <div className={css.field}><label htmlFor={`${id}-provider`}>{t('provider')}</label><Input id={`${id}-provider`} required value={spec.model.provider} onChange={event => setSpec({ ...spec, model: { ...spec.model, provider: event.target.value } })} /></div>
      <div className={css.field}><label htmlFor={`${id}-model`}>{t('model')}</label><Input id={`${id}-model`} required value={spec.model.model} onChange={event => setSpec({ ...spec, model: { ...spec.model, model: event.target.value } })} /></div>
    </div>
    <div className={css.field}><label htmlFor={`${id}-workspace`}>{t('workspace')}</label><Input id={`${id}-workspace`} value={workspacePath} maxLength={1024} placeholder="." readOnly={Boolean(existing)} onChange={event => setWorkspacePath(event.target.value)} />{!existing && <p className={css.muted}>{t('workspaceHint')}</p>}</div>
    <div className={css.field}><label htmlFor={`${id}-instructions`}>{t('skills')}</label><textarea id={`${id}-instructions`} className={css.textarea} value={spec.instructions} onChange={event => setSpec({ ...spec, instructions: event.target.value })} /></div>
    <div className={css.field}><label htmlFor={`${id}-sources`}>{t('sourceHint')}</label><textarea id={`${id}-sources`} className={css.textarea} value={sources} onChange={event => setSources(event.target.value)} /><p className={css.muted}>{t('assistantHint')}</p><Button disabled={busy || !spec.purpose || !spec.model.provider || !spec.model.model} onClick={() => void assist(spec.purpose, sources.split('\n').map(value => value.trim()).filter(Boolean), spec.model, workspacePath || undefined)}>{t('assistant')}</Button></div>
    <details><summary>{t('knowledge')}</summary><label className={css.field}>{t('resourcesEditor')}<textarea className={css.textarea} value={resources} onChange={event => setResources(event.target.value)} /></label></details>
    <details><summary>{t('workflow')}</summary><label className={css.field}>{t('workflowEditor')}<textarea className={css.textarea} value={workflow} onChange={event => setWorkflow(event.target.value)} /></label></details>
    {error && <p role="alert" className={css.notice}>{error}</p>}
    <div className={css.toolbar}><Button type="submit" variant="primary" disabled={busy}>{t('save')}</Button><Button disabled={busy} onClick={cancel}>{t('cancel')}</Button></div>
  </form></section>;
}

type RunCardProps = { run: Run; t: RobotTranslate; busy: boolean; checks: string[] } & Pick<RobotPageInjected, 'answer' | 'approveAction' | 'cancelRun' | 'openRun' | 'actionDetail' | 'rejectAction' | 'reconcileAction' | 'resumeApprovedAction' | 'confirmCheck' | 'runResult' | 'submitFeedback'>;

function RunCard({ run, t, busy, answer, approveAction, cancelRun, openRun, actionDetail, rejectAction, reconcileAction, resumeApprovedAction, confirmCheck, runResult, submitFeedback, checks }: RunCardProps) {
  const [response, setResponse] = useState('');
  const [detail, setDetail] = useState<Awaited<ReturnType<RobotApi['actionDetail']>>>();
  const [detailError, setDetailError] = useState('');
  const [loadingDetail, setLoadingDetail] = useState(false);
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(run.status);
  useEffect(() => { setDetail(undefined); setDetailError(''); }, [run.pendingAction?.id, run.pendingAction?.inputDigest]);
  const inspected = Boolean(detail && detail.attempt.id === run.pendingAction?.id && detail.attempt.inputDigest === run.pendingAction?.inputDigest);
  const status = { preparing: 'preparing', running: 'running', 'waiting-user': 'waitingUser', 'awaiting-approval': 'awaitingApproval', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', uncertain: 'uncertain' } as const;
  return <article className={css.card}><p className={css.body}>{run.id} · {t(status[run.status])}</p><p className={css.muted}>{t('revision')}: {run.revisionId}</p>
    {run.failureReason && <p role="alert" className={css.body}>{run.failureReason}</p>}
    {run.binding && <Button onClick={() => openRun(run)}>{t('openConversation')}</Button>}
    <RunOutput run={run} t={t} runResult={runResult} />
    {run.pendingQuestion && <><p className={css.body}>{run.pendingQuestion.text}</p><label>{t('result')}<textarea className={css.textarea} value={response} onChange={event => setResponse(event.target.value)} /></label><Button disabled={busy || !response.trim()} onClick={() => void answer(run, response)}>{t('reply')}</Button></>}
    {run.pendingAction && <>
      <p className={css.body}>{run.pendingAction.action} · {run.pendingAction.summary}</p>
      <Button disabled={busy || loadingDetail} onClick={async () => {
        setLoadingDetail(true); setDetailError('');
        try { setDetail(await actionDetail({ runId: run.id })); }
        catch (error) { setDetailError(error instanceof Error ? error.message : String(error)); }
        finally { setLoadingDetail(false); }
      }}>{t('actionDetail')}</Button>
      {detailError && <p className={css.notice} role="alert">{detailError}</p>}
      {inspected && <div><p>{t('actionInput')}</p><pre className={css.body}>{detail!.inputJson}</pre></div>}
      <div className={css.toolbar}>
        {run.pendingAction.status === 'awaiting-approval' && <><Button disabled={busy || !inspected} onClick={() => void approveAction(run)}>{t('approve')}</Button><Button disabled={busy} onClick={() => void rejectAction(run)}>{t('rejectAction')}</Button></>}
        {run.pendingAction.status === 'uncertain' && <Button disabled={busy} onClick={() => void reconcileAction(run)}>{t('reconcile')}</Button>}
        {run.pendingAction.status === 'approved' && run.status === 'running' && <Button disabled={busy || !inspected} onClick={() => void resumeApprovedAction(run)}>{t('resume')}</Button>}
      </div>
    </>}
    {run.status === 'running' && checks.filter(checkId => !run.evidence.some(item => item.stepId === run.stepId && item.visit === run.visits[run.stepId] && item.kind === 'human-confirmation' && item.key === checkId && item.outcome === 'success')).map(checkId => <Button disabled={busy} key={checkId} onClick={() => void confirmCheck(run, checkId)}>{t('confirmCheck')}: {checkId}</Button>)}
    {terminal ? <RunFeedback run={run} t={t} busy={busy} submitFeedback={submitFeedback} /> : <Button disabled={busy} onClick={() => void cancelRun(run)}>{t('cancelRun')}</Button>}
  </article>;
}

function RunOutput({ run, t, runResult }: Pick<RunCardProps, 'run' | 't' | 'runResult'>) {
  const [result, setResult] = useState<Awaited<ReturnType<RobotApi['runResult']>>>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function loadResult() {
    setLoading(true);
    setError('');
    try { setResult(await runResult({ runId: run.id })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setLoading(false); }
  }
  return <div className={css.field}>
    <div><Button disabled={loading} onClick={() => void loadResult()}>{t(result ? 'refreshResult' : 'viewResult')}</Button></div>
    {error && <p className={css.notice} role="alert">{error}</p>}
    {result && (result.artifacts.length ? <>
      <p className={css.muted}>{t('unconfirmedFindings')}</p>
      {result.artifacts.map(artifact => <details key={artifact.id}>
        <summary>{artifact.key}</summary><pre className={css.body}>{artifact.content}</pre>
      </details>)}
    </> : <p role="status">{t('noArtifacts')}</p>)}
  </div>;
}

const feedbackLabels = { success: 'feedbackSuccess', failure: 'feedbackFailure', 'false-positive': 'feedbackFalsePositive', 'missed-finding': 'feedbackMissed', correction: 'feedbackCorrection' } as const;

function RunFeedback({ run, t, busy, submitFeedback }: Pick<RunCardProps, 'run' | 't' | 'busy' | 'submitFeedback'>) {
  const [category, setCategory] = useState<RobotFeedbackCategory>(run.status === 'succeeded' ? 'success' : 'failure');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  async function sendFeedback() {
    setSubmitted(false);
    if (await submitFeedback(run, category, note.trim())) { setNote(''); setSubmitted(true); }
  }
  return <details>
    <summary>{t('addFeedback')}</summary>
    <form className={css.field} onSubmit={event => { event.preventDefault(); void sendFeedback(); }}>
      <label className={css.field}>{t('feedbackCategory')}<select className={css.select} value={category} onChange={event => setCategory(event.target.value as RobotFeedbackCategory)}>
        {(Object.keys(feedbackLabels) as RobotFeedbackCategory[]).map(value => <option key={value} value={value}>{t(feedbackLabels[value])}</option>)}
      </select></label>
      <label className={css.field}>{t('feedbackNote')}<textarea className={css.textarea} value={note} maxLength={4000} required onChange={event => { setNote(event.target.value); setSubmitted(false); }} /></label>
      <div><Button type="submit" disabled={busy || !note.trim()}>{t('submitFeedback')}</Button></div>
      {submitted && <p className={css.muted} role="status">{t('feedbackSaved')}</p>}
    </form>
  </details>;
}

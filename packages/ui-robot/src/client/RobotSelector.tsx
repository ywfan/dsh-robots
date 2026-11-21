/** New-session robot choice coexists with the built-in Agent Preset control. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { RobotPageInjected } from './RobotPage.tsx';
import css from './RobotPage.module.css';

export type RobotSelectorInjected = Pick<RobotPageInjected, 'hooks' | 'start'>;
export type RobotSelectorProps = PropsRuntime<'conversation.hero.options'> & PropsLocale<'robots'> & InjectFace<RobotSelectorInjected>;

/** Choosing a robot creates a fresh bound Session before navigation. */
export function RobotSelector({ t, useRobotPanel, start }: RobotSelectorProps) {
  const robots = useRobotPanel(state => state.robots);
  const busy = useRobotPanel(state => state.busy);
  const ready = robots.filter(robot => robot.robot.currentRevisionId && !robot.robot.disabled);
  return <label className={css.selector}>
    <span>{t('choose')}</span>
    <select className={css.select} aria-label={t('choose')} value="" disabled={busy || !ready.length} onChange={event => {
      const robot = ready.find(item => item.robot.id === event.target.value);
      if (robot) void start(robot);
    }}>
      <option value="">{t('choose')}</option>
      {ready.map(robot => <option value={robot.robot.id} key={robot.robot.id}>{robot.draft.spec.name}</option>)}
    </select>
  </label>;
}

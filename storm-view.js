import { icon } from './icons.js';

// Presentation only: thresholds and completion come from GameState.
const goals = {
  food: { title: '储备生鱼片', icon: 'food', unit: '份' },
  command: { title: '升级指挥中心', icon: 'command', unit: '级' },
  water: { title: '储备淡水', icon: 'water', unit: '份' },
};
const integer = value => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export function renderStormObjectives(storm, { compact = false } = {}) {
  return `<div class="storm-objectives${compact ? ' compact' : ''}" aria-label="风暴准备目标">${storm.objectives.filter(goal => goals[goal.id]).map(goal => {
    const view = goals[goal.id], target = Math.max(1, integer(goal.target));
    const current = integer(goal.current), progress = Math.min(current, target);
    return `<div class="storm-objective${goal.complete ? ' complete' : ''}" data-storm-goal="${goal.id}"><span class="storm-goal-icon" aria-hidden="true">${icon(view.icon)}</span><div class="storm-goal-copy"><div class="storm-goal-label"><strong>${view.title}</strong><span>${current}/${target} ${view.unit}${goal.complete ? storm.status === 'passed' ? ' · 已完成' : ' · 已备妥' : ''}</span></div><div class="storm-goal-track" role="progressbar" aria-label="${view.title}" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${progress}"><i style="width:${progress / target * 100}%"></i></div></div><button class="secondary-button storm-goal-go" data-action="storm-goal" data-goal="${goal.id}" aria-label="${view.title}，前往${goal.id === 'food' ? '切鱼厂' : goal.id === 'command' ? '指挥中心' : '净水器'}">前往 ${icon('arrow')}</button></div>`;
  }).join('')}</div>`;
}

export function renderStormTask(storm, { complete = false, chapter = null } = {}) {
  // Chapter counters are numeric task-list values, never save-provided HTML.
  const ordinal = chapter ? ` · ${integer(chapter.current)}/${integer(chapter.total)}` : '';
  return `<div class="storm-task-heading"><div><div class="eyebrow">第一章 · 海上家园${ordinal}</div><h2>风暴准备</h2></div><button class="gold-button${complete ? ' green' : ''}" data-action="${complete ? 'claim' : 'go-quest'}" data-id="command" data-category="tutorial">${complete ? '领取' : '查看'} ${icon(complete ? 'check' : 'arrow')}</button></div>${renderStormObjectives(storm, { compact: true })}<p class="storm-task-note">${complete ? '已平安度过风暴，任务奖励待领取' : '补给按当前库存计算，备妥后前往避难所'}</p>`;
}

export function stormButtonState(storm) {
  const passed = storm.status === 'passed';
  return {
    disabled: passed || storm.status !== 'approaching' || !storm.ready,
    label: passed ? '已经平安度过' : storm.status === 'dormant' ? '等待风暴靠近' : storm.status === 'recovering' ? '设施恢复中' : storm.ready ? '迎接风暴' : '请先备齐各项目标',
  };
}

import { ScavengingView } from './scavenging-view.js';
import { icon } from './icons.js';

const kinds = ['wood', 'plastic', 'cloth'];
const names = { wood: '木材', plastic: '塑料', cloth: '碎布' };
const total = cargo => kinds.reduce((sum, key) => sum + (cargo?.[key] || 0), 0);
const format = n => Math.floor(n || 0).toLocaleString('zh-CN');
const cargoHTML = cargo => kinds.map(key => `<span class="sc-cargo-item">${icon(key)}<strong>${format(cargo?.[key])}</strong><small>${names[key]}</small></span>`).join('');

/** Touch controls and presentation. All motion, collision and settlement belong to GameState. */
export class ScavengingUI {
  constructor(container, { game, notify = () => {}, onToggle = () => {} }) {
    this.el = container; this.game = game; this.notify = notify; this.onToggle = onToggle;
    this.visible = false; this.input = { x: 0, z: 0 }; this.keys = new Set();
    this.el.addEventListener('click', event => this.handle(event));
    this.keyDown = event => {
      if (!this.visible) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (this.dialog === 'pause' || this.dialog === 'upgrade') this.resume(); else if (!this.dialog) this.pause();
      }
      const key = event.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(key) && !this.dialog) {
        event.preventDefault(); event.stopImmediatePropagation(); this.keys.add(key);
      }
    };
    this.keyUp = event => this.keys.delete(event.key.toLowerCase());
    document.addEventListener('keydown', this.keyDown, true);
    document.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', () => { if (this.visible && !this.dialog) this.pause(); });
    this.frame = this.frame.bind(this);
  }
  open() {
    if (this.visible) return true;
    const result = this.game.startScavenging();
    if (!result.ok) { this.notify(result.message); return false; }
    this.visible = true; this.dialog = null; this.lastFocus = document.activeElement;
    this.el.hidden = false; document.body.classList.add('scavenging-view'); this.onToggle(true);
    this.el.innerHTML = `<section class="sc-shell" aria-label="手动拾荒海域"><div class="sc-scene" id="scavenging-scene"></div><header class="sc-hud"><strong>拾荒收获</strong><div class="sc-total" role="progressbar" aria-label="拾荒载荷" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i style="transform:scaleX(0)"></i><b id="sc-total">0</b></div><div class="sc-cargo" id="sc-cargo"></div></header><button class="sc-pause" data-sc-action="pause" aria-label="暂停拾荒"><span>Ⅱ</span></button><div class="sc-warning" id="sc-warning"><span>${icon('shark')}</span><strong id="sc-shark-label">小心鲨鱼</strong><small id="sc-hit-count">撞击 0 / 3</small><b id="sc-fish-warning" hidden>鱼群靠近，护住货物</b></div><div class="sc-notice" id="sc-notice" role="status" aria-live="polite"></div><div class="sc-steering" id="sc-steering" aria-label="拖动摇杆移动，也可使用方向键"><div class="sc-stick" id="sc-stick"><span></span><i id="sc-stick-knob"></i></div><p id="sc-control-hint">拖动摇杆移动，靠近物资自动拾取</p></div><button class="sc-full-return" id="sc-full-return" data-sc-action="return" hidden><strong>返航</strong><small>已满载</small></button><footer class="sc-footer"><button class="sc-return" data-sc-action="return">${icon('arrow')}<strong>返航</strong></button><div class="sc-tools"><button class="sc-hold sc-upgrade-entry" data-sc-action="upgrade-open">${icon('hammer')}<strong>升级</strong><small>提升拾荒技能</small></button><button class="sc-hold" data-sc-action="leave">${icon('anchor')}<strong>暂离海域</strong><small>保留本次货物</small></button></div></footer><div class="sc-modal" id="sc-modal" hidden></div></section>`;
    this.inertSiblings = [...this.el.parentElement.children].filter(node => node !== this.el && node.id !== 'toast').map(node => [node, node.inert]);
    this.inertSiblings.forEach(([node]) => { node.inert = true; });
    this.view = new ScavengingView(this.el.querySelector('#scavenging-scene'));
    this.surface = this.el.querySelector('.sc-shell');
    this.pointerDown = event => {
      if (this.dialog || this.pointerId !== undefined || event.target.closest('button, .sc-modal') || event.isPrimary === false) return;
      event.preventDefault(); this.pointerId = event.pointerId; this.surface.setPointerCapture(event.pointerId);
      const rect = this.el.querySelector('#sc-stick').getBoundingClientRect();
      this.origin = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      // A drag can begin anywhere on the water, while the visible joystick stays within thumb reach.
      const distance = Math.hypot(event.clientX - this.origin.x, event.clientY - this.origin.y);
      this.dragOrigin = distance < 70 ? this.origin : { x: event.clientX, y: event.clientY };
      this.movePointer(event);
    };
    this.pointerMove = event => { if (event.pointerId === this.pointerId) { event.preventDefault(); this.movePointer(event); } };
    this.pointerEnd = event => { if (event.pointerId === this.pointerId) this.resetInput(); };
    this.surface.addEventListener('pointerdown', this.pointerDown);
    this.surface.addEventListener('pointermove', this.pointerMove);
    this.surface.addEventListener('pointerup', this.pointerEnd);
    this.surface.addEventListener('pointercancel', this.pointerEnd);
    this.surface.addEventListener('lostpointercapture', this.pointerEnd);
    this.lastTime = performance.now(); this.lastCargo = null; this.lastHits = null; this.noticeUntil = 0;
    this.update(); this.raf = requestAnimationFrame(this.frame);
    this.el.querySelector('[data-sc-action="pause"]').focus({ preventScroll: true });
    if (!this.dialog && !this.game.state.scavenging.guideSeen) this.showGuide();
    return true;
  }
  movePointer(event) {
    const dx = event.clientX - this.dragOrigin.x, dz = event.clientY - this.dragOrigin.y;
    const length = Math.hypot(dx, dz), limit = 45, scale = length > limit ? limit / length : 1;
    this.input = length < 5 ? { x: 0, z: 0 } : { x: dx * scale / limit, z: dz * scale / limit };
    this.el.querySelector('#sc-stick-knob').style.transform = `translate(${dx * scale}px,${dz * scale}px)`;
  }
  resetInput() {
    const id = this.pointerId; this.pointerId = undefined; this.input = { x: 0, z: 0 }; this.keys.clear();
    if (id !== undefined && this.surface?.hasPointerCapture(id)) this.surface.releasePointerCapture(id);
    const knob = this.el.querySelector('#sc-stick-knob'); if (knob) knob.style.transform = '';
  }
  frame(now) {
    if (!this.visible) return;
    const dt = Math.min(.05, Math.max(0, (now - this.lastTime) / 1000)); this.lastTime = now;
    if (!this.dialog && !document.hidden) {
      const x = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
      const z = (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0) - (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0);
      this.game.moveScavenging(this.keys.size ? { x, z } : this.input, dt);
      this.update();
    }
    this.raf = requestAnimationFrame(this.frame);
  }
  update() {
    if (!this.visible) return;
    const trip = this.game.getScavenging(); if (!trip || trip.status === 'returned') return;
    if (trip.status === 'failed') { this.showFailure(trip); return; }
    this.view?.update(trip);
    const cargo = trip.cargo || {}, key = kinds.map(k => cargo[k] || 0).join('/');
    if (key !== this.lastCargo || trip.capacity !== this.lastCapacity) {
      const count = total(cargo), capacity = trip.capacity || 100, full = count >= capacity;
      this.el.querySelector('#sc-total').textContent = `${format(count)}${full ? '（已满载）' : ''}`;
      const meter = this.el.querySelector('.sc-total'); meter.setAttribute('aria-valuenow', count); meter.setAttribute('aria-valuemax', capacity);
      meter.querySelector('i').style.transform = `scaleX(${Math.min(1,count/capacity)})`;
      this.el.querySelector('#sc-full-return').hidden = !full; this.surface.classList.toggle('sc-loaded', full);
      this.el.querySelector('#sc-cargo').innerHTML = cargoHTML(cargo);
      if (this.lastCargo !== null) {
        const previous = this.lastCargo.split('/').map(Number), delta = kinds.map((k, i) => [k, (cargo[k] || 0) - previous[i]]).filter(([, n]) => n !== 0);
        const lost = delta.some(([, n]) => n < 0);
        if (delta.length) this.notice((lost ? '货物散落：' : '拾取 ') + delta.map(([k, n]) => `${names[k]} ${n > 0 ? '+' : ''}${n}`).join(' · '), lost);
      }
      this.lastCargo = key; this.lastCapacity = trip.capacity;
    }
    const player = trip.player || {}, danger = (trip.sharks || []).some(s => Math.hypot(s.x - player.x, s.z - player.z) < 6);
    this.el.querySelector('#sc-warning').classList.toggle('danger', danger);
    this.el.querySelector('#sc-shark-label').textContent = danger ? '鲨鱼靠近！' : '小心鲨鱼';
    this.el.querySelector('#sc-hit-count').textContent = `撞击 ${trip.hits || 0} / 3`;
    this.el.querySelector('#sc-fish-warning').hidden = !(trip.fishSchools || []).some(s => Math.hypot(s.x - player.x, s.z - player.z) < 5);
    if(this.lastHits !== null && trip.hits > this.lastHits) this.notice(`被鲨鱼撞到了！${trip.hits} / 3`, true);
    this.lastHits = trip.hits || 0;
    const controlHint = this.el.querySelector('#sc-control-hint');
    if (trip.objects.length && trip.objects.every(object => object.collected)) controlHint.textContent = '这片海域已搜完，返航卸货后再出发';
    else if (total(cargo) > 0) controlHint.textContent = '收好货物，随时返航带回营地';
    if (performance.now() > this.noticeUntil) this.el.querySelector('#sc-notice').classList.remove('show');
  }
  notice(text, danger = false) {
    const el = this.el.querySelector('#sc-notice'); if (!el) return;
    el.textContent = text; el.classList.toggle('danger', danger); el.classList.add('show'); this.noticeUntil = performance.now() + 2200;
  }
  showGuide() {
    this.resetInput(); this.dialog = 'guide'; this.view?.setPaused(true);
    this.showModal('出海前，记住两件事', `<div class="sc-guide-threats"><div>${icon('fish')}<strong>避开鱼群</strong><small>它们会抢走货网里的物资</small></div><div>${icon('shark')}<strong>留意鲨鱼</strong><small>撞击三次，本次拾荒就会结束</small></div></div><p>拖动摇杆移动，靠近木材、塑料和碎布自动收集。货网当前可装${this.game.getScavenging()?.capacity || 100}份，随时返航把货物带回营地。</p>`, '<button data-sc-action="guide-done" class="sc-primary">知道了，开始拾荒</button>');
  }
  showFailure(trip) {
    if(this.dialog === 'failed' || this.dialog === 'result') return;
    this.resetInput(); this.view?.update(trip); this.view?.setPaused(true); this.dialog = 'failed'; this.game.save();
    this.showModal('拾荒遇险', '<p>受到三次鲨鱼撞击，本次拾荒已经中止。<br>先带着剩余货物回营地休整。</p>', '<button data-sc-action="return" class="sc-primary">带货返航</button>');
  }
  pause() {
    if (!this.visible || this.dialog) return;
    this.resetInput(); this.game.save(); this.view?.setPaused(true); this.dialog = 'pause';
    this.showModal('休息一下', '<p>航行已暂停，货物留在网里。</p>', '<button data-sc-action="resume" class="sc-primary">继续拾荒</button><button data-sc-action="leave" class="sc-secondary">暂离海域 · 保留进度</button>');
  }
  resume() {
    this.dialog = null; this.resetInput(); this.lastTime = performance.now(); this.view?.setPaused(false);
    this.el.querySelector('#sc-modal').hidden = true;
    [...this.surface.children].forEach(node => { node.inert = false; });
    this.update();
    this.el.querySelector('[data-sc-action="pause"]').focus({ preventScroll: true });
  }
  suspend() { if (this.visible && !this.dialog) this.pause(); else this.resetInput(); }
  sync(state, event) {
    if (!this.visible) return;
    if (event.type === 'reset') { this.close(); return; }
    if (event.type === 'load') { if (!['sailing','failed'].includes(this.game.getScavenging()?.status)) this.close(); else { this.update(); this.pause(); } }
  }
  showModal(title, body, actions) {
    const el = this.el.querySelector('#sc-modal'); el.hidden = false; el.className = 'sc-modal';
    [...this.surface.children].forEach(node => { if (node !== el) node.inert = true; });
    el.innerHTML = `<section class="sc-dialog" role="dialog" aria-modal="true" aria-label="${title}"><span class="sc-dialog-art">${icon('bag')}</span><h2>${title}</h2>${body}<div class="sc-dialog-actions">${actions}</div></section>`;
    el.querySelector('button')?.focus({ preventScroll: true });
  }
  settle() {
    if (this.dialog === 'result') return;
    this.resetInput(); const result = this.game.returnScavenging();
    if (!result.ok) { this.notify(result.message); return; }
    this.dialog = 'result'; this.view?.setPaused(true);
    this.showModal(result.failed ? '遇险返航' : '平安归航', '', '');
    const el = this.el.querySelector('#sc-modal'); el.classList.add('sc-reward-overlay');
    el.innerHTML = `<section class="sc-reward-stage" role="dialog" aria-modal="true" aria-label="${result.failed ? '遇险返航' : '平安归航'}"><div class="sc-reward-rays" aria-hidden="true"></div><small>${result.failed ? '带回剩余物资' : '满载希望，平安归来'}</small><h2>恭喜获得</h2><div class="sc-reward-materials">${kinds.map(k=>`<div class="sc-reward-item">${icon(k)}<strong>${names[k]}</strong><b>×${format(result.resources[k])}</b></div>`).join('')}</div><p>收获已放入营地背包</p><button class="sc-reward-close" data-sc-action="close">点击空白区域关闭</button></section>`;
    el.querySelector('button').focus({preventScroll:true});
  }
  showUpgrade() {
    this.resetInput(); this.view?.setPaused(true); this.game.save(); this.dialog = 'upgrade';
    const info = this.game.getScavengingUpgrade();
    const percent = value => `${Math.round((value || 0) * 100)}%`;
    const stats = [['加倍概率', percent(info.doubleChance), info.nextKind === 'enhance' ? `+${Math.round((info.next.doubleChance-info.doubleChance)*100)}%` : ''], ['加倍倍率', `${Math.round(info.doubleMultiplier*100)}%`, info.nextKind === 'tier' ? `+${Math.round((info.next.doubleMultiplier-info.doubleMultiplier)*100)}%` : ''], ['仓库容量', format(info.capacity), info.nextKind === 'tier' ? `+${info.next.capacity-info.capacity}` : '']];
    this.showModal('拾荒强化', `<button class="sc-upgrade-close" data-sc-action="upgrade-close" aria-label="关闭强化">×</button><div class="sc-upgrade-boat">${icon('scavenger')}</div><span class="sc-skill-level">拾荒等级 ${info.tier || 1} 级 · 强化 ${info.level}/${info.maxLevel}</span><div class="sc-upgrade-stats">${stats.map(([label,value,next])=>`<div><small>${label}</small><strong>${value}</strong><b>${next || '&nbsp;'}</b></div>`).join('')}</div><p class="sc-upgrade-hint">加倍时获得更多材料，货网容量仍按上限计算。</p><div class="sc-upgrade-price">${info.nextKind === 'tier' ? `建造 ${info.requiredBoats} 个拾荒船解锁新等级 <small>${info.buildingCount}/${info.requiredBoats}</small>` : info.cost ? `${icon('coin')} ${format(info.cost.coin)} <small>拥有 ${format(this.game.state.resources.coin)}</small>` : '已达到本阶段上限'}</div><p class="sc-upgrade-feedback" id="sc-upgrade-feedback" role="status">${info.nextKind === 'tier' ? info.canUpgrade ? '船队准备就绪，可以提升加倍倍率和仓库容量' : '先回营地再建造一艘拾荒船' : info.canUpgrade ? '强化后，下次拾取就有机会获得加倍物资' : info.cost ? '金币不足，先完成任务和物资交付' : '继续出海，为营地带回更多物资'}</p>`, `<button class="sc-enhance" data-sc-action="upgrade" ${info.canUpgrade ? '' : 'disabled'}>${info.nextKind === 'tier' ? '升级' : info.cost ? '强化' : '已满级'}</button>`);
    this.el.querySelector('#sc-modal').classList.add('sc-upgrade-overlay');
  }
  handle(event) {
    if (this.dialog === 'result' && event.target === this.el.querySelector('#sc-modal')) { this.close(); return; }
    const button = event.target.closest('[data-sc-action]'); if (!button || button.disabled) return;
    const action = button.dataset.scAction;
    if (action === 'guide-done') { this.game.markScavengingGuideSeen(); this.resume(); }
    else if (action === 'upgrade-open') this.showUpgrade();
    else if (action === 'upgrade-close') this.resume();
    else if (action === 'upgrade') { const result = this.game.upgradeScavenging(); this.showUpgrade(); const feedback = this.el.querySelector('#sc-upgrade-feedback'); feedback.textContent = result.message; feedback.classList.toggle('success', result.ok); }
    else if (action === 'pause') this.pause();
    else if (action === 'resume') this.resume();
    else if (action === 'return') this.settle();
    else if (action === 'leave' || action === 'close') this.close();
    else if (action === 'again') { this.close(); this.open(); }
  }
  close() {
    if (!this.visible) return;
    this.resetInput(); this.game.save(); this.visible = false; this.dialog = null; cancelAnimationFrame(this.raf);
    this.view?.dispose(); this.view = null;
    this.inertSiblings?.forEach(([node, before]) => { node.inert = before; }); this.inertSiblings = [];
    this.el.hidden = true; this.el.innerHTML = ''; document.body.classList.remove('scavenging-view');
    this.onToggle(false); if (this.lastFocus?.isConnected) this.lastFocus.focus({ preventScroll: true });
  }
}

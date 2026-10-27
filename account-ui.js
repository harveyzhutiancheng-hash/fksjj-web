import { icon } from './icons.js';

let nextAccountDialog = 0;
const USERNAME = /^[A-Za-z0-9_]{3,24}$/;
const STATUS = {
  guest: ['游客营地', '登录账号，把你的营地好好保存。'],
  checking: ['正在检查营地', '稍等一下，正在连接你的账号。'],
  synced: ['营地已保存', '云端已记住你的最新进度。'],
  pending: ['等待保存', '你的营地有新进展，正在等待同步。'],
  offline: ['暂时离线', '连接恢复后，可以再次保存营地。'],
  conflict: ['有两份营地进度', '先选择这次要继续哪一座营地。'],
  expired: ['请重新登录', '登录已过期，重新登录后继续保存营地。'],
  error: ['暂未完成保存', '连接没有完成，请稍后再试。'],
};
const dateLabel = (value) => {
  if (value === null || value === undefined || value === '') return '暂无记录';
  const date = new Date(typeof value === 'string' && !/^\d+$/.test(value) ? value : Number(value));
  if (!Number.isFinite(date.getTime())) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
};

/** Account presentation only. The manager owns credentials, saves and conflicts. */
export class AccountUI {
  constructor(container, { manager, onToggle = () => {}, notify = () => {} }) {
    if (!container || !manager) throw new Error('AccountUI requires a container and manager.');
    this.el = container;
    this.manager = manager;
    this.onToggle = onToggle;
    this.notify = notify;
    this.visible = false;
    this.mode = 'login';
    this.localBusy = false;
    this.confirmLocal = null;
    this.screen = null;
    this.id = `account-dialog-${++nextAccountDialog}`;
    this.inertSiblings = [];
    this.el.classList.add('account-root');
    this.el.hidden = true;
    this._click = (event) => this.handle(event);
    this._submit = (event) => { event.preventDefault(); event.stopPropagation(); void this.submit(); };
    this._input = (event) => { if (event.target.matches('input')) event.target.removeAttribute('aria-invalid'); };
    this._keydown = (event) => this.keydown(event);
    this._focusin = (event) => {
      if (this.visible && !this.el.contains(event.target)) this.focusFirst();
    };
    this._viewport = () => this.updateViewport();
    this.el.addEventListener('click', this._click);
    this.el.addEventListener('submit', this._submit);
    this.el.addEventListener('input', this._input);
    // Some managers immediately call subscribers. All state exists before this.
    this.unsubscribe = manager.subscribe(() => this.sync());
  }

  open() {
    if (this.visible) { this.sync(); return; }
    this.lastFocus = document.activeElement;
    this.previousInert = this.el.inert;
    this.el.inert = false;
    this.visible = true;
    this.confirmLocal = null;
    this.screen = null;
    this.el.hidden = false;
    this.mount();
    let branch = this.el;
    const visited = new Set();
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || sibling.id === 'toast' || visited.has(sibling)) continue;
        visited.add(sibling);
        this.inertSiblings.push([sibling, sibling.inert]);
        sibling.inert = true;
      }
      if (branch.parentElement === document.body) break;
      branch = branch.parentElement;
    }
    document.addEventListener('keydown', this._keydown, true);
    document.addEventListener('focusin', this._focusin, true);
    window.addEventListener('resize', this._viewport);
    window.visualViewport?.addEventListener('resize', this._viewport);
    window.visualViewport?.addEventListener('scroll', this._viewport);
    document.body.classList.add('account-view');
    this.onToggle(true);
    this.updateViewport();
    this.sync();
    this.focusFirst();
  }

  mount() {
    this.el.innerHTML = `<div class="account-shade" data-account-shade>
      <section class="account-window" role="dialog" aria-modal="true" aria-labelledby="${this.id}-title" tabindex="-1">
        <header class="account-header"><span class="account-emblem" aria-hidden="true">${icon('ship')}</span><div><small>海上家园</small><h2 id="${this.id}-title">我的账号</h2></div><button type="button" class="account-close" data-account-action="close" aria-label="关闭账号面板">${icon('close')}</button></header>
        <div class="account-status" role="status" aria-live="polite"><span class="account-status-dot" aria-hidden="true"></span><div><strong data-account-status></strong><p data-account-message></p></div></div>
        <div class="account-body">
          <section data-account-auth>
            <div class="account-tabs" role="tablist" aria-label="登录或注册"><button type="button" role="tab" data-account-action="login-tab" data-account-lock>登录账号</button><button type="button" role="tab" data-account-action="register-tab" data-account-lock>注册账号</button></div>
            <p class="account-expired-note" data-account-expired hidden>请重新登录当前账号，或先退出账号。</p>
            <form id="${this.id}-form" class="account-form" novalidate>
              <label class="account-field"><span>用户名</span><input name="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}" required aria-describedby="${this.id}-username-hint" data-account-lock><small id="${this.id}-username-hint">3–24位字母、数字或下划线</small></label>
              <label class="account-field"><span>密码</span><input name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required aria-describedby="${this.id}-password-hint" data-account-lock><small id="${this.id}-password-hint">8–128位，请妥善保管</small></label>
              <label class="account-field" data-account-confirm-field hidden><span>确认密码</span><input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" data-account-lock></label>
              <label class="account-check account-show-password"><input type="checkbox" name="showPassword" data-account-lock><span>显示密码</span></label>
              <label class="account-check account-import" data-account-import><input type="checkbox" name="importGuest" checked data-account-lock><span>云端为空时保存本机游客营地<small>游客副本仍会保留</small></span></label>
              <p class="account-form-note" data-account-import-note>已有云端营地会优先读取，本机游客副本保留；两边进度不会合并。</p>
            </form>
          </section>
          <section class="account-profile" data-account-profile hidden><div class="account-captain" aria-hidden="true">${icon('people')}</div><div><small>正在使用的账号</small><h3 data-account-username></h3><p>让每一次远航，都有归处。</p></div></section>
          <dl class="account-save-time" data-account-save-time hidden><dt>上次云端存档</dt><dd data-account-last-synced></dd></dl>
          <section class="account-conflict" data-account-conflict hidden>
            <div data-account-conflict-choice><h3>这次继续哪座营地？</h3><p>云端营地更新于 <strong data-account-cloud-time></strong>。选择前请确认要保留的进度。</p><button type="button" class="account-button account-cloud-choice" data-account-action="cloud" data-account-lock><strong>读取云端营地</strong><small>本机营地备份仍会保留</small></button><button type="button" class="account-button account-local-choice" data-account-action="review-local" data-account-lock><strong>保留本机并覆盖云端</strong><small>用当前设备的进度替换云端营地</small></button></div>
            <div class="account-review" data-account-review hidden><span class="account-review-icon" aria-hidden="true">${icon('flag')}</span><h3>确认保留本机营地？</h3><p>账号 <strong data-account-review-name></strong> 的云端营地将被当前设备的进度替换。</p><dl><dt>将替换的云端存档</dt><dd data-account-review-time></dd></dl><p class="account-review-note">确认后，下次登录将使用这台设备的营地进度。</p><button type="button" class="account-button account-danger" data-account-action="confirm-local" data-account-lock>确认覆盖云端</button><button type="button" class="account-button account-secondary" data-account-action="cancel-local" data-account-lock>再想想</button></div>
          </section>
          <p class="account-error" id="${this.id}-error" role="alert" aria-live="assertive" aria-atomic="true" hidden></p>
        </div>
        <footer class="account-footer"><button type="submit" form="${this.id}-form" class="account-button account-primary" data-account-submit data-account-lock>登录账号</button><button type="button" class="account-button account-primary" data-account-action="sync" data-account-sync data-account-lock hidden>保存当前营地</button><button type="button" class="account-button account-primary" data-account-action="reload" data-account-reload data-account-lock hidden>重新载入账号营地</button><button type="button" class="account-button account-secondary" data-account-action="logout" data-account-logout data-account-lock hidden>退出登录</button></footer>
      </section></div>`;
    this.form = this.el.querySelector('form');
    this.form.addEventListener('change', (event) => {
      if (event.target.name !== 'showPassword') return;
      const type = event.target.checked ? 'text' : 'password';
      this.form.elements.password.type = type;
      this.form.elements.confirmPassword.type = type;
    });
  }

  sync() {
    if (!this.visible) return;
    const state = this.manager.snapshot();
    this.state = state;
    const expired = state.phase === 'expired';
    const authenticated = !!state.user && !expired;
    const conflict = authenticated && state.phase === 'conflict';
    const nextScreen = authenticated ? 'profile' : expired ? 'expired' : 'guest';
    if (this.screen !== nextScreen) {
      this.clearPasswords();
      this.clearError();
      this.confirmLocal = false;
      if (expired) {
        this.mode = 'login';
        this.form.elements.username.value = state.user?.username || '';
      }
      this.screen = nextScreen;
    }
    if (!conflict || this.confirmLocal && (this.confirmLocal.userId !== state.user?.id || this.confirmLocal.revision !== state.conflict?.revision)) this.confirmLocal = null;
    this.el.dataset.phase = state.phase || 'guest';
    const [label, fallback] = STATUS[state.phase] || STATUS.error;
    this.el.querySelector('[data-account-status]').textContent = label;
    this.el.querySelector('[data-account-message]').textContent = state.message || fallback;
    this.el.querySelector('[data-account-auth]').hidden = authenticated;
    this.el.querySelector('[data-account-profile]').hidden = !authenticated;
    this.el.querySelector('[data-account-save-time]').hidden = !authenticated;
    this.el.querySelector('[data-account-username]').textContent = state.user?.username || '';
    this.el.querySelector('[data-account-last-synced]').textContent = dateLabel(state.lastSyncedAt);
    this.el.querySelector('[data-account-expired]').hidden = !expired;
    this.el.querySelector('.account-tabs').hidden = expired;
    this.el.querySelector('[data-account-import]').hidden = expired;
    this.el.querySelector('[data-account-import-note]').hidden = expired;
    this.el.querySelector('[data-account-confirm-field]').hidden = this.mode !== 'register' || expired;
    this.form.elements.confirmPassword.required = this.mode === 'register' && !expired;
    this.form.elements.password.autocomplete = this.mode === 'register' ? 'new-password' : 'current-password';
    for (const button of this.el.querySelectorAll('[role="tab"]')) {
      const selected = button.dataset.accountAction === `${this.mode}-tab`;
      button.setAttribute('aria-selected', String(selected));
      button.classList.toggle('selected', selected);
    }
    this.el.querySelector('[data-account-conflict]').hidden = !conflict;
    this.el.querySelector('[data-account-conflict-choice]').hidden = !!this.confirmLocal;
    this.el.querySelector('[data-account-review]').hidden = !this.confirmLocal;
    const cloudTime = dateLabel(state.conflict?.updatedAt);
    this.el.querySelector('[data-account-cloud-time]').textContent = cloudTime;
    this.el.querySelector('[data-account-review-time]').textContent = cloudTime;
    this.el.querySelector('[data-account-review-name]').textContent = state.user?.username || '';
    const busy = !!state.busy || this.localBusy;
    for (const field of this.el.querySelectorAll('[data-account-lock]')) field.disabled = busy;
    this.form.elements.importGuest.disabled = busy || !state.hasGuestSave || expired;
    const submit = this.el.querySelector('[data-account-submit]');
    submit.hidden = authenticated;
    submit.textContent = busy ? '正在处理…' : expired ? '重新登录' : this.mode === 'register' ? '注册并保存营地' : '登录账号';
    const sync = this.el.querySelector('[data-account-sync]');
    sync.hidden = !authenticated || conflict || state.phase === 'error' || state.identityFrozen;
    sync.textContent = busy ? '正在保存…' : '保存当前营地';
    this.el.querySelector('[data-account-reload]').hidden = !authenticated || !(state.phase === 'error' || state.identityFrozen);
    this.el.querySelector('[data-account-logout]').hidden = !authenticated && !expired;
    this.el.querySelector('.account-footer').classList.toggle('account-footer-single', !authenticated && !expired || conflict);
    if (state.phase === 'error' && state.message && !this.errorMessage) this.showError(state.message);
  }

  async submit() {
    if (this.localBusy || this.manager.snapshot().busy) return;
    const state = this.manager.snapshot();
    if (state.user && state.phase !== 'expired') return;
    this.clearError();
    const username = this.form.elements.username.value.trim();
    let password = this.form.elements.password.value;
    if (!USERNAME.test(username)) { this.showError('用户名需为3–24位字母、数字或下划线。', this.form.elements.username); return; }
    if (password.length < 8 || password.length > 128) { this.showError('密码需为8–128位。', this.form.elements.password); return; }
    const registration = this.mode === 'register' && state.phase !== 'expired';
    if (registration && password !== this.form.elements.confirmPassword.value) { this.showError('两次输入的密码不一致。', this.form.elements.confirmPassword); return; }
    const importGuest = state.phase !== 'expired' && !!state.hasGuestSave && this.form.elements.importGuest.checked;
    this.clearPasswords();
    await this.perform(() => {
      const request = registration ? this.manager.register(username, password, { importGuest }) : this.manager.login(username, password, { importGuest });
      password = '';
      return request;
    });
    password = '';
  }

  async perform(action) {
    if (this.localBusy || this.manager.snapshot().busy) return;
    this.localBusy = true;
    this.clearError();
    this.sync();
    try { await action(); }
    catch (error) {
      const message = error?.userMessage || error?.message || '操作没有完成，请稍后再试。';
      if (this.visible) this.showError(message);
      else this.notify(message);
    } finally {
      this.localBusy = false;
      this.clearPasswords();
      this.sync();
    }
  }

  handle(event) {
    event.stopPropagation();
    if (event.target.hasAttribute('data-account-shade')) { this.close(); return; }
    const button = event.target.closest('[data-account-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.accountAction;
    if (action === 'close') { this.close(); return; }
    if (this.localBusy || this.manager.snapshot().busy) return;
    if (action === 'login-tab' || action === 'register-tab') {
      if (this.manager.snapshot().phase === 'expired') return;
      this.mode = action === 'register-tab' ? 'register' : 'login';
      this.clearPasswords(); this.clearError(); this.sync();
      this.form.elements.username.focus({ preventScroll: true });
    } else if (action === 'sync') void this.perform(() => this.manager.syncNow());
    else if (action === 'reload') this.manager.reload();
    else if (action === 'logout') void this.perform(() => this.manager.logout());
    else if (action === 'cloud') {
      const state = this.manager.snapshot();
      if(state.phase !== 'conflict' || !state.user)return;
      void this.perform(() => this.manager.resolveConflict('cloud', {userId:state.user?.id,revision:state.conflict?.revision}));
    }
    else if (action === 'review-local') {
      const state = this.manager.snapshot();
      if(state.phase !== 'conflict' || !state.user)return;
      this.confirmLocal = {userId:state.user.id,revision:state.conflict?.revision}; this.clearError(); this.sync();
      this.el.querySelector('[data-account-action="confirm-local"]')?.focus({ preventScroll: true });
    } else if (action === 'cancel-local') {
      this.confirmLocal = null; this.clearError(); this.sync();
      this.el.querySelector('[data-account-action="review-local"]')?.focus({ preventScroll: true });
    } else if (action === 'confirm-local' && this.confirmLocal) {
      const state=this.manager.snapshot(), expected=this.confirmLocal;
      if(state.phase!=='conflict'||expected.userId!==state.user?.id||expected.revision!==state.conflict?.revision){
        this.confirmLocal=null;this.sync();this.showError('营地进度已经变化，请重新查看后确认。');return;
      }
      void this.perform(() => this.manager.resolveConflict('local', expected));
    }
  }

  showError(message, field = null) {
    this.errorMessage = String(message);
    const error = this.el.querySelector('.account-error');
    if (!error) return;
    error.textContent = this.errorMessage;
    error.hidden = false;
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
    else error.scrollIntoView?.({ block: 'nearest' });
  }
  clearError() {
    this.errorMessage = '';
    const error = this.el.querySelector('.account-error');
    if (error) { error.textContent = ''; error.hidden = true; }
    for (const field of this.el.querySelectorAll('[aria-invalid]')) field.removeAttribute('aria-invalid');
  }
  clearPasswords() {
    for (const input of this.el.querySelectorAll('input[name="password"],input[name="confirmPassword"]')) { input.value = ''; input.type = 'password'; }
    const show = this.el.querySelector('input[name="showPassword"]');
    if (show) show.checked = false;
  }
  focusable() {
    return [...this.el.querySelectorAll('button,input,a[href],[tabindex="0"]')].filter((node) => !node.disabled && !node.closest('[hidden]') && node.getClientRects().length);
  }
  focusFirst() {
    const username = this.el.querySelector('input[name="username"]');
    if (username && !username.disabled && !username.closest('[hidden]')) username.focus({ preventScroll: true });
    else (this.focusable()[0] || this.el.querySelector('.account-window'))?.focus({ preventScroll: true });
  }
  keydown(event) {
    if (!this.visible) return;
    event.stopPropagation();
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); this.close(); return; }
    if (event.key !== 'Tab') return;
    const nodes = this.focusable();
    if (!nodes.length) { event.preventDefault(); this.el.querySelector('.account-window')?.focus(); return; }
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || !this.el.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !this.el.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  updateViewport() {
    if (!this.visible) return;
    const viewport = window.visualViewport;
    this.el.style.setProperty('--account-viewport-height', `${viewport?.height || window.innerHeight}px`);
    this.el.style.setProperty('--account-viewport-top', `${viewport?.offsetTop || 0}px`);
    this.el.dataset.compact = String((viewport?.height || window.innerHeight) < 460);
    if (this.el.contains(document.activeElement) && document.activeElement?.matches('input')) document.activeElement.scrollIntoView?.({ block: 'nearest' });
  }
  close() {
    if (!this.visible) return;
    this.clearPasswords();
    this.visible = false;
    this.confirmLocal = false;
    document.removeEventListener('keydown', this._keydown, true);
    document.removeEventListener('focusin', this._focusin, true);
    window.removeEventListener('resize', this._viewport);
    window.visualViewport?.removeEventListener('resize', this._viewport);
    window.visualViewport?.removeEventListener('scroll', this._viewport);
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.form = null;
    for (const [sibling, before] of this.inertSiblings) sibling.inert = before;
    this.inertSiblings = [];
    this.el.inert = this.previousInert;
    document.body.classList.remove('account-view');
    this.onToggle(false);
    if (this.lastFocus?.isConnected && !this.lastFocus.closest('[inert]')) this.lastFocus.focus({ preventScroll: true });
  }
  destroy() {
    this.close();
    this.unsubscribe?.();
    this.el.removeEventListener('click', this._click);
    this.el.removeEventListener('submit', this._submit);
    this.el.removeEventListener('input', this._input);
  }
}

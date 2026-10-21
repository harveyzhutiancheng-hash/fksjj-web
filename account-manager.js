export const GUEST_SAVE_KEY = 'fkssj-save-v1';
export const ACTIVE_ACCOUNT_KEY = 'fkssj-active-account-v1';
export const accountSaveKey = id => `fkssj-account-save-v1:${id}`;
const metaKey = id => `fkssj-account-meta-v1:${id}`;
const importKey = id => `fkssj-account-import-v1:${id}`;
const message = (text, code) => Object.assign(new Error(text), { userMessage:text, code });
const identity = user => user && Number.isSafeInteger(user.id) && user.id > 0 && typeof user.username === 'string' ? { id:user.id, username:user.username } : null;

/** GameState writes to a captured identity; a login cannot redirect an old page's save. */
export class AccountManager {
  constructor({ storage = globalThis.localStorage, fetcher = globalThis.fetch.bind(globalThis), validate = () => {}, reload = () => location.reload(), ownsPage = () => true, now = Date.now, autoSync = true } = {}) {
    Object.assign(this, { storage, fetcher, validate, reload, ownsPage, now, autoSync });
    this.user = null; this.phase = 'checking'; this.busy = false; this.message = '';
    this.csrfToken = null; this.revision = 0; this.lastSyncedAt = null;
    this.conflict = null; this.transitioning = false; this.generation = 0; this.needsRemote = false;
    this.listeners = new Set(); this.timer = null; this.inflight = null;
    this.beforeTransition = () => {};
  }
  read(key) { try { return this.storage.getItem(key); } catch { return null; } }
  json(key) { try { return JSON.parse(this.read(key)); } catch { return null; } }
  write(key, value) { this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); }
  snapshot() {
    return { phase:this.phase, user:this.user, busy:this.busy, message:this.message, lastSyncedAt:this.lastSyncedAt, conflict:this.conflict, hasGuestSave:!!this.read(GUEST_SAVE_KEY) };
  }
  subscribe(fn) { this.listeners.add(fn); fn(this.snapshot()); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.snapshot()); }
  get canPlay() { return !this.transitioning && !this.needsRemote && !['checking','conflict','error'].includes(this.phase) && this.ownsPage(); }
  async request(path, { method = 'GET', body, user = this.user, csrf = this.csrfToken } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (csrf) headers['X-CSRF-Token'] = csrf;
      if (user) headers['X-FKSSJ-User'] = String(user.id);
      const response = await this.fetcher(`/api${path}`, { method, credentials:'same-origin', cache:'no-store', headers, ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:controller.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw message(data?.message || '服务暂时不可用，请稍后重试。', data?.code || `http_${response.status}`);
      if (!data || typeof data !== 'object') throw message('服务器返回异常，请稍后重试。', 'network');
      return data;
    } catch (error) {
      if (error.userMessage) throw error;
      throw message('暂时连不上服务器，进度仍保存在本机。', 'network');
    } finally { clearTimeout(timeout); }
  }
  checkedSave(save) {
    if (!save || typeof save !== 'object' || save.version !== 1) throw message('云存档版本暂不兼容，原有进度已保留。', 'invalid_save');
    try { this.validate(save); } catch { throw message('存档暂时无法读取，原有进度已保留。', 'invalid_save'); }
    return JSON.stringify(save);
  }
  backup(id, text) {
    if (text) this.write(`fkssj-account-backup-v1:${id}`, { savedAt:this.now(), save:JSON.parse(text) });
  }
  metadata(id = this.user?.id) {
    return this.json(metaKey(id)) || { revision:0, dirty:!!this.read(accountSaveKey(id)), serial:0, lastSyncedAt:null };
  }
  saveMetadata(meta, id = this.user.id) { this.write(metaKey(id), meta); }
  async prepare() {
    const hint = identity(this.json(ACTIVE_ACCOUNT_KEY));
    try {
      const auth = await this.request('/auth/me');
      if (!identity(auth.user)) {
        if (hint && this.read(accountSaveKey(hint.id))) {
          this.user = hint; this.phase = 'expired'; this.message = '登录已过期，本机进度已保留，请重新登录。';
        } else { this.phase = 'guest'; this.storage.removeItem(ACTIVE_ACCOUNT_KEY); }
      } else {
        this.user = identity(auth.user); this.csrfToken = auth.csrfToken;
        this.write(ACTIVE_ACCOUNT_KEY, this.user);
        this.needsRemote = !this.read(accountSaveKey(this.user.id));
        await this.reconcile(await this.request('/save'));
        this.needsRemote = false;
      }
    } catch (error) {
      if (!this.user && hint && this.read(accountSaveKey(hint.id))) this.user = hint;
      this.phase = error.code === 'invalid_save' ? 'error' : this.user ? 'offline' : 'guest';
      this.message = error.userMessage || '本机储存空间不可用，请检查浏览器设置。';
    }
    this.emit();
  }
  async reconcile(remote) {
    if (!Number.isSafeInteger(remote.revision) || remote.revision < 0) throw message('云存档版本异常，暂未同步。', 'invalid_save');
    const id = this.user.id, key = accountSaveKey(id);
    // Persist migration intent across an interrupted first login; never replace an existing camp.
    const pendingGuest = this.read(importKey(id));
    if (!remote.save && !this.read(key) && pendingGuest) {
      this.checkedSave(JSON.parse(pendingGuest));
      this.write(key, pendingGuest);
      this.saveMetadata({ revision:remote.revision, dirty:true, serial:1, lastSyncedAt:null });
    }
    const local = this.read(key), meta = this.metadata();
    const cloud = remote.save === null ? null : this.checkedSave(remote.save);
    this.storage.removeItem(importKey(id));
    this.revision = remote.revision; this.lastSyncedAt = meta.lastSyncedAt;
    if (meta.dirty && local && meta.revision !== remote.revision && local !== cloud) {
      this.conflict = { revision:remote.revision, updatedAt:remote.updatedAt };
      this.phase = 'conflict'; this.message = '另一台设备更新过营地，请选择要保留的进度。'; return;
    }
    if (meta.dirty && local && local !== cloud) {
      this.saveMetadata({ ...meta, revision:remote.revision });
      this.phase = 'pending'; this.schedule(); return;
    }
    if (cloud) {
      if (local && local !== cloud) this.backup(id, local);
      this.write(key, cloud);
    }
    this.lastSyncedAt = cloud ? remote.updatedAt : null;
    this.saveMetadata({ revision:remote.revision, dirty:false, serial:meta.serial || 0, lastSyncedAt:this.lastSyncedAt });
    this.conflict = null; this.phase = cloud ? 'synced' : 'pending'; this.message = '';
  }
  createStorage() {
    const owner = this.user?.id ?? null;
    const key = owner ? accountSaveKey(owner) : GUEST_SAVE_KEY;
    return {
      getItem: () => this.read(key),
      setItem: (_key, text) => {
        if (!this.ownsPage()) throw new Error('另一页正在使用营地，请刷新后继续。');
        // Never replace a cloud snapshot while leaving an old page during an account switch.
        if (this.transitioning || this.needsRemote || this.phase === 'error') return;
        this.write(key, text);
        if (owner) {
          const meta = this.metadata(owner);
          this.saveMetadata({ ...meta, dirty:true, serial:(meta.serial || 0) + 1 }, owner);
          if (this.user?.id === owner && !['conflict','expired','error'].includes(this.phase)) {
            if (this.phase !== 'offline') this.phase = 'pending';
            this.emit(); this.schedule();
          }
        }
      },
      removeItem: () => { if (!this.transitioning && this.ownsPage()) this.storage.removeItem(key); }
    };
  }
  schedule(delay = 1200) {
    if (!this.autoSync || this.timer || this.transitioning || !this.user || ['conflict','expired','error'].includes(this.phase)) return;
    this.timer = setTimeout(() => { this.timer = null; this.syncNow().catch(() => {}); }, delay);
  }
  async syncNow() {
    if (this.inflight) return this.inflight;
    if (!this.user || this.transitioning) return;
    if (!this.ownsPage()) throw message('请回到正在游玩的标签页。', 'page_locked');
    if (this.phase === 'conflict') throw message('请先选择要保留的进度。', 'save_conflict');
    if (this.phase === 'error') throw message(this.message, 'invalid_save');
    if (this.phase === 'expired') throw message('请重新登录后同步进度。', 'unauthorized');
    const epoch = this.generation, user = this.user;
    this.inflight = this.upload(epoch, user).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async upload(epoch, user) {
    let sentText = null, sentSerial = null;
    try {
      if (!this.csrfToken) {
        const auth = await this.request('/auth/me');
        if (auth.user?.id !== user.id) throw message('登录状态已变化，请重新登录。', 'user_mismatch');
        this.csrfToken = auth.csrfToken;
      }
      if (this.needsRemote) {
        await this.reconcile(await this.request('/save', {user}));
        this.needsRemote = false;
        this.leaving = true; this.transitioning = true; this.reload(); return;
      }
      const meta = this.metadata(user.id);
      if (!meta.dirty) { this.phase = 'synced'; this.emit(); return; }
      sentText = this.read(accountSaveKey(user.id)); sentSerial = meta.serial;
      if (!sentText) return;
      const save = JSON.parse(sentText); this.checkedSave(save);
      const result = await this.request('/save', { method:'PUT', body:{ expectedRevision:meta.revision, save }, user });
      if (epoch !== this.generation) return;
      this.acceptUpload(user.id, sentSerial, result);
    } catch (error) {
      if (epoch !== this.generation) return;
      if (error.code === 'save_conflict') {
        try {
          const remote = await this.request('/save', { user });
          if (epoch !== this.generation) return;
          // A timed-out PUT may already have committed. Resume only on exact snapshot equality.
          if (sentText && remote.save && this.checkedSave(remote.save) === sentText) {
            this.acceptUpload(user.id, sentSerial, remote); return;
          }
          this.conflict = { revision:remote.revision, updatedAt:remote.updatedAt };
        } catch { this.conflict = { revision:null, updatedAt:null }; }
        this.phase = 'conflict'; this.message = '云端已有另一份进度，请选择要保留的营地。';
      } else if (['unauthorized','user_mismatch','csrf_invalid','http_401'].includes(error.code)) {
        this.phase = 'expired'; this.csrfToken = null; this.message = '登录已过期，本机进度已保留，请重新登录。';
      } else {
        this.phase = error.code === 'invalid_save' ? 'error' : 'offline';
        this.message = error.userMessage || '暂时无法同步，本机进度已保留。';
        if (this.phase === 'offline') this.schedule(15000);
      }
      this.emit(); throw error;
    }
  }
  acceptUpload(id, sentSerial, result) {
    const current = this.metadata(id);
    const dirty = current.serial !== sentSerial;
    this.revision = result.revision; this.lastSyncedAt = result.updatedAt;
    this.saveMetadata({ ...current, revision:result.revision, dirty, lastSyncedAt:result.updatedAt }, id);
    this.phase = dirty ? 'pending' : 'synced'; this.message = ''; this.conflict = null; this.emit();
    if (dirty) this.schedule();
  }
  async transition(operation, saveBefore = true) {
    if (this.busy || !this.ownsPage()) throw message('请稍等当前操作完成。', 'busy');
    this.busy = true; this.emit();
    try {
      if (saveBefore) this.beforeTransition();
      this.transitioning = true;
      clearTimeout(this.timer); this.timer = null;
      if (this.inflight) await this.inflight.catch(() => {});
      this.generation++;
      await operation();
    } catch (error) {
      this.message = error.userMessage || '操作没有完成，请稍后重试。';
      throw error;
    } finally { this.busy = false; this.transitioning = !!this.leaving; this.emit(); this.schedule(); }
  }
  register(username, password, options = {}) { return this.authenticate('register', username, password, options); }
  login(username, password, options = {}) { return this.authenticate('login', username, password, options); }
  async authenticate(kind, username, password, { importGuest = true } = {}) {
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) throw message('用户名需为 3–24 位字母、数字或下划线。', 'invalid_username');
    if (password.length < 8 || password.length > 128) throw message('密码需为 8–128 个字符。', 'invalid_password');
    await this.transition(async () => {
      const auth = await this.request(`/auth/${kind}`, { method:'POST', body:{ username, password } });
      if (!identity(auth.user) || !auth.csrfToken) throw message('登录响应异常，请重试。', 'network');
      this.user = identity(auth.user); this.csrfToken = auth.csrfToken; this.conflict = null;
      this.write(ACTIVE_ACCOUNT_KEY, this.user);
      if (!this.read(accountSaveKey(this.user.id)) && importGuest) {
        const guest = this.read(GUEST_SAVE_KEY);
        if (guest) {
          this.checkedSave(JSON.parse(guest));
          this.write(importKey(this.user.id), guest);
        }
      }
      try { await this.reconcile(await this.request('/save')); }
      catch (error) {
        // Authentication succeeded: the old page must stop even if fetching its camp failed.
        this.phase = error.code === 'invalid_save' ? 'error' : 'offline';
        this.message = error.userMessage;
      }
      this.leaving = true; this.reload();
    });
  }
  async logout() {
    this.beforeTransition();
    if (!['expired','conflict','error'].includes(this.phase)) {
      await this.syncNow().catch(() => {});
    }
    await this.transition(async () => {
      // Re-fetch CSRF to allow a stale tab to explicitly sign out the current browser session.
      const auth = await this.request('/auth/me');
      await this.request('/auth/logout', { method:'POST', body:{}, user:auth.user, csrf:auth.csrfToken });
      this.storage.removeItem(ACTIVE_ACCOUNT_KEY); this.csrfToken = null;
      this.user = null; this.phase = 'guest'; this.conflict = null; this.leaving = true; this.reload();
    }, false);
  }
  async resolveConflict(choice) {
    if (!['cloud','local'].includes(choice)) throw new Error('Unknown save choice');
    await this.transition(async () => {
      const remote = await this.request('/save');
      const id = this.user.id, key = accountSaveKey(id), local = this.read(key);
      this.backup(id, local);
      if (choice === 'cloud') {
        if (!remote.save) throw message('云端还没有进度，请保留本机营地。', 'empty_cloud');
        this.write(key, this.checkedSave(remote.save));
        this.saveMetadata({ revision:remote.revision, dirty:false, serial:0, lastSyncedAt:remote.updatedAt });
      } else {
        if (!local) throw message('本机没有可上传的进度。', 'empty_local');
        const save = JSON.parse(local); this.checkedSave(save);
        const result = await this.request('/save', { method:'PUT', body:{ expectedRevision:remote.revision, save } });
        this.acceptUpload(id, this.metadata().serial, result);
      }
      this.leaving = true; this.reload();
    });
  }
}

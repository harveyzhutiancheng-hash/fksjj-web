export const GUEST_SAVE_KEY = 'fkssj-save-v1';
export const ACTIVE_ACCOUNT_KEY = 'fkssj-active-account-v1';
export const accountSaveKey = id => `fkssj-account-save-v1:${id}`;
const metaKey = id => `fkssj-account-meta-v1:${id}`;
const importKey = id => `fkssj-account-import-v1:${id}`;
const message = (text, code) => Object.assign(new Error(text), { userMessage:text, code });
const identity = user => user && Number.isSafeInteger(user.id) && user.id > 0 && typeof user.username === 'string' ? { id:user.id, username:user.username } : null;
const AUTH_ERRORS = new Set(['authentication_required','unauthorized','user_mismatch','csrf_invalid','http_401']);
const BLOCKED = new Set(['checking','conflict','expired','error']);

/** A running GameState remains bound to its original account until a reload. */
export class AccountManager {
  constructor({ storage = globalThis.localStorage, fetcher = globalThis.fetch.bind(globalThis), validate = () => {}, reload = () => location.reload(), ownsPage = () => true, now = Date.now, autoSync = true } = {}) {
    Object.assign(this, { storage, fetcher, validate, reload, ownsPage, now, autoSync });
    this.user = null; this.phase = 'checking'; this.busy = false; this.message = '';
    this.csrfToken = null; this.revision = 0; this.lastSyncedAt = null;
    this.conflict = null; this.transitioning = false; this.generation = 0; this.needsRemote = false;
    this.identityFrozen = false; this.leaving = false;
    this.listeners = new Set(); this.timer = null; this.inflight = null;
    this.beforeTransition = () => {};
  }
  read(key) { try { return this.storage.getItem(key); } catch { return null; } }
  json(key) { try { return JSON.parse(this.read(key)); } catch { return null; } }
  write(key, value) {
    try { this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); }
    catch { throw message('浏览器未能写入存档。营地已暂停，请检查储存空间后重新载入。', 'storage_unavailable'); }
  }
  remove(key) {
    try { this.storage.removeItem(key); }
    catch { throw message('浏览器未能更新存档。营地已暂停，请检查储存空间后重新载入。', 'storage_unavailable'); }
  }
  snapshot() {
    return { phase:this.phase, user:this.user, busy:this.busy, message:this.message, lastSyncedAt:this.lastSyncedAt, conflict:this.conflict && {...this.conflict}, hasGuestSave:!!this.read(GUEST_SAVE_KEY), canPlay:this.canPlay, needsRemote:this.needsRemote, identityFrozen:this.identityFrozen };
  }
  subscribe(fn) { this.listeners.add(fn); fn(this.snapshot()); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.snapshot()); }
  hintMatches(user = this.user) { return (identity(this.json(ACTIVE_ACCOUNT_KEY))?.id ?? null) === (user?.id ?? null); }
  checkHint(user = this.user) {
    // Preserve the original failure reason, especially a successful login whose hint write failed.
    if (this.identityFrozen) return false;
    if (this.hintMatches(user)) return true;
    this.freezeIdentity(); return false;
  }
  get canPlay() { return !this.identityFrozen && !this.transitioning && !this.needsRemote && !BLOCKED.has(this.phase) && this.hintMatches() && this.ownsPage(); }
  current(epoch, user = this.user) {
    if (epoch !== this.generation || (user?.id ?? null) !== (this.user?.id ?? null)) return false;
    return this.checkHint(user);
  }
  stopTimer() { clearTimeout(this.timer); this.timer = null; }
  freezeIdentity(error = message('当前浏览器账号已变化，本页营地已暂停，请重新登录或载入。', 'user_mismatch')) {
    this.generation++; this.stopTimer(); this.identityFrozen = true;
    this.phase = 'expired'; this.csrfToken = null; this.conflict = null;
    this.message = error.code === 'user_mismatch' ? '当前浏览器账号已变化，本页营地已暂停；原有本机进度已保留。' : '登录已过期，本页营地已暂停；原有本机进度已保留，请重新登录。';
    this.emit();
  }
  failure(error) {
    if (AUTH_ERRORS.has(error.code)) { this.freezeIdentity(error); return; }
    if (error.code === 'storage_unavailable' || error.code === 'invalid_save') {
      this.generation++; this.stopTimer(); this.identityFrozen = true; this.phase = 'error';
    }
    this.message = error.userMessage || '操作没有完成，请稍后重试。';
  }
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
      if (!response.ok) throw Object.assign(message(data?.message || '服务暂时不可用，请稍后重试。', data?.code || `http_${response.status}`), { revision:data?.revision, updatedAt:data?.updatedAt });
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
  checkedRemote(remote) {
    if (!Number.isSafeInteger(remote.revision) || remote.revision < 0) throw message('云存档版本异常，暂未同步。', 'invalid_save');
    return remote.save === null ? null : this.checkedSave(remote.save);
  }
  backup(id, text) { if (text) this.write(`fkssj-account-backup-v1:${id}`, { savedAt:this.now(), save:JSON.parse(text) }); }
  metadata(id = this.user?.id) { return this.json(metaKey(id)) || { revision:0, dirty:!!this.read(accountSaveKey(id)), serial:0, lastSyncedAt:null }; }
  saveMetadata(meta, id = this.user.id) { this.write(metaKey(id), meta); }
  setConflict(remote, user = this.user) {
    this.conflict = { userId:user.id, revision:Number.isSafeInteger(remote.revision) ? remote.revision : null, updatedAt:remote.updatedAt ?? null };
    this.phase = 'conflict'; this.message = '云端已有另一份进度，请选择要保留的营地。'; this.stopTimer();
  }
  async prepare() {
    const epoch = ++this.generation, hintText = this.read(ACTIVE_ACCOUNT_KEY), hint = identity(this.json(ACTIVE_ACCOUNT_KEY));
    this.phase = 'checking'; this.stopTimer();
    try {
      const auth = await this.request('/auth/me', {user:null,csrf:null});
      if (epoch !== this.generation) return;
      if (this.read(ACTIVE_ACCOUNT_KEY) !== hintText) { this.user = hint; this.freezeIdentity(); return; }
      if (!identity(auth.user)) {
        if (hint && this.read(accountSaveKey(hint.id))) {
          this.user = hint; this.freezeIdentity(message('', 'authentication_required'));
        } else { this.user = null; this.identityFrozen = false; this.phase = 'guest'; this.remove(ACTIVE_ACCOUNT_KEY); }
      } else {
        const user = identity(auth.user);
        this.user = user; this.csrfToken = auth.csrfToken; this.identityFrozen = false;
        this.needsRemote = !this.read(accountSaveKey(user.id));
        this.write(ACTIVE_ACCOUNT_KEY, user);
        const remote = await this.request('/save', {user});
        if (!this.current(epoch, user)) return;
        this.reconcile(remote, epoch, user); this.needsRemote = false;
      }
    } catch (error) {
      if (epoch !== this.generation) return;
      if (!this.user && hint && this.read(accountSaveKey(hint.id))) this.user = hint;
      if (AUTH_ERRORS.has(error.code) || ['storage_unavailable','invalid_save'].includes(error.code)) this.failure(error);
      else { this.phase = this.user ? 'offline' : 'guest'; this.message = error.userMessage; }
    }
    this.emit();
  }
  reconcile(remote, epoch = this.generation, user = this.user) {
    if (!this.current(epoch, user)) return;
    const cloud = this.checkedRemote(remote), id = user.id, key = accountSaveKey(id);
    const pendingGuest = this.read(importKey(id));
    if (!cloud && !this.read(key) && pendingGuest) {
      let save;
      try { save = JSON.parse(pendingGuest); } catch { throw message('待迁移营地无法读取，原副本已保留。', 'invalid_save'); }
      this.checkedSave(save); this.write(key, pendingGuest);
      this.saveMetadata({ revision:remote.revision, dirty:true, serial:1, lastSyncedAt:null }, id);
    }
    const local = this.read(key), meta = this.metadata(id);
    this.remove(importKey(id)); this.revision = remote.revision; this.lastSyncedAt = meta.lastSyncedAt;
    if (meta.dirty && local && meta.revision !== remote.revision && local !== cloud) { this.setConflict(remote, user); return; }
    if (meta.dirty && local && local !== cloud) {
      this.saveMetadata({ ...meta, revision:remote.revision }, id); this.phase = 'pending'; this.schedule(); return;
    }
    if (cloud) { if (local && local !== cloud) this.backup(id, local); this.write(key, cloud); }
    const syncedAt = cloud ? remote.updatedAt : null;
    this.saveMetadata({ revision:remote.revision, dirty:false, serial:meta.serial || 0, lastSyncedAt:syncedAt }, id);
    this.lastSyncedAt = syncedAt; this.conflict = null; this.phase = cloud ? 'synced' : 'pending'; this.message = '';
  }
  createStorage() {
    const owner = this.user?.id ?? null, key = owner ? accountSaveKey(owner) : GUEST_SAVE_KEY;
    const writable = () => {
      if (!this.ownsPage()) throw message('另一页正在使用营地，请刷新后继续。', 'page_locked');
      if (!this.checkHint() || !this.canPlay || owner !== (this.user?.id ?? null)) throw message('本页营地已暂停，原有本机进度未改动。', 'account_frozen');
    };
    return {
      getItem: () => this.read(key),
      setItem: (_key, text) => {
        writable();
        try {
          this.write(key, text);
          if (owner) {
            const meta = this.metadata(owner);
            this.saveMetadata({ ...meta, dirty:true, serial:(meta.serial || 0) + 1 }, owner);
            if (this.phase !== 'offline') this.phase = 'pending';
            this.emit(); this.schedule();
          }
        } catch (error) { this.failure(error); this.emit(); throw error; }
      },
      removeItem: () => { writable(); try { this.remove(key); } catch (error) { this.failure(error); this.emit(); throw error; } }
    };
  }
  schedule(delay = 1200) {
    if (!this.autoSync || this.timer || this.identityFrozen || this.transitioning || !this.user || BLOCKED.has(this.phase)) return;
    this.timer = setTimeout(() => { this.timer = null; this.syncNow().catch(() => {}); }, delay);
  }
  async syncNow() {
    if (this.phase === 'error') throw message(this.message, 'invalid_save');
    if (this.identityFrozen || this.phase === 'expired') throw message('请重新登录或载入后同步进度。', 'unauthorized');
    if (!this.checkHint()) throw message('当前浏览器账号已变化，本页营地已暂停。', 'user_mismatch');
    if (this.phase === 'conflict') throw message('请先选择要保留的进度。', 'save_conflict');
    if (this.inflight) return this.inflight;
    if (!this.user || this.transitioning || this.phase === 'checking') return;
    if (!this.ownsPage()) throw message('请回到正在游玩的标签页。', 'page_locked');
    const epoch = this.generation, user = this.user;
    const pending = this.upload(epoch, user).finally(() => { if (this.inflight === pending) this.inflight = null; });
    this.inflight = pending; return pending;
  }
  async upload(epoch, user) {
    let sentText = null, sentSerial = null;
    try {
      if (!this.current(epoch, user)) return;
      if (!this.csrfToken) {
        const auth = await this.request('/auth/me', {user});
        if (!this.current(epoch, user)) return;
        if (auth.user?.id !== user.id) throw message('登录状态已变化，请重新登录。', 'user_mismatch');
        if (!auth.csrfToken) throw message('登录响应异常，请重新登录。', 'network');
        this.csrfToken = auth.csrfToken;
      }
      if (this.needsRemote) {
        const remote = await this.request('/save', {user});
        if (!this.current(epoch, user)) return;
        this.reconcile(remote, epoch, user); this.needsRemote = false;
        this.leaving = true; this.transitioning = true; this.reload(); return;
      }
      const meta = this.metadata(user.id);
      if (!meta.dirty) { this.phase = 'synced'; this.emit(); return; }
      sentText = this.read(accountSaveKey(user.id)); sentSerial = meta.serial;
      if (!sentText) return;
      const save = JSON.parse(sentText); this.checkedSave(save);
      const result = await this.request('/save', { method:'PUT', body:{ expectedRevision:meta.revision, save }, user });
      if (!this.current(epoch, user)) return;
      this.acceptUpload(user.id, sentSerial, result, epoch);
    } catch (error) {
      if (!this.current(epoch, user)) return;
      if (error.code === 'save_conflict') {
        try {
          const remote = await this.request('/save', {user});
          if (!this.current(epoch, user)) return;
          const cloud = this.checkedRemote(remote);
          if (sentText && cloud === sentText) { this.acceptUpload(user.id, sentSerial, remote, epoch); return; }
          this.setConflict(remote, user);
        } catch (readError) {
          if (!this.current(epoch, user)) return;
          if (AUTH_ERRORS.has(readError.code) || ['invalid_save','storage_unavailable'].includes(readError.code)) { this.failure(readError); this.emit(); throw readError; }
          this.setConflict({revision:null,updatedAt:null}, user);
        }
      } else if (AUTH_ERRORS.has(error.code) || ['invalid_save','storage_unavailable'].includes(error.code)) this.failure(error);
      else { this.phase = 'offline'; this.message = error.userMessage || '暂时无法同步，本机进度已保留。'; this.schedule(15000); }
      this.emit(); throw error;
    }
  }
  acceptUpload(id, sentSerial, result, epoch = this.generation) {
    if (!this.current(epoch, {id})) return;
    if (!Number.isSafeInteger(result.revision) || result.revision < 1) throw message('云存档版本异常，暂未同步。', 'invalid_save');
    const current = this.metadata(id), dirty = current.serial !== sentSerial;
    this.saveMetadata({ ...current, revision:result.revision, dirty, lastSyncedAt:result.updatedAt }, id);
    this.revision = result.revision; this.lastSyncedAt = result.updatedAt;
    this.phase = dirty ? 'pending' : 'synced'; this.message = ''; this.conflict = null; this.emit(); if (dirty) this.schedule();
  }
  async transition(operation, saveBefore = true) {
    if (this.busy || !this.ownsPage()) throw message('请稍等当前操作完成。', 'busy');
    const token = Symbol('transition'); this.transitionToken = token; this.busy = true; this.emit();
    let epoch = this.generation;
    try {
      if (saveBefore && this.canPlay) this.beforeTransition();
      this.transitioning = true; this.stopTimer(); epoch = ++this.generation;
      if (this.inflight) await this.inflight.catch(() => {});
      if (epoch !== this.generation) return;
      await operation(epoch);
    } catch (error) {
      if (epoch === this.generation) this.failure(error);
      throw error;
    } finally {
      if (this.transitionToken === token) { this.busy = false; this.transitioning = !!this.leaving; this.emit(); this.schedule(); }
    }
  }
  register(username, password, options = {}) { return this.authenticate('register', username, password, options); }
  login(username, password, options = {}) { return this.authenticate('login', username, password, options); }
  async authenticate(kind, username, password, { importGuest = true } = {}) {
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) throw message('用户名需为 3–24 位字母、数字或下划线。', 'invalid_username');
    if (password.length < 8 || password.length > 128) throw message('密码需为 8–128 个字符。', 'invalid_password');
    await this.transition(async epoch => {
      let auth; const hintText = this.read(ACTIVE_ACCOUNT_KEY);
      try { auth = await this.request(`/auth/${kind}`, { method:'POST', body:{username,password} }); }
      catch (error) {
        if (epoch !== this.generation) return;
        if (error.code === 'network') { this.leaving = true; this.failure(message('登录结果暂时无法确认，本页已暂停，请重新载入后检查账号。', 'invalid_save')); }
        throw error;
      }
      if (epoch !== this.generation) return;
      if (this.read(ACTIVE_ACCOUNT_KEY) !== hintText) { this.freezeIdentity(); return; }
      // The server has changed its Cookie already. Freeze the old GameState before any fallible local write.
      this.leaving = true; this.transitioning = true;
      if (!identity(auth.user) || !auth.csrfToken) throw message('登录响应异常，本页已暂停，请重新载入。', 'invalid_save');
      const user = identity(auth.user);
      this.user = user; this.csrfToken = auth.csrfToken; this.conflict = null; this.identityFrozen = false; this.phase = 'checking';
      this.revision = 0; this.lastSyncedAt = null;
      this.needsRemote = !this.read(accountSaveKey(user.id));
      this.write(ACTIVE_ACCOUNT_KEY, user);
      if (!this.read(accountSaveKey(user.id)) && importGuest) {
        const guest = this.read(GUEST_SAVE_KEY);
        if (guest) { this.checkedSave(JSON.parse(guest)); this.write(importKey(user.id), guest); }
      }
      try {
        const remote = await this.request('/save', {user});
        if (!this.current(epoch, user)) return;
        this.reconcile(remote, epoch, user); this.needsRemote = false;
      } catch (error) {
        if (!this.current(epoch, user)) return;
        if (AUTH_ERRORS.has(error.code) || ['invalid_save','storage_unavailable'].includes(error.code)) throw error;
        this.phase = 'offline'; this.message = error.userMessage;
      }
      this.reload();
    });
  }
  async logout() {
    if (this.canPlay) this.beforeTransition();
    if (!this.identityFrozen && !BLOCKED.has(this.phase)) await this.syncNow().catch(() => {});
    await this.transition(async epoch => {
      const hintText = this.read(ACTIVE_ACCOUNT_KEY);
      const stillCurrent = () => {
        if (epoch !== this.generation) return false;
        if (this.read(ACTIVE_ACCOUNT_KEY) !== hintText) { this.freezeIdentity(); return false; }
        return true;
      };
      let auth;
      try { auth = await this.request('/auth/me', {user:null,csrf:null}); }
      catch (error) { if (!stillCurrent()) return; throw error; }
      if (!stillCurrent()) return;
      try { await this.request('/auth/logout', { method:'POST', body:{}, user:auth.user, csrf:auth.csrfToken }); }
      catch (error) {
        if (!stillCurrent()) return;
        if (error.code === 'network') {
          this.leaving = true;
          this.failure(message('退出结果暂时无法确认，本页已暂停；本机营地已保留，请重新载入后检查账号。', 'invalid_save'));
        }
        throw error;
      }
      if (!stillCurrent()) return;
      this.leaving = true; this.remove(ACTIVE_ACCOUNT_KEY); this.csrfToken = null;
      this.user = null; this.phase = 'guest'; this.conflict = null; this.identityFrozen = false; this.reload();
    }, false);
  }
  async resolveConflict(choice, expected = this.conflict && {...this.conflict}) {
    if (!['cloud','local'].includes(choice)) throw new Error('Unknown save choice');
    if (!this.user || this.phase !== 'conflict' || this.identityFrozen) throw message('请先重新检查营地冲突。', 'save_conflict');
    const user = this.user, review = expected && {...expected}, key = accountSaveKey(user.id);
    if (!review || review.userId !== user.id || review.revision !== this.conflict?.revision) throw message('营地冲突已变化，请重新查看后选择。', 'conflict_changed');
    // Never invoke the old GameState save callback while resolving a frozen conflict candidate.
    await this.transition(async epoch => {
      const remote = await this.request('/save', {user});
      if (!this.current(epoch, user)) return;
      const cloud = this.checkedRemote(remote);
      if (remote.revision !== review.revision) {
        this.setConflict(remote, user); throw message('云端营地刚有更新，请重新查看后选择。', 'conflict_changed');
      }
      const local = this.read(key); this.backup(user.id, local);
      if (choice === 'cloud') {
        if (!cloud) throw message('云端还没有进度，请保留本机营地。', 'empty_cloud');
        this.write(key, cloud);
        this.saveMetadata({ revision:remote.revision, dirty:false, serial:0, lastSyncedAt:remote.updatedAt }, user.id);
      } else {
        if (!local) throw message('本机没有可上传的进度。', 'empty_local');
        const save = JSON.parse(local); this.checkedSave(save);
        const serial = this.metadata(user.id).serial;
        try {
          const result = await this.request('/save', { method:'PUT', body:{expectedRevision:review.revision,save}, user });
          if (!this.current(epoch, user)) return;
          this.acceptUpload(user.id, serial, result, epoch);
        } catch (error) {
          if (!this.current(epoch, user)) return;
          if (error.code === 'save_conflict') {
            this.setConflict({revision:error.revision,updatedAt:error.updatedAt}, user);
            throw message('云端营地刚有更新，请重新查看后选择。', 'conflict_changed');
          }
          throw error;
        }
      }
      this.leaving = true; this.reload();
    }, false);
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AccountManager, ACTIVE_ACCOUNT_KEY, GUEST_SAVE_KEY, accountSaveKey } from './account-manager.js';
import { GameState } from './game-state.js';

// These tests use real HTTP requests to Python's WSGI API and temporary private
// databases. The explicit jar sends Secure cookies manually; it does not test a
// browser's cookie policy, real tabs, independent contexts, or physical offline.
const publicOrigin = 'http://localhost:4174';
const password = 'fkssj-http-test-password';
const projectRoot = dirname(fileURLToPath(import.meta.url));
const metaKey = id => `fkssj-account-meta-v1:${id}`;
const seed = wood => {
  const save = structuredClone(new GameState({ storage:null, autoLoad:false }).state);
  save.resources.wood = wood;
  save.savedAt = 1_800_000_000_000 + wood;
  return save;
};

async function withHttpApi(run) {
  const directory = await mkdtemp(join(tmpdir(), 'fkssj-http-'));
  const code = `import sys
from wsgiref.simple_server import make_server, WSGIRequestHandler
from api.app import create_app
class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass
server = make_server('127.0.0.1', 0, create_app(sys.argv[1], sys.argv[2]), handler_class=QuietHandler)
print(server.server_port, flush=True)
server.serve_forever()
`;
  const child = spawn('python3', ['-u', '-c', code, directory, publicOrigin], {
    cwd:projectRoot,
    env:{ ...process.env, PYTHONDONTWRITEBYTECODE:'1' },
    stdio:['ignore', 'pipe', 'pipe']
  });
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  const lines = createInterface({ input:child.stdout });
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`HTTP test API did not start: ${errors}`)), 10_000);
      const failed = error => { clearTimeout(timeout); reject(error); };
      child.once('error', failed);
      child.once('exit', code => failed(new Error(`HTTP test API exited ${code}: ${errors}`)));
      lines.once('line', line => {
        clearTimeout(timeout);
        if (!/^\d+$/.test(line)) reject(new Error(`Unexpected API startup response: ${line}`));
        else resolve(Number(line));
      });
    });
    await run(`http://127.0.0.1:${port}`);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timeout); }
    }
    await rm(directory, { recursive:true, force:true });
  }
}

async function withNodeProxy(apiBase, run) {
  // Load the unchanged development server. Only report its actual ephemeral
  // listening port; no proxy routing or request/response behavior is replaced.
  const code = `import http from 'node:http';
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once('listening', () => console.log('FKSSJ_TEST_PORT ' + this.address().port));
  return listen.apply(this, args);
};
await import('./server.mjs');
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd:projectRoot,
    env:{ ...process.env, PORT:'0', API_PORT:new URL(apiBase).port },
    stdio:['ignore', 'pipe', 'pipe']
  });
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  const lines = createInterface({ input:child.stdout });
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Node test proxy did not start: ${errors}`)), 10_000);
      const failed = error => { clearTimeout(timeout); reject(error); };
      child.once('error', failed);
      child.once('exit', code => failed(new Error(`Node test proxy exited ${code}: ${errors}`)));
      lines.on('line', line => {
        const match = /^FKSSJ_TEST_PORT (\d+)$/.exec(line);
        if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
      });
    });
    await run(`http://127.0.0.1:${port}`);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timeout); }
    }
  }
}

class CookieJar {
  constructor(base, cookie = '') { this.base = base; this.cookie = cookie; this.requests = []; }
  async fetch(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('Origin', publicOrigin);
    if (this.cookie) headers.set('Cookie', this.cookie);
    this.requests.push({ path, method:options.method || 'GET', user:headers.get('X-FKSSJ-User') });
    const response = await fetch(this.base + path, { ...options, headers });
    for (const header of response.headers.getSetCookie()) {
      if (!header.startsWith('__Host-fkssj_session=')) continue;
      // Attribute assertions leave production cookie behavior unchanged. This
      // HTTP harness deliberately carries the returned token itself.
      assert.match(header, /;\s*Secure(?:;|$)/i);
      assert.match(header, /;\s*HttpOnly(?:;|$)/i);
      assert.match(header, /;\s*SameSite=Lax(?:;|$)/i);
      assert.match(header, /;\s*Path=\/(?:;|$)/i);
      this.cookie = header.split(';', 1)[0];
    }
    return response;
  }
  async request(path, { method = 'GET', body, user, csrf } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (user !== undefined) headers['X-FKSSJ-User'] = String(user);
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const response = await this.fetch(path, {
      method, headers, ...(body === undefined ? {} : { body:JSON.stringify(body) })
    });
    return { status:response.status, data:await response.json(), headers:response.headers };
  }
}

async function registered(base, username) {
  const jar = new CookieJar(base);
  const result = await jar.request('/api/auth/register', { method:'POST', body:{ username, password } });
  assert.equal(result.status, 200);
  return { jar, user:result.data.user, csrf:result.data.csrfToken };
}
async function put(account, save, revision = 0) {
  const response = await account.jar.request('/api/save', {
    method:'PUT', body:{ expectedRevision:revision, save }, user:account.user.id, csrf:account.csrf
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
async function get(account) {
  const response = await account.jar.request('/api/save', { user:account.user.id });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
function makeManager(jar, storage = new Map()) {
  const adapter = {
    getItem:key => storage.get(key) ?? null,
    setItem:(key, value) => storage.set(key, String(value)),
    removeItem:key => storage.delete(key)
  };
  const manager = new AccountManager({
    storage:adapter, fetcher:jar.fetch.bind(jar), autoSync:false, reload:() => {},
    validate:save => {
      assert.ok(new GameState({ storage:null, autoLoad:false })._normalizeSave(save));
    }
  });
  return { manager, storage, adapter };
}
function noSaveDisclosure(response) {
  assert.equal(response.status, 403);
  assert.equal(response.data.code, 'user_mismatch');
  for (const key of ['save', 'revision', 'updatedAt']) assert.equal(Object.hasOwn(response.data, key), false);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
}

test('HTTP GET binds B cookie to the identity header without leaking or changing A/B saves', async () => {
  await withHttpApi(async base => {
    const a = await registered(base, 'http_a'), b = await registered(base, 'http_b');
    const saveA = seed(101), saveB = seed(202);
    await put(a, saveA); await put(b, saveB);
    const beforeA = await get(a), beforeB = await get(b);
    assert.deepEqual(beforeA.save, saveA);
    assert.deepEqual(beforeB.save, saveB);
    assert.equal(beforeA.revision, 1); assert.equal(beforeB.revision, 1);
    noSaveDisclosure(await b.jar.request('/api/save', { user:a.user.id }));
    assert.deepEqual(await get(b), beforeB);
    assert.deepEqual(await get(a), beforeA);
    assert.deepEqual(await get(b), beforeB);
  });
});

test('HTTP GET with an authenticated cookie but no identity header is rejected without a save', async () => {
  await withHttpApi(async base => {
    const account = await registered(base, 'http_missing_header');
    await put(account, seed(303));
    const before = await get(account);
    noSaveDisclosure(await account.jar.request('/api/save'));
    assert.deepEqual(await get(account), before);
  });
});

test('Node proxy HTTP preserves cookie and identity-header binding for rejected and normal GETs', async () => {
  await withHttpApi(apiBase => withNodeProxy(apiBase, async proxyBase => {
    const a = await registered(proxyBase, 'proxy_http_a'), b = await registered(proxyBase, 'proxy_http_b');
    const saveA = seed(151), saveB = seed(252);
    await put(a, saveA); await put(b, saveB);
    const beforeA = await get(a), beforeB = await get(b);
    assert.deepEqual(beforeA.save, saveA);
    assert.deepEqual(beforeB.save, saveB);
    noSaveDisclosure(await b.jar.request('/api/save', { user:a.user.id }));
    noSaveDisclosure(await b.jar.request('/api/save'));
    assert.deepEqual(await get(b), beforeB);
    assert.deepEqual(await get(a), beforeA);
  }));
});

test('HTTP pending A GET after an explicit shared-cookie switch freezes local writes and uploads', async () => {
  await withHttpApi(async base => {
    const a = await registered(base, 'http_stale_a'), b = await registered(base, 'http_stale_b');
    await put(a, seed(110)); await put(b, seed(220));
    const shared = new CookieJar(base, a.jar.cookie);
    const { manager, storage } = makeManager(shared);
    await manager.prepare();
    const bound = manager.createStorage();
    bound.setItem('', JSON.stringify(seed(111)));
    const local = storage.get(accountSaveKey(a.user.id)), metadata = storage.get(metaKey(a.user.id));
    const beforeA = await get(a), beforeB = await get(b);
    // This explicitly models a changed shared cookie jar. It is not a real
    // second tab, an independent browser context, or a browser-policy test.
    shared.cookie = b.jar.cookie;
    manager.needsRemote = true;
    await assert.rejects(manager.syncNow(), error => error.code === 'user_mismatch');
    assert.equal(manager.canPlay, false);
    assert.throws(() => bound.setItem('', JSON.stringify(seed(999))), { code:'account_frozen' });
    assert.throws(() => bound.removeItem(''), { code:'account_frozen' });
    assert.equal(storage.get(accountSaveKey(a.user.id)), local);
    assert.equal(storage.get(metaKey(a.user.id)), metadata);
    assert.equal(storage.has(accountSaveKey(b.user.id)), false);
    assert.equal(JSON.parse(storage.get(ACTIVE_ACCOUNT_KEY)).id, a.user.id);
    const requests = shared.requests.length;
    await assert.rejects(manager.syncNow());
    assert.equal(shared.requests.length, requests, 'a frozen manager must not retry an upload');
    assert.deepEqual(await get(a), beforeA);
    assert.deepEqual(await get(b), beforeB);
  });
});

test('HTTP guest registration migrates only to an empty account and keeps the guest copy', async () => {
  await withHttpApi(async base => {
    const jar = new CookieJar(base), first = makeManager(jar);
    await first.manager.prepare();
    const guest = JSON.stringify(seed(73));
    first.manager.createStorage().setItem('', guest);
    await first.manager.register('http_guest_import', password);
    const next = makeManager(jar, first.storage);
    await next.manager.prepare();
    const user = next.manager.user;
    assert.equal(next.storage.get(GUEST_SAVE_KEY), guest);
    assert.equal(next.storage.get(accountSaveKey(user.id)), guest);
    await next.manager.syncNow();
    const cloud = await jar.request('/api/save', { user:user.id });
    assert.equal(cloud.status, 200);
    assert.deepEqual(cloud.data.save, JSON.parse(guest));
    assert.equal(next.storage.get(GUEST_SAVE_KEY), guest);
  });
});

test('HTTP successful B login followed by injected local quota failure freezes the old A page', async () => {
  await withHttpApi(async base => {
    const a = await registered(base, 'http_quota_a'), b = await registered(base, 'http_quota_b');
    await put(a, seed(510)); await put(b, seed(620));
    const beforeA = await get(a), beforeB = await get(b);
    const shared = new CookieJar(base, a.jar.cookie), { manager, storage, adapter } = makeManager(shared);
    await manager.prepare();
    const bound = manager.createStorage();
    bound.setItem('', JSON.stringify(seed(511)));
    const local = storage.get(accountSaveKey(a.user.id)), metadata = storage.get(metaKey(a.user.id));
    const active = storage.get(ACTIVE_ACCOUNT_KEY), write = adapter.setItem;
    // The API login and cookie replacement are real HTTP. Only this subsequent
    // localStorage failure is injected; this does not measure browser quota.
    adapter.setItem = (key, value) => {
      if (key === ACTIVE_ACCOUNT_KEY) throw Object.assign(new Error('injected storage quota'), { name:'QuotaExceededError' });
      return write(key, value);
    };
    await manager.login('http_quota_b', password, { importGuest:false }).catch(() => {});
    const auth = await shared.request('/api/auth/me');
    assert.equal(auth.status, 200);
    assert.equal(auth.data.user.id, b.user.id, 'the server really completed B authentication');
    assert.equal(manager.canPlay, false);
    assert.throws(() => bound.setItem('', JSON.stringify(seed(999))), { code:'account_frozen' });
    assert.equal(storage.get(accountSaveKey(a.user.id)), local);
    assert.equal(storage.get(metaKey(a.user.id)), metadata);
    assert.equal(storage.get(ACTIVE_ACCOUNT_KEY), active);
    const requests = shared.requests.length;
    await assert.rejects(manager.syncNow());
    assert.equal(shared.requests.length, requests);
    assert.equal(shared.requests.filter(request => request.method === 'PUT').length, 0);
    assert.deepEqual(await get(b), beforeB);
    // Logging B in on the shared jar revoked its previous A session. Verify A
    // with a newly authenticated independent HTTP jar, not a stale A cookie.
    const verify = new CookieJar(base);
    const login = await verify.request('/api/auth/login', { method:'POST', body:{ username:'http_quota_a', password } });
    assert.equal(login.status, 200);
    assert.deepEqual(await get({ jar:verify, user:login.data.user }), beforeA);
  });
});

for (const choice of ['cloud', 'local']) {
  test(`HTTP conflict choosing ${choice} preserves a recovery copy and uses the latest revision`, async () => {
    await withHttpApi(async base => {
      const account = await registered(base, `http_conflict_${choice}`);
      await put(account, seed(41));
      const jar = new CookieJar(base, account.jar.cookie), { manager, storage } = makeManager(jar);
      await manager.prepare();
      const local = seed(73), newerCloud = seed(99);
      manager.createStorage().setItem('', JSON.stringify(local));
      await put(account, newerCloud, 1);
      await assert.rejects(manager.syncNow(), error => error.code === 'save_conflict');
      assert.equal(manager.canPlay, false);
      assert.equal(storage.get(accountSaveKey(account.user.id)), JSON.stringify(local));
      const before = await get(account);
      await manager.resolveConflict(choice);
      const after = await get(account);
      assert.deepEqual(JSON.parse(storage.get(`fkssj-account-backup-v1:${account.user.id}`)).save, local);
      if (choice === 'cloud') {
        assert.deepEqual(after, before);
        assert.deepEqual(JSON.parse(storage.get(accountSaveKey(account.user.id))), newerCloud);
      } else {
        assert.equal(after.revision, before.revision + 1);
        assert.deepEqual(after.save, local);
      }
    });
  });
}

test('HTTP conflict recovery freezes A when its follow-up GET observes a changed explicit cookie jar', async () => {
  await withHttpApi(async base => {
    const a = await registered(base, 'http_race_a'), b = await registered(base, 'http_race_b');
    await put(a, seed(310)); await put(b, seed(420));
    const shared = new CookieJar(base, a.jar.cookie), { manager, storage } = makeManager(shared);
    await manager.prepare();
    const bound = manager.createStorage();
    bound.setItem('', JSON.stringify(seed(311)));
    await put(a, seed(312), 1);
    const local = storage.get(accountSaveKey(a.user.id)), metadata = storage.get(metaKey(a.user.id));
    const beforeA = await get(a), beforeB = await get(b);
    const fetcher = manager.fetcher;
    // Timing injection: change the explicit jar after a real 409 response,
    // before AccountManager issues its real follow-up GET. No browser is used.
    manager.fetcher = async (path, options) => {
      const response = await fetcher(path, options);
      if (path === '/api/save' && options.method === 'PUT' && response.status === 409) shared.cookie = b.jar.cookie;
      return response;
    };
    await assert.rejects(manager.syncNow());
    assert.equal(manager.canPlay, false);
    assert.throws(() => bound.setItem('', JSON.stringify(seed(999))), { code:'account_frozen' });
    assert.equal(storage.get(accountSaveKey(a.user.id)), local);
    assert.equal(storage.get(metaKey(a.user.id)), metadata);
    const requests = shared.requests.length;
    await assert.rejects(manager.syncNow());
    assert.equal(shared.requests.length, requests);
    assert.deepEqual(await get(a), beforeA);
    assert.deepEqual(await get(b), beforeB);
  });
});

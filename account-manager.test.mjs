import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, GUEST_SAVE_KEY, ACTIVE_ACCOUNT_KEY, accountSaveKey } from './account-manager.js';
import { GameState } from './game-state.js';

const user = { id:1, username:'captain' };
const seed = () => JSON.parse(JSON.stringify(new GameState({storage:null,autoLoad:false}).state));
const metaKey = id => `fkssj-account-meta-v1:${id}`;
function setup({logged = true, remote = null, revision = 0} = {}) {
  const data = new Map(), requests = [];
  let account = logged ? user : null, cloud = remote, rev = revision, fail = false, hook;
  const storage = {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)};
  const fetcher = async (path, options) => {
    requests.push({path,options});
    if (fail) throw new Error('offline');
    const body = options.body && JSON.parse(options.body);
    let payload, status = 200;
    if (path.endsWith('/auth/me')) payload={user:account,csrfToken:account?'csrf':undefined};
    else if (path.endsWith('/auth/register') || path.endsWith('/auth/login')) {account=user;payload={user,csrfToken:'csrf'};}
    else if (path.endsWith('/auth/logout')) {account=null;payload={ok:true};}
    else if (path.endsWith('/save') && options.method === 'PUT') {
      if (body.expectedRevision !== rev) { status=409;payload={code:'save_conflict',message:'conflict'}; }
      else {cloud=body.save;rev++;payload={revision:rev,updatedAt:5000};if(hook)await hook();}
    } else payload={revision:rev,save:cloud,updatedAt:cloud?5000:null};
    return {ok:status===200,status,json:async()=>payload};
  };
  let reloads=0;
  const manager=new AccountManager({storage,fetcher,autoSync:false,reload:()=>reloads++,validate:raw=>{if(!new GameState({storage:null,autoLoad:false})._normalizeSave(raw))throw Error('bad');}});
  return {manager,storage,data,requests,get cloud(){return cloud;},get rev(){return rev;},get reloads(){return reloads;},offline:v=>fail=v,remote:(save,revision)=>{cloud=save;rev=revision;},hook:f=>hook=f,logout:()=>account=null};
}
test('anonymous guest storage retains the original key and sends no save', async()=>{
  const t=setup({logged:false});await t.manager.prepare();
  const value=JSON.stringify(seed());t.manager.createStorage().setItem('',value);
  assert.equal(t.storage.getItem(GUEST_SAVE_KEY),value);assert.equal(t.manager.phase,'guest');
  await t.manager.syncNow();assert.equal(t.requests.length,1);
});
test('registration imports guest only to an empty account; old page cannot overwrite cloud cache', async()=>{
  const t=setup({logged:false});await t.manager.prepare();
  const bound=t.manager.createStorage(), value=seed();value.resources.wood=73;
  bound.setItem('',JSON.stringify(value));await t.manager.register('captain','longpassword');
  assert.equal(JSON.parse(t.storage.getItem(accountSaveKey(1))).resources.wood,73);
  bound.setItem('',JSON.stringify(seed()));
  assert.equal(JSON.parse(t.storage.getItem(GUEST_SAVE_KEY)).resources.wood,73);
  assert.equal(t.reloads,1);assert.equal(t.manager.transitioning,true);
});
test('login uses an existing cloud camp and preserves the local guest camp',async()=>{
  const cloud=seed();cloud.resources.wood=81;const t=setup({logged:false,remote:cloud,revision:4});await t.manager.prepare();
  const guest=seed();guest.resources.wood=19;t.storage.setItem(GUEST_SAVE_KEY,JSON.stringify(guest));
  await t.manager.login('captain','longpassword');
  assert.equal(JSON.parse(t.storage.getItem(accountSaveKey(1))).resources.wood,81);
  assert.equal(JSON.parse(t.storage.getItem(GUEST_SAVE_KEY)).resources.wood,19);
});
test('registration can start a fresh account without importing guest',async()=>{
  const t=setup({logged:false});await t.manager.prepare();t.storage.setItem(GUEST_SAVE_KEY,JSON.stringify(seed()));
  await t.manager.register('captain','longpassword',{importGuest:false});
  assert.equal(t.storage.getItem(accountSaveKey(1)),null);
});
test('PUT carries captured identity, CSRF and CAS; subsequent local writes stay dirty',async()=>{
  const t=setup();await t.manager.prepare();const bound=t.manager.createStorage();
  bound.setItem('',JSON.stringify(seed()));
  t.hook(()=>{const next=seed();next.resources.wood=31;bound.setItem('',JSON.stringify(next));});
  await t.manager.syncNow();
  const put=t.requests.find(x=>x.options.method==='PUT');
  assert.equal(put.options.headers['X-FKSSJ-User'],'1');assert.equal(put.options.headers['X-CSRF-Token'],'csrf');
  assert.equal(t.manager.phase,'pending');assert.equal(JSON.parse(t.storage.getItem(metaKey(1))).revision,1);
  t.hook(null);await t.manager.syncNow();assert.equal(t.cloud.resources.wood,31);assert.equal(t.manager.phase,'synced');
});
test('offline writes remain local and retry successfully',async()=>{
  const t=setup();await t.manager.prepare();const value=seed();value.resources.fish=12;t.manager.createStorage().setItem('',JSON.stringify(value));
  t.offline(true);await assert.rejects(t.manager.syncNow());assert.equal(t.manager.phase,'offline');
  assert.equal(JSON.parse(t.storage.getItem(accountSaveKey(1))).resources.fish,12);
  t.offline(false);await t.manager.syncNow();assert.equal(t.cloud.resources.fish,12);
});
test('expired login restores account cache rather than starting or copying a guest camp',async()=>{
  const t=setup({logged:false});t.storage.setItem(ACTIVE_ACCOUNT_KEY,JSON.stringify(user));t.storage.setItem(accountSaveKey(1),JSON.stringify(seed()));
  await t.manager.prepare();assert.equal(t.manager.phase,'expired');assert.equal(t.manager.user.id,1);
  assert.equal(t.storage.getItem(GUEST_SAVE_KEY),null);await assert.rejects(t.manager.syncNow());
});
test('startup detects dirty cache versus newer cloud without overwriting either',async()=>{
  const cloud=seed();cloud.resources.wood=99;const t=setup({remote:cloud,revision:5});
  const local=seed();local.resources.wood=40;
  t.storage.setItem(accountSaveKey(1),JSON.stringify(local));t.storage.setItem(metaKey(1),JSON.stringify({revision:4,dirty:true,serial:1}));
  await t.manager.prepare();assert.equal(t.manager.phase,'conflict');assert.equal(t.manager.canPlay,false);
  assert.equal(JSON.parse(t.storage.getItem(accountSaveKey(1))).resources.wood,40);assert.equal(t.cloud.resources.wood,99);
});
test('cloud resolution makes a local recovery copy and keeps the cloud revision',async()=>{
  const cloud=seed();cloud.resources.coin=100;const t=setup({remote:cloud,revision:3});
  const local=seed();local.resources.coin=32;t.storage.setItem(accountSaveKey(1),JSON.stringify(local));t.storage.setItem(metaKey(1),JSON.stringify({revision:2,dirty:true,serial:1}));
  await t.manager.prepare();await t.manager.resolveConflict('cloud');
  assert.equal(JSON.parse(t.storage.getItem(accountSaveKey(1))).resources.coin,100);
  assert.equal(JSON.parse(t.storage.getItem('fkssj-account-backup-v1:1')).save.resources.coin,32);
  assert.equal(JSON.parse(t.storage.getItem(metaKey(1))).revision,3);
});
test('local resolution uses the freshly read cloud revision',async()=>{
  const t=setup({remote:seed(),revision:3});const local=seed();local.resources.fish=99;
  t.storage.setItem(accountSaveKey(1),JSON.stringify(local));t.storage.setItem(metaKey(1),JSON.stringify({revision:2,dirty:true,serial:1}));
  await t.manager.prepare();t.remote(seed(),4);await t.manager.resolveConflict('local');
  assert.equal(t.rev,5);assert.equal(t.cloud.resources.fish,99);
});
test('lost PUT response is reconciled only when the committed snapshot is identical',async()=>{
  const t=setup();await t.manager.prepare();const value=seed();t.manager.createStorage().setItem('',JSON.stringify(value));
  t.hook(()=>{throw new Error('lost response');});await assert.rejects(t.manager.syncNow());assert.equal(t.rev,1);
  t.hook(null);await t.manager.syncNow();assert.equal(t.manager.phase,'synced');assert.equal(t.rev,1);
});
test('incompatible cloud remains untouched and syncing is blocked',async()=>{
  const t=setup({remote:{version:999},revision:9});await t.manager.prepare();assert.equal(t.manager.phase,'error');
  assert.equal(t.storage.getItem(accountSaveKey(1)),null);await assert.rejects(t.manager.syncNow());
  assert.deepEqual(t.cloud,{version:999});
});
test('logout retains separate account and guest caches, including offline pending data',async()=>{
  const t=setup();await t.manager.prepare();t.manager.createStorage().setItem('',JSON.stringify(seed()));t.storage.setItem(GUEST_SAVE_KEY,'guest');
  await t.manager.logout();assert.equal(t.manager.user,null);assert.equal(t.storage.getItem(GUEST_SAVE_KEY),'guest');
  assert.ok(t.storage.getItem(accountSaveKey(1)));assert.equal(t.storage.getItem(ACTIVE_ACCOUNT_KEY),null);
});
test('failed logout does not pretend the session ended',async()=>{
  const t=setup();await t.manager.prepare();t.offline(true);
  await assert.rejects(t.manager.logout());assert.equal(t.manager.user.id,1);assert.ok(t.storage.getItem(ACTIVE_ACCOUNT_KEY));
});
test('an unreachable first cloud load blocks a fresh camp from overwriting unseen progress',async()=>{
  const cloud=seed();cloud.resources.wood=127;const t=setup({remote:cloud,revision:6});
  const fetcher=t.manager.fetcher;let fail=true;
  t.manager.fetcher=(path,options)=>path==='/api/save'&&fail?Promise.reject(Error('offline')):fetcher(path,options);
  await t.manager.prepare();assert.equal(t.manager.needsRemote,true);assert.equal(t.manager.canPlay,false);
  t.manager.createStorage().setItem('',JSON.stringify(seed()));
  assert.equal(t.storage.getItem(accountSaveKey(1)),null);
  fail=false;await t.manager.syncNow();
  assert.equal(JSON.parse(t.storage.getItem(accountSaveKey(1))).resources.wood,127);assert.equal(t.rev,6);
});
test('registration interrupted after authentication retains guest migration intent on reload',async()=>{
  const t=setup({logged:false});await t.manager.prepare();const guest=seed();guest.resources.wood=76;t.storage.setItem(GUEST_SAVE_KEY,JSON.stringify(guest));
  const fetcher=t.manager.fetcher;let fail=true;
  t.manager.fetcher=(path,options)=>path==='/api/save'&&fail?Promise.reject(Error('offline')):fetcher(path,options);
  await t.manager.register('captain','longpassword');assert.equal(t.reloads,1);
  fail=false;
  const next=new AccountManager({storage:t.storage,fetcher,autoSync:false,reload:()=>{}});
  await next.prepare();
  assert.equal(JSON.parse(t.storage.getItem(accountSaveKey(1))).resources.wood,76);
  await next.syncNow();assert.equal(t.cloud.resources.wood,76);
});
test('logout saves once before flushing, without creating a new unsynced snapshot afterwards',async()=>{
  const t=setup();await t.manager.prepare();const bound=t.manager.createStorage();let calls=0;
  t.manager.beforeTransition=()=>{calls++;bound.setItem('',JSON.stringify(seed()));};
  await t.manager.logout();assert.equal(calls,1);assert.equal(JSON.parse(t.storage.getItem(metaKey(1))).dirty,false);
});

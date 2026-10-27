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
  assert.throws(()=>bound.setItem('',JSON.stringify(seed())),{code:'account_frozen'});
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
test('local resolution asks for another choice when the displayed cloud revision changed',async()=>{
  const t=setup({remote:seed(),revision:3});const local=seed();local.resources.fish=99;
  t.storage.setItem(accountSaveKey(1),JSON.stringify(local));t.storage.setItem(metaKey(1),JSON.stringify({revision:2,dirty:true,serial:1}));
  await t.manager.prepare();t.remote(seed(),4);
  await assert.rejects(t.manager.resolveConflict('local'),{code:'conflict_changed'});
  assert.equal(t.rev,4);assert.equal(t.manager.conflict.revision,4);
  await t.manager.resolveConflict('local');
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
  assert.throws(()=>t.manager.createStorage().setItem('',JSON.stringify(seed())),{code:'account_frozen'});
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

// These are storage and deferred-response models, not real browser tabs/offline tests.
const response = (value,status=200) => ({ok:status>=200&&status<300,status,json:async()=>value});
const deferred = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
function holdResponse(t,predicate) {
  const entered=deferred(),finished=deferred(),seen=[],base=t.manager.fetcher;
  t.manager.fetcher=(path,options)=>{seen.push({path,options});if(predicate(path,options)){entered.resolve();return finished.promise;}return base(path,options);};
  return {entered:entered.promise,resolve:finished.resolve,reject:finished.reject,seen};
}
const cache = (t,id=1) => [t.storage.getItem(accountSaveKey(id)),t.storage.getItem(metaKey(id))];
function liveGame(t) {
  const bound=t.manager.createStorage(), game=new GameState({storage:bound});
  assert.equal(game.save().ok,true);return {game,bound};
}
for (const code of ['user_mismatch','authentication_required','csrf_invalid']) {
  test(`${code} freezes a real GameState, its captured storage and further uploads`,async()=>{
    const t=setup();await t.manager.prepare();const {game,bound}=liveGame(t),before=cache(t);
    const base=t.manager.fetcher;let calls=0;
    t.manager.fetcher=(path,options)=>{calls++;return path==='/api/save'?response({code,message:'identity changed'},code==='authentication_required'?401:403):base(path,options);};
    t.manager.needsRemote=true;await assert.rejects(t.manager.syncNow(),{code});
    assert.equal(t.manager.canPlay,false);assert.equal(t.manager.snapshot().identityFrozen,true);
    game.state.resources.wood+=123;assert.equal(game.save().ok,false);
    assert.throws(()=>bound.removeItem(''),{code:'account_frozen'});assert.deepEqual(cache(t),before);
    const count=calls;await assert.rejects(t.manager.syncNow());assert.equal(calls,count);
  });
}
test('two managers sharing storage freeze the old account when the active hint changes',async()=>{
  const t=setup();await t.manager.prepare();const {game,bound}=liveGame(t),before=cache(t),b={id:2,username:'other'};
  const other=new AccountManager({storage:t.storage,autoSync:false,reload:()=>{},fetcher:async path=>response(path.endsWith('/auth/me')?{user:b,csrfToken:'b-token'}:{revision:1,save:seed(),updatedAt:6000})});
  await other.prepare();assert.equal(other.canPlay,true);assert.equal(t.manager.canPlay,false);
  game.state.resources.wood=999;assert.equal(game.save().ok,false);
  assert.throws(()=>bound.removeItem(''),{code:'account_frozen'});assert.deepEqual(cache(t),before);
  const count=t.requests.length;await assert.rejects(t.manager.syncNow());assert.equal(t.requests.length,count);
  assert.equal(JSON.parse(t.storage.getItem(ACTIVE_ACCOUNT_KEY)).id,2);
});
test('a guest GameState cannot write after another manager selects an account',async()=>{
  const t=setup({logged:false});await t.manager.prepare();const {game,bound}=liveGame(t),before=t.storage.getItem(GUEST_SAVE_KEY);
  t.storage.setItem(ACTIVE_ACCOUNT_KEY,JSON.stringify({id:2,username:'other'}));
  assert.equal(t.manager.canPlay,false);assert.equal(game.save().ok,false);
  assert.throws(()=>bound.removeItem(''),{code:'account_frozen'});assert.equal(t.storage.getItem(GUEST_SAVE_KEY),before);
});
test('a late startup auth response cannot replace a newer shared account hint',async()=>{
  const t=setup();const gate=holdResponse(t,path=>path==='/api/auth/me'),work=t.manager.prepare();await gate.entered;
  const b={id:2,username:'other'};t.storage.setItem(ACTIVE_ACCOUNT_KEY,JSON.stringify(b));
  gate.resolve(response({user,csrfToken:'old-csrf'}));await work;
  assert.equal(t.manager.canPlay,false);assert.equal(t.manager.csrfToken,null);
  assert.deepEqual(JSON.parse(t.storage.getItem(ACTIVE_ACCOUNT_KEY)),b);
  assert.equal(gate.seen.filter(x=>x.path==='/api/save').length,0);
});
for (const outcome of ['success','rejection']) {
  test(`late startup save ${outcome} cannot change a frozen account cache or phase`,async()=>{
    const t=setup();await t.manager.prepare();liveGame(t);const before=cache(t),gate=holdResponse(t,path=>path==='/api/save');
    const work=t.manager.prepare();await gate.entered;t.manager.freezeIdentity();const state=t.manager.snapshot();
    if(outcome==='success'){const b=seed();b.resources.wood=888;gate.resolve(response({revision:8,save:b,updatedAt:8000}));}else gate.reject(Error('late offline'));
    await work;assert.deepEqual(cache(t),before);assert.equal(t.manager.phase,state.phase);assert.equal(t.manager.message,state.message);assert.equal(t.manager.csrfToken,null);
  });
  for (const stage of ['auth','GET','PUT','conflict-GET']) {
    test(`late ${stage} ${outcome} is ignored after the current generation is frozen`,async()=>{
      const t=setup();await t.manager.prepare();liveGame(t);const before=cache(t);
      if(stage==='auth')t.manager.csrfToken=null;
      if(stage==='GET')t.manager.needsRemote=true;
      if(stage==='conflict-GET'){
        const base=t.manager.fetcher;t.manager.fetcher=(path,options)=>options.method==='PUT'?response({code:'save_conflict'},409):base(path,options);
      }
      const gate=holdResponse(t,(path,options)=>stage==='auth'?path==='/api/auth/me':path==='/api/save'&&(stage==='PUT'?options.method==='PUT':options.method==='GET'));
      const work=t.manager.syncNow();await gate.entered;t.manager.freezeIdentity();const state=t.manager.snapshot();
      if(outcome==='rejection')gate.reject(Error('late network failure'));
      else if(stage==='auth')gate.resolve(response({user:{id:2,username:'other'},csrfToken:'late-token'}));
      else if(stage==='PUT')gate.resolve(response({revision:9,updatedAt:9000}));
      else {const b=seed();b.resources.wood=777;gate.resolve(response({revision:9,save:b,updatedAt:9000}));}
      await work;assert.deepEqual(cache(t),before);assert.equal(t.manager.phase,state.phase);assert.equal(t.manager.message,state.message);assert.equal(t.manager.csrfToken,null);assert.equal(t.manager.conflict,null);
      if(stage==='auth')assert.equal(gate.seen.filter(x=>x.options.method==='PUT').length,0);
    });
  }
  test(`late authentication POST ${outcome} cannot revive a superseded guest page`,async()=>{
    const t=setup({logged:false});await t.manager.prepare();liveGame(t);const before=t.storage.getItem(GUEST_SAVE_KEY),gate=holdResponse(t,path=>path==='/api/auth/login');
    const work=t.manager.login('captain','longpassword');await gate.entered;t.manager.freezeIdentity();
    if(outcome==='success')gate.resolve(response({user,csrfToken:'late-token'}));else gate.reject(Error('late auth timeout'));
    await work;assert.equal(t.manager.canPlay,false);assert.equal(t.manager.user,null);assert.equal(t.manager.csrfToken,null);assert.equal(t.storage.getItem(GUEST_SAVE_KEY),before);assert.equal(t.reloads,0);
  });
}
test('a changed shared hint invalidates a pending PUT even without a storage event',async()=>{
  const t=setup();await t.manager.prepare();liveGame(t);const before=cache(t),gate=holdResponse(t,(path,options)=>options.method==='PUT');
  const work=t.manager.syncNow();await gate.entered;t.storage.setItem(ACTIVE_ACCOUNT_KEY,JSON.stringify({id:2,username:'other'}));
  gate.resolve(response({revision:9,updatedAt:9000}));await work;
  assert.equal(t.manager.canPlay,false);assert.equal(t.manager.phase,'expired');assert.deepEqual(cache(t),before);
});
for (const choice of ['cloud','local']) {
  test(`conflict ${choice} never saves the stale live GameState before choosing the candidate`,async()=>{
    const cloud=seed();cloud.resources.wood=90;const local=seed();local.resources.wood=31;
    const t=setup({remote:cloud,revision:3});t.storage.setItem(accountSaveKey(1),JSON.stringify(local));t.storage.setItem(metaKey(1),JSON.stringify({revision:2,dirty:true,serial:1}));
    await t.manager.prepare();const game=new GameState({storage:t.manager.createStorage()});game.state.resources.wood=999;let saves=0;
    t.manager.beforeTransition=()=>{saves++;game.save();};
    await t.manager.resolveConflict(choice);assert.equal(saves,0);
    assert.equal(JSON.parse(t.storage.getItem('fkssj-account-backup-v1:1')).save.resources.wood,31);
    assert.equal(t.cloud.resources.wood,choice==='local'?31:90);
    assert.equal(JSON.parse(t.storage.getItem(accountSaveKey(1))).resources.wood,choice==='local'?31:90);
  });
}
test('a conflict confirmation cannot be reused for another account or revision',async()=>{
  const local=seed();local.resources.wood=31;const t=setup({remote:seed(),revision:3});
  t.storage.setItem(accountSaveKey(1),JSON.stringify(local));t.storage.setItem(metaKey(1),JSON.stringify({revision:2,dirty:true,serial:1}));await t.manager.prepare();
  const before=cache(t),count=t.requests.length;
  await assert.rejects(t.manager.resolveConflict('local',{userId:2,revision:3}),{code:'conflict_changed'});
  await assert.rejects(t.manager.resolveConflict('local',{userId:1,revision:2}),{code:'conflict_changed'});
  assert.equal(t.requests.length,count);assert.deepEqual(cache(t),before);assert.equal(t.rev,3);
});
for (const target of ['active','migration','metadata']) {
  test(`authentication success followed by ${target} quota failure freezes the old GameState`,async()=>{
    const t=setup({remote:seed(),revision:1});await t.manager.prepare();const {game,bound}=liveGame(t),before=cache(t),b={id:2,username:'other'};
    t.storage.setItem(GUEST_SAVE_KEY,JSON.stringify(seed()));
    const key=target==='active'?ACTIVE_ACCOUNT_KEY:target==='migration'?'fkssj-account-import-v1:2':metaKey(2),set=t.storage.setItem;
    t.storage.setItem=(k,v)=>{if(k===key)throw Object.assign(Error('full'),{name:'QuotaExceededError'});set(k,v);};
    t.manager.fetcher=async path=>response(path.endsWith('/auth/login')?{user:b,csrfToken:'b-token'}:{revision:target==='metadata'?1:0,save:target==='metadata'?seed():null,updatedAt:7000});
    await assert.rejects(t.manager.login('other','longpassword'),{code:'storage_unavailable'});
    assert.equal(t.manager.user.id,2);assert.equal(t.manager.phase,'error');assert.equal(t.manager.canPlay,false);assert.equal(t.manager.transitioning,true);assert.equal(t.manager.lastSyncedAt,null);assert.equal(t.reloads,0);
    const failureMessage=t.manager.message;
    game.state.resources.wood=999;assert.equal(game.save().ok,false);assert.throws(()=>bound.removeItem(''),{code:'account_frozen'});assert.deepEqual(cache(t),before);
    await assert.rejects(t.manager.syncNow());assert.equal(t.manager.phase,'error');assert.equal(t.manager.message,failureMessage);
  });
}
test('a metadata quota failure after a committed PUT never reports a synced account',async()=>{
  const t=setup();await t.manager.prepare();liveGame(t);const before=t.storage.getItem(metaKey(1)),set=t.storage.setItem;
  t.storage.setItem=(k,v)=>{if(k===metaKey(1))throw Error('full');set(k,v);};
  await assert.rejects(t.manager.syncNow(),{code:'storage_unavailable'});
  assert.equal(t.rev,1);assert.equal(t.manager.phase,'error');assert.equal(t.manager.canPlay,false);assert.equal(t.storage.getItem(metaKey(1)),before);assert.equal(t.manager.lastSyncedAt,null);
});
for (const outcome of ['lost-response','invalid-json']) {
  test(`an uncertain logout ${outcome} freezes the real GameState without claiming logout`,async()=>{
    const t=setup();await t.manager.prepare();const {game}=liveGame(t),base=t.manager.fetcher;let atPost,posts=0;
    t.manager.fetcher=(path,options)=>{
      if(path==='/api/auth/logout'){
        posts++;atPost=cache(t);t.logout();
        if(outcome==='lost-response')throw Error('response lost after server logout');
        return {ok:true,status:200,json:async()=>{throw Error('bad JSON');}};
      }
      return base(path,options);
    };
    await assert.rejects(t.manager.logout(),{code:'network'});
    assert.equal(posts,1);assert.equal(t.manager.user.id,1);assert.equal(t.manager.phase,'error');assert.equal(t.manager.canPlay,false);assert.equal(t.manager.transitioning,true);assert.equal(t.reloads,0);
    assert.equal(JSON.parse(t.storage.getItem(ACTIVE_ACCOUNT_KEY)).id,1);
    const failureMessage=t.manager.message;game.state.resources.wood+=123;assert.equal(game.save().ok,false);assert.deepEqual(cache(t),atPost);
    await assert.rejects(t.manager.syncNow());assert.equal(t.manager.phase,'error');assert.equal(t.manager.message,failureMessage);
  });
}
test('logout auth lookup failure before any POST keeps the known account usable',async()=>{
  const t=setup();await t.manager.prepare();const base=t.manager.fetcher;let posts=0;
  t.manager.fetcher=(path,options)=>{if(path==='/api/auth/me')throw Error('lookup offline');if(path==='/api/auth/logout')posts++;return base(path,options);};
  await assert.rejects(t.manager.logout(),{code:'network'});
  assert.equal(posts,0);assert.equal(t.manager.user.id,1);assert.equal(t.manager.canPlay,true);assert.equal(t.manager.identityFrozen,false);
});
for (const outcome of ['success','rejection']) {
  test(`a late logout POST ${outcome} cannot clear the account hint after a newer generation froze`,async()=>{
    const t=setup();await t.manager.prepare();const gate=holdResponse(t,path=>path==='/api/auth/logout');
    const work=t.manager.logout();await gate.entered;t.manager.freezeIdentity();const state=t.manager.snapshot(),hint=t.storage.getItem(ACTIVE_ACCOUNT_KEY);
    if(outcome==='success')gate.resolve(response({ok:true}));else gate.reject(Error('late logout rejection'));
    await work;assert.equal(t.storage.getItem(ACTIVE_ACCOUNT_KEY),hint);assert.equal(t.manager.user.id,1);assert.equal(t.manager.phase,state.phase);assert.equal(t.manager.message,state.message);assert.equal(t.reloads,0);
  });
}
for (const stage of ['auth','POST']) {
  for (const outcome of ['success','rejection']) {
    test(`logout ${stage} ${outcome} preserves a newer shared hint even without a storage event`,async()=>{
      const t=setup();await t.manager.prepare();const gate=holdResponse(t,path=>path===(stage==='auth'?'/api/auth/me':'/api/auth/logout'));
      const work=t.manager.logout();await gate.entered;
      const b={id:2,username:'other'};t.storage.setItem(ACTIVE_ACCOUNT_KEY,JSON.stringify(b));
      if(outcome==='rejection')gate.reject(Error('late logout failure'));
      else gate.resolve(response(stage==='auth'?{user,csrfToken:'old-token'}:{ok:true}));
      await work;assert.deepEqual(JSON.parse(t.storage.getItem(ACTIVE_ACCOUNT_KEY)),b);
      assert.equal(t.manager.user.id,1);assert.equal(t.manager.phase,'expired');assert.equal(t.manager.canPlay,false);assert.equal(t.reloads,0);
      if(stage==='auth')assert.equal(gate.seen.filter(x=>x.path==='/api/auth/logout').length,0);
    });
  }
}

// API deployment failures are injected response models: no server or browser is contacted.
const missingAPIModes = ['json404','json503','html404','html200','connection'];
function missingAPIResponse(mode) {
  if (mode === 'connection') throw Error('injected connection failure');
  if (mode.startsWith('html')) return {ok:mode==='html200',status:mode==='html200'?200:404,json:async()=>{throw Error('injected HTML response');}};
  return response({code:mode==='json404'?'not_found':'unavailable',message:'injected unavailable API'},mode==='json404'?404:503);
}
function unavailableAPI(profile, mode) {
  const t=setup({logged:false}),calls=[];
  const guest=seed();guest.resources.wood=17;
  if(profile!=='fresh-guest')t.storage.setItem(GUEST_SAVE_KEY,JSON.stringify(guest));
  if(profile==='account-cache'||profile==='hint-no-cache')t.storage.setItem(ACTIVE_ACCOUNT_KEY,JSON.stringify(user));
  if(profile==='account-cache'){
    const local=seed();local.resources.wood=73;t.storage.setItem(accountSaveKey(1),JSON.stringify(local));
    t.storage.setItem(metaKey(1),JSON.stringify({revision:7,dirty:false,serial:3,lastSyncedAt:5000}));
  }
  t.manager.fetcher=async(path,options)=>{calls.push({path,method:options.method});return missingAPIResponse(mode);};
  return {...t,calls};
}
for(const mode of missingAPIModes){
  for(const profile of ['fresh-guest','existing-guest','account-cache','hint-no-cache']){
    test(`missing API ${mode} preserves ${profile} and its storage boundary`,async()=>{
      const t=unavailableAPI(profile,mode),before=[...t.data];await t.manager.prepare();
      assert.deepEqual([...t.data],before);assert.deepEqual(t.calls,[{path:'/api/auth/me',method:'GET'}]);
      assert.notEqual(t.manager.phase,'synced');
      if(profile==='hint-no-cache'){
        assert.equal(t.manager.phase,'guest');assert.equal(t.manager.user,null);assert.equal(t.manager.canPlay,false);
        const game=new GameState({storage:t.manager.createStorage()});game.state.resources.wood=999;
        assert.equal(game.save().ok,false);assert.deepEqual([...t.data],before);
        await assert.rejects(t.manager.syncNow());assert.equal(t.calls.length,1);
      }else{
        assert.equal(t.manager.phase,profile==='account-cache'?'offline':'guest');assert.equal(t.manager.canPlay,true);
        const originalGuest=t.storage.getItem(GUEST_SAVE_KEY),game=new GameState({storage:t.manager.createStorage()});
        game.state.resources.wood+=1;assert.equal(game.save().ok,true);
        if(profile==='account-cache'){
          assert.equal(t.manager.user.id,1);assert.equal(JSON.parse(t.storage.getItem(accountSaveKey(1))).resources.wood,74);
          assert.equal(t.storage.getItem(GUEST_SAVE_KEY),originalGuest);
          await assert.rejects(t.manager.syncNow());assert.equal(t.manager.phase,'offline');
        }else{
          assert.equal(t.manager.user,null);assert.ok(t.storage.getItem(GUEST_SAVE_KEY));
          assert.equal(t.storage.getItem(accountSaveKey(1)),null);assert.equal(t.storage.getItem(metaKey(1)),null);
          await t.manager.syncNow();assert.equal(t.calls.length,1);
        }
      }
      assert.equal(t.calls.filter(call=>call.method==='PUT').length,0);
    });
  }
  for(const profile of ['fresh-guest','existing-guest']){
    test(`login against missing API ${mode} retains ${profile} without migrating or claiming sync`,async()=>{
      const t=unavailableAPI(profile,mode);await t.manager.prepare();const before=[...t.data];
      await assert.rejects(t.manager.login('captain','longpassword'));
      assert.deepEqual([...t.data],before);assert.equal(t.manager.user,null);assert.equal(t.manager.lastSyncedAt,null);
      assert.notEqual(t.manager.phase,'synced');assert.equal(t.storage.getItem('fkssj-account-import-v1:1'),null);
      assert.deepEqual(t.calls,[{path:'/api/auth/me',method:'GET'},{path:'/api/auth/login',method:'POST'}]);
      if(mode==='html200'||mode==='connection'){
        // A POST with an uncertain result may already have changed the HttpOnly Cookie.
        assert.equal(t.manager.phase,'error');assert.equal(t.manager.canPlay,false);assert.equal(t.manager.identityFrozen,true);
      }else{assert.equal(t.manager.phase,'guest');assert.equal(t.manager.canPlay,true);}
    });
  }
  test(`confirmed account without local cache stays blocked when save endpoint returns ${mode}`,async()=>{
    const t=unavailableAPI('existing-guest',mode),guest=t.storage.getItem(GUEST_SAVE_KEY);
    t.manager.fetcher=async(path,options)=>{t.calls.push({path,method:options.method});return path==='/api/auth/me'?response({user,csrfToken:'csrf'}):missingAPIResponse(mode);};
    await t.manager.prepare();assert.equal(t.manager.user.id,1);assert.equal(t.manager.phase,'offline');assert.equal(t.manager.needsRemote,true);assert.equal(t.manager.canPlay,false);
    assert.equal(t.storage.getItem(accountSaveKey(1)),null);assert.equal(t.storage.getItem(metaKey(1)),null);assert.equal(t.storage.getItem(GUEST_SAVE_KEY),guest);
    const game=new GameState({storage:t.manager.createStorage()});assert.equal(game.save().ok,false);
    assert.equal(t.storage.getItem(accountSaveKey(1)),null);assert.equal(t.calls.filter(call=>call.method==='PUT').length,0);
  });
}
for(const session of [null,{id:2,username:'other'}]){
  test(`an offline cached hint freezes before save when recovered API confirms ${session?'another account':'no session'}`,async()=>{
    const t=unavailableAPI('account-cache','connection');await t.manager.prepare();const before=cache(t),count=t.calls.length;
    t.manager.fetcher=async(path,options)=>{t.calls.push({path,method:options.method});return response({user:session,csrfToken:session?'other-token':undefined});};
    await assert.rejects(t.manager.syncNow(),{code:'user_mismatch'});
    assert.equal(t.manager.canPlay,false);assert.equal(t.manager.phase,'expired');assert.deepEqual(cache(t),before);
    assert.deepEqual(t.calls.slice(count),[{path:'/api/auth/me',method:'GET'}]);
    assert.equal(t.storage.getItem(accountSaveKey(2)),null);assert.equal(t.calls.filter(call=>call.method==='PUT').length,0);
  });
}

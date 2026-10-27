import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState, QUESTS } from './game-state.js';
import { AccountManager, accountSaveKey } from './account-manager.js';
import { ProductionUI, productionQueueView, renderProductionQueue, productionTaskHint } from './production-ui.js';

// Source/event models, not a browser DOM, screenshot or natural waiting test.
function factory(options={}) {
  const game=new GameState({storage:null,autoLoad:false,now:()=>1_000_000,...options});
  Object.assign(game.state.resources,{wood:100,scrap:100,fish:120});
  const tile=game.state.raft.find(t=>!game.state.buildings.some(b=>b.x===t.x&&b.z===t.z));
  const built=game.placeBuilding('slicer',tile.x,tile.z);
  assert.equal(built.ok,true,built.message);
  return {game,slicer:built.building};
}
function enqueue(game,slicer,count=1,quantity=1) {
  for(let i=0;i<count;i++)assert.equal(game.queueProduction('sashimi',quantity,slicer.id).ok,true);
}
function event(action,id) {
  const button={disabled:false,dataset:{factoryAction:action,id}};
  return {target:{classList:{contains:()=>false},closest:()=>button}};
}

test('five paid icons and an empty sixth slot show only the actual running countdown',()=>{
  const {game,slicer}=factory();enqueue(game,slicer,5);game.tick(17);
  const queue=game.getProductionQueue(slicer.id),before=game.getState();
  const view=productionQueueView(queue),html=renderProductionQueue(view);
  assert.deepEqual(view.counts,{running:1,queued:4,ready:0,empty:1});
  assert.equal(view.jobs[0].timeLabel,'1分13秒');
  for(const job of view.jobs.slice(1)){assert.equal(job.timeLabel,'依次加工');assert.equal(job.canClaim,false);}
  assert.equal((html.match(/class="factory-job /g)||[]).length,6);
  assert.equal((html.match(/role="progressbar"/g)||[]).length,1);
  assert.match(html,/第6格，空位/);
  assert.deepEqual(game.getState(),before,'Rendering neither advances, pays nor credits production');
});

test('an unclaimed finished first slot does not mislabel the running second slot',()=>{
  const {game,slicer}=factory();enqueue(game,slicer,3);game.tick(107);
  const view=productionQueueView(game.getProductionQueue(slicer.id));
  assert.deepEqual(view.jobs.map(j=>[j.slot,j.label,j.timeLabel]),[[1,'领取','已完成'],[2,'加工中','1分13秒'],[3,'待加工','依次加工']]);
  assert.deepEqual(view.counts,{running:1,queued:1,ready:1,empty:3});
  const html=renderProductionQueue(view),buttons=html.match(/<button\b[\s\S]*?<\/button>/g);
  assert.doesNotMatch(buttons[0],/ disabled/);assert.match(buttons[1],/ disabled/);assert.match(buttons[2],/ disabled/);
  assert.match(buttons[1],/role="progressbar"/);assert.doesNotMatch(buttons[0],/role="progressbar"/);
  assert.equal(game.state.resources.food,0,'Finished batches stay outside the backpack until claim');
  assert.equal(game.claimQueuedProduction(view.jobs[0].id).ok,true);
  assert.equal(game.state.resources.food,1);assert.equal(game.claimQueuedProduction(view.jobs[0].id).ok,false);
});

test('one ten-item batch keeps one slot, original payment, duration and output',()=>{
  const {game,slicer}=factory();const fish=game.state.resources.fish;enqueue(game,slicer,1,10);
  const view=productionQueueView(game.getProductionQueue(slicer.id));
  assert.equal(game.state.resources.fish,fish-60);assert.equal(view.jobs[0].duration,900);
  assert.deepEqual(view.jobs[0].outputs,{food:10});assert.equal(view.counts.empty,5);
  assert.match(renderProductionQueue(view),/×10/);assert.equal(game.state.resources.food,0);
});

test('timer ticks preserve queue structure identity; completion changes it',()=>{
  const {game,slicer}=factory();enqueue(game,slicer,2);
  const start=productionQueueView(game.getProductionQueue(slicer.id));game.tick(1);
  const next=productionQueueView(game.getProductionQueue(slicer.id));
  assert.equal(start.signature,next.signature);assert.notEqual(start.jobs[0].timeLabel,next.jobs[0].timeLabel);
  game.tick(89);assert.notEqual(next.signature,productionQueueView(game.getProductionQueue(slicer.id)).signature);
});

test('queue labels escape stored strings and never enable an inconsistent ready record',()=>{
  const view=productionQueueView([{id:'"><script>bad()</script>',name:'<img src=x onerror=bad()>',quantity:1,status:'ready',canClaim:false,outputs:{food:1},progress:1}]);
  const html=renderProductionQueue(view);
  assert.doesNotMatch(html,/<script>|<img /);assert.match(html,/&lt;img/);
  assert.equal(view.jobs[0].canClaim,false);assert.match(html,/待检查/);assert.match(html,/ disabled/);
});

test('first-meal hint distinguishes real collection from backpack supplies without delivering',()=>{
  const {game,slicer}=factory();game.state.quests.claimed=QUESTS.slice(0,QUESTS.findIndex(q=>q.id==='food')).map(q=>q.id);
  const recipe=game.getRecipes(slicer.id).find(r=>r.id==='sashimi');game.state.resources.food=5;
  assert.equal(game.getCurrentTask().id,'food');
  const before=game.getState(),unearned=productionTaskHint(game,recipe);
  assert.match(unearned,/已领取 0\/5/);assert.doesNotMatch(unearned,/data-factory-action="order"/);
  assert.deepEqual(game.getState(),before);
  game.state.stats.productionCollected.food=5;
  assert.match(productionTaskHint(game,recipe),/data-factory-action="order"/);
  game.state.resources.food=0;
  assert.doesNotMatch(productionTaskHint(game,recipe),/data-factory-action="order"/);
  assert.match(productionTaskHint(game,recipe),/还缺少/);
  assert.equal(productionTaskHint(game,{id:'fishLine'}),'');
  assert.deepEqual(game.state.residentOrders.completed,[]);
});

test('go-to-delivery rechecks supplies and only navigates after closing the factory',()=>{
  let canDeliver=false;const calls=[];
  const ui=Object.assign(Object.create(ProductionUI.prototype),{game:{getResidentOrder:()=>({canDeliver})},close:()=>calls.push('close'),onOrder:()=>calls.push('order')});
  ui.handle(event('order'));assert.deepEqual(calls,[]);
  canDeliver=true;ui.handle(event('order'));assert.deepEqual(calls,['close','order']);
});

for(const action of ['produce','collect','collect-legacy'])test(`${action}: injected quota freezes the real account without touching an unmounted UI`,async t=>{
  const values=new Map();let full=false,time=1_000_000,puts=0;
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{if(full)throw Error('injected quota');values.set(key,String(value));},removeItem:key=>values.delete(key)};
  const manager=new AccountManager({storage,autoSync:false,reload:()=>{},fetcher:async(path,options)=>{
    if(options.method==='PUT')puts++;
    return {ok:true,status:200,json:async()=>path.endsWith('/auth/me')?{user:{id:1,username:'captain'},csrfToken:'token'}:{revision:0,save:null,updatedAt:null}};
  }});t.after(()=>manager.stopTimer());await manager.prepare();
  const {game,slicer}=factory({storage:manager.createStorage(),now:()=>time});let job;
  if(action==='collect'){enqueue(game,slicer);game.tick(90);job=game.getProductionQueue(slicer.id)[0];}
  if(action==='collect-legacy')slicer.stored=1;
  game.save();const save=storage.getItem(accountSaveKey(1)),meta=storage.getItem('fkssj-account-meta-v1:1');
  let notifications=0,domAccess=0;
  const ui=Object.assign(Object.create(ProductionUI.prototype),{game,buildingId:slicer.id,recipeId:'sashimi',quantity:1,visible:true,notify:()=>notifications++,update:()=>{throw Error('must not update unmounted UI');},el:{querySelector:()=>{domAccess++;return null;}}});
  manager.subscribe(()=>{if(!manager.canPlay)ui.visible=false;});
  full=true;time+=6000;
  assert.doesNotThrow(()=>ui.handle(event(action,job?.id)));
  assert.equal(manager.canPlay,false);assert.equal(manager.phase,'error');assert.equal(ui.visible,false);
  assert.equal(notifications,0);assert.equal(domAccess,0);assert.equal(puts,0);
  assert.equal(storage.getItem(accountSaveKey(1)),save);assert.equal(storage.getItem('fkssj-account-meta-v1:1'),meta);
});

test('normal action feedback tolerates a status node removed during notification',()=>{
  const ui=Object.assign(Object.create(ProductionUI.prototype),{visible:true,notify:()=>{ui.visible=false;},update:()=>{},el:{querySelector:()=>null}});
  assert.doesNotThrow(()=>ui.showResult({message:'test'}));
});

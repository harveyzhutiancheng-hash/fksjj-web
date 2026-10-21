import { GameState, BUILDINGS, QUESTS } from './game-state.js';
import { RaftScene } from './scene.js';
import { icon, portrait } from './icons.js';
import { ProgressionUI } from './progress-ui.js';
import { ScavengingUI } from './scavenging-ui.js';
import { ProductionUI } from './production-ui.js';
import { DivingUI } from './diving-ui.js';
import { CRAFT_RESOURCE_NAMES } from './production-state.js';
import { AccountManager } from './account-manager.js';
import { AccountUI } from './account-ui.js';
import { acquireGamePage } from './page-lock.js';

const $ = (selector) => document.querySelector(selector);
const names = { wood:'木材', scrap:'废金属', fish:'鲜鱼', water:'淡水', food:'生鱼片', coin:'金币', plastic:'塑料', cloth:'碎布', seaweed:'海藻', glass:'玻璃', ...CRAFT_RESOURCE_NAMES };
const resourceKeys = ['wood','scrap','fish','water','food'];
const unlockAt = { fishing:1, slicer:3, purifier:5, scavenger:8, bed:10, farm:11, beacon:13 };
const factoryTypes = ['materials','construction','tailor','seafoodKitchen','dailyFactory'];
const gatedTypes = [...factoryTypes,'broadcast','divingDock','hospital'];
const buildOrder = ['fishing','slicer','purifier','scavenger','bed','farm','beacon',...factoryTypes.filter(type=>type!=='dailyFactory'),'broadcast','divingDock','hospital','dailyFactory'];
const questActions = {salvage:'在海面上拾取 15 份木材',fishing:'搭建第一把钓鱼椅',fish:'从海里钓上 15 条鲜鱼',slicer:'建造切鱼厂',food:'交付 5 份生鱼片，满足居民',purifier:'建造海水净化器',water:'领取 6 份淡水',expand:'在边缘扩建 2 块浮台'};
const questHints = {
  salvage:'点击海面上的木箱和漂流木，把物资捞上来',
  fishing:'打开建造，选择钓鱼椅，再点一处空闲浮台',
  fish:'点击钓鱼椅，甩竿后等咬钩，连续点击收线',
  slicer:'有了鲜鱼，接下来该准备一顿饭了',
  food:'进入切鱼厂安排生产，领取 5 份生鱼片后交付首餐',
  purifier:'大海再大，也得有一杯能喝的水',
  water:'净水器会持续生产，记得点击建筑领取淡水',
  expand:'点击右侧扩建，再选木筏边缘的金色位置',
  scavenger:'准备一艘拾荒船，去看看更远的海面',
  rescue:'打开海域，远处还有人在等着我们',
  bed:'让新伙伴也有一个安稳的落脚处',
  farm:'一小块泥土，也能在大海上长出希望',
  command:'点击指挥中心升级，储备水和食物，迎接风暴',
  beacon:'风浪已经过去，点一盏灯，照亮回家的路',
};
const ownsPage = await acquireGamePage();
const accounts = new AccountManager({ ownsPage, validate:raw=> {
  const reader = new GameState({storage:null,autoLoad:false});
  if (!reader._normalizeSave(raw)) throw new Error('Invalid game save');
} });
await accounts.prepare();
const game = new GameState({storage:accounts.createStorage()});
accounts.beforeTransition = () => {
  if(game.persistenceLocked)return; // Keep the unreadable original available for recovery/logout.
  if (!game.save().ok) throw new Error('本机存档未能保存，请检查浏览器储存空间。');
};
let progressionUI, scavengingUI, productionUI, divingUI, accountUI;
let scene, modal = null, selectedBuilding = null, mode = 'normal', buildType = null;
let toastTimer, sound = false, audioContext, ambient, lastQuestMarkup = '', lastResourceValues = {};
let stormPresentation = false;
let fishingId = null, autoFishing = false, catchTimer = null, fishingRound = null;
let introStep = 0, introOpen = false, actionBuilding = null, lastDemandMarkup = '', levelTimer;
const introLines = [
  ['阿海', '醒醒，老大！这座浮台还没沉，我们总算有个落脚的地方了。'],
  ['阿海', '海上漂着不少木板和旧箱子。捞回来，先搭一把钓鱼椅，解决吃饭的问题。'],
  ['阿海', '有鱼、有水、再有几个伙伴……就算世界只剩海，我们也能把日子重新过起来。'],
];
const savedSound = localStorageGet('fkssj-sound');
sound = savedSound === 'true';

function localStorageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function amount(value) { return Math.floor(Math.max(0, Number(value) || 0)).toLocaleString('zh-CN'); }
function waitTime(value) { const seconds=Math.max(0,Math.ceil(value||0));return seconds>=60?`${Math.floor(seconds/60)}分${seconds%60?`${seconds%60}秒`:''}`:`${seconds}秒`; }
function canAfford(cost) { return Object.entries(cost || {}).every(([key,n])=>game.state.resources[key] >= n); }
function costMarkup(cost, compare = true) { return `<span class="cost-list">${Object.entries(cost || {}).map(([key,n])=>`<span class="${compare && game.state.resources[key]<n?'short':''}">${icon(key)}${n}</span>`).join('')}</span>`; }
function hasCost(cost) { return !!cost && Object.keys(cost).length > 0; }
function questButtonLabel(quest) { return !quest.complete?'前往':hasCost(quest.cost)?'交付':hasCost(quest.reward)?'领取':'完成'; }
function currentQuest() { return game.getCurrentTask(); }
function claimAction(q) { return q.side?'side-claim':q.story?'story-claim':q.followup?'continuation-claim':'claim'; }
function claimTask(id,category) { return category==='story'?game.claimStoryQuest(id):category==='continuation'?game.claimContinuationQuest(id):game.claimQuest(id); }
function toast(message) { if (!message) return; $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(()=>$('#toast').classList.remove('show'),2700); }
function rewardFloat(resources, position) {
  Object.entries(resources || {}).forEach(([key,n], i)=> {
    const el = document.createElement('div'); el.className='float-reward';
    el.style.marginTop=`${i*30}px`; el.innerHTML=`${icon(key==='experience'?'flag':key)}+${n}`;
    if(position){el.style.left=`${Math.max(45,Math.min(innerWidth-45,position.screenX))}px`;el.style.top=`${Math.max(145,Math.min(innerHeight-230,position.screenY))}px`;}
    $('#float-rewards').appendChild(el); setTimeout(()=>el.remove(),1400);
  });
}
function act(result, options = {}) {
  if (!result) return;
  toast(result.message);
  if (result.ok) { playTone(options.note || 620); if (options.float !== false) rewardFloat(result.resources || result.reward); }
  else playTone(170, .035);
  return result;
}

function setupIcons() {
  $('#captain-portrait').innerHTML=portrait(0);
  $('#sound-button').innerHTML=icon(sound?'sound':'muted');
  $('#settings-button').innerHTML=icon('gear');
  $('#weather-icon').innerHTML=icon('sun');
  $('#expand-art').innerHTML=icon('expand');
  $('#quest-art').innerHTML=icon('journal');
  $('#storm-art').innerHTML=icon('storm');
  $('#heroes-art').innerHTML=icon('people');
  $('#campaign-art').innerHTML=icon('flag');
  $('#focus-button').innerHTML=icon('focus');
  document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
  document.querySelectorAll('[data-fish-icon]').forEach(el=>el.innerHTML=icon(el.dataset.fishIcon));
  $('#fishing-heading-icon').innerHTML=icon('fishing');
  $('#fishing-cast .cast-icon').innerHTML=icon('fishing');
  $('#opening-person').innerHTML=portrait(0);
  $('#resources').innerHTML=resourceKeys.map(key=>`<div class="resource" data-resource="${key}">${icon(key)}<span><small class="resource-name">${names[key]}</small><b>0</b></span></div>`).join('');
}

function render(state, event = {}) {
  progressionUI?.sync(state,event);
  scavengingUI?.sync(state,event);
  productionUI?.sync(state,event);
  divingUI?.sync(state,event);
  const ready=state.storm.status==='passed'||state.completed;
  $('#heroes-button').classList.toggle('progress-locked',!ready);
  $('#campaign-button').classList.toggle('progress-locked',!ready);
  for (const key of resourceKeys) {
    const el = $(`[data-resource="${key}"]`), value = Math.floor(state.resources[key]);
    el.querySelector('b').textContent=amount(value);
    if (lastResourceValues[key] !== undefined && value > lastResourceValues[key] && event.type!=='tick') {
      el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    }
    lastResourceValues[key]=value;
  }
  $('#coins').innerHTML=`${icon('coin')} ${amount(state.resources.coin)}`;
  const level = state.profile?.level || 1;
  $('#level').textContent=`Lv.${level}`;
  $('#xp-fill').style.width=`${(state.profile?.experience || 0)%60/60*100}%`;
  $('#population').textContent=`${state.population.total} 位居民 · ${game.availableWorkers} 位空闲`;
  $('#day-label').textContent=`海上 · 第 ${1+Math.floor(state.elapsed/600)} 天`;
  const approaching=state.storm.status==='approaching';
  $('#weather-icon').innerHTML=icon(approaching?'storm':'sun');
  $('#weather-label').textContent=approaching?'乌云靠近 / 准备避风':state.storm.status==='passed'?'雨过天晴 / 海风轻柔':'晴朗 / 东南风';
  $('#storm-button').hidden=!approaching;
  const quest = currentQuest();
  const questSite=quest&&['build','upgrade'].includes(quest.action?.type)?state.buildings.find(b=>b.type===quest.action.buildingType&&b.construction):null;
  $('#quest-dot').hidden=!quest?.complete;
  $('#tutorial-hint').textContent=quest?.followup ? quest.description : questHints[quest?.id] || '家园继续运转，沿着航道探索更远的海域';
  const questMarkup=quest ? `<div class="quest-portrait">${icon('journal')}</div><div class="quest-copy"><div class="eyebrow">${quest.story ? `海上故事 · 潜向深海 &nbsp; ${state.story.claimed.length+1}/${game.getStoryQuests().length}` : quest.followup ? `后续建设 · 物资与工坊 &nbsp; ${state.continuation.claimed.length+1}/${game.getContinuationQuests().length}` : `第一章 · 海上家园 &nbsp; ${state.quests.claimed.length+1}/${QUESTS.length}`}</div><h2>${esc(questActions[quest.id]||quest.title)}<span class="quest-counter">(${Math.min(quest.current,quest.target)}/${quest.target})</span></h2><small>${Object.entries(hasCost(quest.cost)?quest.cost:quest.reward).slice(0,4).map(([key,n])=>`<span>${key==='experience'?'EXP':icon(key)}${n}</span>`).join('')}</small></div><button class="gold-button ${quest.complete?'green':''}" data-action="${quest.complete?claimAction(quest):'go-quest'}" data-id="${quest.id}" data-category="${quest.category||'tutorial'}">${questButtonLabel(quest)} ${icon(quest.complete?'check':'arrow')}</button>` : `<div class="quest-portrait">${portrait(1)}</div><div class="quest-copy"><div class="eyebrow">经营首段完成 · 远海救援</div><h2>电台里传来了新的求救信号</h2><small>招募伙伴，组建救援队继续前进。</small></div><button class="gold-button" data-action="progression" data-tab="campaign">闯关 ${icon('flag')}</button>`;
  if (questMarkup!==lastQuestMarkup) { $('#quest-panel').innerHTML=questMarkup; lastQuestMarkup=questMarkup; }
  if(questSite){const timer=game.getConstruction(questSite.id),label=$('#quest-panel .quest-copy small');label.classList.add('quest-wait');label.innerHTML=`<span>${icon('clock')} ${timer.kind==='upgrade'?'升级中':'建造中'} · ${waitTime(timer.remaining)}</span>`;$('#quest-panel button').textContent='查看进度';}
  scene?.setState(state);
  updateResidentDemand();
  updateGuide();
  if (modal==='building') updateBuildingLive();
  if (modal==='bag') document.querySelectorAll('[data-bag]').forEach(el=>el.textContent=amount(state.resources[el.dataset.bag]));
  if (modal==='people') updateNeeds();
  if (modal==='storm') updateStormLive();
  if (modal==='resident-order') updateResidentOrderLive();
  if (fishingId) updateFishingLive();
  if (event.type==='questClaimed' && state.completed) setTimeout(showCompletion,400);
  if (event.type==='load' && state.offlineReport) showOffline(state.offlineReport);
  if (event.type==='stormPassed' && !stormPresentation) { stormPresentation=true; scene?.playStorm?.(); setTimeout(()=>{stormPresentation=false;},6000); }
}

function showIntro() {
  if(accountUI?.visible||!accounts.canPlay)return;
  if(introOpen || game.state.tutorial?.introSeen || game.persistenceLocked)return;
  introOpen=true;introStep=0;closeSheet();exitFishing();hideBuildingActions();
  document.body.classList.add('intro-view');$('#opening-dialog').hidden=false;
  renderIntro();$('#dialogue-next').focus({preventScroll:true});
}
function renderIntro() {
  const [name,text]=introLines[introStep];$('#dialogue-name').textContent=name;
  $('#dialogue-text').textContent=text;$('#dialogue-page').textContent=`${introStep+1} / ${introLines.length}`;
  $('#dialogue-next').textContent=introStep===introLines.length-1?'开始拾荒 ›':'继续 ›';
}
function finishIntro() {
  game.completeIntro();introOpen=false;$('#opening-dialog').hidden=true;
  document.body.classList.remove('intro-view');scene?.focus();updateGuide();
  toast('先捞回 15 份木材，搭起我们的第一把钓鱼椅。');
}
function hideBuildingActions() { actionBuilding=null;$('#building-actions').hidden=true; }
function showBuildingActions(id) {
  const b=game.state.buildings.find(v=>v.id===id);if(!b)return;
  if(b.type!=='fishing'){openBuilding(id);return;}
  closeSheet();actionBuilding=id;
  const el=$('#building-actions');el.innerHTML=`<strong>${BUILDINGS.fishing.name} <small>Lv.${b.level}</small></strong><div><button data-action="fishing-upgrade-from-camp" data-id="${id}">${icon('hammer')}升级</button><button data-action="fishing-enter" data-id="${id}">${icon('fishing')}钓鱼</button></div>`;
  el.hidden=false;positionBuildingActions();
}
function positionBuildingActions() {
  if(!actionBuilding)return;const el=$('#building-actions'),p=anchorForOverlay(actionBuilding,el);
  if(!p)return;el.style.left=`${Math.max(100,Math.min(innerWidth-100,p.screenX))}px`;el.style.top=`${Math.max(145,Math.min(innerHeight-205,p.screenY-14))}px`;
}
function anchorForOverlay(kind,el) {
  // The popup follows this world object; it must not block its own anchor.
  const wasHidden=el.hidden;el.hidden=true;
  try{return scene?.getGuideAnchor?.(kind);}finally{el.hidden=wasHidden;}
}
function updateResidentDemand() {
  const el=$('#resident-demand'),d=game.getResidentOrder();
  el.hidden=!d.order || !d.unlocked || !game.state.buildings.some(b=>b.type==='slicer') || !!fishingId || scavengingUI?.visible || productionUI?.visible || divingUI?.visible || introOpen || mode!=='normal' || !!modal;
  if(el.hidden)return;
  const markup=`<span class="demand-items">${Object.entries(d.order.cost).map(([key,n])=>`<span>${icon(key)}<b class="${game.state.resources[key]<n?'short':''}">${Math.min(n,Math.floor(game.state.resources[key]))}/${n}</b></span>`).join('')}</span><small>${d.canDeliver?'可以交付':`${d.order.resident.name}的需求`}</small>`;
  if(markup!==lastDemandMarkup){el.innerHTML=markup;lastDemandMarkup=markup;}
  el.classList.toggle('ready',d.canDeliver);el.dataset.orderId=d.id;
  const p=anchorForOverlay('resident',el) || {screenX:innerWidth*.58,screenY:innerHeight*.44};
  el.style.left=`${Math.max(85,Math.min(innerWidth-85,p.screenX))}px`;el.style.top=`${Math.max(145,Math.min(innerHeight-215,p.screenY-16))}px`;
}
function openResidentOrder() {
  const d=game.getResidentOrder();if(!d.order){openPeople();return;}
  const o=d.order;
  openSheet('居民需求',`${o.resident.name} · 已满足 ${game.getResidentDemandProgress().completed} 份需求`,`<div class="order-person"><span>${portrait(o.resident.portrait)}</span><div><h3>${esc(o.title)}</h3><p>${esc(o.description)}</p></div></div><div class="order-supplies">${Object.entries(o.cost).map(([key,n])=>`<div>${icon(key)}<strong>${names[key]}</strong><span data-order-resource="${key}"></span></div>`).join('')}</div><p id="order-reason"></p><div class="order-rewards"><b>交付奖励</b><span class="experience-reward">EXP +${o.reward.experience}</span>${costMarkup(Object.fromEntries(Object.entries(o.reward).filter(([k])=>k!=='experience')),false)}</div><button class="gold-button order-deliver" data-action="deliver-order" data-id="${o.id}">${icon('check')} 交付物资</button>`,'people','resident-order');
  const shortcuts=document.createElement('div');shortcuts.className='order-shortcuts';
  shortcuts.innerHTML=Object.keys(o.cost).map(key=>`<button class="secondary-button" data-action="order-supplies" data-resource="${key}">${icon(key)} ${key==='grilledFish'?'去加工烤鱼':`准备${names[key]||key}`} ${icon('arrow')}</button>`).join('');
  $('#order-reason').after(shortcuts);updateResidentOrderLive();
}
function updateResidentOrderLive() {
  const d=game.getResidentOrder();if(!d.order)return;
  for(const [key,n]of Object.entries(d.order.cost)){const el=$(`[data-order-resource="${key}"]`);if(el){el.textContent=`${amount(game.state.resources[key])} / ${n}`;el.classList.toggle('short',game.state.resources[key]<n);}}
  const button=$('[data-action="deliver-order"]');if(button)button.disabled=!d.canDeliver;
  const reason=$('#order-reason');if(reason)reason.textContent=d.canDeliver?'物资备齐了，把这一份交给伙伴吧。':d.reason || '先去领取设施产物，备齐需求物资。';
  document.querySelectorAll('[data-action="order-supplies"]').forEach(button=>{const key=button.dataset.resource;button.hidden=!d.unlocked||(game.state.resources[key]>=d.order.cost[key]&&(!d.order.productionRequired?.[key]||d.productionReady));});
}
function goOrderSupplies(key) {
  const d=game.getResidentOrder();if(!d.unlocked||!d.order?.cost[key])return;
  const recipe=game.getRecipes().find(r=>r.outputs[key]);
  if(recipe){openProduction(recipe.buildingId,recipe.buildingType,recipe.id);return;}
  const type={food:'slicer',water:'purifier',fish:'fishing'}[key],building=game.state.buildings.find(b=>b.type===type);
  if(building)openBuilding(building.id);else if(type)chooseBuild(type);
}
function deliverOrder(id) {
  const before=game.state.profile.level,result=act(game.deliverResidentOrder(id));
  if(!result.ok)return;closeSheet();
  if(game.state.profile.level>before){const el=$('#level-up');el.innerHTML=`<small>领袖升级</small><strong>Lv.${game.state.profile.level}</strong><span>居民需求已完成 · EXP +${result.reward.experience}</span>`;el.hidden=false;clearTimeout(levelTimer);levelTimer=setTimeout(()=>{el.hidden=true;},2900);}
}
function updateGuide() {
  const el=$('#guide-pointer');el.hidden=true;
  delete el.dataset.guideKind;delete el.dataset.guideX;delete el.dataset.guideY;
  if(!scene||introOpen||modal||fishingId||actionBuilding||progressionUI?.visible||scavengingUI?.visible||productionUI?.visible||divingUI?.visible)return;
  const q=currentQuest();let target,kind;
  if(mode==='build'){kind='build';target=scene.getGuideAnchor?.('build');}
  else if(mode==='expand'){kind='expand';target=scene.getGuideAnchor?.('expand');}
  else if(q?.complete){kind='claim';const b=$('#quest-panel button[data-id]');if(b){const r=b.getBoundingClientRect();target={screenX:r.x+r.width/2,screenY:r.y+r.height/2};}}
  else if(q?.id==='salvage'){kind='salvage';target=scene.getGuideAnchor?.('salvage');}
  else if(q?.id==='food'&&game.getResidentOrder().canDeliver){kind='resident';const r=$('#resident-demand').getBoundingClientRect();target={screenX:r.x+r.width/2,screenY:r.y+r.height/2};}
  else if(['fish','food','water'].includes(q?.id)){const type={fish:'fishing',food:'slicer',water:'purifier'}[q.id],b=game.state.buildings.find(b=>b.type===type);if(b){kind=type==='fishing'?'fishing':b.id;target=scene.getGuideAnchor?.(b.id);}}
  else if(q&&['fishing','slicer','purifier','scavenger','bed','farm','beacon'].includes(q.id)){kind='build-menu';const r=$('[data-nav="build"]').getBoundingClientRect();target={screenX:r.x+r.width/2,screenY:r.y+r.height/2};}
  else if(q){const b=$('#quest-panel [data-action="go-quest"]');if(b){kind='quest-action';const r=b.getBoundingClientRect();target={screenX:r.x+r.width/2,screenY:r.y+r.height/2};}}
  if(!target||target.screenX<25||target.screenX>innerWidth-25||target.screenY<90||target.screenY>innerHeight-25)return;
  el.hidden=false;el.dataset.guideKind=kind;el.dataset.guideX=target.screenX.toFixed(1);el.dataset.guideY=target.screenY.toFixed(1);el.style.left=`${target.screenX}px`;el.style.top=`${target.screenY}px`;
}

function openSheet(title, subtitle, body, iconName, type) {
  hideBuildingActions();
  modal=type;
  $('#modal-root').innerHTML=`<div class="modal-shade"><section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sheet-grip"></div><header class="sheet-header"><div class="sheet-title">${icon(iconName)}<div><h2>${esc(title)}</h2><small>${esc(subtitle)}</small></div></div><button class="close-button" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="sheet-body">${body}</div></section></div>`;
  // Opening a sheet on canvas pointerup must not dismiss it with the same tap's click.
  $('.modal-shade').addEventListener('pointerdown', e=>{if(e.target.classList.contains('modal-shade'))closeSheet();});
  $('.sheet [data-action="close"]').focus({preventScroll:true});
}
function closeSheet() { $('#modal-root').innerHTML=''; modal=null; selectedBuilding=null; }
function setMode(next, type) {
  hideBuildingActions();
  if(fishingId)exitFishing();
  closeSheet(); mode=next; buildType=type || null; scene?.setMode(next,type);
  $('#mode-banner').hidden=next==='normal';
  $('#mode-text').textContent=next==='expand'?'选择金色位置，拼接新的木筏':`选择绿色空位，建造${BUILDINGS[type]?.name||'设施'}`;
  document.querySelectorAll('[data-nav]').forEach(el=>el.classList.toggle('active',el.dataset.nav===(next==='build'?'build':'camp')));
}
function startExpand() { setMode('expand'); toast(`每块木筏需要 ${Object.entries(game.getExpandCost()).map(([k,n])=>`${n}${names[k]}`).join('、')}`); }
function unlocked(type) { return gatedTypes.includes(type) ? game.getFactoryUnlock(type).unlocked : game.state.quests.claimed.length >= (unlockAt[type] ?? 0); }
function openBuild() {
  const cards = buildOrder.map(type=> {
    const d=BUILDINGS[type], locked=!unlocked(type), owned=game.state.buildings.some(b=>b.type===type),pending=game.state.buildings.some(b=>b.type===type&&b.construction?.kind==='build');
    return `<button class="build-card ${locked?'locked':''}" data-action="choose-build" data-type="${type}"><span class="building-art" style="background:${d.color}30">${icon(type)}</span><h3>${d.name}</h3><span class="type-tag">${locked?'尚未解锁':pending?'建造中 · 查看进度':owned?'已建造 · 可继续建造':d.production||factoryTypes.includes(type)?'生产设施':'营地设施'}</span><span class="build-arrow">${icon(locked?'lock':'arrow')}</span><p>${locked?(gatedTypes.includes(type)?game.getFactoryUnlock(type).reason:`完成航海日志第 ${unlockAt[type]} 项任务后解锁`):d.description}</p>${costMarkup(d.cost)}${d.buildSeconds?`<small class="build-duration">${icon('clock')} 建造 ${waitTime(d.buildSeconds)}</small>`:''}</button>`;
  }).join('');
  openSheet('把木筏，变成家','建造完成后，点击设施管理生产',`<div class="panel-info"><div><h3>${game.state.raft.length} 块木筏 · ${game.state.buildings.length} 座设施</h3><p>新的设施需要一块空闲木筏。</p></div><button class="secondary-button" data-action="expand">扩建 ${icon('expand')}</button></div><div class="build-grid">${cards}</div>`,'hammer','build');
}
function chooseBuild(type) {
  const pending=game.state.buildings.find(b=>b.type===type&&b.construction?.kind==='build');if(pending){openBuilding(pending.id,true);return;}
  if (!unlocked(type)) { toast(gatedTypes.includes(type)?game.getFactoryUnlock(type).reason:'先跟着航海日志，完成前面的任务吧。'); return; }
  if (type==='beacon' && game.state.storm.status!=='passed') { toast('先修好指挥中心、准备补给，平安度过风暴。'); openStorm(); return; }
  if (!canAfford(BUILDINGS[type].cost)) { const missing=Object.entries(BUILDINGS[type].cost).filter(([k,n])=>game.state.resources[k]<n).map(([k,n])=>`${names[k]||k} ${Math.ceil(n-game.state.resources[k])}`);toast(`还缺 ${missing.join('、')}${factoryTypes.includes(type)?'；可在工厂加工或出海收集':'，先去收集一些物资吧'}`); return; }
  if (game.state.raft.length<=game.state.buildings.length) { toast('木筏已经住满了，先扩建一块。'); startExpand(); return; }
  setMode('build',type);
  scene.focus();
}
function openBuilding(id, manage = false) {
  const b=game.state.buildings.find(v=>v.id===id); if(!b) return;
  const construction=game.getConstruction(id);
  if(b.type==='fishing'&&!manage){enterFishing(id);return;}
  if((factoryTypes.includes(b.type)||b.type==='slicer')&&!manage&&!construction){openProduction(id);return;}
  const d=BUILDINGS[b.type]; selectedBuilding=id;
  if(!(fishingId&&b.type==='fishing'))scene?.focusBuilding?.(id);
  const hero=`<div class="detail-hero"><div class="building-art" style="background:${d.color}40">${icon(b.type)}</div><div><h3>${d.name} <span class="level" style="color:#b48f4d" id="building-level">Lv.${b.level}</span></h3><p>${d.description}</p></div></div>`;
  let body=hero;
  if(construction)body+=`<section class="construction-progress" data-construction-id="${b.id}"><div><span>${icon('hammer')} ${construction.kind==='upgrade'?`升级至 ${construction.targetLevel} 级`:'正在建造'}</span><strong id="construction-time"></strong></div><div class="progress-track"><i id="construction-fill"></i></div><p>${construction.kind==='upgrade'?'竣工后解锁海藻汁。原有烤鱼加工可以继续。':'竣工后可以下潜，建造任务也会随之完成。'}<br>费用已支付，离开页面也会继续计时。</p></section>`;
  if(construction?.kind==='build'){
    body+=`<button class="secondary-button" data-action="close">先去忙别的 ${icon('arrow')}</button>`;
    openSheet(d.name,'营地施工 / 完工后即可使用',body,b.type,'building');selectedBuilding=id;updateBuildingLive();return;
  }
  if(b.type==='slicer')body+=`<button class="secondary-button factory-entry" data-action="production" data-id="${b.id}" data-type="slicer">${icon('food')} 生鱼片与鱼肠线加工 ${icon('arrow')}</button>`;
  if(b.type==='scavenger')body+=scavengeEntry();
  if(b.type==='divingDock')body+=divingEntry();
  if(b.type==='broadcast')body+=`<button class="scavenge-entry" data-action="progression" data-tab="recruit">${icon('people')}<span><strong>发送招募讯息</strong><small>寻找海上的英雄，壮大救援队伍</small></span>${icon('arrow')}</button>`;
  if(b.type==='hospital')body+=`<div class="panel-info"><div><h3>营地可以容纳更多居民</h3><p>这座医院增加 ${d.capacity*b.level} 人的承载空间。<br>营地现有 ${game.state.population.total} 位居民，可容纳 ${game.state.population.capacity} 人。</p></div>${icon('hospital')}</div><button class="secondary-button" data-action="journal">${icon('journal')} 查看航海日志 ${icon('arrow')}</button>`;
  if(b.type==='seafoodKitchen')body+=`<button class="secondary-button factory-entry" data-action="production" data-id="${b.id}" data-type="seafoodKitchen">${icon('seafoodKitchen')} 安排厨房加工 ${icon('arrow')}</button>`;
  if(d.production) {
    body+=`<div class="panel-info"><div style="flex:1"><h3 id="production-label"></h3><p id="production-status"></p><div class="progress-track"><i id="production-progress"></i></div></div>${icon(d.production.resource)}</div><div class="action-row"><button class="gold-button green" data-action="collect-production" data-id="${b.id}" id="collect-production-button">领取产物</button>${b.type==='fishing'?`<button class="gold-button" data-action="cast" id="cast-button">${icon('fishing')} 甩竿</button>`:''}</div>`;
    if(!d.production.manual)body+=`<div class="row"><div><strong>安排工作</strong><small id="worker-description"></small></div><div class="stepper"><button data-action="worker-minus" data-id="${b.id}" aria-label="调回一位工人">−</button><strong id="worker-number">${b.workers}</strong><button data-action="worker-plus" data-id="${b.id}" aria-label="安排一位工人">+</button></div></div>`;
  }
  if(b.type==='command') body+=`<div class="panel-info"><div><h3>营地的主心骨</h3><p>当前居民 ${game.state.population.total} 人 / 可容纳 ${game.state.population.capacity} 人<br>升至 2 级后，可保护居民度过第一次风暴。</p></div>${icon('flag')}</div>${game.state.storm.status==='approaching'?'<button class="gold-button" data-action="storm">准备迎接风暴</button>':''}`;
  if(b.type==='bed') body+=`<div class="panel-info"><div><h3>夜里也有归处</h3><p>提供 ${d.capacity*b.level} 个床位。<br>营地共有 ${game.state.population.total} 位居民。</p></div>${icon('heart')}</div>`;
  if(b.type==='beacon') body+=`<div class="panel-info"><div><h3>希望，终于有了形状</h3><p>信标亮起后，远方的船只也能找到这里。</p></div>${icon('sun')}</div>`;
  const upgrade=game.getUpgradeCost(id);
  if(!construction&&(upgrade||!['broadcast','divingDock','hospital','dailyFactory'].includes(b.type)))body+=`<div class="row"><div><strong>设施升级</strong><small>${upgrade&&d.upgradeSeconds?`施工 ${waitTime(d.upgradeSeconds)} · 竣工后解锁海藻汁`:b.type==='slicer'?(b.level<2?'升至2级开放鱼肠线加工':'当前已开放生鱼片与鱼肠线'):'提升产量、容量或营地承载力'}</small></div><span id="upgrade-cost">${upgrade?costMarkup(upgrade):'已满级'}</span></div><button class="gold-button" data-action="upgrade" data-id="${b.id}" ${!upgrade?'disabled':''}>${icon('hammer')} ${upgrade?d.upgradeSeconds?'开始升级':'升级设施':b.type==='broadcast'||b.type==='divingDock'?'设施已就绪':'已达最高等级'}</button>`;
  openSheet(d.name,'营地设施 / 点击领取与管理',body,b.type,'building');
  selectedBuilding=id; updateBuildingLive();
}
function updateBuildingLive() {
  const b=game.state.buildings.find(v=>v.id===selectedBuilding); if(!b)return;
  const construction=game.getConstruction(b.id),timer=$('#construction-time');
  if(construction){if(timer){timer.textContent=waitTime(construction.remaining);$('#construction-fill').style.width=`${construction.progress*100}%`;}else{openBuilding(b.id,true);return;}}
  else if(timer){openBuilding(b.id,true);return;}
  const info=game.getProductionInfo(b.id); if(!info)return;
  $('#production-label').textContent=`待领取 ${amount(info.stored)} / ${info.capacity} ${names[info.resource]}`;
  $('#production-status').textContent=info.manual?'新加工在六格队列中安排，成品完成后领取。':info.blocked==='full'?'仓库满了，领取后继续生产':info.blocked==='inputs'?`等待原料：${Object.entries(info.inputs||{}).map(([k,n])=>`${n}${names[k]}`).join(' / ')}`:`下一批约 ${Math.ceil(info.secondsRemaining)} 秒 · 效率 ${Math.round(info.efficiency*100)}%`;
  $('#production-progress').style.width=`${info.progress*100}%`;
  $('#collect-production-button').disabled=info.stored<1;
  $('#collect-production-button').innerHTML=`${icon(info.resource)} 领取${info.stored>=1?` ×${amount(info.stored)}`:''}`;
  if($('#worker-number'))$('#worker-number').textContent=b.workers;
  if($('#worker-description'))$('#worker-description').textContent=`${game.availableWorkers} 位空闲 · 每增加一人，生产更快`;
  if($('#cast-button')) { const wait=Math.max(0,2.5-(game.state.elapsed-game.state.fishing.lastCastAt)); $('#cast-button').disabled=wait>.01; $('#cast-button').innerHTML=`${icon('fishing')} ${wait>.01?`等咬钩 ${Math.ceil(wait)}s`:'甩竿'}`; }
}
function enterFishing(id) {
  const building=game.state.buildings.find(b=>b.id===id&&b.type==='fishing');if(!building)return;
  closeSheet();hideBuildingActions();fishingRound=null;
  mode='normal';buildType=null;scene?.setMode('normal');$('#mode-banner').hidden=true;
  fishingId=id;autoFishing=false;
  $('#fishing-screen').hidden=false;document.body.classList.add('fishing-view');
  $('.bottom-hud').setAttribute('aria-hidden','true');
  scene?.setFishingMode?.(id);updateFishingLive();
}
function exitFishing() {
  if(!fishingId)return;
  autoFishing=false;fishingId=null;fishingRound=null;clearTimeout(catchTimer);
  $('#fishing-screen').hidden=true;document.body.classList.remove('fishing-view');
  $('#fishing-catch').classList.remove('show');$('.bottom-hud').removeAttribute('aria-hidden');
  scene?.setFishingMode?.(null);
}
function updateFishingLive() {
  const b=game.state.buildings.find(b=>b.id===fishingId);if(!b){exitFishing();return;}
  const wait=Math.max(0,2.5-(game.state.elapsed-game.state.fishing.lastCastAt));
  const phase=fishingRound?.phase||'idle',button=$('#fishing-cast');
  button.dataset.phase=phase;button.disabled=phase==='waiting'||(phase==='idle'&&wait>1e-7);
  button.classList.toggle('reeling',phase==='reeling');
  button.style.setProperty('--cast-progress',`${phase==='reeling'?fishingRound.progress:100}%`);
  button.querySelector('strong').textContent=phase==='reeling'?'收线':phase==='waiting'?'等咬钩':wait>1e-7?'整竿':'甩竿';
  button.querySelector('small').textContent=phase==='reeling'?'连续点击':phase==='waiting'?'留意鱼漂':wait>1e-7?`${Math.ceil(wait)} 秒`:'点击抛出鱼钩';
  button.setAttribute('aria-label',phase==='reeling'?'连续点击收线':phase==='waiting'?'等待鱼儿咬钩':'甩竿钓鱼');
  $('#fishing-status').textContent=phase==='reeling'?'咬钩了！趁现在，连点按钮收线':phase==='waiting'?'鱼钩落水了，等鱼漂动起来…':autoFishing?'自动钓鱼中':'往海里甩一竿，看看有什么收获';
  $('#reel-meter').hidden=phase!=='reeling';$('#reel-fill').style.width=`${fishingRound?.progress||0}%`;
  $('#fishing-level').textContent=`Lv.${b.level}`;
  $('#fishing-title').textContent=BUILDINGS[b.type].name;
  $('#fishing-auto').classList.toggle('active',autoFishing);$('#fishing-auto').setAttribute('aria-pressed',String(autoFishing));
  $('#fishing-auto strong').textContent=autoFishing?'自动中':'自动';
  const production=$('#fishing-production');production.hidden=b.stored<1;
  production.innerHTML=`${icon('fish')} 鱼篓里还有 ${amount(b.stored)} 条 · 领取`;
  const q=currentQuest(),claim=$('#fishing-claim');claim.hidden=!q?.complete;
  if(q?.complete){claim.innerHTML=`${icon('check')} ${q.title} · 领取奖励`;claim.dataset.id=q.id;claim.dataset.category=q.category||'tutorial';}
}
function castFishing(automatic=false) {
  if(!fishingId||document.hidden||modal)return;
  if(fishingRound){if(fishingRound.phase==='reeling'&&!automatic){fishingRound.progress=Math.min(100,fishingRound.progress+29);playTone(510+fishingRound.progress*3,.035);if(fishingRound.progress>=100)finishFishing();else updateFishingLive();}return;}
  if(game.state.elapsed-game.state.fishing.lastCastAt<2.5-1e-7)return;
  fishingRound={phase:'waiting',remaining:1.1,progress:0,automatic};
  $('#fishing-catch').classList.remove('show');scene?.animateCast?.();playTone(440,.08);updateFishingLive();
}
function advanceFishing(dt) {
  if(!fishingRound||!fishingId||document.hidden||modal)return;
  if(fishingRound.phase==='waiting'){fishingRound.remaining-=dt;if(fishingRound.remaining<=0){fishingRound.phase='reeling';playTone(840,.06);}}
  else{fishingRound.progress=Math.max(0,Math.min(100,fishingRound.progress+dt*(fishingRound.automatic?82:-5)));if(fishingRound.progress>=100)finishFishing();}
  if(fishingRound)updateFishingLive();
}
function finishFishing() {
  fishingRound=null;const result=game.castLine();
  if(!result.ok){toast(result.message);return;}
  const note=$('#fishing-catch');note.innerHTML=`${icon('fish')}<strong>鲜鱼 +${result.amount}</strong><small>收进鱼篓，今天有鱼吃了！</small>`;
  note.classList.remove('show');void note.offsetWidth;note.classList.add('show');playTone(820,.1);
  clearTimeout(catchTimer);catchTimer=setTimeout(()=>note.classList.remove('show'),2100);
  if(navigator.vibrate)navigator.vibrate(16);updateFishingLive();
}
function openFishingCatches() {
  openSheet('今天的收获','收好鲜鱼，给伙伴准备第一顿饭',`<div class="fishing-record">${icon('fish')}<strong>${game.state.stats.fishCollected}</strong><span>鲜鱼收获累计</span></div><div class="row"><strong>完成收线</strong><span>${game.state.stats.manualCasts} 次</span></div><div class="row"><strong>仓库鲜鱼</strong><span>${amount(game.state.resources.fish)} 条</span></div><p>把鲜鱼交给切鱼厂，就能给大家准备一顿饭。鱼篓里的自动产物，需要点击领取后才会入仓。</p>`,'fish','fishing-catches');
}
function openPeople() {
  const residents=['阿海','米娅','老乔'];
  const assignments=[]; game.state.buildings.forEach(b=>{for(let i=0;i<b.workers;i++)assignments.push(BUILDINGS[b.type].name);});
  const demand=game.getResidentOrder();
  openSheet('营地居民',`已满足 ${game.getResidentDemandProgress().completed} 份需求 · 获得领袖经验`,`${demand.order?`<button class="resident-order-entry" data-action="resident-order">${icon('food')}<span><strong>${esc(demand.order.title)}</strong><small>${demand.canDeliver?'物资齐了，可以交付':'准备伙伴需要的物资'}</small></span>${icon('arrow')}</button>`:''}<div class="needs"><div class="panel-info"><strong>${icon('food')} 饱腹</strong><small data-need-label="hunger"></small><div class="progress-track"><i data-need="hunger"></i></div></div><div class="panel-info"><strong>${icon('water')} 饮水</strong><small data-need-label="thirst"></small><div class="progress-track"><i data-need="thirst"></i></div></div></div><div class="row"><strong>${game.state.population.total} 位居民</strong><span>可容纳 ${game.state.population.capacity} 人 · 空闲 ${game.availableWorkers}</span></div>${Array.from({length:game.state.population.total},(_,i)=>`<div class="resident"><div class="resident-face">${portrait(i)}</div><div><h3>${residents[i]||`漂流者 ${i+1}`}</h3><p>${i===0?'就算世界只剩海，也得好好吃饭。':i===1?'谢谢你们，我也想为这里做点什么。':'风向变了，不过这次我们有家。'}</p></div><span class="resident-role">${assignments[i]||'营地待命'}</span></div>`).join('')}<p>点击生产设施安排工人；首餐交付后，居民会按需使用库存水与食物。</p>${game.state.population.total>game.state.population.capacity?'<div class="storm-note">床位有点紧张。建造居民睡铺，让大家休息好，生产也会更顺畅。</div>':''}`,'people','people');
  updateNeeds();
}
function updateNeeds() { for(const key of ['hunger','thirst']) { const value=Math.round(game.state.population[key]); $(`[data-need="${key}"]`).style.width=`${value}%`; $(`[data-need-label="${key}"]`).textContent=`${value}%`; } }
function scavengeEntry() {
  const trip=game.getScavenging(),active=['sailing','failed'].includes(trip?.status),ready=game.state.buildings.some(b=>b.type==='scavenger');
  const count=active?Object.values(trip.cargo).reduce((a,b)=>a+b,0):0;
  return `<button class="scavenge-entry" data-action="scavenging-enter">${icon('ship')}<span><strong>${active?'继续海上拾荒':'出海拾荒'}</strong><small>${ready?'拖动摇杆 · 收集木材、塑料与碎布':'先建造拾荒船，解锁手动海域'}</small>${active?`<small class="sc-entry-tag">货网里还有 ${count} 份物资，返航后入库</small>`:''}</span>${icon('arrow')}</button>`;
}
function enterScavenging() {
  if(introOpen||progressionUI?.visible||productionUI?.visible||divingUI?.visible)return;
  setMode('normal');
  if(scavengingUI.open()){updateGuide();updateResidentDemand();}
}
function divingEntry() {
  const trip=game.getDiving(),active=['diving','surfaced'].includes(trip?.status),ready=game.state.buildings.some(b=>b.type==='divingDock'&&game.isBuildingReady(b.id)),pending=game.state.buildings.find(b=>b.type==='divingDock'&&b.construction);
  return `<button class="scavenge-entry" data-action="${ready||active?'diving-enter':'choose-build'}" data-type="divingDock">${icon('divingDock')}<span><strong>${active?'继续海底探索':pending&&!ready?'船坞建造中 · 查看进度':'潜水采集'}</strong><small>${ready?'携带氧气瓶，采集废金属、玻璃与海藻':pending?'竣工后就能出发，费用已支付':'建造潜水船坞，探索沉没的街区'}</small>${active?`<small class="sc-entry-tag">氧气剩余 ${Math.ceil(trip.oxygenRemaining)} 秒 · 本次收获尚未入库</small>`:''}</span>${icon('arrow')}</button>`;
}
function enterDiving() {
  if(introOpen||progressionUI?.visible||productionUI?.visible||scavengingUI?.visible)return;
  const pending=game.state.buildings.find(b=>b.type==='divingDock'&&b.construction);
  if(pending&&!game.state.buildings.some(b=>b.type==='divingDock'&&game.isBuildingReady(b.id))&&!['diving','surfaced'].includes(game.getDiving()?.status)){openBuilding(pending.id,true);return;}
  setMode('normal');if(divingUI.open()){updateGuide();updateResidentDemand();}
}
function openExplore() {
  const done=game.state.exploration.rescueCompleted;
  const ship=game.state.buildings.some(b=>b.type==='scavenger');
  openSheet('附近海域','海上拾荒 / 海底潜水 / 漂流救援',`${scavengeEntry()}${divingEntry()}<div class="ocean-map"><div class="map-lines"></div><span class="map-route"></span><span class="map-home">${icon('command')}</span><span class="map-destination">${icon(done?'check':'ship')}</span><span class="map-label">漂流者营地 · 失事小船</span></div><div class="detail-hero"><div><h3>${done?'他们已经安全到家了':'远处，有人在挥手'}</h3><p>${done?'米娅和老乔正在营地里开始新的生活。':'一艘失事的小船上，还有两名幸存者。<br>带上补给，把他们接回家。'}</p></div></div><div class="row"><strong>航行补给</strong>${costMarkup({water:3,food:3})}</div><div class="row"><strong>救援收获</strong><span>${icon('people')} 2 位新伙伴</span></div>${!ship?'<p>需要先在营地建造一艘拾荒船。</p>':''}<button class="gold-button ${done?'green':''}" data-action="rescue" ${done?'disabled':''}>${icon(done?'check':'ship')} ${done?'救援已完成':ship?'派船出发':'先建造拾荒船'}</button>`,'compass','explore');
}
function openProduction(id=null,type=null,recipeId=null) { if(introOpen||scavengingUI?.visible||divingUI?.visible||progressionUI?.visible)return;setMode('normal');productionUI.open(id,type);if(recipeId){productionUI.recipeId=recipeId;productionUI.render();} }
function openBag() {
  openSheet('家当，都在这儿','收好每一份来自大海的馈赠',`<div class="inventory-grid">${Object.entries(names).map(([key,name])=>`<div class="inventory-cell">${icon(key)}<strong data-bag="${key}">${amount(game.state.resources[key])}</strong><small>${name}</small></div>`).join('')}</div><div class="sheet-section">收集记录</div><div class="row"><strong>海上打捞</strong><span>${game.state.stats.salvageCount} 次</span></div><div class="row"><strong>拼接木筏</strong><span>${game.state.raft.length} 块</span></div><div class="row"><strong>生产设施</strong><span>${game.state.buildings.length} 座</span></div><p>木材和废料用于建造；塑料与碎布由手动拾荒带回；工厂可加工木板、布匹、长绳、救生衣和鱼肠线，日用品厂加工生活用品；海产厨房可以烤鱼，升至2级后用潜水带回的海藻和玻璃加工海藻汁。鲜鱼交给切鱼厂或厨房；食物与淡水会由居民按需取用。</p><button class="gold-button" data-action="production">${icon('materials')} 前往加工工坊</button>`,'bag','bag');
}
function openJournal() {
  const followup=game.getContinuationQuests(),story=game.getStoryQuests();
  const entries=(quests,category='tutorial')=>quests.map((q,i)=>`<div class="journal-entry ${q.claimed?'complete':q.active?'active':''}"><span class="journal-number">${q.claimed?icon('check'):String(i+1).padStart(2,'0')}</span><div><h3>${esc(q.title)}</h3><p>${esc(q.description)}</p>${q.active?`<small>${Math.min(q.current,q.target)}/${q.target}</small>`:''}${hasCost(q.cost)&&q.active?`<div class="continuation-delivery"><small>交付所需</small>${costMarkup(q.cost)}</div>`:''}</div>${q.active?`<button class="secondary-button" data-action="${q.complete?category==='story'?'story-claim':category==='continuation'?'continuation-claim':'claim':'go-quest'}" data-id="${q.id}" data-category="${category}">${questButtonLabel(q)}</button>`:''}</div>`).join('');
  openSheet('漂流者的航海日志','经营建设 / 继续把家园建起来',`<div class="panel-info"><div><h3>第一章 · 海上家园</h3><p>${game.state.quests.claimed.length} / ${QUESTS.length} 项已完成</p></div>${icon('journal')}</div>${entries(game.getQuests())}<div class="panel-info continuation-heading"><div><h3>海上故事 · 潜向深海</h3><p>${game.state.story.claimed.length} / ${story.length} 项已完成${game.state.completed?'':' · 完成海上家园后开启'}</p></div>${icon('divingDock')}</div>${entries(story,'story')}<div class="panel-info continuation-heading"><div><h3>后续建设 · 物资与工坊</h3><p>${game.state.continuation.claimed.length} / ${followup.length} 项已完成</p></div>${icon('materials')}</div>${entries(followup,'continuation')}`,'journal','journal');
  const side=game.getSideQuests(),ready=side.filter(q=>q.canClaim).length,entry=document.createElement('button');
  entry.className='side-journal-entry';entry.dataset.action='side-journal';
  entry.innerHTML=`${icon('materials')}<span><strong>支线任务 · 生产与储备</strong><small>${game.state.completed?`${side.filter(q=>q.claimed).length} / ${side.length} 已完成${ready?` · ${ready}项奖励可领取`:''}`:'完成海上家园后开启'}</small></span>${icon('arrow')}`;
  $('.sheet-body').prepend(entry);
}
function openSideJournal() {
  const quests=game.getSideQuests();
  openSheet('支线任务','生产与储备 / 积累领袖经验',`<p>累计加工并领取物资，达到目标后领取经验。已入库的产量会保留记录。</p>${quests.map((q,i)=>`<div class="journal-entry side-quest ${q.claimed?'complete':q.active?'active':''}" data-side-id="${q.id}"><span class="journal-number">${q.claimed?icon('check'):i+1}</span><div><h3>${esc(q.title)}</h3><p>${esc(q.description)}</p><small>${Math.min(q.current,q.target)} / ${q.target} <b class="side-xp">EXP +${q.reward.experience}</b></small></div>${q.claimed?'<span class="side-claimed">已领取</span>':q.unlocked?`<button class="secondary-button" data-action="${q.canClaim?'side-claim':'go-quest'}" data-id="${q.id}" data-category="side">${q.canClaim?'领取奖励':'前往'}</button>`:'<span class="side-claimed">待开启</span>'}</div>`).join('')}<button class="secondary-button" data-action="journal">返回航海日志</button>`,'journal','side-journal');
}

function goQuest(id,category) {
  const q=id?(category==='side'?game.getSideQuests():category==='story'?game.getStoryQuests():category==='continuation'?game.getContinuationQuests():game.getQuests()).find(q=>q.id===id):currentQuest(); if(!q)return;
  if(q.followup||category==='continuation'){
    const action=q.action || {};
    if(action.type==='build'){const pending=game.state.buildings.find(b=>b.type===action.buildingType&&b.construction);if(pending)openBuilding(pending.id,true);else openBuild();return;}
    if(action.type==='dive'){enterDiving();return;}
    if(action.type==='progression'){openProgression(action.tab||'heroes');return;}
    if(action.type==='resident-order'){openResidentOrder();return;}
    if(action.type==='upgrade'){const b=game.state.buildings.find(b=>b.type===action.buildingType);if(b)openBuilding(b.id,true);else openBuild();return;}
    if(action.type==='production'){const recipe=game.getRecipes().find(r=>r.id===action.recipeId);openProduction(recipe?.buildingId??null,action.buildingType,action.recipeId);return;}
    if(action.type==='collect-production'){const b=game.state.buildings.find(b=>b.type===action.buildingType);if(b)openBuilding(b.id,true);else openBuild();return;}
    if(action.type==='scavenge'||action.type==='scavenge-upgrade'){enterScavenging();if(action.type==='scavenge-upgrade'&&scavengingUI.visible){game.markScavengingGuideSeen();scavengingUI.showUpgrade();}return;}
    if(action.type==='deliver'){
      const missing=Object.keys(q.cost||{}).find(k=>game.state.resources[k]<q.cost[k]);
      const recipe=missing&&game.getRecipes().find(r=>r.outputs[missing]);
      if(recipe){openProduction(recipe.buildingId,recipe.buildingType,recipe.id);return;}
      if(missing==='water'||missing==='food'){const b=game.state.buildings.find(b=>b.type===(missing==='water'?'purifier':'slicer'));if(b){openBuilding(b.id);return;}}
    }
    openJournal();return;
  }
  const d={fishing:'fishing',slicer:'slicer',purifier:'purifier',scavenger:'scavenger',bed:'bed',farm:'farm',beacon:'beacon'};
  if(d[q.id]) { openBuild(); return; }
  if(q.id==='salvage') { closeSheet(); setMode('normal'); scene.focus(); toast('点击海面上的漂流木和箱子，收集15份木材。'); }
  else if(q.id==='expand') startExpand();
  else if(q.id==='rescue') openExplore();
  else if(q.id==='command') openStorm();
  else if(q.id==='food'&&game.getResidentOrder().canDeliver)openResidentOrder();
  else { const type={fish:'fishing',food:'slicer',water:'purifier'}[q.id]; const b=game.state.buildings.find(b=>b.type===type); if(b){if(type==='fishing')showBuildingActions(b.id);else openBuilding(b.id);} else openBuild(); }
}
function openStorm() {
  const storm=game.getStormStatus();
  const passed=storm.status==='passed';
  openSheet(passed?'风暴过后':'乌云正在靠近',passed?'大家都平安，这就是最好的消息':'修好避难所，给居民留足补给',`<div class="detail-hero"><div class="building-art" style="background:#d4e2dd">${icon(passed?'sun':'storm')}</div><div><h3>${passed?'海面又亮起来了':'一起，把这一夜撑过去'}</h3><p>${passed?'继续建设家园，点亮归航信标。':'风雨会很大，但准备充分就不用怕。<br>升级指挥中心，备好淡水与食物。'}</p></div></div><div class="row"><strong>${icon('command')} 指挥中心</strong><span data-storm-value="command"></span></div><div class="row"><strong>${icon('water')} 淡水储备</strong><span data-storm-value="water"></span></div><div class="row"><strong>${icon('food')} 食物储备</strong><span data-storm-value="food"></span></div><p>度过风暴会消耗 4 份淡水与 4 份食物。准备好后，再带大家躲进避难所。</p><div class="action-row">${storm.commandLevel<2?'<button class="secondary-button" data-action="open-command">修整指挥中心</button>':''}<button class="gold-button ${passed?'green':''}" data-action="face-storm" ${passed||storm.status==='dormant'?'disabled':''}>${passed?'已经平安度过':storm.ready?'迎接风暴':'检查准备'}</button></div>`,'storm','storm');
  updateStormLive();
}
function updateStormLive() {
  const status=game.getStormStatus();
  $('[data-storm-value="command"]').innerHTML=`${status.commandLevel} / 2 级 ${status.commandLevel>=2?icon('check'):''}`;
  for(const key of ['water','food'])$(`[data-storm-value="${key}"]`).innerHTML=`${amount(game.state.resources[key])} / 6 ${game.state.resources[key]>=6?icon('check'):''}`;
  const button=$('[data-action="face-storm"]');
  button.textContent=status.status==='passed'?'已经平安度过':status.ready?'迎接风暴':'检查准备';
}
function openAccount() {
  closeSheet(); hideBuildingActions(); setMode('normal');
  autoFishing=false; fishingRound=null;
  for(const panel of [progressionUI,scavengingUI,productionUI,divingUI])if(panel?.visible)panel.close();
  accountUI.open();
}
function openSettings() {
  const logged=!!accounts.user;
  openSheet('歇一会儿，也没关系','海风会替你守着这里',`<div class="setting-row"><span>${logged?esc(accounts.user.username):'游客营地'}<small>${logged?'账号与云存档':'登录后可在其他设备继续'}</small></span><button class="secondary-button" data-action="account">${logged?'账号管理':'登录 / 注册'}</button></div><div class="setting-row"><span>海上的声音<small>海风、拾荒和建造音效</small></span><button class="secondary-button" data-action="sound">${icon(sound?'sound':'muted')} ${sound?'已开启':'已关闭'}</button></div><div class="setting-row"><span>手动保存<small>${logged?'保存到本机，并尝试同步云端':'自动保存到当前浏览器'}</small></span><button class="secondary-button" data-action="save">保存进度</button></div><div class="setting-row"><span>回到营地<small>重置镜头的位置与缩放</small></span><button class="secondary-button" data-action="focus">重置视角</button></div><div class="setting-row"><span>重新漂流<small>${logged?'重置当前账号营地，并同步云端':'清空本机游客进度，从海上第一天开始'}</small></span><button class="secondary-button danger-button" data-action="confirm-reset">重新开始</button></div><p class="saved-label">${logged?'云存档状态可在账号管理中查看。':'游客进度保存在当前浏览器。'}<br>离开后，设施可累计最多 2 小时的离线产物。</p>`,'gear','settings');
}
function showCompletion() {
  closeSheet(); setMode('normal'); scene.focus();
  openSheet('家园已经安稳，远海还有人等着我们','首段经营完成 / 英雄与远海闯关已开放',`<div class="celebration">${icon('beacon')}<h3>灯亮了，新的信号也来了。</h3><p>电台里传来了被海盗围困的求救声。沿着航道出发，寻找米娅和失散的伙伴。</p><div class="panel-info"><div><h3>${game.state.population.total} 位居民</h3><p>守住家园</p></div><div><h3>${game.state.buildings.length} 座设施</h3><p>提供补给</p></div></div><button class="gold-button" data-action="journal">继续建设家园 ${icon('arrow')}</button><button class="secondary-button" data-action="progression" data-tab="campaign">前往远海救援</button></div>`,'flag','complete');
  for(let i=0;i<38;i++) {const el=document.createElement('i');el.className='confetti';el.style.cssText=`--x:${Math.random()*100}%;--c:${['#ffd265','#d7ecb9','#fb9567','#f8f2d8'][i%4]};--delay:${Math.random()*.7}s`;$('#game').append(el);setTimeout(()=>el.remove(),4200);}
  playTone(830,.1);setTimeout(()=>playTone(1100,.1),160);setTimeout(()=>playTone(1320,.15),320);
}
function showOffline(report) {
  const produced=Object.entries(report.produced||{}).filter(([,n])=>n>0);
  if(produced.length) toast(`欢迎回家。离开期间，设施生产了${produced.map(([k,n])=>`${amount(n)}${names[k]}`).join('、')}，点击建筑领取。`);
}

function toggleSound() {
  sound=!sound; try{localStorage.setItem('fkssj-sound',String(sound));}catch{}
  $('#sound-button').innerHTML=icon(sound?'sound':'muted'); $('#sound-button').setAttribute('aria-label',sound?'关闭声音':'开启声音');
  if(sound) { startAmbient(); playTone(520); } else { ambient?.stop?.(); ambient=null; }
  if(modal==='settings')openSettings();
}
function getAudio() { if(!audioContext)audioContext=new (window.AudioContext||window.webkitAudioContext)(); if(audioContext.state==='suspended')audioContext.resume(); return audioContext; }
function playTone(freq=600,duration=.07) { if(!sound)return;try{const ctx=getAudio(),osc=ctx.createOscillator(),gain=ctx.createGain();osc.type='sine';osc.frequency.setValueAtTime(freq,ctx.currentTime);osc.frequency.exponentialRampToValueAtTime(freq*.65,ctx.currentTime+duration);gain.gain.setValueAtTime(.08,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+duration);osc.connect(gain).connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+duration);}catch{} }
function startAmbient() { if(!sound||ambient)return;try{const ctx=getAudio(),buffer=ctx.createBuffer(1,ctx.sampleRate*4,ctx.sampleRate),data=buffer.getChannelData(0);let previous=0;for(let i=0;i<data.length;i++){previous=(previous+Math.random()*.02-.01)/1.008;data[i]=previous*2*(.7+.3*Math.sin(i/data.length*Math.PI*4));}const source=ctx.createBufferSource(),filter=ctx.createBiquadFilter(),gain=ctx.createGain();source.buffer=buffer;source.loop=true;filter.type='lowpass';filter.frequency.value=700;gain.gain.value=.16;source.connect(filter).connect(gain).connect(ctx.destination);source.start();ambient=source;}catch{} }

document.addEventListener('click',e=> {
  if(accountUI?.visible)return;
  if(!accounts.canPlay&&!e.target.closest('[data-action="account"],#account-button')){openAccount();return;}
  if(progressionUI?.visible||productionUI?.visible||divingUI?.visible||scavengingUI?.visible)return;
  if(introOpen&&!e.target.closest('[data-action="intro-next"],[data-action="intro-skip"]'))return;
  const nav=e.target.closest('[data-nav]');
  if(nav){const key=nav.dataset.nav;document.querySelectorAll('[data-nav]').forEach(el=>el.classList.toggle('active',el===nav));if(key==='camp'){setMode('normal');scene.focus();}else({build:openBuild,people:openPeople,explore:openExplore,bag:openBag}[key])();return;}
  const button=e.target.closest('[data-action]');if(!button||button.disabled)return;
  const {action,id,type}=button.dataset;
  if(action==='intro-skip')finishIntro();
  else if(action==='intro-next'){if(introStep<introLines.length-1){introStep++;renderIntro();}else finishIntro();}
  else if(action==='resident-order')openResidentOrder();
  else if(action==='order-supplies')goOrderSupplies(button.dataset.resource);
  else if(action==='progression')openProgression(button.dataset.tab||'campaign');
  else if(action==='deliver-order')deliverOrder(id);
  else if(action==='fishing-enter')enterFishing(id);
  else if(action==='fishing-upgrade-from-camp')openBuilding(id,true);
  else if(action==='close')closeSheet();
  else if(action==='go-quest')goQuest(id,button.dataset.category);
  else if(action==='claim'){const wasJournal=modal==='journal';const result=act(game.claimQuest(id));if(wasJournal&&result.ok&&!result.completed)openJournal();}
  else if(action==='choose-build')chooseBuild(type);
  else if(action==='expand')startExpand();
  else if(action==='journal')openJournal();
  else if(action==='side-journal')openSideJournal();
  else if(action==='side-claim'){const result=act(game.claimSideQuest(id));if(result.ok)openSideJournal();}
  else if(action==='collect-production')act(game.collectProduction(id));
  else if(action==='cast'){const target=fishingId||selectedBuilding;enterFishing(target);castFishing();}
  else if(action==='worker-plus'||action==='worker-minus')act(game.assignWorker(id,action==='worker-plus'?1:-1));
  else if(action==='upgrade'){const result=act(game.upgradeBuilding(id));if(result.ok)openBuilding(id,true);}
  else if(action==='fishing-cast')castFishing();
  else if(action==='fishing-exit'){closeSheet();exitFishing();}
  else if(action==='fishing-upgrade')openBuilding(fishingId,true);
  else if(action==='fishing-catches')openFishingCatches();
  else if(action==='fishing-production')act(game.collectProduction(fishingId));
  else if(action==='fishing-auto'){autoFishing=!autoFishing;if(fishingRound)fishingRound.automatic=autoFishing;updateFishingLive();if(autoFishing&&!fishingRound)castFishing(true);}
  else if(action==='fishing-claim'){const result=act(claimTask(id,button.dataset.category));if(result.ok){closeSheet();exitFishing();scene?.focus();}}
  else if(action==='scavenging-enter')enterScavenging();
  else if(action==='diving-enter')enterDiving();
  else if(action==='story-claim'){const wasJournal=modal==='journal';const result=act(game.claimStoryQuest(id));if(result.ok&&wasJournal)openJournal();}
  else if(action==='production')openProduction(id,type);
  else if(action==='continuation-claim'){const wasJournal=modal==='journal';const result=act(game.claimContinuationQuest(id));if(result.ok&&wasJournal)openJournal();}
  else if(action==='rescue'){if(!game.state.buildings.some(b=>b.type==='scavenger')){openBuild();return;}const result=act(game.explore());if(result.ok){openExplore();scene.focus();}}
  else if(action==='storm')openStorm();
  else if(action==='open-command')openBuilding(game.state.buildings.find(b=>b.type==='command').id);
  else if(action==='face-storm'){const result=act(game.faceStorm());if(result.ok){closeSheet();scene.focus();setTimeout(()=>toast('风暴过去了。每个人，都平安。'),4500);}}
  else if(action==='sound')toggleSound();
  else if(action==='account')openAccount();
  else if(action==='save'){act(game.save());accounts.syncNow().then(()=>{if(accounts.phase==='synced')toast('进度已同步到云端。');}).catch(error=>toast(error.userMessage));}
  else if(action==='focus'){closeSheet();scene.focus();}
  else if(action==='confirm-reset')openSheet('重新出发？',accounts.user?'这会重置当前账号的营地，并同步云端':'这会清除当前浏览器里的游客营地',`<p>木筏、居民、资源与航海日志都会回到最初。确定要重新开始这段旅程吗？</p><div class="action-row"><button class="secondary-button" data-action="settings">保留我的家园</button><button class="gold-button" data-action="reset">重新开始</button></div>`,'anchor','reset');
  else if(action==='settings')openSettings();
  else if(action==='reset'){act(game.reset());setMode('normal');scene.focus();showIntro();}
});
document.addEventListener('keydown',e=>{if(accountUI?.visible||!accounts.canPlay)return;if(scavengingUI?.visible||productionUI?.visible||divingUI?.visible)return;if(introOpen){if(e.key==='Escape')finishIntro();if(e.key==='Tab'){e.preventDefault();(document.activeElement===$('#dialogue-next')?$('.intro-skip'):$('#dialogue-next')).focus();}return;}if(e.key==='Escape'){if(modal){closeSheet();return;}hideBuildingActions();setMode('normal');}});
document.addEventListener('pointerdown',e=>{if(actionBuilding&&!e.target.closest('#building-actions'))hideBuildingActions();});
document.addEventListener('pointerdown',()=>{if(sound)startAmbient();},{once:true});
$('#captain-button').onclick=openPeople;
$('#settings-button').onclick=()=>accounts.canPlay?openSettings():openAccount();
$('#account-button').onclick=openAccount;
$('#sound-button').onclick=toggleSound;
$('#expand-button').onclick=startExpand;
$('#quest-button').onclick=openJournal;
$('#storm-button').onclick=openStorm;
function openProgression(tab) {if(introOpen||scavengingUI?.visible||productionUI?.visible||divingUI?.visible)return;setMode('normal');progressionUI?.open(tab);}
$('#heroes-button').onclick=()=>openProgression('heroes');
$('#campaign-button').onclick=()=>openProgression('campaign');
$('#cancel-mode').onclick=()=>setMode('normal');
$('#focus-button').onclick=()=>scene.focus();
$('#zoom-in').onclick=()=>scene.zoom(.16);
$('#zoom-out').onclick=()=>scene.zoom(-.16);

setupIcons();
accountUI=new AccountUI($('#account-root'),{manager:accounts,notify:toast,onToggle:paused=>{scene?.setPaused?.(paused||!accounts.canPlay);if(!paused)setTimeout(showIntro,0);}});
accounts.subscribe(state=>{
  const labels={guest:'游客 · 登录',checking:'连接中',synced:'云端已保存',pending:'等待同步',offline:'离线 · 本机保存',conflict:'存档待选择',expired:'请重新登录',error:'存档需检查'};
  $('#account-button').textContent=labels[state.phase]||'账号';
  $('#account-button').setAttribute('aria-label',`${state.user?.username||'游客'}，${labels[state.phase]}，账号管理`);
  $('#account-button').dataset.phase=state.phase;
  if((['conflict','expired','error'].includes(state.phase)||accounts.needsRemote)&&!accountUI.visible&&!introOpen)openAccount();
});
window.addEventListener('online',()=>accounts.syncNow().catch(()=>{}));
progressionUI=new ProgressionUI($('#progression-root'),{game,notify:toast,onToggle:paused=>{scene?.setPaused?.(paused);}});
scavengingUI=new ScavengingUI($('#scavenging-root'),{game,notify:toast,onToggle:paused=>{scene?.setPaused?.(paused);updateGuide();updateResidentDemand();}});
divingUI=new DivingUI($('#diving-root'),{game,notify:toast,onToggle:paused=>{scene?.setPaused?.(paused);updateGuide();updateResidentDemand();}});
productionUI=new ProductionUI($('#production-root'),{game,notify:toast,onToggle:paused=>{scene?.setPaused?.(paused);updateGuide();updateResidentDemand();},onBuild:chooseBuild,onScavenge:enterScavenging,onDive:enterDiving,onManage:id=>openBuilding(id,true),onFish:()=>{const b=game.state.buildings.find(b=>b.type==='fishing');if(b)enterFishing(b.id);else chooseBuild('fishing');}});
try {
  scene=new RaftScene($('#world'),{
    onReady:()=>{document.body.classList.add('ready');showIntro();},
    onCollect:(kind,position)=>{if(!accounts.canPlay||accountUI.visible||modal||fishingId||introOpen||progressionUI.visible||scavengingUI.visible||productionUI.visible||divingUI.visible)return;const result=game.collect(kind);if(result.ok){rewardFloat(result.resources,position);playTone(480+Math.random()*190);}},
    onBuilding:(id)=>{if(accounts.canPlay&&!accountUI.visible&&mode==='normal'&&!fishingId&&!introOpen&&!modal&&!progressionUI.visible&&!scavengingUI.visible&&!productionUI.visible&&!divingUI.visible)showBuildingActions(id);},
    onTile:(x,z)=> {
      if(!accounts.canPlay||accountUI.visible||modal||fishingId||introOpen||progressionUI.visible||scavengingUI.visible||productionUI.visible||divingUI.visible)return;
      if(mode==='expand')act(game.expand(x,z));
      else if(mode==='build'){const result=act(game.placeBuilding(buildType,x,z));if(result.ok){setMode('normal');if(result.building.construction){openBuilding(result.building.id,true);}else toast(`${BUILDINGS[result.building.type].name}建好了。点击设施开始使用。`);}}
      else toast('这里可以建造设施。打开下方“建造”试试。');
    }
  });
  game.onChange(render);
  // Keep game time tied to visible wall time. Hidden pages accrue production through load().
  let last=performance.now();
  setInterval(()=>{const now=performance.now(),dt=(now-last)/1000;last=now;if(!document.hidden&&accounts.canPlay&&!accountUI.visible){game.tick(Math.min(dt,2));advanceFishing(Math.min(dt,2));positionBuildingActions();progressionUI.tick(Math.min(dt,2));}},250);
  setInterval(()=>{if(accounts.canPlay&&!accountUI.visible&&autoFishing&&fishingId&&!fishingRound&&!modal&&!document.hidden&&game.state.elapsed-game.state.fishing.lastCastAt>=2.5)castFishing(true);},300);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){autoFishing=false;fishingRound=null;progressionUI.suspend();scavengingUI.suspend();divingUI.suspend();game.save();accounts.syncNow().catch(()=>{});audioContext?.suspend();}else{if(accounts.canPlay)game.load();last=performance.now();if(sound)audioContext?.resume();}});
  window.addEventListener('pagehide',()=>{autoFishing=false;fishingRound=null;progressionUI.suspend();scavengingUI.suspend();divingUI.suspend();game.save();});
  setTimeout(()=>{
    document.body.classList.add('ready');
    showIntro();
    if(game.state.offlineReport)showOffline(game.state.offlineReport);
    if(game.storageError)toast(game.storageError);
  },1000);
} catch(error) {
  console.error(error); document.body.classList.add('ready');
  $('#world').innerHTML='<div class="webgl-error"><h2>营地暂时无法显示</h2><p>请开启浏览器的图形加速，再刷新页面。<br>你的游戏进度会保留。</p></div>';
  toast('3D 场景未能启动，请尝试更新浏览器或开启图形加速。');
}

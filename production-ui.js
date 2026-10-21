import { BUILDINGS } from './game-state.js';
import { icon } from './icons.js';
import { CRAFT_RESOURCE_NAMES, PRODUCTION_CONFIG } from './production-state.js';

const factories = ['slicer', 'materials', 'construction', 'tailor', 'seafoodKitchen', 'dailyFactory'];
const names = {food:'生鱼片',wood:'木材',plastic:'塑料',cloth:'碎布',scrap:'废金属',coin:'金币',fish:'鲜鱼',seaweed:'海藻',glass:'玻璃',...CRAFT_RESOURCE_NAMES};
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => Math.floor(value || 0).toLocaleString('zh-CN');
const duration = value => {const s=Math.max(0,Math.ceil(value||0));return s>=60?`${Math.floor(s/60)}分${s%60?`${s%60}秒`:''}`:`${s}秒`;};

/** Factory selection, queue and recipe UI. The domain owns inventory and time. */
export class ProductionUI {
  constructor(container,{game,notify=()=>{},onToggle=()=>{},onBuild=()=>{},onScavenge=()=>{},onDive=()=>{},onManage=()=>{},onFish=()=>{}}) {
    Object.assign(this,{el:container,game,notify,onToggle,onBuild,onScavenge,onDive,onManage,onFish}); this.visible=false;this.quantity=1;
    this.el.addEventListener('click',e=>this.handle(e));
    this.el.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();this.close();}});
  }
  open(buildingId=null,type=null) {
    const building=this.game.state.buildings.find(b=>b.id===buildingId&&factories.includes(b.type));
    this.type=building?.type || type || this.type || factories.find(t=>this.game.state.buildings.some(b=>b.type===t)) || factories[0];
    const available=this.game.getRecipes().filter(r=>r.buildingType===this.type);
    this.buildingId=building?.id || available.find(r=>r.unlocked)?.buildingId || available.find(r=>r.buildingId)?.buildingId || null;
    this.recipeId=null;this.quantity=1;
    if(!this.visible){this.lastFocus=document.activeElement;this.visible=true;this.el.hidden=false;this.inertSiblings=[...this.el.parentElement.children].filter(n=>n!==this.el&&n.id!=='toast').map(n=>[n,n.inert]);this.inertSiblings.forEach(([n])=>n.inert=true);document.body.classList.add('production-view');this.onToggle(true);}
    this.render();this.el.querySelector('[data-factory-action="close"]')?.focus({preventScroll:true});
  }
  recipes(){return this.game.getRecipes(this.buildingId).filter(r=>r.buildingType===this.type);}
  render() {
    if(!this.visible)return;
    const definition=BUILDINGS[this.type],building=this.game.state.buildings.find(b=>b.id===this.buildingId),recipes=this.recipes();
    if(!recipes.some(r=>r.id===this.recipeId))this.recipeId=recipes[0]?.id;
    const recipe=recipes.find(r=>r.id===this.recipeId);
    this.lastBuildingStage=`${building?.level||0}/${building?.construction?.kind||''}`;
    this.el.innerHTML=`<div class="factory-shade"><section class="factory-window" role="dialog" aria-modal="true" aria-label="${definition.name}"><header class="factory-heading"><button data-factory-action="close" aria-label="返回营地">${icon('arrow')}</button><div><h2>${definition.name} ${building?`<small>${building.level}级</small>`:''}</h2><p>安排生产，把漂流物变成生活物资</p></div><span>${icon(this.type)}</span></header><nav class="factory-tabs" aria-label="切换工厂">${factories.map(t=>`<button data-factory-action="factory" data-type="${t}" class="${t===this.type?'selected':''}" aria-pressed="${t===this.type}">${icon(t)}<span>${BUILDINGS[t]?.name || t}</span>${this.game.state.buildings.some(b=>b.type===t)?'':`<small>待建造</small>`}</button>`).join('')}</nav>${building?`<div class="factory-scroll"><section class="factory-line"><div class="factory-label"><strong>生产队列 · ${PRODUCTION_CONFIG.queueSlots}格</strong><small>原料入队时扣除 · 完成后领取</small></div><div class="factory-queue" id="factory-queue"></div><div id="factory-legacy-stock"></div></section><section class="factory-recipes"><div class="factory-label"><strong>选择产品</strong><small>点选查看原料</small></div><div class="factory-recipe-grid">${recipes.map(r=>`<button data-factory-action="recipe" data-id="${r.id}" class="${r.id===this.recipeId?'selected':''} ${!r.unlocked?'locked':''}" aria-pressed="${r.id===this.recipeId}">${icon(Object.keys(r.outputs)[0])}<strong>${esc(r.name)}</strong><small>${r.unlocked?duration(r.seconds):esc(r.reason)}</small></button>`).join('')}</div></section><section class="factory-detail" id="factory-detail"></section></div><footer class="factory-footer"><div class="factory-batch"><span>批次数量</span><div><button data-factory-action="minus" aria-label="减少生产数量">−</button><strong id="factory-quantity">${this.quantity}</strong><button data-factory-action="plus" aria-label="增加生产数量">+</button></div></div><button class="factory-produce" data-factory-action="produce" id="factory-produce">生产</button></footer>`:`<div class="factory-build"><div class="factory-building-art">${icon(this.type)}</div><h3>安置${definition.name}</h3><p>${esc(definition.description)}</p><div class="factory-cost">${this.costHTML(definition.cost)}</div><button class="factory-produce" data-factory-action="build">前往建造</button><small>需要一块空闲浮台</small></div>`}<div class="factory-status" id="factory-status" role="status"></div></section></div>`;
    if(['slicer','seafoodKitchen'].includes(building?.type)){
      const management=document.createElement('button');management.className='factory-manage';management.dataset.factoryAction='manage';
      management.innerHTML=`${icon(building.type)} ${building.type==='slicer'?'设施管理 · 升级':'厨房管理 · 升级设施'} ${icon('arrow')}`;
      this.el.querySelector('.factory-scroll')?.prepend(management);
    }
    if(building?.construction){const pending=document.createElement('div');pending.className='factory-construction';pending.innerHTML=`<span>${icon('hammer')} 升级施工中 · <b data-factory-construction-time></b></span><small>烤鱼照常加工，竣工后开放海藻汁。</small>`;this.el.querySelector('.factory-scroll')?.prepend(pending);}
    const tabs=this.el.querySelector('.factory-tabs'),selected=tabs?.querySelector('.selected');
    if(selected)tabs.scrollLeft=selected.offsetLeft-tabs.offsetLeft-(tabs.clientWidth-selected.clientWidth)/2;
    this.lastQueueStructure=null;this.lastDetailMarkup=null;this.update();
  }
  costHTML(cost){return Object.entries(cost||{}).map(([key,value])=>`<span class="${this.game.state.resources[key]<value?'short':''}">${icon(key)}<strong>${number(this.game.state.resources[key])}/${number(value)}</strong><small>${names[key]||key}</small></span>`).join('');}
  update() {
    if(!this.visible||!this.buildingId)return;
    const building=this.game.state.buildings.find(b=>b.id===this.buildingId),construction=this.game.getConstruction(this.buildingId);
    if(this.lastBuildingStage!==`${building?.level||0}/${construction?.kind||''}`){this.render();return;}
    const timer=this.el.querySelector('[data-factory-construction-time]');if(timer)timer.textContent=duration(construction?.remaining);
    const queue=this.game.getProductionQueue(this.buildingId),el=this.el.querySelector('#factory-queue');
    const signature=queue.map(j=>`${j.id}/${j.status}`).join('|');
    if(signature!==this.lastQueueStructure){
      el.innerHTML=queue.map(j=>`<button class="factory-job ${j.status}" data-factory-action="collect" data-id="${j.id}" aria-label="${esc(j.name)} ${j.quantity}份 ${j.canClaim?'领取成品':j.status==='queued'?'等待生产':'生产中'}" ${j.canClaim?'':'disabled'}><span>${icon(Object.keys(j.outputs)[0])}<b>×${Object.values(j.outputs)[0]}</b></span><strong>${j.canClaim?'领取':j.status==='queued'?'等待生产':'生产中'}</strong><small data-job-time="${j.id}"></small><i><em data-job-progress="${j.id}"></em></i></button>`).join('')+Array.from({length:Math.max(0,PRODUCTION_CONFIG.queueSlots-queue.length)},()=>'<div class="factory-job empty"><span>＋</span><small>空闲队列</small></div>').join('');this.lastQueueStructure=signature;
    }
    for(const job of queue){const timer=this.el.querySelector(`[data-job-time="${job.id}"]`),bar=this.el.querySelector(`[data-job-progress="${job.id}"]`);if(timer)timer.textContent=job.canClaim?'完成':duration(job.remaining);if(bar)bar.style.width=`${Math.round(job.progress*100)}%`;}
    const legacy=this.el.querySelector('#factory-legacy-stock'),legacyAmount=building?.type==='slicer'?Math.floor(building.stored||0):0;
    const legacyMarkup=legacyAmount>0?`<button class="factory-legacy-claim" data-factory-action="collect-legacy">${icon('food')} 已备好的生鱼片 <b>×${legacyAmount}</b><strong>领取</strong></button>`:'';
    if(legacy&&legacy.innerHTML!==legacyMarkup)legacy.innerHTML=legacyMarkup;
    const recipe=this.recipes().find(r=>r.id===this.recipeId);if(!recipe)return;
    const outputKey=Object.keys(recipe.outputs)[0],cost=Object.fromEntries(Object.entries(recipe.inputs).map(([k,n])=>[k,n*this.quantity]));
    const storageFull=recipe.reserved>=recipe.storage;
    const canAfford=Object.entries(cost).every(([k,n])=>this.game.state.resources[k]>=n),full=queue.length>=PRODUCTION_CONFIG.queueSlots;
    const credit=recipe.id==='sashimi'?Math.min(90,building?.legacySlicerProgress||0):0;
    const details=`<div class="factory-product">${icon(outputKey)}<div><h3>${esc(recipe.name)}</h3>${recipe.referenceStatus==='provisional'?'<small class="factory-reference-note">暂用配方 · 原版数值待核实</small>':''}<small>背包 ${number(this.game.state.resources[outputKey])} · 厂内待领 ${recipe.stored || 0} · 容量 ${recipe.reserved || 0}${recipe.storage?` / ${recipe.storage}`:''}</small><p>${esc(recipe.description||'为营地居民准备物资')}</p></div></div><div class="factory-ingredients"><span>生产所需</span><div class="factory-cost">${this.costHTML(cost)}</div></div><div class="factory-duration">${icon('clock')} 预计 ${duration(recipe.seconds*this.quantity-credit)} · 产出 ${number(Object.values(recipe.outputs)[0]*this.quantity)} 份</div>${credit?`<p class="factory-work-credit">已保留 ${duration(credit)} 工时，下一批可接着做</p>`:''}${!recipe.unlocked?`<p class="factory-reason">${esc(recipe.reason)}</p>`:!canAfford?(['seaweed','glass','scrap'].some(k=>cost[k]&&this.game.state.resources[k]<cost[k])?'<button class="factory-missing" data-factory-action="dive">潜水原料不足，去海底收集 ›</button>':cost.fish&&this.game.state.resources.fish<cost.fish?'<button class="factory-missing" data-factory-action="fish">鲜鱼不足，去钓鱼 ›</button>':'<button class="factory-missing" data-factory-action="scavenge">原料不够，去海域拾荒 ›</button>'):full?'<p class="factory-reason">队列已满，领取成品后再安排生产</p>':storageFull?'<p class="factory-reason">成品与已排生产占满容量，等待完成并领取后可继续</p>':''}`;
    const detail=this.el.querySelector('#factory-detail');if(this.lastDetailMarkup!==details){detail.innerHTML=details;this.lastDetailMarkup=details;}
    const button=this.el.querySelector('#factory-produce');const capacityBlocked=canAfford&&!full&&this.quantity>recipe.maxQuantity;button.disabled=!recipe.unlocked||!canAfford||full||capacityBlocked;button.textContent=full?'队列已满':!recipe.unlocked?'尚未解锁':!canAfford?'原料不足':capacityBlocked?(storageFull?'容量已满':'减少生产数量'):`生产 ×${this.quantity}`;
    this.el.querySelector('#factory-quantity').textContent=this.quantity;
    this.el.querySelector('[data-factory-action="minus"]').disabled=this.quantity<=1;this.el.querySelector('[data-factory-action="plus"]').disabled=this.quantity>=PRODUCTION_CONFIG.maxQuantity;
  }
  sync(state,event={}){if(!this.visible)return;if(event.type==='reset'){this.close();return;}if(event.type==='load'){this.open(this.buildingId,this.type);return;}this.update();}
  handle(event){if(event.target.classList.contains('factory-shade')){this.close();return;}const button=event.target.closest('[data-factory-action]');if(!button||button.disabled)return;const a=button.dataset.factoryAction;
    if(a==='close')this.close();
    else if(a==='factory')this.open(null,button.dataset.type);
    else if(a==='recipe'){this.recipeId=button.dataset.id;this.quantity=1;this.render();}
    else if(a==='minus'||a==='plus'){this.quantity=Math.max(1,Math.min(PRODUCTION_CONFIG.maxQuantity,this.quantity+(a==='plus'?1:-1)));this.update();}
    else if(a==='build'){const t=this.type;this.close();this.onBuild(t);}
    else if(a==='scavenge'){this.close();this.onScavenge();}
    else if(a==='dive'){this.close();this.onDive();}
    else if(a==='manage'){const id=this.buildingId;this.close();this.onManage(id);}
    else if(a==='fish'){this.close();this.onFish();}
    else if(a==='collect-legacy'){const result=this.game.collectProduction(this.buildingId);this.notify(result.message);this.update();this.el.querySelector('#factory-status').textContent=result.message;}
    else if(a==='produce'||a==='collect'){const result=a==='produce'?this.game.queueProduction(this.recipeId,this.quantity,this.buildingId):this.game.claimQueuedProduction(button.dataset.id);this.notify(result.message);this.update();this.el.querySelector('#factory-status').textContent=result.message;}
  }
  close(){if(!this.visible)return;this.visible=false;this.el.hidden=true;this.el.innerHTML='';this.inertSiblings?.forEach(([n,before])=>n.inert=before);this.inertSiblings=[];document.body.classList.remove('production-view');this.onToggle(false);if(this.lastFocus?.isConnected)this.lastFocus.focus({preventScroll:true});}
}

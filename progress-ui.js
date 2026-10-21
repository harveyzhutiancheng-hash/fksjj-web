import { ProgressState, HEROES } from './progress-state.js';
import { BattleView } from './battle-view.js';
import { CampaignView } from './campaign-view.js';
import { icon } from './icons.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = value => {const s=Math.floor(Math.max(0,Number(value)||0));return [Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(v=>String(v).padStart(2,'0')).join(':');};
const count = value => Math.floor(Math.max(0, Number(value)||0)).toLocaleString('zh-CN');
const jobs = {tank:'坦克',warrior:'战士',mage:'法师',ranger:'射手'};
const tiers = {common:'普通',rare:'稀有',legendary:'传说'};
const supplies = {tickets:'普通招募券',legendTickets:'传说招募券',heroExp:'英雄经验',coin:'培养金币',essence:'进阶精华',shards:'英雄碎片'};
const tabs = [['campaign','闯关','compass'],['heroes','英雄','people'],['formation','布阵','flag'],['recruit','招募','ship']];

function art(hero, mini=false) {
  const n=hero.id, female=['mia','mechanic'].includes(n),skin='#ecc39b',ink='#213354';
  const hair={mia:'#674b3e',yilong:'#26374a',lei:'#e3e8e1',sam:'#c99b61',rambo:'#262f39',wizard:'#514b68',loyal:'#45545d',mechanic:'#9d6c43'}[n]||'#4c5a6a';
  const shirt=hero.color||'#7ba4b1';
  let hat=n==='lei'?'<path d="m15 24-7-9 12 1-2-11 13 5 7-8 5 13 12-4 3 14" fill="#e7ede3"/>':n==='sam'?'<path d="M11 31V17l12-5 9 4 15-5 12 11v9" fill="#c99b61"/>':n==='wizard'?'<path d="m12 32 10-23 17 8 14 18" fill="#51466e"/>':n==='loyal'?'<path d="M11 27V15l18-7 25 8 4 11Z" fill="#587e82"/><path d="m11 27 48 0-10 7H13Z" fill="#314c5d"/>':n==='mechanic'?'<circle cx="12" cy="25" r="10" fill="#a1744c"/><circle cx="58" cy="25" r="10" fill="#a1744c"/>':`<path d="M12 34 8 20l11 2 2-12 10 6 10-8 5 13 10-2 2 17" fill="${hair}"/>`;
  const face=n==='sam'?'<path d="M15 36h18l2 10H16Zm23 0h17l-1 10H38Z" fill="#283d51"/><path d="M32 39h7"/>':n==='lei'?'<circle cx="24" cy="40" r="8" fill="#a6d0d7"/><circle cx="46" cy="40" r="8" fill="#a6d0d7"/><path d="M32 40h6"/>':'<path d="m19 37 10-2m12 0 10 2"/><ellipse cx="24" cy="42" rx="2" ry="3" fill="#213354"/><ellipse cx="46" cy="42" rx="2" ry="3" fill="#213354"/>';
  const extra=n==='rambo'?'<path d="M12 29h45v7H12Z" fill="#d85747"/><path d="m55 31 12 9-12-3" fill="#d85747"/>':n==='mechanic'?'<rect x="15" y="24" width="39" height="11" rx="4" fill="#576b79"/><circle cx="24" cy="29" r="5" fill="#c5d5cd"/><circle cx="45" cy="29" r="5" fill="#c5d5cd"/>':'';
  const weapon=hero.job==='ranger'?'<path d="m52 69 15-8 6 11-17 6Z" fill="#596f7c"/><path d="m62 65 8-12 4 2-5 13" fill="#9eaaad"/>':hero.job==='mage'||hero.job==='support'?'<path d="m59 98 5-58" stroke="#b29061" stroke-width="5"/><path d="m64 36 8 9-7 8-8-8Z" fill="#9dcbda"/>':'<path d="m57 94 6-31" stroke="#6a8292" stroke-width="9"/><path d="m55 68 16 3" stroke="#d4bc7c" stroke-width="5"/>';
  return `<svg viewBox="0 0 80 108" aria-hidden="true" class="hero-illustration ${mini?'mini':''}"><g stroke="${ink}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 104V80c0-19 52-19 52 0l4 24Z" fill="${shirt}"/><path d="m19 72 16 14 17-14-7 25H27Z" fill="#e8d5ad"/><path d="m28 67 0 12 9 6 8-9-2-11" fill="${skin}"/>${weapon}<ellipse cx="35" cy="42" rx="25" ry="29" fill="${skin}"/><path d="m50 25 9 10-2 23-17 12 10-17Z" fill="#c69a78" stroke="none"/>${hat}${extra}${face}${female?'<path d="m28 56 11 1-4 4Z" fill="#bf6c65"/>':'<path d="m23 56 12 4 13-5-7 11-12-1Z" fill="#fff1ce"/>'}<path d="m35 43-2 9 6 1" fill="none"/>${female?'':`<path d="m18 51 6 7 10 5 13-7 8-6-6 15-13 8-15-8Z" fill="${hair}"/>`}<path d="M15 88v15m36-15 1 15" fill="none"/></g></svg>`;
}

const rewardHTML = reward => Object.entries(reward||{}).filter(([,n])=>n>0).map(([key,n])=>`<span class="p-supply" title="${supplies[key]||key}">${icon(key==='coin'?'coin':key.includes('Tickets')||key==='tickets'?'journal':key==='heroExp'?'flag':'gem')}<b>${count(n)}</b><small>${supplies[key]||key}</small></span>`).join('');

export class ProgressionUI {
  constructor(container,{game,notify=()=>{},onToggle=()=>{}}) {
    this.el=container;this.game=game;this.engine=new ProgressState(game);this.notify=notify;this.onToggle=onToggle;
    this.visible=false;this.tab='campaign';this.filter='all';this.selectedStage=null;this.detail=null;this.formationTarget=null;this.recruitPool='normal';this.draws=null;this.speed=1;this.auto=false;this.autoTimer=null;
    this.el.addEventListener('click',e=>this.handle(e));
    document.addEventListener('keydown',e=>{if(this.visible&&e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(this.detail||this.draws||this.idleOpen||this.stageInfo){this.detail=null;this.draws=null;this.idleOpen=false;this.stageInfo=false;this.render();}else this.close();}},true);
  }
  get unlocked(){return this.game.state.storm.status==='passed'||this.game.state.completed;}
  get data(){return this.game.state.progression;}
  open(tab='campaign') {
    if(!this.unlocked){this.notify('修好指挥中心、渡过第一次风暴后，开放英雄与远海闯关。');return false;}
    this.visible=true;this.tab=tab;this.el.hidden=false;document.body.classList.add('progression-view');this.onToggle(true);this.render();return true;
  }
  commitBattleTime() {const b=this.data.battle;if(b?.phase==='playing'&&this.battleView?.battle?.id===b.id&&this.battleView.time>b.time)this.engine.advanceBattle(this.battleView.time-b.time);}
  suspend() {this.commitBattleTime();clearTimeout(this.autoTimer);this.auto=false;if(this.visible)this.updateBattleControls();}
  close() {this.commitBattleTime();this.visible=false;clearTimeout(this.autoTimer);this.auto=false;this.battleView?.dispose();this.battleView=null;this.campaignView?.dispose();this.campaignView=null;this.el.hidden=true;this.el.innerHTML='';document.body.classList.remove('progression-view');this.onToggle(false);this.game.save();}
  sync(state,event={}) {
    if(!this.visible)return;
    if(event.type==='reset'){this.close();return;}
    this.el.querySelectorAll('[data-wallet]').forEach(el=>el.textContent=count(this.data.wallet[el.dataset.wallet]));
    if(event.type==='load'){const tab=this.tab;this.battleView?.dispose();this.battleView=null;this.tab=tab;this.render();}
    if(this.tab==='battle')this.updateBattleControls();
    if(this.tab==='campaign'){const t=this.el.querySelector('#campaign-idle-clock');if(t)t.textContent=clock(this.engine.getIdle().seconds);}
    if(this.idleOpen){const idle=this.engine.getIdle(),pending=this.el.querySelector('#idle-pending'),clock=this.el.querySelector('#idle-clock'),claim=this.el.querySelector('[data-p-action="idle-claim"]');if(pending)pending.innerHTML=rewardHTML(idle.pending);if(clock)clock.textContent=`已累计 ${Math.floor(idle.seconds/60)} 分 ${idle.seconds%60} 秒 / 最多 2 小时`;if(claim)claim.disabled=!idle.canClaim;}
  }
  tick(dt) {
    if(!this.visible||this.tab!=='battle'||!this.battleView||document.hidden)return;
    const b=this.data.battle;
    if(b?.phase==='playing')this.commitBattleTime();
    this.updateBattleControls();
  }
  render() {
    if(!this.visible)return;
    this.commitBattleTime();this.battleView?.dispose();this.battleView=null;this.campaignView?.dispose();this.campaignView=null;this.detail=null;this.draws=null;this.idleOpen=false;this.stageInfo=false;
    this.el.innerHTML=`<section class="progress-shell ${this.tab==='campaign'?'campaign-shell':''}" aria-label="远海救援"><header class="progress-header"><button data-p-action="close" aria-label="返回营地">${icon('arrow')}</button><div><small>海上家园 / 远海救援</small><h2>${this.tab==='battle'?'战斗':tabs.find(t=>t[0]===this.tab)?.[1]||'远海'}</h2></div><span class="progress-stage-count">${this.data.campaign.highestCleared} / 40</span></header><div class="progress-wallet">${['coin','heroExp','tickets','essence'].map(k=>`<span title="${supplies[k]}">${icon(k==='coin'?'coin':k==='heroExp'?'flag':k==='essence'?'gem':'journal')}<b data-wallet="${k}">${count(this.data.wallet[k])}</b><small>${k==='legendTickets'?'传说券':k==='tickets'?'招募券':k==='heroExp'?'经验':k==='coin'?'培养币':'精华'}</small></span>`).join('')}</div><div class="progress-content" id="progress-content"></div><nav class="progress-tabs">${tabs.map(([id,label,i])=>`<button class="${this.tab===id?'active':''}" data-p-action="tab" data-tab="${id}">${icon(i)}<strong>${label}</strong></button>`).join('')}</nav><div id="progress-modal"></div></section>`;
    const content=this.el.querySelector('#progress-content');
    if(this.tab==='heroes')content.innerHTML=this.heroesHTML();
    else if(this.tab==='formation')content.innerHTML=this.formationHTML();
    else if(this.tab==='recruit')content.innerHTML=this.recruitHTML();
    else if(this.tab==='battle'){this.mountBattle(content);return;}
    else {content.innerHTML=this.campaignHTML();this.mountCampaign(content);}
  }
  heroCard(h,detail=true) {return `<button class="hero-card ${h.rarity} ${h.owned?'':'unowned'}" data-p-action="${detail?'hero':'assign'}" data-hero="${h.id}"><span class="hero-tier">${tiers[h.rarity]} · ${jobs[h.job]}</span><span class="hero-card-art">${art(h)}</span><strong>${esc(h.name)}</strong><small>${h.owned?`Lv.${h.level}　${'★'.repeat(h.stars)}`:'尚未招募'}</small></button>`;}
  heroesHTML() {
    const list=this.engine.getHeroes(),shown=this.filter==='all'?list:list.filter(h=>h.job===this.filter);
    return `<div class="p-section-heading"><div><small>与你并肩的人</small><h3>英雄名册 <b>${list.filter(h=>h.owned).length}/${list.length}</b></h3></div><button class="p-small" data-p-action="tab" data-tab="recruit">去招募 ${icon('arrow')}</button></div><div class="hero-filters">${[['all','全部'],...Object.entries(jobs)].map(([id,label])=>`<button class="${this.filter===id?'active':''}" data-p-action="filter" data-filter="${id}">${label}</button>`).join('')}</div><div class="hero-grid">${shown.map(h=>this.heroCard(h)).join('')}</div>`;
  }
  formationHTML() {
    const owned=this.engine.getHeroes().filter(h=>h.owned),slots=this.data.formation;
    return `<div class="p-section-heading"><div><small>默认阵型 · 点击位置安排伙伴</small><h3>主阵容英雄 <b>${slots.filter(Boolean).length}/5</b></h3></div><button class="p-small" data-p-action="auto-formation">一键上阵</button></div><div class="formation-board"><div class="formation-chart-lines"></div><div class="formation-direction">敌舰方向 ↑</div>${slots.map((id,slot)=>{const h=HEROES[id],level=h?this.data.heroes[h.id]?.level:0;return `<button class="formation-position position-${slot} ${h?'filled':''} ${this.formationTarget===slot?'selected':''}" data-p-action="slot" data-slot="${slot}" aria-label="位置${slot+1}${h?' '+h.name:' 空位'}">${h?`${art(h,true)}<strong>${h.name}</strong><small>${level}级</small>`:'<b>＋</b><span>安排英雄</span>'}</button>`;}).join('')}<div class="formation-save-note">自动保存布阵结果</div></div><div class="p-section-heading"><h3>${this.formationTarget===null?'已拥有的英雄':`选择第 ${this.formationTarget+1} 个位置的英雄`}</h3>${this.formationTarget!==null?'<button class="p-small" data-p-action="remove-slot">撤下此位置</button>':''}</div><div class="formation-roster">${owned.map(h=>this.heroCard(h,false)).join('')}</div><button class="p-primary p-wide" data-p-action="tab" data-tab="campaign">阵容准备好了，前往闯关 ${icon('arrow')}</button>`;
  }
  recruitHTML() {
    const pity=this.data.recruitment.pity,total=this.data.recruitment.normalCount+this.data.recruitment.legendCount,firstCost=this.engine.getRecruitCost(1).tickets;
    return `<div class="recruit-banner recruit-radio"><small>电台招募 / 幸存者信号</small><h3>还有人，听得见我们</h3><div class="recruit-portraits">${['loyal','mechanic','lei'].map(id=>`<div>${art(HEROES[id])}<strong>${HEROES[id].name}</strong></div>`).join('')}</div><p>再招募 <b>${50-pity}</b> 次，必得传说英雄</p></div><div class="recruit-stock"><span>${icon('journal')} 招募券 <b data-wallet="tickets">${count(this.data.wallet.tickets)}</b></span><small>累计招募 ${count(total)} 次</small></div><div class="recruit-actions"><button class="p-primary" data-p-action="recruit" data-count="1">${firstCost===0?'首次免费招募':'招募一次'}<small>${firstCost===0?'本次无需招募券':`${icon('journal')} 消耗 ${firstCost} 张`}</small></button><button class="p-primary" data-p-action="recruit" data-count="10">招募十次<small>${icon('journal')} 消耗 10 张</small></button></div><div class="p-rule"><strong>招募规则</strong><p>首次单次招募免费；单次与十次招募共享进度，每 50 次内必得一名传说英雄，抽到传说后重新计数。重复英雄转为对应碎片，可用于升星。</p></div>`;
  }
  campaignHTML() {
    const stages=this.engine.getStages(),next=stages.find(s=>s.unlocked&&!s.cleared)||stages.at(-1),chosen=stages.find(s=>s.id===this.selectedStage)||next;
    this.selectedStage=chosen.id;
    const idle=this.engine.getIdle(),battle=this.data.battle,canResume=battle&&battle.phase!=='claimed';
    return `<div class="campaign-voyage"><div id="campaign-scene" class="campaign-preview" aria-label="救援船与当前出战英雄"></div><header class="campaign-hud"><div class="campaign-progress">${icon('flag')}<strong>${this.data.campaign.highestCleared}</strong><small>关已通过</small></div><button class="campaign-heroes" data-p-action="tab" data-tab="heroes">${icon('people')}<span>英雄</span></button></header><section class="stage-detail campaign-stage-copy"><small>${esc(chosen.zone)}</small><h3>${esc(chosen.name)}</h3><button data-p-action="stage-info" aria-label="查看本关敌人与奖励">${chosen.unlocked?chosen.cleared?'首通奖励已领取':'查看敌人与首通奖励':'通过前一关后解锁'} ${icon('arrow')}</button></section><div class="campaign-idle-tools"><button class="campaign-signal" data-p-action="idle" aria-label="查看和领取挂机补给"><span class="signal-tv"><i></i><b></b></span><strong id="campaign-idle-clock">${clock(idle.seconds)}</strong><small>挂机补给</small></button><button class="campaign-info" data-p-action="stage-info">${icon('compass')}<span>航道情报</span></button></div><footer class="campaign-dock"><div class="campaign-track" role="group" aria-label="选择关卡">${stages.map(t=>`<button data-p-action="stage" data-stage="${t.id}" aria-label="第${t.id}关 ${esc(t.name)}" aria-pressed="${t.id===chosen.id}" class="campaign-track-node ${t.cleared?'cleared':''} ${t.unlocked?'':'locked'} ${t.id===chosen.id?'selected':''} ${t.boss?'boss':''}"><span>${t.id}</span>${t.boss?'<small>强敌</small>':''}</button>`).join('')}</div><div class="campaign-bottom-actions"><button class="campaign-return" data-p-action="close" aria-label="返回营地">${icon('arrow')}</button><button class="campaign-fight" data-p-action="${canResume?'resume':'fight'}" ${!canResume&&!chosen.unlocked?'disabled':''}><strong>${canResume?'继续战斗':chosen.cleared?'再次挑战':'开战'}</strong>${!canResume&&!chosen.unlocked?'<small>尚未解锁</small>':''}</button><button class="campaign-formation" data-p-action="tab" data-tab="formation"><i>${'<b></b>'.repeat(6)}</i><strong>阵容</strong></button></div></footer></div>`;
  }
  mountCampaign(content) {
    content.classList.add('campaign-content');
    this.campaignView=new CampaignView(content.querySelector('#campaign-scene'));
    const units=this.data.formation.flatMap((id,slot)=>{const h=id&&this.engine.getHero(id);return h?.owned?[{id:`ally-${h.id}`,heroId:h.id,name:h.name,job:h.job,color:h.color,level:h.level,slot,...h.stats,hp:h.stats.maxHp}]:[];});
    this.campaignView.showFormation(units);
    requestAnimationFrame(()=>{const track=this.el.querySelector('.campaign-track'),selected=track?.querySelector('.selected');if(track?.isConnected&&selected){if(track.scrollHeight>track.clientHeight+2)track.scrollTop=selected.offsetTop-track.clientHeight/2+selected.clientHeight/2;else track.scrollLeft=selected.offsetLeft-track.clientWidth/2+selected.clientWidth/2;}});
  }
  mountBattle(content) {
    const b=this.engine.getBattle();if(!b){this.tab='campaign';this.render();return;}
    content.classList.add('battle-content');content.innerHTML=`<div class="battle-topline"><strong>第 ${b.stage} 关</strong><span id="battle-time">00:00</span><button class="p-small" data-p-action="speed">速度 ×${this.speed}</button></div><div id="battle-stage" aria-label="救援队战斗"></div><div class="battle-control-panel"><div class="battle-log" id="battle-log">救援队已就位。</div><div id="battle-result"></div><div class="battle-action-row"><button class="p-small ${this.auto?'active':''}" data-p-action="auto">${this.auto?'自动闯关中':'自动闯关'}</button><button class="p-small" data-p-action="skip" id="battle-skip" disabled>10 秒后可跳过</button></div></div>`;
    const field=content.querySelector('#battle-stage');
    this.battleView=new BattleView(field,{onEvent:e=>{if(e.type==='skill'){const log=this.el.querySelector('#battle-log');if(log)log.textContent=e.label||'英雄释放技能';}},onComplete:()=>this.finishBattle()});
    this.battleView.setSpeed(this.speed);this.battleView.play(b);
    if(b.phase!=='playing')this.battleView.skip();
    this.updateBattleControls();
  }
  finishBattle() {
    const b=this.data.battle;if(!b||!this.visible||this.tab!=='battle')return;
    if(b.phase==='playing')this.engine.advanceBattle(Math.max(0,b.duration-b.time)+.01);
    if(b.result==='defeat')this.auto=false;
    this.updateBattleControls();
    if(this.auto&&!document.hidden&&b.result==='victory'&&b.phase==='finished'){clearTimeout(this.autoTimer);this.autoTimer=setTimeout(()=>{if(this.auto&&this.visible&&!document.hidden&&this.tab==='battle')this.collectBattle(true);},1300);}
  }
  updateBattleControls() {
    const b=this.data.battle;if(!b)return;
    const auto=this.el.querySelector('[data-p-action="auto"]');if(auto){auto.textContent=this.auto?'自动闯关中':'自动闯关';auto.classList.toggle('active',this.auto);}
    const time=this.el.querySelector('#battle-time');if(time)time.textContent=`${String(Math.floor(b.time/60)).padStart(2,'0')}:${String(Math.floor(b.time%60)).padStart(2,'0')}`;
    const skip=this.el.querySelector('#battle-skip');if(skip){skip.disabled=b.phase!=='playing'||b.time<10;skip.textContent=b.phase!=='playing'?'战斗已结束':b.time>=10?'跳过演出':`${Math.ceil(10-b.time)} 秒后可跳过`;}
    const result=this.el.querySelector('#battle-result');if(!result||b.phase==='playing')return;
    const marker=`${b.id}:${b.phase}`;if(result.dataset.result===marker)return;result.dataset.result=marker;
    if(b.result==='victory'){const stage=this.engine.getStage(b.stage);result.innerHTML=`<div class="p-battle-verdict victory"><small>航道已清理</small><strong>战斗胜利</strong><div>${stage?.cleared?'<p>本关首通奖励已领取</p>':rewardHTML(stage?.rewards)}</div><button class="p-primary" data-p-action="battle-claim" ${b.claimed?'disabled':''}>${b.claimed?'奖励已领取':'领取奖励并继续'}</button></div>`;}
    else result.innerHTML='<div class="p-battle-verdict defeat"><small>伙伴们已撤回营地</small><strong>暂时受阻</strong><p>调整前后排站位，或培养英雄后再来。</p><div><button class="p-small" data-p-action="tab" data-tab="formation">调整阵容</button><button class="p-primary" data-p-action="retry">再次挑战</button></div></div>';
  }
  renderModal() {
    const root=this.el.querySelector('#progress-modal');if(!root)return;
    if(this.idleOpen){const idle=this.engine.getIdle();root.innerHTML=`<div class="p-modal-shade"><section class="p-modal" role="dialog" aria-modal="true" aria-label="挂机补给"><header><h3>伙伴带回的物资</h3><button data-p-action="modal-close" aria-label="关闭">${icon('close')}</button></header><p class="idle-clock" id="idle-clock">已累计 ${Math.floor(idle.seconds/60)} 分 ${idle.seconds%60} 秒 / 最多 2 小时</p><div class="idle-pending" id="idle-pending">${rewardHTML(idle.pending)}</div><div class="p-rule"><strong>当前每分钟收益 · 最高通关 ${this.data.campaign.highestCleared} 关</strong><div class="idle-rates">${Object.entries(idle.perMinute).filter(([,v])=>v>0).map(([key,v])=>`<span>${supplies[key]}<b>${Number(v).toFixed(v<1?2:0)} / 分</b></span>`).join('')||'<p>通过第一关后，伙伴会开始带回挂机物资。</p>'}</div></div><button class="p-primary p-wide" data-p-action="idle-claim" ${!idle.canClaim?'disabled':''}>收取挂机补给</button></section></div>`;return;}
    if(this.draws){root.innerHTML=`<div class="p-modal-shade"><section class="p-modal" role="dialog" aria-modal="true" aria-label="招募结果"><header><h3>电台接通了！</h3><button data-p-action="modal-close" aria-label="关闭">${icon('close')}</button></header><div class="draw-grid">${this.draws.map(d=>{const h=HEROES[d.heroId||d.id]||d.hero||d;return `<div class="draw-card ${h.rarity}">${art(h)}<strong>${esc(h.name)}</strong><small>${d.duplicate?`重复转为 ${d.shards||d.shardsGained||0} 碎片`:'新伙伴加入'}</small></div>`;}).join('')}</div><button class="p-primary p-wide" data-p-action="modal-close">收下伙伴</button></section></div>`;return;}
    if(!this.detail&&!this.stageInfo){root.innerHTML='';return;}
    if(this.stageInfo){const stage=this.engine.getStage(this.selectedStage);if(!stage)return;root.innerHTML=`<div class="p-modal-shade"><section class="p-modal stage-info-modal" role="dialog" aria-modal="true" aria-label="关卡情报"><header><h3>${esc(stage.name)}</h3><button data-p-action="modal-close" aria-label="关闭">${icon('close')}</button></header><p>${esc(stage.description)}</p><div class="enemy-preview">${stage.enemies.map(h=>`<span>${art(h,true)}<small>${esc(h.name)}</small></span>`).join('')}</div><h4>${stage.cleared?'首通奖励已领取':'首次通关奖励'}</h4><div class="stage-info-rewards">${rewardHTML(stage.rewards)}</div><button class="p-primary p-wide" data-p-action="modal-close">返回救援船</button></section></div>`;return;}
    const h=this.engine.getHeroes().find(v=>v.id===this.detail);if(!h)return;
    root.innerHTML=`<div class="p-modal-shade"><section class="p-modal hero-detail-modal" role="dialog" aria-modal="true" aria-label="${esc(h.name)}"><header><span>${tiers[h.rarity]} · ${jobs[h.job]}</span><button data-p-action="modal-close" aria-label="关闭">${icon('close')}</button></header><div class="hero-detail-portrait ${h.rarity}">${art(h)}<div><small>${h.owned?`Lv.${h.level}　${'★'.repeat(h.stars)}`:'尚未招募'}</small><h3>${h.name}</h3><p>${h.description}</p></div></div><div class="hero-stat-grid">${[['maxHp','生命'],['attack','攻击'],['armor','护甲']].map(([k,l])=>`<span><small>${l}</small><strong>${count(h.stats[k])}</strong></span>`).join('')}</div><div class="hero-skill"><strong>${esc(h.skill.name)}</strong><p>${esc(h.skill.description)}</p></div><div class="hero-cultivation"><div><strong>升级</strong><span>${rewardHTML(h.upgradeCost)}</span><button class="p-primary" data-p-action="upgrade" data-hero="${h.id}" ${!h.owned||!h.upgradeCost?'disabled':''}>${!h.owned?'先招募英雄':h.upgradeCost?'提升 1 级':'等级已满'}</button></div><div><strong>升星 <small>持有 ${h.shards} 碎片</small></strong><span>${rewardHTML(h.starCost)}</span><button class="p-primary" data-p-action="star" data-hero="${h.id}" ${!h.owned||!h.starCost?'disabled':''}>${!h.owned?'先招募英雄':h.starCost?'提升星级':'星级已满'}</button></div></div></section></div>`;
  }
  collectBattle(next=false) {
    const stage=this.data.battle?.stage,result=this.engine.claimBattleReward();this.notify(result.message);if(!result.ok)return;
    if(next){const upcoming=this.engine.getStage(stage+1);if(upcoming){const start=this.engine.startBattle(upcoming.id);if(start.ok){this.tab='battle';this.render();return;}this.notify(start.message);}this.auto=false;}
    this.tab='campaign';this.selectedStage=stage+1;this.render();
  }
  handle(e) {
    const button=e.target.closest('[data-p-action]');if(!button||button.disabled)return;
    const a=button.dataset.pAction,id=button.dataset.hero;let result;
    if(a==='close'){this.close();return;}
    if(a==='modal-close'){this.detail=null;this.draws=null;this.idleOpen=false;this.stageInfo=false;this.render();return;}
    if(a==='tab'){clearTimeout(this.autoTimer);this.auto=false;this.tab=button.dataset.tab;this.formationTarget=null;this.render();return;}
    if(a==='filter'){this.filter=button.dataset.filter;this.render();return;}
    if(a==='hero'){this.detail=id;this.renderModal();return;}
    if(a==='pool'){this.recruitPool=button.dataset.pool;this.render();return;}
    if(a==='stage'){this.selectedStage=Number(button.dataset.stage);this.render();return;}
    if(a==='stage-info'){this.stageInfo=true;this.renderModal();return;}
    if(a==='slot'){this.formationTarget=Number(button.dataset.slot);this.render();return;}
    if(a==='assign'){if(this.formationTarget===null){this.notify('先点一个阵容位置，再选择英雄。');return;}result=this.engine.assignSlot(id,this.formationTarget);}
    if(a==='remove-slot'){const slots=[...this.data.formation];slots[this.formationTarget]=null;result=this.engine.setFormation(slots);}
    if(a==='auto-formation'){const owned=this.engine.getHeroes().filter(h=>h.owned).sort((a,b)=>b.level-a.level),front=owned.filter(h=>['tank','warrior'].includes(h.job)),back=owned.filter(h=>!front.includes(h)),ordered=[...front,...back].slice(0,5);const slots=Array(5).fill(null);ordered.forEach((h,i)=>{slots[i]=h.id;});result=this.engine.setFormation(slots);}
    if(a==='upgrade'||a==='star'){result=a==='upgrade'?this.engine.upgradeHero(id):this.engine.starUpHero(id);this.notify(result.message);this.sync(this.game.state);this.renderModal();return;}
    if(a==='recruit'){result=this.engine.recruit('normal',Number(button.dataset.count));if(!result.ok){this.notify(result.message);return;}this.render();this.draws=result.draws||result.results||result.heroes||[];this.renderModal();return;}
    if(a==='idle'){this.idleOpen=true;this.renderModal();return;}
    if(a==='idle-claim'){result=this.engine.claimIdle();this.notify(result.message);this.sync(this.game.state);return;}
    if(a==='fight'||a==='retry'){result=this.engine.startBattle(a==='retry'?this.data.battle.stage:this.selectedStage);if(result.ok){this.tab='battle';this.render();return;}}
    if(a==='resume'){this.tab='battle';this.render();return;}
    if(a==='speed'){this.speed=this.speed===1?2:1;this.battleView?.setSpeed(this.speed);button.textContent=`速度 ×${this.speed}`;return;}
    if(a==='auto'){this.auto=!this.auto;button.textContent=this.auto?'自动闯关中':'自动闯关';button.classList.toggle('active',this.auto);if(this.auto&&this.data.battle?.phase==='finished')this.finishBattle();return;}
    if(a==='skip'){result=this.engine.skipBattle();if(result.ok)this.battleView?.skip();else this.notify(result.message);this.updateBattleControls();return;}
    if(a==='battle-claim'){this.collectBattle(true);return;}
    if(result){this.notify(result.message);if(result.ok){this.formationTarget=null;this.render();}}
  }
}

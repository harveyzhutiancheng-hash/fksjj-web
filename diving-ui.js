import { DivingView } from './diving-view.js';
import { icon } from './icons.js';

const names={scrap:'废金属',glass:'玻璃',seaweed:'海藻'};
const cargoHTML=cargo=>Object.entries(names).map(([key,name])=>`<span>${icon(key)}<strong>${Math.floor(cargo?.[key]||0)}</strong><small>${name}</small></span>`).join('');
const time=n=>{const s=Math.ceil(Math.max(0,n));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};

export class DivingUI {
  constructor(container,{game,notify=()=>{},onToggle=()=>{}}){
    Object.assign(this,{el:container,game,notify,onToggle});this.visible=false;this.keys=new Set();this.input={x:0,y:0};
    container.addEventListener('click',e=>this.handle(e));
    document.addEventListener('keydown',e=>{if(!this.visible)return;if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(this.dialog==='pause')this.resume();else if(!this.dialog)this.pause();}const k=e.key.toLowerCase();if(['w','a','s','d','arrowup','arrowleft','arrowdown','arrowright'].includes(k)&&!this.dialog){e.preventDefault();e.stopImmediatePropagation();this.keys.add(k);}},true);
    document.addEventListener('keyup',e=>this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur',()=>{if(this.visible&&!this.dialog)this.pause();});this.frame=this.frame.bind(this);
  }
  open(){
    if(this.visible)return true;const result=this.game.startDiving();if(!result.ok){this.notify(result.message);return false;}
    this.visible=true;this.dialog=null;this.lastFocus=document.activeElement;this.el.hidden=false;document.body.classList.add('diving-view');
    this.inertSiblings=[...this.el.parentElement.children].filter(n=>n!==this.el&&n.id!=='toast').map(n=>[n,n.inert]);this.inertSiblings.forEach(([n])=>n.inert=true);this.onToggle(true);
    this.el.innerHTML=`<section class="dv-shell" aria-label="海底潜水"><div class="dv-scene"></div><header class="dv-header"><div class="dv-title"><span>${icon('divingDock')}</span><strong>沉没街区<small>沿废墟向下探索</small></strong><button data-dive-action="pause" aria-label="暂停潜水">Ⅱ</button></div><div class="dv-oxygen"><strong>氧气剩余</strong><div role="progressbar" aria-label="剩余氧气" aria-valuemin="0" aria-valuemax="60" aria-valuenow="60"><i></i><b>01:00</b></div></div><div class="dv-cargo"></div></header><div class="dv-depth"><strong>0m</strong><small>潜水深度</small></div><div class="dv-notice" role="status"></div><div class="dv-controls"><div class="dv-stick" aria-label="拖动摇杆控制潜水方向"><i></i><b>↓</b></div><p>拖动游动，靠近物资拾取</p></div><footer class="dv-footer"><button class="dv-return" data-dive-action="return">${icon('arrow')}<strong>上浮返航</strong></button><button class="dv-leave" data-dive-action="leave">暂离<small>保留氧气与收获</small></button></footer><div class="dv-modal" hidden></div></section>`;
    this.surface=this.el.querySelector('.dv-shell');this.view=new DivingView(this.el.querySelector('.dv-scene'));
    this.pointerDown=e=>{if(this.dialog||this.pointerId!==undefined||e.isPrimary===false||e.target.closest('button,.dv-modal'))return;e.preventDefault();this.pointerId=e.pointerId;this.surface.setPointerCapture(e.pointerId);const r=this.el.querySelector('.dv-stick').getBoundingClientRect(),center={x:r.x+r.width/2,y:r.y+r.height/2};this.origin=Math.hypot(e.clientX-center.x,e.clientY-center.y)<70?center:{x:e.clientX,y:e.clientY};this.movePointer(e);};
    this.pointerMove=e=>{if(e.pointerId===this.pointerId){e.preventDefault();this.movePointer(e);}};
    this.pointerEnd=e=>{if(e.pointerId===this.pointerId)this.resetInput();};
    this.surface.addEventListener('pointerdown',this.pointerDown);this.surface.addEventListener('pointermove',this.pointerMove);for(const event of ['pointerup','pointercancel','lostpointercapture'])this.surface.addEventListener(event,this.pointerEnd);
    this.last=performance.now();this.lastCargo=null;this.update();this.raf=requestAnimationFrame(this.frame);
    if(!this.dialog&&!this.game.state.diving.guideSeen)this.showGuide();
    if(!this.dialog)this.el.querySelector('[data-dive-action="pause"]')?.focus({preventScroll:true});return true;
  }
  movePointer(e){const dx=e.clientX-this.origin.x,dy=e.clientY-this.origin.y,length=Math.hypot(dx,dy),scale=length>40?40/length:1;this.input=length<5?{x:0,y:0}:{x:dx*scale/40,y:dy*scale/40};this.el.querySelector('.dv-stick i').style.transform=`translate(${dx*scale}px,${dy*scale}px)`;}
  resetInput(){const id=this.pointerId;this.pointerId=undefined;this.input={x:0,y:0};this.keys.clear();if(id!==undefined&&this.surface?.hasPointerCapture(id))this.surface.releasePointerCapture(id);const knob=this.el.querySelector('.dv-stick i');if(knob)knob.style.transform='';}
  frame(now){if(!this.visible)return;const dt=Math.min(.05,Math.max(0,(now-this.last)/1000));this.last=now;if(!this.dialog&&!document.hidden){const x=(this.keys.has('d')||this.keys.has('arrowright')?1:0)-(this.keys.has('a')||this.keys.has('arrowleft')?1:0),y=(this.keys.has('s')||this.keys.has('arrowdown')?1:0)-(this.keys.has('w')||this.keys.has('arrowup')?1:0);this.game.moveDiving(this.keys.size?{x,y}:this.input,dt);this.update();}this.raf=requestAnimationFrame(this.frame);}
  update(){
    if(!this.visible)return;const trip=this.game.getDiving();if(!trip||trip.status==='returned')return;this.view?.update(trip);
    const meter=this.el.querySelector('.dv-oxygen [role="progressbar"]');meter.setAttribute('aria-valuenow',Math.ceil(trip.oxygenRemaining));meter.setAttribute('aria-valuemax',trip.oxygenCapacity);meter.querySelector('i').style.transform=`scaleX(${trip.oxygenRemaining/trip.oxygenCapacity})`;meter.querySelector('b').textContent=time(trip.oxygenRemaining);this.surface.classList.toggle('dv-low',trip.oxygenRemaining<=10);this.el.querySelector('.dv-depth strong').textContent=`${trip.player.y.toFixed(1)}m`;
    const cargo=JSON.stringify(trip.cargo);if(cargo!==this.lastCargo){if(this.lastCargo){const old=JSON.parse(this.lastCargo),gain=Object.keys(names).filter(k=>trip.cargo[k]>old[k]).map(k=>`${names[k]} +${trip.cargo[k]-old[k]}`);if(gain.length){const e=this.el.querySelector('.dv-notice');e.textContent=gain.join(' · ');e.classList.add('show');clearTimeout(this.noticeTimer);this.noticeTimer=setTimeout(()=>e.classList.remove('show'),1800);}}this.el.querySelector('.dv-cargo').innerHTML=cargoHTML(trip.cargo);this.lastCargo=cargo;}
    if(trip.status==='surfaced'&&this.dialog!=='result')this.settle();
  }
  showModal(title,body,buttons){const el=this.el.querySelector('.dv-modal');el.hidden=false;[...this.surface.children].forEach(n=>{if(n!==el)n.inert=true;});el.innerHTML=`<section class="dv-dialog" role="dialog" aria-modal="true" aria-label="${title}"><span class="dv-dialog-art">${icon('divingDock')}</span><h2>${title}</h2>${body}<div class="dv-dialog-actions">${buttons}</div></section>`;el.querySelector('button')?.focus({preventScroll:true});}
  showGuide(){this.resetInput();this.dialog='guide';this.view.setPaused(true);this.showModal('第一次下潜',`<p>氧气可支撑 <strong>60 秒</strong>。拖动摇杆向下探索，靠近废金属、玻璃和海藻就能拾取。</p><div class="dv-guide-resources">${cargoHTML({scrap:0,glass:0,seaweed:0})}</div><p>随时上浮带回收获；氧气耗尽时会自动上浮。</p>`,'<button data-dive-action="guide-done">准备好了，下潜</button>');}
  pause(){if(!this.visible||this.dialog)return;this.resetInput();this.game.save();this.dialog='pause';this.view.setPaused(true);this.showModal('在这里歇一会儿','<p>潜水已暂停，氧气和本次收获会保留。</p>','<button data-dive-action="resume">继续潜水</button><button class="secondary" data-dive-action="leave">暂离海底</button>');}
  resume(){this.dialog=null;this.resetInput();this.last=performance.now();this.el.querySelector('.dv-modal').hidden=true;[...this.surface.children].forEach(n=>n.inert=false);this.view.setPaused(false);this.update();}
  settle(){if(this.dialog==='result')return;this.resetInput();const result=this.game.returnDiving();if(!result.ok){this.notify(result.message);return;}this.dialog='result';this.view.setPaused(true);this.showModal(result.surfaced?'氧气耗尽，安全上浮':'带着收获回家',`<div class="dv-result-cargo">${cargoHTML(result.resources)}</div><p>物资已收入营地背包。海藻和玻璃可以交给厨房加工。</p>`,'<button data-dive-action="close">返回营地</button><button class="secondary" data-dive-action="again">再潜一次</button>');}
  handle(e){const b=e.target.closest('[data-dive-action]');if(!b||b.disabled)return;const action=b.dataset.diveAction;if(action==='guide-done'){this.game.markDivingGuideSeen();this.resume();}else if(action==='pause')this.pause();else if(action==='resume')this.resume();else if(action==='return')this.settle();else if(action==='leave'||action==='close')this.close();else if(action==='again'){this.close();this.open();}}
  suspend(){if(this.visible&&!this.dialog)this.pause();else this.resetInput();}
  sync(state,event){if(!this.visible)return;if(event.type==='reset')this.close();if(event.type==='load'){const trip=this.game.getDiving();if(!trip||trip.status==='returned')this.close();else{this.update();if(!this.dialog)this.pause();}}}
  close(){if(!this.visible)return;this.resetInput();this.game.save();this.visible=false;cancelAnimationFrame(this.raf);clearTimeout(this.noticeTimer);this.view?.dispose();this.view=null;this.el.hidden=true;this.el.innerHTML='';document.body.classList.remove('diving-view');this.inertSiblings?.forEach(([n,value])=>n.inert=value);this.inertSiblings=null;this.onToggle(false);if(this.lastFocus?.isConnected)this.lastFocus.focus({preventScroll:true});}
}

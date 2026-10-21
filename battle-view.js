import * as THREE from './node_modules/three/build/three.module.js';

const clamp=THREE.MathUtils.clamp;
const UP=new THREE.Vector3(0,1,0);
const JOBS={tank:'重装',warrior:'突击',fighter:'突击',ranger:'射手',ranged:'射手',marksman:'射手',shooter:'射手',healer:'医疗',support:'支援',assassin:'游击',engineer:'技师',summoner:'召唤',wizard:'巫师',mage:'法师'};
const PALETTE={tank:0x8ba566,warrior:0xd8664e,fighter:0xd8664e,ranger:0x5b90be,ranged:0x5b90be,marksman:0x5b90be,shooter:0x5b90be,healer:0x80baa0,support:0xe5b857,assassin:0xa185bd,engineer:0xdb9858,summoner:0xdba36c,wizard:0xa35d9b,mage:0x779cd0};
const hash=text=>{let n=0;for(const c of String(text))n=((n*31)+c.charCodeAt(0))>>>0;return n;};
const create=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};

/** Deterministic battle presentation. No domain mutations, reward generation, or random combat. */
export class BattleView {
  constructor(container,{onComplete,onEvent}={}) {
    this.container=container;this.onComplete=onComplete;this.onEvent=onEvent;
    this.speed=1;this.time=0;this.finished=false;this.disposed=false;this.units=new Map();this.effects=[];this.floats=[];this.materials=new Map();this.geometries=new Map();this.completedIds=new Set();
    this.root=create('div','bv-root');this.root.setAttribute('aria-label','海上甲板战斗');container.appendChild(this.root);
    this.labels=create('div','bv-labels');this.fxLayer=create('div','bv-fx-layer');this.root.append(this.labels,this.fxLayer);
    this.banner=create('div','bv-announcement');this.banner.setAttribute('aria-live','polite');this.root.appendChild(this.banner);
    this.result=create('div','bv-result');this.result.hidden=true;this.root.appendChild(this.result);
    if(!document.querySelector('link[data-battle-view-style]')){const link=create('link');link.rel='stylesheet';link.href=new URL('./battle-view.css',import.meta.url).href;link.dataset.battleViewStyle='true';document.head.appendChild(link);}
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0x31669a);this.scene.fog=new THREE.FogExp2(0x386b9e,.015);
    this.camera=new THREE.OrthographicCamera(-5,5,7,-7,.1,90);this.camera.position.set(5.2,15.5,13.5);this.camera.lookAt(0,.1,0);
    try {
      this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.02;
      this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
      this.renderer.domElement.className='bv-canvas';this.renderer.domElement.setAttribute('aria-hidden','true');this.root.prepend(this.renderer.domElement);
      this._world();
    } catch(error) {
      this.renderer=null;this.fallback=create('canvas','bv-canvas');this.root.prepend(this.fallback);this.context=this.fallback.getContext('2d');
      console.warn('BattleView is using the canvas fallback.',error);
    }
    this.observer=new ResizeObserver(()=>this._resize());this.observer.observe(container);this._resize();
    this.frame=this._frame.bind(this);this.raf=requestAnimationFrame(this.frame);
  }

  _mat(color,extra={}) {
    const key=`${color}/${extra.transparent?extra.opacity:''}/${extra.emissive||''}`;
    if(!this.materials.has(key))this.materials.set(key,new THREE.MeshStandardMaterial({color,roughness:.92,...extra}));return this.materials.get(key);
  }
  _geo(type,args) {
    const key=type+args.join('/');if(!this.geometries.has(key)){const C={box:THREE.BoxGeometry,sphere:THREE.SphereGeometry,cylinder:THREE.CylinderGeometry,cone:THREE.ConeGeometry,torus:THREE.TorusGeometry}[type];this.geometries.set(key,new C(...args));}return this.geometries.get(key);
  }
  _mesh(parent,geometry,material,x=0,y=0,z=0,shadow=true) {const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,y,z);mesh.castShadow=shadow;mesh.receiveShadow=true;parent.add(mesh);return mesh;}
  _box(parent,w,h,d,color,x=0,y=0,z=0){return this._mesh(parent,this._geo('box',[w,h,d]),this._mat(color),x,y,z);}
  _sphere(parent,r,color,x=0,y=0,z=0,s=12){return this._mesh(parent,this._geo('sphere',[r,s,8]),this._mat(color),x,y,z);}
  _cyl(parent,r,h,color,x=0,y=0,z=0,s=10){return this._mesh(parent,this._geo('cylinder',[r,r,h,s]),this._mat(color),x,y,z);}
  _beam(parent,a,b,width,color){const start=new THREE.Vector3(...a),end=new THREE.Vector3(...b),middle=start.clone().add(end).multiplyScalar(.5);const mesh=this._box(parent,width,start.distanceTo(end),width,color,...middle.toArray());mesh.quaternion.setFromUnitVectors(UP,end.sub(start).normalize());return mesh;}

  _world() {
    this.scene.add(new THREE.HemisphereLight(0xe4ebff,0x424575,2.1));const sun=new THREE.DirectionalLight(0xffedc8,2.5);sun.position.set(-5,15,7);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-7,right:7,top:7,bottom:-7,near:1,far:35});sun.shadow.normalBias=.04;sun.shadow.bias=-.0002;this.scene.add(sun);
    const fill=new THREE.DirectionalLight(0xb9d4ff,.7);fill.position.set(6,8,-5);this.scene.add(fill);
    this.waterMaterial=new THREE.ShaderMaterial({uniforms:{time:{value:0}},vertexShader:'varying vec2 v;void main(){v=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:`varying vec2 v;uniform float time;float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.54);}void main(){vec2 p=v+vec2(time*.025,0.);vec2 c=floor(p/2.);vec2 q=mod(p,2.)-1.;q-=vec2(hash(c)*.8-.4,hash(c+3.)*.7-.35);float ridge=abs(q.y-(.07-abs(q.x)*.27));float crest=(1.-smoothstep(.012,.045,ridge))*(1.-smoothstep(.18,.35,abs(q.x)))*step(.35,hash(c+7.));vec3 col=mix(vec3(.025,.085,.23),vec3(.05,.16,.36),sin(v.x*.22+v.y*.14)*.5+.5);col=mix(col,vec3(.7,.8,.94),crest*.6);gl_FragColor=vec4(col,1.);#include <tonemapping_fragment>\n#include <colorspace_fragment>}`.replace('1.);#include','1.);\n#include')});
    const water=new THREE.Mesh(new THREE.PlaneGeometry(100,100),this.waterMaterial);water.rotation.x=-Math.PI/2;water.position.y=-.24;this.scene.add(water);
    this.arena=new THREE.Group();this.scene.add(this.arena);
    for(const side of [-1,1]) {
      const deck=new THREE.Group();deck.position.z=side*2.35;this.arena.add(deck);
      this._box(deck,5.8,.24,3.38,0x30345f,0,-.02,0);
      for(let x=0;x<3;x++)for(let z=0;z<2;z++) {
        const px=(x-1)*1.87,pz=(z-.5)*1.61;
        this._box(deck,1.82,.095,1.56,(x+z)%2?0xa9ada8:0xb9b8ae,px,.14,pz);
        this._box(deck,1.80,.025,.020,0x55576e,px,.20,pz+.76);
        for(const dx of [-.79,.79])for(const dz of [-.65,.65])this._cyl(deck,.025,.018,0x5b6171,px+dx,.207,pz+dz,5);
        this._box(deck,.35,.014,.13,0x8f9c8a,px-.45,.203,pz+.4).rotation.y=.35;
      }
      for(const x of [-2.84,2.84]) {
        this._box(deck,.07,.32,3.22,side===1?0x7d965e:0x977969,x,.35,0);
        this._box(deck,.11,.055,3.30,0x303763,x,.54,0);
        const float=this._cyl(deck,.20,2.8,0x4677a4,x,-.18,0);float.rotation.x=Math.PI/2;
      }
      const colors=[0x649e9d,0xc2959d,0xe3b67d];
      for(let i=0;i<6;i++)this._box(deck,.91,.075,.26,colors[i%3],(i-2.5)*.94,.08,side*1.91);
      for(const x of [-2.9,2.9])this._box(deck,.40,.12,.40,0x9caaa5,x,.12,side*1.90);
      this._mergeStatic(deck);this._hull(deck,.018);
    }
    for(const x of [-1.5,1.5]) {
      this._box(this.arena,.16,.11,1.5,0x32335f,x,-.10,0);
      for(let i=0;i<5;i++)this._box(this.arena,.69,.10,.24,i%2?0xc39c70:0xe3b681,x,.05,(i-2)*.29);
    }
    this.unitGroup=new THREE.Group();this.scene.add(this.unitGroup);
    const shadow=new THREE.Mesh(new THREE.PlaneGeometry(20,20),new THREE.ShadowMaterial({opacity:.19,depthWrite:false}));shadow.rotation.x=-Math.PI/2;shadow.position.y=-.215;shadow.receiveShadow=true;this.scene.add(shadow);
  }

  _mergeStatic(group,exclusions=[]) {
    group.updateWorldMatrix(true,true);const inv=group.matrixWorld.clone().invert(),exclude=new Set(exclusions),batches=new Map();
    const visit=node=>{if(exclude.has(node))return;if(node.isMesh&&!node.children.length){const bucket=batches.get(node.material)||[];bucket.push(node);batches.set(node.material,bucket);}for(const child of node.children)visit(child);};visit(group);
    for(const [material,meshes]of batches){if(meshes.length<2)continue;const sources=meshes.map(mesh=>{const g=mesh.geometry.index?mesh.geometry.toNonIndexed():mesh.geometry.clone();g.applyMatrix4(inv.clone().multiply(mesh.matrixWorld));return g;});const geometry=new THREE.BufferGeometry();for(const name of ['position','normal','uv']){if(!sources.every(g=>g.attributes[name]))continue;const size=sources[0].attributes[name].itemSize,values=new Float32Array(sources.reduce((n,g)=>n+g.attributes[name].array.length,0));let offset=0;for(const g of sources){values.set(g.attributes[name].array,offset);offset+=g.attributes[name].array.length;}geometry.setAttribute(name,new THREE.BufferAttribute(values,size));}const mesh=new THREE.Mesh(geometry,material);mesh.castShadow=true;mesh.receiveShadow=true;mesh.userData.ownedGeometry=true;group.add(mesh);meshes.forEach(m=>m.removeFromParent());sources.forEach(g=>g.dispose());}
  }
  _hull(group,thickness=.015,exclusions=[]) {
    group.updateWorldMatrix(true,true);const inv=group.matrixWorld.clone().invert(),exclude=new Set(exclusions),values=[];
    const visit=node=>{if(exclude.has(node))return;if(node.isMesh){const g=node.geometry.index?node.geometry.toNonIndexed():node.geometry.clone();g.applyMatrix4(inv.clone().multiply(node.matrixWorld));const p=g.attributes.position,n=g.attributes.normal;if(n){const averages=new Map();for(let i=0;i<p.count;i++){const key=[p.getX(i),p.getY(i),p.getZ(i)].map(v=>Math.round(v*10000)).join(',');const v=averages.get(key)||new THREE.Vector3();v.x+=n.getX(i);v.y+=n.getY(i);v.z+=n.getZ(i);averages.set(key,v);}for(const v of averages.values())v.normalize();for(let i=0;i<p.count;i++){const key=[p.getX(i),p.getY(i),p.getZ(i)].map(v=>Math.round(v*10000)).join(','),v=averages.get(key);values.push(p.getX(i)+v.x*thickness,p.getY(i)+v.y*thickness,p.getZ(i)+v.z*thickness);}}g.dispose();}for(const child of node.children)visit(child);};visit(group);
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(values,3));const material=this.hullMaterial||(this.hullMaterial=new THREE.MeshBasicMaterial({color:0x262651,side:THREE.BackSide}));const mesh=new THREE.Mesh(geometry,material);mesh.userData.ownedGeometry=true;group.add(mesh);
  }

  _unit(raw,side,index) {
    const id=String(raw.id??`${side}-${index}`),job=String(raw.job||'warrior').toLowerCase(),col=(Number(raw.slot??index)%3),row=Math.floor(Number(raw.slot??index)/3);
    const configured=raw.position||this.battle?.positions?.[id]||this.battle?.formations?.[side==='ally'?'allies':'enemies']?.[Number(raw.slot??index)];
    const base=new THREE.Vector3((side==='ally'?col-1:1-col)*1.65,.205,(side==='ally'?1:-1)*(1.38+row*1.52));
    if(configured){if(Array.isArray(configured)){base.x=Number(configured[0])||0;base.z=Number(configured[1])||0;}else{base.x=Number(configured.x)||0;base.z=Number(configured.z)||0;}}
    const label=create('div',`bv-unit-label ${side==='ally'?'is-ally':'is-enemy'}${raw.summon?' is-summon':''}`),name=create('strong','bv-unit-name',raw.name||id),jobLabel=create('small','bv-unit-job',raw.kind==='dog'?'机械犬':raw.kind==='robot'?'支援机':JOBS[job]||raw.job||'战斗员'),bar=create('div','bv-life'),fill=create('i','bv-life-fill'),shieldBar=create('i','bv-shield-fill');bar.append(fill,shieldBar);label.append(name,jobLabel,bar);this.labels.appendChild(label);
    const maxHp=Math.max(1,Number(raw.maxHp)||1),initialHp=clamp(Number(raw.hp??maxHp),0,maxHp);
    const buffLabel=create('small','bv-buff');buffLabel.hidden=true;label.appendChild(buffLabel);
    const actor={id,raw,side,job,base,hp:initialHp,initialHp,maxHp,shield:0,label,fill,shieldBar,buffLabel,buffUntil:0,dead:initialHp<=0,deathAt:null,action:null,flashUntil:0,phase:(hash(id)%100)/17,knockUntil:0,summoned:!!raw.summon,kind:raw.kind};
    if(this.renderer){
      const group=new THREE.Group();group.position.copy(base);this.unitGroup.add(group);actor.group=group;
      const body=new THREE.Group();group.add(body);actor.body=body;
      const color=raw.color||PALETTE[job]||(side==='ally'?0xda6c53:0x9f6b7e),skin=[0xe5b481,0xd6a175,0xc88f6e][hash(id)%3];
      if(raw.kind==='dog'||raw.kind==='robot') {
        this._summonModel(actor,body,raw.kind,color);
      } else {
      const leftLeg=this._box(body,.13,.26,.15,0x495e78,-.11,.20,0),rightLeg=this._box(body,.13,.26,.15,0x495e78,.11,.20,0);
      this._box(body,.16,.09,.23,0x383956,-.11,.045,.035);this._box(body,.16,.09,.23,0x383956,.11,.045,.035);
      this._box(body,.38,.39,.26,color,0,.48,0);this._box(body,.36,.085,.29,0x41466a,0,.30,0);
      this._box(body,.055,.34,.025,0xe5d3a4,-.12,.48,.145);this._box(body,.055,.34,.025,0xe5d3a4,.12,.48,.145);
      const leftArm=new THREE.Group();leftArm.position.set(-.27,.62,0);body.add(leftArm);const rightArm=new THREE.Group();rightArm.position.set(.27,.62,0);body.add(rightArm);
      this._box(leftArm,.15,.16,.19,color,0,-.04,0);this._box(rightArm,.15,.16,.19,color,0,-.04,0);this._box(leftArm,.12,.21,.13,skin,0,-.19,.02);this._box(rightArm,.12,.21,.13,skin,0,-.19,.02);
      this._sphere(body,.265,skin,0,.96,0,14).scale.set(1,1.03,.92);const hair=this._sphere(body,.273,side==='ally'?0x473847:0x4b3b48,0,1.065,-.03,12);hair.scale.set(1,.56,1);
      for(let k=0;k<4;k++){const tuft=this._mesh(body,this._geo('cone',[.073,.16,4]),this._mat(0x453644),(k-1.5)*.105,1.18-Math.abs(k-1.5)*.018,.015);tuft.rotation.z=(k-1.5)*-.26;}
      this._sphere(body,.039,0xfff0d6,-.085,.97,.221,8);this._sphere(body,.039,0xfff0d6,.085,.97,.221,8);this._sphere(body,.021,0x2d3157,-.085,.965,.252,7);this._sphere(body,.021,0x2d3157,.085,.965,.252,7);
      this._sphere(body,.037,0xd39971,0,.90,.242,7);this._box(body,.105,.014,.018,0x8d634e,0,.848,.224);
      if(job==='tank'){
        this._box(body,.45,.13,.36,0xa3ae85,0,.65,0);const helmet=this._sphere(body,.29,0xc7ad6e,0,1.08,-.01,12);helmet.scale.y=.55;this._box(leftArm,.48,.58,.11,0x353d6b,-.03,-.16,.16);this._box(leftArm,.40,.48,.055,0x91a476,-.03,-.16,.23);this._box(leftArm,.07,.42,.06,0xd9c99a,-.03,-.16,.27);
        this._box(rightArm,.11,.52,.10,0x96704f,0,-.18,.1);this._box(rightArm,.32,.15,.22,0x687b8d,0,-.45,.1);
      }else if(['ranger','ranged','marksman','shooter','engineer'].includes(job)){
        this._box(rightArm,.12,.15,.70,0x404967,0,-.20,.27);this._box(rightArm,.14,.14,.27,0x98694b,0,-.20,.13);this._box(rightArm,.055,.055,.22,0xa8bdc5,0,-.20,.70);
        this._box(body,.44,.085,.13,0x354566,0,1.015,.21);this._box(body,.15,.045,.04,0x8ad1d0,-.11,1.015,.285);this._box(body,.15,.045,.04,0x8ad1d0,.11,1.015,.285);
      }else if(['healer','support','summoner','wizard','mage'].includes(job)){
        this._box(body,.30,.34,.16,0xd6d8b5,0,.47,-.22);this._box(body,.17,.055,.035,0xd36c5d,0,.49,-.32);this._box(body,.055,.17,.035,0xd36c5d,0,.49,-.32);
        this._cyl(rightArm,.075,.44,0x65768f,0,-.17,.12);this._sphere(rightArm,.13,job==='healer'?0xb3e4ae:job==='mage'?0xa4e7ff:0xf2cd65,0,.10,.12,10);
        if(job==='wizard'||job==='mage'){for(const x of [-.18,0,.18]){this._cyl(body,.035,.62,0x9b78ce,x,1.12,-.29,7);this._sphere(body,.046,0xf1b6ff,x,1.45,-.29,7);}this._box(body,.42,.28,.30,color,0,.42,0);}
      }else if(job==='assassin'){
        this._box(body,.38,.16,.07,0x6e5f8f,0,.87,.20);for(const arm of [leftArm,rightArm]){this._box(arm,.045,.18,.055,0x51465a,0,-.26,.06);this._box(arm,.13,.28,.035,0xc8d4cc,.035,-.44,.06);}
      }else{
        this._box(rightArm,.055,.26,.06,0x70533e,0,-.25,.08);const blade=this._box(rightArm,.17,.58,.045,0xc1cdd0,0,-.62,.08);blade.rotation.z=-.09;this._box(rightArm,.28,.055,.09,0xd0ac66,0,-.38,.08);
      }
      this._mergeStatic(body,[leftArm,rightArm,leftLeg,rightLeg]);this._hull(body,.018,[leftArm,rightArm,leftLeg,rightLeg]);
      actor.leftArm=leftArm;actor.rightArm=rightArm;actor.leftLeg=leftLeg;actor.rightLeg=rightLeg;
      }
      const shield=new THREE.Mesh(this._geo('sphere',[.66,12,9]),new THREE.MeshBasicMaterial({color:0x84dce5,transparent:true,opacity:.20,depthWrite:false,side:THREE.DoubleSide}));shield.position.y=.66;shield.scale.set(.85,1.15,.85);shield.visible=false;group.add(shield);actor.shieldMesh=shield;
      const flash=new THREE.Mesh(this._geo('sphere',[.46,10,7]),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.0,depthWrite:false}));flash.position.y=.72;flash.scale.set(.85,1.5,.85);flash.visible=false;group.add(flash);actor.flashMesh=flash;
      const foot=new THREE.Mesh(new THREE.RingGeometry(.36,.41,24),new THREE.MeshBasicMaterial({color:side==='ally'?0x8adaaf:0xe8a088,transparent:true,opacity:.75,side:THREE.DoubleSide,depthWrite:false}));foot.rotation.x=-Math.PI/2;foot.position.y=.01;foot.userData.ownedGeometry=true;group.add(foot);actor.foot=foot;
      group.rotation.y=side==='ally'?Math.PI:0;
    }
    this.units.set(id,actor);this._bar(actor);return actor;
  }

  _summonModel(actor,body,kind,color) {
    if(kind==='dog') {
      this._box(body,.35,.25,.58,0x6d8297,0,.36,0);this._box(body,.30,.08,.43,color,0,.52,-.02);this._box(body,.33,.28,.30,0xaab5b9,0,.51,.35);
      this._box(body,.30,.10,.035,0x2c4165,0,.54,.515);this._box(body,.19,.045,.04,0x8de4dc,0,.54,.54);this._box(body,.18,.08,.13,0x3c4c69,0,.43,.55);
      for(const x of [-.14,.14]){const ear=this._mesh(body,this._geo('cone',[.08,.21,4]),this._mat(0x455a7b),x,.73,.30);ear.rotation.z=x<0?-.3:.3;}
      const legs=[];for(const x of [-.18,.18])for(const z of [-.22,.19]){const leg=new THREE.Group();leg.position.set(x,.28,z);body.add(leg);this._box(leg,.075,.22,.08,0x434f6c,0,-.09,0);this._box(leg,.13,.065,.17,0x9dabb2,0,-.20,.035);legs.push(leg);}
      const tail=this._cyl(body,.025,.30,0x495f7b,0,.54,-.38,7);tail.rotation.x=-.8;this._sphere(body,.049,0xe7c46b,0,.66,-.48,7);
      this._mergeStatic(body,legs);this._hull(body,.015,legs);[actor.leftArm,actor.rightArm,actor.leftLeg,actor.rightLeg]=legs;actor.labelHeight=1.00;actor.bodyHeight=.50;
    } else {
      this._cyl(body,.23,.34,0x98aab7,0,.47,0,12);this._box(body,.38,.22,.13,color,0,.49,.19);this._box(body,.12,.07,.045,0xffda80,0,.52,.28);
      this._sphere(body,.22,0xd2d6c5,0,.82,0,12);this._box(body,.31,.10,.05,0x34496a,0,.85,.185);this._box(body,.20,.04,.055,0x96e1e6,0,.85,.217);this._cyl(body,.02,.20,0x6a7c90,0,1.06,0,6);this._sphere(body,.045,0xe9bf63,0,1.18,0,7);
      const leftArm=new THREE.Group();leftArm.position.set(-.31,.65,0);body.add(leftArm);const rightArm=new THREE.Group();rightArm.position.set(.31,.65,0);body.add(rightArm);
      this._box(leftArm,.12,.29,.11,0x6f8299,0,-.12,0);const cannon=this._cyl(rightArm,.11,.39,0x526b8a,0,-.12,.14,10);cannon.rotation.x=Math.PI/2;this._cyl(rightArm,.065,.03,0x263959,0,-.12,.35,9).rotation.x=Math.PI/2;
      const leftLeg=this._box(body,.13,.27,.15,0x5d748c,-.12,.18,0),rightLeg=this._box(body,.13,.27,.15,0x5d748c,.12,.18,0);this._box(body,.18,.07,.25,0xaebac0,-.12,.045,.04);this._box(body,.18,.07,.25,0xaebac0,.12,.045,.04);
      this._mergeStatic(body,[leftArm,rightArm,leftLeg,rightLeg]);this._hull(body,.015,[leftArm,rightArm,leftLeg,rightLeg]);Object.assign(actor,{leftArm,rightArm,leftLeg,rightLeg,labelHeight:1.35,bodyHeight:.70});
    }
  }

  play(battle) {
    if(this.disposed)return Promise.resolve({cancelled:true});
    if(this.resolvePlay)this.resolvePlay({cancelled:true});this._clearBattle();
    this.battle=battle||{};this.battleId=String(battle?.id??'battle');this.duration=Math.max(.1,Number(battle?.duration)||Math.max(0,...(battle?.events||[]).map(e=>Number(e.at)||0))+.5);
    this.events=(battle?.events||[]).map((event,index)=>({...event,at:Math.max(0,Number(event.at)||0),_index:index})).sort((a,b)=>a.at-b.at||a._index-b._index);
    (battle?.allies||[]).slice(0,6).forEach((raw,i)=>this._unit(raw,'ally',i));(battle?.enemies||[]).slice(0,6).forEach((raw,i)=>this._unit(raw,'enemy',i));
    this.finished=false;this.result.hidden=true;this.eventIndex=0;this.time=0;this.lastFrame=0;this.seek(clamp(Number(battle?.time)||0,0,this.duration),true);
    if(this.time===0){this.eventIndex=0;for(const actor of this.units.values()){actor.hp=actor.initialHp;actor.shield=0;actor.dead=actor.hp<=0;actor.deathAt=actor.dead?0:null;this._bar(actor);}this._announce('战斗开始','start');}
    return new Promise(resolve=>{this.resolvePlay=resolve;if(this.time>=this.duration)queueMicrotask(()=>this._complete());});
  }

  setSpeed(speed) {this.speed=speed===2?2:1;}
  skip() {if(!this.battle||this.finished||this.disposed)return;this.seek(this.duration);}
  seek(seconds,silentEnd=false) {
    if(!this.battle||this.disposed)return;
    this._clearEffects();this.time=clamp(Number(seconds)||0,0,this.duration);this.eventIndex=0;
    for(const actor of [...this.units.values()])if(actor.summoned){this._removeUnit(actor);this.units.delete(actor.id);}
    for(const actor of this.units.values()){actor.hp=actor.initialHp;actor.shield=0;actor.buffUntil=0;actor.buffLabel.hidden=true;actor.stunned=false;actor.dead=actor.hp<=0;actor.deathAt=actor.dead?0:null;actor.action=null;actor.knockUntil=0;actor.flashUntil=0;if(actor.group){actor.group.visible=true;actor.group.position.copy(actor.base);actor.group.scale.setScalar(1);actor.group.rotation.z=0;actor.group.rotation.y=actor.side==='ally'?Math.PI:0;actor.body.rotation.set(0,0,0);}this._bar(actor);}
    while(this.eventIndex<this.events.length&&this.events[this.eventIndex].at<=this.time){this._apply(this.events[this.eventIndex++],true);}
    this.finished=false;this.result.hidden=true;this.banner.className='bv-announcement';
    if(this.time>=this.duration&&!silentEnd)this._complete();
  }

  _apply(event,silent=false) {
    if(event.type==='spawn'){
      const raw=event.unit;if(!raw?.id||this.units.has(String(raw.id)))return;
      const side=event.side==='allies'||event.side==='ally'?'ally':'enemy',owner=this.units.get(String(event.ownerId||raw.ownerId));
      const peers=[...this.units.values()].filter(unit=>unit.summoned&&unit.raw.ownerId===(event.ownerId||raw.ownerId)&&!unit.dead).length;
      const base=owner?{x:owner.base.x+(peers%2?-.62:.62),z:owner.base.z+(side==='ally'?-.40:.40)}:null;
      const summoned=this._unit({...raw,summon:true,ownerId:event.ownerId||raw.ownerId,...(base?{position:base}:{})},side,Number(raw.slot)||0);
      if(!silent){this._ring(summoned.base,0xc7deff,.8,.7);this._float(summoned,'参战','shield');this.onEvent?.(event);}return;
    }
    const actor=this.units.get(String(event.actorId)),target=this.units.get(String(event.targetId??event.actorId)),type=event.type;
    if(target){
      if(Number.isFinite(Number(event.hpAfter)))target.hp=clamp(Number(event.hpAfter),0,target.maxHp);
      else if(type==='damage')target.hp=Math.max(0,target.hp-Math.max(0,Number(event.amount)||0));
      else if(type==='heal')target.hp=Math.min(target.maxHp,target.hp+Math.max(0,Number(event.amount)||0));
      if(event.shieldAfter!==undefined)target.shield=Math.max(0,Number(event.shieldAfter)||0);else if(type==='shield')target.shield=Math.max(0,Number(event.amount)||0);
      if(type==='buff'){target.buffUntil=event.at+(Number(event.duration)||3);target.buffLabel.textContent=event.stunned?'禁锢':event.speedMultiplier>1?'攻速↑ 暴击↑':event.label||'增益';target.stunned=!!event.stunned;target.buffLabel.hidden=target.buffUntil<=this.time;}
      if(type==='heal'&&target.hp>0){target.dead=false;target.deathAt=null;}
      if(type==='defeat'||target.hp<=0){target.dead=true;target.deathAt=silent?Math.max(0,event.at-.8):this.time;target.hp=0;if(type==='defeat')target.expired=event.reason==='expired';}
      this._bar(target);
    }
    if(!silent){
      if((type==='attack'||type==='skill')&&actor&&!actor.dead){actor.action={start:this.time,duration:Number(event.duration)||(type==='skill'?1.05:.68),target:target?.base.clone(),kind:type};if(type==='skill'){this._announce(`${actor.raw.name} · ${event.label||'技能'}`,'skill');this._ring(actor.base,0xffdf7a,1.0);this.shakeUntil=this.time+.35;}if(target){if(['ranger','ranged','marksman','shooter','engineer','healer','support','mage','wizard'].includes(actor.job)||actor.kind==='robot')this._projectile(actor,target,type==='skill');else this._ring(target.base,type==='skill'?0xffd479:0xffe8b0,.45,.5);}}
      if(type==='damage'&&target){this._float(target,`−${Math.round(Number(event.amount)||0)}`,event.critical||event.label==='暴击'?'critical':'damage');target.flashUntil=this.time+.20;target.knockUntil=this.time+.22;this._ring(target.base,0xffdba6,.40,.45);if(actor&&/雷/.test(`${actor.raw.name}${event.label||''}`))this._lightning(actor,target);}
      if(type==='heal'&&target){this._float(target,`+${Math.round(Number(event.amount)||0)}`,'heal');this._ring(target.base,0xa3edb2,.85,.65);}
      if(type==='shield'&&target){this._float(target,event.label||'护盾','shield');this._ring(target.base,0x8edfe8,.9,.7);}
      if(type==='buff'&&target){this._float(target,event.label||(event.stunned?'禁锢':'攻速↑'),'buff');this._ring(target.base,event.stunned?0xc7a3f4:0xffdf8e,.9,.75);}
      if(type==='knockback'&&target)target.knockUntil=this.time+.42;
      if(type==='defeat'&&target){if(event.reason==='expired')target.expired=true;else this._float(target,'击倒','defeat');}
      this.onEvent?.(event);
    }
  }

  _bar(actor) {
    actor.fill.style.width=`${actor.hp/actor.maxHp*100}%`;actor.shieldBar.style.width=`${clamp(actor.shield/actor.maxHp,0,1)*100}%`;
    actor.label.classList.toggle('is-defeated',actor.dead);actor.label.setAttribute('aria-label',`${actor.raw.name}，${Math.ceil(actor.hp)}/${actor.maxHp} 生命${actor.shield?'，护盾 '+actor.shield:''}`);
    if(actor.shieldMesh)actor.shieldMesh.visible=actor.shield>0&&!actor.dead;
  }
  _float(actor,text,kind) {const node=create('span',`bv-float is-${kind}`,text);this.fxLayer.appendChild(node);this.floats.push({node,actor,start:this.time,duration:kind==='defeat'?1.0:.85,index:this.floats.length%3});}
  _announce(text,type) {this.banner.textContent=text;this.banner.className=`bv-announcement is-show is-${type}`;this.bannerUntil=this.time+1.05;}
  _ring(position,color,duration=.7,maxScale=1) {
    if(!this.renderer)return;const mesh=new THREE.Mesh(new THREE.RingGeometry(.22,.28,28),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.8,side:THREE.DoubleSide,depthWrite:false}));mesh.rotation.x=-Math.PI/2;mesh.position.copy(position);mesh.position.y+=.025;this.scene.add(mesh);this.effects.push({kind:'ring',mesh,start:this.time,duration,maxScale});
  }
  _projectile(actor,target,skill) {
    if(!this.renderer)return;const color=actor.job==='mage'?0x9ddfff:skill?0xffd979:0xf2e6bc,mesh=new THREE.Mesh(this._geo('sphere',[skill?.13:.075,8,5]),new THREE.MeshBasicMaterial({color}));this.scene.add(mesh);this.effects.push({kind:'projectile',mesh,from:actor.base.clone().add(new THREE.Vector3(0,actor.bodyHeight||.88,0)),to:target.base.clone().add(new THREE.Vector3(0,target.bodyHeight||.70,0)),start:this.time,duration:skill?.48:.32});
  }
  _lightning(actor,target) {
    if(!this.renderer)return;const from=actor.base.clone().add(new THREE.Vector3(0,1,0)),to=target.base.clone().add(new THREE.Vector3(0,.75,0)),points=[];
    for(let i=0;i<9;i++){const p=from.clone().lerp(to,i/8);if(i>0&&i<8){p.x+=(i%2?1:-1)*.13;p.y+=(i%3-1)*.15;}points.push(p);}
    const geometry=new THREE.BufferGeometry().setFromPoints(points),mesh=new THREE.Line(geometry,new THREE.LineBasicMaterial({color:0xb4eaff,transparent:true,opacity:1,depthWrite:false}));this.scene.add(mesh);this.effects.push({kind:'lightning',mesh,start:this.time,duration:.42});
  }

  _updateActors(dt) {
    const anchors=[];
    for(const actor of this.units.values()) {
      if(actor.group){
        const t=this.time,group=actor.group;group.position.copy(actor.base);group.rotation.z=0;
        if(actor.dead){const p=clamp((t-(actor.deathAt??t))/.65,0,1);group.rotation.z=(actor.side==='ally'?-1:1)*p*1.3;group.position.y=.205-p*.08;group.scale.setScalar(actor.expired?Math.max(.01,1-p):1-p*.28);actor.label.style.opacity=String(1-p*.75);if(actor.summoned&&p>=1)group.visible=false;}
        else {
          actor.label.style.opacity='1';group.scale.setScalar(1);group.position.y+=Math.sin(t*2+actor.phase)*.015;actor.leftArm.rotation.x=-.12+Math.sin(t*2+actor.phase)*.035;actor.rightArm.rotation.x=-.2-Math.sin(t*2+actor.phase)*.035;actor.leftLeg.rotation.x=actor.rightLeg.rotation.x=0;
          const action=actor.action;if(action){const p=clamp((t-action.start)/action.duration,0,1),motion=Math.sin(p*Math.PI);actor.rightArm.rotation.x=-.3-motion*1.65;actor.leftArm.rotation.x=-.1-motion*.6;actor.body.rotation.x=motion*.10;
            if(action.target&&((!actor.kind&&['warrior','fighter','tank','assassin'].includes(actor.job))||actor.kind==='dog')){const delta=action.target.clone().sub(actor.base),distance=delta.length();if(distance>.1){delta.multiplyScalar(Math.min(distance-.75,2.5)/distance);group.position.addScaledVector(delta,motion*.75);group.rotation.y=Math.atan2(action.target.x-actor.base.x,action.target.z-actor.base.z);actor.leftLeg.rotation.x=Math.sin(p*16)*.35;actor.rightLeg.rotation.x=-actor.leftLeg.rotation.x;}}
            if(p>=1){actor.action=null;actor.body.rotation.x=0;group.rotation.y=actor.side==='ally'?Math.PI:0;}
          }
          if(actor.knockUntil>t)group.position.z+=(actor.side==='ally'?1:-1)*Math.sin((actor.knockUntil-t)/.22*Math.PI)*.18;
        }
        actor.flashMesh.visible=actor.flashUntil>t&&!actor.dead;actor.flashMesh.material.opacity=actor.flashMesh.visible?.45:0;
        if(actor.shieldMesh.visible)actor.shieldMesh.material.opacity=.17+Math.sin(t*3+actor.phase)*.045;
        actor.buffLabel.hidden=actor.dead||actor.buffUntil<=t;if(!actor.buffLabel.hidden&&actor.stunned)group.rotation.z=Math.sin(t*12)*.045;
      }
      const point=this._project(actor,actor.labelHeight||1.45);actor.label.hidden=(actor.summoned&&actor.dead&&this.time-(actor.deathAt||0)>.65)||point.x<4||point.x>this.width-4||point.y<10||point.y>this.height+20;
      if(actor.dead&&this.time-(actor.deathAt||0)>.95)actor.label.hidden=true;
      actor.buffLabel.hidden=actor.dead||actor.buffUntil<=this.time;
      if(!actor.label.hidden)anchors.push({actor,point});
    }
    const placed=[];
    anchors.sort((a,b)=>Number(a.actor.summoned)-Number(b.actor.summoned)||a.point.y-b.point.y);
    for(const {actor,point}of anchors){
      const width=actor.summoned?52:66,height=actor.buffUntil>this.time?30:20;let best=null,bestScore=Infinity;
      for(const dy of [0,-12,12,-24,24,-36,36,-48,48])for(const dx of [0,-14,14,-28,28]){
        const x=clamp(point.x+dx,width/2+2,this.width-width/2-2),y=clamp(point.y+dy,height+2,this.height-4),rect={left:x-width/2,right:x+width/2,top:y-height,bottom:y};
        let penalty=0;for(const other of placed){const w=Math.min(rect.right,other.right)-Math.max(rect.left,other.left),h=Math.min(rect.bottom,other.bottom)-Math.max(rect.top,other.top);if(w>0&&h>0)penalty+=w*h*15;}
        const score=dx*dx+dy*dy+penalty;if(score<bestScore){bestScore=score;best={x,y,rect};}
      }
      placed.push(best.rect);actor.label.style.left=`${best.x}px`;actor.label.style.top=`${best.y}px`;
    }
  }

  _project(actor,height=.9) {
    if(this.renderer){const position=actor.group?actor.group.position.clone():actor.base.clone();position.y+=height;position.project(this.camera);return{x:(position.x+1)*this.width/2,y:(1-position.y)*this.height/2};}
    const enemy=actor.side==='enemy',slot=Number(actor.raw.slot||0),col=slot%3,row=Math.floor(slot/3);return{x:this.width*(.25+col*.25),y:this.height*(enemy?.25-row*.12:.57+row*.14)-height*18};
  }
  _updateEffects() {
    for(let i=this.effects.length-1;i>=0;i--){const effect=this.effects[i],p=clamp((this.time-effect.start)/effect.duration,0,1);if(effect.kind==='ring'){effect.mesh.scale.setScalar(.6+p*2.5*effect.maxScale);effect.mesh.material.opacity=(1-p)*.8;}else if(effect.kind==='projectile'){effect.mesh.position.lerpVectors(effect.from,effect.to,p);effect.mesh.position.y+=Math.sin(p*Math.PI)*.40;}else if(effect.kind==='lightning')effect.mesh.material.opacity=1-p;if(p>=1){effect.mesh.removeFromParent();if(effect.kind!=='projectile')effect.mesh.geometry.dispose();effect.mesh.material.dispose();this.effects.splice(i,1);}}
    for(let i=this.floats.length-1;i>=0;i--){const item=this.floats[i],p=clamp((this.time-item.start)/item.duration,0,1),point=this._project(item.actor,1.13);item.node.style.left=`${point.x+(item.index-1)*10}px`;item.node.style.top=`${point.y-p*45}px`;item.node.style.opacity=String(p>.6?(1-p)/.4:1);item.node.style.transform=`translate(-50%,-50%) scale(${p<.12?.7+p*3:1})`;if(p>=1){item.node.remove();this.floats.splice(i,1);}}
    if(this.bannerUntil<this.time)this.banner.classList.remove('is-show');
  }

  _complete() {
    if(this.finished||this.disposed||!this.battle)return;this.finished=true;this.time=this.duration;const result=this.battle.result==='victory'?'victory':'defeat',payload={battleId:this.battleId,result,time:this.time};
    this.result.replaceChildren(create('small','',result==='victory'?'海风站在我们这边':'整顿阵容，再次出发'),create('strong','',result==='victory'?'胜 利':'战 败'));this.result.className=`bv-result is-${result}`;this.result.hidden=false;
    if(!this.completedIds.has(this.battleId)){this.completedIds.add(this.battleId);this.onComplete?.(payload);}this.resolvePlay?.(payload);this.resolvePlay=null;
  }
  _clearEffects() {for(const effect of this.effects){effect.mesh.removeFromParent();if(effect.kind!=='projectile')effect.mesh.geometry.dispose();effect.mesh.material.dispose();}this.effects=[];for(const item of this.floats)item.node.remove();this.floats=[];}
  _removeUnit(actor) {actor.label.remove();if(actor.group){actor.group.removeFromParent();actor.group.traverse(object=>{if(object.userData.ownedGeometry)object.geometry?.dispose();if(object===actor.shieldMesh||object===actor.flashMesh||object===actor.foot)object.material?.dispose();});}}
  _clearBattle() {this._clearEffects();for(const actor of this.units.values())this._removeUnit(actor);this.units.clear();}

  _resize() {
    this.width=Math.max(1,this.container.clientWidth||390);this.height=Math.max(1,this.container.clientHeight||500);const aspect=this.width/this.height;
    if(this.renderer){this.renderer.setSize(this.width,this.height,false);const wide=aspect>1.7,viewWidth=aspect<1?8.9:(wide?6.2:10.2)*aspect;this.camera.position.set(5.2,wide?7.2:15.5,wide?16.8:13.5);this.camera.lookAt(0,.1,0);this.camera.left=-viewWidth/2;this.camera.right=viewWidth/2;this.camera.top=viewWidth/aspect/2;this.camera.bottom=-viewWidth/aspect/2;this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld();}
    else if(this.fallback){const dpr=Math.min(window.devicePixelRatio||1,1.5);this.fallback.width=this.width*dpr;this.fallback.height=this.height*dpr;this.context.setTransform(dpr,0,0,dpr,0,0);}
  }
  _fallbackFrame() {
    const c=this.context;if(!c)return;c.clearRect(0,0,this.width,this.height);c.fillStyle='#2c659d';c.fillRect(0,0,this.width,this.height);
    for(const y of [.15,.50]){c.fillStyle='#30355e';c.fillRect(this.width*.12,this.height*y,this.width*.76,this.height*.28);c.fillStyle='#b3b8ad';c.fillRect(this.width*.13,this.height*y+4,this.width*.74,this.height*.28-8);}
    for(const actor of this.units.values()){if(actor.dead)continue;const p=this._project(actor,0),color=actor.raw.color||`#${(PALETTE[actor.job]||0xd26455).toString(16)}`;c.fillStyle=color;c.fillRect(p.x-10,p.y-18,20,23);c.fillStyle='#e4b68b';c.beginPath();c.arc(p.x,p.y-30,14,0,Math.PI*2);c.fill();c.fillStyle='#403548';c.beginPath();c.ellipse(p.x,p.y-38,14,8,0,0,Math.PI*2);c.fill();}
  }
  _frame(now) {
    if(this.disposed)return;this.raf=requestAnimationFrame(this.frame);const dt=Math.min((now-(this.lastFrame||now))/1000,.08);this.lastFrame=now;
    if(this.battle&&!this.finished&&!document.hidden){this.time=Math.min(this.duration,this.time+dt*this.speed);while(this.eventIndex<this.events.length&&this.events[this.eventIndex].at<=this.time)this._apply(this.events[this.eventIndex++]);if(this.time>=this.duration)this._complete();}
    if(this.waterMaterial)this.waterMaterial.uniforms.time.value=now/1000;
    this._updateActors(dt);this._updateEffects();
    if(this.renderer){if(this.shakeUntil>this.time&&this.arena)this.arena.rotation.z=Math.sin(now*.07)*.004;else if(this.arena)this.arena.rotation.z=0;this.renderer.render(this.scene,this.camera);}else this._fallbackFrame();
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.raf);this.observer.disconnect();this.resolvePlay?.({cancelled:true});this.resolvePlay=null;this._clearBattle();
    if(this.renderer){const geometries=new Set(),materials=new Set();this.scene.traverse(object=>{if(object.geometry)geometries.add(object.geometry);if(object.material)materials.add(object.material);});this.geometries.forEach(g=>geometries.add(g));this.materials.forEach(m=>materials.add(m));geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());this.renderer.forceContextLoss();this.renderer.dispose();}
    this.root.remove();
  }
}

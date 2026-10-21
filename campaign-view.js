import * as THREE from './node_modules/three/build/three.module.js';
import { BattleView } from './battle-view.js';

const clamp=THREE.MathUtils.clamp;
const INK=0x233455;
const HERO_COLORS={wizard:0xc74964,lei:0xa1b8d2,loyal:0x739b83,mechanic:0xc78c62,sam:0xd39a51,rambo:0x8eaf58,mia:0x7fb7cc,yilong:0xdeb257};

/** A presentation-only voyage preview. It never creates a battle or grants rewards. */
export class CampaignView extends BattleView {
  constructor(container) {
    super(container);
    this.root.classList.add('cv-root');
    this.root.setAttribute('aria-label','远海航行中的救援船与当前阵容');
    this.root.style.background='#145886';
    this.root.style.pointerEvents='none';
    this.root.style.touchAction='auto';
    this.labels.style.overflow='visible';
    this.banner.hidden=true;this.result.hidden=true;
    this.previewClock=0;
    this.reducedMotion=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches||false;
    if(this.renderer)this.renderer.toneMappingExposure=.96;
  }

  _world() {
    this.scene.background=new THREE.Color(0x176a94);
    this.scene.fog=new THREE.FogExp2(0x4195b6,.013);
    this.scene.add(new THREE.HemisphereLight(0xcde5f5,0x35426c,2.05));
    const sun=new THREE.DirectionalLight(0xffedca,2.25);sun.position.set(-7,15,10);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-7,right:7,top:7,bottom:-7,near:1,far:37});sun.shadow.normalBias=.04;sun.shadow.bias=-.00015;this.scene.add(sun);
    const fill=new THREE.DirectionalLight(0xa8c9eb,.65);fill.position.set(8,6,-5);this.scene.add(fill);
    this.waterMaterial=new THREE.ShaderMaterial({uniforms:{time:{value:0}},vertexShader:`varying vec2 v;void main(){vec4 p=modelMatrix*vec4(position,1.);v=p.xz;gl_Position=projectionMatrix*viewMatrix*p;}`,fragmentShader:`
      varying vec2 v;uniform float time;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      void main(){
        vec2 p=v+vec2(.08*sin(time*.2),time*.48);vec2 cell=floor(p/2.7);vec2 q=mod(p,2.7)-1.35;
        q-=vec2(hash(cell)*1.0-.5,hash(cell+4.)*.8-.4);
        float ridge=abs(q.y-(.11-abs(q.x)*.20));
        float shortWave=(1.-smoothstep(.018,.055,ridge))*(1.-smoothstep(.30,.59,abs(q.x)))*step(.24,hash(cell+7.));
        float broad=sin(v.x*.42+v.y*.24+sin(v.y*.31)*.6)*.5+.5;
        vec3 col=mix(vec3(.018,.075,.19),vec3(.035,.19,.35),broad);
        col=mix(col,vec3(.055,.25,.43),smoothstep(2.,-20.,v.y)*.53);
        col=mix(col,vec3(.66,.85,.91),shortWave*.75);
        float tail=max(0.,-v.y-1.);float edge=abs(v.x)-(2.65+tail*.14);
        float wake=(1.-smoothstep(.07,.24,abs(edge+sin(v.y*2.2+time*2.)*.10)))*smoothstep(6.,3.8,v.y)*smoothstep(-16.,-10.,v.y);
        col=mix(col,vec3(.78,.90,.94),wake*.72);
        gl_FragColor=vec4(col,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`});
    const water=new THREE.Mesh(new THREE.PlaneGeometry(120,120),this.waterMaterial);water.rotation.x=-Math.PI/2;water.position.y=-.32;this.scene.add(water);
    this.arena=new THREE.Group();this.boat=this.arena;this.scene.add(this.arena);
    this._ship();
    this._mergeStatic(this.arena);
    this._hull(this.arena,.019);
    this.unitGroup=new THREE.Group();this.arena.add(this.unitGroup);
    this._wake();
    this._distantCity();
  }

  _shape(points,height,depth,color,parent=this.arena) {
    const shape=new THREE.Shape();points.forEach(([x,z],i)=>i?shape.lineTo(x,-z):shape.moveTo(x,-z));shape.closePath();
    const geometry=depth?new THREE.ExtrudeGeometry(shape,{depth,bevelEnabled:false,curveSegments:1}):new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI/2);
    return this._mesh(parent,geometry,this._mat(color),0,height,0);
  }

  _ship() {
    const g=this.arena;
    this._shape([[-2.55,-4.35],[2.55,-4.35],[2.68,2.76],[1.75,4.12],[0,4.78],[-1.75,4.12],[-2.68,2.76]],-.40,.56,0x416d7e);
    this._shape([[-2.47,-4.25],[2.47,-4.25],[2.56,2.73],[1.67,4.02],[0,4.62],[-1.67,4.02],[-2.56,2.73]],.18,.12,0x273959);
    this._shape([[-2.34,-4.14],[2.34,-4.14],[2.42,2.69],[1.56,3.89],[0,4.42],[-1.56,3.89],[-2.42,2.69]],.305,0,0xada99a);
    const deckColors=[0xbab6a5,0xa9afa5,0xb9bbaa,0xaaa89b,0xb7b4a4];
    for(let row=0;row<4;row++)for(let col=0;col<3;col++){
      const x=(col-1)*1.52,z=-3.35+row*1.76;
      this._box(g,1.49,.035,1.71,deckColors[(row+col*2)%deckColors.length],x,.33,z);
      this._box(g,1.45,.018,.020,0x616b74,x,.354,z+.82);
      for(const dx of [-.62,.62])this._cyl(g,.025,.018,0x536575,x+dx,.359,z+.67,5);
    }
    for(const [x,z,w,d,c]of [[-1.95,-.2,.45,.75,0x8dad9a],[1.8,1.3,.62,.38,0x8eaba4],[-.3,3.3,.90,.38,0xbd966f],[.9,-.4,.45,.65,0xb5957a]]){
      const plate=this._box(g,w,.027,d,c,x,.37,z);plate.rotation.y=x*.08;
    }
    for(const side of [-1,1]){
      const x=side*2.49;
      for(const z of [-3.95,-1.65,.60,2.7]){
        this._box(g,.09,.82,.10,0x7d7467,x,.72,z);
        this._sphere(g,.073,0xd0b490,x,1.15,z,7);
      }
      this._beam(g,[x,1.12,-4],[x,1.12,2.76],.075,0x9c8a73);
      this._beam(g,[x,.67,-4],[x,.67,2.76],.045,0xb4a68b);
      this._beam(g,[x,1.12,2.76],[side*1.61,.93,3.97],.075,0x96826f);
      this._beam(g,[side*1.61,.93,3.97],[0,.84,4.55],.075,0x948676);
      for(const z of [-3.2,-.85,1.55]){
        const tyre=this._mesh(g,this._geo('torus',[.30,.095,7,13]),this._mat(0x263c57),side*2.67,.04,z);tyre.rotation.y=Math.PI/2;
        this._beam(g,[side*2.52,.70,z],[side*2.67,.05,z],.028,0xc6ae84);
        this._box(g,.035,.42,.24,0xa5785f,side*2.67,-.10,z+.47);
      }
      for(let i=0;i<7;i++){
        const z=-3.7+i*.96;this._box(g,.035,.19,.29,i%3===0?0x6b9f9c:0xb3836e,side*2.575,-.05,z);
        this._box(g,.038,.045,.60,0xc4ab85,side*2.58,.12,z);
      }
    }
    this._beam(g,[-2.48,1.1,-4.08],[2.48,1.1,-4.08],.08,0xa08c75);
    this._box(g,4.35,.15,3.24,0x344e6b,0,.47,-2.47);
    this._box(g,4.18,2.13,3.07,0x7da9ab,0,1.60,-2.47);
    const boards=[0x85b9b9,0x719da6,0x94b8af,0x7ba9b8,0x9cb1a5];
    for(let i=0;i<13;i++){
      const x=-1.96+i*.325;
      this._box(g,.24,1.98,.032,boards[i%5],x,1.58,-.913);
      this._box(g,.022,2.02,.042,0x4d7991,x+.137,1.58,-.884);
      this._box(g,.23,.13+.14*(i%3),.039,0xb39f80,x,.66+(i%2)*.39,-.883);
    }
    for(const side of [-1,1])for(let i=0;i<10;i++){
      const z=-3.82+i*.30;
      this._box(g,.035,2.0,.23,boards[(i+2)%5],side*2.115,1.59,z);
      this._box(g,.044,2.02,.020,0x4c7f94,side*2.14,1.59,z+.13);
      if(i%3===0)this._box(g,.044,.35,.20,0xb19b76,side*2.15,1.01+(i%2)*.65,z);
    }
    for(const x of [-2.17,2.17]){
      this._box(g,.12,2.32,.12,0x31668a,x,1.59,-.91);
      this._box(g,.12,2.32,.12,0x31668a,x,1.59,-4.01);
    }
    for(const z of [-.87,-4.05]){
      this._box(g,4.48,.10,.13,0x527f94,0,2.74,z);
      this._box(g,4.48,.10,.14,0xaa8868,0,.51,z);
    }
    // Open-looking doorway and small salvaged windows preserve the patchwork silhouette.
    this._box(g,.88,1.69,.060,0x294f66,.37,1.33,-.844);
    this._box(g,.69,1.56,.065,0x48798a,.39,1.31,-.805);
    this._box(g,.50,.60,.035,0x3b5667,.40,1.65,-.764);
    this._box(g,.43,.48,.040,0x7facb1,.40,1.65,-.741);
    this._box(g,.030,.50,.048,0x365474,.40,1.65,-.712);
    this._box(g,.45,.035,.048,0x365474,.40,1.65,-.709);
    this._sphere(g,.047,0xc6ac79,.66,1.17,-.72,7);
    this._box(g,.88,.67,.065,0x365d78,-1.17,1.91,-.841);
    this._box(g,.72,.52,.070,0x83bac8,-1.17,1.91,-.798);
    this._box(g,.050,.55,.081,0x436887,-1.17,1.91,-.750);
    this._box(g,.76,.045,.081,0x436887,-1.17,1.91,-.749);
    this._box(g,.065,.70,.92,0x365d78,2.175,1.96,-2.48);
    this._box(g,.070,.52,.74,0x88b6c5,2.218,1.96,-2.48);
    this._box(g,.08,.55,.04,0x3c6380,2.261,1.96,-2.48);
    this._box(g,.08,.035,.78,0x3c6380,2.262,1.96,-2.48);
    const roof=this._box(g,4.68,.13,3.48,0x5e9095,0,2.86,-2.47);roof.rotation.z=-.025;
    const roofA=this._box(g,2.32,.045,3.31,0x70a49a,-1.10,2.97,-2.47);roofA.rotation.z=-.045;
    const roofB=this._box(g,1.94,.042,2.84,0x8aad9c,1.10,2.97,-2.46);roofB.rotation.z=.040;
    for(let i=0;i<9;i++)this._box(g,4.45,.025,.020,0x3f717f,0,3.01,-3.97+i*.38);
    this._box(g,1.33,.035,.63,0xb1b7a1,-.77,3.04,-1.23).rotation.y=-.12;
    this._box(g,.54,.040,1.35,0x8d9c8c,1.31,3.04,-2.75).rotation.y=.18;
    for(const [x,z]of [[-1.80,-1.45],[1.70,-3.5]]){
      this._cyl(g,.14,.81,0x967a5e,x,3.40,z,9);
      this._cyl(g,.17,.10,0x465a70,x,3.81,z,9);
    }
    this._beam(g,[1.65,2.94,-3.4],[1.75,4.55,-3.4],.05,0x3f5271);
    this._beam(g,[.98,4.18,-3.4],[2.39,4.18,-3.4],.035,0x49617c);
    this._beam(g,[1.15,4.37,-3.41],[2.20,4.05,-3.41],.035,0x49617c);
    this._beam(g,[-1.65,3.02,-3.8],[-1.82,3.91,-3.8],.045,0x74664f);
    const flagShape=new THREE.Shape();flagShape.moveTo(0,0);flagShape.lineTo(.65,-.08);flagShape.lineTo(.45,-.25);flagShape.lineTo(.65,-.45);flagShape.lineTo(0,-.37);flagShape.closePath();
    const flag=new THREE.Mesh(new THREE.ShapeGeometry(flagShape),this._mat(0xe4bb67,{side:THREE.DoubleSide}));flag.position.set(-1.82,3.89,-3.80);g.add(flag);
    // A rolled tarp, rope coils, spare cans, and patched timber keep the craft lived-in.
    this._box(g,.77,.25,.38,0xc5b38b,-1.36,.50,-.19);
    this._box(g,.69,.032,.31,0xead0a3,-1.36,.645,-.19);
    for(const x of [-1.55,-1.19])this._box(g,.035,.25,.39,0x626c79,x,.51,-.19);
    const barrel=this._cyl(g,.26,.64,0xad7d56,1.63,.66,-.28,12);
    for(const y of [.43,.83])this._cyl(g,.275,.055,0x516579,1.63,y,-.28,12);
    const coil=this._mesh(g,this._geo('torus',[.23,.034,6,18]),this._mat(0xc5aa7d),-1.92,.41,2.13);coil.rotation.x=-Math.PI/2;
    const coil2=this._mesh(g,this._geo('torus',[.17,.033,6,18]),this._mat(0xc5aa7d),-1.92,.41,2.13);coil2.rotation.x=-Math.PI/2;
    const life=this._mesh(g,this._geo('torus',[.27,.08,7,16]),this._mat(0xd5bc92),-1.96,1.42,-.77);life.rotation.y=.12;
    for(const x of [-.50,.50])this._box(g,.11,.24,.22,0x596e83,x,.48,3.89);
    this._beam(g,[-.60,.59,3.89],[.60,.59,3.89],.10,0x74828c);
    this._nameplate();
  }

  _nameplate() {
    const canvas=document.createElement('canvas');canvas.width=384;canvas.height=96;const c=canvas.getContext('2d');
    c.fillStyle='#537e89';c.fillRect(0,0,384,96);c.font='900 57px sans-serif';c.textAlign='center';c.fillStyle='#d8ddc9';c.fillText('拾 浪 号',192,70);
    c.fillStyle='#537e89';for(let i=0;i<17;i++)c.fillRect((i*97)%384,(i*31)%91,8+(i%4)*5,2);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;this.nameplateTexture=texture;
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2.95,.65),new THREE.MeshStandardMaterial({map:texture,roughness:1}));mesh.rotation.y=Math.PI/2;mesh.position.set(2.67,-.01,.45);this.arena.add(mesh);
  }

  _foamRibbon(points,width,color=0xc0e2e7) {
    const positions=[];
    for(let i=0;i<points.length-1;i++){
      const a=new THREE.Vector3(points[i][0],-.285,points[i][1]),b=new THREE.Vector3(points[i+1][0],-.285,points[i+1][1]);const n=new THREE.Vector3(-(b.z-a.z),0,b.x-a.x).normalize().multiplyScalar(width*(.55+.30*Math.sin(i*1.7)));
      const a1=a.clone().add(n),a2=a.clone().sub(n),b1=b.clone().add(n),b2=b.clone().sub(n);positions.push(...a1.toArray(),...a2.toArray(),...b1.toArray(),...b1.toArray(),...a2.toArray(),...b2.toArray());
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide}));this.wakeGroup.add(mesh);return mesh;
  }

  _wake() {
    this.wakeGroup=new THREE.Group();this.scene.add(this.wakeGroup);
    const foamMaterials=[new THREE.MeshBasicMaterial({color:0xb9dde5}),new THREE.MeshBasicMaterial({color:0xe1f1ed})];
    for(const side of [-1,1]){
      this._foamRibbon(Array.from({length:20},(_,i)=>{const t=i/19;return[side*(2.47+Math.sin(t*Math.PI)*.58+t*t*1.07),4.0-t*14];}),.17);
      this._foamRibbon(Array.from({length:17},(_,i)=>{const t=i/16;return[side*(2.94+Math.sin(t*5)*.14+t*.95),2.5-t*12.5];}),.055,0x8ab9cd);
      this._foamRibbon(Array.from({length:11},(_,i)=>{const t=i/10;return[side*(.06+t*3.27),4.69-Math.sin(t*Math.PI/2)*1.22];}),.26,0xe2f1ed);
      for(let i=0;i<17;i++){
        const t=i/16,x=side*(2.65+Math.sin(t*Math.PI)*.61+t*t*.85),z=3.7-t*13.5;
        const foam=new THREE.Mesh(this._geo('sphere',[.12,6,3]),foamMaterials[i%3?0:1]);foam.position.set(x+Math.sin(i*2.8)*.23,-.27,z);foam.scale.set(.7+(i%4)*.3,.035,1.2+(i%3));this.wakeGroup.add(foam);
      }
    }
    this._mergeStatic(this.wakeGroup);
  }

  _distantCity() {
    const city=new THREE.Group();this.scene.add(city);this.city=city;
    const material=new THREE.MeshBasicMaterial({color:0x317f9f,transparent:true,opacity:.28,depthWrite:false});
    for(let i=0;i<9;i++){
      const x=(i-4)*2.9,z=-20-(i%3)*1.6,h=1.5+(i*7%5)*.65;
      this._mesh(city,this._geo('box',[1.1+(i%2)*.6,h,1.0]),material,x,h*.5-.35,z,false);
      if(i%3===1)this._mesh(city,this._geo('box',[.65,.50,.55]),material,x,h-.10,z,false);
    }
    this._mergeStatic(city);
  }

  showFormation(units=[]) {
    if(this.disposed)return;
    this._clearBattle();this.battle=null;this.finished=true;this.banner.hidden=true;this.result.hidden=true;
    const list=Array.isArray(units)?units.filter(Boolean).slice(0,5):[];
    const usedSlots=new Set();
    list.forEach((unit,index)=>{
      let slot=Math.floor(Number(unit.slot));if(!Number.isFinite(slot)||slot<0||slot>5||usedSlots.has(slot))slot=[0,1,2,3,4,5].find(n=>!usedSlots.has(n));usedSlots.add(slot);
      const col=slot%3,row=Math.floor(slot/3),id=String(unit.id??unit.heroId??`preview-${index}`),heroId=String(unit.heroId||unit.id||'');
      const actor=this._unit({...unit,id,slot,color:HERO_COLORS[heroId]??unit.color,position:{x:(col-1)*1.51,z:row?2.75:.94},maxHp:Math.max(1,Number(unit.maxHp??unit.stats?.maxHp)||1),hp:Math.max(1,Number(unit.maxHp??unit.stats?.maxHp)||1)},'ally',index);
      actor.level=Math.max(1,Math.floor(Number(unit.level)||1));actor.heroId=heroId;actor.base.y=.365;
      actor.group?.scale.setScalar(1.18);if(actor.group)actor.group.rotation.y=.10;
      actor.fill.parentElement.hidden=true;actor.label.querySelector('.bv-unit-job').style.display='none';
      actor.buffLabel.hidden=true;actor.label.style.width='90px';actor.label.style.textShadow='1px 1px 0 #172b4f,-1px -1px 0 #172b4f,1px -1px 0 #172b4f,-1px 1px 0 #172b4f,0 2px 0 #172b4f';
      const name=actor.label.querySelector('.bv-unit-name');name.style.display='none';actor.label.setAttribute('aria-label',`${unit.name||id}，${actor.level}级`);
      const level=document.createElement('strong');level.textContent=`${actor.level}级`;level.style.cssText='display:block;font-size:17px;font-weight:1000;line-height:1.2;color:#fffdf0;letter-spacing:-.2px';actor.label.appendChild(level);actor.levelLabel=level;
      this._heroDetails(actor);
    });
    this._resize();this._previewActors(0);
  }

  _heroDetails(actor) {
    if(!actor.body)return;const g=new THREE.Group(),id=actor.heroId;actor.body.add(g);
    if(id==='rambo'){
      this._box(g,.52,.09,.08,0xb94f4b,0,1.10,.21);this._box(g,.14,.035,.32,0xbe514b,-.27,1.09,-.05).rotation.x=.3;
      for(let i=0;i<5;i++)this._box(g,.045,.10,.035,0xe0c38d,-.18+i*.09,.55,.16);
    }else if(id==='loyal'){
      const hat=this._sphere(g,.30,0x728f75,0,1.13,0,12);hat.scale.y=.54;this._box(g,.54,.035,.20,0x4c6e6b,0,1.13,.16);
      this._box(g,.31,.25,.15,0x6d877a,0,.48,-.23);
    }else if(id==='mechanic'){
      for(const x of [-.27,.27])this._sphere(g,.125,0x9c6644,x,1.075,-.035,9);
      for(const x of [-.105,.105]){this._cyl(g,.084,.055,0x374c65,x,1.12,.22,10).rotation.x=Math.PI/2;this._cyl(g,.057,.060,0xa9d1cf,x,1.12,.25,10).rotation.x=Math.PI/2;}
      this._box(g,.15,.14,.08,0xbd694c,0,.47,.175);
    }else if(id==='lei'){
      for(let i=0;i<6;i++){const tuft=this._mesh(g,this._geo('cone',[.10,.28,4]),this._mat(0xd6e2dc),(i-2.5)*.08,1.23-Math.abs(i-2.5)*.015,-.01);tuft.rotation.z=(i-2.5)*-.28;}
      for(const x of [-.095,.095]){const lens=this._mesh(g,this._geo('torus',[.076,.017,6,12]),this._mat(0x344663),x,.98,.255);this._sphere(g,.062,0x9ec8cf,x,.98,.251,9).scale.z=.20;}
      this._box(g,.06,.019,.018,0x344663,0,.98,.263);
    }else if(id==='wizard'){
      this._box(g,.48,.11,.20,0x5e6799,0,.72,-.08);
      for(const x of [-.18,0,.18]){this._cyl(g,.042,.59,0xea63cd,x,1.17,-.29,7);this._sphere(g,.05,0xffa8e9,x,1.48,-.29,7);}
      this._box(g,.23,.036,.05,0xe1c26a,0,.57,.165);
    }else if(id==='sam'){
      for(let i=0;i<3;i++)this._mesh(g,this._geo('cone',[.070,.17,3]),this._mat(0xe1bf69),(i-1)*.14,1.30,.05);
      this._box(g,.43,.080,.13,0x88597c,0,1.20,.07);
    }
    // Details form their own batch, keeping the inherited mesh and its ownership intact.
    this._mergeStatic(g);if(g.children.length)this._hull(g,.014);
  }

  _project(actor,height=0) {
    if(this.renderer&&actor.group){const point=actor.group.getWorldPosition(new THREE.Vector3());point.y+=height;point.project(this.camera);return{x:(point.x+1)*this.width/2,y:(1-point.y)*this.height/2};}
    const col=Number(actor.raw.slot||0)%3,row=Math.floor(Number(actor.raw.slot||0)/3);return{x:this.width*(.25+col*.25),y:this.height*(.53+row*.18)-height*18};
  }

  _previewActors(t) {
    for(const actor of this.units.values()){
      if(actor.group){actor.group.position.copy(actor.base);actor.group.position.y+=Math.sin(t*1.7+actor.phase)*.010;actor.group.rotation.y=.10+Math.sin(t*.50+actor.phase)*.035;actor.leftArm.rotation.x=-.08+Math.sin(t*1.5+actor.phase)*.035;actor.rightArm.rotation.x=-.14-Math.sin(t*1.5+actor.phase)*.035;actor.group.updateWorldMatrix(true,true);}
      const p=this._project(actor,-.05);actor.label.hidden=p.x<-20||p.x>this.width+20||p.y<0||p.y>this.height-15;actor.label.style.left=`${clamp(p.x,42,this.width-42)}px`;actor.label.style.top=`${p.y+29}px`;actor.label.style.opacity='1';
    }
  }

  _resize() {
    this.width=Math.max(1,this.container.clientWidth||390);this.height=Math.max(1,this.container.clientHeight||600);const aspect=this.width/this.height;
    if(this.renderer){this.renderer.setSize(this.width,this.height,false);const viewHeight=aspect>=1?10.6:Math.max(10.5,8.35/aspect),viewWidth=viewHeight*aspect;
      this.camera.position.set(8.2,13.5,16.8);this.camera.lookAt(0,.65,-.25);this.camera.left=-viewWidth/2;this.camera.right=viewWidth/2;this.camera.top=viewHeight/2;this.camera.bottom=-viewHeight/2;this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld();
    }else if(this.fallback){const dpr=Math.min(window.devicePixelRatio||1,1.5);this.fallback.width=this.width*dpr;this.fallback.height=this.height*dpr;this.context.setTransform(dpr,0,0,dpr,0,0);}
  }

  _fallbackFrame() {
    const c=this.context;if(!c)return;const w=this.width,h=this.height;c.fillStyle='#195887';c.fillRect(0,0,w,h);
    c.strokeStyle='#a7dce7';c.lineWidth=2;for(let i=0;i<14;i++){const x=(i*97)%w,y=(i*113+this.previewClock*10)%h;c.beginPath();c.moveTo(x,y);c.quadraticCurveTo(x+14,y-4,x+26,y);c.stroke();}
    const left=w*.12,right=w*.88,top=h*.22,bottom=h*.77;c.fillStyle='#37516a';c.beginPath();c.moveTo(left,top);c.lineTo(right,top);c.lineTo(right,bottom-30);c.lineTo(w*.5,bottom+30);c.lineTo(left,bottom-30);c.closePath();c.fill();c.fillStyle='#b3b5a4';c.fillRect(left+6,top+6,right-left-12,bottom-top-23);c.fillStyle='#7ea9ad';c.fillRect(w*.18,top-28,w*.64,h*.19);c.fillStyle='#608f8f';c.fillRect(w*.16,top-40,w*.68,17);
    for(const actor of this.units.values()){const p=this._project(actor);c.fillStyle=new THREE.Color(actor.raw.color||0xd1a266).getStyle();c.fillRect(p.x-11,p.y-27,22,29);c.fillStyle='#dfb18a';c.beginPath();c.arc(p.x,p.y-39,14,0,Math.PI*2);c.fill();c.fillStyle='#40384c';c.fillRect(p.x-12,p.y-51,24,10);}
  }

  _frame(now) {
    if(this.disposed)return;this.raf=requestAnimationFrame(this.frame);const dt=Math.min((now-(this.lastFrame||now))/1000,.08);this.lastFrame=now;
    if(!document.hidden)this.previewClock=(this.previewClock||0)+dt;
    const t=this.reducedMotion?0:(this.previewClock||0);this.time=t;
    if(this.waterMaterial)this.waterMaterial.uniforms.time.value=t;
    if(this.boat){this.boat.position.y=Math.sin(t*1.1)*.025;this.boat.rotation.z=Math.sin(t*.68)*.006;this.boat.rotation.x=Math.sin(t*.78)*.004;this.boat.updateWorldMatrix(true,true);}
    if(this.wakeGroup)this.wakeGroup.scale.x=1+Math.sin(t*1.4)*.012;
    this._previewActors(t);
    if(this.renderer)this.renderer.render(this.scene,this.camera);else this._fallbackFrame();
  }

  dispose() {if(this.disposed)return;this.nameplateTexture?.dispose();super.dispose();}
}

import * as THREE from './node_modules/three/build/three.module.js';

const clamp=THREE.MathUtils.clamp;
const KINDS=['wood','plastic','cloth'];
const INK=0x243957;
const hash=value=>{let n=0;for(const c of String(value))n=(Math.imul(n,31)+c.charCodeAt(0))>>>0;return n;};
const number=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const angleLerp=(a,b,t)=>a+Math.atan2(Math.sin(b-a),Math.cos(b-a))*t;

/** Read-only rendering of GameState.getScavenging(). Movement and loot remain authoritative in GameState. */
export class ScavengingView {
  constructor(container) {
    this.container=container;this.disposed=false;this.paused=false;this.clock=0;this.lastTime=0;this.tripId=null;
    this.nodes=new Map();this.sharks=new Map();this.fishSchools=new Map();this.batches=new Map();this.geometries=new Map();this.ownedGeometries=new Set();this.materials=new Set();this.ripples=[];
    this.position=new THREE.Vector3();this.targetPosition=new THREE.Vector3();this.heading=0;this.targetHeading=0;this.speed=0;this.cargoSignature='';
    this.root=document.createElement('div');this.root.setAttribute('aria-label','海上手动拾荒场景');this.root.style.cssText='position:absolute;inset:0;overflow:hidden;pointer-events:none;background:#356ca4;';container.appendChild(this.root);
    this.reducedMotion=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches||false;
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0x356ca4);this.camera=new THREE.OrthographicCamera(-5,5,8,-8,.1,100);
    this.offset=new THREE.Vector3(0,20,8);this.cameraCenter=new THREE.Vector3();
    try {
      this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.02;
      this.renderer.domElement.style.cssText='position:absolute;inset:0;width:100%;height:100%;display:block;';this.renderer.domElement.setAttribute('aria-hidden','true');this.root.appendChild(this.renderer.domElement);
      this._world();
    }catch(error){
      this.renderer?.forceContextLoss();this.renderer?.dispose();this.renderer=null;
      this.canvas=document.createElement('canvas');this.canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;';this.root.appendChild(this.canvas);this.context=this.canvas.getContext('2d');
      console.warn('ScavengingView uses its canvas fallback.',error);
    }
    this.observer=new ResizeObserver(()=>this._resize());this.observer.observe(container);this._resize();
    this.frame=this._frame.bind(this);this.raf=requestAnimationFrame(this.frame);
  }

  _geo(type,args) {
    const key=type+'/'+args.join('/');if(!this.geometries.has(key)){const C={box:THREE.BoxGeometry,sphere:THREE.SphereGeometry,cylinder:THREE.CylinderGeometry,cone:THREE.ConeGeometry,torus:THREE.TorusGeometry}[type];this.geometries.set(key,new C(...args));}return this.geometries.get(key);
  }
  _material(options) {const material=new THREE.MeshStandardMaterial({roughness:.92,...options});this.materials.add(material);return material;}
  _basic(options) {const material=new THREE.MeshBasicMaterial(options);this.materials.add(material);return material;}
  _part(parts,type,args,color,position=[0,0,0],scale=[1,1,1],rotation=[0,0,0]) {
    const geometry=this._geo(type,args),matrix=new THREE.Matrix4().compose(new THREE.Vector3(...position),new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),new THREE.Vector3(...scale));parts.push({geometry,matrix,color:new THREE.Color(color)});
  }
  _pack(parts) {
    const positions=[],normals=[],colors=[];
    for(const part of parts){const source=part.geometry.index?part.geometry.toNonIndexed():part.geometry.clone();source.applyMatrix4(part.matrix);const p=source.getAttribute('position'),n=source.getAttribute('normal');for(let i=0;i<p.count;i++){positions.push(p.getX(i),p.getY(i),p.getZ(i));normals.push(n?n.getX(i):0,n?n.getY(i):1,n?n.getZ(i):0);colors.push(part.color.r,part.color.g,part.color.b);}source.dispose();}
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.computeBoundingSphere();this.ownedGeometries.add(geometry);return geometry;
  }
  _model(parts,parent) {const mesh=new THREE.Mesh(this._pack(parts),this.colorMaterial);parent?.add(mesh);return mesh;}

  _world() {
    this.scene.add(new THREE.HemisphereLight(0xdbeaff,0x3c4773,2.05));const sun=new THREE.DirectionalLight(0xffebc6,2.35);sun.position.set(-6,12,8);this.scene.add(sun);const fill=new THREE.DirectionalLight(0xb7d7ed,.65);fill.position.set(7,5,-4);this.scene.add(fill);
    this.colorMaterial=this._material({vertexColors:true});
    this.waterMaterial=new THREE.ShaderMaterial({uniforms:{time:{value:0},player:{value:new THREE.Vector2()}},vertexShader:`varying vec2 v;void main(){vec4 p=modelMatrix*vec4(position,1.);v=p.xz;gl_Position=projectionMatrix*viewMatrix*p;}`,fragmentShader:`
      varying vec2 v;uniform float time;uniform vec2 player;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      void main(){
        vec2 p=v+vec2(time*.025,time*.08);vec2 c=floor(p/2.20);vec2 q=mod(p,2.20)-1.1;q-=vec2(hash(c)*.72-.36,hash(c+3.)*.60-.30);
        float ridge=abs(q.y-(.075-abs(q.x)*.20));float wave=(1.-smoothstep(.012,.040,ridge))*(1.-smoothstep(.20,.45,abs(q.x)))*step(.23,hash(c+8.));
        float swell=sin(v.x*.35+v.y*.23+sin(v.x*.12)*1.2)*.5+.5;
        vec3 col=mix(vec3(.060,.145,.285),vec3(.100,.230,.405),swell);
        col=mix(col,vec3(.72,.84,.91),wave*.72);
        gl_FragColor=vec4(col,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`});this.materials.add(this.waterMaterial);
    const water=new THREE.Mesh(new THREE.PlaneGeometry(160,160),this.waterMaterial);this.ownedGeometries.add(water.geometry);water.rotation.x=-Math.PI/2;water.position.y=-.08;this.scene.add(water);
    this.templates=new Map();for(const kind of KINDS)for(let variant=0;variant<2;variant++){
      const geometry=this._debrisGeometry(kind,variant),key=kind+variant;this.templates.set(key,geometry);const mesh=new THREE.InstancedMesh(geometry,this.colorMaterial,512);mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;mesh.count=0;this.scene.add(mesh);this.batches.set(key,mesh);
    }
    this.playerRig=new THREE.Group();this.scene.add(this.playerRig);this._swimmer();this.cargoRig=new THREE.Group();this.scene.add(this.cargoRig);this._net();
    this.cargoBatches=new Map();for(const kind of KINDS){const mesh=new THREE.InstancedMesh(this._cargoGeometry(kind),this.colorMaterial,36);mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;mesh.count=0;this.cargoRig.add(mesh);this.cargoBatches.set(kind,mesh);}
    const ropeGeometry=new THREE.BufferGeometry();ropeGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(12),3));this.ownedGeometries.add(ropeGeometry);const ropeMaterial=new THREE.LineBasicMaterial({color:0xceba86});this.materials.add(ropeMaterial);this.towRope=new THREE.LineSegments(ropeGeometry,ropeMaterial);this.scene.add(this.towRope);
    const rippleGeometry=new THREE.RingGeometry(.68,.78,24);rippleGeometry.rotateX(-Math.PI/2);this.ownedGeometries.add(rippleGeometry);this.rippleMesh=new THREE.InstancedMesh(rippleGeometry,this._basic({color:0xffffff,vertexColors:true,side:THREE.DoubleSide,depthWrite:false}),32);this.rippleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);this.rippleMesh.frustumCulled=false;this.rippleMesh.count=0;this.scene.add(this.rippleMesh);
    const trailGeometry=this._geo('sphere',[.08,6,3]);this.trail=new THREE.InstancedMesh(trailGeometry,this._basic({color:0xe3edf0}),12);this.trail.instanceMatrix.setUsage(THREE.DynamicDrawUsage);this.trail.frustumCulled=false;this.scene.add(this.trail);
    this.sharkGeometry=this._sharkGeometry();this.sharkMesh=new THREE.InstancedMesh(this.sharkGeometry,this.colorMaterial,16);this.sharkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);this.sharkMesh.frustumCulled=false;this.sharkMesh.count=0;this.scene.add(this.sharkMesh);
    this.fishMesh=new THREE.InstancedMesh(this._fishGeometry(),this.colorMaterial,16);this.fishMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);this.fishMesh.frustumCulled=false;this.fishMesh.count=0;this.scene.add(this.fishMesh);
    this.matrix=new THREE.Matrix4();this.quaternion=new THREE.Quaternion();this.euler=new THREE.Euler();this.scale=new THREE.Vector3();this.vector=new THREE.Vector3();
  }

  _debrisGeometry(kind,variant) {
    const p=[],part=(...args)=>this._part(p,...args);
    if(kind==='wood'){
      if(!variant){
        for(let i=0;i<3;i++){part('box',[.22,.12,.95],0x523e38,[(i-1)*.23,0,(i%2)*.14],[1,1,1],[0,(i-1)*.12,0]);part('box',[.18,.035,.89],[0xc38e55,0xb8804b,0xd1a36a][i],[(i-1)*.23,.074,(i%2)*.14],[1,1,1],[0,(i-1)*.12,0]);for(const z of [-.30,.30])part('box',[.025,.010,.12],0x8d6749,[(i-1)*.23,.095,z+(i%2)*.14]);}
        part('box',[.73,.09,.065],0x6d6b60,[0,.12,-.26]);part('box',[.73,.09,.065],0x6d6b60,[0,.12,.37]);
      }else{
        part('box',[.72,.54,.67],0x654b3d,[0,.18,0]);part('box',[.65,.47,.60],0xb68a5a,[0,.20,0]);for(const x of [-.27,0,.27])part('box',[.035,.022,.61],0x806044,[x,.445,0]);for(const x of [-.30,.30])part('box',[.060,.57,.070],0xd2ad73,[x,.20,.30]);for(const z of [-.28,.28])part('box',[.66,.060,.075],0xd2ad73,[0,.41,z]);part('box',[.074,.048,.78],0x98734b,[0,.45,0],[1,1,1],[0,.75,0]);
      }
    }else if(kind==='plastic'){
      if(!variant){
        part('box',[.52,.25,.63],INK,[0,.03,0],[1,1,1],[0,0,.12]);part('box',[.47,.22,.58],0x5ba86d,[0,.065,0],[1,1,1],[0,0,.12]);part('box',[.31,.040,.38],0x86c98c,[0,.19,0],[1,1,1],[0,.15,0]);part('box',[.17,.09,.11],0x395d62,[.18,.13,.26]);part('box',[.18,.050,.11],0xb8d8a3,[.18,.20,.26]);
        part('box',[.21,.070,.32],0x47895f,[-.21,.19,-.06],[1,1,1],[0,0,.18]);
      }else{
        part('cylinder',[.20,.23,.63,10],0x5589a8,[0,.06,0],[1,1,1],[Math.PI/2,0,.24]);part('cylinder',[.23,.23,.055,10],0xc1d7d0,[0,.07,.28],[1,1,1],[Math.PI/2,0,.24]);part('cylinder',[.23,.23,.055,10],0x36617f,[0,.05,-.28],[1,1,1],[Math.PI/2,0,.24]);part('box',[.19,.055,.25],0xd9d9b2,[0,.28,.015]);
        part('cylinder',[.10,.11,.34,9],0xc79942,[.30,.015,-.05],[1,1,1],[Math.PI/2,.2,-.35]);part('cylinder',[.075,.075,.06,8],0xdce5c1,[.30,.015,.13],[1,1,1],[Math.PI/2,0,0]);
      }
    }else{
      if(!variant){
        part('box',[.62,.065,.72],0x59677b,[0,.04,0],[1,1,1],[0,.20,0]);part('box',[.55,.085,.63],0xd6ceaf,[0,.085,0],[1,1,1],[0,.20,0]);part('box',[.39,.035,.13],0xeee4c5,[0,.144,.10],[1,1,1],[0,.20,0]);part('box',[.11,.018,.48],0xb6a995,[-.17,.146,-.01],[1,1,1],[0,.20,0]);part('box',[.15,.032,.17],0xc77663,[.16,.147,-.18],[1,1,1],[0,.20,0]);
      }else{
        part('box',[.62,.065,.28],0x455d79,[0,.015,0],[1,1,1],[0,-.3,0]);part('cylinder',[.14,.14,.60,10],0xc6bba9,[0,.115,0],[1,1,1],[0,0,Math.PI/2]);part('cylinder',[.14,.14,.06,10],0xe4dcc9,[.27,.115,0],[1,1,1],[0,0,Math.PI/2]);part('box',[.10,.060,.30],0xa18a80,[0,.22,0],[1,1,1],[0,-.30,0]);part('box',[.23,.023,.22],0x8895af,[-.23,.09,.20],[1,1,1],[0,.3,0]);
      }
    }
    return this._pack(p);
  }

  _swimmer() {
    const p=[],part=(...a)=>this._part(p,...a);
    // The public tutorial shows a red-shirted rider on a tiny white raft with blue/yellow edging.
    part('box',[1.02,.12,1.12],INK,[0,-.035,0]);part('box',[.89,.065,1.02],0xd6d6bd,[0,.057,0]);
    for(const x of [-.46,.46]){part('box',[.085,.13,1.11],0x508eab,[x,.060,0]);part('cylinder',[.085,.085,1.07,9],0x6096b1,[x,-.08,0],[1,1,1],[Math.PI/2,0,0]);}
    for(const z of [-.50,.50])part('box',[.97,.11,.075],0xd9ba67,[0,.075,z]);
    for(const x of [-.24,0,.24])part('box',[.016,.009,.94],0xa0adac,[x,.097,0]);
    part('box',[.39,.36,.25],0x9c4244,[0,.36,-.03]);part('box',[.34,.34,.23],0xd9554f,[0,.39,-.01]);part('box',[.051,.34,.035],0xefbd64,[-.12,.40,.126]);part('box',[.051,.34,.035],0xefbd64,[.12,.40,.126]);
    part('sphere',[.225,13,9],0xe6b18c,[0,.75,.06],[1,1,.94]);part('sphere',[.228,12,8],0x493c43,[0,.87,.025],[1,.50,1]);
    for(const x of [-.085,.085]){part('sphere',[.033,7,5],0xffedda,[x,.765,.258],[1,.8,.55]);part('sphere',[.019,6,4],0x293c58,[x,.763,.277]);}part('sphere',[.039,7,5],0xc98c6d,[0,.70,.275]);
    part('box',[.15,.027,.09],0x433c47,[0,.91,.13]);part('box',[.32,.10,.23],0x3c536f,[0,.205,.07]);this.bodyMesh=this._model(p,this.playerRig);
    this.arms=[];this.legs=[];
    for(const side of [-1,1]){
      const arm=new THREE.Group();arm.position.set(side*.235,.54,.015);this.playerRig.add(arm);const a=[];this._part(a,'box',[.15,.17,.17],0xc94b4c,[side*.025,-.03,0]);this._part(a,'box',[.11,.22,.12],0xe2aa83,[side*.05,-.18,.055],[1,1,1],[.2,0,-side*.13]);this._part(a,'sphere',[.067,7,5],0xedbd97,[side*.06,-.29,.09],[1,1,.8]);
      if(side===1){this._part(a,'cylinder',[.022,.022,.73,8],0xa58052,[.08,-.48,.26],[1,1,1],[.78,0,0]);this._part(a,'box',[.12,.23,.040],0x51758b,[.08,-.72,.49],[1,1,1],[.78,0,0]);}this._model(a,arm);this.arms.push(arm);
      const leg=new THREE.Group();leg.position.set(side*.105,.19,.13);this.playerRig.add(leg);const b=[];this._part(b,'box',[.14,.17,.19],0x37647f,[0,-.01,.045]);this._part(b,'box',[.15,.065,.22],0x203d5c,[0,-.07,.18]);this._model(b,leg);this.legs.push(leg);
    }
    const geometry=new THREE.CircleGeometry(.72,24);geometry.rotateX(-Math.PI/2);this.ownedGeometries.add(geometry);this.playerShadow=new THREE.Mesh(geometry,this._basic({color:0x173d65,transparent:true,opacity:.24,depthWrite:false}));this.playerShadow.position.y=-.045;this.playerShadow.scale.set(.70,1,1);this.playerRig.add(this.playerShadow);
    const ring=new THREE.RingGeometry(.47,.50,26);ring.rotateX(-Math.PI/2);this.ownedGeometries.add(ring);this.swimRing=new THREE.Mesh(ring,this._basic({color:0xd9eaf0,transparent:true,opacity:.75,side:THREE.DoubleSide,depthWrite:false}));this.swimRing.position.y=-.025;this.swimRing.scale.set(1.15,1,.70);this.playerRig.add(this.swimRing);
    this.hitHalo=new THREE.Mesh(this._geo('sphere',[.68,12,7]),this._basic({color:0xff6b62,transparent:true,opacity:0,depthWrite:false}));this.hitHalo.scale.set(1,.16,1);this.playerRig.add(this.hitHalo);
  }

  _net() {
    this.netRig=new THREE.Group();this.cargoRig.add(this.netRig);
    const p=[],part=(...a)=>this._part(p,...a);
    for(const side of [-1,1]){
      part('cylinder',[.055,.055,1.78,8],0xc8a570,[side*.80,.055,0],[1,1,1],[Math.PI/2,0,0]);
      part('cylinder',[.11,.11,.48,8],0x467b9d,[side*.88,.04,.50],[1,1,1],[Math.PI/2,0,0]);part('cylinder',[.11,.11,.48,8],0xc07e54,[side*.88,.04,-.53],[1,1,1],[Math.PI/2,0,0]);
    }
    for(const z of [-.85,.85])part('cylinder',[.05,.05,1.65,8],0xd2b07c,[0,.04,z],[1,1,1],[0,0,Math.PI/2]);
    this._model(p,this.netRig);
    const lines=[];
    for(let i=0;i<=8;i++){
      const a=-.77+i*.1925;lines.push(a,-.025,-.82,a,-.025,.82);lines.push(-.77,-.025,a,.77,-.025,a);
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(lines,3));this.ownedGeometries.add(geometry);const material=new THREE.LineBasicMaterial({color:0xcab482,transparent:true,opacity:.84});this.materials.add(material);this.netRig.add(new THREE.LineSegments(geometry,material));
    const netGeometry=new THREE.PlaneGeometry(1.60,1.72);netGeometry.rotateX(-Math.PI/2);this.ownedGeometries.add(netGeometry);const net=new THREE.Mesh(netGeometry,this._basic({color:0x295d77,transparent:true,opacity:.26,side:THREE.DoubleSide,depthWrite:false}));net.position.y=-.04;this.netRig.add(net);
  }

  _cargoGeometry(kind) {
    const parts=[],part=(...args)=>this._part(parts,...args);
    if(kind==='wood'){
      for(let layer=0;layer<3;layer++)for(let board=0;board<3;board++){
        const x=(board-1)*.225,y=.035+layer*.105,z=(board%2)*.08,angle=(layer%2?.10:-.07);
        part('box',[.225,.10,.93],0x624936,[x,y,z],[1,1,1],[0,angle,0]);part('box',[.195,.025,.90],[0xc18b56,0xd0a06a,0xb87b48][(board+layer)%3],[x,y+.060,z],[1,1,1],[0,angle,0]);
        part('box',[.023,.008,.67],0x966a47,[x-.04,y+.076,z],[1,1,1],[0,angle,0]);
      }
      for(const z of [-.27,.34])part('box',[.75,.047,.050],0x6e716b,[0,.32,z]);
    }else if(kind==='cloth'){
      part('box',[.69,.060,.57],0x53667b,[0,.01,0]);
      for(let i=0;i<3;i++){part('box',[.65,.075,.53],i%2?0xd7cdb4:0xe4ddc7,[(i%2)*.02,.075+i*.078,(i%2)*.025]);part('box',[.60,.013,.026],0xb5aa98,[.005,.10+i*.078,.265+(i%2)*.025]);}
      part('box',[.055,.30,.57],0xb7a184,[.09,.16,.02]);part('box',[.25,.018,.20],0x90a5b5,[-.12,.285,-.06]);
    }else{
      part('box',[.48,.36,.53],0x3e6e61,[0,.18,0]);part('box',[.43,.33,.49],0x69ae78,[0,.21,0]);part('box',[.29,.026,.34],0x8cca93,[0,.39,0]);
      part('box',[.19,.10,.12],0x355c5b,[.13,.39,.20]);part('box',[.16,.035,.09],0xc3d3a8,[.13,.45,.20]);
      part('cylinder',[.095,.095,.36,9],0x6c9fbb,[.29,.20,-.10]);part('cylinder',[.064,.064,.065,8],0xd5e2d4,[.29,.41,-.10]);
    }
    return this._pack(parts);
  }

  _sharkGeometry() {
    const p=[];this._part(p,'sphere',[.43,10,6],0x254f75,[0,-.085,0],[.50,.10,1.50]);
    const fin=new THREE.Shape();fin.moveTo(-.055,-.27);fin.lineTo(-.045,.32);fin.lineTo(.19,.10);fin.lineTo(.12,-.24);fin.closePath();const geometry=new THREE.ExtrudeGeometry(fin,{depth:.060,bevelEnabled:false});geometry.rotateY(Math.PI/2);geometry.translate(-.03,.045,0);this.ownedGeometries.add(geometry);p.push({geometry,matrix:new THREE.Matrix4(),color:new THREE.Color(0x465672)});
    return this._pack(p);
  }

  _fishGeometry() {
    const p=[];for(let i=0;i<7;i++){const x=(i%3-1)*.30,z=(Math.floor(i/3)-1)*.43+(i%2)*.11;this._part(p,'sphere',[.15,8,5],i%2?0x426b88:0x355e7b,[x,-.035,z],[.47,.12,1.15]);this._part(p,'cone',[.078,.14,3],0x3c6681,[x,-.035,z-.20],[1,.42,1],[Math.PI/2,0,0]);}return this._pack(p);
  }

  update(trip) {
    if(this.disposed)return;
    if(!trip){this.trip=null;this.nodes.clear();this.sharks.clear();this.fishSchools.clear();if(this.playerRig){this.playerRig.visible=false;this.cargoRig.visible=false;this.towRope.visible=false;}return;}
    const id=String(trip.id??'trip'),fresh=id!==this.tripId;this.trip=trip;this.tripId=id;
    this.targetPosition.set(number(trip.player?.x),0,number(trip.player?.z));this.targetHeading=number(trip.player?.heading);
    if(fresh){this.nodes.clear();this.sharks.clear();this.ripples=[];this.position.copy(this.targetPosition);this.heading=this.targetHeading;this.cameraCenter.copy(this.position);this.clock=0;this.cargoSignature='';if(this.cargoRig){this.cargoRig.position.copy(this.position).add(new THREE.Vector3(-Math.sin(this.heading)*1.60,0,-Math.cos(this.heading)*1.60));this.cargoRig.rotation.y=this.heading;}}
    const ids=new Set();for(const raw of trip.objects||[]){if(!KINDS.includes(raw.kind))continue;const nodeId=String(raw.id),existing=this.nodes.get(nodeId);ids.add(nodeId);
      if(!existing){if(!raw.collected)this.nodes.set(nodeId,{id:nodeId,kind:raw.kind,x:number(raw.x),z:number(raw.z),amount:Math.max(1,number(raw.amount,1)),seed:hash(nodeId),collected:false});}
      else{existing.x=number(raw.x);existing.z=number(raw.z);existing.amount=Math.max(1,number(raw.amount,1));if(raw.collected&&!existing.collected){existing.collected=true;existing.collectedAt=this.clock;this.ripples.push({x:existing.x,z:existing.z,start:this.clock});}}
    }
    for(const node of this.nodes.values())if(!ids.has(node.id)&&!node.collected){node.collected=true;node.collectedAt=this.clock;this.ripples.push({x:node.x,z:node.z,start:this.clock});}
    this.sharks.clear();for(const shark of trip.sharks||[])this.sharks.set(String(shark.id),{x:number(shark.x),z:number(shark.z),heading:number(shark.heading)});
    this.fishSchools.clear();for(const school of trip.fishSchools||[])this.fishSchools.set(String(school.id),{x:number(school.x),z:number(school.z),heading:number(school.heading)});
    const cargo={wood:Math.max(0,number(trip.cargo?.wood)),plastic:Math.max(0,number(trip.cargo?.plastic)),cloth:Math.max(0,number(trip.cargo?.cloth))},capacity=Math.max(1,number(trip.capacity,100)),signature=capacity+'/'+KINDS.map(k=>cargo[k]).join('/');if(signature!==this.cargoSignature){this.cargoSignature=signature;this.cargo=cargo;this.cargoCapacity=capacity;if(this.renderer)this._cargo();}
    if(this.playerRig){this.playerRig.visible=trip.status!=='returned';this.cargoRig.visible=trip.status!=='returned';this.towRope.visible=trip.status!=='returned';}
    if(fresh)this._draw(0);
  }

  _cargo() {
    const total=KINDS.reduce((sum,kind)=>sum+this.cargo[kind],0),ratio=clamp(total/this.cargoCapacity,0,1),quantum=this.cargoCapacity/33;
    this.cargoRatio=ratio;
    const slots=[];for(const kind of ['plastic','cloth','wood']){const count=this.cargo[kind]>0?Math.min(36,Math.ceil(this.cargo[kind]/quantum)):0;for(let i=0;i<count;i++)slots.push(kind);}
    const counters={wood:0,plastic:0,cloth:0};
    // Six bundles per tier. Taller tiers lean back into the stretched net, retaining
    // the readable green / fabric / timber bands visible in the recorded haul.
    slots.forEach((kind,i)=>{const row=Math.floor(i/3)%2,col=i%3,tier=Math.floor(i/6),angle=((i*17)%19-9)*.012+(tier%2)*.09;this.euler.set(.025*(i%2),angle,.025*((i%3)-1));this.quaternion.setFromEuler(this.euler);this.vector.set((col-1)*.44+Math.sin(tier*2.2)*.035,.15+tier*.31,row*.46-.23-tier*.28);this.scale.setScalar(kind==='wood'?.76:kind==='cloth'?.75:.70);this.matrix.compose(this.vector,this.quaternion,this.scale);this.cargoBatches.get(kind).setMatrixAt(counters[kind]++,this.matrix);});
    this.netRig.scale.z=1+ratio*.70;this.netRig.position.z=-.85*(this.netRig.scale.z-1);
    for(const kind of KINDS){const mesh=this.cargoBatches.get(kind);mesh.count=counters[kind];mesh.instanceMatrix.needsUpdate=true;}
  }

  setPaused(paused) {
    if(this.disposed||this.paused===!!paused)return;this.paused=!!paused;this.lastTime=0;
    if(this.paused){cancelAnimationFrame(this.raf);this.raf=null;this._draw(0);}else if(!this.raf)this.raf=requestAnimationFrame(this.frame);
  }

  _resize() {
    this.width=Math.max(1,this.container.clientWidth||390);this.height=Math.max(1,this.container.clientHeight||844);const aspect=this.width/this.height;
    this.viewHeight=aspect>=1?11.7:10.4/aspect;this.viewWidth=this.viewHeight*aspect;
    this.camera.left=-this.viewWidth/2;this.camera.right=this.viewWidth/2;this.camera.top=this.viewHeight/2;this.camera.bottom=-this.viewHeight/2;this.camera.updateProjectionMatrix();
    if(this.renderer)this.renderer.setSize(this.width,this.height,false);else if(this.canvas){const dpr=Math.min(window.devicePixelRatio||1,1.5);this.canvas.width=this.width*dpr;this.canvas.height=this.height*dpr;this.context.setTransform(dpr,0,0,dpr,0,0);}
    this._draw(0);
  }

  _draw(dt) {
    const before=this.position.clone();this.position.lerp(this.targetPosition,1-Math.exp(-dt*15));this.heading=angleLerp(this.heading,this.targetHeading,1-Math.exp(-dt*12));this.speed=dt?this.position.distanceTo(before)/dt:this.speed*.9;
    this.cameraCenter.lerp(this.position,dt?1-Math.exp(-dt*8):1);const target=this.cameraCenter.clone();
    // A tall load heading up-screen would sit beneath the shallow landscape HUD.
    // Portrait framing stays at 44%; landscape tracks the loaded silhouette lower.
    const loadFrame=this.width>this.height?(this.cargoRatio||0)*Math.max(0,Math.cos(this.heading))*.20:0;
    target.z+=this.viewHeight*(.060-loadFrame)/.9285;this.camera.position.copy(target).add(this.offset);this.camera.lookAt(target);this.camera.updateMatrixWorld();
    if(!this.renderer){this._fallback();return;}
    const t=this.reducedMotion?0:this.clock;this.waterMaterial.uniforms.time.value=t;this.waterMaterial.uniforms.player.value.set(this.position.x,this.position.z);
    const counts=new Map([...this.batches.keys()].map(key=>[key,0]));
    for(const [id,node]of this.nodes){let scale=.88+Math.min(.18,node.amount*.015),x=node.x,z=node.z,y=.020+Math.sin(t*1.45+node.seed%31)*.030;
      if(node.collected){const p=clamp((this.clock-node.collectedAt)/.44,0,1);if(p>=1){this.nodes.delete(id);continue;}scale*=1-p;x+=(this.cargoRig.position.x-x)*p*.80;z+=(this.cargoRig.position.z-z)*p*.80;y+=Math.sin(p*Math.PI)*.26;}
      const key=node.kind+(node.seed%2),batch=this.batches.get(key),index=counts.get(key);if(index>=512)continue;this.vector.set(x,y,z);this.euler.set(Math.sin(t+node.seed)*.045,(node.seed%628)/100,Math.sin(t*.9+node.seed)*.035);this.quaternion.setFromEuler(this.euler);this.scale.setScalar(scale);this.matrix.compose(this.vector,this.quaternion,this.scale);batch.setMatrixAt(index,this.matrix);counts.set(key,index+1);
    }
    for(const [key,mesh]of this.batches){mesh.count=counts.get(key);mesh.instanceMatrix.needsUpdate=true;}
    this.playerRig.position.copy(this.position);this.playerRig.position.y=Math.sin(t*3.2)*.018;this.playerRig.rotation.y=this.heading;
    const swimming=this.trip?.status==='sailing'?Math.min(1,this.speed/.8):0,stroke=this.trip?.status==='sailing'?t*(2.2+swimming*2.0):0;this.arms.forEach((arm,i)=>{const side=i?1:-1;arm.rotation.x=-.18+Math.sin(stroke+i*Math.PI)*.24*swimming;arm.rotation.z=side*.12+Math.cos(stroke+i*Math.PI)*.035;});this.legs.forEach((leg,i)=>leg.rotation.x=Math.sin(stroke+i*Math.PI)*.045*swimming);
    const cargoTarget=this.position.clone().add(new THREE.Vector3(-Math.sin(this.heading)*1.60,0,-Math.cos(this.heading)*1.60));this.cargoRig.position.lerp(cargoTarget,dt?1-Math.exp(-dt*6):1);this.cargoRig.position.y=Math.sin(t*1.7)*.015;this.cargoRig.rotation.y=angleLerp(this.cargoRig.rotation.y,this.heading,dt?1-Math.exp(-dt*6):1);
    const hit=number(this.trip?.hitUntil)>number(this.trip?.elapsed);this.hitHalo.material.opacity=hit?.20+Math.sin(t*19)*.08:0;
    this.playerRig.updateWorldMatrix(true,true);this.cargoRig.updateWorldMatrix(true,true);const rope=this.towRope.geometry.attributes.position;
    for(const side of [-1,1]){const a=this.playerRig.localToWorld(new THREE.Vector3(side*.20,.04,-.39)),b=this.cargoRig.localToWorld(new THREE.Vector3(side*.70,.05,.84)),index=side<0?0:2;rope.setXYZ(index,a.x,a.y,a.z);rope.setXYZ(index+1,b.x,b.y,b.z);}rope.needsUpdate=true;this.towRope.geometry.computeBoundingSphere();
    for(let i=0;i<12;i++){const phase=(t*1.2+i/12)%1,side=i%2?1:-1,local=new THREE.Vector3(side*(.26+phase*.26),-.035,-.40-phase*1.05);local.applyAxisAngle(new THREE.Vector3(0,1,0),this.heading).add(this.position);this.matrix.compose(local,new THREE.Quaternion(),new THREE.Vector3((1-phase)*(.8+swimming*.7),.04,(1-phase)*1.5));this.trail.setMatrixAt(i,this.matrix);}this.trail.instanceMatrix.needsUpdate=true;
    this.ripples=this.ripples.filter(r=>this.clock-r.start<.8).slice(-32);this.ripples.forEach((r,i)=>{const p=clamp((this.clock-r.start)/.8,0,1);this.vector.set(r.x,-.025,r.z);this.scale.set(0.2+p*.9,1,0.2+p*.9);this.matrix.compose(this.vector,new THREE.Quaternion(),this.scale);this.rippleMesh.setMatrixAt(i,this.matrix);this.rippleMesh.setColorAt(i,new THREE.Color(0xd4e7ee).lerp(new THREE.Color(0x447aa5),p));});this.rippleMesh.count=this.ripples.length;this.rippleMesh.instanceMatrix.needsUpdate=true;if(this.rippleMesh.instanceColor)this.rippleMesh.instanceColor.needsUpdate=true;
    let sharkIndex=0;for(const shark of this.sharks.values()){if(sharkIndex>=16)break;this.vector.set(shark.x,Math.sin(t*1.4+sharkIndex)*.012,shark.z);this.euler.set(0,shark.heading,0);this.quaternion.setFromEuler(this.euler);this.scale.setScalar(1);this.matrix.compose(this.vector,this.quaternion,this.scale);this.sharkMesh.setMatrixAt(sharkIndex++,this.matrix);}this.sharkMesh.count=sharkIndex;this.sharkMesh.instanceMatrix.needsUpdate=true;
    let fishIndex=0;for(const fish of this.fishSchools.values()){if(fishIndex>=16)break;this.vector.set(fish.x,0,fish.z);this.euler.set(0,fish.heading+Math.sin(t*5+fishIndex)*.035,0);this.quaternion.setFromEuler(this.euler);this.scale.setScalar(1);this.matrix.compose(this.vector,this.quaternion,this.scale);this.fishMesh.setMatrixAt(fishIndex++,this.matrix);}this.fishMesh.count=fishIndex;this.fishMesh.instanceMatrix.needsUpdate=true;
    this.renderer.render(this.scene,this.camera);
  }

  _fallback() {
    const c=this.context;if(!c)return;const w=this.width,h=this.height,scale=w/this.viewWidth,project=(x,z)=>({x:w/2+(x-this.position.x)*scale,y:h*.44+(z-this.position.z)*scale*.9285});c.fillStyle='#346b9f';c.fillRect(0,0,w,h);c.strokeStyle='#b0c9df';c.lineWidth=1.5;
    for(let i=0;i<38;i++){const x=(i*97+17)%w,y=(i*131+this.clock*2)%h;c.beginPath();c.moveTo(x,y);c.lineTo(x+7,y-2);c.lineTo(x+16,y);c.stroke();}
    for(const node of this.nodes.values()){if(node.collected)continue;const p=project(node.x,node.z);c.save();c.translate(p.x,p.y);c.rotate((node.seed%20)/10);c.fillStyle=node.kind==='wood'?'#b88d5b':node.kind==='plastic'?'#81b78a':'#d9cdb3';c.strokeStyle='#283f5c';c.lineWidth=2;c.fillRect(-9,-7,18,14);c.strokeRect(-9,-7,18,14);c.restore();}
    if(!this.trip||this.trip.status==='returned')return;const p=project(this.position.x,this.position.z);c.save();c.translate(p.x,p.y);c.rotate(-this.heading);c.strokeStyle='#d1b78c';c.strokeRect(-scale*.7,-scale*2.3,scale*1.4,scale*1.35);const cargo=Object.values(this.cargo||{}).reduce((a,b)=>a+b,0);for(let i=0;i<Math.min(9,Math.ceil(cargo/4));i++){c.fillStyle=['#b48957','#82b686','#ddd1af'][i%3];c.fillRect((i%3-1)*12-5,-scale*1.8+Math.floor(i/3)*9,12,10);}c.fillStyle='#d65350';c.fillRect(-8,-7,16,20);c.fillStyle='#e3b18e';c.beginPath();c.arc(0,13,8,0,Math.PI*2);c.fill();c.fillStyle='#493f47';c.fillRect(-7,7,14,5);c.restore();
  }

  _frame(now) {
    this.raf=null;if(this.disposed||this.paused)return;const dt=Math.min(.08,(now-(this.lastTime||now))/1000);this.lastTime=now;if(!document.hidden){this.clock+=dt;this._draw(dt);}this.raf=requestAnimationFrame(this.frame);
  }

  dispose() {
    if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.raf);this.raf=null;this.observer.disconnect();this.nodes.clear();this.sharks.clear();this.fishSchools.clear();
    this.scene.traverse(node=>{if(node.isInstancedMesh)node.dispose();if(node.geometry)this.ownedGeometries.add(node.geometry);if(node.material)this.materials.add(node.material);});for(const geometry of this.geometries.values())this.ownedGeometries.add(geometry);for(const geometry of this.ownedGeometries)geometry.dispose();for(const material of this.materials)material.dispose();
    if(this.renderer){this.renderer.forceContextLoss();this.renderer.dispose();}this.root.remove();
  }
}

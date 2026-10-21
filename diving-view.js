import * as THREE from './node_modules/three/build/three.module.js';

/** Side-on seabed rendering. The domain owns oxygen, movement, pickups and rewards. */
export class DivingView {
  constructor(container) {
    this.container=container;this.time=0;this.paused=false;this.disposed=false;this.tripId=null;
    this.objects=new Map();this.geometries=new Map();this.materials=new Map();this.bubbles=[];
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#285b77');
    this.camera=new THREE.OrthographicCamera(-10,10,14,-14,.1,120);this.camera.position.set(0,-8,35);this.camera.lookAt(0,-8,0);
    this.renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute('aria-label','潜水员在沉没街区收集海藻、玻璃和废金属');
    this.renderer.domElement.style.cssText='display:block;width:100%;height:100%;';container.appendChild(this.renderer.domElement);
    this.scene.add(new THREE.HemisphereLight(0xe1f8f7,0x29445d,2.4));const sun=new THREE.DirectionalLight(0xd8ffff,2.4);sun.position.set(-8,12,16);this.scene.add(sun);
    this._world();this._diver();this.resize=new ResizeObserver(()=>this._resize());this.resize.observe(container);this._resize();
    this.last=performance.now();this.frame=this._frame.bind(this);this.raf=requestAnimationFrame(this.frame);
  }
  _geometry(kind,args) {const key=kind+args.join(',');if(!this.geometries.has(key)){const C={box:THREE.BoxGeometry,sphere:THREE.SphereGeometry,cylinder:THREE.CylinderGeometry,cone:THREE.ConeGeometry,ico:THREE.IcosahedronGeometry,torus:THREE.TorusGeometry}[kind];this.geometries.set(key,new C(...args));}return this.geometries.get(key);}
  _material(color,opacity=1){const key=color+'/'+opacity;if(!this.materials.has(key))this.materials.set(key,new THREE.MeshStandardMaterial({color,roughness:.85,transparent:opacity<1,opacity,depthWrite:opacity===1}));return this.materials.get(key);}
  _part(parent,kind,args,color,x=0,y=0,z=0,rotation=0,opacity=1){const m=new THREE.Mesh(this._geometry(kind,args),this._material(color,opacity));m.position.set(x,y,z);m.rotation.z=rotation;parent.add(m);return m;}
  _box(p,w,h,d,c,x,y,z=0,r=0){return this._part(p,'box',[w,h,d],c,x,y,z,r);}
  _world(){
    // Distant silhouettes remain scenery, not invisible collision geometry.
    for(let i=0;i<12;i++){
      const x=-30+i*5.3,h=9+(i*7%17),y=-29+h/2;
      this._box(this.scene,4,h,1,i%2?'#294d67':'#31566d',x,y,-12);
      for(let row=0;row<Math.floor(h/3);row++)for(let col=0;col<2;col++)this._box(this.scene,.7,.9,.1,'#243e58',x+(col-.5)*1.5,-28+row*3,-11.4);
      if(i%3===0)this._box(this.scene,5,.3,1.2,'#41647a',x,y+h/2,-11.4,.05);
    }
    this._box(this.scene,70,1.2,3,'#456e7b',0,-29,0);
    for(let i=0;i<45;i++){const x=-30+i*1.4;this._part(this.scene,'ico',[.3+(i%4)*.12,0],i%3?'#67878a':'#436b74',x,-28.3,-1.5);}
    this._box(this.scene,70,.12,1,'#9ad3d5',0,.6,1);
    this._box(this.scene,70,1.2,1,'#64a5bd',0,1.3,-1);
    this._box(this.scene,3.8,.3,2,'#897256',0,.75,0);
    this._box(this.scene,3.7,.1,2.05,'#bcaa76',0,.94,0);
    this._box(this.scene,.15,2.2,.15,'#b5bfc0',-1.4,-.15,1);
    this._box(this.scene,.15,2.2,.15,'#b5bfc0',-.7,-.15,1);
    for(let i=0;i<5;i++)this._box(this.scene,.8,.1,.15,'#a4b8b7',-1.05,.6-i*.4,1);
    for(let i=0;i<8;i++){
      const g=new THREE.Group();g.position.set(-25+i*7,-10,-8);g.rotation.z=-.18;
      this._part(g,'box',[1.2,42,.05],'#b3e2da',0,0,0,0,.045);this.scene.add(g);
    }
    for(let i=0;i<25;i++){
      const b=this._part(this.scene,'sphere',[.035+(i%3)*.018,6,4],'#bcf4ed',0,0,2,0,.5);
      this.bubbles.push({mesh:b,x:-16+(i*7%33),start:i*1.3});
    }
    this.objectRoot=new THREE.Group();this.scene.add(this.objectRoot);
  }
  _diver(){
    this.diver=new THREE.Group();this.scene.add(this.diver);this.swimmer=new THREE.Group();this.diver.add(this.swimmer);
    this._box(this.swimmer,.65,.92,.48,'#e17458',0,0,.3,-.15);
    this._part(this.swimmer,'sphere',[.36,8,6],'#dba981',.1,.75,.3);
    this._part(this.swimmer,'sphere',[.36,8,5],'#544639',.06,.91,.19);
    this._box(this.swimmer,.59,.25,.15,'#253d53',.17,.76,.62);
    this._box(this.swimmer,.46,.16,.1,'#8fddde',.17,.76,.73);
    this._box(this.swimmer,.12,.5,.13,'#344b50',-.29,.96,.53,.08);
    this._part(this.swimmer,'cylinder',[.18,.18,.73,7],'#dfbe64',-.36,.12,.06,.08);
    this._box(this.swimmer,.68,.14,.52,'#444f55',-.02,.03,.34);
    this.arm=this._box(this.swimmer,.18,.68,.23,'#dfaa81',.48,.12,.38,-.45);
    this.legs=[];
    for(const x of [-.18,.18]){const leg=new THREE.Group();leg.position.set(x,-.49,.32);this.swimmer.add(leg);this._box(leg,.25,.65,.25,'#315c7e',0,-.22,0);this._box(leg,.25,.2,.7,'#202f48',0,-.62,.22);this.legs.push(leg);}
  }
  _pickup(item){
    const g=new THREE.Group();g.position.set(item.x,-item.y,.7);
    if(item.kind==='seaweed'){
      this._part(g,'ico',[.25,0],'#627d6b',0,-.36,0);
      for(let i=0;i<3;i++){const leaf=this._part(g,'cone',[.18,.95,5],'#64bd8a',(i-1)*.23,.15+(i%2)*.16,0,(i-1)*-.21);leaf.scale.z=.35;}
    }else if(item.kind==='glass'){
      for(let i=0;i<3;i++){const shard=this._part(g,'ico',[.31,0],i%2?'#92dde0':'#b9e5df',(i-1)*.25,i%2*.2,0,(i-1)*.5);shard.scale.set(.65,1.25,.5);}
    }else{
      this._box(g,.65,.35,.35,'#809699',0,-.06,0,-.2);this._box(g,.55,.2,.4,'#b0bbbb',.18,.2,.1,.25);
      this._part(g,'torus',[.23,.07,5,8],'#556d75',-.3,.18,.1,.15);
    }
    this.objectRoot.add(g);return g;
  }
  update(trip){
    if(!trip)return;this.trip=trip;
    if(this.tripId!==trip.id){for(const n of this.objects.values())this.objectRoot.remove(n);this.objects.clear();this.tripId=trip.id;}
    for(const item of trip.objects){let node=this.objects.get(item.id);if(!node){node=this._pickup(item);this.objects.set(item.id,node);}node.visible=!item.collected;}
    this.diver.position.set(trip.player.x,-trip.player.y,2);
    const old=this.previousPosition;this.moving=old?Math.hypot(trip.player.x-old.x,trip.player.y-old.y)>.001:false;
    if(old&&Math.abs(trip.player.x-old.x)>.001)this.facing=trip.player.x>old.x?1:-1;
    this.previousPosition={x:trip.player.x,y:trip.player.y};
    this.swimmer.rotation.y=this.facing===-1?-.3:.3;
    const centerY=-trip.player.y-this.height*.15;
    this.camera.position.set(trip.player.x*.65,centerY,35);this.camera.lookAt(trip.player.x*.65,centerY,0);
  }
  _resize(){const w=this.container.clientWidth||390,h=this.container.clientHeight||844;this.height=Math.max(13,Math.min(31,18*h/w));const width=this.height*w/h;Object.assign(this.camera,{left:-width/2,right:width/2,top:this.height/2,bottom:-this.height/2});this.camera.updateProjectionMatrix();this.renderer.setSize(w,h,false);if(this.trip)this.update(this.trip);}
  _frame(now){if(this.disposed)return;const dt=Math.min(.05,(now-this.last)/1000);this.last=now;if(!this.paused){this.time+=dt;const kick=this.moving?Math.sin(this.time*11)*.35:Math.sin(this.time*2)*.08;this.legs[0].rotation.z=kick;this.legs[1].rotation.z=-kick;this.arm.rotation.z=-.45+kick*.35;for(const b of this.bubbles)b.mesh.position.set(b.x+Math.sin(this.time+b.start)*.15,-28+(this.time*.6+b.start)%29,2);this.renderer.render(this.scene,this.camera);}this.raf=requestAnimationFrame(this.frame);}
  setPaused(value){this.paused=value;this.last=performance.now();if(value)this.renderer.render(this.scene,this.camera);}
  dispose(){if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.raf);this.resize.disconnect();for(const g of this.geometries.values())g.dispose();for(const m of this.materials.values())m.dispose();this.renderer.dispose();this.renderer.forceContextLoss();this.renderer.domElement.remove();this.objects.clear();}
}

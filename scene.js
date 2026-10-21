import * as THREE from './node_modules/three/build/three.module.js';

const TILE = 1.55;
const UP = new THREE.Vector3(0, 1, 0);
const DEFAULT_RAFT = Array.from({ length: 9 }, (_, i) => ({ x: (i % 3) - 1, z: Math.floor(i / 3) - 1 }));
const clamp = THREE.MathUtils.clamp;
const rand = (a, b) => a + Math.random() * (b - a);
const keyOf = (x, z) => `${x},${z}`;
const COLORS = {
  timber: 0x9b6138, darkWood: 0x644532, paleWood: 0xc79758,
  rope: 0xd3ba7d, yellow: 0xf6c74c, rust: 0xcc6a40, teal: 0x438a83,
  navy: 0x315d68, blue: 0x56a8b0, cream: 0xffedc5, red: 0xd9614d,
};

/** A self-contained, touch-first, procedural sea settlement scene. */
export class RaftScene {
  constructor(container, { onCollect, onTile, onBuilding, onReady } = {}) {
    this.container = container;
    this.callbacks = { onCollect, onTile, onBuilding, onReady };
    this.disposed = false;
    this.mode = 'normal';
    this.materials = new Map();
    this.geometries = new Map();
    this.textures = new Set();
    this.pickables = [];
    this.debris = [];
    this.residents = [];
    this.animations = [];
    this.ripples = [];
    this.salvageJobs = [];
    this.fishingModeId = null;
    this.pointers = new Map();
    this.lastTime = 0;
    this.elapsed = 0;
    this.spawnTimer = 0;
    this.zoomLevel = 1;
    this.zoomTarget = 1;
    this.pan = new THREE.Vector3(0, -0.2, 0);
    this.targetPan = this.pan.clone();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.ground = new THREE.Plane(UP, 0);
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x356aa0);
    this.scene.fog = new THREE.FogExp2(0x507eab, 0.010);
    this.camera = new THREE.OrthographicCamera(-5, 5, 10, -10, 0.1, 160);
    this.cameraOffset = new THREE.Vector3(10, 14.2, 17.2);
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (error) {
      const message = document.createElement('div');
      message.className = 'webgl-fallback';
      message.style.cssText = 'position:absolute;inset:22% 7%;display:grid;place-content:center;text-align:center;color:#173c47;font:600 16px/1.9 -apple-system,BlinkMacSystemFont,sans-serif;padding:24px;border-radius:24px;background:#e9f6e7;';
      message.textContent = '这艘木筏需要浏览器的 3D 支持。请开启硬件加速，或使用新版 Safari / Chrome 重新打开。';
      container.appendChild(message);
      this.fallback = message;
      console.warn('Unable to initialize the raft WebGL scene:', error);
      queueMicrotask(() => this.callbacks.onReady?.({ webgl: false }));
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x356aa0);
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;';
    this.renderer.domElement.setAttribute('aria-label', '海上木筏，可拖动查看、双指缩放，点击漂流物拾取资源');
    this.renderer.domElement.setAttribute('role', 'img');
    container.appendChild(this.renderer.domElement);
    this._makeTextures();
    this._lights();
    this._ocean();
    this._surroundings();
    this.floating = new THREE.Group();
    this.scene.add(this.floating);
    this.tileGroup = new THREE.Group();
    this.buildingGroup = new THREE.Group();
    this.peopleGroup = new THREE.Group();
    this.targetGroup = new THREE.Group();
    this.floating.add(this.tileGroup, this.buildingGroup, this.peopleGroup, this.targetGroup);
    this._makeFishSchool();
    this._bindEvents();
    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(container);
    this._resize();
    this.setState({ raft: DEFAULT_RAFT, buildings: [{ id: 'command', type: 'command', x: 0, z: 0 }], population: { total: 2 } });
    for (let i = 0; i < 13; i++) this._spawnDebris(i);
    this._frame = this._frame.bind(this);
    this.animationFrame = requestAnimationFrame(this._frame);
    requestAnimationFrame(() => { if (!this.disposed) this.callbacks.onReady?.(); });
  }

  _makeTextures() {
    const woodCanvas = document.createElement('canvas');
    woodCanvas.width = 128; woodCanvas.height = 256;
    const ctx = woodCanvas.getContext('2d');
    ctx.fillStyle = '#c6a26e'; ctx.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 85; i++) {
      const x = rand(0, 128);
      ctx.strokeStyle = `rgba(75,43,21,${rand(0.03, 0.16)})`;
      ctx.lineWidth = rand(0.5, 2);
      ctx.beginPath(); ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + rand(-8, 8), 72, x + rand(-8, 8), 170, x + rand(-3, 3), 256);
      ctx.stroke();
    }
    ctx.strokeStyle = '#745737'; ctx.globalAlpha = 0.22;
    for (const [x, y] of [[32, 70], [99, 180]]) {
      for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.ellipse(x, y, i * 2.6, i * 8, 0, 0, Math.PI * 2); ctx.stroke(); }
    }
    const wood = new THREE.CanvasTexture(woodCanvas);
    wood.colorSpace = THREE.SRGBColorSpace;
    wood.anisotropy = Math.min(this.renderer.capabilities.getMaxAnisotropy(), 4);
    this.woodTexture = wood; this.textures.add(wood);
    const steelCanvas=document.createElement('canvas');steelCanvas.width=steelCanvas.height=128;
    const steel=steelCanvas.getContext('2d');steel.fillStyle='#c1bfb4';steel.fillRect(0,0,128,128);
    for(let i=0;i<14;i++){const x=rand(0,128),y=rand(0,128);steel.fillStyle=i%3?'#aaa99d':'#8f957f';steel.beginPath();steel.moveTo(x,y);steel.lineTo(x+rand(8,27),y+rand(-4,6));steel.lineTo(x+rand(7,23),y+rand(5,13));steel.lineTo(x-3,y+rand(3,11));steel.fill();}
    steel.strokeStyle='#858780';steel.lineWidth=1;for(let i=0;i<8;i++){const x=rand(10,115),y=rand(10,115);steel.beginPath();steel.moveTo(x,y);steel.lineTo(x-3,y+7);steel.lineTo(x+3,y+10);steel.stroke();}
    this.steelTexture=new THREE.CanvasTexture(steelCanvas);this.steelTexture.colorSpace=THREE.SRGBColorSpace;this.textures.add(this.steelTexture);
    const wallCanvas=document.createElement('canvas');wallCanvas.width=wallCanvas.height=128;
    const wall=wallCanvas.getContext('2d');wall.fillStyle='#9eae60';wall.fillRect(0,0,128,128);
    for(let i=0;i<16;i++){const x=rand(0,128),y=rand(0,128);wall.fillStyle=i%3?'#e3dfb7':'#5f7955';wall.beginPath();wall.moveTo(x,y);wall.lineTo(x+rand(9,24),y+rand(-4,8));wall.lineTo(x+rand(5,21),y+rand(11,27));wall.lineTo(x-rand(3,11),y+rand(8,19));wall.fill();}
    this.wallTexture=new THREE.CanvasTexture(wallCanvas);this.wallTexture.colorSpace=THREE.SRGBColorSpace;this.textures.add(this.wallTexture);
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 64;
    const sh = shadowCanvas.getContext('2d');
    const gradient = sh.createRadialGradient(32, 32, 1, 32, 32, 31);
    gradient.addColorStop(0, 'rgba(4,52,57,.38)'); gradient.addColorStop(0.65, 'rgba(4,52,57,.19)'); gradient.addColorStop(1, 'rgba(4,52,57,0)');
    sh.fillStyle = gradient; sh.fillRect(0, 0, 64, 64);
    this.contactTexture = new THREE.CanvasTexture(shadowCanvas); this.textures.add(this.contactTexture);
  }

  _mat(color, extra = {}) {
    const k = `${color}/${extra.map?.uuid||''}/${extra.roughness ?? ''}/${extra.metalness ?? ''}/${extra.transparent ? extra.opacity : ''}`;
    if (!this.materials.has(k)) this.materials.set(k, new THREE.MeshStandardMaterial({ color, roughness: 0.86, metalness: 0, ...extra }));
    return this.materials.get(k);
  }

  _geo(kind, args) {
    const k = `${kind}:${args.join(',')}`;
    if (!this.geometries.has(k)) {
      const Constructor = { box: THREE.BoxGeometry, cylinder: THREE.CylinderGeometry, sphere: THREE.SphereGeometry, cone: THREE.ConeGeometry, torus: THREE.TorusGeometry }[kind];
      this.geometries.set(k, new Constructor(...args));
    }
    return this.geometries.get(k);
  }

  _mesh(parent, geometry, material, x = 0, y = 0, z = 0, shadow = true) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.castShadow = shadow; mesh.receiveShadow = true;
    parent.add(mesh); return mesh;
  }

  _box(parent, w, h, d, color, x = 0, y = 0, z = 0, wood = false) {
    return this._mesh(parent, this._geo('box', [w, h, d]), this._mat(color, wood ? { map: this.woodTexture } : {}), x, y, z);
  }

  _cylinder(parent, radius, height, color, x = 0, y = 0, z = 0, radiusBottom = radius, sides = 10) {
    return this._mesh(parent, this._geo('cylinder', [radius, radiusBottom, height, sides]), this._mat(color), x, y, z);
  }

  _sphere(parent, radius, color, x = 0, y = 0, z = 0, segments = 10) {
    return this._mesh(parent, this._geo('sphere', [radius, segments, 7]), this._mat(color), x, y, z);
  }

  _beam(parent, from, to, width, color = COLORS.timber, depth = width) {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const mesh = this._box(parent, width, a.distanceTo(b), depth, color, ...(a.clone().add(b).multiplyScalar(0.5).toArray()), true);
    mesh.quaternion.setFromUnitVectors(UP, b.sub(a).normalize()); return mesh;
  }

  _rope(parent, points, color = COLORS.rope, radius = 0.018) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    const geo = new THREE.TubeGeometry(curve, Math.max(7, points.length * 4), radius, 4, false);
    const mesh = this._mesh(parent, geo, this._mat(color)); mesh.userData.ownGeometry = true; return mesh;
  }

  _outline(mesh, opacity = 0.42) {
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 32), new THREE.LineBasicMaterial({ color: 0x25265b, transparent: true, opacity: Math.min(0.90, opacity * 2.1) }));
    lines.userData.ownGeometry = true; lines.userData.ownMaterial = true;
    mesh.add(lines); return mesh;
  }

  _lights() {
    const ambient = new THREE.HemisphereLight(0xdce7ff, 0x454c80, 1.8); this.scene.add(ambient);
    this.sun = new THREE.DirectionalLight(0xffedca, 2.1); this.sun.position.set(-9, 17, 8);
    this.sun.castShadow = true; this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 45 });
    this.sun.shadow.normalBias = 0.04; this.sun.shadow.bias = -0.0003; this.sun.shadow.radius = 3;
    this.scene.add(this.sun);
    const fill = new THREE.DirectionalLight(0xa9c9ff, 0.65); fill.position.set(7, 8, -10); this.scene.add(fill);
  }

  _ocean() {
    this.waterMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uCenter: { value: new THREE.Vector2() }, uStorm: { value: 0 } },
      vertexShader: `
        uniform float uTime;
        varying vec3 vWorld;
        void main() {
          vec3 p = position;
          p.z += sin(p.x * .52 + uTime * .65) * .025 + cos(p.y * .7 + uTime * .48) * .018;
          vec4 world = modelMatrix * vec4(p, 1.);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform float uTime;
        uniform vec2 uCenter;
        uniform float uStorm;
        varying vec3 vWorld;
        float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
        float noise(vec2 p) {
          vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);
        }
        void main() {
          vec2 p=vWorld.xz;
          float n=noise(p*.13+vec2(uTime*.008,-uTime*.012));
          float bands=sin(p.x*.19+p.y*.16)*.5+.5;
          vec3 deep=vec3(.018,.075,.21);
          vec3 shallow=vec3(.055,.17,.41);
          vec3 col=mix(deep,shallow,clamp(n*.62+bands*.25+.25,0.,1.));
          float nearRaft=exp(-length(p-uCenter)*.16);
          col=mix(col,vec3(.043,.157,.37),nearRaft*.22);
          vec2 drift=p+vec2(uTime*.022,-uTime*.018);
          vec2 cell=floor(drift/vec2(2.1,1.7));
          vec2 local=mod(drift,vec2(2.1,1.7))-vec2(1.05,.85);
          local-=vec2(hash(cell)*.9-.45,hash(cell+3.)*.6-.3);
          float ridge=abs(local.y-(.07-abs(local.x)*.25));
          float crest=(1.-smoothstep(.014,.046,ridge))*(1.-smoothstep(.20,.37,abs(local.x)));
          crest*=step(.24,hash(cell+7.))*smoothstep(-.45,.2,sin(uTime*.45+hash(cell)*6.28));
          col=mix(col,vec3(.72,.82,.95),crest*.72);
          float glint=pow(max(0.,sin(p.x*10.+p.y*12.+uTime*.6)),22.)*smoothstep(.77,.94,noise(p*2.));
          col+=vec3(.018,.030,.05)*glint;
          col=mix(col,vec3(.12,.30,.35)+col*.16,uStorm*.62);
          gl_FragColor=vec4(col,.86);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(230, 230, 65, 65), this.waterMaterial);
    this.water.rotation.x = -Math.PI / 2; this.water.position.y = -0.23; this.water.renderOrder = 1;
    this.scene.add(this.water);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), new THREE.ShadowMaterial({ opacity: 0.2, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = -0.185; shadow.receiveShadow = true; shadow.renderOrder = 2; this.scene.add(shadow);
    this.waterShadow = shadow;
    const contacts = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 7.7), new THREE.MeshBasicMaterial({ map: this.contactTexture, transparent: true, depthWrite: false, opacity: 0.75 }));
    contacts.rotation.x = -Math.PI / 2; contacts.position.y = -0.16; contacts.renderOrder = 3; this.scene.add(contacts);
    this.contactShadow = contacts;
    const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xb1eece, transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthWrite: false });
    for (let i = 0; i < 7; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.83, 0.855, 36, 1, rand(0, 2), rand(1.2, 2.6)), ringMaterial);
      ring.rotation.x = -Math.PI / 2; ring.position.set(rand(-4.5, 4.5), -0.12, rand(-4, 4)); ring.scale.set(1.4, 0.45, 1); ring.renderOrder = 4;
      this.scene.add(ring); this.ripples.push({ mesh: ring, phase: i * 0.9 });
    }
  }

  _surroundings() {
    const surroundings = new THREE.Group(); this.scene.add(surroundings); this.surroundings = surroundings;
    // These ghosted roofs place the raft above a drowned city, without competing with the settlement.
    const submerged = new THREE.Group(); this.scene.add(submerged);
    for (const [x, z, w, h, d] of [[-5.5,-5.7,2.1,4.0,1.6],[3.9,-7.5,2,4.5,2.1],[-5.5,3.8,2.5,4.7,2.4],[6.8,3.6,1.8,3.8,2.4]]) {
      const building = this._box(submerged, w, h, d, 0x35537b, x, -h / 2 - 0.50, z);
      building.castShadow = false;
      this._box(submerged, w + 0.14, 0.15, d + 0.14, 0x536f91, x, -0.52, z).castShadow = false;
      const silhouette=new THREE.LineSegments(new THREE.EdgesGeometry(building.geometry),new THREE.LineBasicMaterial({color:0x293f70,transparent:true,opacity:.65}));silhouette.position.copy(building.position);submerged.add(silhouette);
      for (let row = 0; row < 5; row++) for (let column = 0; column < 4; column++) {
        this._box(submerged,.25,.33,.016,0x1e3865,x-w*.34+column*w*.22,-1.05-row*.63,z+d/2+.012).castShadow=false;
        this._box(submerged,.016,.33,.25,0x25446f,x+w/2+.012,-1.05-row*.63,z-d*.34+column*d*.22).castShadow=false;
      }
      for(let row=0;row<5;row++)this._box(submerged,w+.04,.028,d+.04,0x4f6c91,x,-.82-row*.63,z).castShadow=false;
    }
    this._batchStatic(submerged);
    for (const [x,z,s] of [[-11,-6,1.5],[10,-12,1.7],[14,4,1.35],[-12,13,1.15]]) {
      const island = new THREE.Group(); island.position.set(x, -0.2, z); surroundings.add(island);
      const rock = this._mesh(island, new THREE.DodecahedronGeometry(s, 0), this._mat(0x698b88), 0, .22, 0); rock.scale.set(1.65,.6,1.15); rock.rotation.set(.1,.4,.1);
      const ridge = this._mesh(island, new THREE.DodecahedronGeometry(s*.6,0),this._mat(0x8eaaa0),-.3,.55,.1); ridge.scale.set(1,.55,.8);
      this._box(island,s*1.1,.12,s*.7,0x9ba77b,-.3,.63,0).rotation.y=.4;
      if (x < 0) this._palm(island,-.2,.65,0,s*.7);
    }
    // A leaning municipal water tower survives at the edge of the map.
    const tower = new THREE.Group(); tower.position.set(-10.7,-.22,-11.3); tower.scale.setScalar(.72); tower.rotation.z = -.13; surroundings.add(tower);
    for (const x of [-.6,.6]) for (const z of [-.6,.6]) this._beam(tower,[x,0,z],[x,2.55,z],.1,0x597f7b);
    for (const z of [-.6,.6]) { this._beam(tower,[-.6,.2,z],[.6,2.2,z],.065,0x77918a); this._beam(tower,[.6,.2,z],[-.6,2.2,z],.065,0x77918a); }
    this._cylinder(tower,1.03,1.5,0xb3a57d,0,3,0,1.03,12);
    this._cylinder(tower,1.07,.1,0x658c8c,0,2.36,0,1.07,12);
    this._cylinder(tower,.2,.55,0x788e88,0,4,0,1.06,12);
    const stripe = this._cylinder(tower,1.045,.14,0x6b9291,0,3.35,0,1.045,12); stripe.castShadow=false;
    // A grounded trawler, deliberately quiet and weathered.
    const wreck = new THREE.Group(); wreck.position.set(9.4,-.15,-7.2); wreck.rotation.set(.05,-.6,-.19); surroundings.add(wreck);
    const hull = this._cylinder(wreck,.6,2.8,0x716c5c,0,.14,0,.46,6); hull.rotation.z=Math.PI/2; hull.scale.z=.72;
    this._box(wreck,2.7,.19,.81,0xa88a61,0,.4,0);
    this._box(wreck,.8,.75,.7,0xc4baa0,.1,.8,0);
    this._box(wreck,.88,.12,.8,0x58827e,.1,1.23,0);
    this._box(wreck,.35,.25,.014,0x395c62,.1,.94,.36);
    this._beam(wreck,[-.8,.5,0],[-.8,2.3,0],.07,0x708079);
    this._rope(wreck,[[-.8,2.2,0],[0,1.6,.02],[1.25,.5,0]],0x8c9681,.013);
    const buoy = new THREE.Group(); buoy.position.set(-5.8,-.15,5.7); surroundings.add(buoy);
    this._cylinder(buoy,.28,.12,0xd48e49,0,0,0,.38);
    this._cylinder(buoy,.10,.55,0xe3ca89,0,.27,0,.17);
    this._sphere(buoy,.12,0xe8764d,0,.59,0);
    this.animations.push({ type:'buoy', group:buoy, baseY:-.15, phase:1.4 });
    // The playable sea is a drowned city. Keep dry land and tall props out of its silhouette.
    for(const child of surroundings.children)if(child!==buoy)child.visible=false;
  }

  _palm(parent, x, y, z, scale = 1) {
    const palm = new THREE.Group(); palm.position.set(x,y,z); palm.scale.setScalar(scale); parent.add(palm);
    this._beam(palm,[0,0,0],[.18,1.8,0],.12,0x9c8457);
    for(let i=0;i<7;i++) {
      const leaf = this._mesh(palm,new THREE.ConeGeometry(.22,1.3,4),this._mat(i%2 ? 0x609d69:0x78ac6a),Math.sin(i*6.28/7)*.46,1.82,Math.cos(i*6.28/7)*.46);
      leaf.quaternion.setFromUnitVectors(UP,new THREE.Vector3(Math.sin(i*6.28/7),-.22,Math.cos(i*6.28/7)).normalize());
    }
  }

  setState(state) {
    this.state = state || {};
    if (!this.renderer || this.disposed) return;
    const raft = Array.isArray(this.state.raft) && this.state.raft.length ? this.state.raft : DEFAULT_RAFT;
    this.raft = raft.filter(t => Number.isFinite(t.x) && Number.isFinite(t.z));
    this.tileSet = new Set(this.raft.map(t => keyOf(t.x,t.z)));
    this.buildings = Array.isArray(this.state.buildings) ? this.state.buildings : Object.values(this.state.buildings || {});
    this.buildings = this.buildings.filter(b => b && Number.isFinite(b.x) && Number.isFinite(b.z));
    this.occupied = new Set(this.buildings.map(b => keyOf(b.x,b.z)));
    const raftKey = this.raft.map(t => keyOf(t.x,t.z)).sort().join('|');
    if (raftKey !== this.raftKey) { this.raftKey = raftKey; this._buildRaft(); this._makeTargets(); }
    const layoutKey = this.buildings.map(b => `${b.id}/${b.type}/${b.x}/${b.z}/${b.level || 1}/${b.construction?.kind||''}`).join('|');
    if (layoutKey !== this.layoutKey) { this.layoutKey = layoutKey; this._buildBuildings(); this._makeTargets(); }
    this._updateReady();
    const count = clamp(Number(this.state.population?.total ?? this.state.population ?? 2), 1, 10);
    if (count !== this.residents.length) this._makeResidents(count);
    this._assignWorkers();
    this._updateFishingTargets();
    this._rebuildPickables();
  }

  _clear(group) {
    if (!group) return;
    while (group.children.length) {
      const child = group.children[0];
      child.traverse(obj => {
        if (obj.userData.ownGeometry) obj.geometry?.dispose();
        if (obj.userData.ownMaterial) obj.material?.dispose();
      });
      group.remove(child);
    }
  }

  _batchStatic(group, exclusions = []) {
    // Planks, nails, ropes and structural beams share a small material palette.
    // Merge once when the layout changes so each board does not become a mobile draw call.
    group.updateWorldMatrix(true,true);
    const inverse=group.matrixWorld.clone().invert(), excluded=new Set(exclusions), batches=new Map();
    const visit=node=>{
      if(excluded.has(node))return;
      if(node.isMesh&&!node.userData.action&&!node.children.length&&!Array.isArray(node.material)) {
        const bucket=batches.get(node.material)||[];bucket.push(node);batches.set(node.material,bucket);
      }
      for(const child of node.children)visit(child);
    };
    visit(group);
    for(const [material,meshes] of batches) {
      if(meshes.length<2)continue;
      const geometries=meshes.map(mesh=>{
        const geometry=mesh.geometry.index?mesh.geometry.toNonIndexed():mesh.geometry.clone();
        geometry.applyMatrix4(inverse.clone().multiply(mesh.matrixWorld));return geometry;
      });
      const geometry=new THREE.BufferGeometry();
      for(const name of ['position','normal','uv']) {
        if(!geometries.every(g=>g.attributes[name]))continue;
        const itemSize=geometries[0].attributes[name].itemSize;
        const length=geometries.reduce((sum,g)=>sum+g.attributes[name].array.length,0);
        const values=new Float32Array(length);let offset=0;
        for(const source of geometries){values.set(source.attributes[name].array,offset);offset+=source.attributes[name].array.length;}
        geometry.setAttribute(name,new THREE.BufferAttribute(values,itemSize));
      }
      geometry.computeBoundingSphere();
      const merged=new THREE.Mesh(geometry,material);merged.castShadow=meshes.some(m=>m.castShadow);merged.receiveShadow=true;
      merged.userData.ownGeometry=true;merged.userData.ownMaterial=meshes.some(m=>m.userData.ownMaterial);group.add(merged);
      for(const source of meshes){source.parent.remove(source);if(source.userData.ownGeometry)source.geometry.dispose();}
      for(const temporary of geometries)temporary.dispose();
    }
  }

  _comicHull(group,thickness=.018,exclusions=[]) {
    group.updateWorldMatrix(true,true);
    const inverse=group.matrixWorld.clone().invert(),excluded=new Set(exclusions),positions=[];
    const visit=node=>{
      if(excluded.has(node)||node.userData.isComicHull)return;
      if(node.isMesh&&!node.userData.action&&node.material!==this.invisibleMaterial) {
        const geometry=node.geometry.index?node.geometry.toNonIndexed():node.geometry.clone();geometry.applyMatrix4(inverse.clone().multiply(node.matrixWorld));
        const p=geometry.attributes.position,n=geometry.attributes.normal;
        if(n) {
          const averages=new Map();
          for(let i=0;i<p.count;i++){const key=`${Math.round(p.getX(i)*10000)},${Math.round(p.getY(i)*10000)},${Math.round(p.getZ(i)*10000)}`,sum=averages.get(key)||new THREE.Vector3();sum.x+=n.getX(i);sum.y+=n.getY(i);sum.z+=n.getZ(i);averages.set(key,sum);}
          for(const value of averages.values())value.normalize();
          for(let i=0;i<p.count;i++){const key=`${Math.round(p.getX(i)*10000)},${Math.round(p.getY(i)*10000)},${Math.round(p.getZ(i)*10000)}`,normal=averages.get(key);positions.push(p.getX(i)+normal.x*thickness,p.getY(i)+normal.y*thickness,p.getZ(i)+normal.z*thickness);}
        }
        geometry.dispose();
      }
      for(const child of node.children)visit(child);
    };visit(group);
    if(!positions.length)return;
    if(!this.comicHullMaterial)this.comicHullMaterial=new THREE.MeshBasicMaterial({color:0x272758,side:THREE.BackSide});
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeBoundingSphere();
    const hull=new THREE.Mesh(geometry,this.comicHullMaterial);hull.userData.ownGeometry=true;hull.userData.isComicHull=true;group.add(hull);
  }

  _buildRaft() {
    this._clear(this.tileGroup); this.tilePickables = [];
    const bridgeColors=[0x61a69e,0xaa81ac,0xe6b574,0x6197b0];
    for (const tile of this.raft) {
      const {x,z}=tile;
      const group = new THREE.Group(); group.position.set(x*TILE,0,z*TILE); this.tileGroup.add(group);
      const seed=Math.abs(x*19+z*11+7);
      this._box(group,1.49,.18,1.49,0x343b69,0,.07,0);
      const slab=this._mesh(group,this._geo('box',[1.49,.12,1.49]),this._mat(seed%3===0?0xc9c5b9:0xb9bbb5,{map:this.steelTexture}),0,.21,0);
      this._box(group,1.46,.018,.018,0x55576e,0,.278,-.73);
      this._box(group,.018,.018,1.46,0x55576e,-.73,.278,0);
      const scuff=this._box(group,.29,.012,.13,seed%2?0x8b8f7f:0xada391,.32,.278,.27);scuff.rotation.y=.4;
      if(seed%2===0){const repair=this._box(group,.25,.022,.35,0x728b83,-.43,.283,.31);repair.rotation.y=-.09;}
      for(const a of [-.56,.56]) {
        const float=this._cylinder(group,.22,1.14,(x+z)%2?0x476f9f:0x425987,a,-.10,0,.22,10);float.rotation.x=Math.PI/2;
        for(const b of [-.39,.39])this._mesh(group,this._geo('torus',[.224,.022,4,12]),this._mat(0x323966),a,-.10,b);
      }
      for(const a of [-.64,.64])for(const b of [-.64,.64])this._cylinder(group,.024,.014,0x57576b,a,.284,b,.024,6);
      const exposed=[];
      for (const [dx,dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        if(!this.tileSet.has(keyOf(x+dx,z+dz))) {
          exposed.push([dx,dz]);
          const edge=new THREE.Group();edge.rotation.y=Math.atan2(dx,dz);group.add(edge);
          const ramp=(Math.abs(x*3+z+dx+2*dz)%3===1);
          if(!ramp) {
            this._mesh(edge,this._geo('box',[1.29,.27,.075]),this._mat(0xd1d1a8,{map:this.wallTexture}),0,.415,.72);
            this._box(edge,1.35,.045,.10,0x36456c,0,.285,.72);
            for(const px of [-.66,.66])this._box(edge,.055,.34,.10,0x727f56,px,.405,.72);
            for(const px of [-.48,.48])this._box(edge,.10,.14,.04,0xe0b244,px,.12,.766);
          } else {
            const rampGroup=new THREE.Group();rampGroup.position.set(0,.20,.80);rampGroup.rotation.x=.30;edge.add(rampGroup);
            this._box(rampGroup,1.16,.10,.89,0x323765,0,-.045,0);
            for(let i=0;i<5;i++){const plank=this._box(rampGroup,.217,.07,.85,i%2?0xf1c486:0xe4b577,-.448+i*.224,.025,0,true);plank.rotation.y=(i-2)*.012;}
            for(const px of [-.60,.60])this._beam(rampGroup,[px,.02,-.46],[px,.02,.46],.045,0x343660);
          }
          const bridge=new THREE.Group();bridge.position.set(0,.025,1.015);edge.add(bridge);
          this._box(bridge,1.53,.115,.36,0x343b70,0,-.035,0);
          this._box(bridge,1.45,.055,.37,0xbd655d,0,-.085,0);
          for(let i=0;i<3;i++)this._box(bridge,.475,.055,.31,bridgeColors[(seed+i+Math.abs(dx+dz))%4],-.49+i*.49,.055,0,i===1);
          for(const px of [-.72,.72])this._rope(bridge,[[px,-.08,-.16],[px,.095,-.15],[px,.095,.15],[px,-.08,.16]],0xd3c49b,.014);
          const tube=this._cylinder(bridge,.10,1.26,0x477ba9,0,-.145,0,.10,8);tube.rotation.z=Math.PI/2;
        }
      }
      for(let i=0;i<exposed.length;i++)for(let j=i+1;j<exposed.length;j++) {
        const [ax,az]=exposed[i],[bx,bz]=exposed[j];if(ax*bx+az*bz!==0)continue;
        const cx=(ax+bx)*1.015,cz=(az+bz)*1.015;
        this._box(group,.39,.12,.39,0x343a69,cx,.01,cz);
        this._mesh(group,this._geo('box',[.35,.06,.35]),this._mat(0xb9bbab,{map:this.steelTexture}),cx,.105,cz);
        for(const sx of [-.13,.13])this._cylinder(group,.018,.012,0x585b70,cx+sx,.145,cz,.018,5);
      }
      const hit=this._box(group,1.53,.12,1.53,0xffffff,0,.27,0);
      hit.material=this._invisibleMaterial(); hit.castShadow=false; hit.userData.action={type:'tile',x,z}; this.tilePickables.push(hit);
    }
    this._batchStatic(this.tileGroup);
    this._comicHull(this.tileGroup,.019);
    const cx=this.raft.reduce((s,t)=>s+t.x,0)/this.raft.length*TILE;
    const cz=this.raft.reduce((s,t)=>s+t.z,0)/this.raft.length*TILE;
    this.waterMaterial.uniforms.uCenter.value.set(cx,cz);
    const width=(Math.max(...this.raft.map(t=>t.x))-Math.min(...this.raft.map(t=>t.x))+1)*TILE;
    const depth=(Math.max(...this.raft.map(t=>t.z))-Math.min(...this.raft.map(t=>t.z))+1)*TILE;
    this.contactShadow.position.set(cx,-.16,cz); this.contactShadow.scale.set(width/4.65,depth/4.65,1);
  }

  _invisibleMaterial() {
    if(!this.invisibleMaterial) this.invisibleMaterial=new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false,colorWrite:false});
    return this.invisibleMaterial;
  }

  _buildBuildings() {
    this._finishCast();
    this._clear(this.buildingGroup); this.buildingPickables=[]; this.buildingModels=new Map();
    this.animations=this.animations.filter(a=>a.type==='buoy');
    for(const building of this.buildings) {
      const group=new THREE.Group(); group.position.set(building.x*TILE,.29,building.z*TILE); group.userData.building=building; this.buildingGroup.add(group);
      if(building.type==='fishing') {
        if(!this.tileSet.has(keyOf(building.x-1,building.z))){group.position.x-=.56;group.position.z+=.14;}
        else if(!this.tileSet.has(keyOf(building.x,building.z+1))){group.position.z+=.56;group.position.x-=.14;}
        else if(!this.tileSet.has(keyOf(building.x+1,building.z))){group.position.x+=.56;group.position.z+=.14;}
      }
      const creator={command:'_command',purifier:'_purifier',kitchen:'_kitchen',bed:'_bed',farm:'_farm',beacon:'_beacon',fishing:'_fishing',slicer:'_slicer',scavenger:'_scavenger',materials:'_materials',construction:'_construction',tailor:'_tailor',seafoodKitchen:'_seafoodKitchen',broadcast:'_broadcast',divingDock:'_divingDock',hospital:'_hospital',dailyFactory:'_dailyFactory'}[building.type] || '_command';
      if(building.construction?.kind==='build')this._constructionSite(group,false);
      else {this[creator](group);if(building.construction)this._constructionSite(group,true);}
      this._batchStatic(group,this.animations.map(animation=>animation.mesh).filter(Boolean));
      this._comicHull(group,.017,this.animations.map(animation=>animation.mesh).filter(Boolean));
      // Keep the forgiving footprint shallow. A full-height invisible box blocks
      // visible roofs in the row behind it, so the actual canopy/model surfaces
      // participate in picking instead of filling the air above the building.
      const hit=this._box(group,1.28,.18,1.28,0xffffff,0,.10,0);
      hit.material=this._invisibleMaterial(); hit.castShadow=false; hit.userData.action={type:'building',id:building.id}; this.buildingPickables.push(hit);
      group.traverse(mesh=>{
        if(mesh.isMesh&&mesh!==hit){mesh.userData.action={type:'building',id:building.id};this.buildingPickables.push(mesh);}
      });
      const icon=this._sprite(building.construction?'build':building.type==='purifier'?'water':building.type==='kitchen'||building.type==='fishing'||building.type==='slicer'?'fish':'ready',.70);
      icon.position.set(0,building.type==='beacon'?3.3:building.type==='command'?2.2:1.95,0); icon.userData.baseY=icon.position.y; icon.visible=false;
      icon.userData.action={type:'building',id:building.id}; group.add(icon);
      this.buildingPickables.push(icon);
      this.buildingModels.set(building.id,{group,icon,building,rig:group.userData.fishingRig});
    }
  }

  _constructionSite(g,upgrade=false) {
    // Temporary timber scaffold; the building's original model appears on completion.
    const y=upgrade?1.76:1.18;
    for(const x of [-.64,.64])for(const z of [-.53,.53])this._beam(g,[x,.12,z],[x,y,z],.065,0x9a7748);
    for(const x of [-.64,.64]){
      this._beam(g,[x,y,-.60],[x,y,.60],.07,0xbb965c);
      this._beam(g,[x,.25,-.53],[x,y-.1,.53],.045,0xc4a066);
    }
    this._beam(g,[-.70,y,-.53],[.70,y,-.53],.07,0xbb965c);
    if(!upgrade){
      for(let i=0;i<5;i++)this._box(g,.77,.045,.12,0xc09a62,-.12,.18+i*.048,.05,true).rotation.y=i*.04;
      const cover=this._box(g,1.05,.03,.65,0x708d9b,.08,y-.05,-.14);cover.rotation.z=-.08;
      this._box(g,.26,.28,.23,0x8a9c9f,.40,.23,.30,true);
    }
    // Low striped barrier leaves the scene's visible roof pick targets unobstructed.
    this._box(g,.78,.17,.045,0xe3ba4f,0,.47,.66,true);
    for(const x of [-.29,-.09,.11,.31]){const stripe=this._box(g,.055,.16,.012,0x66523d,x,.47,.691);stripe.rotation.z=-.35;}
    for(const x of [-.32,.32])this._beam(g,[x,.13,.63],[x,.52,.63],.045,0x96754b);
    this._box(g,.25,.07,.13,0x5c6974,-.33,.40,.26).rotation.y=.35;
    this._beam(g,[-.31,.30,.27],[-.11,.30,.45],.035,0xb9955f);
  }

  _command(g) {
    this._box(g,1.22,.12,1.17,0xc79b5b,0,.06,0,true);
    this._box(g,1.12,.61,.075,0x9f8756,0,.42,-.40,true);
    this._box(g,.075,.55,.80,0xbaa06b,-.52,.40,0,true);
    for(const x of [-.57,.57]) for(const z of [-.48,.48]) this._beam(g,[x,.12,z],[x,1.15,z],.075,0x8d7147);
    this._beam(g,[-.68,1.02,-.61],[-.68,1.22,.61],.065,0x7c6744);
    this._beam(g,[.68,1.02,-.61],[.68,1.22,.61],.065,0x7c6744);
    const roof=this._box(g,1.45,.065,1.41,0xeac14a,0,1.16,0); roof.rotation.x=.18; this._outline(roof,.29);
    this._box(g,1.45,.21,.045,0xf0c851,0,1.19,.7);
    const patch=this._box(g,.35,.018,.37,0xc79942,.35,1.207,-.08); patch.rotation.x=.18; patch.rotation.y=.15;
    const repair=this._box(g,.28,.024,.42,0x819477,-.37,1.222,.19);repair.rotation.x=.18;repair.rotation.y=-.14;
    for(const z of [-.25,-.13,-.01,.11])this._box(g,.015,.025,.07,0x6c6950,-.20,1.24,z);
    this._rope(g,[[-.7,1.29,.67],[-.35,1.13,.73],[0,1.12,.73],[.35,1.13,.73],[.7,1.29,.67]],0x6d6b45,.013);
    this._box(g,.60,.08,.34,0x9b613b,.01,.53,.14,true);
    this._box(g,.43,.014,.29,0xe5dab1,.01,.58,.14).rotation.y=.12;
    this._box(g,.22,.016,.07,0x5b9c98,.04,.592,.14).rotation.y=-.42;
    this._cylinder(g,.075,.055,0x637f6d,.15,.61,.06);
    this._barrel(g,.53,.03,.65,.18,0x6b9d95);
    this._box(g,.29,.3,.27,0xb58548,-.39,.19,.48,true);
    this._box(g,.31,.05,.29,0x6d8f79,-.39,.37,.48,true);
    this._beam(g,[.60,.2,-.39],[.60,1.9,-.39],.045,0x7a6b48);
    const flagGeometry=new THREE.BufferGeometry();
    flagGeometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,.5,-.03,0,.4,-.22,.025,0,-.27,0],3));
    flagGeometry.setIndex([0,1,2,0,2,3]); flagGeometry.computeVertexNormals();
    const flag=this._mesh(g,flagGeometry,new THREE.MeshStandardMaterial({color:0xf49d43,side:THREE.DoubleSide,roughness:.9}),.61,1.83,-.39); flag.userData.ownGeometry=true; flag.userData.ownMaterial=true;
    this.animations.push({type:'flag',mesh:flag});
    const ring=this._mesh(g,this._geo('torus',[.16,.035,5,14]),this._mat(0xd38949),-.57,.56,.08); ring.rotation.y=Math.PI/2;
    this._sphere(g,.038,0xffe6a2,.49,.85,.47);
    this._rope(g,[[-.55,.12,.57],[-.62,.19,.59],[-.68,.16,.55],[-.64,.09,.51],[-.56,.12,.57]],0xd4bd85,.027);
    const towel=this._box(g,.25,.018,.45,0x688e89,-.52,.55,-.09);towel.rotation.z=-.12;
  }

  _barrel(g,x,y,z,r=.2,color=COLORS.blue) {
    const group=new THREE.Group(); group.position.set(x,y,z); g.add(group);
    this._outline(this._cylinder(group,r,r*2.5,color,0,r*1.25,0,r,12),.18);
    for(const by of [.10,r*2.5-.08]) this._cylinder(group,r+.007,.038,0x638b87,0,by,0,r+.007,12);
    this._cylinder(group,r*.80,.022,0x8eb9ac,0,r*2.5+.012,0,r*.80,12);
    return group;
  }

  _purifier(g) {
    this._box(g,1.12,.08,.96,0x8e7451,0,.04,0,true);
    this._barrel(g,-.28,.08,.05,.29,0x49a6b5);
    this._cylinder(g,.24,.05,0x92d5cd,-.28,.86,.05,.29,12);
    this._cylinder(g,.14,.13,0xf0cf6b,-.28,.95,.05,.24,12);
    this._cylinder(g,.04,.35,0x568e8b,-.28,1.17,.05,.04,8);
    this._barrel(g,.36,.08,.22,.19,0x2c7b91);
    this._box(g,.42,.45,.36,0xcabe8b,.28,.34,-.33);
    this._cylinder(g,.18,.09,0x82b5af,.28,.60,-.33,.18,10);
    this._rope(g,[[-.28,1.25,.05],[.04,1.3,.04],[.24,.95,.2],[.36,.75,.22]],0xd3b073,.038);
    this._beam(g,[-.55,.15,-.4],[-.55,1.25,-.4],.05,0xb59960);
    this._beam(g,[-.55,1.25,-.4],[.47,1.25,-.4],.04,0xb59960);
    const board=this._box(g,.37,.32,.04,0xe7d6a3,-.15,1.17,-.4); board.rotation.z=-.06;
    const drop=this._sprite('water',.22); drop.position.set(-.15,1.18,-.36); g.add(drop);
    const water=this._cylinder(g,.013,.20,0x8ce5e0,.36,.73,.22,.013,6); water.castShadow=false;
    this.animations.push({type:'water',mesh:water});
    this._box(g,.16,.06,.13,0x657978,.5,.17,-.25);
  }

  _canopy(g, colorA, colorB, y=1.28) {
    for(const x of [-.61,.61]) for(const z of [-.49,.49]) this._beam(g,[x,0,z],[x,y,z],.046,0x86684b);
    for(let i=0;i<6;i++) {
      const strip=this._box(g,.23,.055,1.23,i%2?colorB:colorA,-.575+i*.23,y,.04); strip.rotation.x=.12;
      const flap=this._box(g,.23,.17,.035,i%2?colorB:colorA,-.575+i*.23,y-.02,.65); flap.rotation.x=.05;
    }
  }

  _kitchen(g) {
    this._canopy(g,0xd8684c,0xf8e4b7,1.38);
    this._box(g,1.04,.14,.7,0xb99b64,0,.51,.05,true);
    this._box(g,.8,.4,.55,0x929382,.05,.27,.02);
    for(const x of [-.36,.36]) this._box(g,.08,.5,.08,0x76573d,x,.27,.25,true);
    this._cylinder(g,.23,.08,0x4c5550,-.20,.62,.03);
    this._cylinder(g,.20,.21,0x4a6866,-.20,.75,.03,.16);
    this._cylinder(g,.12,.03,0xca9145,-.20,.87,.03);
    for(const x of [-.44,.045]) { const handle=this._mesh(g,this._geo('torus',[.065,.018,4,8]),this._mat(0x455751),x,.79,.03); handle.rotation.y=Math.PI/2; }
    this._box(g,.31,.032,.25,0xe3b77a,.31,.61,.08,true);
    this._fish(g,.31,.66,.08,.21,-.8);
    this._box(g,.30,.23,.06,0x464a42,.12,.30,.33);
    for(let i=0;i<3;i++) this._beam(g,[i*.065+.05,.19,.37],[i*.065+.09,.32,.37],.025,0xeaaa48);
    this._barrel(g,-.5,0,-.39,.15,0x648d79);
    this._cylinder(g,.07,.75,0x797d6b,.43,.95,-.33,.07,8);
    this.animations.push({type:'smoke',group:g,x:.43,y:1.35,z:-.33});
  }

  _bed(g) {
    this._box(g,1.04,.10,1.12,0x9b7448,0,.07,0,true);
    for(const x of [-.48,.48]) this._beam(g,[x,.1,-.48],[0,1.06,-.48],.05,0xb19a67);
    const roofGeometry=new THREE.BufferGeometry();
    roofGeometry.setAttribute('position',new THREE.Float32BufferAttribute([-.62,.18,-.6,0,1.03,-.6,0,1.03,.60,-.62,.18,.6,0,1.03,-.6,.62,.18,-.6,.62,.18,.6,0,1.03,.6],3));
    roofGeometry.setIndex([0,1,2,0,2,3,4,5,6,4,6,7]); roofGeometry.computeVertexNormals();
    const roof=this._mesh(g,roofGeometry,new THREE.MeshStandardMaterial({color:0x688f69,roughness:1,side:THREE.DoubleSide})); roof.userData.ownGeometry=true; roof.userData.ownMaterial=true; this._outline(roof,.18);
    this._box(g,.60,.11,.96,0xc1b37f,0,.20,.03);
    this._box(g,.57,.05,.61,0x54928b,0,.28,.17);
    this._box(g,.47,.09,.22,0xf1dfb3,0,.29,-.32);
    this._rope(g,[[0,1.03,.61],[.03,.5,.91],[.05,.05,.92]],0xd8c18b,.016);
    this._box(g,.29,.26,.25,0xbaa572,.52,.17,.45,true);
    this._sphere(g,.065,0xf7ce65,.54,.45,.43);
  }

  _farm(g) {
    this._box(g,1.2,.26,1.16,0x9f7844,0,.16,0,true);
    this._box(g,1.08,.06,1.04,0x6f5940,0,.32,0);
    for(const x of [-.58,.58]) this._box(g,.06,.16,1.21,0xc49b61,x,.33,0,true);
    for(const z of [-.58,.58]) this._box(g,1.22,.16,.06,0xc49b61,0,.33,z,true);
    for(let i=0;i<3;i++) for(let j=0;j<3;j++) {
      const x=(i-1)*.32,z=(j-1)*.32;
      this._cylinder(g,.018,.24,0x5a8549,x,.47,z,.024,5);
      for(let k=0;k<3;k++) {
        const leaf=this._sphere(g,.12,(i+j+k)%2?0x77a849:0x9cbd56,x+Math.sin(k*2.1)*.06,.49+k*.03,z+Math.cos(k*2.1)*.06,6);
        leaf.scale.set(.55,1.6,.8); leaf.rotation.z=Math.sin(k*2.1)*.6; leaf.rotation.x=Math.cos(k*2.1)*.6;
      }
    }
    this._beam(g,[.49,.35,-.47],[.49,1.05,-.47],.035,0x96794c);
    const sign=this._box(g,.37,.24,.045,0xedd39c,.48,.96,-.46,true); sign.rotation.z=.13;
    this._box(g,.08,.12,.052,0x7fa150,.48,.96,-.43).rotation.z=.35;
  }

  _beacon(g) {
    this._box(g,1.15,.12,1.12,0xb68c50,0,.06,0,true);
    for(const x of [-.43,.43]) for(const z of [-.43,.43]) this._beam(g,[x,.1,z],[x*.54,1.85,z*.54],.075,0x8d6f45);
    for(const z of [-.43,.43]) {this._beam(g,[-.41,.3,z],[.31,1.35,z*.7],.05,0xad8a55);this._beam(g,[.41,.3,z],[-.31,1.35,z*.7],.05,0xad8a55);}
    this._box(g,.90,.13,.90,0xbd975b,0,1.73,0,true);
    for(let i=0;i<5;i++) this._beam(g,[-.22,.35+i*.25,.44],[.22,.35+i*.25,.44],.04,0x8b704c);
    this._cylinder(g,.23,.42,0x3b838e,0,2,0,.23,8);
    this._cylinder(g,.26,.065,0xf0c759,0,2.27,0,.26,8);
    this._sphere(g,.13,0xffd962,0,2.15,0);
    this._beam(g,[0,2.25,0],[0,2.93,0],.037,0x536f65);
    const radar=new THREE.Group(); radar.position.set(0,2.7,0); g.add(radar);
    this._beam(radar,[-.46,0,0],[.46,0,0],.035,0x647a66);
    for(const x of [-.33,-.11,.11,.33]) this._beam(radar,[x,0,-.16],[x,0,.16],.024,0x647a66);
    this.animations.push({type:'radar',mesh:radar});
    this._box(g,.33,.38,.31,0x597b72,.46,.24,.31);
    this._cylinder(g,.055,.05,0xe6b34f,.46,.45,.31);
  }

  _umbrella(g,x,y,z,r=.77) {
    const umbrella=new THREE.Group();umbrella.position.set(x,y,z);g.add(umbrella);
    this._cylinder(umbrella,.025,1.35,0xb6a473,0,.67,0,.025,8);
    for(let i=0;i<8;i++) {
      const a=i*Math.PI/4,b=(i+1)*Math.PI/4;
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,1.53,0,Math.cos(a)*r,1.25,Math.sin(a)*r,Math.cos(b)*r,1.25,Math.sin(b)*r],3)); geometry.computeVertexNormals();
      const leaf=this._mesh(umbrella,geometry,new THREE.MeshStandardMaterial({color:i%2?0xf4d86f:0xe9b646,side:THREE.DoubleSide,roughness:.9})); leaf.userData.ownGeometry=true;leaf.userData.ownMaterial=true;
      this._beam(umbrella,[0,1.51,0],[Math.cos(a)*r,1.25,Math.sin(a)*r],.013,0xcbad62);
    }
    this._sphere(umbrella,.055,0xeebc4a,0,1.56,0);
  }

  _fishing(g) {
    this._box(g,1.24,.12,1.29,0x34386e,0,.025,0);
    this._mesh(g,this._geo('box',[1.15,.055,1.19]),this._mat(0xb6b7c4,{map:this.steelTexture}),0,.11,0);
    for(const x of [-.49,.49]){const float=this._cylinder(g,.14,1.20,0x4a81b5,x,-.10,0,.14,10);float.rotation.x=Math.PI/2;}
    for(const x of [-.57,.57])for(const z of [-.49,.40]) {
      this._beam(g,[x,.12,z],[x,1.34,z],.045,0xe0b36d);
      this._cylinder(g,.052,.09,0x59649b,x,.19,z,.052,8);
    }
    const fabricGeometry=new THREE.BufferGeometry();
    fabricGeometry.setAttribute('position',new THREE.Float32BufferAttribute([-.67,1.34,-.60,.67,1.33,-.60,.67,1.31,.48,-.67,1.34,.48,0,1.44,-.06],3));fabricGeometry.setIndex([0,4,1,1,4,2,2,4,3,3,4,0]);fabricGeometry.computeVertexNormals();
    const fabric=this._mesh(g,fabricGeometry,this._mat(0xffb83e,{side:THREE.DoubleSide}));fabric.userData.ownGeometry=true;
    this._rope(g,[[-.67,1.345,-.60],[.67,1.335,-.60],[.67,1.315,.48],[-.67,1.345,.48],[-.67,1.345,-.60]],0x333467,.017);
    this._beam(g,[-.59,1.36,-.53],[.58,1.36,.40],.014,0xd99437);this._beam(g,[.59,1.36,-.53],[-.58,1.36,.40],.014,0xd99437);
    const chair=new THREE.Group();chair.position.set(-.23,0,.52);chair.rotation.y=-.535;g.add(chair);
    for(const x of [-.18,.18])for(const z of [-.15,.15])this._beam(chair,[x,.12,z],[x,.45,z],.035,0x333e70);
    this._box(chair,.43,.065,.39,0x364372,0,.43,0);this._box(chair,.38,.065,.34,0xf4ecce,0,.485,0);
    this._box(chair,.43,.35,.065,0x3d4779,0,.65,-.18);this._box(chair,.37,.28,.035,0xf3eac8,0,.67,-.135);
    for(const x of [-.23,.23])this._beam(chair,[x,.44,-.15],[x,.60,.17],.034,0x364372);
    this._barrel(g,-.43,.10,.35,.15,0x477bad);
    const innerTube=this._mesh(g,this._geo('torus',[.19,.06,7,16]),this._mat(0x46588c),.48,.53,-.39);innerTube.rotation.y=.24;
    const rigGroup=new THREE.Group();g.add(rigGroup);
    const pivot=new THREE.Group();pivot.position.set(.44,.44,.43);rigGroup.add(pivot);
    this._beam(pivot,[0,0,0],[0,.40,.31],.038,0x755c39);
    this._beam(pivot,[0,.40,.31],[0,.85,.69],.019,0xd4bb79);
    this._cylinder(pivot,.055,.08,0x3a6a72,0,.18,.12,.055,8).rotation.z=Math.PI/2;
    const lineGeometry=new THREE.BufferGeometry();lineGeometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(19*3),3));
    const line=new THREE.Line(lineGeometry,new THREE.LineBasicMaterial({color:0xede6b9,transparent:true,opacity:.87}));line.frustumCulled=false;line.userData.ownGeometry=true;line.userData.ownMaterial=true;rigGroup.add(line);
    const bobber=new THREE.Group();rigGroup.add(bobber);
    this._sphere(bobber,.093,0xe96f45,0,.045,0,10).scale.y=1.3;
    this._cylinder(bobber,.094,.06,0xffefc4,0,.057,0,.094,10);
    this._beam(bobber,[0,.13,0],[0,.24,0],.013,0xf7d06c);
    const ring=this._mesh(bobber,new THREE.RingGeometry(.16,.18,24),new THREE.MeshBasicMaterial({color:0xceead7,transparent:true,opacity:.5,side:THREE.DoubleSide,depthWrite:false}),0,-.03,0,false);ring.rotation.x=-Math.PI/2;ring.userData.ownGeometry=true;ring.userData.ownMaterial=true;
    g.userData.fishingRig={group:rigGroup,pivot,line,bobber,ring,building:g.userData.building};
    this.animations.push({type:'fishingRig',mesh:rigGroup});
    const fish=this._fish(g,-.40,.49,.36,.14,.4); fish.rotation.z=.13;
    this._box(g,.22,.23,.23,0x718b72,.46,.21,-.38);
    this._box(g,.24,.04,.25,0xd6c786,.46,.35,-.38);
    this._rope(g,[[-.51,.10,-.47],[-.57,.16,-.42],[-.50,.22,-.39],[-.44,.15,-.44],[-.51,.10,-.47]],0xd5bf88,.022);
  }

  _fish(g,x,y,z,size=.2,rotation=0) {
    const fish=new THREE.Group(); fish.position.set(x,y,z); fish.rotation.y=rotation;g.add(fish);
    const body=this._sphere(fish,size,0x90b8b0); body.scale.set(1.65,.45,.64);
    const tail=this._mesh(fish,this._geo('cone',[size*.76,size*.9,3]),this._mat(0x547c78),-size*1.63,0,0); tail.rotation.z=-Math.PI/2;tail.scale.z=.38;
    this._sphere(fish,size*.075,0x2f5355,size*1.03,size*.3,size*.38,6);
    return fish;
  }

  _slicer(g) {
    this._canopy(g,0x5d9e91,0x7db5a0,1.4);
    this._box(g,1.08,.13,.70,0xcdab70,0,.72,.06,true);
    for(const x of [-.47,.47]) for(const z of [-.23,.35]) this._box(g,.075,.66,.075,0x8f7048,x,.35,z,true);
    this._box(g,.73,.07,.49,0xe5c68d,0,.83,.06,true);
    this._fish(g,-.08,.91,.09,.21,.15);
    const blade=this._box(g,.27,.22,.025,0xb9cbc2,.29,1.0,.09);blade.rotation.z=-.4;
    this._box(g,.08,.22,.045,0x6f5742,.39,1.17,.09).rotation.z=-.4;
    const crate=this._box(g,.45,.34,.38,0x4b8e8c,-.26,.22,.40);this._outline(crate,.2);
    this._fish(g,-.24,.42,.43,.15,-.6);
    this._barrel(g,.41,0,-.36,.17,0x948366);
    this._box(g,.58,.22,.045,0xe9d6a0,0,1.18,.56,true);
    const sign=this._sprite('fish',.25);sign.position.set(0,1.18,.60);g.add(sign);
    const patch=this._box(g,.31,.018,.37,0x477e74,.35,1.445,-.14);patch.rotation.x=.12;patch.rotation.y=-.1;
    for(const x of [-.45,-.30,-.15])this._box(g,.07,.027,.04,0x76674c,x,1.445,.31);
  }

  _scavenger(g) {
    this._box(g,1.1,.11,1.1,0xa78b5e,0,.07,0,true);
    this._box(g,.73,.13,.64,0x7e8b79,0,.2,-.1);
    this._cylinder(g,.18,.28,0x577874,-.23,.39,-.12,.25,10);
    this._beam(g,[-.23,.5,-.12],[-.23,1.48,-.12],.12,0xd6ac4d);
    this._beam(g,[-.23,1.48,-.12],[.79,1.27,.27],.13,0xe2b74e);
    this._beam(g,[-.23,.78,-.12],[.66,1.27,.22],.06,0x9e8750);
    this._cylinder(g,.10,.17,0x486d68,.78,1.23,.27,.10,8).rotation.x=Math.PI/2;
    this._rope(g,[[.79,1.28,.27],[.80,.84,.27],[.82,.51,.27]],0x49574e,.013);
    const hook=this._mesh(g,this._geo('torus',[.07,.018,4,10,Math.PI*1.45]),this._mat(0x485a56),.82,.47,.27);hook.rotation.z=.5;
    const boat=new THREE.Group();boat.position.set(.97,-.24,.63);boat.rotation.y=.2;g.add(boat);
    const hull=this._cylinder(boat,.30,1.35,0x94734b,0,0,0,.23,6);hull.rotation.x=Math.PI/2;hull.scale.x=.9;
    this._box(boat,.53,.06,1.25,0xb29460,0,.20,0,true);
    for(const z of [-.32,.30]) this._box(boat,.54,.04,.14,0x775e40,0,.24,z,true);
    this._box(g,.43,.37,.39,0xbe9158,-.31,.28,.42,true);
    this._box(g,.46,.04,.41,0xd2a56a,-.31,.49,.42,true);
    this._rope(g,[[.4,.11,.48],[.75,.04,.55],[.95,-.02,.14]],0xd3bd86,.015);
  }

  _materials(g) {
    // Form follows the publisher's material-factory illustration; all geometry is local.
    this._box(g,1.30,.10,1.28,0x34486c,0,.035,0);
    this._box(g,1.20,.055,1.18,0xb8b9a6,0,.115,0);
    this._box(g,.72,.67,.67,0xd8dbc9,-.20,.49,-.26);
    this._box(g,.76,.12,.71,0x67758a,-.20,.20,-.26);
    this._box(g,.22,.28,.038,0x394e75,-.33,.61,.089);
    this._box(g,.17,.22,.044,0x7ba5bd,-.33,.61,.112);
    for(const x of [-.56,.16])this._beam(g,[x,.18,-.60],[x,.88,-.60],.046,0xbaa06b);
    const roof=this._box(g,1.03,.07,.99,0x458f9c,-.22,1.00,-.24);roof.rotation.z=-.19;
    for(let i=0;i<6;i++){const x=-.66+i*.18;this._box(g,.019,.025,.92,0x2c6d83,x,1.035-(x+.22)*.19,-.24);}
    for(const x of [-.73,.29])this._beam(g,[x,1.05-(x+.22)*.19,-.76],[x,1.05-(x+.22)*.19,.28],.073,0xd9b976);
    this._box(g,.22,.022,.27,0x76a9a0,-.38,1.075,-.25).rotation.z=-.19;
    this._cylinder(g,.086,.74,0xb5c3bc,.39,.81,-.52,.086,10);
    this._cylinder(g,.10,.070,0x53667d,.39,1.20,-.52,.10,10);
    const outlet=this._cylinder(g,.087,.25,0xa8b9ba,.47,1.24,-.52,.087,10);outlet.rotation.z=-.63;
    const rim=this._cylinder(g,.103,.038,0x4b647c,.55,1.33,-.52,.103,10);rim.rotation.z=-.63;
    const ramp=new THREE.Group();ramp.position.set(-.23,.16,.48);ramp.rotation.x=.17;g.add(ramp);
    this._box(ramp,.65,.06,.58,0x508f97,0,0,0);
    for(const x of [-.31,.31])this._box(ramp,.04,.10,.60,0xb7c8bd,x,.04,0);
    for(const z of [-.19,0,.19])this._box(ramp,.56,.016,.019,0x2f6f7e,0,.038,z);
    for(const x of [-.52,.04])this._cylinder(g,.030,.16,0x6996a0,x,.14,.74,.030,7);
    this._box(g,.42,.08,.91,0xd5d8c8,.48,.18,.10);
    const bin=this._mesh(g,this._geo('torus',[.28,.038,5,18]),this._mat(0xd8dac8),.48,.34,.10);bin.rotation.x=Math.PI/2;bin.scale.set(.72,1.43,1);
    const colors=[0x81bda8,0x75a6bd,0xcda6b1,0xa7c6aa];
    for(let i=0;i<10;i++){const x=.37+(i%2)*.18,z=-.22+Math.floor(i/2)*.15,y=.29+(i%3)*.035;const scrap=this._box(g,.13,.19,.12,colors[i%4],x,y,z);scrap.rotation.z=(i%3-1)*.18;scrap.rotation.y=i*.4;}
    const roll=this._cylinder(g,.11,.28,0xd0c8a7,-.35,.28,.30,.11,10);roll.rotation.z=Math.PI/2;
    const coil=this._mesh(g,this._geo('torus',[.085,.026,5,12]),this._mat(0xc6ae7b),-.08,.20,.53);coil.rotation.x=Math.PI/2;
  }

  _construction(g) {
    this._box(g,1.31,.10,1.28,0x34456d,0,.035,0);
    this._box(g,1.22,.058,1.18,0xb7b6a5,0,.115,0);
    for(const x of [-.57,.48])for(const z of [-.59,.08]){
      const top=z<0?1.42:1.20;this._beam(g,[x,.13,z],[x,top+.05,z],.068,0xb79863);
      const knot=this._mesh(g,this._geo('torus',[.055,.015,4,9]),this._mat(0x3d577a),x,top-.02,z);knot.rotation.x=Math.PI/2;
    }
    for(let i=0;i<5;i++){
      const x=-.50+i*.235,roof=this._box(g,.24,.040,.84,i%2?0xe9a14f:0xe6a958,x,1.32,-.27);roof.rotation.x=.28;
      this._box(g,.24,.09+(i%2)*.035,.032,0xc78048,x,1.16-(i%2)*.013,.15);
    }
    const patch=this._box(g,.24,.019,.21,0xc78648,.24,1.36,-.38);patch.rotation.x=.28;patch.rotation.y=.14;
    this._rope(g,[[-.60,1.48,-.60],[-.12,1.40,-.65],[.52,1.45,-.60]],0x344a70,.018);
    this._box(g,.36,.52,.06,0x8c9f75,.43,.43,-.47);
    for(let row=0;row<3;row++)for(let col=0;col<2;col++){
      const log=this._cylinder(g,.095,.57,0xad8b59,-.43+col*.20,.23+row*.17,-.27,.095,9);log.rotation.x=Math.PI/2;
      const end=this._cylinder(g,.073,.018,0xd8bd83,-.43+col*.20,.23+row*.17,.024,.073,9);end.rotation.x=Math.PI/2;
    }
    this._cylinder(g,.255,.23,0x7d6546,.27,.25,.37,.28,11);
    this._cylinder(g,.24,.040,0xe0bd7d,.27,.385,.37,.25,11);
    for(const radius of [.11,.18]){const ring=this._mesh(g,this._geo('torus',[radius,.008,4,15]),this._mat(0xb58d59),.27,.410,.37);ring.rotation.x=Math.PI/2;}
    const handle=this._box(g,.036,.43,.045,0x826145,.35,.57,.33,true);handle.rotation.z=-.50;
    const axe=this._box(g,.18,.13,.035,0x9fb7bc,.44,.74,.33);axe.rotation.z=-.50;
    for(let i=0;i<3;i++){const plank=this._box(g,.29,.045,.63,0xc7a56b,.42,.18+i*.048,-.15,true);plank.rotation.y=-.17;}
    const wire=this._mesh(g,this._geo('torus',[.12,.020,5,13]),this._mat(0xc9b26a),-.34,.19,.45);wire.rotation.x=Math.PI/2;
    for(const x of [-.61,.61])this._beam(g,[x,.16,.53],[x,.43,.53],.035,0xaac0b6);
    this._beam(g,[-.61,.43,.53],[-.61,.43,-.05],.035,0xaac0b6);
    for(const [x,z]of [[-.10,.49],[.56,.10],[-.56,.21]]){const chip=this._box(g,.11,.018,.075,0xc09c65,x,.16,z,true);chip.rotation.y=x*2;}
  }

  _tailor(g) {
    // Green sewing table, pink awning and long cloth rolls are visible in the 1270s recording.
    this._box(g,1.28,.10,1.25,0x38486e,0,.035,0);
    this._box(g,1.19,.045,1.15,0xb9bda5,0,.108,0);
    for(const x of [-.53,.34])for(const z of [-.55,-.02])this._beam(g,[x,.13,z],[x,1.33,z],.052,0xb59867);
    for(let i=0;i<5;i++){
      const roof=this._box(g,.225,.045,.72,i%2?0xd895a1:0xda9aa6,-.53+i*.225,1.35,-.29);roof.rotation.z=-.055;
      this._box(g,.225,.12,.032,i%2?0xbc7f95:0xd48f9f,-.53+i*.225,1.29,.075);
    }
    const patch=this._box(g,.25,.015,.25,0xc4788c,.16,1.39,-.37);patch.rotation.z=-.055;
    this._rope(g,[[-.64,1.35,.08],[-.08,1.30,.13],[.58,1.34,.08]],0xe2c78b,.013);
    for(const x of [-.44,.32])for(const z of [-.23,.30])this._box(g,.055,.43,.055,0x8b7652,x,.33,z,true);
    this._box(g,1.01,.085,.65,0x4b916f,-.05,.58,.06);
    this._box(g,.94,.018,.58,0x7daf82,-.05,.634,.06);
    this._box(g,.45,.05,.26,0xc5d1c1,-.24,.68,.01);
    this._box(g,.085,.27,.18,0xe1dec8,-.40,.82,.01);
    this._box(g,.35,.08,.17,0xe1dec8,-.26,.965,.01);
    this._box(g,.025,.19,.027,0x799499,-.08,.84,.06);
    const wheel=this._mesh(g,this._geo('torus',[.088,.022,5,14]),this._mat(0x3e5877),-.49,.89,.01);wheel.rotation.y=Math.PI/2;
    this._box(g,.30,.023,.28,0xd4bd83,.20,.661,.12).rotation.y=.15;
    this._box(g,.15,.019,.19,0x667fa4,.18,.680,.12).rotation.y=.15;
    for(const [x,color]of [[.15,0xb28ba3],[.32,0xc9b569]]){this._cylinder(g,.045,.12,color,x,.77,-.16,.045,9);this._cylinder(g,.065,.020,0xe2cfa1,x,.84,-.16,.065,9);}
    this._beam(g,[.57,.14,-.50],[.57,1.17,-.50],.046,0xb9a474);
    this._beam(g,[.57,1.17,-.50],[.57,1.17,.48],.045,0xb9a474);
    for(const [z,color]of [[-.28,0xd5c59a],[.03,0xa7b89d],[.32,0xb397b2]]){
      const roll=this._cylinder(g,.09,.66,color,.57,.67,z,.09,10);roll.rotation.z=.04;
      this._cylinder(g,.048,.024,0x6b6c72,.57,1.01,z,.048,9);
      this._box(g,.14,.28,.035,color,.59,.28,z+.07);
    }
    this._cylinder(g,.15,.20,0xa67e68,-.47,.22,.43,.17,10);
  }

  _seafoodKitchen(g) {
    // Publisher illustration: orange arched canvas, curved counter and a grill.
    this._box(g,1.36,.11,1.32,0x36436c,0,.035,0);
    this._box(g,1.26,.05,1.22,0xc6c7ad,0,.115,0);
    for(const x of [-.53,.53]){const drum=this._cylinder(g,.13,1.24,0x487b9a,x,-.05,0,.13,10);drum.rotation.x=Math.PI/2;}
    for(let i=0;i<5;i++)this._box(g,.205,.028,.68,i%2?0xb49364:0xc8a875,-.43+i*.215,.155,-.04);
    const positions=[],indices=[],front=[],back=[];
    for(let i=0;i<=12;i++){
      const theta=i*Math.PI/12,x=Math.cos(theta)*.68,y=1.01+Math.sin(theta)*.49;
      positions.push(x,y,-.61,x,y,.025);front.push([x,y,.025]);back.push([x,y,-.61]);
      if(i<12){const n=i*2;indices.push(n,n+1,n+2,n+1,n+3,n+2);}
    }
    const canopyGeometry=new THREE.BufferGeometry();canopyGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));canopyGeometry.setIndex(indices);canopyGeometry.computeVertexNormals();
    const canopy=this._mesh(g,canopyGeometry,this._mat(0xf2a942,{side:THREE.DoubleSide}));canopy.userData.ownGeometry=true;
    this._rope(g,front,0x394775,.025);this._rope(g,back,0x394775,.024);
    for(const x of [-.68,.68]){this._beam(g,[x,.15,-.59],[x,1.02,-.59],.044,0x9e865d);this._beam(g,[x,.15,.02],[x,1.02,.02],.044,0x9e865d);}
    this._beam(g,[0,1.51,-.62],[0,1.51,.025],.025,0xffd479);
    for(const [x,y,z]of [[-.44,1.39,-.28],[.25,1.47,-.34]]){const patch=this._box(g,.17,.015,.19,0xd68b3e,x,y,z);patch.rotation.z=x>0?-.35:.65;}
    const counter=(from,to,inner,outer,height,y,color)=>{
      const shape=new THREE.Shape(),steps=12;
      for(let i=0;i<=steps;i++){const a=from+(to-from)*i/steps,x=Math.sin(a)*outer,z=Math.cos(a)*outer;i?shape.lineTo(x,-z):shape.moveTo(x,-z);}
      for(let i=steps;i>=0;i--){const a=from+(to-from)*i/steps;shape.lineTo(Math.sin(a)*inner,-Math.cos(a)*inner);}shape.closePath();
      const geometry=new THREE.ExtrudeGeometry(shape,{depth:height,bevelEnabled:false,curveSegments:1});geometry.rotateX(-Math.PI/2);
      const mesh=this._mesh(g,geometry,this._mat(color),0,y,0);mesh.userData.ownGeometry=true;return mesh;
    };
    for(const [from,to]of [[-1.55,-.55],[-.12,1.55]]){
      counter(from,to,.46,.65,.40,.17,0xc7b28b);
      counter(from,to,.44,.68,.055,.57,0xe1e2cd);
      const edge=[];for(let i=0;i<=12;i++){const a=from+(to-from)*i/12;edge.push([Math.sin(a)*.68,.625,Math.cos(a)*.68]);}this._rope(g,edge,0x3b4d7a,.018);
      for(let i=1;i<5;i++){const a=from+(to-from)*i/5;this._beam(g,[Math.sin(a)*.654,.22,Math.cos(a)*.654],[Math.sin(a)*.654,.52,Math.cos(a)*.654],.012,0x9e8c6f);}
    }
    this._box(g,.99,.07,.27,0xc29a63,-.06,.73,-.42);
    for(const [x,color]of [[-.40,0x487e83],[-.08,0x638e7e]])this._barrel(g,x,.15,-.37,.14,color);
    this._cylinder(g,.12,.19,0xe2ddbd,-.38,.87,-.42,.12,12);
    this._cylinder(g,.125,.025,0x63738a,-.38,.98,-.42,.125,12);
    for(const [x,color]of [[-.10,0xa7bbb0],[.10,0xef934c]]){this._cylinder(g,.055,.15,color,x,.84,-.43,.055,10);this._cylinder(g,.046,.035,0x4c6079,x,.935,-.43,.046,10);}
    this._box(g,.34,.32,.38,0x38445f,.44,.48,-.20);
    this._box(g,.38,.06,.42,0xa16b4d,.44,.67,-.20);
    this._box(g,.28,.035,.31,0xd36d36,.44,.706,-.20);
    for(const z of [-.32,-.24,-.16,-.08])this._beam(g,[.28,.75,z],[.60,.75,z],.019,0x35465e);
    const fish=this._fish(g,.43,.79,-.18,.115,.2);fish.children[0].material=this._mat(0xcc9b5a);
    this._sphere(g,.043,0xffbf4e,.33,.74,-.21);this._sphere(g,.036,0xf18c38,.55,.76,-.14);
    const plate=this._cylinder(g,.13,.018,0xf0e5bb,.28,.65,.52,.13,12);plate.scale.z=.8;
    this._fish(g,.28,.686,.52,.083,-.3);
    this._barrel(g,-.51,.17,.24,.12,0x9ba46d);
    this._rope(g,[[.64,.13,.59],[.69,.22,.53],[.63,.24,.48],[.57,.17,.53],[.64,.13,.59]],0xceb67d,.021);
  }

  _broadcast(g) {
    this._box(g,1.31,.11,1.25,0x354a73,0,.035,0);
    this._box(g,1.20,.055,1.14,0xb8bea9,0,.115,0);
    for(const x of [-.53,.53]){const barrel=this._cylinder(g,.13,1.19,0x54889b,x,-.075,0,.13,10);barrel.rotation.x=Math.PI/2;}
    for(const x of [-.46,.46])for(const z of [-.35,.35])this._beam(g,[x,.15,z],[x*.43,1.66,z*.43],.067,0x657ca6);
    for(const z of [-.35,.35]){
      this._beam(g,[-.43,.23,z],[.31,1.07,z*.67],.038,0x435f90);
      this._beam(g,[.43,.23,z],[-.31,1.07,z*.67],.038,0x435f90);
      this._beam(g,[-.30,1.02,z*.67],[.20,1.64,z*.43],.033,0x7f94b9);
      this._beam(g,[.30,1.02,z*.67],[-.20,1.64,z*.43],.033,0x7f94b9);
    }
    this._box(g,.72,.085,.63,0xbdbb99,0,1.17,0);
    this._box(g,.69,.46,.035,0x3c537d,0,.55,.25);
    this._box(g,.56,.35,.055,0xc3a66d,0,.57,.285);
    this._box(g,.29,.18,.026,0x334b70,-.07,.62,.322);
    for(const x of [-.16,-.09,-.02])this._box(g,.025,.12,.032,0x7f9da6,x,.62,.342);
    this._cylinder(g,.039,.034,0xe9bd5f,.17,.63,.34,.039,9).rotation.x=Math.PI/2;
    this._sphere(g,.027,0xca7251,.17,.51,.34,8);
    for(const x of [-.13,.13])this._beam(g,[x,.14,.58],[x,1.20,.37],.034,0xc2ad77);
    for(let i=0;i<6;i++)this._beam(g,[-.13,.24+i*.16,.56-i*.032],[.13,.24+i*.16,.56-i*.032],.026,0xc2ad77);
    this._beam(g,[-.12,1.2,-.04],[-.12,2.24,-.04],.047,0x3e5d91);
    this._beam(g,[-.12,1.96,-.04],[.38,1.96,-.04],.026,0xb8ccd1);
    for(const x of [.02,.20,.38])this._beam(g,[x,1.83,-.17],[x,2.10,.09],.018,0xd7ddcc);
    this._beam(g,[-.12,2.15,-.04],[-.47,2.15,-.04],.024,0xb8ccd1);
    this._sphere(g,.048,0xe8bd65,-.12,2.27,-.04,8);
    const dish=new THREE.Group();dish.position.set(.25,1.60,-.04);dish.rotation.set(.80,0,-.42);g.add(dish);
    const points=Array.from({length:9},(_,i)=>new THREE.Vector2(i*.0375,(i*.0375)**2*.85));
    const geometry=new THREE.LatheGeometry(points,18),bowl=this._mesh(dish,geometry,this._mat(0xe0e6d5,{side:THREE.DoubleSide}));bowl.userData.ownGeometry=true;
    const rim=this._mesh(dish,this._geo('torus',[.30,.017,5,20]),this._mat(0x506893),0,.0765,0);rim.rotation.x=Math.PI/2;
    for(const angle of [0,Math.PI*2/3,Math.PI*4/3])this._beam(dish,[Math.sin(angle)*.27,.06,Math.cos(angle)*.27],[0,.27,0],.014,0x7488a7);
    this._sphere(dish,.043,0xc7a35f,0,.275,0,8);
    this._rope(g,[[-.11,1.83,-.06],[-.27,1.37,.02],[-.45,.96,.10],[-.33,.68,.24]],0x35485f,.018);
    this._box(g,.31,.23,.30,0x527c92,-.39,.26,-.30);
    this._box(g,.34,.036,.33,0xc5b882,-.39,.40,-.30);
    this._rope(g,[[-.58,.14,-.51],[-.63,.21,-.45],[-.57,.24,-.40],[-.52,.17,-.45],[-.58,.14,-.51]],0xd4bd86,.018);
  }

  _divingDock(g) {
    // A local diving-equipment interpretation, not an unverified exact dock skin.
    this._box(g,1.35,.12,1.31,0x394b73,0,.025,0);
    for(let i=0;i<6;i++)this._box(g,.204,.055,1.19,i%2?0xba9b68:0xcaaa73,-.51+i*.205,.12,0,true);
    for(const x of [-.53,.53]){const barrel=this._cylinder(g,.14,1.27,0x4d8c95,x,-.09,0,.14,10);barrel.rotation.x=Math.PI/2;}
    this._box(g,.34,.028,.38,0x599e9c,-.35,.167,.38).rotation.y=-.10;
    for(const x of [-.54,.54])for(const z of [-.51,.14]){
      this._beam(g,[x,.16,z],[x,1.22,z],.049,0xb59c6d);
      const knot=this._mesh(g,this._geo('torus',[.044,.012,4,8]),this._mat(0x405c79),x,1.20,z);knot.rotation.x=Math.PI/2;
    }
    const roofGeometry=new THREE.BufferGeometry();roofGeometry.setAttribute('position',new THREE.Float32BufferAttribute([-.64,1.24,-.61,.64,1.24,-.61,.64,1.18,.24,-.64,1.18,.24,0,1.35,-.19],3));roofGeometry.setIndex([0,4,1,1,4,2,2,4,3,3,4,0]);roofGeometry.computeVertexNormals();
    const roof=this._mesh(g,roofGeometry,this._mat(0x6f9d64,{side:THREE.DoubleSide}));roof.userData.ownGeometry=true;
    this._rope(g,[[-.64,1.24,-.61],[.64,1.24,-.61],[.64,1.18,.24],[-.64,1.18,.24],[-.64,1.24,-.61]],0x3d5c73,.019);
    const patch=this._box(g,.27,.018,.24,0x4b857f,.30,1.30,-.27);patch.rotation.y=.19;patch.rotation.z=-.11;
    for(const x of [-.38,-.15]){
      this._cylinder(g,.089,.43,0x5a9a93,x,.40,-.08,.089,12);
      this._sphere(g,.088,0x87b3a0,x,.62,-.08,10).scale.y=.58;
      this._cylinder(g,.031,.10,0x627a86,x,.70,-.08,.031,8);
      for(const y of [.28,.52])this._cylinder(g,.096,.035,0x3d5b78,x,y,-.08,.096,12);
      this._beam(g,[x-.06,.76,-.08],[x+.06,.76,-.08],.022,0xe1bf62);
    }
    this._box(g,.46,.08,.30,0xc2b381,-.27,.18,-.09);
    const gauge=this._cylinder(g,.096,.04,0xe4e7d4,-.27,.84,-.025,.096,12);gauge.rotation.x=Math.PI/2;
    const gaugeRim=this._mesh(g,this._geo('torus',[.097,.013,5,16]),this._mat(0x3c5b7a),-.27,.84,.001);
    this._beam(g,[-.27,.84,.018],[-.31,.88,.018],.013,0xc66f4d);
    this._rope(g,[[-.15,.70,-.08],[.01,.74,.03],[.10,.57,.18],[.06,.26,.38],[.24,.18,.47]],0x344f6c,.025);
    for(const x of [.17,.47]){
      this._rope(g,[[x,.41,.38],[x,.46,.60],[x,.27,.73],[x,-.40,.80]],0xd6bc7d,.031);
    }
    for(let i=0;i<5;i++)this._beam(g,[.17,.25-i*.14,.74+i*.013],[.47,.25-i*.14,.74+i*.013],.026,0xc5c8ac);
    const lifeRing=this._mesh(g,this._geo('torus',[.17,.05,7,20]),this._mat(0xe3ad52),-.54,.75,.10);lifeRing.rotation.y=-.22;
    for(const x of [.23,.43]){const fin=this._box(g,.13,.032,.35,0x4b708c,x,.20,-.32);fin.rotation.y=.16;this._box(g,.09,.055,.10,0xd6bd75,x,.235,-.45).rotation.y=.16;}
    this._box(g,.23,.20,.19,0xbba277,.43,.27,.28,true);
    this._rope(g,[[-.57,.17,.57],[-.62,.24,.51],[-.55,.27,.47],[-.50,.20,.52],[-.57,.17,.57]],0xd8c392,.020);
  }

  _hospital(g) {
    // Medical housing silhouette only; population and other effects stay in state.
    this._box(g,1.34,.11,1.28,0x3c5076,0,.035,0);
    this._box(g,1.24,.05,1.18,0xc9cbb4,0,.115,0);
    for(const x of [-.54,.54]){const barrel=this._cylinder(g,.13,1.18,0x5b8399,x,-.07,0,.13,10);barrel.rotation.x=Math.PI/2;}
    this._box(g,1.02,.94,.87,0xd6dccf,0,.63,-.07);
    this._box(g,1.07,.12,.92,0x637f9c,0,.25,-.07);
    for(const x of [-.51,.51])for(const z of [-.50,.36])this._box(g,.06,.99,.06,0x607e9b,x,.64,z);
    this._box(g,1.06,.055,.91,0x8098ab,0,.75,-.07);
    for(const x of [-.34,.34])for(const y of [.51,.92]){
      this._box(g,.22,.23,.036,0x486d92,x,y,.385);
      this._box(g,.17,.18,.042,0x9dc6c9,x,y,.409);
      this._box(g,.018,.18,.046,0xe2e3c7,x,y,.434);
    }
    for(const z of [-.30,.13])for(const y of [.51,.92]){
      this._box(g,.036,.23,.25,0x486d92,.535,y,z);
      this._box(g,.042,.18,.20,0x9dc6c9,.558,y,z);
      this._box(g,.046,.18,.018,0xe2e3c7,.583,y,z);
    }
    this._box(g,.25,.46,.055,0x637e8b,0,.46,.407);
    this._box(g,.17,.32,.025,0xaac3bd,0,.49,.445);
    this._sphere(g,.017,0xd4b978,.072,.41,.465,6);
    this._box(g,.47,.06,.29,0xb6bdae,0,.18,.52);
    this._box(g,.52,.055,.17,0xd4d3b9,0,.13,.67);
    const roofGeometry=new THREE.BufferGeometry();
    roofGeometry.setAttribute('position',new THREE.Float32BufferAttribute([-.65,1.17,-.63,0,1.46,-.63,0,1.46,.51,-.65,1.17,.51,0,1.46,-.63,.65,1.17,-.63,.65,1.17,.51,0,1.46,.51],3));
    roofGeometry.setIndex([0,1,2,0,2,3,4,5,6,4,6,7]);roofGeometry.computeVertexNormals();
    const roof=this._mesh(g,roofGeometry,this._mat(0x8da0ae,{side:THREE.DoubleSide}));roof.userData.ownGeometry=true;
    this._rope(g,[[-.65,1.17,.51],[0,1.46,.51],[.65,1.17,.51]],0x435e87,.025);
    this._beam(g,[0,1.47,-.64],[0,1.47,.52],.04,0xb9c5be);
    for(const x of [-.44,-.22,.22,.44])this._beam(g,[x,1.48-Math.abs(x)*.45,-.59],[x,1.48-Math.abs(x)*.45,.47],.015,0x71899e);
    this._box(g,.36,.29,.045,0xe9e8cf,0,1.085,.45);
    this._box(g,.075,.21,.025,0x559878,0,1.085,.483);
    this._box(g,.22,.075,.025,0x559878,0,1.085,.486);
    for(const x of [-.45,.45]){this._box(g,.19,.25,.22,0x8c9b7d,x,.25,.52);const leaf=this._sphere(g,.11,0x729769,x,.42,.52,7);leaf.scale.set(1,.7,1);}
  }

  _dailyFactory(g) {
    // Open L-shaped workshop adapted from the publisher's daily-goods illustration.
    this._box(g,1.34,.11,1.29,0x3b5074,0,.035,0);
    for(let i=0;i<6;i++)this._box(g,.204,.045,1.18,i%2?0xbba878:0xc9b98c,-.51+i*.205,.12,0,true);
    for(const x of [-.54,.54]){const barrel=this._cylinder(g,.14,1.20,0x4b86aa,x,-.08,0,.14,10);barrel.rotation.x=Math.PI/2;}
    this._box(g,1.16,.93,.055,0x6a91b1,0,.62,-.53);
    this._box(g,.055,.65,.77,0x6a91b1,-.57,.48,-.10);
    this._box(g,.96,.07,.31,0xbfa571,.04,.51,-.35,true);
    this._box(g,.96,.065,.31,0xbfa571,.04,.83,-.35,true);
    this._box(g,.30,.07,.63,0xbfa571,-.42,.52,.03,true);
    for(const [x,z]of [[-.58,-.57],[.58,-.57],[-.58,.38],[.58,-.22]])this._beam(g,[x,.15,z],[x,1.28,z],.055,0xc7ae7d);
    const backRoof=this._box(g,1.32,.055,.43,0xdec296,0,1.29,-.40);backRoof.rotation.x=.055;
    const sideRoof=this._box(g,.42,.055,.93,0xdec296,-.45,1.265,.14);sideRoof.rotation.z=-.045;
    this._rope(g,[[-.67,1.30,.62],[-.24,1.30,.62],[-.24,1.30,-.18],[.66,1.32,-.18]],0x4d6485,.019);
    const patch=this._box(g,.22,.015,.20,0xc5aa82,.30,1.329,-.43);patch.rotation.y=.2;
    this._box(g,.27,.23,.025,0xda9aaf,-.17,.91,-.487);
    const houseGeometry=new THREE.BufferGeometry();houseGeometry.setAttribute('position',new THREE.Float32BufferAttribute([-.35,1.025,-.468,-.17,1.19,-.468,.01,1.025,-.468],3));houseGeometry.computeVertexNormals();
    const houseRoof=this._mesh(g,houseGeometry,this._mat(0xda9aaf,{side:THREE.DoubleSide}));houseRoof.userData.ownGeometry=true;
    this._box(g,.075,.12,.032,0x6a91b1,-.17,.85,-.459);
    this._box(g,1.00,.33,.27,0xbda87b,.10,.34,.43,true);
    this._box(g,1.10,.055,.36,0x80aa94,.10,.54,.43);
    this._box(g,.30,.16,.028,0xd5a2ab,.09,.35,.578);
    this._box(g,.22,.16,.028,0xc7b984,.43,.35,.578);
    this._box(g,.22,.16,.028,0x7297ad,-.25,.35,.578);
    for(const [x,y,z,color]of [[-.30,.23,-.34,0xcbb893],[.05,.23,-.34,0xb8b69c],[.34,.23,-.34,0xcbb893],[.28,.66,-.35,0xb5c2af],[.42,.97,-.36,0xd1c6aa],[-.44,.25,.07,0xc7ba99]]){
      this._box(g,.22,.23,.22,color,x,y,z);
      this._box(g,.025,.23,.225,0xa49478,x,y,z);
    }
    for(const x of [-.37,-.14,.09]){
      this._beam(g,[x,1.25,-.17],[x,1.09,-.17],.014,0x53677e);
      this._cylinder(g,.061,.14,0xd8ded0,x,.99,-.16,.061,10);
      const handle=this._mesh(g,this._geo('torus',[.043,.012,5,10]),this._mat(0x748ca4),x+.072,1.005,-.16);handle.rotation.y=Math.PI/2;
    }
    const pan=this._cylinder(g,.11,.022,0xb9c8ca,-.43,.93,.16,.11,14);pan.rotation.x=Math.PI/2;
    this._beam(g,[-.43,1.02,.16],[-.43,1.20,.16],.027,0x8a765b);
    this._cylinder(g,.068,.11,0xe1dfc4,.08,.63,.42,.068,10);
    const mugHandle=this._mesh(g,this._geo('torus',[.042,.013,5,10]),this._mat(0xb1c4bd),.16,.64,.42);mugHandle.rotation.y=Math.PI/2;
    this._cylinder(g,.077,.17,0xe3debe,.39,.67,.42,.077,12);
    this._cylinder(g,.027,.018,0x827b65,.39,.765,.42,.027,8);
    this._box(g,.17,.22,.17,0xc5b58f,-.52,.24,.48,true);
    this._rope(g,[[.58,.14,.57],[.64,.21,.52],[.59,.25,.46],[.53,.18,.51],[.58,.14,.57]],0xd4bd86,.018);
  }

  _updateReady() {
    if(!this.buildingModels)return;
    const jobs=Array.isArray(this.state.production?.queue)?this.state.production.queue:[];
    this.runningFactories=new Set(jobs.filter(job=>job.status==='running'&&Number(job.remaining)>0).map(job=>String(job.buildingId)));
    const readyFactories=new Set(jobs.filter(job=>job.status==='ready').map(job=>String(job.buildingId)));
    for(const building of this.buildings) {
      const model=this.buildingModels.get(building.id);if(!model)continue;
      model.building=building;
      const amount=Number(building.stored ?? building.amount ?? building.output ?? 0);
      const ready=building.ready || building.productionReady || building.status==='ready' || amount>0 || readyFactories.has(String(building.id));
      model.icon.visible=Boolean(building.construction||ready)&&building.type!=='command';
    }
  }

  _sprite(kind,scale=.55) {
    if(!this.spriteMaterials)this.spriteMaterials=new Map();
    if(!this.spriteMaterials.has(kind)) {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
      const c=canvas.getContext('2d');
      c.shadowColor='rgba(28,65,61,.25)';c.shadowBlur=8;c.shadowOffsetY=5;
      c.fillStyle=kind==='plus'?'#f5ce64':kind==='build'?'#b6df83':'#fff2cf';
      c.beginPath();c.arc(64,61,48,0,Math.PI*2);c.fill();c.shadowColor='transparent';
      c.lineWidth=5;c.strokeStyle=kind==='plus'?'#fff4c3':'#fffdf0';c.stroke();
      if(kind==='water') {
        c.fillStyle='#4fa9c5';c.beginPath();c.moveTo(64,25);c.bezierCurveTo(54,42,39,57,39,72);c.bezierCurveTo(39,104,89,104,89,72);c.bezierCurveTo(89,56,75,40,64,25);c.fill();
        c.strokeStyle='#a7e6e8';c.lineWidth=5;c.beginPath();c.moveTo(49,68);c.quadraticCurveTo(44,82,58,86);c.stroke();
      } else if(kind==='fish') {
        c.fillStyle='#5e9c9a';c.beginPath();c.ellipse(65,64,29,17,-.2,0,Math.PI*2);c.fill();c.beginPath();c.moveTo(39,64);c.lineTo(23,49);c.lineTo(23,81);c.closePath();c.fill();
        c.fillStyle='#315b61';c.beginPath();c.arc(80,58,3.5,0,6.3);c.fill();
      } else if(kind==='build') {
        c.strokeStyle='#4d794e';c.lineWidth=10;c.lineCap='round';c.beginPath();c.moveTo(46,86);c.lineTo(77,44);c.stroke();
        c.save();c.translate(72,46);c.rotate(.60);c.fillStyle='#4d794e';c.fillRect(-23,-9,46,18);c.restore();
      } else {
        c.strokeStyle=kind==='plus'?'#9c6e2e':'#5c906c';c.lineWidth=9;c.lineCap='round';c.beginPath();
        if(kind==='plus'){c.moveTo(64,39);c.lineTo(64,85);c.moveTo(41,62);c.lineTo(87,62);}else{c.moveTo(42,65);c.lineTo(57,79);c.lineTo(87,46);}c.stroke();
      }
      const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;this.textures.add(texture);
      this.spriteMaterials.set(kind,new THREE.SpriteMaterial({map:texture,transparent:true,depthTest:false,depthWrite:false}));
    }
    const sprite=new THREE.Sprite(this.spriteMaterials.get(kind));sprite.scale.set(scale,scale,1);sprite.renderOrder=10;return sprite;
  }

  setMode(mode='normal',buildingType) {
    this.mode=mode;this.buildingType=buildingType;
    if(!this.renderer)return;
    this._makeTargets();this._rebuildPickables();
    this.renderer.domElement.style.cursor=mode==='normal'?'grab':'crosshair';
  }

  _makeTargets() {
    if(!this.targetGroup||!this.raft)return;
    this._clear(this.targetGroup);this.targetPickables=[];
    if(this.mode==='normal')return;
    const candidates=new Map();
    if(this.mode==='expand') for(const tile of this.raft) for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const x=tile.x+dx,z=tile.z+dz,k=keyOf(x,z);if(!this.tileSet.has(k))candidates.set(k,{x,z});
    }
    else for(const tile of this.raft)if(!this.occupied.has(keyOf(tile.x,tile.z)))candidates.set(keyOf(tile.x,tile.z),tile);
    const material=new THREE.MeshBasicMaterial({color:this.mode==='expand'?0xffd75f:0x9fda7f,transparent:true,opacity:.20,side:THREE.DoubleSide,depthWrite:false});
    for(const tile of candidates.values()) {
      const group=new THREE.Group();group.position.set(tile.x*TILE,this.mode==='expand'?-.06:.35,tile.z*TILE);this.targetGroup.add(group);
      const plate=this._mesh(group,new THREE.PlaneGeometry(1.4,1.4),material);plate.rotation.x=-Math.PI/2;plate.userData.ownGeometry=true;plate.userData.ownMaterial=true;plate.renderOrder=6;
      const lineGeometry=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-.7,0,-.7),new THREE.Vector3(.7,0,-.7),new THREE.Vector3(.7,0,.7),new THREE.Vector3(-.7,0,.7),new THREE.Vector3(-.7,0,-.7)]);
      const border=new THREE.Line(lineGeometry,new THREE.LineBasicMaterial({color:this.mode==='expand'?0xffe49a:0xc5f6a5,transparent:true,opacity:.85}));border.userData.ownGeometry=true;border.userData.ownMaterial=true;group.add(border);
      const plus=this._sprite(this.mode==='expand'?'plus':'build',.58);plus.position.y=.23;group.add(plus);
      const hit=this._box(group,1.47,.16,1.47,0xffffff,0,.04,0);hit.material=this._invisibleMaterial();hit.castShadow=false;hit.userData.action={type:'tile',x:tile.x,z:tile.z};
      plus.userData.action=hit.userData.action;this.targetPickables.push(hit,plus);
    }
  }

  _rebuildPickables() {
    this.pickables=[...(this.mode==='normal'?(this.buildingPickables||[]):[]),...(this.mode==='normal'?(this.tilePickables||[]):[]),...(this.targetPickables||[]),...this.debris.filter(d=>!d.collected).map(d=>d.hit)];
  }

  _makeResidents(count) {
    this._clear(this.peopleGroup);this.residents=[];
    for(let i=0;i<count;i++) {
      const group=new THREE.Group();this.peopleGroup.add(group);
      const skin=[0xe6ba88,0xdba778,0xc8936d][i%3];
      const leftLeg=this._box(group,.085,.14,.10,0x55788e,-.07,.15,0);const rightLeg=this._box(group,.085,.14,.10,0x55788e,.07,.15,0);
      const leftFoot=this._box(group,.095,.06,.14,0x4d4162,-.07,.055,.022),rightFoot=this._box(group,.095,.06,.14,0x4d4162,.07,.055,.022);
      this._box(group,.25,.24,.17,i%3===2?0xb34b44:0xd74f3f,0,.30,0);
      this._box(group,.038,.20,.022,0xf2dfba,-.075,.30,.095);this._box(group,.038,.20,.022,0xf2dfba,.075,.30,.095);
      this._box(group,.31,.065,.19,0xcc4d3e,0,.40,0);
      const leftArm=this._box(group,.075,.22,.085,skin,-.173,.30,0);leftArm.rotation.z=-.17;
      const rightArm=this._box(group,.075,.22,.085,skin,.173,.30,0);rightArm.rotation.z=.17;
      this._sphere(group,.203,skin,0,.60,0,14).scale.set(1,1.05,.94);
      const hair=this._sphere(group,.205,i%2?0x3b3343:0x403341,0,.69,-.024,11);hair.scale.set(1.02,.65,1);
      for(let k=0;k<5;k++){const tuft=this._mesh(group,this._geo('cone',[.061,.15,4]),this._mat(0x3d3342),(k-2)*.073,.79-Math.abs(k-2)*.016,.026);tuft.rotation.z=(k-2)*-.27;}
      this._sphere(group,.029,0xf8f0d3,-.063,.615,.169,8);this._sphere(group,.029,0xf8f0d3,.063,.615,.169,8);
      this._sphere(group,.016,0x34305b,-.063,.612,.192,6);this._sphere(group,.016,0x34305b,.063,.612,.192,6);
      this._sphere(group,.035,0xd79c75,0,.56,.184,6).scale.set(.7,.6,1);
      group.scale.setScalar(1.13);
      const tile=this.raft[(i*3+2)%this.raft.length]||{x:0,z:0};
      group.position.set(tile.x*TILE+.4,.29,tile.z*TILE+.38);
      const limbs=[leftLeg,rightLeg,leftArm,rightArm,leftFoot,rightFoot];this._batchStatic(group,limbs);this._comicHull(group,.013,limbs);
      const resident={group,leftLeg,rightLeg,leftArm,rightArm,leftFoot,rightFoot,target:new THREE.Vector3(group.position.x,.29,group.position.z),tile:{...tile},phase:i*1.7,wait:rand(0,3)};
      this.residents.push(resident);
    }
  }

  _nextResidentTarget(resident) {
    const {x,z}=resident.tile;
    const neighbors=[[x,z],[x+1,z],[x-1,z],[x,z+1],[x,z-1]].filter(([a,b])=>this.tileSet.has(keyOf(a,b)));
    const [nx,nz]=neighbors[Math.floor(Math.random()*neighbors.length)]||[x,z];resident.tile={x:nx,z:nz};
    // Workers use the wooden paths at the edge of each tile, leaving machinery clear.
    resident.target.set(nx*TILE+(Math.random()>.5?.46:-.46),.29,nz*TILE+.48);
    resident.wait=rand(.6,3.0);
  }

  _assignWorkers() {
    const signature=this.buildings.map(b=>`${b.id}:${b.workers||0}:${b.x}:${b.z}`).join('|')+'/'+this.residents.length+'/'+(this.fishingModeId||'')+'/'+[...(this.runningFactories||[])].sort().join(',');
    if(signature===this.workerSignature)return;this.workerSignature=signature;
    let index=0;
    for(const resident of this.residents){resident.workerId=null;resident.temporaryDuty=null;resident.workPosition=null;resident.workPath=[];}
    for(const building of this.buildings)for(let slot=0;slot<(building.workers||0)&&index<this.residents.length;slot++) {
      const resident=this.residents[index++];resident.workerId=building.id;resident.workerSlot=slot;
    }
    if(this.fishingModeId) {
      this.fishingResident=this.residents.find(r=>r.workerId===this.fishingModeId)||this.residents.find(r=>!r.workerId)||this.residents[0];
      if(this.fishingResident)this.fishingResident.temporaryDuty=this.fishingModeId;
    } else {this.fishingResident=null;for(const resident of this.residents)resident.temporaryDuty=null;}
    for(const id of this.runningFactories||[])if(!this.residents.some(resident=>String(resident.workerId)===id||String(resident.temporaryDuty)===id)){
      const idle=this.residents.find(resident=>!resident.workerId&&!resident.temporaryDuty);if(idle)idle.temporaryDuty=this.buildings.find(building=>String(building.id)===id)?.id;
    }
    for(const resident of this.residents) {
      const id=resident.temporaryDuty||resident.workerId,building=this.buildings.find(b=>b.id===id);
      if(!building){if(resident.tool)resident.tool.visible=false;continue;}
      const direction=building.type==='fishing'?this._fishingSpot(building).direction:{x:0,z:1};
      const side=resident.workerSlot%2?-.25:.25;
      resident.workPosition=new THREE.Vector3(building.x*TILE+direction.x*.43+direction.z*side,.29,building.z*TILE+direction.z*.43-direction.x*side);
      if(building.type==='fishing'){const site=this.buildingModels.get(building.id)?.group.position||{x:building.x*TILE,z:building.z*TILE};resident.workPosition.set(site.x-.23-(resident.workerSlot||0)*.30,.29,site.z+.52);}
      else if(building.type==='materials')resident.workPosition.set(building.x*TILE-.22,.29,building.z*TILE+.57);
      else if(building.type==='construction')resident.workPosition.set(building.x*TILE-.08,.29,building.z*TILE+.53);
      else if(building.type==='tailor')resident.workPosition.set(building.x*TILE-.10,.29,building.z*TILE+.54);
      else if(building.type==='seafoodKitchen')resident.workPosition.set(building.x*TILE+.06,.29,building.z*TILE+.12);
      resident.workFacing=Math.atan2(direction.x,direction.z);
      if(building.type!=='fishing')resident.workFacing=Math.PI;
      const path=this._tilePath(resident.tile,{x:building.x,z:building.z});
      resident.workPath=path.map(tile=>new THREE.Vector3(tile.x*TILE+.46,.29,tile.z*TILE+.48));resident.workPath.push(resident.workPosition);
      resident.target.copy(resident.workPath[0]);resident.wait=0;
      this._residentTool(resident,building.type);
    }
  }

  _tilePath(from,to) {
    if(!from||!this.tileSet.has(keyOf(from.x,from.z)))return [];
    const queue=[from],parents=new Map([[keyOf(from.x,from.z),null]]);let cursor=0;
    while(cursor<queue.length) {
      const tile=queue[cursor++];if(tile.x===to.x&&tile.z===to.z)break;
      for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1]]){const next={x:tile.x+dx,z:tile.z+dz},key=keyOf(next.x,next.z);if(this.tileSet.has(key)&&!parents.has(key)){parents.set(key,tile);queue.push(next);}}
    }
    if(!parents.has(keyOf(to.x,to.z)))return [];
    const route=[];let tile=to;
    while(tile){route.push(tile);tile=parents.get(keyOf(tile.x,tile.z));}return route.reverse().slice(1);
  }

  _residentTool(resident,type) {
    if(resident.tool){resident.rightArm.remove(resident.tool);this._disposeOwn(resident.tool);resident.tool=null;}
    if(!['slicer','purifier','farm','scavenger','kitchen','materials','construction','tailor','seafoodKitchen'].includes(type))return;
    const tool=new THREE.Group();tool.position.set(0,-.15,.02);resident.rightArm.add(tool);resident.tool=tool;
    if(type==='slicer'||type==='kitchen'||type==='seafoodKitchen') {
      this._box(tool,.025,.12,.035,0x6e5038,0,-.04,0);this._box(tool,.12,.13,.022,0xc4d4c8,.045,-.15,0);
    } else if(type==='farm'||type==='purifier'||type==='materials') {
      this._cylinder(tool,.065,.10,0x69a7a2,0,-.04,.03,.06,8);this._beam(tool,[0,-.03,.06],[0,-.02,.16],.025,0x97c5b6);
    } else if(type==='tailor'){this._box(tool,.14,.035,.17,0xbbaac2,0,-.12,.025);}
    else {this._box(tool,.03,.19,.035,0x907044,0,-.05,0);this._box(tool,.17,.055,.07,0x6d8580,0,-.16,0);}
  }

  _moveResident(resident,target,dt,t,speed=.73) {
    resident.leftLeg.position.set(-.07,.15,0);resident.rightLeg.position.set(.07,.15,0);
    resident.leftFoot.position.set(-.07,.055,.022);resident.rightFoot.position.set(.07,.055,.022);
    const dx=target.x-resident.group.position.x,dz=target.z-resident.group.position.z,distance=Math.hypot(dx,dz);
    if(distance<.045){resident.leftLeg.rotation.x=0;resident.rightLeg.rotation.x=0;return true;}
    const step=Math.min(distance,dt*speed);resident.group.position.x+=dx/distance*step;resident.group.position.z+=dz/distance*step;
    resident.group.rotation.y=Math.atan2(dx,dz);resident.group.rotation.x=0;resident.group.rotation.z=0;
    resident.leftLeg.rotation.x=Math.sin(t*10+resident.phase)*.38;resident.rightLeg.rotation.x=-resident.leftLeg.rotation.x;
    resident.leftArm.rotation.x=-resident.leftLeg.rotation.x*.5;resident.rightArm.rotation.x=resident.leftLeg.rotation.x*.5;
    resident.group.position.y=.29+Math.abs(Math.sin(t*10+resident.phase))*.022;
    resident.tile={x:Math.round(resident.group.position.x/TILE),z:Math.round(resident.group.position.z/TILE)};return false;
  }

  _workResident(resident,building,t) {
    resident.group.rotation.y=resident.workFacing;resident.group.position.y=.29;resident.group.rotation.z=0;
    const swing=Math.sin(t*5+resident.phase);
    if(building.type==='fishing'){
      resident.leftArm.rotation.x=-.82+swing*.07;resident.rightArm.rotation.x=-1.0+swing*.10;resident.group.rotation.x=-.035;
      if(!(resident.workerSlot>0)){resident.group.position.y=.60;resident.leftLeg.rotation.x=resident.rightLeg.rotation.x=-1.15;resident.leftLeg.position.set(-.07,.17,.09);resident.rightLeg.position.set(.07,.17,.09);resident.leftFoot.position.set(-.07,.095,.18);resident.rightFoot.position.set(.07,.095,.18);}
    }
    else if(building.type==='slicer'||building.type==='kitchen'){resident.rightArm.rotation.x=-.75+swing*.62;resident.leftArm.rotation.x=-.58;resident.group.rotation.x=.08;}
    else if(building.type==='farm'){resident.rightArm.rotation.x=-.9+Math.sin(t*2)*.22;resident.leftArm.rotation.x=-.1;resident.group.rotation.x=.12;}
    else if(['materials','construction','tailor','seafoodKitchen'].includes(building.type)){
      const working=this.runningFactories?.has(String(building.id));
      resident.rightArm.rotation.x=working?(building.type==='construction'?-.7+swing*.58:-.66+swing*.16):-.22;
      resident.leftArm.rotation.x=working?-.58:-.16;resident.group.rotation.x=working?.06:0;
    }
    else {resident.rightArm.rotation.x=-.6+swing*.25;resident.leftArm.rotation.x=-.4-swing*.14;resident.group.rotation.x=.04;}
  }

  _makeFishSchool() {
    this.fishSchool=new THREE.Group();this.fishSchool.visible=false;this.scene.add(this.fishSchool);this.schoolFish=[];
    const shape=new THREE.Shape();shape.moveTo(.31,0);shape.quadraticCurveTo(.08,.15,-.20,.07);shape.lineTo(-.37,.15);shape.lineTo(-.31,0);shape.lineTo(-.37,-.15);shape.lineTo(-.20,-.07);shape.quadraticCurveTo(.08,-.15,.31,0);
    const geometry=new THREE.ShapeGeometry(shape,6);
    const material=new THREE.MeshBasicMaterial({color:0x14596f,transparent:true,opacity:.35,side:THREE.DoubleSide,depthWrite:false});
    for(let i=0;i<7;i++) {
      const fish=new THREE.Mesh(geometry,material);fish.rotation.x=-Math.PI/2;fish.renderOrder=5;fish.scale.setScalar(i%3===0?1.1:.72);this.fishSchool.add(fish);
      this.schoolFish.push({mesh:fish,phase:i*.94,range:.45+i*.13});
    }
  }

  _fishingSpot(building) {
    // Front-left water keeps the yellow shelter in the upper right of fishing view.
    const direction={x:-.51,z:.86};let distance=.8;
    while(distance<14&&this.tileSet.has(keyOf(Math.round(building.x+direction.x*distance/TILE),Math.round(building.z+direction.z*distance/TILE))))distance+=.3;
    distance+=.8;
    return {x:building.x*TILE+direction.x*distance,y:-.15,z:building.z*TILE+direction.z*distance,direction};
  }

  _updateFishingTargets() {
    if(!this.buildingModels)return;
    for(const model of this.buildingModels.values())if(model.rig) {
      model.rig.target=this._fishingSpot(model.building);
      const d=model.rig.target.direction;
      model.rig.pivot.position.set(-.23+d.x*.30,.60,.52+d.z*.30);model.rig.pivot.rotation.y=Math.atan2(d.x,d.z);
    }
    const model=this.buildingModels.get(this.fishingModeId);
    if(model?.rig){const target=model.rig.target;this.fishSchool.position.set(target.x,-.14,target.z);}
  }

  setFishingMode(id) {
    if(!this.renderer)return;
    if(!id) {
      this.fishingModeId=null;this.fishSchool.visible=false;this._finishCast();this.workerSignature='';this._assignWorkers();this.focus();return;
    }
    const model=this.buildingModels.get(id);if(!model?.rig)return;
    this.fishingModeId=id;this._updateFishingTargets();this.fishSchool.visible=true;
    const target=model.rig.target;
    this.targetPan.set(THREE.MathUtils.lerp(model.group.position.x,target.x,.56),-.25,THREE.MathUtils.lerp(model.group.position.z,target.z,.56));
    this.zoomTarget=1.43;this.workerSignature='';this._assignWorkers();
  }

  _makeSwimmer() {
    const group=new THREE.Group();this.scene.add(group);group.visible=false;
    const body=this._sphere(group,.18,0xde8a38,0,.07,0);body.scale.set(1,.50,1.3);
    this._sphere(group,.15,0xe6b381,0,.26,.07);
    const hair=this._sphere(group,.155,0x694a33,0,.32,.04);hair.scale.set(1,.55,1);
    this._sphere(group,.02,0x344b48,-.052,.27,.205,6);this._sphere(group,.02,0x344b48,.052,.27,.205,6);
    const leftArm=this._box(group,.075,.08,.28,0xe2ad7b,-.21,.09,.05),rightArm=this._box(group,.075,.08,.28,0xe2ad7b,.21,.09,.05);
    leftArm.rotation.y=-.45;rightArm.rotation.y=.45;
    const legs=this._box(group,.20,.055,.24,0x3f7880,0,.01,-.21);
    group.traverse(mesh=>{mesh.castShadow=false;});this.swimmer={group,leftArm,rightArm,legs};return this.swimmer;
  }

  _beginSalvage(entry) {
    const source=entry.group.position.clone();let nearest=this.raft[0],best=Infinity;
    for(const tile of this.raft){const distance=Math.hypot(source.x-tile.x*TILE,source.z-tile.z*TILE);if(distance<best){best=distance;nearest=tile;}}
    const direction=new THREE.Vector3(source.x-nearest.x*TILE,0,source.z-nearest.z*TILE).normalize();
    const start=new THREE.Vector3(nearest.x*TILE+direction.x*.86,-.19,nearest.z*TILE+direction.z*.86);
    const job={entry,source,start,started:null,duration:clamp(1.1+best*.18,1.4,2.2),trailAt:0};
    entry.collectEffect=job;this.salvageJobs.push(job);
    if(!this.swimmer)this._makeSwimmer();
  }

  _updateSalvages(t) {
    const job=this.salvageJobs[0];if(!job){if(this.swimmer)this.swimmer.group.visible=false;return;}
    const swimmer=this.swimmer;swimmer.group.visible=true;
    if(job.started===null){job.started=t;job.trailAt=t;}
    const progress=clamp((t-job.started)/job.duration,0,1),outbound=progress<.62;
    const journey=outbound?progress/.62:1-(progress-.62)/.38;
    const eased=THREE.MathUtils.smoothstep(journey,0,1);
    swimmer.group.position.lerpVectors(job.start,job.source,eased);swimmer.group.position.y=-.20+Math.sin(t*10)*.017;
    const dx=job.source.x-job.start.x,dz=job.source.z-job.start.z;swimmer.group.rotation.y=Math.atan2(dx,dz)+(outbound?0:Math.PI);
    swimmer.leftArm.rotation.x=Math.sin(t*12)*.7;swimmer.rightArm.rotation.x=-Math.sin(t*12)*.7;swimmer.legs.rotation.y=Math.sin(t*12)*.1;
    if(t-job.trailAt>.17){this._splash(swimmer.group.position,.55);job.trailAt=t;}
    if(progress>.60&&!job.splashed){job.splashed=true;this._splash(job.source);}
    if(progress>.62){job.entry.group.position.copy(swimmer.group.position);job.entry.group.position.y=.02;job.entry.group.scale.setScalar(progress>.88?Math.max(.001,(1-progress)/.12):.78);}
    else {job.entry.group.position.copy(job.source);job.entry.group.position.y=-.1+Math.sin(t*2)*.025;}
    if(progress>=1) {
      this.scene.remove(job.entry.group);this._disposeOwn(job.entry.group);const index=this.debris.indexOf(job.entry);if(index>=0)this.debris.splice(index,1);
      this.salvageJobs.shift();this._rebuildPickables();
    }
  }

  _finishCast() {
    if(this.cast?.fish){this.scene.remove(this.cast.fish);this._disposeOwn(this.cast.fish);}this.cast=null;
  }

  _updateFishing(t) {
    if(this.fishingModeId)for(const fish of this.schoolFish) {
      const phase=t*.32+fish.phase;fish.mesh.position.set(Math.cos(phase)*fish.range,Math.sin(t*.7+fish.phase)*.006,Math.sin(phase*1.12)*fish.range*.62);
      fish.mesh.rotation.z=-phase-Math.PI/2;fish.mesh.scale.y=(fish.mesh.scale.x)*(1+Math.sin(t*5+fish.phase)*.06);
    }
    for(const [id,model]of this.buildingModels) {
      const rig=model.rig;if(!rig?.target)continue;
      const cast=this.cast?.id===id?this.cast:null,p=cast?clamp((t-cast.started)/1.85,0,1):1;
      rig.pivot.rotation.x=cast?p<.16?-.7*Math.sin(p/.16*Math.PI/2):-.7*(1-clamp((p-.16)/.22,0,1)):Math.sin(t*.8)*.018;
      rig.pivot.updateWorldMatrix(true,false);
      const tip=rig.pivot.localToWorld(new THREE.Vector3(0,.85,.69));
      const end=new THREE.Vector3(rig.target.x,rig.target.y+Math.sin(t*2)*.018,rig.target.z);
      if(cast&&p<.44) {
        const fly=clamp((p-.12)/.32,0,1);end.lerpVectors(tip,new THREE.Vector3(rig.target.x,rig.target.y,rig.target.z),fly);end.y+=Math.sin(fly*Math.PI)*1.1;
      }
      if(cast&&p>=.44&&!cast.landed){cast.landed=true;this._splash(end);}
      if(cast&&p>.65&&p<.95) {
        if(!cast.fish){cast.fish=this._fish(this.scene,end.x,-.18,end.z,.25,-.7);cast.fish.traverse(mesh=>{mesh.castShadow=false;});}
        const jump=(p-.65)/.30;cast.fish.position.set(end.x+Math.sin(jump*Math.PI)*.24,-.17+Math.sin(jump*Math.PI)*.83,end.z-jump*.25);cast.fish.rotation.z=-.3+jump*1.6;
      }
      if(cast&&p>=.95&&!cast.caught){cast.caught=true;if(cast.fish)cast.fish.visible=false;this._splash(end);}
      const localTip=rig.group.worldToLocal(tip.clone()),localEnd=rig.group.worldToLocal(end.clone());rig.bobber.position.copy(localEnd);
      const positions=rig.line.geometry.attributes.position;
      for(let i=0;i<19;i++){const f=i/18;positions.setXYZ(i,THREE.MathUtils.lerp(localTip.x,localEnd.x,f),THREE.MathUtils.lerp(localTip.y,localEnd.y,f)-Math.sin(f*Math.PI)*.16,THREE.MathUtils.lerp(localTip.z,localEnd.z,f));}positions.needsUpdate=true;
      rig.ring.scale.setScalar(1+Math.sin(t*2)*.14);rig.bobber.scale.setScalar(this.fishingModeId===id?1.13:1);
      if(cast&&p>=1)this._finishCast();
    }
  }

  _spawnDebris(seed) {
    if(this.debris.length>=17||!this.renderer)return;
    const kind=['wood','wood','scrap','crate'][Math.floor(Math.random()*4)];
    const group=new THREE.Group();this.scene.add(group);
    const angle=(seed!==undefined?seed/13:Math.random())*Math.PI*2;
    const radius=rand(4.3,6.9);
    group.position.set(Math.sin(angle)*radius,-.11,Math.cos(angle)*radius*.83);
    group.rotation.y=rand(-Math.PI,Math.PI);
    const phase=rand(0,6.28);
    if(kind==='wood') {
      for(let i=0;i<3;i++){const plank=this._box(group,.18,.085,.69,0xc49a61,(i-1)*.18,.02+(i%2)*.035,0,true);plank.rotation.y=(i-1)*.06;}
      for(const z of [-.22,.22])this._box(group,.58,.028,.055,0x846b48,0,.1,z,true);
    } else if(kind==='scrap') {
      const barrel=this._cylinder(group,.23,.57,0x577f7e,0,.10,0,.23,10);barrel.rotation.z=1.17;
      for(const x of [-.18,.18]){const ring=this._mesh(group,this._geo('torus',[.234,.018,4,12]),this._mat(0x8b9c86),x,.10,0);ring.rotation.y=Math.PI/2;ring.rotation.z=-.40;}
      const patch=this._box(group,.18,.02,.23,0xbc7c53,.03,.32,.02);patch.rotation.z=.25;
    } else {
      this._box(group,.52,.48,.48,0xb28a54,0,.13,0,true);
      this._box(group,.56,.055,.52,0xd6ae73,0,.4,0,true);
      for(const x of [-.2,.2])this._box(group,.06,.5,.035,0x715f43,x,.15,.255,true);
      this._box(group,.55,.06,.035,0xe3c18b,0,.15,.26,true);
      const label=this._box(group,.19,.19,.018,0xe8dca8,0,.16,.278);label.rotation.z=.08;
      this._box(group,.1,.07,.024,0x74957a,0,.16,.29);
    }
    const shadow=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({map:this.contactTexture,transparent:true,depthWrite:false,opacity:.75}));
    shadow.rotation.x=-Math.PI/2;shadow.position.y=-.055;shadow.userData.ownGeometry=true;shadow.userData.ownMaterial=true;group.add(shadow);
    const hit=this._box(group,.82,.78,.82,0xffffff,0,.20,0);hit.material=this._invisibleMaterial();hit.castShadow=false;
    const entry={group,hit,kind,phase,baseX:group.position.x,baseZ:group.position.z,age:0,drift:rand(-.03,.03),collected:false};
    hit.userData.action={type:'debris',entry};this.debris.push(entry);this._rebuildPickables();
  }

  _bindEvents() {
    const canvas=this.renderer.domElement;
    this.onPointerDown=e=>{
      if(e.button!==undefined&&e.button!==0)return;
      this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      canvas.setPointerCapture?.(e.pointerId);
      if(this.pointers.size===1){this.pointerStart={x:e.clientX,y:e.clientY,time:performance.now()};this.dragLast={x:e.clientX,y:e.clientY};this.dragged=false;this.pinched=false;}
      if(this.pointers.size===2){const p=[...this.pointers.values()];this.pinchDistance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);this.pinched=true;this.dragged=true;}
      canvas.style.cursor='grabbing';
    };
    this.onPointerMove=e=>{
      if(!this.pointers.has(e.pointerId))return;
      this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(this.pointers.size>=2){
        const p=[...this.pointers.values()];const distance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);
        if(this.pinchDistance>0)this.zoomTarget=clamp(this.zoomTarget*distance/this.pinchDistance,.62,1.9);
        this.pinchDistance=distance;return;
      }
      if(!this.dragLast)return;
      const dx=e.clientX-this.dragLast.x,dy=e.clientY-this.dragLast.y;
      if(Math.hypot(e.clientX-this.pointerStart.x,e.clientY-this.pointerStart.y)>7)this.dragged=true;
      if(this.dragged&&!this.pinched){
        const a=this._groundPoint(this.dragLast.x,this.dragLast.y),b=this._groundPoint(e.clientX,e.clientY);
        if(a&&b){this.targetPan.add(a.sub(b));this.targetPan.x=clamp(this.targetPan.x,-9,9);this.targetPan.z=clamp(this.targetPan.z,-9,9);this.pan.copy(this.targetPan);this._updateCamera();}
      }
      this.dragLast={x:e.clientX,y:e.clientY};
    };
    this.onPointerUp=e=>{
      if(!this.pointers.has(e.pointerId))return;
      this.pointers.delete(e.pointerId);
      if(!this.dragged&&!this.pinched&&this.pointerStart&&performance.now()-this.pointerStart.time<700)this._click(e.clientX,e.clientY);
      if(this.pointers.size===0){this.dragLast=null;this.pointerStart=null;canvas.style.cursor=this.mode==='normal'?'grab':'crosshair';}
    };
    this.onPointerCancel=e=>{this.pointers.delete(e.pointerId);this.dragged=true;this.dragLast=null;};
    this.onWheel=e=>{e.preventDefault();this.zoom(-e.deltaY*.0012);};
    this.onContextLost=e=>{e.preventDefault();this.contextLost=true;};
    this.onContextRestored=()=>{this.contextLost=false;};
    canvas.addEventListener('pointerdown',this.onPointerDown);
    canvas.addEventListener('pointermove',this.onPointerMove);
    canvas.addEventListener('pointerup',this.onPointerUp);
    canvas.addEventListener('pointercancel',this.onPointerCancel);
    canvas.addEventListener('wheel',this.onWheel,{passive:false});
    canvas.addEventListener('webglcontextlost',this.onContextLost);
    canvas.addEventListener('webglcontextrestored',this.onContextRestored);
    canvas.style.cursor='grab';
  }

  _groundPoint(clientX,clientY) {
    const rect=this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((clientX-rect.left)/rect.width*2-1,-((clientY-rect.top)/rect.height)*2+1);
    this.raycaster.setFromCamera(this.pointer,this.camera);
    return this.raycaster.ray.intersectPlane(this.ground,new THREE.Vector3());
  }

  _click(clientX,clientY) {
    if(this.fishingModeId){const point=this._groundPoint(clientX,clientY);if(point)this._splash(point,.7);return;}
    const rect=this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((clientX-rect.left)/rect.width*2-1,-((clientY-rect.top)/rect.height)*2+1);
    this.raycaster.setFromCamera(this.pointer,this.camera);
    const hits=this.raycaster.intersectObjects(this.pickables,false).filter(hit=>hit.object.visible);
    if(!hits.length)return;
    // Sprites are camera-facing and intentionally forgiving to tap, but only visible actions participate.
    const hit=hits[0];const action=hit.object.userData.action;if(!action)return;
    if(action.type==='debris') {
      const entry=action.entry;if(entry.collected)return;entry.collected=true;entry.collectTime=this.elapsed;
      const position=entry.group.position.clone(),projected=position.clone().project(this.camera);
      const origin={x:position.x,y:position.y,z:position.z,screenX:rect.left+(projected.x+1)*rect.width/2,screenY:rect.top+(1-projected.y)*rect.height/2};
      this._beginSalvage(entry);this._rebuildPickables();this.callbacks.onCollect?.(entry.kind,origin);this._splash(entry.group.position);
      if(navigator.vibrate)navigator.vibrate(12);
    } else if(action.type==='building') {
      this._selectBuilding(action.id);this.callbacks.onBuilding?.(action.id);
    } else if(action.type==='tile') this.callbacks.onTile?.(action.x,action.z);
  }

  _selectBuilding(id) {
    if(this.selection)this.selection.parent?.remove(this.selection);
    if(!this.selection){this.selection=new THREE.Mesh(new THREE.RingGeometry(.65,.70,40),new THREE.MeshBasicMaterial({color:0xffe494,transparent:true,opacity:.9,side:THREE.DoubleSide,depthTest:true}));this.selection.rotation.x=-Math.PI/2;}
    const model=this.buildingModels.get(id);if(!model)return;
    model.group.add(this.selection);this.selection.position.set(0,.025,0);this.selectionUntil=this.elapsed+2;
  }

  _splash(position,scale=1) {
    const mesh=new THREE.Mesh(new THREE.RingGeometry(.20,.24,24),new THREE.MeshBasicMaterial({color:0xe5f9d9,transparent:true,opacity:.8,side:THREE.DoubleSide,depthWrite:false}));
    mesh.rotation.x=-Math.PI/2;mesh.position.set(position.x,-.08,position.z);mesh.renderOrder=5;this.scene.add(mesh);
    mesh.scale.setScalar(scale);this.ripples.push({mesh,born:this.elapsed,temporary:true,scale});
  }

  setPaused(paused) { this.paused=Boolean(paused);this.lastTime=performance.now(); }
  focus() { this.targetPan.set(0,-.2,0);this.zoomTarget=1; }
  zoom(delta) { this.zoomTarget=clamp(this.zoomTarget*Math.exp(delta),.62,1.9); }

  getGuideAnchor(kind) {
    if(!this.renderer||this.disposed)return null;
    const canvas=this.renderer.domElement,rect=canvas.getBoundingClientRect(),touchRadius=24;
    // Chrome may adjust a touch on the canvas to a nearby DOM button. Keep a
    // finger-sized area clear, including HUD panels which visually cover water.
    const blockers=[],hudSelector='.hud,.resources,.weather,.quick-tools,.camera-tools,.bottom-hud,.mode-banner,.resident-demand,.building-actions';
    for(const element of document.querySelectorAll(`button,a[href],input,select,textarea,[role="button"],${hudSelector}`)) {
      if(element.closest('[hidden]'))continue;
      const style=getComputedStyle(element);
      // Closing the opening dialogue can expose HUD on the next frame. Its
      // layout is already present, so reserve that space during the transition.
      if(style.display==='none'||(style.visibility!=='visible'&&!element.matches(hudSelector)))continue;
      const box=element.getBoundingClientRect();
      if(box.width>0&&box.height>0)blockers.push(box);
    }
    const safe=(x,y)=>{
      if(blockers.some(box=>x>box.left-touchRadius&&x<box.right+touchRadius&&y>box.top-touchRadius&&y<box.bottom+touchRadius))return false;
      for(const [dx,dy]of [[0,0],[-24,0],[24,0],[0,-24],[0,24],[-17,-17],[17,-17],[-17,17],[17,17]])if(document.elementFromPoint(x+dx,y+dy)!==canvas)return false;
      return true;
    };
    this.scene.updateMatrixWorld(true);this.camera.updateMatrixWorld();
    const project=(position,expected,offsetX=0,offsetY=0)=>{
      const p=position.clone().project(this.camera);p.x+=offsetX*2/rect.width;p.y-=offsetY*2/rect.height;
      const screenX=rect.left+(p.x+1)*rect.width/2,screenY=rect.top+(1-p.y)*rect.height/2;
      // Reserve the header, then use actual HUD bounds instead of fixed bottom
      // padding: the old 145/170 padding left only 75px in a landscape viewport.
      if(screenX<rect.left+28||screenX>rect.right-28||screenY<rect.top+92||screenY>rect.bottom-28||!safe(screenX,screenY))return null;
      if(expected){this.pointer.set(p.x,p.y);this.raycaster.setFromCamera(this.pointer,this.camera);const action=this.raycaster.intersectObjects(this.pickables,false).filter(hit=>hit.object.visible)[0]?.object.userData.action;if(!expected(action))return null;}
      return {screenX,screenY};
    };
    if(kind==='salvage') {
      const candidates=this.debris.filter(d=>!d.collected).sort((a,b)=>(a.kind==='wood'?0:1)-(b.kind==='wood'?0:1)||a.group.position.lengthSq()-b.group.position.lengthSq());
      // A visible part of a crate can be safely beside HUD even when its center
      // is too close. Every alternate point must still raycast to that same item.
      for(const [dx,dy]of [[0,0],[-12,0],[12,0],[0,-12],[0,12],[-12,-12],[12,-12],[-12,12],[12,12]])for(const entry of candidates){const anchor=project(entry.hit.getWorldPosition(new THREE.Vector3()),action=>action?.type==='debris'&&action.entry===entry,dx,dy);if(anchor)return anchor;}return null;
    }
    if(kind==='resident') {
      const residents=[...this.residents].sort((a,b)=>a.group.position.lengthSq()-b.group.position.lengthSq());
      for(const resident of residents){const point=resident.group.getWorldPosition(new THREE.Vector3());point.y+=.70;const anchor=project(point);if(anchor)return anchor;}return null;
    }
    if(kind==='build'||kind==='expand') {
      if(kind==='expand'&&this.mode!=='expand')return null;
      const targets=(this.targetPickables?.length?this.targetPickables:this.tilePickables).filter(mesh=>mesh.isMesh&&mesh.userData.action?.type==='tile'&&(kind==='expand'||!this.occupied.has(keyOf(mesh.userData.action.x,mesh.userData.action.z))));
      for(const target of targets){const action=target.userData.action,anchor=project(target.getWorldPosition(new THREE.Vector3()),hit=>hit?.type==='tile'&&hit.x===action.x&&hit.z===action.z);if(anchor)return anchor;}return null;
    }
    const id=kind==='fishing'?this.buildings.find(b=>b.type==='fishing')?.id:kind,model=this.buildingModels.get(id);
    if(!model)return null;
    for(const height of [1.39,1.1,.8,.42])for(const [x,z]of [[0,0],[.32,.20],[-.32,.20]]) {
      const point=model.group.localToWorld(new THREE.Vector3(x,height,z)),anchor=project(point,action=>action?.type==='building'&&action.id===id);if(anchor)return anchor;
    }
    return null;
  }

  focusBuilding(id) {
    const model=this.buildingModels?.get(id);
    if(!model)return;
    this.targetPan.set(model.group.position.x,.05,model.group.position.z);
    this.zoomTarget=1.5;this._selectBuilding(id);
  }

  animateCast() {
    const fishing=this.buildings?.find(b=>b.id===this.fishingModeId)||this.buildings?.find(b=>b.type==='fishing');
    if(!fishing)return;this._finishCast();
    this.cast={id:fishing.id,started:this.elapsed,actor:this.fishingResident||this.residents.find(r=>r.workerId===fishing.id)||this.residents[0]};
  }

  playStorm() {
    if(!this.renderer)return;
    this.stormStarted=this.elapsed;this.stormUntil=this.elapsed+7;
    if(!this.rain) {
      const positions=new Float32Array(100*6);
      this.rainSeeds=Array.from({length:100},()=>({x:rand(-12,12),z:rand(-10,10),height:rand(0,10)}));
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
      const material=new THREE.LineBasicMaterial({color:0xe0f5e9,transparent:true,opacity:.4,depthWrite:false});
      this.rain=new THREE.LineSegments(geometry,material);this.rain.frustumCulled=false;this.scene.add(this.rain);
    }
    this.rain.visible=true;
  }

  _resize() {
    if(!this.renderer||this.disposed)return;
    const width=Math.max(1,this.container.clientWidth),height=Math.max(1,this.container.clientHeight);
    this.width=width;this.height=height;this.renderer.setSize(width,height,false);
    const aspect=width/height;
    const viewWidth=aspect<.8?10.25:aspect<1.2?12:14.2;
    this.baseWidth=viewWidth;this.baseHeight=viewWidth/aspect;this._updateCamera();
  }

  _updateCamera() {
    if(!this.baseWidth)return;
    this.camera.left=-this.baseWidth/2;this.camera.right=this.baseWidth/2;
    this.camera.top=this.baseHeight/2;this.camera.bottom=-this.baseHeight/2;
    this.camera.zoom=this.zoomLevel;this.camera.position.copy(this.pan).add(this.cameraOffset);this.camera.lookAt(this.pan);
    this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld();
  }

  _frame(now) {
    if(this.disposed)return;
    this.animationFrame=requestAnimationFrame(this._frame);
    if(this.paused||document.hidden||this.contextLost){this.lastTime=now;return;}
    const dt=Math.min((now-(this.lastTime||now))/1000,.05);this.lastTime=now;this.elapsed+=dt;
    const t=this.elapsed;
    this.zoomLevel=THREE.MathUtils.damp(this.zoomLevel,this.zoomTarget,10,dt);
    this.pan.lerp(this.targetPan,Math.min(1,dt*8));this._updateCamera();
    this.waterMaterial.uniforms.uTime.value=t;
    const storm=this.stormUntil>t?Math.min(1,(t-this.stormStarted)*1.2,(this.stormUntil-t)*.8):0;
    this.waterMaterial.uniforms.uStorm.value=storm;
    if(this.rain) {
      this.rain.visible=storm>0;this.rain.material.opacity=storm*.32;
      if(storm>0) {
        const positions=this.rain.geometry.attributes.position;
        this.rainSeeds.forEach((seed,i)=>{const y=((seed.height-t*7)%10+10)%10;positions.setXYZ(i*2,seed.x,y,seed.z);positions.setXYZ(i*2+1,seed.x-.16,y+.55,seed.z+.04);});positions.needsUpdate=true;
      }
    }
    if(!this.reducedMotion){this.floating.position.y=Math.sin(t*.7)*.026;this.floating.rotation.z=Math.sin(t*.42)*.0035;this.floating.rotation.x=Math.sin(t*.37)*.0025;}
    for(const [id,model] of this.buildingModels||[])if(model.icon.visible){model.icon.position.y=model.icon.userData.baseY+Math.sin(t*2.5+String(id).length)*.065;}
    for(const resident of this.residents) {
      const duty=resident.temporaryDuty||resident.workerId,building=this.buildings.find(b=>b.id===duty);
      if(building&&resident.workPosition) {
        const target=resident.workPath[0]||resident.workPosition;
        if(this._moveResident(resident,target,dt,t,.9)) {
          if(resident.workPath.length)resident.workPath.shift();
          else this._workResident(resident,building,t);
        }
      } else if(resident.wait>0){resident.wait-=dt;resident.leftArm.rotation.x=Math.sin(t*3+resident.phase)*.10;resident.rightArm.rotation.x=-Math.sin(t*3+resident.phase)*.10;resident.group.rotation.x=0;}
      else if(this._moveResident(resident,resident.target,dt,t,.43))this._nextResidentTarget(resident);
      if(this.cast?.actor===resident) {
        const p=(t-this.cast.started)/1.85;resident.rightArm.rotation.x=p<.25?-1.4*Math.sin(p/.25*Math.PI):-.72+Math.sin(t*7)*.20;
        resident.group.rotation.z=Math.sin(p*Math.PI*2)*.045;
      } else resident.group.rotation.z=0;
    }
    this._updateFishing(t);this._updateSalvages(t);
    for(const animation of this.animations) {
      if(animation.type==='buoy'){animation.group.position.y=animation.baseY+Math.sin(t*1.3+animation.phase)*.05;animation.group.rotation.z=Math.sin(t+animation.phase)*.035;}
      else if(animation.type==='flag'){animation.mesh.rotation.y=Math.sin(t*2.4)*.11;animation.mesh.rotation.x=Math.sin(t*1.3)*.06;}
      else if(animation.type==='radar')animation.mesh.rotation.y=t*.45;
      else if(animation.type==='water')animation.mesh.scale.y=.82+Math.sin(t*7)*.16;
      else if(animation.type==='bobber')animation.mesh.position.y=animation.baseY+Math.sin(t*2.1)*.035;
    }
    for(let i=this.debris.length-1;i>=0;i--) {
      const entry=this.debris[i];entry.age+=dt;
      if(entry.collected){
        if(entry.collectEffect)continue;
        const progress=(t-entry.collectTime)/.32;entry.group.scale.setScalar(Math.max(.001,1-progress));entry.group.position.y+=dt*1.8;
        if(progress>=1){this.scene.remove(entry.group);this._disposeOwn(entry.group);this.debris.splice(i,1);this._rebuildPickables();}continue;
      }
      entry.group.position.x=entry.baseX+Math.sin(t*.12+entry.phase)*.32;
      entry.group.position.z=entry.baseZ+Math.cos(t*.11+entry.phase)*.24;
      entry.group.position.y=-.10+Math.sin(t*1.2+entry.phase)*.055;
      entry.group.rotation.z=Math.sin(t*.9+entry.phase)*.075;
      if(entry.age>105){this.scene.remove(entry.group);this._disposeOwn(entry.group);this.debris.splice(i,1);this._rebuildPickables();}
    }
    this.spawnTimer+=dt;if(this.spawnTimer>3.8){this.spawnTimer=0;this._spawnDebris();}
    for(let i=this.ripples.length-1;i>=0;i--) {
      const ripple=this.ripples[i];
      if(ripple.temporary){const progress=(t-ripple.born)/.85;ripple.mesh.scale.setScalar((1+progress*2.6)*(ripple.scale||1));ripple.mesh.material.opacity=(1-progress)*.8;
        if(progress>=1){this.scene.remove(ripple.mesh);ripple.mesh.geometry.dispose();ripple.mesh.material.dispose();this.ripples.splice(i,1);}}
      else {ripple.mesh.position.y=-.13+Math.sin(t+ripple.phase)*.006;ripple.mesh.rotation.z=Math.sin(t*.11+ripple.phase)*.2;}
    }
    if(this.selection&&t>this.selectionUntil)this.selection.parent?.remove(this.selection);
    this.renderer.render(this.scene,this.camera);
  }

  _disposeOwn(group) { group.traverse(obj=>{if(obj.userData.ownGeometry)obj.geometry?.dispose();if(obj.userData.ownMaterial)obj.material?.dispose();}); }

  dispose() {
    if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.animationFrame);this.resizeObserver?.disconnect();
    if(this.fallback){this.fallback.remove();return;}
    if(!this.renderer)return;
    const canvas=this.renderer.domElement;
    for(const [event,handler] of [['pointerdown',this.onPointerDown],['pointermove',this.onPointerMove],['pointerup',this.onPointerUp],['pointercancel',this.onPointerCancel],['wheel',this.onWheel],['webglcontextlost',this.onContextLost],['webglcontextrestored',this.onContextRestored]])canvas.removeEventListener(event,handler);
    const geometries=new Set(),materials=new Set();
    this.scene.traverse(obj=>{if(obj.geometry)geometries.add(obj.geometry);if(obj.material)(Array.isArray(obj.material)?obj.material:[obj.material]).forEach(m=>materials.add(m));});
    // A layout rebuild can detach the selected building's ring from the scene.
    // It remains cached for the next selection, so dispose it explicitly too.
    if(this.selection){geometries.add(this.selection.geometry);materials.add(this.selection.material);}
    this.geometries.forEach(g=>geometries.add(g));this.materials.forEach(m=>materials.add(m));this.spriteMaterials?.forEach(m=>materials.add(m));
    geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());this.textures.forEach(texture=>texture.dispose());
    this.renderer.dispose();canvas.remove();
  }
}

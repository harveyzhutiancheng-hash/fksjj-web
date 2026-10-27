import { createProgression, normalizeProgression } from './progress-state.js';
import { createScavenging, normalizeScavenging, ScavengingState } from './scavenging-state.js';
import { createDiving, normalizeDiving, DivingState } from './diving-state.js';
import { createStory, normalizeStory, StoryState } from './story-state.js';
import { CRAFT_RESOURCE_NAMES, RECIPES, CONTINUATION_QUESTS, createProduction, createContinuation, normalizeProduction, normalizeContinuation, ProductionState } from './production-state.js';

export { RECIPES, CONTINUATION_QUESTS };

const SAVE_VERSION = 1;
const DEFAULT_STORAGE_KEY = 'fkssj-save-v1';
const MAX_OFFLINE_SECONDS = 2 * 60 * 60;
const RESOURCE_KEYS = ['wood', 'scrap', 'fish', 'water', 'food', 'coin', 'plastic', 'cloth', 'seaweed', 'glass', ...Object.keys(CRAFT_RESOURCE_NAMES)];
const emptyResources = () => Object.fromEntries(RESOURCE_KEYS.map((key) => [key, 0]));
const clone = (value) => JSON.parse(JSON.stringify(value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const buildingReady = (building) => !!building && building.construction?.kind !== 'build';
const constructionError = () => { throw new Error('已付费施工记录不完整，已保留原存档。'); };
const resourceNames = { wood: '木材', scrap: '废金属', fish: '鲜鱼', water: '淡水', food: '食物', coin: '金币', plastic: '塑料', cloth: '碎布', seaweed: '海藻', glass: '玻璃', ...CRAFT_RESOURCE_NAMES };

export const BUILDINGS = Object.freeze({
  command: { name: '指挥中心', icon: '⚑', color: '#d3b176', description: '木筏的核心。升级后提升居住空间，并抵御风暴。', cost: {}, maxLevel: 3, maxWorkers: 0, capacity: 2, upgradeCost: { wood: 35, scrap: 24, coin: 15 } },
  fishing: { name: '钓鱼椅', icon: '🎣', color: '#71bcce', description: '从海里钓取鲜鱼，供切鱼厂加工。', cost: { wood: 18, scrap: 6 }, maxLevel: 3, maxWorkers: 2, upgradeCost: { wood: 24, scrap: 12, coin: 8 }, production: { resource: 'fish', amount: 5, interval: 8, capacity: 35 } },
  slicer: { name: '切鱼厂', icon: '🔪', color: '#e39e80', description: '安排生鱼片加工：6条鲜鱼制作1份，耗时90秒；升2级可加工鱼肠线。', cost: { wood: 20, scrap: 10 }, maxLevel: 3, maxUpgradeLevel: 2, maxWorkers: 0, upgradeCost: { wood: 26, scrap: 16, coin: 10 }, production: { resource: 'food', amount: 1, interval: 90, capacity: 50, inputs: { fish: 6 }, manual: true } },
  purifier: { name: '海水净化器', icon: '💧', color: '#81c9e1', description: '将海水转化成居民需要的淡水。', cost: { wood: 18, scrap: 10 }, maxLevel: 3, maxWorkers: 2, upgradeCost: { wood: 24, scrap: 16, coin: 8 }, production: { resource: 'water', amount: 2, interval: 10, capacity: 16 } },
  scavenger: { name: '拾荒船', icon: '⛵', color: '#b8cbb0', description: '出海搜集废料，同时解锁海上救援。', cost: { wood: 25, scrap: 12 }, maxLevel: 3, maxWorkers: 2, upgradeCost: { wood: 30, scrap: 18, coin: 10 }, production: { resource: 'scrap', amount: 3, interval: 18, capacity: 24 } },
  bed: { name: '居民睡铺', icon: '🛏', color: '#d6ba91', description: '增加 4 个床位，让获救的居民安稳休息。', cost: { wood: 20, scrap: 6 }, maxLevel: 3, maxWorkers: 0, capacity: 4, upgradeCost: { wood: 24, scrap: 12, coin: 6 } },
  farm: { name: '漂浮农田', icon: '🌱', color: '#93b876', description: '每次使用 1 份淡水，收获 3 份食物。', cost: { wood: 24, scrap: 8 }, maxLevel: 3, maxWorkers: 2, upgradeCost: { wood: 28, scrap: 16, coin: 10 }, production: { resource: 'food', amount: 3, interval: 16, capacity: 24, inputs: { water: 1 } } },
  beacon: { name: '归航信标', icon: '✦', color: '#ead08a', description: '风暴后点亮信标，完成这座海上家园的第一章。', cost: { wood: 40, scrap: 28, coin: 20 }, maxLevel: 3, maxWorkers: 0, upgradeCost: { wood: 35, scrap: 24, coin: 15 } },
  kitchen: { name: '海上厨房', icon: '🍲', color: '#d9a37f', description: '以鲜鱼烹饪热食。主线可使用切鱼厂完成食物生产。', cost: { wood: 22, scrap: 10 }, maxLevel: 3, maxWorkers: 2, upgradeCost: { wood: 26, scrap: 16, coin: 10 }, production: { resource: 'food', amount: 3, interval: 12, capacity: 18, inputs: { fish: 4 } } },
  materials: { name: '材料厂', icon: '🧵', color: '#aa9ac9', description: '将拾荒原料排队加工成布匹与长绳。建造费用与加工参数为项目配置。', cost: { wood: 20, plastic: 12 }, maxLevel: 1, maxWorkers: 0, upgradeCost: {} },
  construction: { name: '建材厂', icon: '🪵', color: '#c8a77b', description: '将木材加工成木板，用于后续建设。建造费用与加工参数为项目配置。', cost: { wood: 25, plastic: 10, fabric: 2, rope: 1 }, maxLevel: 1, maxWorkers: 0, upgradeCost: {} },
  tailor: { name: '服装作坊', icon: '🦺', color: '#e2b86c', description: '用塑料与碎布制作救生衣。原料10+10、耗时5分钟参考实录；建造费用为项目配置。', cost: { wood: 20, plastic: 10, plank: 2, fabric: 2 }, maxLevel: 1, maxWorkers: 0, upgradeCost: {} },
  seafoodKitchen: { name: '海产厨房', icon: '🐟', color: '#d9a37f', description: '用木材生火烤制鲜鱼，升至2级后可以加工海藻汁。', note: '建造仍沿用旧海上厨房22木材、10废料的项目成本。实录2124秒升级弹窗明确1级升2级解锁海藻汁，2123至2125秒已见扣费1500金币、200鲜鱼；本项目只收这部分，其他材料及完整表未核实。1至2级施工1200秒；兼容规则为施工中保留旧等级，旧配方与已付批次继续。旧kitchen独立保留，已有二级不追补等待或费用。', cost: { wood: 22, scrap: 10 }, maxLevel: 2, maxWorkers: 0, upgradeCost: { coin: 1500, fish: 200 }, upgradeSeconds: 1200 },
  broadcast: { name: '广播站', icon: '📻', color: '#88a7c5', description: '向远海发送讯息，招募更多伙伴加入家园。', note: '领袖6级和60木材、60塑料参考公开实录；画面另有蓝色图标5尚未确认含义，本项目暂未计费，不声称已还原完整原作造价。', cost: { wood: 60, plastic: 60 }, maxLevel: 1, maxWorkers: 0, upgradeCost: {} },
  divingDock: { name: '潜水船坞', icon: '🤿', color: '#73b5b5', description: '从这里下潜，寻找废金属、玻璃与海藻。', note: '实录1935至1938秒金币减少1500，出现潜水船坞20秒施工。本项目只计入已见的1500金币；完整材料表及其他成本未核实，不额外收费。完工后才开放潜水。广播站建成后衔接是项目简化，不推断领袖10级为硬门槛。', cost: { coin: 1500 }, maxLevel: 1, maxWorkers: 0, upgradeCost: {}, buildSeconds: 20 },
  hospital: { name: '医院', icon: '🏥', color: '#f0d5cf', description: '特殊民居，为家园增加40人口容量。', note: '发行方转载攻略将医院列为增加人口的特殊民居。实录2090至2100秒金币减少1500、人口上限40变80；本项目按差值接入容量+40和1500金币，完整材料表未核实。不把同期21至33的人口变化解释为医院赠送12名居民，不添加治疗或自动扣费。领取潜水物资故事目标后开放为项目接入门槛。', cost: { coin: 1500 }, capacity: 40, maxLevel: 1, maxWorkers: 0, upgradeCost: {} },
  dailyFactory: { name: '日用品厂', icon: '🧴', color: '#b7ccad', description: '将原料加工成居民需要的日用品。', note: '实录2100秒选中日用品厂时浮价1500金币、金属200，2110秒金币减少1500；蓝色图标9未辨明，本项目暂不计入，不声称完整材料表已核实。领取医院建成故事目标后开放为项目接入门槛。', cost: { coin: 1500, scrap: 200 }, maxLevel: 1, maxWorkers: 0, upgradeCost: {} },
});

for (const definition of Object.values(BUILDINGS)) {
  if (definition.production) {
    definition.production.seconds = definition.production.interval;
    if (definition.production.inputs) definition.production.input = definition.production.inputs;
  }
}

export const QUESTS = Object.freeze([
  { id: 'salvage', title: '海面上的第一份馈赠', description: '点击海面漂浮物，累计打捞 15 份木材。', target: 15, metric: 'wood', reward: { wood: 12, scrap: 6, coin: 4 } },
  { id: 'fishing', title: '搬出钓鱼椅', description: '在空闲木筏上安置一把钓鱼椅。', target: 1, metric: 'build:fishing', reward: { wood: 10, scrap: 4, coin: 3 } },
  { id: 'fish', title: '第一网鲜鱼', description: '从钓鱼椅累计获得 15 条鲜鱼，也可以手动甩竿。', target: 15, metric: 'fishCollected', reward: { wood: 12, scrap: 6, coin: 3 } },
  { id: 'slicer', title: '把收获端上餐桌', description: '建造切鱼厂，把鲜鱼加工成生鱼片。', target: 1, metric: 'build:slicer', reward: { fish: 8, water: 2, coin: 4 } },
  { id: 'food', title: '一顿安稳的饭', description: '生产并领取 5 份生鱼片，再交给阿海，满足第一份居民需求。', target: 1, metric: 'residentOrder', reward: { wood: 12, scrap: 8, coin: 5 } },
  { id: 'purifier', title: '向大海借一杯水', description: '建造一座海水净化器。', target: 1, metric: 'build:purifier', reward: { wood: 10, scrap: 4, coin: 4 } },
  { id: 'water', title: '淡水储备', description: '从海水净化器累计领取 6 份淡水。', target: 6, metric: 'produce:water', reward: { wood: 14, scrap: 8, food: 4, coin: 5 } },
  { id: 'expand', title: '家园再大一点', description: '沿着边缘扩建 2 块木筏。', target: 2, metric: 'expand', reward: { wood: 12, scrap: 6, coin: 5 } },
  { id: 'scavenger', title: '准备远航', description: '建造拾荒船，寻找物资与幸存者。', target: 1, metric: 'build:scavenger', reward: { water: 4, food: 4, coin: 6 } },
  { id: 'rescue', title: '远方的求救声', description: '派出拾荒船，完成第一次海上救援。', target: 1, metric: 'rescue', reward: { wood: 16, scrap: 8, water: 6, food: 6, coin: 8 } },
  { id: 'bed', title: '今晚有个落脚处', description: '建造居民睡铺，安置新加入的伙伴。', target: 1, metric: 'build:bed', reward: { wood: 12, scrap: 6, coin: 6 } },
  { id: 'farm', title: '让生活生长', description: '建造漂浮农田，建立另一条食物来源。', target: 1, metric: 'build:farm', reward: { wood: 20, scrap: 14, water: 6, coin: 12 } },
  { id: 'command', title: '迎着风暴修好家园', description: '指挥中心升至 2 级，备好水与食物，再迎接风暴。', target: 1, metric: 'storm', reward: { wood: 22, scrap: 16, water: 6, food: 6, coin: 15 } },
  { id: 'beacon', title: '灯亮起的地方就是家', description: '建造归航信标，完成海上家园的第一章。', target: 1, metric: 'build:beacon', reward: { wood: 20, scrap: 12, water: 10, food: 10, coin: 30 } },
]);

export const RESIDENT_ORDERS = Object.freeze([
  { id: 'first-meal', title: '先让大家吃上饭', description: '阿海饿坏了。生产并领取 5 份生鱼片，把第一顿饭交到他手里。', resident: { id: 'captain', name: '阿海', portrait: 0 }, cost: { food: 5 }, reward: { experience: 60, coin: 8, wood: 8, scrap: 4 }, unlock: 'start', unlockDescription: '从切鱼厂累计领取 5 份生鱼片后可以交付。', productionRequired: { food: 5 } },
  { id: 'fresh-water', title: '再备一壶干净的水', description: '净水器运转起来了，为阿海准备一壶水和一点食物。', resident: { id: 'captain', name: '阿海', portrait: 0 }, cost: { water: 4, food: 2 }, reward: { experience: 80, coin: 10, wood: 10, scrap: 6 }, unlock: 'water', unlockDescription: '从净水器累计领取 6 份淡水后解锁。' },
  { id: 'welcome-meal', title: '给新伙伴留一份', description: '把水和食物送给刚获救的米娅，欢迎她加入海上家园。', resident: { id: 'mia', name: '米娅', portrait: 1 }, cost: { food: 6, water: 4 }, reward: { experience: 100, coin: 14, wood: 12, scrap: 8 }, unlock: 'rescue', unlockDescription: '完成第一次海上救援后解锁。' },
  { id: 'deodorizer-meal', title: '防臭大师的餐点', description: '为防臭大师准备1条烤鱼和1杯淡水。', resident: { id: 'deodorizer', name: '防臭大师', portrait: 2 }, cost: { grilledFish: 1, water: 1 }, reward: { experience: 40, coin: 120 }, unlock: 'collector', unlockDescription: '完成收藏家的烤鱼需求，并拥有可用的海产厨房后解锁。', source: 'https://www.bilibili.com/video/BV1Vt9MByEP8/?t=686', note: '686秒需求为1烤鱼与1淡水，奖励40经验、120金币，688秒金币1825至1945再次印证。排在既有三单及收藏家交付之后为项目兼容接入，不代表完整轮换表；不实现每日12单上限或定时刷新。实录渠道未独立确认。' },
  { id: 'xiaoqiang-fish-meal', title: '小强的双鱼餐', description: '为小强准备1份生鱼片和1条烤鱼。', resident: { id: 'xiaoqiang', name: '小强', portrait: 2 }, cost: { food: 1, grilledFish: 1 }, reward: { experience: 40, coin: 105 }, unlock: 'collector', unlockDescription: '完成收藏家的烤鱼需求，并拥有可用的海产厨房后解锁。', source: 'https://www.bilibili.com/video/BV1Vt9MByEP8/?t=685', note: '实际解码685.744秒的小强面板明确生鱼片1、烤鱼1、40经验105金币；686秒钱包1720至1825。录像中此单在防臭大师之前，本项目保留旧四单顺序后追加，一次交付；不据此推断每日刷新或完整原作轮换。录像渠道未独立确认。' },
  { id: 'sailor-fish-vest', title: '水手的出海补给', description: '为水手准备1条烤鱼和1件救生衣。', resident: { id: 'sailor', name: '水手', portrait: 0 }, cost: { grilledFish: 1, lifejacket: 1 }, reward: { experience: 40, coin: 180 }, unlock: 'collector', unlockDescription: '完成收藏家的烤鱼需求，并拥有可用的海产厨房后解锁。', source: 'https://www.bilibili.com/video/BV1Vt9MByEP8/?t=1285', note: '1285秒左侧白底选中水手，需求烤鱼1、救生衣1，奖励40经验180金币；1285.527秒钱包5045至5225。追加一次性订单为项目接入，不推断刷新；录像渠道未独立确认。' },
  { id: 'blade-food-vest', title: '螺丝刀的出海补给', description: '为螺丝刀准备2份生鱼片和1件救生衣。', resident: { id: 'screwdriver', name: '螺丝刀', portrait: 1 }, cost: { food: 2, lifejacket: 1 }, reward: { experience: 40, coin: 165 }, unlock: 'collector', unlockDescription: '完成收藏家的烤鱼需求，并拥有可用的海产厨房后解锁。', source: 'https://www.bilibili.com/video/BV1Vt9MByEP8/?t=1285.5', note: '实际1285.527秒左侧白底选中螺丝刀，需求生鱼片2、救生衣1，明示40经验165金币；1286秒钱包5225至5390。稳定ID中的blade为内部标识，显示名称按画面。追加一次性订单为项目接入，不推断刷新；录像渠道未独立确认。' },
  { id: 'collector-vest-water', title: '收藏家的出海准备', description: '为收藏家准备1件救生衣和2杯淡水。', resident: { id: 'collector', name: '收藏家', portrait: 2 }, cost: { lifejacket: 1, water: 2 }, reward: { experience: 40, coin: 195 }, unlock: 'collector', unlockDescription: '完成收藏家的烤鱼需求，并拥有可用的海产厨房后解锁。', source: 'https://www.bilibili.com/video/BV1Vt9MByEP8/?t=1286', note: '1286秒选中收藏家，需求救生衣1、淡水2，奖励40经验195金币；1287秒钱包5390至5585。与收藏家烤鱼是两份不同需求，旧烤鱼奖励不重发。追加一次性订单为项目接入，不推断刷新；录像渠道未独立确认。' },
  { id: 'coral-line-vest', title: '珊瑚礁的鱼肠线与救生衣', description: '为珊瑚礁准备1份鱼肠线和1件救生衣。', resident: { id: 'coral', name: '珊瑚礁', portrait: 0 }, cost: { fishLine: 1, lifejacket: 1 }, reward: { experience: 45, coin: 105 }, unlock: 'collector', unlockDescription: '完成收藏家的烤鱼需求，并拥有可用的海产厨房后解锁。', source: 'https://www.bilibili.com/video/BV1Vt9MByEP8/?t=1290', note: '1288至1290秒右侧白底标签选中珊瑚礁，左侧水母酱未选中；需求鱼肠线1、救生衣1，奖励45经验105金币；鱼肠线图标与1515秒配方面板对应。此时尚未交付，采用明示报价。追加一次性订单为项目接入，不推断刷新；录像渠道未独立确认。' },
  { id: 'jellyfish-fish-water', title: '水母酱的烤鱼与淡水', description: '为水母酱准备1条烤鱼和2杯淡水。', resident: { id: 'jellyfish', name: '水母酱', portrait: 2 }, cost: { grilledFish: 1, water: 2 }, reward: { experience: 40, coin: 165 }, unlock: 'collector', unlockDescription: '完成收藏家的烤鱼需求，并拥有可用的海产厨房后解锁。', source: 'https://www.bilibili.com/video/BV1Vt9MByEP8/?t=1539', note: '1539秒选中水母酱，需求烤鱼1、淡水2，明示40经验165金币，1545秒钱包5585至5750。与鱼肠线需求为不同事件。追加一次性订单为项目接入，不推断刷新；录像渠道未独立确认。' },
]);

function createInitialState(now) {
  return {
    version: SAVE_VERSION,
    savedAt: now,
    elapsed: 0,
    nextBuildingId: 1,
    resources: { ...emptyResources(), wood: 8, scrap: 6, water: 3, coin: 10 },
    profile: { experience: 0, level: 1 },
    residentOrders: { version: 1, completed: [] },
    tutorial: { introSeen: false },
    progression: createProgression(now),
    scavenging: createScavenging(),
    diving: createDiving(),
    production: createProduction(),
    continuation: createContinuation(),
    story: createStory(),
    raft: Array.from({ length: 9 }, (_, index) => ({ x: index % 3 - 1, z: Math.floor(index / 3) - 1 })),
    buildings: [{ id: 'command', type: 'command', x: 0, z: 0, level: 1, workers: 0, stored: 0, progress: 0 }],
    population: { total: 1, capacity: 2, hunger: 100, thirst: 100 },
    stats: { salvageCount: 0, fishCollected: 0, manualCasts: 0, salvageCollected: emptyResources(), productionCollected: emptyResources(), productionGenerated: emptyResources(), totalCollected: emptyResources(), buildingsBuilt: { command: 1 }, tilesExpanded: 0, upgrades: 0, workersAssigned: 0, rescued: 0, questsClaimed: 0 },
    quests: { claimed: [] },
    exploration: { rescueCompleted: false },
    fishing: { lastCastAt: -2.5 },
    storm: { status: 'dormant', attempts: 0, penaltyRemaining: 0 },
    completed: false,
    offlineReport: null,
  };
}

export class GameState {
  constructor(options = {}) {
    this.storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    try { this.storage = options.storage === undefined ? globalThis.localStorage : options.storage; } catch { this.storage = null; }
    this.listeners = new Set();
    this.storageError = null;
    this.persistenceLocked = false;
    this.lastSavedAt = 0;
    this.state = createInitialState(this.now());
    this._scavenging = new ScavengingState(this);
    this._diving = new DivingState(this);
    this._production = new ProductionState(this);
    this._story = new StoryState(this);
    if (options.autoLoad !== false) this.load();
    this._refreshDerived();
  }

  get availableWorkers() {
    return Math.max(0, this.state.population.total - this.state.buildings.reduce((sum, building) => sum + building.workers, 0));
  }

  getState() { return clone(this.state); }
  isBuildingReady(id) { return buildingReady(typeof id === 'object' ? id : this._building(id)); }
  getConstruction(id) {
    const building = typeof id === 'object' ? id : this._building(id), job = building?.construction;
    return job ? { ...clone(job), buildingId: building.id, progress: clamp(1 - job.remaining / job.duration, 0, 1) } : null;
  }

  startScavenging() { return this._scavenging.start(); }
  moveScavenging(input, dt) { return this._scavenging.move(input, dt); }
  returnScavenging() { return this._scavenging.returnToCamp(); }
  getScavenging() { return this._scavenging.getTrip(); }
  markScavengingGuideSeen() { return this._scavenging.markGuideSeen(); }
  getScavengingUpgrade() { return this._scavenging.getUpgrade(); }
  upgradeScavenging() { return this._scavenging.upgrade(); }
  startDiving() { return this._diving.start(); }
  moveDiving(input, dt) { return this._diving.move(input, dt); }
  returnDiving() { return this._diving.returnToCamp(); }
  getDiving() { return this._diving.getTrip(); }
  markDivingGuideSeen() { return this._diving.markGuideSeen(); }
  getRecipes(buildingId = null) { return this._production.getRecipes(buildingId); }
  queueProduction(recipeId, quantity = 1, buildingId = null) { return this._production.enqueue(recipeId, quantity, buildingId); }
  getProductionQueue(buildingId = null) { return this._production.getQueue(buildingId); }
  claimQueuedProduction(jobId) { return this._production.claim(jobId); }
  getStoryQuests() { return this._story.getQuests(); }
  claimStoryQuest(id) { return this._story.claim(id); }
  getSideQuests() { return this._story.getSideQuests(); }
  claimSideQuest(id) { return this._story.claimSide(id); }
  getCurrentTask() {
    const tutorial = this.getQuests().find((quest) => quest.active);
    if (tutorial) return { ...tutorial, category: 'tutorial', story: false, followup: false };
    const story = this.getStoryQuests().find((quest) => quest.active);
    if (story) return story;
    const continuation = this.getContinuationQuests().find((quest) => quest.active);
    return continuation ? { ...continuation, category: 'continuation', story: false, followup: true } : null;
  }

  getFactoryUnlock(type) {
    if (this.state.buildings.some((building) => building.type === type && buildingReady(building))) return { unlocked: true, reason: '' };
    if (type === 'broadcast') return { unlocked: this.state.profile.level >= 6, reason: this.state.profile.level >= 6 ? '' : '领袖达到6级后开放广播站建设。' };
    if (type === 'divingDock') {
      const unlocked = this.state.buildings.some((building) => building.type === 'broadcast' && buildingReady(building));
      return { unlocked, reason: unlocked ? '' : '先建造广播站，再建设潜水船坞。' };
    }
    if (type === 'hospital' || type === 'dailyFactory') {
      const prerequisite = type === 'hospital' ? 'diving-scrap' : 'hospital-built';
      const unlocked = this.state.story.claimed.includes(prerequisite);
      return { unlocked, reason: unlocked ? '' : type === 'hospital' ? '先领取潜水物资故事目标，再建造医院。' : '先领取医院建成故事目标，再建造日用品厂。', note: '按已领取的前置故事目标开放为本项目接入门槛，不声称原作最早解锁条件已核实。' };
    }
    if (!['materials', 'construction', 'tailor', 'seafoodKitchen'].includes(type)) return { unlocked: !!BUILDINGS[type], reason: BUILDINGS[type] ? '' : '找不到这类设施。' };
    return { unlocked: this.state.completed, reason: this.state.completed ? '' : '完成海上家园原14项任务后开放工厂建设。' };
  }

  onChange(listener, options = {}) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    if (options.immediate !== false) listener(this.state, { type: 'init' });
    return () => this.listeners.delete(listener);
  }

  save() {
    if (this.persistenceLocked) return { ok: false, persisted: false, message: this.storageError };
    if (!this.storage?.setItem) return { ok: true, persisted: false, message: '当前以临时存档运行。' };
    try {
      this.state.savedAt = this.now();
      this.storage.setItem(this.storageKey, JSON.stringify(this.state));
      this.lastSavedAt = this.state.savedAt;
      this.storageError = null;
      return { ok: true, persisted: true, message: '进度已保存。' };
    } catch {
      this.storageError = '浏览器未能写入存档，当前进度仍保留在本次页面中。';
      return { ok: false, persisted: false, message: this.storageError };
    }
  }

  load() {
    if (!this.storage?.getItem) return { ok: true, loaded: false, message: '开始新的海上旅程。' };
    try {
      const text = this.storage.getItem(this.storageKey);
      if (!text) {
        this.persistenceLocked = false;
        this.storageError = null;
        return { ok: true, loaded: false, message: '开始新的海上旅程。' };
      }
      const raw = JSON.parse(text);
      if (raw?.version !== SAVE_VERSION) return this._lockPersistence('存档版本暂不兼容');
      const normalized = this._normalizeSave(raw);
      if (!normalized) return this._lockPersistence('存档内容不完整');
      this.persistenceLocked = false;
      this.storageError = null;
      this.state = normalized;
      this._refreshDerived();
      const offlineSeconds = clamp((this.now() - this.state.savedAt) / 1000, 0, MAX_OFFLINE_SECONDS);
      const report = this._advance(offlineSeconds);
      this.state.offlineReport = offlineSeconds >= 10 ? { seconds: offlineSeconds, produced: report.produced, constructionCompleted: report.constructionCompleted, capped: (this.now() - raw.savedAt) / 1000 > MAX_OFFLINE_SECONDS } : null;
      this._changed('load', { offlineSeconds, constructionCompleted: report.constructionCompleted });
      return { ok: true, loaded: true, offlineSeconds, message: '已继续上次的旅程。' };
    } catch {
      return this._lockPersistence('暂时无法读取存档，或存档已经损坏');
    }
  }

  reset() {
    this.persistenceLocked = false;
    this.storageError = null;
    this.state = createInitialState(this.now());
    this._changed('reset');
    return { ok: true, message: '新旅程开始了。' };
  }

  completeIntro() {
    if (!this.state.tutorial.introSeen) {
      this.state.tutorial.introSeen = true;
      this._changed('introCompleted');
    }
    return { ok: true, introSeen: true, message: '先把海上的物资收起来，给大家准备第一顿饭。' };
  }

  getResidentDemandProgress() {
    const ids = new Set(this.state.residentOrders.completed);
    if (this.state.story.claimed.includes('collector-grilled-fish') || this.state.continuation.claimed.includes('collector-grilled-fish')) ids.add('collector-grilled-fish');
    return { completedIds: [...ids], completed: ids.size, knownTotal: RESIDENT_ORDERS.length + 1 };
  }

  getResidentOrder() {
    const completed = this.state.residentOrders.completed;
    const definition = RESIDENT_ORDERS.find((order) => !completed.includes(order.id));
    const common = { completed: completed.length, total: RESIDENT_ORDERS.length, experienceToNextLevel: 60 - this.state.profile.experience % 60 };
    if (!definition) return { ...common, order: null, id: null, status: 'completed', canDeliver: false, unlocked: false, missing: {}, productionReady: true, productionRequired: {}, productionCollected: {}, reason: '这几份居民需求已经全部满足了。' };
    const unlocked = definition.unlock === 'start' || definition.unlock === 'water' && this.state.stats.productionCollected.water >= 6 || definition.unlock === 'rescue' && this.state.exploration.rescueCompleted || definition.unlock === 'collector' && (this.state.story.claimed.includes('collector-grilled-fish') || this.state.continuation.claimed.includes('collector-grilled-fish')) && this.state.buildings.some((building) => building.type === 'seafoodKitchen' && buildingReady(building));
    const productionRequired = definition.productionRequired || {};
    const productionCollected = Object.fromEntries(Object.keys(productionRequired).map((key) => [key, this.state.stats.productionCollected[key]]));
    const productionReady = Object.entries(productionRequired).every(([key, amount]) => this.state.stats.productionCollected[key] >= amount);
    const missing = Object.fromEntries(Object.entries(definition.cost).filter(([key, amount]) => this.state.resources[key] + 1e-7 < amount).map(([key, amount]) => [key, Math.ceil(amount - this.state.resources[key] - 1e-7)]));
    const canDeliver = unlocked && productionReady && this._canAfford(definition.cost);
    const reason = !unlocked ? definition.unlockDescription : !productionReady ? '先从生产设施累计领取 5 份生鱼片，再交付给居民。' : Object.keys(missing).length ? `还缺少${Object.entries(missing).map(([key, amount]) => `${amount} 份${resourceNames[key]}`).join('、')}。` : '物资准备好了，可以交付。';
    return { ...common, order: clone(definition), id: definition.id, status: unlocked ? 'active' : 'locked', canDeliver, unlocked, missing, productionReady, productionRequired: clone(productionRequired), productionCollected, reason };
  }

  deliverResidentOrder(id) {
    const current = this.getResidentOrder();
    const orderId = id ?? current.id;
    const failure = (message) => ({ ok: false, message, orderId, order: current.order, canDeliver: false, missing: current.missing, currentOrder: current });
    if (orderId && this.state.residentOrders.completed.includes(orderId)) return failure('这份居民需求已经交付过了。');
    if (!current.order) return failure('这几份居民需求已经全部满足了。');
    if (orderId !== current.id) return failure('先满足当前这位居民的需求吧。');
    if (!current.canDeliver) return failure(current.reason);
    const { order } = current;
    this._spend(order.cost);
    this.state.residentOrders.completed.push(order.id);
    const resources = Object.fromEntries(Object.entries(order.reward).filter(([key]) => RESOURCE_KEYS.includes(key)));
    this._addResources(resources);
    this.state.profile.experience += order.reward.experience;
    this._refreshDerived();
    const profile = clone(this.state.profile);
    this._changed('residentOrderDelivered', { order, reward: order.reward, profile });
    return { ok: true, message: `${order.resident.name}收到了补给！获得 ${order.reward.experience} 经验。`, orderId: order.id, order, cost: clone(order.cost), reward: clone(order.reward), resources, profile, missing: {}, canDeliver: false, currentOrder: this.getResidentOrder() };
  }

  tick(dt) {
    const seconds = clamp(finite(dt), 0, MAX_OFFLINE_SECONDS);
    const report = this._advance(seconds);
    if (!seconds && !report.constructionCompleted.length) return { ok: true, seconds: 0, message: '' };
    this._changed('tick', { seconds, constructionCompleted: report.constructionCompleted }, report.constructionCompleted.length > 0);
    return { ok: true, seconds, ...report, message: '' };
  }

  collect(kind = 'crate') {
    const bundles = {
      wood: { wood: 6 }, scrap: { scrap: 4 }, fish: { fish: 3 }, water: { water: 2 }, food: { food: 2 }, coin: { coin: 2 },
      crate: { wood: 6, scrap: 3, coin: 1 }, barrel: { wood: 4, scrap: 4, coin: 2 }, driftwood: { wood: 7 }, supply: { wood: 5, scrap: 3, fish: 2 },
    };
    const bundle = bundles[kind];
    if (!bundle) return { ok: false, message: '这件漂浮物暂时无法打捞。' };
    this._addResources(bundle, 'salvage');
    this.state.stats.salvageCount += 1;
    this._changed('collect', { kind, resources: bundle });
    return { ok: true, resources: clone(bundle), message: `打捞成功：${this._formatCost(bundle)}` };
  }

  castLine() {
    if (!this.state.buildings.some((building) => building.type === 'fishing')) return { ok: false, message: '先安置一把钓鱼椅，再来甩竿吧。' };
    const cooldownRemaining = Math.max(0, 2.5 - (this.state.elapsed - this.state.fishing.lastCastAt));
    if (cooldownRemaining > 1e-7) return { ok: false, cooldownRemaining, message: '鱼儿还没咬钩，再等一小会儿。' };
    const amount = 3 + this.state.stats.manualCasts % 3;
    this.state.fishing.lastCastAt = this.state.elapsed;
    this.state.stats.manualCasts += 1;
    this.state.resources.fish += amount;
    this.state.stats.fishCollected += amount;
    this.state.stats.totalCollected.fish += amount;
    this._changed('castLine', { amount });
    return { ok: true, amount, resources: { fish: amount }, cooldownRemaining: 2.5, message: `鱼儿上钩！获得 ${amount} 条鲜鱼。` };
  }

  getExpandCost() {
    return { wood: 8 + Math.floor(this.state.stats.tilesExpanded / 4) * 2, scrap: 3 };
  }

  expand(x, z) {
    if (!Number.isInteger(x) || !Number.isInteger(z) || Math.abs(x) > 6 || Math.abs(z) > 6) return { ok: false, message: '请在木筏边缘选择有效的位置。' };
    if (this.state.raft.some((tile) => tile.x === x && tile.z === z)) return { ok: false, message: '这里已经有木筏了。' };
    if (!this.state.raft.some((tile) => Math.abs(tile.x - x) + Math.abs(tile.z - z) === 1)) return { ok: false, message: '新木筏需要和现有木筏相连。' };
    const cost = this.getExpandCost();
    if (!this._canAfford(cost)) return this._insufficient(cost);
    this._spend(cost);
    this.state.raft.push({ x, z });
    this.state.stats.tilesExpanded += 1;
    this._changed('expand', { x, z });
    return { ok: true, tile: { x, z }, cost, message: '木筏扩建完成。' };
  }

  getBuildingCost(type) { return BUILDINGS[type] ? clone(BUILDINGS[type].cost) : null; }

  placeBuilding(type, x, z) {
    const definition = BUILDINGS[type];
    if (!definition || type === 'command') return { ok: false, message: '请选择可以建造的设施。' };
    const factoryUnlock = this.getFactoryUnlock(type);
    if (!factoryUnlock.unlocked) return { ok: false, message: factoryUnlock.reason };
    if (!Number.isInteger(x) || !Number.isInteger(z) || !this.state.raft.some((tile) => tile.x === x && tile.z === z)) return { ok: false, message: '设施需要建在木筏上。' };
    if (this.state.buildings.some((building) => building.x === x && building.z === z)) return { ok: false, message: '这里已经有设施了，换一块空木筏吧。' };
    if (type === 'beacon' && this.state.storm.status !== 'passed') return { ok: false, message: '先升级指挥中心、备好补给并迎接风暴，再建造归航信标。' };
    if (!this._canAfford(definition.cost)) return this._insufficient(definition.cost);
    this._spend(definition.cost);
    const duration = definition.buildSeconds || 0;
    const workers = !duration && definition.maxWorkers > 0 && this.availableWorkers > 0 ? 1 : 0;
    const building = { id: `building-${this.state.nextBuildingId++}`, type, x, z, level: 1, workers, stored: 0, progress: 0 };
    if (duration) building.construction = { version: 1, kind: 'build', fromLevel: 0, targetLevel: 1, duration, remaining: duration, cost: clone(definition.cost) };
    this.state.buildings.push(building);
    if (!duration) this.state.stats.buildingsBuilt[type] = (this.state.stats.buildingsBuilt[type] || 0) + 1;
    this.state.stats.workersAssigned += workers;
    const job = this.getConstruction(building.id);
    this._changed('build', { building, queued: !!duration });
    return { ok: true, building, id: building.id, queued: !!duration, job, message: duration ? `${definition.name}开始施工，${duration}秒后完工。` : `${definition.name}建好了${workers ? '，已安排 1 位居民工作' : ''}。` };
  }

  getUpgradeCost(id) {
    const building = this._building(id);
    if (!building || building.level >= (BUILDINGS[building.type].maxUpgradeLevel || BUILDINGS[building.type].maxLevel)) return null;
    return Object.fromEntries(Object.entries(BUILDINGS[building.type].upgradeCost).map(([key, amount]) => [key, Math.ceil(amount * (1 + (building.level - 1) * 0.7))]));
  }

  upgradeBuilding(id) {
    const building = this._building(id);
    if (!building) return { ok: false, message: '找不到这座设施。' };
    if (building.construction) return { ok: false, job: this.getConstruction(id), message: '这座设施正在施工，请等待完工后再操作。' };
    const cost = this.getUpgradeCost(id);
    if (!cost) return { ok: false, message: '这座设施已达到最高等级。' };
    if (!this._canAfford(cost)) return this._insufficient(cost);
    this._spend(cost);
    const duration = BUILDINGS[building.type].upgradeSeconds || 0;
    if (duration) {
      building.construction = { version: 1, kind: 'upgrade', fromLevel: building.level, targetLevel: building.level + 1, duration, remaining: duration, cost: clone(cost) };
      const job = this.getConstruction(id);
      this._changed('upgrade', { building, queued: true });
      return { ok: true, building, queued: true, job, message: `${BUILDINGS[building.type].name}开始升级，${duration}秒后升至${job.targetLevel}级。` };
    }
    building.level += 1;
    this.state.stats.upgrades += 1;
    this._changed('upgrade', { building });
    return { ok: true, building, message: `${BUILDINGS[building.type].name}升至 ${building.level} 级。` };
  }

  assignWorker(id, delta = 1) {
    const building = this._building(id);
    if (building && !buildingReady(building)) return { ok: false, message: '设施尚未完工，暂时不能安排工人。' };
    if (!building || BUILDINGS[building.type].maxWorkers < 1) return { ok: false, message: '这座设施不需要安排工人。' };
    if (!Number.isInteger(delta) || delta === 0) return { ok: false, message: '请选择增加或减少的工人数。' };
    const next = building.workers + delta;
    if (next < 0 || next > BUILDINGS[building.type].maxWorkers) return { ok: false, message: `这座设施最多安排 ${BUILDINGS[building.type].maxWorkers} 位工人。` };
    if (delta > this.availableWorkers) return { ok: false, message: '没有空闲居民了，可以先从其他设施调回工人。' };
    building.workers = next;
    if (delta > 0) this.state.stats.workersAssigned += delta;
    this._changed('workers', { building });
    return { ok: true, workers: next, message: delta > 0 ? '已安排居民工作。' : '居民已回到待命岗位。' };
  }

  assign(id, delta = 1) { return this.assignWorker(id, delta); }

  collectProduction(id) {
    const building = this._building(id);
    const production = buildingReady(building) && BUILDINGS[building.type].production;
    if (!production) return { ok: false, message: '这座设施没有可以领取的产物。' };
    const amount = Math.floor(building.stored + 1e-7);
    if (amount < 1) return { ok: false, message: production.manual ? '在加工队列中安排生鱼片，完成后领取。' : '还在生产中，稍等一会儿。' };
    building.stored = Math.max(0, building.stored - amount);
    const bundle = { [production.resource]: amount };
    this._addResources(bundle, 'production');
    if (production.resource === 'fish') this.state.stats.fishCollected += amount;
    if (this.state.stats.productionCollected.water >= 6 && this.state.storm.status === 'dormant') this.state.storm.status = 'approaching';
    this._changed('productionCollected', { building, resources: bundle });
    return { ok: true, resources: bundle, amount, message: `领取了 ${amount} 份${resourceNames[production.resource]}。` };
  }

  getProductionInfo(id) {
    const building = typeof id === 'object' ? id : this._building(id);
    const production = buildingReady(building) && BUILDINGS[building.type]?.production;
    if (!production) return null;
    if (production.manual) return { ...clone(production), stored: building.stored, progress: 0, workers: 0, efficiency: 1, secondsRemaining: 0, blocked: 'manual' };
    const scale = 1 + (building.level - 1) * 0.5;
    const efficiency = this._efficiency(building);
    const capacity = Math.floor(production.capacity * scale);
    return { ...clone(production), capacity, amount: Math.ceil(production.amount * scale), stored: building.stored, progress: clamp(building.progress / production.interval, 0, 1), workers: building.workers, efficiency, secondsRemaining: Math.max(0, (production.interval - building.progress) / efficiency), blocked: building.stored >= capacity ? 'full' : !this._canAfford(production.inputs || {}) ? 'inputs' : null };
  }

  explore() {
    if (this.state.exploration.rescueCompleted) return { ok: false, message: '这片海域的幸存者已经获救了，新的远航将在下一章开启。' };
    if (!this.state.buildings.some((building) => building.type === 'scavenger')) return { ok: false, message: '先建造拾荒船，再去寻找幸存者。' };
    const cost = { water: 3, food: 3 };
    if (!this._canAfford(cost)) return this._insufficient(cost);
    this._spend(cost);
    this.state.population.total += 2;
    this.state.stats.rescued += 2;
    this.state.exploration.rescueCompleted = true;
    this._changed('rescue', { residents: 2 });
    return { ok: true, residents: 2, message: '救援成功！2 位幸存者加入了家园，为他们准备睡铺吧。' };
  }

  getStormStatus() {
    const commandLevel = this.state.buildings.find((building) => building.type === 'command')?.level || 1;
    const ready = commandLevel >= 2 && this.state.resources.water >= 6 && this.state.resources.food >= 6;
    const passed = this.state.storm.status === 'passed';
    // These are the project's existing storm requirements. Food still shares
    // its legacy inventory with farm/kitchen output; it is not the first-meal
    // production counter. A passed storm records that these goals were met,
    // even after faceStorm spends the supplies. No extra save ledger is needed.
    const objectives = [
      { id: 'food', current: this.state.resources.food, target: 6, action: { type: 'production', buildingType: 'slicer', recipeId: 'sashimi' } },
      { id: 'command', current: commandLevel, target: 2, action: { type: 'building', buildingType: 'command' } },
      { id: 'water', current: this.state.resources.water, target: 6, action: { type: 'building', buildingType: 'purifier' } },
    ].map((objective) => ({ ...objective, current: passed ? Math.max(objective.current, objective.target) : objective.current, complete: passed || objective.current >= objective.target }));
    return { ...this.state.storm, ready, commandLevel, requirements: { commandLevel: 2, water: 6, food: 6 }, objectives };
  }

  faceStorm() {
    const storm = this.state.storm;
    if (storm.status === 'dormant') return { ok: false, message: '海面还很平静，先完成淡水储备。' };
    if (storm.status === 'passed') return { ok: false, message: '你们已经平安渡过这场风暴。' };
    if (storm.status === 'recovering') return { ok: false, message: `设施正在恢复，约 ${Math.ceil(storm.penaltyRemaining)} 秒后可以重新准备。` };
    if (!this.getStormStatus().ready) return { ok: false, message: '需要 2 级指挥中心、6 份淡水和 6 份食物，再迎接风暴。' };
    this._spend({ water: 4, food: 4 });
    storm.attempts += 1;
    storm.status = 'passed';
    storm.penaltyRemaining = 0;
    this.state.resources.coin += 10;
    this._changed('stormPassed');
    return { ok: true, message: '指挥中心守住了家园！大家平安渡过风暴，获得 10 金币。' };
  }

  resolveStorm() { return this.faceStorm(); }

  questStatus(id) {
    const index = QUESTS.findIndex((quest) => quest.id === id);
    if (index < 0) return null;
    const quest = QUESTS[index];
    const current = this._questValue(quest.metric);
    const claimed = this.state.quests.claimed.includes(id);
    const active = !claimed && QUESTS.slice(0, index).every((previous) => this.state.quests.claimed.includes(previous.id));
    const complete = current >= quest.target;
    return { ...clone(quest), current, target: quest.target, progress: clamp(current / quest.target, 0, 1), claimed, complete, active, status: claimed ? 'claimed' : !active ? 'locked' : complete ? 'ready' : 'active' };
  }

  getQuests() { return QUESTS.map((quest) => this.questStatus(quest.id)); }

  getContinuationQuests() {
    return CONTINUATION_QUESTS.map((quest, index) => {
      const claimed = this.state.continuation.claimed.includes(quest.id);
      const missing = Object.fromEntries(Object.entries(quest.cost).filter(([key, value]) => this.state.resources[key] + 1e-7 < value).map(([key, value]) => [key, Math.ceil(value - this.state.resources[key] - 1e-7)]));
      const current = quest.metric === 'trips' ? this.state.scavenging.completedTrips : quest.metric === 'scavenger-upgrade' ? this.state.scavenging.upgradeLevel : quest.metric === 'deliver' ? Object.keys(missing).length ? 0 : 1 : this._questValue(quest.metric);
      const active = !claimed && this.state.completed && CONTINUATION_QUESTS.slice(0, index).every((previous) => this.state.continuation.claimed.includes(previous.id));
      const complete = claimed || current >= quest.target && !Object.keys(missing).length;
      return { ...clone(quest), current, progress: clamp(current / quest.target, 0, 1), claimed, active, complete, missing, status: claimed ? 'claimed' : !active ? 'locked' : complete ? 'ready' : 'active' };
    });
  }

  claimContinuationQuest(id) {
    const quest = this.getContinuationQuests().find((value) => value.id === id);
    if (!quest) return { ok: false, message: '找不到这个后续建设任务。' };
    if (quest.claimed) return { ok: false, message: '这份后续任务奖励已经领取过。' };
    if (!quest.active) return { ok: false, message: '先完成原14步，并按顺序领取后续建设奖励。' };
    if (!quest.complete) return { ok: false, missing: quest.missing, message: quest.metric === 'deliver' ? '交付物资还不够，领取时会扣除页面列出的材料。' : '这项建设目标还没有完成。' };
    this._spend(quest.cost);
    this.state.continuation.claimed.push(id);
    const sharedStory = this.getStoryQuests().find((value) => value.legacyId === id);
    if (sharedStory && !this.state.story.claimed.includes(sharedStory.id)) this.state.story.claimed.push(sharedStory.id);
    const resources = Object.fromEntries(Object.entries(quest.reward).filter(([key]) => RESOURCE_KEYS.includes(key)));
    this._addResources(resources);
    this.state.profile.experience += Math.max(0, finite(quest.reward.experience));
    this._changed('continuationQuestClaimed', { quest, resources: clone(resources), reward: clone(quest.reward) });
    return { ok: true, cost: clone(quest.cost), reward: clone(quest.reward), resources: clone(resources), profile: clone(this.state.profile), message: `后续建设完成：${quest.title}。` };
  }

  claimQuest(id) {
    const quest = this.questStatus(id);
    if (!quest) return { ok: false, message: '找不到这个任务。' };
    if (quest.claimed) return { ok: false, message: '这份奖励已经领取过了。' };
    if (!quest.active) return { ok: false, message: '先领取前一个任务的奖励吧。' };
    if (!quest.complete) return { ok: false, message: '再努力一点，任务还没有完成。' };
    this._addResources(quest.reward);
    this.state.quests.claimed.push(id);
    this.state.stats.questsClaimed += 1;
    this.state.completed = this.state.quests.claimed.length === QUESTS.length;
    this._changed('questClaimed', { quest });
    return { ok: true, reward: quest.reward, completed: this.state.completed, message: this.state.completed ? '第一章完成！风浪之上，属于你们的家园亮起来了。' : `任务完成：${this._formatCost(quest.reward)}` };
  }

  _building(id) { return this.state.buildings.find((building) => building.id === id); }
  _lockPersistence(reason) {
    this.persistenceLocked = true;
    this.storageError = `${reason}，原存档已保留并暂停自动保存。当前可临时游玩；选择“重新开始”后才会覆盖旧存档。`;
    return { ok: false, loaded: false, persisted: false, message: this.storageError };
  }
  _canAfford(cost) { return Object.entries(cost).every(([key, amount]) => RESOURCE_KEYS.includes(key) && this.state.resources[key] + 1e-7 >= amount); }
  _spend(cost) { for (const [key, amount] of Object.entries(cost)) this.state.resources[key] = Math.max(0, this.state.resources[key] - amount); }
  _formatCost(cost) { return Object.entries(cost).map(([key, amount]) => `${resourceNames[key]} +${amount}`).join(' · '); }
  _insufficient(cost) { return { ok: false, cost: clone(cost), message: `物资不足，需要${Object.entries(cost).map(([key, amount]) => `${amount} ${resourceNames[key]}`).join('、')}。` }; }

  _addResources(bundle, source) {
    for (const [key, amount] of Object.entries(bundle)) {
      this.state.resources[key] += amount;
      if (source) {
        this.state.stats.totalCollected[key] += amount;
        this.state.stats[source === 'salvage' ? 'salvageCollected' : 'productionCollected'][key] += amount;
      }
    }
  }

  _questValue(metric) {
    if (metric.startsWith('build:')) return this.state.stats.buildingsBuilt[metric.slice(6)] || 0;
    if (metric.startsWith('produce:')) return this.state.stats.productionCollected[metric.slice(8)] || 0;
    if (metric === 'wood') return this.state.stats.salvageCollected.wood;
    if (metric === 'fishCollected') return this.state.stats.fishCollected;
    if (metric === 'residentOrder') return this.state.residentOrders.completed.includes('first-meal') ? 1 : 0;
    if (metric === 'expand') return this.state.stats.tilesExpanded;
    if (metric === 'rescue') return this.state.exploration.rescueCompleted ? 1 : 0;
    if (metric === 'storm') return this.state.storm.status === 'passed' && this.state.buildings.some((building) => building.type === 'command' && building.level >= 2) ? 1 : 0;
    return 0;
  }

  _efficiency(building) {
    const workerFactor = building.workers ? 1 + (building.workers - 1) * 0.5 : 0.55;
    const wellbeing = 0.65 + 0.35 * Math.min(this.state.population.hunger, this.state.population.thirst) / 100;
    const shelter = this.state.population.total > this.state.population.capacity ? 0.9 : 1;
    return workerFactor * wellbeing * shelter * (this.state.storm.status === 'recovering' ? 0.7 : 1);
  }

  _completeConstructions() {
    const completed = [];
    for (const building of this.state.buildings) {
      const job = building.construction;
      if (!job || job.remaining > 0) continue;
      delete building.construction;
      if (job.kind === 'build') {
        this.state.stats.buildingsBuilt[building.type] = (this.state.stats.buildingsBuilt[building.type] || 0) + 1;
        building.workers = BUILDINGS[building.type].maxWorkers > 0 && this.availableWorkers > 0 ? 1 : 0;
        this.state.stats.workersAssigned += building.workers;
      } else {
        building.level = job.targetLevel;
        this.state.stats.upgrades += 1;
      }
      completed.push({ id: building.id, buildingId: building.id, type: building.type, kind: job.kind, targetLevel: job.targetLevel });
    }
    if (completed.length) this._refreshDerived();
    return completed;
  }

  _advance(seconds) {
    const produced = emptyResources();
    const constructionCompleted = this._completeConstructions();
    let remaining = seconds;
    while (remaining > 0) {
      const deadline = Math.min(Infinity, ...this.state.buildings.filter((building) => building.construction).map((building) => building.construction.remaining));
      const step = Math.min(1, remaining, deadline);
      const population = this.state.population;
      for (const [resource, meter, period, decline] of [['water', 'thirst', 180, 0.055], ['food', 'hunger', 240, 0.04]]) {
        // Keep the first meal available for its explicit tutorial delivery.
        if (!this.state.residentOrders.completed.includes('first-meal')) {
          population[meter] = clamp(population[meter] - step * decline, 0, 100);
          continue;
        }
        const need = step * population.total / period;
        const available = Math.min(need, this.state.resources[resource]);
        this.state.resources[resource] = Math.max(0, this.state.resources[resource] - available);
        population[meter] = clamp(population[meter] + (available >= need - 1e-8 ? step * 0.14 : -step * decline), 0, 100);
      }
      if (this.state.storm.status === 'recovering') {
        this.state.storm.penaltyRemaining = Math.max(0, this.state.storm.penaltyRemaining - step);
        if (!this.state.storm.penaltyRemaining) this.state.storm.status = 'approaching';
      }
      for (const building of this.state.buildings) {
        const production = BUILDINGS[building.type].production;
        if (!production || production.manual || !buildingReady(building)) continue;
        const scale = 1 + (building.level - 1) * 0.5;
        const capacity = Math.floor(production.capacity * scale);
        if (building.stored >= capacity) { building.progress = 0; continue; }
        building.progress += step * this._efficiency(building);
        while (building.progress + 1e-7 >= production.interval) {
          if (!this._canAfford(production.inputs || {})) { building.progress = production.interval; break; }
          const amount = Math.min(Math.ceil(production.amount * scale), capacity - building.stored);
          if (amount <= 0) { building.progress = 0; break; }
          this._spend(production.inputs || {});
          building.stored += amount;
          produced[production.resource] += amount;
          this.state.stats.productionGenerated[production.resource] += amount;
          building.progress = Math.max(0, building.progress - production.interval);
          if (building.stored >= capacity) { building.progress = 0; break; }
        }
      }
      for (const [key, amount] of Object.entries(this._production.advance(step))) produced[key] += amount;
      for (const building of this.state.buildings) if (building.construction) building.construction.remaining = Math.max(0, building.construction.remaining - step);
      constructionCompleted.push(...this._completeConstructions());
      this.state.elapsed += step;
      remaining -= step;
    }
    return { produced, constructionCompleted };
  }

  _refreshDerived() {
    this.state.population.capacity = this.state.buildings.reduce((sum, building) => sum + (buildingReady(building) ? (BUILDINGS[building.type].capacity || 0) * building.level : 0), 0);
    this.state.profile.level = 1 + Math.floor(this.state.profile.experience / 60);
  }

  _changed(type, detail = {}, forceSave = true) {
    this._refreshDerived();
    if (forceSave || this.now() - this.lastSavedAt >= 5000) this.save();
    for (const listener of this.listeners) {
      try { listener(this.state, { type, ...detail }); } catch (error) { console.error('GameState listener failed:', error); }
    }
  }

  _normalizeSave(raw) {
    if (!raw || !Array.isArray(raw.raft) || !Array.isArray(raw.buildings) || !raw.resources || !raw.population) return null;
    const state = createInitialState(this.now());
    const tiles = new Set();
    state.raft = raw.raft.filter((tile) => Number.isInteger(tile?.x) && Number.isInteger(tile?.z) && Math.abs(tile.x) <= 6 && Math.abs(tile.z) <= 6).filter((tile) => {
      const key = `${tile.x},${tile.z}`;
      if (tiles.has(key)) return false;
      tiles.add(key);
      return true;
    }).map(({ x, z }) => ({ x, z }));
    if (!tiles.has('0,0')) return null;
    const positions = new Set();
    const ids = new Set(), constructionIds = new Set(), constructionPositions = new Set();
    state.buildings = [];
    for (const value of raw.buildings) {
      const definition = BUILDINGS[value?.type];
      const position = `${value?.x},${value?.z}`;
      const hasConstruction = Object.hasOwn(value || {}, 'construction');
      if (!definition || typeof value.id !== 'string' || !Number.isInteger(value.x) || !Number.isInteger(value.z) || ids.has(value.id) || positions.has(position) || !tiles.has(position)) {
        if (hasConstruction || constructionIds.has(value?.id) || constructionPositions.has(position)) constructionError();
        continue;
      }
      if (value.type === 'command' && (value.x !== 0 || value.z !== 0 || state.buildings.some((building) => building.type === 'command'))) {
        if (hasConstruction) constructionError();
        continue;
      }
      if (hasConstruction && (!Number.isInteger(value.level) || value.level < 1 || value.level > definition.maxLevel)) constructionError();
      const level = clamp(Math.floor(finite(value.level, 1)), 1, definition.maxLevel);
      const legacySlicer = value.type === 'slicer' && (raw.production?.version ?? 1) <= 5;
      const capacity = value.type === 'slicer' ? (legacySlicer ? 16 * (1 + (level - 1) * 0.5) : 50) : definition.production ? Math.floor(definition.production.capacity * (1 + (level - 1) * 0.5)) : 0;
      const building = { id: value.id, type: value.type, x: value.x, z: value.z, level, workers: clamp(Math.floor(finite(value.workers)), 0, definition.maxWorkers), stored: clamp(finite(value.stored), 0, capacity), progress: clamp(finite(value.progress), 0, definition.production?.interval || 0) };
      if (value.type === 'slicer') {
        // Old auto-production charged fish only on completion. Preserve its
        // finished stock, carry the fraction of work to one new paid batch.
        const credit = legacySlicer ? clamp(finite(value.progress), 0, 10) * 9 : (Object.hasOwn(value, 'legacySlicerProgress') ? value.legacySlicerProgress : 0);
        if (!Number.isFinite(credit) || credit < 0 || credit > 90 || !legacySlicer && (!Number.isFinite(value.stored) || value.stored < 0 || value.stored > 50)) throw new Error('切鱼厂库存或保留工时不完整，已保留原存档。');
        building.legacySlicerProgress = credit;
        building.progress = 0;
      }
      if (hasConstruction) {
        building.construction = this._normalizeConstruction(value.construction, building);
        if (!buildingReady(building)) building.workers = 0;
        constructionIds.add(building.id); constructionPositions.add(position);
      }
      state.buildings.push(building);
      ids.add(value.id);
      positions.add(position);
    }
    if (!state.buildings.some((building) => building.type === 'command')) return null;
    for (const key of RESOURCE_KEYS) state.resources[key] = clamp(finite(raw.resources[key]), 0, 1e9);
    state.population.total = clamp(Math.floor(finite(raw.population.total, 1)), 1, 100);
    state.population.hunger = clamp(finite(raw.population.hunger, 100), 0, 100);
    state.population.thirst = clamp(finite(raw.population.thirst, 100), 0, 100);
    let freeWorkers = state.population.total;
    for (const building of state.buildings) { building.workers = Math.min(building.workers, freeWorkers); freeWorkers -= building.workers; }
    const stats = raw.stats || {};
    for (const key of ['salvageCount', 'fishCollected', 'manualCasts', 'tilesExpanded', 'upgrades', 'workersAssigned', 'rescued', 'questsClaimed']) state.stats[key] = Math.max(0, finite(stats[key]));
    for (const category of ['salvageCollected', 'productionCollected', 'productionGenerated', 'totalCollected']) for (const key of RESOURCE_KEYS) state.stats[category][key] = Math.max(0, finite(stats[category]?.[key]));
    state.stats.buildingsBuilt = Object.fromEntries(Object.keys(BUILDINGS).map((key) => [key, Math.max(finite(stats.buildingsBuilt?.[key]), state.buildings.filter((building) => building.type === key && buildingReady(building)).length)]));
    state.quests.claimed = QUESTS.filter((quest) => raw.quests?.claimed?.includes(quest.id)).map((quest) => quest.id);
    state.stats.questsClaimed = state.quests.claimed.length;
    const orderLedger = raw.residentOrders;
    if (orderLedger != null && (typeof orderLedger !== 'object' || Array.isArray(orderLedger) || orderLedger.version !== undefined && orderLedger.version !== 1 || orderLedger.completed !== undefined && !Array.isArray(orderLedger.completed))) throw new Error('居民需求记录来自更新版本或格式不完整，已保留原存档。');
    const completedOrders = orderLedger?.completed || [];
    if (completedOrders.some((id) => !RESIDENT_ORDERS.some((order) => order.id === id))) throw new Error('居民需求交付记录暂不兼容，已保留原存档。');
    state.residentOrders.completed = RESIDENT_ORDERS.filter((order) => completedOrders.includes(order.id) || order.id === 'first-meal' && state.quests.claimed.includes('food')).map((order) => order.id);
    const legacyExperience = Math.floor(state.quests.claimed.length / 3) * 60;
    state.profile.experience = clamp(Math.floor(finite(raw.profile?.experience, legacyExperience)), 0, 1e9);
    state.profile.level = 1 + Math.floor(state.profile.experience / 60);
    state.tutorial.introSeen = raw.tutorial?.introSeen === true || state.stats.salvageCount > 0 || state.quests.claimed.length > 0 || state.buildings.length > 1;
    state.exploration.rescueCompleted = raw.exploration?.rescueCompleted === true;
    state.fishing.lastCastAt = Math.max(-2.5, finite(raw.fishing?.lastCastAt, -2.5));
    if (state.exploration.rescueCompleted) state.population.total = Math.max(3, state.population.total);
    state.storm.status = ['dormant', 'approaching', 'recovering', 'passed'].includes(raw.storm?.status) ? raw.storm.status : 'dormant';
    state.storm.attempts = Math.max(0, finite(raw.storm?.attempts));
    state.storm.penaltyRemaining = clamp(finite(raw.storm?.penaltyRemaining), 0, 90);
    state.completed = state.quests.claimed.length === QUESTS.length;
    state.elapsed = Math.max(0, finite(raw.elapsed));
    state.nextBuildingId = Math.max(1, Math.floor(finite(raw.nextBuildingId, 1)), ...state.buildings.map((building) => finite(building.id.replace('building-', '')) + 1));
    state.savedAt = Math.max(0, finite(raw.savedAt, this.now()));
    state.progression = normalizeProgression(raw.progression, this.now());
    state.scavenging = normalizeScavenging(raw.scavenging);
    state.diving = normalizeDiving(raw.diving);
    state.production = normalizeProduction(raw.production, state.buildings, RESOURCE_KEYS);
    state.continuation = normalizeContinuation(raw.continuation);
    state.story = normalizeStory(raw.story, state.continuation);
    return state;
  }

  _normalizeConstruction(raw, building) {
    if (raw && Number(raw.version) > 1) throw new Error('施工记录来自更新版本，已保留原存档。');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || !['build', 'upgrade'].includes(raw.kind) || !Number.isFinite(raw.duration) || raw.duration <= 0 || raw.duration > 1e7 || !Number.isFinite(raw.remaining) || raw.remaining < 0 || raw.remaining > raw.duration || !Number.isInteger(raw.fromLevel) || !Number.isInteger(raw.targetLevel)) constructionError();
    const definition = BUILDINGS[building.type];
    if (raw.kind === 'build' ? !definition.buildSeconds || building.level !== 1 || raw.fromLevel !== 0 || raw.targetLevel !== 1 : !definition.upgradeSeconds || raw.fromLevel !== building.level || raw.targetLevel !== building.level + 1 || raw.targetLevel > definition.maxLevel) constructionError();
    if (!raw.cost || typeof raw.cost !== 'object' || Array.isArray(raw.cost) || !Object.keys(raw.cost).length || Object.entries(raw.cost).some(([key, amount]) => !RESOURCE_KEYS.includes(key) || !Number.isFinite(amount) || amount < 0 || amount > 1e9) || !Object.values(raw.cost).some((amount) => amount > 0)) constructionError();
    return { version: 1, kind: raw.kind, fromLevel: raw.fromLevel, targetLevel: raw.targetLevel, duration: raw.duration, remaining: raw.remaining, cost: clone(raw.cost) };
  }
}

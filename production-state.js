/** Queued factory production. Recipe snapshots keep paid jobs stable across saves. */
export const CRAFT_RESOURCE_NAMES = Object.freeze({
  fabric: '布匹', rope: '长绳', plank: '木板', lifejacket: '救生衣', fishLine: '鱼肠线', grilledFish: '烤鱼', seaweedJuice: '海藻汁', dailyGoods: '日用品',
});
export const PRODUCTION_RESOURCE_KEYS = Object.freeze(['food', ...Object.keys(CRAFT_RESOURCE_NAMES)]);

// The 1→2 upgrade dialog at 2124s explicitly unlocks seaweed juice. This gate
// is separate from both its 1200-second upgrade and the product processing time.
export const SEAWEED_JUICE_RECIPE = Object.freeze({ id: 'seaweedJuice', name: '海藻汁', description: '把海藻与玻璃加工成海藻汁。', buildingType: 'seafoodKitchen', minBuildingLevel: 2, inputs: { seaweed: 20, glass: 10 }, outputs: { seaweedJuice: 1 }, seconds: 1200, storage: 50, note: '实录2124秒海产厨房1级升2级弹窗明确解锁海藻汁；海藻20、玻璃10、加工20分钟与库存50参考2140秒。建筑升级施工和本配方加工各1200秒，分别计时；施工期间保持旧等级，旧配方与已付批次继续为兼容规则。' });

export const PRODUCTION_CONFIG = Object.freeze({ version: 6, queueSlots: 6, maxQuantity: 10, note: '各工厂独立先进先出、6批队列；本项目保留单批1至10件的便捷入口与已付批次快照，这与原作逐件占生产槽的行为仍有差异。未核实配方仍为项目配置。生鱼片为鲜鱼6、90秒、库存上限50；实录布匹为碎布20、救生衣为塑料10加碎布10、鱼肠线为鲜鱼20，均为5分钟、库存上限50；鱼肠线需2级切鱼厂为项目衔接规则。' });
export const RECIPES = Object.freeze([
  { id: 'fabric', name: '布匹', description: '把拾荒带回的碎布整理成可用布匹。', buildingType: 'materials', inputs: { cloth: 20 }, outputs: { fabric: 1 }, seconds: 300, storage: 50, note: '碎布20、5分钟与库存50参考公开实录1530秒；单次产出1匹为本项目批次表示。' },
  { id: 'rope', name: '长绳', description: '用碎布和塑料编成建设用的长绳。', buildingType: 'materials', inputs: { cloth: 2, plastic: 1 }, outputs: { rope: 1 }, seconds: 40, storage: 50, note: '材料厂存在长绳由官方公开图确认；本条数量、时长与库存为项目配置。' },
  { id: 'plank', name: '木板', description: '把木材切成便于搭建的木板。', buildingType: 'construction', inputs: { wood: 5 }, outputs: { plank: 1 }, seconds: 30, storage: 50, note: '建材厂存在木板由官方公开图确认；本条数量、时长与库存为项目配置。' },
  { id: 'lifejacket', name: '救生衣', description: '将塑料与碎布加工成海上救援用的救生衣。', buildingType: 'tailor', inputs: { plastic: 10, cloth: 10 }, outputs: { lifejacket: 1 }, seconds: 300, storage: 50, note: '配方原料、5分钟和库存50参考公开实录1270秒；单次产出1件为本项目批次表示。' },
  { id: 'sashimi', name: '生鱼片', description: '将鲜鱼加工成居民需要的生鱼片。', buildingType: 'slicer', minBuildingLevel: 1, inputs: { fish: 6 }, outputs: { food: 1 }, seconds: 90, storage: 50, source: 'https://www.bilibili.com/video/BV1Vt9MByEP8/?t=1494', note: '鲜鱼6、90秒与库存50参考公开实录1494秒。切鱼厂建成即可入队，领取后计入首餐生产累计；旧已生成尾货与新队列成品共用50份厂内上限。旧版未付生产进度折算为0至90秒，由首个成功入队批次一次抵用，仍完整扣鱼，拒绝入队时保留。单批1至10份与旧批次整批领取仍为项目兼容表示，未重构为原作逐件占槽。' },
  { id: 'fishLine', name: '鱼肠线', description: '从鲜鱼中加工鱼肠线，与生鱼片共用切鱼厂队列和鲜鱼库存。', buildingType: 'slicer', minBuildingLevel: 2, inputs: { fish: 20 }, outputs: { fishLine: 1 }, seconds: 300, storage: 50, note: '鲜鱼20、5分钟与库存50参考公开实录1500秒；画面为2级切鱼厂，但尚未证实原作解锁等级。2级门槛为本项目衔接规则。' },
  { id: 'grilledFish', name: '烤鱼', description: '用木材生火烤制鲜鱼，为收藏家准备一顿饭。', buildingType: 'seafoodKitchen', minBuildingLevel: 1, inputs: { fish: 1, wood: 5 }, outputs: { grilledFish: 1 }, seconds: 300, storage: 50, note: '鲜鱼1、木材5、5分钟与库存50参考公开实录678秒；原14步后开放为项目衔接规则。' },
  SEAWEED_JUICE_RECIPE,
  { id: 'dailyGoods', name: '日用品', description: '用玻璃与废金属加工居民日常生活需要的用品。', buildingType: 'dailyFactory', minBuildingLevel: 1, inputs: { glass: 20, scrap: 20 }, outputs: { dailyGoods: 1 }, seconds: 1200, storage: 50, source: 'https://www.bilibili.com/video/BV1Vt9MByEP8/?t=2113', note: '实录2113秒日用品厂1级配方面板明确玻璃20、废金属20、20分钟和库存50，2115与2117秒再次可见；蓝色玻璃图标与2140秒海藻汁配方一致。单批产出1份为本项目批次表示，实录渠道未独立确认。旧版已付20废金属、300秒批次继续按原输入、时长和剩余时间快照完成，不补扣玻璃。' },
]);

export const CONTINUATION_QUESTS = Object.freeze([
  { id: 'supply-trip', title: '把收获带回家', description: '完成一趟手动拾荒并返航。之前完成的航程也计入。', metric: 'trips', target: 1, cost: {}, reward: { coin: 30, wood: 12 }, action: { type: 'scavenge' } },
  { id: 'materials-built', title: '建起材料厂', description: '在营地建造材料厂，开始加工拾荒原料。', metric: 'build:materials', target: 1, cost: {}, reward: { coin: 20, cloth: 4, plastic: 4 }, action: { type: 'build', buildingType: 'materials' } },
  { id: 'fabric-made', title: '让碎布有新用处', description: '从材料厂累计领取2匹布匹。', metric: 'produce:fabric', target: 2, cost: {}, reward: { coin: 25, wood: 10 }, action: { type: 'production', buildingType: 'materials', recipeId: 'fabric' } },
  { id: 'rope-made', title: '把家园绑得更牢', description: '从材料厂累计领取1根长绳。', metric: 'produce:rope', target: 1, cost: {}, reward: { coin: 25, plastic: 4, cloth: 4 }, action: { type: 'production', buildingType: 'materials', recipeId: 'rope' } },
  { id: 'construction-built', title: '有了建材才能走远', description: '使用布匹和长绳建造建材厂。', metric: 'build:construction', target: 1, cost: {}, reward: { coin: 30, wood: 10 }, action: { type: 'build', buildingType: 'construction' } },
  { id: 'planks-made', title: '把漂流木变成木板', description: '从建材厂累计领取2块木板。', metric: 'produce:plank', target: 2, cost: {}, reward: { coin: 30, plastic: 10, cloth: 10 }, action: { type: 'production', buildingType: 'construction', recipeId: 'plank' } },
  { id: 'tailor-built', title: '海上也要有防护', description: '使用木板和布匹建造服装作坊。', metric: 'build:tailor', target: 1, cost: {}, reward: { coin: 35, plastic: 10, cloth: 10 }, action: { type: 'build', buildingType: 'tailor' } },
  { id: 'lifejacket-made', title: '准备第一件救生衣', description: '从服装作坊累计领取1件救生衣。', metric: 'produce:lifejacket', target: 1, cost: {}, reward: { coin: 40, wood: 15 }, action: { type: 'production', buildingType: 'tailor', recipeId: 'lifejacket' } },
  { id: 'rescue-kit', title: '为下一次救援备好物资', description: '交付1件救生衣、4份淡水和4份食物。领取时扣除明示物资。', metric: 'deliver', target: 1, cost: { lifejacket: 1, water: 4, food: 4 }, reward: { coin: 60, wood: 15, scrap: 10 }, action: { type: 'deliver', buildingType: 'tailor', recipeId: 'lifejacket' } },
  { id: 'scavenger-enhanced', title: '强化拾荒装备', description: '完成至少1次拾荒概率强化，已经强化的进度也计入。', metric: 'scavenger-upgrade', target: 1, cost: {}, reward: { coin: 50, plastic: 8, cloth: 8 }, action: { type: 'scavenge-upgrade' } },
  { id: 'second-boat', title: '再准备一艘拾荒船', description: '营地拥有2艘拾荒船，为后续拾荒等级升级做好准备。', metric: 'build:scavenger', target: 2, cost: {}, reward: { coin: 75, wood: 20, scrap: 12 }, action: { type: 'build', buildingType: 'scavenger' } },
  { id: 'logistics-reserve', title: '新的远航补给', description: '交付3木板、2布匹、2长绳及1件救生衣。', metric: 'deliver', target: 1, cost: { plank: 3, fabric: 2, rope: 2, lifejacket: 1 }, reward: { coin: 100, wood: 25, scrap: 15 }, action: { type: 'deliver', buildingType: 'materials' } },
  { id: 'seafood-kitchen-built', title: '建造海产厨房', description: '安置1座海产厨房，用鲜鱼和木材制作烤鱼。', metric: 'build:seafoodKitchen', target: 1, cost: {}, reward: {}, action: { type: 'build', buildingType: 'seafoodKitchen' }, note: '建造海产厨房1座参考实录650秒；追加在原12项后和开放时机为项目衔接。本次没有核实建造任务奖励，不额外编造奖励。' },
  { id: 'collector-grilled-fish', title: '收藏家想吃一条烤鱼', description: '交付1条烤鱼，获得40领袖经验与75金币。', metric: 'deliver', target: 1, cost: { grilledFish: 1 }, reward: { experience: 40, coin: 75 }, action: { type: 'deliver', buildingType: 'seafoodKitchen', recipeId: 'grilledFish' }, note: '交付1烤鱼、奖励40经验与75金币参考公开实录684秒；追加任务位置和开放时机为项目衔接规则。' },
].map((quest) => ({ ...quest, note: quest.note || '独立于原14步的项目后续建设任务；顺序、目标与奖励均为项目配置，并非已核实的原作主线。' })));

const clone = (value) => JSON.parse(JSON.stringify(value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const count = (value, fallback = 0) => Math.floor(clamp(finite(value, fallback), 0, 1e9));
const scaled = (bundle, quantity) => Object.fromEntries(Object.entries(bundle).map(([key, amount]) => [key, amount * quantity]));
const sum = (bundle) => Object.values(bundle).reduce((total, amount) => total + amount, 0);
const missingResources = (resources, cost) => Object.fromEntries(Object.entries(cost).filter(([key, amount]) => resources[key] + 1e-7 < amount).map(([key, amount]) => [key, Math.ceil(amount - resources[key] - 1e-7)]));

export function createProduction() { return { version: PRODUCTION_CONFIG.version, nextJobId: 1, queue: [], collected: Object.fromEntries(PRODUCTION_RESOURCE_KEYS.map((key) => [key, 0])) }; }
export function createContinuation() { return { version: 1, claimed: [] }; }

export function normalizeContinuation(raw) {
  if (raw == null) return createContinuation();
  if (typeof raw !== 'object' || Array.isArray(raw) || finite(raw.version, 1) > 1) throw new Error('后续建设任务来自更新版本或格式不完整，已保留原存档。');
  if (raw.claimed !== undefined && !Array.isArray(raw.claimed)) throw new Error('后续任务领取记录不完整，已保留原存档。');
  const claimed = [...new Set(raw.claimed || [])];
  if (claimed.some((id) => !CONTINUATION_QUESTS.some((quest) => quest.id === id))) throw new Error('后续任务记录暂不兼容，已保留原存档。');
  return { version: 1, claimed };
}

export function normalizeProduction(raw, buildings, resourceKeys) {
  const state = createProduction();
  if (raw == null) return state;
  if (typeof raw !== 'object' || Array.isArray(raw) || !Number.isInteger(raw.version ?? 1) || (raw.version ?? 1) < 1 || (raw.version ?? 1) > PRODUCTION_CONFIG.version) throw new Error('工厂生产来自更新版本或格式不完整，已保留原存档。');
  if (raw.queue !== undefined && !Array.isArray(raw.queue)) throw new Error('工厂队列不完整，已保留原存档。');
  const ids = new Set(), stationCounts = new Map(), outputCounts = new Map();
  const cleanBundle = (bundle) => {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || Object.entries(bundle).some(([key, amount]) => !resourceKeys.includes(key) || !Number.isFinite(amount) || amount < 0 || amount > 1e9)) throw new Error('已付费生产批次的材料记录不兼容，已保留原存档。');
    return clone(bundle);
  };
  for (const job of raw.queue || []) {
    const recipe = RECIPES.find((definition) => definition.id === job?.recipeId);
    if (!recipe || typeof job.id !== 'string' || !job.id || ids.has(job.id) || !buildings.some((building) => building.id === job.buildingId && building.type === recipe.buildingType) || !['queued', 'running', 'ready'].includes(job.status) || !Number.isInteger(job.quantity) || job.quantity < 1 || job.quantity > PRODUCTION_CONFIG.maxQuantity || !Number.isFinite(job.duration) || job.duration <= 0 || job.duration > 1e9 || !Number.isFinite(job.remaining) || job.remaining < 0 || job.remaining > job.duration) throw new Error('已付费生产批次不完整，已保留原存档。');
    const inputs = cleanBundle(job.inputs), outputs = cleanBundle(job.outputs);
    if (!sum(outputs) || job.status === 'ready' && job.remaining > 1e-7) throw new Error('生产完成记录不一致，已保留原存档。');
    const stationCount = (stationCounts.get(job.buildingId) || 0) + 1, outputKey = `${job.buildingId}:${recipe.id}`, outputCount = (outputCounts.get(outputKey) || 0) + sum(outputs);
    if (stationCount > PRODUCTION_CONFIG.queueSlots || outputCount > recipe.storage) throw new Error('工厂队列超出本版本容量，已保留原存档。');
    stationCounts.set(job.buildingId, stationCount); outputCounts.set(outputKey, outputCount); ids.add(job.id);
    state.queue.push({ id: job.id, buildingId: job.buildingId, recipeId: job.recipeId, name: typeof job.name === 'string' ? job.name : recipe.name, quantity: job.quantity, inputs, outputs, duration: job.duration, remaining: job.remaining, status: job.remaining <= 1e-7 ? 'ready' : job.status });
  }
  state.nextJobId = Math.max(1, count(raw.nextJobId, 1), ...state.queue.map((job) => count(/^production-(\d+)$/.exec(job.id)?.[1]) + 1));
  for (const building of buildings.filter((building) => building.type === 'slicer')) {
    const reservedFood = Math.max(0, finite(building.stored)) + state.queue.filter((job) => job.buildingId === building.id).reduce((total, job) => total + (job.outputs.food || 0), 0);
    if (reservedFood > 50 + 1e-7) throw new Error('切鱼厂旧库存与已付生鱼片批次超出容量，已保留原存档。');
  }
  for (const key of Object.keys(state.collected)) state.collected[key] = count(raw.collected?.[key]);
  return state;
}

export class ProductionState {
  constructor(game) { this.game = game; }
  get state() { return this.game.state.production; }
  _jobs(buildingId) { return this.state.queue.filter((job) => !buildingId || job.buildingId === buildingId); }
  _station(recipe, buildingId) {
    const stations = this.game.state.buildings.filter((building) => building.type === recipe.buildingType && (!buildingId || building.id === buildingId) && (typeof this.game.isBuildingReady !== 'function' || this.game.isBuildingReady(building.id)));
    return stations.find((building) => building.level >= (recipe.minBuildingLevel || 1)) || stations[0];
  }
  _refreshStatuses() {
    const running = new Set();
    for (const job of this.state.queue) {
      if (job.remaining <= 1e-7) { job.status = 'ready'; continue; }
      job.status = running.has(job.buildingId) ? 'queued' : 'running'; running.add(job.buildingId);
    }
  }
  getQueue(buildingId = null) {
    return this._jobs(buildingId).map((job) => ({ ...clone(job), progress: clamp(1 - job.remaining / job.duration, 0, 1), canClaim: job.status === 'ready' }));
  }
  getRecipes(buildingId = null) {
    const selected = buildingId && this.game.state.buildings.find((building) => building.id === buildingId);
    return RECIPES.filter((recipe) => !buildingId || selected?.type === recipe.buildingType).map((recipe) => {
      const station = this._station(recipe, buildingId), jobs = this._jobs(station?.id).filter((job) => station && job.buildingId === station.id);
      const related = jobs.filter((job) => recipe.id === 'sashimi' ? (job.outputs.food || 0) > 0 : job.recipeId === recipe.id), legacyStored = recipe.id === 'sashimi' ? Math.max(0, finite(station?.stored)) : 0;
      const outputAmount = (job) => recipe.id === 'sashimi' ? job.outputs.food || 0 : sum(job.outputs);
      const reserved = legacyStored + related.reduce((value, job) => value + outputAmount(job), 0), stored = legacyStored + related.filter((job) => job.status === 'ready').reduce((value, job) => value + outputAmount(job), 0);
      const missing = missingResources(this.game.state.resources, recipe.inputs);
      const factoryUnlock = this.game.getFactoryUnlock(recipe.buildingType), minBuildingLevel = recipe.minBuildingLevel || 1, buildingLevel = station?.level || 0;
      const unlocked = factoryUnlock.unlocked && !!station && buildingLevel >= minBuildingLevel;
      const reason = !factoryUnlock.unlocked ? factoryUnlock.reason : !station ? '先建造对应工厂。' : buildingLevel < minBuildingLevel ? `这份配方需要设施升至${minBuildingLevel}级（当前${buildingLevel}级）。` : jobs.length >= PRODUCTION_CONFIG.queueSlots ? '这座工厂的生产队列已满，先领取成品。' : reserved + sum(recipe.outputs) > recipe.storage ? '这项成品的厂内库存已预留满，先领取。' : Object.keys(missing).length ? '加工原料还不够。' : '';
      const affordable = Math.min(...Object.entries(recipe.inputs).map(([key, amount]) => Math.floor((this.game.state.resources[key] + 1e-7) / amount)));
      return { ...clone(recipe), minBuildingLevel, buildingLevel, buildingId: station?.id || null, construction: station && this.game.getConstruction?.(station.id) || null, unlocked, reason, missing, canQueue: unlocked && !reason, maxQuantity: unlocked && jobs.length < PRODUCTION_CONFIG.queueSlots ? Math.max(0, Math.min(PRODUCTION_CONFIG.maxQuantity, affordable, Math.floor((recipe.storage - reserved) / sum(recipe.outputs)))) : 0, queueSlots: PRODUCTION_CONFIG.queueSlots, slotsUsed: jobs.length, stored, reserved, legacyStored };
    });
  }
  enqueue(recipeId, quantity = 1, buildingId = null) {
    const recipe = RECIPES.find((value) => value.id === recipeId);
    if (!recipe) return { ok: false, message: '找不到这份加工配方。' };
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > PRODUCTION_CONFIG.maxQuantity) return { ok: false, message: '每批请选择1至10件。' };
    const info = this.getRecipes(buildingId).find((value) => value.id === recipeId);
    if (!info?.canQueue) return { ok: false, missing: info?.missing || {}, message: info?.reason || '这座工厂无法加工此配方。' };
    const inputs = scaled(recipe.inputs, quantity), outputs = scaled(recipe.outputs, quantity), missing = missingResources(this.game.state.resources, inputs);
    if (Object.keys(missing).length) return { ok: false, cost: inputs, missing, message: '这批加工原料还不够。' };
    if (info.reserved + sum(outputs) > recipe.storage) return { ok: false, message: '这批成品超出厂内库存上限，先领取或减少数量。' };
    // The migration credit is pre-existing work, not a material discount. Clear
    // it only after validation/payment and before publishing any callback.
    const duration = recipe.seconds * quantity, station = this.game.state.buildings.find((building) => building.id === info.buildingId);
    const legacyProgressUsed = recipeId === 'sashimi' ? clamp(finite(station?.legacySlicerProgress), 0, recipe.seconds) : 0;
    const remaining = Math.max(0, duration - legacyProgressUsed);
    const job = { id: `production-${this.state.nextJobId++}`, buildingId: info.buildingId, recipeId, name: recipe.name, quantity, inputs, outputs, duration, remaining: remaining <= 1e-7 ? 0 : remaining, status: 'queued' };
    this.game._spend(inputs);
    if (legacyProgressUsed > 0) station.legacySlicerProgress = 0;
    this.state.queue.push(job); this._refreshStatuses();
    if (job.status === 'ready') for (const [key, amount] of Object.entries(outputs)) this.game.state.stats.productionGenerated[key] += amount;
    this.game._changed('productionQueued', { job: clone(job), cost: clone(inputs), legacyProgressUsed });
    return { ok: true, job: clone(job), cost: clone(inputs), legacyProgressUsed, message: `${quantity}件${recipe.name}已加入生产队列。` };
  }
  advance(seconds) {
    const produced = {};
    for (const buildingId of new Set(this.state.queue.map((job) => job.buildingId))) {
      let remaining = seconds;
      for (const job of this._jobs(buildingId)) {
        if (job.status === 'ready') continue;
        const used = Math.min(remaining, job.remaining); job.remaining = Math.max(0, job.remaining - used); remaining -= used;
        if (job.remaining <= 1e-7) {
          job.remaining = 0; job.status = 'ready';
          for (const [key, amount] of Object.entries(job.outputs)) { produced[key] = (produced[key] || 0) + amount; this.game.state.stats.productionGenerated[key] += amount; }
        }
        if (remaining <= 1e-7) break;
      }
    }
    this._refreshStatuses(); return produced;
  }
  claim(jobId) {
    const index = this.state.queue.findIndex((job) => job.id === jobId), job = this.state.queue[index];
    if (!job) return { ok: false, message: '这批产物已经领取过，或不存在。' };
    if (job.status !== 'ready') return { ok: false, message: '这批成品还在加工中。' };
    this.state.queue.splice(index, 1);
    this.game._addResources(job.outputs, 'production');
    for (const [key, amount] of Object.entries(job.outputs)) this.state.collected[key] = (this.state.collected[key] || 0) + amount;
    this._refreshStatuses(); this.game._changed('queuedProductionCollected', { jobId, resources: clone(job.outputs) });
    return { ok: true, jobId, resources: clone(job.outputs), message: `已领取${job.name}。` };
  }
}

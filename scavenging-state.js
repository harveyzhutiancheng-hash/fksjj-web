/**
 * Manual scavenging: input-driven movement and pickup collisions are authoritative
 * here. The view only renders snapshots. Map, speed and amounts are project
 * configuration. A recorded tutorial distinguishes stealing fish schools from
 * sharks (three shark hits end a trip). Fish theft amounts, recovery times and
 * returning surviving cargo after failure are protective project rules.
 */
export const SCAVENGING_RESOURCES = Object.freeze(['wood', 'plastic', 'cloth']);
export const SCAVENGING_CONFIG = Object.freeze({
  version: 2,
  capacity: 100,
  maxUpgradeLevel: 10,
  maxTier: 2,
  doubleMultiplier: 2,
  upgradeChanceStep: 0.01,
  speed: 4,
  pickupRadius: 0.9,
  maxStepSeconds: 0.25,
  sharkSpeed: 2.1,
  sharkChaseRadius: 6,
  sharkHitRadius: 1.25,
  sharkFailureHits: 3,
  hitRecoverySeconds: 3,
  fishSpeed: 1.5,
  fishChaseRadius: 4,
  fishStealRadius: 1.6,
  fishLossRatio: 0.2,
  stealRecoverySeconds: 3,
  bounds: Object.freeze({ minX: -18, maxX: 18, minZ: -18, maxZ: 18 }),
  note: '实录1级容量100、加倍倍率200%；每次强化50金币、加倍概率+1%至10%。10%时需建造2艘拾荒船，2级容量200、倍率400%；2级后续成长未实现。移动、地图、鱼群损失与遇险带回货物为项目配置。强化与等级升级立即作用于本趟后续拾取，不重算已装货物或生成新物资。',
});

const VERSION = 2;
const clone = (value) => JSON.parse(JSON.stringify(value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const integer = (value, min, max, fallback = min) => Math.floor(clamp(finite(value, fallback), min, max));
const rounded = (value) => Math.round(value * 1e6) / 1e6;
const emptyCargo = () => Object.fromEntries(SCAVENGING_RESOURCES.map((key) => [key, 0]));
const totalCargo = (cargo) => SCAVENGING_RESOURCES.reduce((sum, key) => sum + cargo[key], 0);
const tripSeed = (sequence) => (Math.imul(sequence, 1664525) + 1013904223) >>> 0 || 1;
const random = (trip) => {
  let value = trip.rngState >>> 0 || 1;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  trip.rngState = value >>> 0;
  return trip.rngState / 4294967296;
};
const validKind = (kind) => SCAVENGING_RESOURCES.includes(kind);
const createSharks = () => [{ id: 'shark-1', x: 12, z: 10, homeX: 12, homeZ: 10, phase: 0, heading: 0 }, { id: 'shark-2', x: -13, z: 10, homeX: -13, homeZ: 10, phase: 2.4, heading: 0 }];
const createFishSchools = () => [{ id: 'fish-school-1', x: 6, z: 6, homeX: 6, homeZ: 6, phase: 1.2, heading: 0 }, { id: 'fish-school-2', x: -7, z: -4, homeX: -7, homeZ: -4, phase: 3.1, heading: 0 }];

function advanceCreature(creature, trip, step, speed, chaseRadius) {
  const distance = Math.hypot(trip.player.x - creature.x, trip.player.z - creature.z), chasing = distance < chaseRadius;
  const targetX = chasing ? trip.player.x : creature.homeX + Math.sin(trip.elapsed * 0.35 + creature.phase) * 2.4;
  const targetZ = chasing ? trip.player.z : creature.homeZ + Math.cos(trip.elapsed * 0.35 + creature.phase) * 2.4;
  const dx = targetX - creature.x, dz = targetZ - creature.z, targetDistance = Math.hypot(dx, dz);
  if (targetDistance <= 1e-7) return;
  const distanceStep = Math.min(targetDistance, speed * (chasing ? 1 : 0.65) * step);
  creature.x = rounded(clamp(creature.x + dx / targetDistance * distanceStep, trip.bounds.minX, trip.bounds.maxX));
  creature.z = rounded(clamp(creature.z + dz / targetDistance * distanceStep, trip.bounds.minZ, trip.bounds.maxZ));
  creature.heading = Math.atan2(dx, dz);
}

export function createScavenging() {
  return { version: VERSION, tier: 1, upgradeLevel: 0, guideSeen: false, nextTripId: 1, trip: null, completedTrips: 0, totalCollected: emptyCargo() };
}

function createTrip(sequence, upgradeLevel = 0, tier = 1) {
  const id = `scavenging-${sequence}`;
  // The first three piles are deliberately within a short joystick movement of
  // the start. Every object is inside the navigable area and can be collected.
  const positions = [[0, 1.8], [0, 3.2], [0, 4.6], [3.7, 4.8], [-4, 4.5], [0, 6.5], [6.7, 2], [-6.5, 1], [4.5, -3.5], [-4.5, -3.5], [0, -6], [8.5, 7], [-8.5, 7], [3, 10], [-3, 10], [10.5, -5.5], [-10.5, -5.5], [0, 13], [13, 3], [13, 6], [13, 9], [-13, 3], [-13, 6], [-13, 9], [13, -3], [13, -6], [13, -9], [-13, -3], [-13, -6], [-13, -9], [6, -10], [0, -11], [-6, -10], [6, 14], [-6, 14], [0, 16]];
  const objects = positions.map(([x, z], index) => {
    const kind = SCAVENGING_RESOURCES[index % SCAVENGING_RESOURCES.length];
    return { id: `${id}-object-${index}`, kind, x, z, amount: { wood: 4, plastic: 3, cloth: 2 }[kind] * tier, collectedAmount: 0, gainedAmount: 0, collected: false };
  });
  return { id, status: 'sailing', tier, capacity: SCAVENGING_CONFIG.capacity * tier, doubleChance: upgradeLevel * SCAVENGING_CONFIG.upgradeChanceStep, doubleMultiplier: SCAVENGING_CONFIG.doubleMultiplier * tier, rngState: tripSeed(sequence), player: { x: 0, z: 0, heading: 0 }, objects, collectedIds: [], sharks: createSharks(), fishSchools: createFishSchools(), cargo: emptyCargo(), lost: emptyCargo(), hits: 0, elapsed: 0, hitUntil: 0, stolenUntil: 0, bounds: { ...SCAVENGING_CONFIG.bounds } };
}

export function normalizeScavenging(raw) {
  const state = createScavenging();
  if (raw === undefined || raw === null) return state;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('拾荒存档格式不完整，已保留原存档。');
  if (finite(raw.version, 1) > VERSION) throw new Error('拾荒进度来自更新版本，已保留原存档。');
  state.upgradeLevel = integer(raw.upgradeLevel, 0, SCAVENGING_CONFIG.maxUpgradeLevel, 0);
  state.tier = integer(raw.tier, 1, SCAVENGING_CONFIG.maxTier, 1);
  if (state.tier === 2) state.upgradeLevel = SCAVENGING_CONFIG.maxUpgradeLevel;
  state.guideSeen = raw.guideSeen === true;
  state.completedTrips = integer(raw.completedTrips, 0, 1e9, 0);
  state.nextTripId = Math.max(integer(raw.nextTripId, 1, 1e9, 1), state.completedTrips + 1);
  for (const key of SCAVENGING_RESOURCES) state.totalCollected[key] = integer(raw.totalCollected?.[key], 0, 1e9, 0);
  if (raw.trip === undefined || raw.trip === null) return state;
  const trip = raw.trip;
  if (typeof trip !== 'object' || Array.isArray(trip) || typeof trip.id !== 'string' || !trip.id || !trip.player || !Array.isArray(trip.objects) || !['sailing', 'failed', 'returned'].includes(trip.status)) throw new Error('拾荒航程存档不完整，已保留原存档。');
  const tripTier = integer(trip.tier, 1, SCAVENGING_CONFIG.maxTier, 1);
  const bounds = { ...SCAVENGING_CONFIG.bounds }, ids = new Set(), collectedIds = new Set(Array.isArray(trip.collectedIds) ? trip.collectedIds : []);
  const objects = trip.objects.slice(0, 90).filter((object) => {
    if (!object || typeof object.id !== 'string' || !object.id || ids.has(object.id) || !validKind(object.kind)) return false;
    ids.add(object.id); return true;
  }).map((object) => {
    const amount = integer(object.amount, 1, 1000, 1);
    // Old trips only stored whole-pile flags. New trips retain a partially taken
    // final pile so reloading cannot duplicate it or erase cargo provenance.
    const collectedAmount = integer(object.collectedAmount, 0, amount, object.collected === true || collectedIds.has(object.id) ? amount : 0);
    const gainedAmount = integer(object.gainedAmount, collectedAmount, collectedAmount * SCAVENGING_CONFIG.doubleMultiplier * tripTier, collectedAmount);
    return { id: object.id, kind: object.kind, x: clamp(finite(object.x), bounds.minX, bounds.maxX), z: clamp(finite(object.z), bounds.minZ, bounds.maxZ), amount, collectedAmount, gainedAmount, collected: collectedAmount >= amount };
  });
  const collectedCargo = emptyCargo();
  for (const object of objects) collectedCargo[object.kind] += object.gainedAmount;
  const collectedObjectIds = new Set(objects.filter((object) => object.collectedAmount > 0).map((object) => object.id));
  const orderedCollectedIds = [...new Set([...collectedIds, ...collectedObjectIds])].filter((id) => collectedObjectIds.has(id));
  const capacity = SCAVENGING_CONFIG.capacity * tripTier, cargo = emptyCargo();
  for (const key of SCAVENGING_RESOURCES) cargo[key] = integer(trip.cargo?.[key], 0, Math.min(collectedCargo[key], capacity - totalCargo(cargo)), 0);
  const sharkIds = new Set();
  const sharks = (Array.isArray(trip.sharks) ? trip.sharks : createSharks()).slice(0, 4).filter((shark) => {
    if (!shark || typeof shark.id !== 'string' || sharkIds.has(shark.id)) return false;
    sharkIds.add(shark.id); return true;
  }).map((shark) => ({ id: shark.id, x: clamp(finite(shark.x), bounds.minX, bounds.maxX), z: clamp(finite(shark.z), bounds.minZ, bounds.maxZ), homeX: clamp(finite(shark.homeX, finite(shark.x)), bounds.minX, bounds.maxX), homeZ: clamp(finite(shark.homeZ, finite(shark.z)), bounds.minZ, bounds.maxZ), phase: finite(shark.phase), heading: finite(shark.heading) }));
  const fishIds = new Set();
  const fishSchools = (Array.isArray(trip.fishSchools) ? trip.fishSchools : createFishSchools()).slice(0, 4).filter((fish) => {
    if (!fish || typeof fish.id !== 'string' || fishIds.has(fish.id)) return false;
    fishIds.add(fish.id); return true;
  }).map((fish) => ({ id: fish.id, x: clamp(finite(fish.x), bounds.minX, bounds.maxX), z: clamp(finite(fish.z), bounds.minZ, bounds.maxZ), homeX: clamp(finite(fish.homeX, finite(fish.x)), bounds.minX, bounds.maxX), homeZ: clamp(finite(fish.homeZ, finite(fish.z)), bounds.minZ, bounds.maxZ), phase: finite(fish.phase), heading: finite(fish.heading) }));
  const hits = integer(trip.hits, 0, SCAVENGING_CONFIG.sharkFailureHits, 0);
  state.trip = {
    id: trip.id, status: trip.status === 'sailing' && hits >= SCAVENGING_CONFIG.sharkFailureHits ? 'failed' : trip.status, tier: tripTier, capacity,
    doubleChance: clamp(finite(trip.doubleChance, state.upgradeLevel * SCAVENGING_CONFIG.upgradeChanceStep), 0, SCAVENGING_CONFIG.maxUpgradeLevel * SCAVENGING_CONFIG.upgradeChanceStep), doubleMultiplier: SCAVENGING_CONFIG.doubleMultiplier * tripTier, rngState: integer(trip.rngState, 1, 4294967295, tripSeed(state.nextTripId)),
    player: { x: clamp(finite(trip.player.x), bounds.minX, bounds.maxX), z: clamp(finite(trip.player.z), bounds.minZ, bounds.maxZ), heading: finite(trip.player.heading) },
    objects, collectedIds: orderedCollectedIds, sharks, fishSchools, cargo,
    lost: Object.fromEntries(SCAVENGING_RESOURCES.map((key) => [key, integer(trip.lost?.[key], 0, collectedCargo[key], 0)])), hits,
    elapsed: Math.max(0, finite(trip.elapsed)), hitUntil: Math.max(0, finite(trip.hitUntil)), stolenUntil: Math.max(0, finite(trip.stolenUntil)), bounds,
  };
  const sequence = /^scavenging-(\d+)$/.exec(trip.id);
  if (sequence) state.nextTripId = Math.max(state.nextTripId, integer(sequence[1], 0, 1e9, 0) + 1);
  return state;
}

export class ScavengingState {
  constructor(game) {
    if (!game?.state) throw new Error('拾荒需要已有 GameState。');
    this.game = game;
    game.state.scavenging = normalizeScavenging(game.state.scavenging);
  }
  get state() { return this.game.state.scavenging; }
  get unlocked() { return this.game.state.buildings.some((building) => building.type === 'scavenger'); }
  getTrip() { return this.state.trip ? clone(this.state.trip) : null; }
  _changed(type, detail = {}, forceSave = true) { this.game._changed(type, detail, forceSave); }

  getUpgrade() {
    const level = this.state.upgradeLevel, tier = this.state.tier, maxLevel = SCAVENGING_CONFIG.maxUpgradeLevel;
    const nextKind = level < maxLevel ? 'enhance' : tier < SCAVENGING_CONFIG.maxTier ? 'tier' : null;
    const cost = nextKind === 'enhance' ? { coin: 50 } : nextKind === 'tier' ? {} : null;
    const missing = cost && this.game.state.resources.coin < cost.coin ? { coin: Math.ceil(cost.coin - this.game.state.resources.coin) } : {};
    const stats = (value, tierValue) => ({ level: value, tier: tierValue, capacity: SCAVENGING_CONFIG.capacity * tierValue, doubleChance: value * SCAVENGING_CONFIG.upgradeChanceStep, doubleMultiplier: SCAVENGING_CONFIG.doubleMultiplier * tierValue });
    const buildingCount = this.game.state.buildings.filter((building) => building.type === 'scavenger').length, requiredBoats = nextKind === 'tier' ? 2 : 0;
    return { ...stats(level, tier), maxLevel, maxTier: SCAVENGING_CONFIG.maxTier, nextKind, requiredBoats, buildingCount, cost, next: nextKind ? stats(nextKind === 'enhance' ? level + 1 : level, nextKind === 'tier' ? tier + 1 : tier) : null, unlocked: this.unlocked, canUpgrade: this.unlocked && !!cost && !Object.keys(missing).length && buildingCount >= requiredBoats, missing, note: SCAVENGING_CONFIG.note };
  }

  upgrade() {
    const info = this.getUpgrade();
    if (!info.unlocked) return { ok: false, message: '先建造拾荒船，再强化拾荒装备。' };
    if (!info.cost) return { ok: false, message: '拾荒装备已达到本项目当前最高强化等级。' };
    if (info.buildingCount < info.requiredBoats) return { ok: false, requiredBoats: info.requiredBoats, buildingCount: info.buildingCount, message: '建造 2 艘拾荒船后才能解锁 2 级拾荒。' };
    if (!info.canUpgrade) return { ok: false, cost: info.cost, missing: info.missing, message: `强化还需要 ${info.missing.coin} 金币。` };
    this.game._spend(info.cost);
    if (info.nextKind === 'tier') this.state.tier += 1; else this.state.upgradeLevel += 1;
    if (this.state.trip?.status === 'sailing') Object.assign(this.state.trip, { tier: this.state.tier, capacity: SCAVENGING_CONFIG.capacity * this.state.tier, doubleChance: this.state.upgradeLevel * SCAVENGING_CONFIG.upgradeChanceStep, doubleMultiplier: SCAVENGING_CONFIG.doubleMultiplier * this.state.tier });
    this._changed('scavengingUpgraded', { tier: this.state.tier, level: this.state.upgradeLevel, cost: info.cost });
    return { ok: true, cost: info.cost, upgrade: this.getUpgrade(), message: info.nextKind === 'tier' ? '拾荒升至 2 级，仓库容量 200、加倍倍率 400%。' : `拾荒强化完成，加倍概率升至 ${this.state.upgradeLevel}%。后续拾取立即生效。` };
  }

  markGuideSeen() {
    if (!this.state.guideSeen) { this.state.guideSeen = true; this._changed('scavengingGuideSeen'); }
    return { ok: true, guideSeen: true, message: '拖动摇杆拾取物资，避开鱼群和鲨鱼。' };
  }

  start() {
    if (!this.unlocked) return { ok: false, message: '先建造拾荒船，再驾驶它去海面收集物资。' };
    if (['sailing', 'failed'].includes(this.state.trip?.status)) return { ok: true, resumed: true, failed: this.state.trip.status === 'failed', tripId: this.state.trip.id, trip: this.getTrip(), message: this.state.trip.status === 'failed' ? '这次拾荒已中止，先将剩余货物带回营地。' : '继续上次的拾荒航程。' };
    const trip = createTrip(this.state.nextTripId++, this.state.upgradeLevel, this.state.tier);
    this.state.trip = trip;
    this._changed('scavengingStarted', { tripId: trip.id });
    return { ok: true, resumed: false, tripId: trip.id, trip: this.getTrip(), message: '靠近漂浮物自动拾取，返航后物资才会入库。' };
  }

  move(input = {}, dt = 0) {
    const trip = this.state.trip;
    if (!trip || trip.status !== 'sailing') return { ok: false, failed: trip?.status === 'failed', picked: [], collected: [], hit: null, stolen: null, events: [], message: trip?.status === 'failed' ? '被鲨鱼撞击三次，本次拾荒已中止。' : '当前没有进行中的拾荒航程。' };
    const seconds = clamp(finite(dt), 0, SCAVENGING_CONFIG.maxStepSeconds);
    const picked = [], events = [];
    let hit = null, stolen = null;
    if (!seconds) return { ok: true, failed: false, moved: false, picked, collected: picked, hit: null, stolen: null, events, message: '' };
    const x = finite(input?.x), z = finite(input?.z), length = Math.hypot(x, z), scale = length > 1 ? 1 / length : 1;
    const dx = x * scale, dz = z * scale;
    const before = { ...trip.player };
    if (length > 1e-7) trip.player.heading = Math.atan2(dx, dz);
    let remaining = seconds;
    while (remaining > 1e-8) {
      const step = Math.min(0.025, remaining);
      trip.player.x = rounded(clamp(trip.player.x + dx * SCAVENGING_CONFIG.speed * step, trip.bounds.minX, trip.bounds.maxX));
      trip.player.z = rounded(clamp(trip.player.z + dz * SCAVENGING_CONFIG.speed * step, trip.bounds.minZ, trip.bounds.maxZ));
      trip.elapsed = rounded(trip.elapsed + step);
      for (const object of trip.objects) {
        if (object.collected || Math.hypot(object.x - trip.player.x, object.z - trip.player.z) > SCAVENGING_CONFIG.pickupRadius) continue;
        const free = Math.max(0, trip.capacity - totalCargo(trip.cargo));
        if (!free) continue;
        const multiplier = random(trip) < trip.doubleChance ? trip.doubleMultiplier : 1;
        const baseAmount = Math.min(object.amount - object.collectedAmount, Math.ceil(free / multiplier));
        const amount = Math.min(baseAmount * multiplier, free);
        if (amount <= 0) continue;
        object.collectedAmount += baseAmount; object.gainedAmount = (object.gainedAmount || 0) + amount; object.collected = object.collectedAmount >= object.amount;
        if (!trip.collectedIds.includes(object.id)) trip.collectedIds.push(object.id);
        trip.cargo[object.kind] += amount;
        const item = { id: object.id, kind: object.kind, amount, baseAmount, multiplier };
        picked.push(item); events.push({ type: 'pickup', ...item, at: trip.elapsed });
      }
      for (const shark of trip.sharks) {
        advanceCreature(shark, trip, step, SCAVENGING_CONFIG.sharkSpeed, SCAVENGING_CONFIG.sharkChaseRadius);
        if (trip.elapsed < trip.hitUntil || Math.hypot(trip.player.x - shark.x, trip.player.z - shark.z) > SCAVENGING_CONFIG.sharkHitRadius) continue;
        trip.hits += 1; trip.hitUntil = rounded(trip.elapsed + SCAVENGING_CONFIG.hitRecoverySeconds);
        hit = { type: 'hit', sharkId: shark.id, at: trip.elapsed, hits: trip.hits };
        events.push(hit);
        if (trip.hits >= SCAVENGING_CONFIG.sharkFailureHits) { trip.status = 'failed'; events.push({ type: 'failed', at: trip.elapsed }); break; }
      }
      if (trip.status === 'failed') break;
      for (const school of trip.fishSchools) {
        advanceCreature(school, trip, step, SCAVENGING_CONFIG.fishSpeed, SCAVENGING_CONFIG.fishChaseRadius);
        if (trip.elapsed < trip.stolenUntil || Math.hypot(trip.player.x - school.x, trip.player.z - school.z) > SCAVENGING_CONFIG.fishStealRadius || !Object.values(trip.cargo).some((amount) => amount > 0)) continue;
        const lost = emptyCargo();
        for (const key of SCAVENGING_RESOURCES) { lost[key] = Math.ceil(trip.cargo[key] * SCAVENGING_CONFIG.fishLossRatio); trip.cargo[key] -= lost[key]; trip.lost[key] += lost[key]; }
        trip.stolenUntil = rounded(trip.elapsed + SCAVENGING_CONFIG.stealRecoverySeconds);
        stolen = { type: 'stolen', schoolId: school.id, at: trip.elapsed, lost };
        events.push(stolen);
      }
      remaining -= step;
    }
    // Position updates are intentionally silent: GameState's normal save captures
    // the current trip, and explicit hide/exit saves retain the latest position.
    const failed = trip.status === 'failed';
    if (picked.length || hit || stolen) this._changed(hit ? failed ? 'scavengingFailed' : 'scavengingHit' : stolen ? 'scavengingStolen' : 'scavengingPicked', { tripId: trip.id, picked: clone(picked), hit: clone(hit), stolen: clone(stolen) });
    return { ok: true, failed, moved: trip.player.x !== before.x || trip.player.z !== before.z, picked, collected: picked, hit, stolen, events, message: '' };
  }

  returnToCamp() {
    const trip = this.state.trip;
    if (!trip || !['sailing', 'failed'].includes(trip.status)) return { ok: false, alreadyReturned: trip?.status === 'returned', resources: emptyCargo(), message: '这次航程已经返航，物资不会重复入库。' };
    const failed = trip.status === 'failed';
    const resources = { ...trip.cargo };
    // Settle the same record before notifying observers or attempting persistence.
    trip.status = 'returned';
    this.game._addResources(resources, 'salvage');
    this.game.state.stats.salvageCount += trip.collectedIds.length;
    this.state.completedTrips += 1;
    for (const key of SCAVENGING_RESOURCES) this.state.totalCollected[key] += resources[key];
    this._changed('scavengingReturned', { tripId: trip.id, resources: clone(resources) });
    return { ok: true, failed, tripId: trip.id, resources, lost: clone(trip.lost), trip: this.getTrip(), message: failed ? '遇险返航，本次拾荒中止；已收货物带回。' : Object.values(resources).some((amount) => amount > 0) ? '返航成功，木头、塑料和碎布已送入仓库。' : '已返回营地，下次再去寻找物资。' };
  }
}

/**
 * Input-driven, side-view diving. Positive y is downward. The recorded opening
 * has sixty seconds of oxygen and supplies scrap, glass and seaweed. Map layout,
 * speed, pickup radius and pile quantities are playable project configuration.
 * Running out of oxygen surfaces the diver with cargo intact; returning settles
 * that cargo once. No wall clock or ordinary camp tick advances a dive.
 */
export const DIVING_RESOURCES = Object.freeze(['scrap', 'glass', 'seaweed']);
export const DIVING_CONFIG = Object.freeze({
  version: 1,
  oxygenCapacity: 60,
  speed: 4,
  pickupRadius: 0.9,
  maxStepSeconds: 0.25,
  checkpointSeconds: 5,
  bounds: Object.freeze({ minX: -16, maxX: 16, minY: 0, maxY: 28 }),
  note: '初级氧气60秒和废金属、玻璃、海藻来源参考公开实录。地图、移动速度、每堆数量与氧气耗尽后保留货物上浮为本项目配置；返航时才入库，不设置未经证实的失败丢货。',
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const integer = (value, fallback = 0) => Math.floor(clamp(finite(value, fallback), 0, 1e9));
const rounded = (value) => Math.round(value * 1e6) / 1e6;
const emptyCargo = () => Object.fromEntries(DIVING_RESOURCES.map((key) => [key, 0]));
const invalid = () => { throw new Error('潜水航程存档不完整，已保留原存档。'); };

export function createDiving() {
  return { version: DIVING_CONFIG.version, guideSeen: false, nextTripId: 1, trip: null, completedTrips: 0, totalCollected: emptyCargo() };
}

function createTrip(sequence) {
  const id = `diving-${sequence}`;
  const positions = [[0, 1.8], [0, 3.2], [0, 4.6], [3, 5.5], [-3, 5.5], [0, 7.5], [6, 8], [-6, 8], [0, 10.5], [9, 11], [-9, 11], [3, 13], [-3, 13], [6, 15.5], [-6, 15.5], [0, 17], [12, 18], [-12, 18], [3, 20], [-3, 20], [8, 22], [-8, 22], [0, 24], [4, 25]];
  const objects = positions.map(([x, y], index) => {
    const kind = DIVING_RESOURCES[index % DIVING_RESOURCES.length];
    return { id: `${id}-object-${index}`, kind, x, y, amount: { scrap: 4, glass: 3, seaweed: 5 }[kind], collected: false };
  });
  return { id, status: 'diving', player: { x: 0, y: 0, heading: 0 }, objects, cargo: emptyCargo(), oxygenRemaining: DIVING_CONFIG.oxygenCapacity, oxygenCapacity: DIVING_CONFIG.oxygenCapacity, elapsed: 0, bounds: { ...DIVING_CONFIG.bounds } };
}

export function normalizeDiving(raw) {
  const state = createDiving();
  if (raw == null) return state;
  if (typeof raw !== 'object' || Array.isArray(raw)) invalid();
  if (finite(raw.version, 1) > DIVING_CONFIG.version) throw new Error('潜水进度来自更新版本，已保留原存档。');
  state.guideSeen = raw.guideSeen === true;
  state.completedTrips = integer(raw.completedTrips);
  state.nextTripId = Math.max(1, integer(raw.nextTripId, 1), state.completedTrips + 1);
  for (const key of DIVING_RESOURCES) state.totalCollected[key] = integer(raw.totalCollected?.[key]);
  if (raw.trip == null) return state;
  const trip = raw.trip;
  if (typeof trip !== 'object' || Array.isArray(trip) || typeof trip.id !== 'string' || !trip.id || !['diving', 'surfaced', 'returned'].includes(trip.status) || !trip.player || !Array.isArray(trip.objects) || trip.objects.length > 90 || !trip.cargo || !Number.isFinite(trip.oxygenRemaining) || !Number.isFinite(trip.oxygenCapacity) || !Number.isFinite(trip.elapsed)) invalid();
  const bounds = { ...DIVING_CONFIG.bounds }, ids = new Set(), collectedCargo = emptyCargo();
  const objects = trip.objects.map((object) => {
    if (!object || typeof object.id !== 'string' || !object.id || ids.has(object.id) || !DIVING_RESOURCES.includes(object.kind) || !Number.isFinite(object.x) || !Number.isFinite(object.y) || !Number.isInteger(object.amount) || object.amount < 1 || object.amount > 1000 || typeof object.collected !== 'boolean') invalid();
    ids.add(object.id);
    if (object.collected) collectedCargo[object.kind] += object.amount;
    return { id: object.id, kind: object.kind, x: clamp(object.x, bounds.minX, bounds.maxX), y: clamp(object.y, bounds.minY, bounds.maxY), amount: object.amount, collected: object.collected };
  });
  if (Object.keys(trip.cargo).some((key) => !DIVING_RESOURCES.includes(key)) || DIVING_RESOURCES.some((key) => trip.cargo[key] !== collectedCargo[key]) || !Number.isFinite(trip.player.x) || !Number.isFinite(trip.player.y) || trip.oxygenCapacity !== DIVING_CONFIG.oxygenCapacity || trip.oxygenRemaining < 0 || trip.oxygenRemaining > trip.oxygenCapacity || trip.elapsed < 0 || Math.abs(trip.elapsed + trip.oxygenRemaining - trip.oxygenCapacity) > 1e-4) invalid();
  const status = trip.status === 'diving' && trip.oxygenRemaining <= 0 ? 'surfaced' : trip.status;
  if (status === 'surfaced' && trip.oxygenRemaining > 0) invalid();
  state.trip = { id: trip.id, status, player: { x: clamp(trip.player.x, bounds.minX, bounds.maxX), y: status === 'surfaced' ? 0 : clamp(trip.player.y, bounds.minY, bounds.maxY), heading: finite(trip.player.heading) }, objects, cargo: collectedCargo, oxygenRemaining: trip.oxygenRemaining, oxygenCapacity: trip.oxygenCapacity, elapsed: trip.elapsed, bounds };
  const sequence = /^diving-(\d+)$/.exec(trip.id);
  if (sequence) state.nextTripId = Math.max(state.nextTripId, integer(sequence[1]) + 1);
  return state;
}

export class DivingState {
  constructor(game) {
    if (!game?.state) throw new Error('潜水需要已有 GameState。');
    this.game = game;
    game.state.diving = normalizeDiving(game.state.diving);
    this._checkpointTripId = null;
    this._checkpointElapsed = 0;
  }
  get state() { return this.game.state.diving; }
  get unlocked() { return this.game.state.buildings.some((building) => building.type === 'divingDock' && (typeof this.game.isBuildingReady !== 'function' || this.game.isBuildingReady(building.id))); }
  getTrip() { return this.state.trip ? clone(this.state.trip) : null; }
  markGuideSeen() {
    if (!this.state.guideSeen) { this.state.guideSeen = true; this.game._changed('divingGuideSeen'); }
    return { ok: true, guideSeen: true, message: '拖动摇杆下潜收集物资，留意氧气，返航后货物入库。' };
  }
  start() {
    // An existing paid-for trip remains resumable even if its entry facility is
    // unavailable in a compatibility snapshot. It cannot create another reward.
    const existing = this.state.trip;
    if (existing && ['diving', 'surfaced'].includes(existing.status)) return { ok: true, resumed: true, surfaced: existing.status === 'surfaced', tripId: existing.id, trip: this.getTrip(), message: existing.status === 'surfaced' ? '已上浮，先把收集到的货物带回营地。' : '继续上次的潜水。' };
    if (!this.unlocked) return { ok: false, message: '先建造潜水船坞，再进入水下收集物资。' };
    const trip = createTrip(this.state.nextTripId++);
    this.state.trip = trip;
    this._checkpointTripId = trip.id; this._checkpointElapsed = 0;
    this.game._changed('divingStarted', { tripId: trip.id });
    return { ok: true, resumed: false, surfaced: false, tripId: trip.id, trip: this.getTrip(), message: '靠近物资自动收集，初级氧气可维持60秒。' };
  }
  move(input = {}, dt = 0) {
    const trip = this.state.trip;
    if (!trip || trip.status !== 'diving') return { ok: false, picked: [], events: [], surfaced: trip?.status === 'surfaced', message: trip?.status === 'surfaced' ? '氧气用尽，已经上浮。请返航领取货物。' : '当前没有进行中的潜水。' };
    const seconds = Math.min(clamp(finite(dt), 0, DIVING_CONFIG.maxStepSeconds), trip.oxygenRemaining), picked = [], events = [];
    if (!seconds) return { ok: true, moved: false, picked, events, surfaced: false, oxygenRemaining: trip.oxygenRemaining, message: '' };
    const x = finite(input?.x), y = finite(input?.y), length = Math.hypot(x, y), scale = length > 1 ? 1 / length : 1, dx = x * scale, dy = y * scale;
    const before = { ...trip.player };
    if (length > 1e-7) trip.player.heading = Math.atan2(dx, dy);
    let remaining = seconds;
    while (remaining > 1e-8) {
      const step = Math.min(0.025, remaining);
      trip.player.x = rounded(clamp(trip.player.x + dx * DIVING_CONFIG.speed * step, trip.bounds.minX, trip.bounds.maxX));
      trip.player.y = rounded(clamp(trip.player.y + dy * DIVING_CONFIG.speed * step, trip.bounds.minY, trip.bounds.maxY));
      trip.elapsed = rounded(trip.elapsed + step);
      trip.oxygenRemaining = rounded(Math.max(0, trip.oxygenCapacity - trip.elapsed));
      for (const object of trip.objects) {
        if (object.collected || Math.hypot(object.x - trip.player.x, object.y - trip.player.y) > DIVING_CONFIG.pickupRadius) continue;
        object.collected = true; trip.cargo[object.kind] += object.amount;
        const item = { id: object.id, kind: object.kind, amount: object.amount };
        picked.push(item); events.push({ type: 'pickup', ...item, at: trip.elapsed });
      }
      remaining -= step;
    }
    const surfaced = trip.oxygenRemaining <= 0;
    if (surfaced) { trip.status = 'surfaced'; trip.player.y = 0; events.push({ type: 'surface', reason: 'oxygen', at: trip.elapsed }); }
    if (picked.length || surfaced) {
      this.game._changed(surfaced ? 'divingSurfaced' : 'divingPicked', { tripId: trip.id, picked: clone(picked), surfaced });
      this._checkpointTripId = trip.id; this._checkpointElapsed = trip.elapsed;
    } else if (this._checkpointTripId !== trip.id || trip.elapsed - this._checkpointElapsed >= DIVING_CONFIG.checkpointSeconds) {
      // Save a checkpoint without asking the camp UI to rerender each RAF.
      this.game.save(); this._checkpointTripId = trip.id; this._checkpointElapsed = trip.elapsed;
    }
    return { ok: true, moved: trip.player.x !== before.x || trip.player.y !== before.y, picked, events, surfaced, oxygenRemaining: trip.oxygenRemaining, message: surfaced ? '氧气用尽，已经上浮。货物保留，请返航入库。' : '' };
  }
  returnToCamp() {
    const trip = this.state.trip;
    if (!trip || !['diving', 'surfaced'].includes(trip.status)) return { ok: false, alreadyReturned: trip?.status === 'returned', resources: emptyCargo(), message: '这趟潜水已经返航，物资不会重复入库。' };
    const surfaced = trip.status === 'surfaced', resources = { ...trip.cargo };
    trip.status = 'returned';
    this.state.completedTrips += 1;
    for (const key of DIVING_RESOURCES) this.state.totalCollected[key] += resources[key];
    this.game._addResources(resources, 'salvage');
    const snapshot = this.getTrip();
    this.game._changed('divingReturned', { tripId: trip.id, resources: clone(resources), surfaced });
    return { ok: true, tripId: trip.id, resources, surfaced, trip: snapshot, message: '已返回营地，废金属、玻璃与海藻已送入仓库。' };
  }
}

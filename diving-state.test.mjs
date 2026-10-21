import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState, BUILDINGS, QUESTS, CONTINUATION_QUESTS } from './game-state.js';
import { createDiving, normalizeDiving, DivingState, DIVING_CONFIG } from './diving-state.js';
import { SEAWEED_JUICE_RECIPE, RECIPES } from './production-state.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function memoryStorage() { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }
// Test the independent module's dock gate without inventing a BUILDINGS price.
function host(hasDock = true) {
  const game = { state: { diving: createDiving(), buildings: hasDock ? [{ id: 'dock', type: 'divingDock' }] : [], resources: { scrap: 0, glass: 0, seaweed: 0 } }, events: [], saves: 0,
    _changed(type, detail = {}) { this.events.push({ type, ...detail }); this.save(); this.listener?.(type, detail); },
    save() { this.saves++; return { ok: true }; },
    _addResources(resources) { for (const [key, amount] of Object.entries(resources)) this.state.resources[key] += amount; },
  };
  const diving = new DivingState(game);
  return { game, diving };
}
function collectIntro(diving) {
  assert.equal(diving.start().ok, true);
  assert.deepEqual(diving.getTrip().cargo, { scrap: 0, glass: 0, seaweed: 0 });
  for (let index = 0; index < 20; index++) diving.move({ x: 0, y: 1 }, 0.05);
  const trip = diving.getTrip();
  assert.deepEqual(trip.cargo, { scrap: 4, glass: 3, seaweed: 5 });
  assert.equal(trip.oxygenRemaining, 59);
  return trip;
}

test('diving requires its own dock while the once-only guide survives GameState saves and resets', () => {
  const { game, diving } = host(false), before = clone(game.state);
  assert.equal(diving.start().ok, false); assert.equal(diving.move({ y: 1 }, 1).ok, false); assert.equal(diving.returnToCamp().ok, false);
  assert.deepEqual(game.state, before); assert.equal(diving.getTrip(), null);
  const storage = memoryStorage(), camp = new GameState({ storage, autoLoad: false, now: () => 1_000_000 }), events = [];
  camp.onChange((state, event) => events.push(event.type), { immediate: false });
  assert.equal(camp.startDiving().ok, false);
  camp.markDivingGuideSeen(); camp.markDivingGuideSeen();
  assert.deepEqual(events, ['divingGuideSeen']);
  const restored = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(restored.state.diving.guideSeen, true);
  restored.reset(); assert.deepEqual(restored.state.diving, createDiving());
});

test('actual downward motion collects three distinct materials and manual return credits exactly once even during an event callback', () => {
  const { game, diving } = host(), trip = collectIntro(diving);
  assert.deepEqual(game.state.resources, { scrap: 0, glass: 0, seaweed: 0 });
  assert.equal(trip.objects.length, 24); assert.equal(trip.objects.filter((object) => object.collected).length, 3);
  const snapshot = diving.getTrip(); snapshot.cargo.glass = 999; snapshot.objects[0].collected = false;
  assert.deepEqual(diving.getTrip().cargo, trip.cargo);
  for (let index = 0; index < 10; index++) diving.move({}, 0.05);
  assert.deepEqual(diving.getTrip().cargo, trip.cargo);
  const nested = []; game.listener = (type) => { if (type === 'divingReturned') nested.push(diving.returnToCamp().ok); };
  const result = diving.returnToCamp();
  assert.equal(result.ok, true); assert.equal(result.surfaced, false); assert.deepEqual(result.resources, trip.cargo);
  assert.deepEqual(nested, [false]); assert.deepEqual(game.state.resources, trip.cargo);
  assert.equal(game.state.diving.completedTrips, 1); assert.deepEqual(game.state.diving.totalCollected, trip.cargo);
  const settled = clone(game.state); assert.equal(diving.returnToCamp().ok, false); assert.deepEqual(game.state, settled);
  assert.equal(diving.start().tripId, 'diving-2'); assert.deepEqual(diving.getTrip().cargo, { scrap: 0, glass: 0, seaweed: 0 });
});

test('input normalization, bounded dt and silent movement checkpoints prevent tab-time jumps and per-frame camp rerenders', () => {
  const { game, diving } = host(); diving.start();
  diving.move({ x: -1000, y: -1000 }, 1000);
  let trip = diving.getTrip();
  assert.equal(trip.elapsed, 0.25); assert.ok(Math.abs(trip.player.x) <= DIVING_CONFIG.speed * 0.25);
  assert.equal(trip.player.y, 0);
  const before = diving.getTrip(); diving.move({ y: 1 }, -100); diving.move({ y: 1 }, NaN); assert.deepEqual(diving.getTrip(), before);
  for (let index = 0; index < 24; index++) diving.move({ x: -1 }, 0.25);
  trip = diving.getTrip(); assert.equal(trip.player.x, trip.bounds.minX); assert.equal(trip.elapsed, 6.25);
  assert.deepEqual(game.events.map((event) => event.type), ['divingStarted']);
  assert.equal(game.saves, 2, 'A five-second position checkpoint saves without a change event');
  const stable = diving.getTrip(); assert.deepEqual(diving.getTrip(), stable, 'No movement call means no oxygen or position change');
});

test('sixty active seconds automatically surface without losing or crediting cargo and restored surface settles once', () => {
  const { game, diving } = host(), intro = collectIntro(diving);
  let last;
  for (let index = 0; index < 236; index++) last = diving.move({}, 0.25);
  assert.equal(last.surfaced, true); assert.ok(last.events.some((event) => event.type === 'surface' && event.reason === 'oxygen'));
  const trip = diving.getTrip(); assert.equal(trip.elapsed, 60); assert.equal(trip.oxygenRemaining, 0); assert.equal(trip.status, 'surfaced'); assert.equal(trip.player.y, 0);
  assert.deepEqual(trip.cargo, intro.cargo); assert.deepEqual(game.state.resources, { scrap: 0, glass: 0, seaweed: 0 });
  assert.equal(diving.move({ y: 1 }, 1).ok, false); assert.deepEqual(diving.getTrip(), trip);
  assert.equal(game.events.filter((event) => event.type === 'divingSurfaced').length, 1);
  const resumed = host(); resumed.game.state.diving = normalizeDiving(clone(game.state.diving));
  assert.equal(resumed.diving.start().resumed, true); assert.equal(resumed.diving.start().surfaced, true);
  assert.equal(resumed.diving.returnToCamp().surfaced, true); assert.deepEqual(resumed.game.state.resources, intro.cargo);
  assert.equal(resumed.diving.returnToCamp().ok, false);
});

test('camp ticks, three-hour offline loading and refresh preserve the exact dive and never recollect or repay its cargo', () => {
  const { game: source, diving } = host(), trip = collectIntro(diving);
  const storage = memoryStorage(); let now = 1_000_000;
  const camp = new GameState({ storage, autoLoad: false, now: () => now });
  camp.state.diving = clone(source.state.diving); camp.tick(120); assert.deepEqual(camp.getDiving(), trip);
  camp.save(); now += 3 * 60 * 60 * 1000;
  const restored = new GameState({ storage, now: () => now });
  assert.equal(restored.persistenceLocked, false); assert.deepEqual(restored.getDiving(), trip); assert.equal(restored.startDiving().resumed, true);
  const before = clone(restored.state.resources); restored.moveDiving({}, 0.25);
  assert.deepEqual(restored.getDiving().cargo, trip.cargo, 'Collected node flags survive an actual reload');
  const result = restored.returnDiving(); assert.equal(result.ok, true); assert.deepEqual(result.resources, trip.cargo);
  for (const key of ['scrap', 'glass', 'seaweed']) {
    assert.equal(restored.state.resources[key], before[key] + trip.cargo[key]);
    assert.equal(restored.state.stats.salvageCollected[key], trip.cargo[key]); assert.equal(restored.state.stats.totalCollected[key], trip.cargo[key]);
  }
  const again = new GameState({ storage, now: () => now });
  assert.equal(again.returnDiving().ok, false); assert.equal(again.state.diving.completedTrips, 1); assert.deepEqual(again.state.resources, restored.state.resources);
  assert.deepEqual(again.getDiving().cargo, trip.cargo); assert.equal(again.getDiving().status, 'returned');
});

test('v0.8 and earlier production saves preserve both fourteen-step reward histories and already-paid batch snapshots', () => {
  for (const version of [1, 2, 3, 4]) {
    const storage = memoryStorage(), game = new GameState({ storage, autoLoad: false, now: () => 1_000_000 });
    game.state.quests.claimed = QUESTS.map((quest) => quest.id); game.state.completed = true;
    game.state.continuation.claimed = CONTINUATION_QUESTS.map((quest) => quest.id);
    Object.assign(game.state.resources, { wood: 100, plastic: 100, cloth: 100 });
    const factory = game.placeBuilding('materials', 1, 0); assert.equal(factory.ok, true);
    const queued = game.queueProduction('fabric'); assert.equal(queued.ok, true);
    const raw = JSON.parse(storage.getItem('fkssj-save-v1')); raw.production.version = version; delete raw.diving;
    for (const key of ['glass', 'seaweed', 'seaweedJuice']) {
      delete raw.resources[key]; delete raw.production.collected[key];
      for (const category of ['totalCollected', 'salvageCollected', 'productionGenerated', 'productionCollected']) delete raw.stats[category][key];
    }
    Object.assign(raw.production.queue[0], { duration: 30, remaining: 12, inputs: { cloth: 3 } });
    const job = clone(raw.production.queue[0]), cloth = raw.resources.cloth;
    storage.setItem('fkssj-save-v1', JSON.stringify(raw));
    const restored = new GameState({ storage, now: () => 1_000_000 });
    assert.equal(restored.persistenceLocked, false); assert.equal(restored.state.production.version, 6);
    assert.deepEqual(restored.state.diving, createDiving()); assert.deepEqual(restored.state.quests.claimed, raw.quests.claimed); assert.deepEqual(restored.state.continuation.claimed, raw.continuation.claimed);
    assert.deepEqual(restored.state.production.queue[0], job);
    for (const key of ['glass', 'seaweed', 'seaweedJuice']) assert.equal(restored.state.resources[key], 0);
    restored.tick(12); assert.equal(restored.claimQueuedProduction(job.id).ok, true); assert.equal(restored.state.resources.cloth, cloth);
    assert.equal(restored.claimContinuationQuest('collector-grilled-fish').ok, false);
  }
});

test('future and damaged dive records protect original raw saves through auto-save attempts until an explicit reset', () => {
  assert.throws(() => normalizeDiving({ version: 2 }), /更新版本/);
  const { game: source, diving } = host(); collectIntro(diving);
  for (const change of [(raw) => { raw.diving.version = 2; }, (raw) => { raw.diving.trip.cargo.glass = 999; }, (raw) => { raw.diving.trip.objects[0].kind = 'future-resource'; }]) {
    const storage = memoryStorage(); let now = 1_000_000;
    const camp = new GameState({ storage, autoLoad: false, now: () => now }); camp.state.diving = clone(source.state.diving); camp.save();
    const raw = JSON.parse(storage.getItem('fkssj-save-v1')); change(raw); const original = JSON.stringify(raw); storage.setItem('fkssj-save-v1', original);
    const locked = new GameState({ storage, now: () => now }); assert.equal(locked.persistenceLocked, true);
    now += 6000; locked.tick(6); locked.collect('wood'); assert.equal(locked.save().persisted, false); assert.equal(storage.getItem('fkssj-save-v1'), original);
    locked.reset(); assert.equal(locked.persistenceLocked, false); assert.deepEqual(locked.state.diving, createDiving()); assert.equal(locked.save().persisted, true);
  }
});

test('seaweed juice uses the recorded formula and the explicit level-two unlock while construction notes disclose compatibility limits', () => {
  assert.deepEqual(SEAWEED_JUICE_RECIPE.inputs, { seaweed: 20, glass: 10 }); assert.deepEqual(SEAWEED_JUICE_RECIPE.outputs, { seaweedJuice: 1 });
  assert.equal(SEAWEED_JUICE_RECIPE.seconds, 1200); assert.equal(SEAWEED_JUICE_RECIPE.storage, 50); assert.equal(SEAWEED_JUICE_RECIPE.minBuildingLevel, 2);
  assert.equal(RECIPES.some((recipe) => recipe.id === 'seaweedJuice'), true);
  assert.deepEqual(BUILDINGS.broadcast.cost, { wood: 60, plastic: 60 }); assert.match(BUILDINGS.broadcast.note, /尚未确认/);
  assert.deepEqual(BUILDINGS.divingDock.cost, { coin: 1500 }); assert.match(BUILDINGS.divingDock.note, /完整材料表及其他成本未核实/);
  const game = new GameState({ storage: null, autoLoad: false }); game.state.completed = true;
  Object.assign(game.state.resources, { wood: 100, scrap: 100, coin: 1500, fish: 200 });
  const kitchen = game.placeBuilding('seafoodKitchen', 1, 0); assert.equal(kitchen.ok, true);
  const before = game.getRecipes(kitchen.id).find((recipe) => recipe.id === 'seaweedJuice'); assert.equal(before.unlocked, false); assert.match(before.reason, /2级/);
  assert.equal(game.upgradeBuilding(kitchen.id).ok, true); assert.equal(game.getRecipes(kitchen.id).find((recipe) => recipe.id === 'seaweedJuice').unlocked, false);
  game.tick(1200); assert.equal(game.getRecipes(kitchen.id).find((recipe) => recipe.id === 'seaweedJuice').unlocked, true);
});

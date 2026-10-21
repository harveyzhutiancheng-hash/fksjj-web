import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState, BUILDINGS } from './game-state.js';
import { createScavenging, normalizeScavenging, SCAVENGING_CONFIG } from './scavenging-state.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function boatGame(options = {}) {
  const game = new GameState({ storage: null, autoLoad: false, now: () => 1_000_000, ...options });
  for (const [key, amount] of Object.entries(BUILDINGS.scavenger.cost)) while (game.state.resources[key] < amount) game.collect(key);
  assert.equal(game.placeBuilding('scavenger', 1, 0).ok, true);
  return game;
}
function collectIntro(game) {
  assert.equal(game.startScavenging().ok, true);
  for (let index = 0; index < 20; index++) game.moveScavenging({ x: 0, z: 1 }, 0.05);
  const trip = game.getScavenging();
  assert.deepEqual(trip.cargo, { wood: 4, plastic: 3, cloth: 2 });
  return trip;
}
const creatureAt = (id, x, z) => ({ id, x, z, homeX: x, homeZ: z, phase: 0, heading: 0 });

test('scavenging requires a boat and its first guide is saved once independently of a trip', () => {
  const storage = memoryStorage(), game = new GameState({ storage, autoLoad: false, now: () => 1_000_000 });
  const before = game.getState();
  assert.equal(game.startScavenging().ok, false);
  assert.equal(game.moveScavenging({ x: 1, z: 0 }, 1).ok, false);
  assert.equal(game.returnScavenging().ok, false);
  assert.deepEqual(game.getState(), before);
  assert.equal(game.getScavenging(), null);
  const events = [];
  game.onChange((state, event) => events.push(event.type), { immediate: false });
  assert.equal(game.state.scavenging.guideSeen, false);
  game.markScavengingGuideSeen(); game.markScavengingGuideSeen();
  assert.deepEqual(events, ['scavengingGuideSeen']);
  assert.equal(new GameState({ storage, now: () => 1_000_000 }).state.scavenging.guideSeen, true);
});

test('real joystick motion picks all three distinct materials into cargo and only returning credits the camp once', () => {
  const game = boatGame(), before = clone(game.state.resources), salvageCount = game.state.stats.salvageCount;
  const collectedBefore = clone(game.state.stats.salvageCollected), totalsBefore = clone(game.state.stats.totalCollected);
  const trip = collectIntro(game);
  assert.equal(trip.objects.length, 36);
  assert.equal(trip.objects.reduce((sum, object) => sum + object.amount, 0), 108);
  assert.equal(trip.capacity, 100);
  assert.equal(trip.collectedIds.length, 3);
  assert.deepEqual(game.state.resources, before);
  const savedCopy = game.getScavenging(); savedCopy.cargo.wood = 9999; savedCopy.objects[0].collected = false;
  assert.deepEqual(game.getScavenging().cargo, trip.cargo, 'Views cannot mutate authoritative cargo');
  for (let index = 0; index < 10; index++) game.moveScavenging({ x: 0, z: 0 }, 0.05);
  assert.deepEqual(game.getScavenging().cargo, trip.cargo, 'A collected object cannot be collected a second time');
  const result = game.returnScavenging();
  assert.equal(result.ok, true); assert.equal(result.failed, false);
  assert.deepEqual(result.resources, trip.cargo);
  for (const key of ['wood', 'plastic', 'cloth']) {
    assert.equal(game.state.resources[key], before[key] + trip.cargo[key]);
    assert.equal(game.state.stats.salvageCollected[key], collectedBefore[key] + trip.cargo[key]);
    assert.equal(game.state.stats.totalCollected[key], totalsBefore[key] + trip.cargo[key]);
    assert.equal(game.state.scavenging.totalCollected[key], trip.cargo[key]);
  }
  assert.equal(game.state.stats.salvageCount, salvageCount + 3);
  assert.equal(game.state.scavenging.completedTrips, 1);
  const settled = game.getState();
  assert.equal(game.returnScavenging().ok, false);
  assert.deepEqual(game.getState(), settled);
  assert.equal(game.startScavenging().tripId, 'scavenging-2');
  assert.deepEqual(game.getScavenging().cargo, { wood: 0, plastic: 0, cloth: 0 });
});

test('movement normalizes input, bounds elapsed steps and positions, and avoids per-frame render or save events', () => {
  const game = boatGame(), events = [];
  game.onChange((state, event) => events.push(event.type), { immediate: false });
  game.startScavenging();
  game.moveScavenging({ x: 1000, z: -1000 }, 1000);
  let trip = game.getScavenging();
  assert.ok(Math.hypot(trip.player.x, trip.player.z) <= SCAVENGING_CONFIG.speed * 0.25 + 1e-5);
  assert.equal(trip.elapsed, 0.25);
  assert.ok(Math.abs(trip.player.heading - Math.atan2(1, -1)) < 1e-8);
  for (let index = 0; index < 20; index++) game.moveScavenging({ x: -1, z: 0 }, 0.05);
  assert.deepEqual(events, ['scavengingStarted']);
  const before = game.getScavenging();
  game.moveScavenging({ x: 1, z: 0 }, -50);
  assert.deepEqual(game.getScavenging(), before);
  for (let index = 0; index < 40; index++) game.moveScavenging({ x: -1, z: 0 }, 0.25);
  trip = game.getScavenging();
  assert.equal(trip.player.x, trip.bounds.minX);
  assert.ok(Number.isFinite(trip.elapsed));
});

test('save/load and ordinary offline ticks preserve the exact voyage and resume without generating or crediting cargo twice', () => {
  const storage = memoryStorage(); let now = 1_000_000;
  const game = boatGame({ storage, now: () => now });
  const trip = collectIntro(game);
  game.tick(120);
  assert.deepEqual(game.getScavenging(), trip);
  game.save(); now += 3 * 60 * 60 * 1000;
  const restored = new GameState({ storage, now: () => now });
  assert.deepEqual(restored.getScavenging(), trip, 'Offline production must not move the ship or hazards');
  assert.equal(restored.startScavenging().resumed, true);
  assert.deepEqual(restored.getScavenging(), trip);
  const before = clone(restored.state.resources);
  restored.returnScavenging();
  for (const key of ['wood', 'plastic', 'cloth']) assert.equal(restored.state.resources[key], before[key] + trip.cargo[key]);
  const again = new GameState({ storage, now: () => now });
  assert.equal(again.returnScavenging().ok, false);
  assert.equal(again.state.scavenging.completedTrips, 1);
  assert.deepEqual(again.state.resources, restored.state.resources);
});

test('the initial 100 capacity takes only the fitting part of a pile, stays steerable, and settles once across reload', () => {
  const storage = memoryStorage(), game = boatGame({ storage });
  game.startScavenging();
  const live = game.state.scavenging.trip;
  // Two collision targets isolate the remaining-space boundary, independently
  // of patrols or incidental pickups along a long trip through the full map.
  live.objects = [
    { id: 'capacity-wood', kind: 'wood', x: 0, z: 1.8, amount: 99, collectedAmount: 0, collected: false },
    { id: 'capacity-cloth', kind: 'cloth', x: 0, z: 3.2, amount: 3, collectedAmount: 0, collected: false },
  ];
  live.sharks = []; live.fishSchools = [];
  const before = clone(game.state.resources), picked = [];
  for (let index = 0; index < 20; index++) picked.push(...game.moveScavenging({ x: 0, z: 1 }, 0.05).picked);
  assert.equal(SCAVENGING_CONFIG.capacity, 100);
  assert.deepEqual(picked.map(({ kind, amount }) => ({ kind, amount })), [{ kind: 'wood', amount: 99 }, { kind: 'cloth', amount: 1 }]);
  assert.deepEqual(live.cargo, { wood: 99, plastic: 0, cloth: 1 });
  assert.equal(live.status, 'sailing', 'Full cargo never automatically returns or ends the trip');
  assert.equal(live.objects[1].collectedAmount, 1); assert.equal(live.objects[1].collected, false);
  assert.deepEqual(game.state.resources, before, 'Full cargo remains outside the warehouse until returning');
  const x = live.player.x;
  game.moveScavenging({ x: 1, z: 0 }, 0.25);
  assert.ok(live.player.x > x, 'The player can keep steering after filling the cargo net');
  assert.equal(Object.values(live.cargo).reduce((sum, value) => sum + value, 0), 100);
  game.save();
  const savedTrip = game.getScavenging(), restored = new GameState({ storage, now: () => 1_000_000 });
  assert.deepEqual(restored.getScavenging(), savedTrip, 'Partial pickup amounts and remaining cargo survive normalization');
  const partial = restored.state.scavenging.trip.objects[1];
  restored.state.scavenging.trip.player = { x: partial.x, z: partial.z, heading: 0 };
  assert.equal(restored.moveScavenging({}, 0.05).picked.length, 0, 'A saved full trip cannot re-take the partial pile');
  assert.equal(partial.collectedAmount, 1);
  const returned = restored.returnScavenging();
  assert.deepEqual(returned.resources, { wood: 99, plastic: 0, cloth: 1 });
  assert.equal(restored.state.resources.wood, before.wood + 99);
  assert.equal(restored.state.resources.cloth, before.cloth + 1);
  const settled = restored.getState();
  assert.equal(restored.returnScavenging().ok, false); assert.deepEqual(restored.getState(), settled);
  const reloaded = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(reloaded.returnScavenging().ok, false);
  assert.equal(reloaded.state.scavenging.completedTrips, 1);
  assert.equal(reloaded.state.resources.cloth, before.cloth + 1);
});

test('legacy voyages without capacity or per-pile pickup amounts migrate to 100 without adding or duplicating cargo', () => {
  const storage = memoryStorage(), game = boatGame({ storage }); collectIntro(game);
  game.save();
  const raw = JSON.parse(storage.getItem('fkssj-save-v1')), oldCargo = clone(raw.scavenging.trip.cargo);
  delete raw.scavenging.trip.capacity;
  for (const object of raw.scavenging.trip.objects) delete object.collectedAmount;
  storage.setItem('fkssj-save-v1', JSON.stringify(raw));
  const restored = new GameState({ storage, now: () => 1_000_000 });
  const trip = restored.getScavenging();
  assert.equal(trip.capacity, 100); assert.deepEqual(trip.cargo, oldCargo);
  assert.deepEqual(trip.objects.slice(0, 3).map((object) => object.collectedAmount), [4, 3, 2]);
  assert.ok(trip.objects.slice(3).every((object) => object.collectedAmount === 0));
  restored.save();
  const reloaded = new GameState({ storage, now: () => 1_000_000 });
  assert.deepEqual(reloaded.getScavenging(), trip, 'Migrating the same voyage again is idempotent');
  assert.deepEqual(reloaded.returnScavenging().resources, oldCargo);
  assert.equal(reloaded.returnScavenging().ok, false);
});

test('scavenging enhancement pays once without overspending and changes only future pickups, including deterministic double rewards', () => {
  const storage = memoryStorage(), game = boatGame({ storage }); collectIntro(game);
  const insufficient = game.getState();
  assert.equal(game.getScavengingUpgrade().doubleChance, 0);
  assert.deepEqual(game.getScavengingUpgrade().cost, { coin: 50 });
  assert.equal(game.upgradeScavenging().ok, false); assert.deepEqual(game.getState(), insufficient);
  while (game.state.resources.coin < 50) game.collect('coin');
  const coin = game.state.resources.coin, previousTrip = game.getScavenging();
  assert.equal(game.upgradeScavenging().ok, true);
  assert.equal(game.state.resources.coin, coin - 50);
  const upgrade = game.getScavengingUpgrade();
  assert.equal(upgrade.level, 1); assert.equal(upgrade.doubleChance, 0.01);
  assert.equal(upgrade.doubleMultiplier, 2); assert.equal(upgrade.capacity, 100);
  assert.deepEqual(upgrade.cost, { coin: 50 });
  assert.deepEqual(game.getScavenging().cargo, previousTrip.cargo, 'Previously gathered cargo is never doubled retrospectively');
  assert.deepEqual(game.getScavenging().objects, previousTrip.objects);
  assert.equal(game.getScavenging().doubleChance, 0.01, 'Enhancement affects the active voyage immediately');
  const live = game.state.scavenging.trip, pile = live.objects[3];
  live.sharks = []; live.fishSchools = [];
  live.player = { x: pile.x, z: pile.z, heading: 0 }; live.rngState = 1;
  game.save();
  const restored = new GameState({ storage, now: () => 1_000_000 });
  const originalPickup = game.moveScavenging({}, 0.05), resumedPickup = restored.moveScavenging({}, 0.05);
  assert.deepEqual(resumedPickup.picked, originalPickup.picked);
  assert.equal(originalPickup.picked[0].multiplier, 2);
  assert.equal(originalPickup.picked[0].baseAmount, 4); assert.equal(originalPickup.picked[0].amount, 8);
  assert.equal(restored.getScavenging().objects[3].gainedAmount, 8);
  assert.equal(restored.getScavenging().objects[3].collectedAmount, 4);
  restored.save();
  const reloaded = new GameState({ storage, now: () => 1_000_000 });
  assert.deepEqual(reloaded.getScavenging(), restored.getScavenging(), 'Normalization retains actual doubled cargo provenance');
  assert.equal(reloaded.state.scavenging.upgradeLevel, 1);
  const rejected = reloaded.getState();
  assert.equal(reloaded.upgradeScavenging().ok, false); assert.deepEqual(reloaded.getState(), rejected);
});

test('ten enhancement steps require two real boats for tier two and never retroactively change already gathered cargo', () => {
  const storage = memoryStorage(), game = boatGame({ storage }); collectIntro(game);
  game.state.resources.coin = 5000;
  const previous = game.getScavenging(), spent = 50 * 10;
  for (let index = 0; index < 10; index++) assert.equal(game.upgradeScavenging().ok, true);
  assert.equal(game.state.resources.coin, 5000 - spent);
  const info = game.getScavengingUpgrade();
  assert.equal(info.level, 10); assert.equal(info.tier, 1); assert.equal(info.nextKind, 'tier');
  assert.equal(info.requiredBoats, 2); assert.equal(info.buildingCount, 1); assert.equal(info.canUpgrade, false);
  assert.equal(info.next.capacity, 200); assert.equal(info.next.doubleMultiplier, 4);
  const rejected = game.getState();
  assert.equal(game.upgradeScavenging().ok, false); assert.deepEqual(game.getState(), rejected);
  for (const [key, value] of Object.entries(BUILDINGS.scavenger.cost)) while (game.state.resources[key] < value) game.collect(key);
  assert.equal(game.placeBuilding('scavenger', -1, 0).ok, true);
  const coin = game.state.resources.coin;
  assert.equal(game.upgradeScavenging().ok, true);
  assert.equal(game.state.resources.coin, coin, 'The recorded boat-count gate adds no invented currency fee');
  assert.equal(game.getScavengingUpgrade().tier, 2); assert.equal(game.getScavengingUpgrade().nextKind, null);
  assert.equal(game.getScavengingUpgrade().cost, null);
  assert.deepEqual(game.getScavenging().cargo, previous.cargo);
  assert.deepEqual(game.getScavenging().objects, previous.objects);
  assert.equal(game.getScavenging().capacity, 200); assert.equal(game.getScavenging().doubleMultiplier, 4);
  game.save();
  const restored = new GameState({ storage, now: () => 1_000_000 });
  assert.deepEqual(restored.getScavenging(), game.getScavenging());
  assert.equal(restored.state.scavenging.tier, 2);
  assert.equal(restored.upgradeScavenging().ok, false);
  restored.returnScavenging(); restored.startScavenging();
  assert.equal(restored.getScavenging().capacity, 200);
  assert.equal(restored.getScavenging().objects.reduce((sum, object) => sum + object.amount, 0), 216);
});

test('fish schools steal cargo by collision with recovery time while sharks never directly deduct materials', () => {
  const game = boatGame(), trip = collectIntro(game), before = clone(game.state.resources);
  const live = game.state.scavenging.trip;
  live.sharks = [];
  live.fishSchools = [creatureAt('test-school', live.player.x, live.player.z)];
  const result = game.moveScavenging({}, 0.05);
  assert.equal(result.hit, null);
  assert.deepEqual(result.stolen.lost, { wood: 1, plastic: 1, cloth: 1 });
  assert.deepEqual(game.getScavenging().cargo, { wood: 3, plastic: 2, cloth: 1 });
  assert.equal(game.getScavenging().hits, 0);
  assert.deepEqual(game.state.resources, before);
  for (let index = 0; index < 3; index++) assert.equal(game.moveScavenging({}, 0.25).stolen, null);
  live.fishSchools = [];
  live.sharks = [creatureAt('test-shark', live.player.x, live.player.z)];
  const cargo = clone(live.cargo);
  assert.equal(game.moveScavenging({}, 0.05).hit.hits, 1);
  assert.deepEqual(game.getScavenging().cargo, cargo);
  const returned = game.returnScavenging();
  assert.deepEqual(returned.resources, cargo);
  assert.deepEqual(returned.lost, { wood: 1, plastic: 1, cloth: 1 });
  assert.equal(trip.cargo.wood, returned.resources.wood + returned.lost.wood);
});

test('three shark hits fail a trip, freeze movement across reload and let surviving cargo return exactly once', () => {
  const storage = memoryStorage(); let now = 1_000_000;
  const game = boatGame({ storage, now: () => now });
  const cargo = collectIntro(game).cargo, live = game.state.scavenging.trip;
  live.fishSchools = []; live.sharks = [creatureAt('test-shark', live.player.x, live.player.z)];
  assert.equal(game.moveScavenging({}, 0.05).hit.hits, 1);
  const recovery = live.hitUntil;
  for (let index = 0; index < 8; index++) game.moveScavenging({}, 0.25);
  assert.equal(live.hits, 1, 'Overlapping a shark does not hit every frame');
  assert.ok(live.elapsed < recovery);
  let failed;
  for (let index = 0; index < 50 && live.status === 'sailing'; index++) failed = game.moveScavenging({}, 0.25);
  assert.equal(live.hits, 3); assert.equal(live.status, 'failed'); assert.equal(failed.failed, true);
  assert.deepEqual(live.cargo, cargo);
  const frozen = game.getScavenging();
  assert.equal(game.moveScavenging({ x: 1, z: 1 }, 0.25).ok, false);
  assert.deepEqual(game.getScavenging(), frozen);
  now += 600_000;
  const restored = new GameState({ storage, now: () => now });
  assert.deepEqual(restored.getScavenging(), frozen);
  assert.equal(restored.startScavenging().failed, true, 'Starting again cannot overwrite an unsettled failed voyage');
  const before = clone(restored.state.resources), returned = restored.returnScavenging();
  assert.equal(returned.ok, true); assert.equal(returned.failed, true);
  for (const key of ['wood', 'plastic', 'cloth']) assert.equal(restored.state.resources[key], before[key] + cargo[key]);
  assert.equal(new GameState({ storage, now: () => now }).returnScavenging().ok, false);
});

test('nearby sharks chase but the ship can steer away faster than them', () => {
  const game = boatGame(); collectIntro(game);
  const live = game.state.scavenging.trip;
  live.fishSchools = []; live.sharks = [creatureAt('chaser', 4, live.player.z)];
  game.moveScavenging({}, 0.25);
  assert.ok(live.sharks[0].x < 4);
  const before = Math.hypot(live.sharks[0].x - live.player.x, live.sharks[0].z - live.player.z);
  game.moveScavenging({ x: -1, z: 0 }, 0.25);
  assert.ok(Math.hypot(live.sharks[0].x - live.player.x, live.sharks[0].z - live.player.z) > before);
  assert.equal(live.hits, 0);
});

test('legacy camp saves add zero plastic/cloth and an unseen guide without changing the existing explore rescue', () => {
  const storage = memoryStorage(), game = boatGame({ storage });
  game.save();
  const raw = JSON.parse(storage.getItem('fkssj-save-v1'));
  delete raw.scavenging; delete raw.resources.plastic; delete raw.resources.cloth;
  for (const category of ['salvageCollected', 'productionCollected', 'productionGenerated', 'totalCollected']) { delete raw.stats[category].plastic; delete raw.stats[category].cloth; }
  storage.setItem('fkssj-save-v1', JSON.stringify(raw));
  const restored = new GameState({ storage, now: () => 1_000_000 });
  assert.deepEqual(restored.state.scavenging, createScavenging());
  assert.equal(restored.state.resources.plastic, 0); assert.equal(restored.state.resources.cloth, 0);
  assert.equal(restored.state.stats.totalCollected.cloth, 0);
  while (restored.state.resources.food < 3) restored.collect('food');
  while (restored.state.resources.water < 3) restored.collect('water');
  assert.equal(restored.explore().residents, 2);
  assert.equal(restored.explore().ok, false);
  assert.deepEqual(restored.state.scavenging, createScavenging());
  restored.startScavenging(); restored.markScavengingGuideSeen(); restored.reset();
  assert.deepEqual(restored.state.scavenging, createScavenging());
});

test('future or malformed scavenging saves preserve original raw data through autosave until explicit reset', () => {
  assert.throws(() => normalizeScavenging({ version: 3 }), /更新版本/);
  for (const damaged of [{ version: 3 }, { version: 1, trip: { id: 'bad', status: 'sailing' } }]) {
    const storage = memoryStorage(), game = boatGame({ storage });
    game.save();
    const raw = JSON.parse(storage.getItem('fkssj-save-v1')); raw.scavenging = damaged;
    const original = JSON.stringify(raw); storage.setItem('fkssj-save-v1', original);
    let now = 1_000_000;
    const locked = new GameState({ storage, now: () => now });
    assert.equal(locked.persistenceLocked, true);
    now += 6000; locked.tick(6); locked.collect('wood');
    assert.equal(storage.getItem('fkssj-save-v1'), original);
    locked.reset();
    assert.equal(locked.persistenceLocked, false);
    assert.deepEqual(locked.state.scavenging, createScavenging());
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState, BUILDINGS, QUESTS, CONTINUATION_QUESTS } from './game-state.js';
import { RECIPES, CRAFT_RESOURCE_NAMES, PRODUCTION_CONFIG, PRODUCTION_RESOURCE_KEYS, createProduction, createContinuation, normalizeProduction } from './production-state.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function memoryStorage() { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }
function continuationGame(options = {}) {
  const game = new GameState({ storage: null, autoLoad: false, now: () => 1_000_000, ...options });
  game.state.quests.claimed = QUESTS.map((quest) => quest.id); game.state.completed = true;
  for (const key of Object.keys(game.state.resources)) game.state.resources[key] = Object.hasOwn(CRAFT_RESOURCE_NAMES, key) ? 0 : 1000;
  return game;
}
function build(game, type, fundCrafts = false) {
  if (fundCrafts) for (const [key, amount] of Object.entries(BUILDINGS[type].cost)) game.state.resources[key] = Math.max(game.state.resources[key], amount);
  let tile = game.state.raft.find((candidate) => !game.state.buildings.some((building) => building.x === candidate.x && building.z === candidate.z));
  if (!tile) {
    const occupied = new Set(game.state.raft.map(({ x, z }) => `${x},${z}`));
    const edge = game.state.raft.flatMap(({ x, z }) => [{ x: x + 1, z }, { x: x - 1, z }, { x, z: z + 1 }, { x, z: z - 1 }]).find(({ x, z }) => !occupied.has(`${x},${z}`) && Math.abs(x) <= 6 && Math.abs(z) <= 6);
    assert.equal(game.expand(edge.x, edge.z).ok, true); tile = edge;
  }
  const result = game.placeBuilding(type, tile.x, tile.z); assert.equal(result.ok, true, result.message); return result.building;
}
function factoryGame(options = {}) {
  const game = continuationGame(options);
  for (const type of ['materials', 'construction', 'tailor']) build(game, type, true);
  return game;
}
function craft(game, recipeId, quantity = 1) {
  const result = game.queueProduction(recipeId, quantity); assert.equal(result.ok, true, result.message);
  game.tick(result.job.duration);
  assert.equal(game.claimQueuedProduction(result.job.id).ok, true); return result;
}
function slicerGame(options = {}) {
  const game = new GameState({ storage: null, autoLoad: false, now: () => 1_000_000, ...options });
  for (const [key, amount] of Object.entries(BUILDINGS.slicer.cost)) while (game.state.resources[key] < amount) game.collect(key);
  const slicer = build(game, 'slicer');
  for (const [key, amount] of Object.entries(game.getUpgradeCost(slicer.id))) while (game.state.resources[key] < amount) game.collect(key);
  return { game, slicer };
}

test('factory locks are enforced in the domain and rejected recipes, quantities and material costs leave all state unchanged', () => {
  const game = new GameState({ storage: null, autoLoad: false });
  game.state.resources.wood = 100; game.state.resources.plastic = 100;
  const locked = game.getState();
  assert.equal(game.getFactoryUnlock('materials').unlocked, false);
  assert.equal(game.getFactoryUnlock('seafoodKitchen').unlocked, false);
  assert.equal(game.placeBuilding('materials', -1, -1).ok, false);
  assert.equal(game.placeBuilding('seafoodKitchen', -1, -1).ok, false);
  assert.equal(game.queueProduction('fabric').ok, false);
  assert.deepEqual(game.getState(), locked);
  game.state.completed = true; game.state.quests.claimed = QUESTS.map((quest) => quest.id);
  assert.equal(game.getFactoryUnlock('materials').unlocked, true);
  assert.equal(game.getRecipes().find((recipe) => recipe.id === 'fabric').canQueue, false);
  build(game, 'materials');
  const insufficient = game.getState();
  for (const [recipeId, quantity] of [['unknown', 1], ['fabric', 0], ['fabric', 1.5], ['fabric', 11], ['fabric', 1]]) assert.equal(game.queueProduction(recipeId, quantity).ok, false);
  assert.deepEqual(game.getState(), insufficient);
  game.state.resources.cloth = 40;
  assert.equal(game.getRecipes().find((recipe) => recipe.id === 'fabric').maxQuantity, 2);
  assert.equal(game.queueProduction('fabric', 3).ok, false);
  assert.equal(game.state.resources.cloth, 40);
});

test('enqueue pays exactly once, holds immutable batch outputs, and each factory rejects a seventh batch without extra payment', () => {
  const game = factoryGame(), station = game.state.buildings.find((building) => building.type === 'materials');
  const cloth = game.state.resources.cloth, fabric = game.state.resources.fabric;
  const queued = game.queueProduction('fabric', 2, station.id);
  assert.equal(queued.ok, true); assert.deepEqual(queued.cost, { cloth: 40 });
  assert.equal(game.state.resources.cloth, cloth - 40); assert.equal(game.state.resources.fabric, fabric);
  assert.equal(queued.job.duration, 600); assert.equal(queued.job.status, 'running');
  assert.equal(game.claimQueuedProduction(queued.job.id).ok, false);
  queued.job.outputs.fabric = 999;
  const view = game.getProductionQueue(station.id); view[0].remaining = 0; view[0].outputs.fabric = 999;
  assert.equal(game.getProductionQueue(station.id)[0].outputs.fabric, 2);
  assert.equal(game.queueProduction('rope', 1, station.id).ok, true);
  assert.equal(game.queueProduction('fabric', 1, station.id).ok, true);
  for (let index = 0; index < 3; index++) assert.equal(game.queueProduction('fabric', 1, station.id).ok, true);
  assert.deepEqual(game.getProductionQueue(station.id).map((job) => job.status), ['running', 'queued', 'queued', 'queued', 'queued', 'queued']);
  assert.equal(PRODUCTION_CONFIG.queueSlots, 6); assert.equal(PRODUCTION_CONFIG.maxQuantity, 10);
  const full = game.getState();
  assert.equal(game.queueProduction('fabric', 1, station.id).ok, false);
  assert.deepEqual(game.getState(), full);
  assert.equal(game.getRecipes(station.id)[0].maxQuantity, 0);
});

test('separate factories run in parallel while one factory preserves FIFO and claiming is reentrant-safe and counted once', () => {
  const game = factoryGame();
  const fabric = game.queueProduction('fabric'), rope = game.queueProduction('rope'), plank = game.queueProduction('plank', 2), jacket = game.queueProduction('lifejacket');
  assert.equal([fabric, rope, plank, jacket].every((result) => result.ok), true);
  const paid = clone(game.state.resources);
  game.tick(30);
  let jobs = Object.fromEntries(game.getProductionQueue().map((job) => [job.recipeId, job]));
  assert.equal(jobs.fabric.status, 'running'); assert.equal(jobs.fabric.remaining, 270); assert.equal(jobs.rope.remaining, 40);
  assert.equal(jobs.plank.remaining, 30); assert.equal(jobs.lifejacket.remaining, 270);
  game.tick(270);
  jobs = Object.fromEntries(game.getProductionQueue().map((job) => [job.recipeId, job]));
  assert.equal(jobs.fabric.status, 'ready'); assert.equal(jobs.rope.remaining, 40);
  assert.equal(jobs.plank.status, 'ready'); assert.equal(jobs.lifejacket.status, 'ready');
  game.tick(40);
  jobs = Object.fromEntries(game.getProductionQueue().map((job) => [job.recipeId, job]));
  assert.equal(jobs.rope.status, 'ready'); assert.equal(jobs.plank.status, 'ready'); assert.equal(jobs.lifejacket.remaining, 0);
  assert.equal(game.state.resources.cloth, paid.cloth); assert.equal(game.state.resources.fabric, paid.fabric);
  const nestedClaims = [];
  game.onChange((state, event) => { if (event.type === 'queuedProductionCollected') nestedClaims.push(game.claimQueuedProduction(event.jobId).ok); }, { immediate: false });
  assert.deepEqual(game.claimQueuedProduction(fabric.job.id).resources, { fabric: 1 });
  assert.deepEqual(nestedClaims, [false]);
  assert.equal(game.state.production.collected.fabric, 1); assert.equal(game.state.stats.productionCollected.fabric, 1);
  const settled = game.getState(); assert.equal(game.claimQueuedProduction(fabric.job.id).ok, false); assert.deepEqual(game.getState(), settled);
  assert.equal(game.state.resources.fabric, paid.fabric + 1);
  assert.equal(game.state.stats.productionGenerated.fabric, 1);
});

test('paid queues finish once during bounded offline advancement and never auto-credit, repay inputs or replay rewards', () => {
  const storage = memoryStorage(); let now = 1_000_000;
  const game = factoryGame({ storage, now: () => now });
  const queued = game.queueProduction('lifejacket'), paidPlastic = game.state.resources.plastic, paidCloth = game.state.resources.cloth, before = game.state.resources.lifejacket;
  assert.equal(queued.ok, true); now += 3 * 60 * 60 * 1000;
  const restored = new GameState({ storage, now: () => now });
  assert.equal(restored.state.offlineReport.seconds, 7200); assert.equal(restored.state.offlineReport.capped, true);
  assert.equal(restored.getProductionQueue()[0].status, 'ready'); assert.equal(restored.state.stats.productionGenerated.lifejacket, 1);
  assert.equal(restored.state.resources.lifejacket, before); assert.equal(restored.state.resources.plastic, paidPlastic); assert.equal(restored.state.resources.cloth, paidCloth);
  const again = new GameState({ storage, now: () => now });
  assert.equal(again.state.offlineReport, null); assert.equal(again.state.stats.productionGenerated.lifejacket, 1);
  assert.deepEqual(again.claimQueuedProduction(queued.job.id).resources, { lifejacket: 1 });
  const after = new GameState({ storage, now: () => now });
  assert.equal(after.claimQueuedProduction(queued.job.id).ok, false); assert.equal(after.state.resources.lifejacket, before + 1);
  assert.equal(after.state.production.collected.lifejacket, 1);
});

test('the recorded sashimi queue works inside the opening, remains uncredited offline until collection and makes the protected first meal reachable', () => {
  const storage = memoryStorage(); let now = 1_000_000;
  const { game, slicer } = slicerGame({ storage, now: () => now });
  assert.equal(game.state.completed, false); assert.equal(game.state.quests.claimed.length, 0); assert.equal(Object.hasOwn(CRAFT_RESOURCE_NAMES, 'food'), false);
  assert.deepEqual(PRODUCTION_RESOURCE_KEYS, ['food', ...Object.keys(CRAFT_RESOURCE_NAMES)]); assert.equal(createProduction().collected.food, 0);
  const recipe = game.getRecipes(slicer.id).find((value) => value.id === 'sashimi');
  assert.deepEqual(recipe.inputs, { fish: 6 }); assert.deepEqual(recipe.outputs, { food: 1 }); assert.equal(recipe.seconds, 90); assert.equal(recipe.storage, 50); assert.equal(recipe.minBuildingLevel, 1); assert.equal(recipe.unlocked, true);
  assert.equal(game.getRecipes(slicer.id).find((value) => value.id === 'fishLine').unlocked, false);
  while (game.state.resources.fish < 30) game.collect('fish');
  const fish = game.state.resources.fish, water = game.state.resources.water, queued = game.queueProduction('sashimi', 5, slicer.id);
  assert.equal(queued.ok, true); assert.deepEqual(queued.cost, { fish: 30 }); assert.equal(queued.job.quantity, 5); assert.equal(queued.job.duration, 450); assert.equal(queued.job.remaining, 450); assert.deepEqual(queued.job.outputs, { food: 5 });
  assert.equal(game.state.resources.fish, fish - 30); assert.equal(game.state.resources.food, 0); assert.equal(game.getResidentOrder().canDeliver, false);
  now += 450_000; const restored = new GameState({ storage, now: () => now });
  assert.equal(restored.state.production.version, 6); assert.equal(restored.getProductionQueue(slicer.id)[0].status, 'ready'); assert.equal(restored.state.stats.productionGenerated.food, 5);
  assert.equal(restored.state.resources.food, 0); assert.equal(restored.state.resources.water, water); assert.equal(restored.state.resources.fish, fish - 30); assert.equal(restored.getResidentOrder().canDeliver, false);
  const noReplay = new GameState({ storage, now: () => now }); assert.equal(noReplay.state.stats.productionGenerated.food, 5); assert.equal(noReplay.state.production.collected.food, 0);
  const nested = []; noReplay.onChange((state, event) => { if (event.type === 'queuedProductionCollected') nested.push(noReplay.claimQueuedProduction(event.jobId).ok); }, { immediate: false });
  assert.deepEqual(noReplay.claimQueuedProduction(queued.job.id).resources, { food: 5 }); assert.deepEqual(nested, [false]);
  assert.equal(noReplay.state.production.collected.food, 5); assert.equal(noReplay.state.stats.productionCollected.food, 5); assert.equal(noReplay.state.resources.food, 5); assert.equal(noReplay.getResidentOrder().canDeliver, true);
  const claimed = noReplay.getState(); assert.equal(noReplay.claimQueuedProduction(queued.job.id).ok, false); assert.deepEqual(noReplay.getState(), claimed);
  assert.equal(noReplay.deliverResidentOrder('first-meal').ok, true); assert.equal(noReplay.state.resources.food, 0); assert.equal(noReplay.state.stats.productionCollected.food, 5);
  const again = new GameState({ storage, now: () => now }); assert.equal(again.state.production.collected.food, 5); assert.equal(again.state.stats.productionCollected.food, 5); assert.equal(again.claimQueuedProduction(queued.job.id).ok, false);
});

test('legacy slicer tail stock and all paid food share fifty capacity while other factories and product capacity stay independent', () => {
  const { game, slicer } = slicerGame(); slicer.stored = 48; game.state.resources.fish = 120;
  const first = game.getRecipes(slicer.id).find((recipe) => recipe.id === 'sashimi');
  assert.equal(first.legacyStored, 48); assert.equal(first.stored, 48); assert.equal(first.reserved, 48); assert.equal(first.maxQuantity, 2);
  const before = game.getState(); assert.equal(game.queueProduction('sashimi', 3, slicer.id).ok, false); assert.deepEqual(game.getState(), before);
  const queued = game.queueProduction('sashimi', 2, slicer.id); assert.equal(queued.ok, true); assert.equal(game.state.resources.fish, 108);
  let info = game.getRecipes(slicer.id).find((recipe) => recipe.id === 'sashimi'); assert.equal(info.stored, 48); assert.equal(info.reserved, 50); assert.equal(info.canQueue, false); assert.equal(info.maxQuantity, 0);
  const full = game.getState(); assert.equal(game.queueProduction('sashimi', 1, slicer.id).ok, false); assert.deepEqual(game.getState(), full);
  const normalized = normalizeProduction(game.state.production, game.state.buildings, Object.keys(game.state.resources)); assert.deepEqual(normalized.queue[0], game.state.production.queue[0]);
  const overflowBuildings = clone(game.state.buildings); overflowBuildings.find((building) => building.id === slicer.id).stored = 49;
  assert.throws(() => normalizeProduction(game.state.production, overflowBuildings, Object.keys(game.state.resources)), /旧库存.*已付/);
  const second = build(game, 'slicer'); const independent = game.getRecipes(second.id).find((recipe) => recipe.id === 'sashimi'); assert.equal(independent.reserved, 0); assert.equal(independent.maxQuantity, 10);
  game.tick(180); info = game.getRecipes(slicer.id).find((recipe) => recipe.id === 'sashimi'); assert.equal(info.stored, 50); assert.equal(info.reserved, 50); assert.equal(slicer.stored, 48); assert.equal(game.state.resources.fish, 108);
  assert.deepEqual(game.claimQueuedProduction(queued.job.id).resources, { food: 2 }); assert.equal(slicer.stored, 48); assert.equal(game.state.stats.productionCollected.food, 2); assert.equal(game.state.production.collected.food, 2);
  assert.deepEqual(game.collectProduction(slicer.id).resources, { food: 48 }); assert.equal(slicer.stored, 0); assert.equal(game.state.stats.productionCollected.food, 50); assert.equal(game.collectProduction(slicer.id).ok, false);
  assert.equal(game.getRecipes(slicer.id).find((recipe) => recipe.id === 'sashimi').reserved, 0);
});

test('versions one through five preserve every paid snapshot and food collection history while version six round-trips six batches', () => {
  const game = factoryGame(); game.queueProduction('fabric', 2); game.queueProduction('rope'); game.queueProduction('fabric');
  const raw = clone(game.state.production); Object.assign(raw.queue[0], { name: '旧已付布匹批次', duration: 30, remaining: 12, inputs: { cloth: 3 }, outputs: { fabric: 2 } }); raw.collected.food = 7;
  for (const version of [1, 2, 3, 4, 5]) {
    const normalized = normalizeProduction({ ...raw, version }, game.state.buildings, Object.keys(game.state.resources));
    assert.equal(normalized.version, 6); assert.deepEqual(normalized.queue, raw.queue); assert.equal(normalized.nextJobId, raw.nextJobId); assert.equal(normalized.collected.food, 7);
    const missingFood = clone(raw); delete missingFood.collected.food; assert.equal(normalizeProduction({ ...missingFood, version }, game.state.buildings, Object.keys(game.state.resources)).collected.food, 0);
  }
  const station = game.state.buildings.find((building) => building.type === 'materials');
  for (let index = 0; index < 3; index++) assert.equal(game.queueProduction('fabric', 1, station.id).ok, true);
  assert.equal(game.state.production.queue.length, 6); assert.deepEqual(normalizeProduction(game.state.production, game.state.buildings, Object.keys(game.state.resources)), game.state.production);
});

test('legacy sashimi seconds survive every rejected enqueue and are consumed once after full payment even under reentrant queueing and reload', () => {
  const storage = memoryStorage(), { game, slicer } = slicerGame({ storage }); slicer.legacySlicerProgress = 45; game.state.resources.fish = 5;
  for (const [id, quantity] of [['unknown', 1], ['sashimi', 0], ['sashimi', 11], ['sashimi', 1], ['sashimi', 2]]) {
    const before = game.getState(); assert.equal(game.queueProduction(id, quantity, slicer.id).ok, false); assert.deepEqual(game.getState(), before); assert.equal(slicer.legacySlicerProgress, 45);
  }
  game.state.resources.fish = 60; slicer.stored = 49;
  const oversized = game.getState(); assert.equal(game.queueProduction('sashimi', 2, slicer.id).ok, false); assert.deepEqual(game.getState(), oversized); assert.equal(slicer.legacySlicerProgress, 45); slicer.stored = 0;
  let nested, reentered = false;
  game.onChange((state, event) => { if (event.type === 'productionQueued' && !reentered) { reentered = true; nested = game.queueProduction('sashimi', 1, slicer.id); } }, { immediate: false });
  const first = game.queueProduction('sashimi', 2, slicer.id);
  assert.equal(first.ok, true); assert.deepEqual(first.cost, { fish: 12 }); assert.equal(first.legacyProgressUsed, 45); assert.equal(first.job.duration, 180); assert.equal(first.job.remaining, 135); assert.equal(first.job.quantity, 2); assert.deepEqual(first.job.outputs, { food: 2 });
  assert.equal(nested.ok, true); assert.equal(nested.legacyProgressUsed, 0); assert.equal(nested.job.remaining, 90); assert.equal(nested.job.status, 'queued'); assert.equal(slicer.legacySlicerProgress, 0); assert.equal(game.state.resources.fish, 42);
  assert.equal(game.save().ok, true); const restored = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(restored.state.buildings.find((building) => building.id === slicer.id).legacySlicerProgress, 0); assert.equal(restored.getProductionQueue(slicer.id)[0].remaining, 135); assert.equal(restored.getProductionQueue(slicer.id)[1].remaining, 90); assert.equal(restored.state.resources.fish, 42);
  restored.tick(134.75); assert.equal(restored.claimQueuedProduction(first.job.id).ok, false); restored.tick(.25);
  assert.equal(restored.getProductionQueue(slicer.id)[1].remaining, 90); assert.deepEqual(restored.claimQueuedProduction(first.job.id).resources, { food: 2 });
  restored.tick(90); assert.deepEqual(restored.claimQueuedProduction(nested.job.id).resources, { food: 1 }); assert.equal(restored.state.stats.productionGenerated.food, 3); assert.equal(restored.state.stats.productionCollected.food, 3); assert.equal(restored.state.production.collected.food, 3); assert.equal(restored.state.resources.fish, 42);
  assert.equal(restored.claimQueuedProduction(first.job.id).ok, false); assert.equal(restored.claimQueuedProduction(nested.job.id).ok, false);
});

test('six non-food jobs do not consume legacy sashimi progress and rejecting a full factory does not discard it', () => {
  const { game, slicer } = slicerGame(); assert.equal(game.upgradeBuilding(slicer.id).ok, true); slicer.legacySlicerProgress = 45; game.state.resources.fish = 200;
  const jobs = [];
  for (let index = 0; index < 6; index++) { const queued = game.queueProduction('fishLine', 1, slicer.id); assert.equal(queued.ok, true); assert.equal(queued.legacyProgressUsed, 0); jobs.push(queued.job); }
  assert.equal(slicer.legacySlicerProgress, 45); assert.equal(game.state.resources.fish, 80);
  const full = game.getState(); assert.equal(game.queueProduction('sashimi', 1, slicer.id).ok, false); assert.deepEqual(game.getState(), full);
  game.tick(300); assert.equal(game.claimQueuedProduction(jobs[0].id).ok, true);
  const sashimi = game.queueProduction('sashimi', 1, slicer.id); assert.equal(sashimi.ok, true); assert.equal(sashimi.job.remaining, 45); assert.equal(sashimi.job.status, 'queued'); assert.equal(sashimi.legacyProgressUsed, 45); assert.equal(slicer.legacySlicerProgress, 0); assert.equal(game.state.resources.fish, 74); assert.equal(game.state.stats.productionGenerated.food, 0);
});

test('a full ninety-second legacy credit still pays all fish, generates once and waits for manual collection, including quantity-ten batches', () => {
  const storage = memoryStorage(); let now = 1_000_000;
  const { game, slicer } = slicerGame({ storage, now: () => now }); slicer.legacySlicerProgress = 90; game.state.resources.fish = 6;
  const queued = game.queueProduction('sashimi', 1, slicer.id);
  assert.equal(queued.ok, true); assert.deepEqual(queued.cost, { fish: 6 }); assert.equal(game.state.resources.fish, 0); assert.equal(slicer.legacySlicerProgress, 0); assert.equal(queued.job.duration, 90); assert.equal(queued.job.remaining, 0); assert.equal(queued.job.status, 'ready'); assert.equal(game.state.stats.productionGenerated.food, 1); assert.equal(game.state.resources.food, 0); assert.equal(game.state.stats.productionCollected.food, 0);
  now += 90_000; const restored = new GameState({ storage, now: () => now }); restored.tick(90);
  assert.equal(restored.state.stats.productionGenerated.food, 1); assert.equal(restored.state.resources.food, 0); assert.equal(restored.state.resources.fish, 0); assert.deepEqual(restored.claimQueuedProduction(queued.job.id).resources, { food: 1 }); assert.equal(restored.state.production.collected.food, 1);
  const again = new GameState({ storage, now: () => now }); assert.equal(again.state.stats.productionGenerated.food, 1); assert.equal(again.state.stats.productionCollected.food, 1); assert.equal(again.claimQueuedProduction(queued.job.id).ok, false);
  const large = slicerGame(); large.slicer.legacySlicerProgress = 90; large.game.state.resources.fish = 60;
  const batch = large.game.queueProduction('sashimi', 10, large.slicer.id); assert.equal(batch.ok, true); assert.equal(batch.job.duration, 900); assert.equal(batch.job.remaining, 810); assert.deepEqual(batch.cost, { fish: 60 }); assert.deepEqual(batch.job.outputs, { food: 10 }); assert.equal(large.game.state.resources.fish, 0); assert.equal(large.game.state.stats.productionGenerated.food, 0);
  large.game.tick(809.75); assert.equal(large.game.claimQueuedProduction(batch.job.id).ok, false); large.game.tick(.25);
  assert.deepEqual(large.game.claimQueuedProduction(batch.job.id).resources, { food: 10 }); assert.equal(large.game.state.stats.productionGenerated.food, 10); assert.equal(large.game.state.stats.productionCollected.food, 10); assert.equal(large.game.state.production.collected.food, 10);
});

test('legacy daily-goods batches keep their paid twenty-metal five-minute snapshots without retroactive glass charges', () => {
  for (const version of [4, 5]) {
    const storage = memoryStorage(), game = continuationGame({ storage });
    game.state.story.claimed = ['hospital-built'];
    const factory = build(game, 'dailyFactory', true), queued = game.queueProduction('dailyGoods', 1, factory.id);
    assert.equal(queued.ok, true);
    const raw = JSON.parse(storage.getItem('fkssj-save-v1'));
    raw.production.version = version;
    Object.assign(raw.production.queue[0], { inputs: { scrap: 20 }, duration: 300, remaining: 137, status: 'running' });
    raw.resources.glass = 0;
    const job = clone(raw.production.queue[0]), stock = clone(raw.resources);
    storage.setItem('fkssj-save-v1', JSON.stringify(raw));
    const restored = new GameState({ storage, now: () => 1_000_000 });
    assert.equal(restored.persistenceLocked, false); assert.deepEqual(restored.state.production.queue[0], job);
    assert.equal(restored.state.resources.glass, 0); assert.equal(restored.state.resources.scrap, stock.scrap);
    const recipe = restored.getRecipes(factory.id).find((value) => value.id === 'dailyGoods');
    assert.deepEqual(recipe.inputs, { glass: 20, scrap: 20 }); assert.equal(recipe.seconds, 1200); assert.equal(recipe.storage, 50);
    assert.equal(recipe.referenceStatus, undefined); assert.deepEqual(recipe.missing, { glass: 20 });
    const insufficient = restored.getState(); assert.equal(restored.queueProduction('dailyGoods', 1, factory.id).ok, false); assert.deepEqual(restored.getState(), insufficient);
    restored.state.resources.glass = 20; // Material fixture for a separately paid new batch.
    const next = restored.queueProduction('dailyGoods', 1, factory.id); assert.equal(next.ok, true);
    assert.deepEqual(next.job.inputs, { glass: 20, scrap: 20 }); assert.equal(next.job.duration, 1200); assert.equal(next.job.status, 'queued');
    assert.equal(restored.state.resources.glass, 0); assert.equal(restored.state.resources.scrap, stock.scrap - 20);
    assert.deepEqual(restored.state.production.queue[0], job, 'Enqueuing the new recipe does not reprice the old paid snapshot');
    restored.tick(136.75); assert.equal(restored.claimQueuedProduction(job.id).ok, false);
    assert.equal(restored.getProductionQueue().find((value) => value.id === next.job.id).remaining, 1200, 'The new batch waits for the old batch in the same FIFO');
    restored.tick(0.25); assert.equal(restored.state.resources.dailyGoods, stock.dailyGoods);
    assert.equal(restored.claimQueuedProduction(job.id).ok, true); assert.equal(restored.claimQueuedProduction(job.id).ok, false);
    assert.equal(restored.state.resources.dailyGoods, stock.dailyGoods + 1);
    assert.equal(restored.state.resources.glass, 0); assert.equal(restored.state.resources.scrap, stock.scrap - 20);
    const again = new GameState({ storage, now: () => 1_000_000 });
    assert.equal(again.claimQueuedProduction(job.id).ok, false); assert.equal(again.state.resources.dailyGoods, stock.dailyGoods + 1);
    assert.equal(again.state.stats.productionGenerated.dailyGoods, 1); assert.equal(again.state.stats.productionCollected.dailyGoods, 1);
    assert.equal(again.getProductionQueue()[0].id, next.job.id); assert.equal(again.getProductionQueue()[0].remaining, 1200);
    again.tick(1199.75); assert.equal(again.claimQueuedProduction(next.job.id).ok, false); again.tick(0.25);
    assert.equal(again.claimQueuedProduction(next.job.id).ok, true); assert.equal(again.claimQueuedProduction(next.job.id).ok, false);
    assert.equal(again.state.resources.dailyGoods, stock.dailyGoods + 2); assert.equal(again.state.resources.glass, 0); assert.equal(again.state.resources.scrap, stock.scrap - 20);
    assert.equal(again.state.stats.productionGenerated.dailyGoods, 2); assert.equal(again.state.stats.productionCollected.dailyGoods, 2);
    const final = new GameState({ storage, now: () => 1_000_000 }); assert.equal(final.getProductionQueue().length, 0); assert.equal(final.state.resources.dailyGoods, stock.dailyGoods + 2);
  }
});

test('fish gut line uses the explicit project level gate and the unified building unlock instead of the old chapter gate', () => {
  const { game, slicer } = slicerGame(); game.state.resources.fish = 40;
  const locked = game.getRecipes(slicer.id).find((recipe) => recipe.id === 'fishLine');
  assert.equal(game.state.completed, false); assert.equal(game.getFactoryUnlock('slicer').unlocked, true);
  assert.equal(locked.minBuildingLevel, 2); assert.equal(locked.buildingLevel, 1);
  assert.equal(locked.unlocked, false); assert.match(locked.reason, /2级/);
  const before = game.getState(); assert.equal(game.queueProduction('fishLine').ok, false); assert.deepEqual(game.getState(), before);
  assert.equal(game.upgradeBuilding(slicer.id).ok, true);
  const recipe = game.getRecipes(slicer.id).find((value) => value.id === 'fishLine');
  assert.equal(recipe.unlocked, true); assert.equal(recipe.canQueue, true); assert.equal(recipe.buildingLevel, 2);
  assert.deepEqual(recipe.inputs, { fish: 20 }); assert.deepEqual(recipe.outputs, { fishLine: 1 });
  assert.equal(recipe.seconds, 300); assert.equal(recipe.storage, 50);
  assert.equal(game.getRecipes().find((value) => value.id === 'fabric').unlocked, false, 'The old post-chapter factory rule is still respected');
  // An unqualified first copy does not hide an eligible second factory when the
  // caller leaves selection to the domain. Explicit IDs keep their own gate.
  const second = build(game, 'slicer', true);
  for (const [key, amount] of Object.entries(game.getUpgradeCost(second.id))) while (game.state.resources[key] < amount) game.collect(key);
  slicer.level = 1; assert.equal(game.upgradeBuilding(second.id).ok, true);
  assert.equal(game.getRecipes().find((value) => value.id === 'fishLine').buildingId, second.id);
  assert.equal(game.getRecipes(slicer.id).find((recipe) => recipe.id === 'fishLine').canQueue, false);
});

test('paid sashimi and fish-line batches share one FIFO and fish balance without automatic production or duplicate spending', () => {
  const storage = memoryStorage(), { game, slicer } = slicerGame({ storage });
  assert.equal(game.upgradeBuilding(slicer.id).ok, true); game.state.resources.fish = 24;
  const queued = game.queueProduction('fishLine', 1, slicer.id);
  assert.equal(queued.ok, true); assert.equal(game.state.resources.fish, 4);
  const insufficient = game.getState(); assert.equal(game.queueProduction('sashimi', 1, slicer.id).ok, false); assert.deepEqual(game.getState(), insufficient);
  assert.equal(game.collect('fish').ok, true); const sashimi = game.queueProduction('sashimi', 1, slicer.id);
  assert.equal(sashimi.ok, true); assert.equal(game.state.resources.fish, 1); assert.equal(sashimi.job.status, 'queued');
  for (let index = 0; index < 300; index++) { game.tick(1); assert.ok(game.state.resources.fish >= 0); }
  assert.equal(game.state.resources.fish, 1); assert.equal(slicer.stored, 0); assert.equal(game.state.stats.productionGenerated.food, 0);
  assert.equal(game.state.stats.productionGenerated.fishLine, 1);
  assert.equal(game.getProductionQueue(slicer.id)[0].status, 'ready'); assert.equal(game.getProductionQueue(slicer.id)[1].remaining, 90);
  assert.equal(game.state.resources.fishLine, 0);
  const stopped = game.getState(); assert.equal(game.queueProduction('fishLine', 1, slicer.id).ok, false); assert.deepEqual(game.getState(), stopped);
  game.save();
  const restored = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(restored.state.production.version, 6);
  assert.deepEqual(restored.claimQueuedProduction(queued.job.id).resources, { fishLine: 1 });
  assert.equal(restored.state.stats.productionCollected.fishLine, 1);
  restored.tick(89.75); assert.equal(restored.claimQueuedProduction(sashimi.job.id).ok, false); restored.tick(.25);
  assert.deepEqual(restored.claimQueuedProduction(sashimi.job.id).resources, { food: 1 });
  assert.equal(restored.state.resources.fish, 1); assert.equal(restored.state.stats.productionCollected.food, 1); assert.equal(restored.state.production.collected.food, 1);
  const reloaded = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(reloaded.state.resources.fishLine, 1); assert.equal(reloaded.getProductionQueue().length, 0);
  assert.equal(reloaded.state.production.version, 6, 'The compatibility guard remains after new products leave the paid queue');
  assert.equal(reloaded.claimQueuedProduction(queued.job.id).ok, false);
  assert.equal(reloaded.claimQueuedProduction(sashimi.job.id).ok, false);
  const other = slicerGame(); assert.equal(other.game.upgradeBuilding(other.slicer.id).ok, true);
  other.game.state.resources.fish = 20; const paidFood = other.game.queueProduction('sashimi', 1, other.slicer.id); assert.equal(paidFood.ok, true); assert.equal(other.game.state.resources.fish, 14);
  const spentOnFood = other.game.getState(); assert.equal(other.game.queueProduction('fishLine').ok, false); assert.deepEqual(other.game.getState(), spentOnFood);
});

test('legacy saves add empty production, preserve already paid recipe snapshots and recognize voyages without duplicating cargo', () => {
  for (const hadScavenging of [false, true]) {
    const storage = memoryStorage(), game = continuationGame({ storage }); game.save();
    const raw = JSON.parse(storage.getItem('fkssj-save-v1'));
    delete raw.production; delete raw.continuation;
    if (hadScavenging) { raw.scavenging.version = 1; raw.scavenging.completedTrips = 1; delete raw.scavenging.upgradeLevel; delete raw.scavenging.tier; }
    else delete raw.scavenging;
    for (const key of Object.keys(CRAFT_RESOURCE_NAMES)) {
      delete raw.resources[key]; for (const category of ['totalCollected', 'productionCollected', 'productionGenerated', 'salvageCollected']) delete raw.stats[category][key];
    }
    storage.setItem('fkssj-save-v1', JSON.stringify(raw));
    const restored = new GameState({ storage, now: () => 1_000_000 });
    assert.equal(restored.persistenceLocked, false); assert.deepEqual(restored.state.production, createProduction()); assert.deepEqual(restored.state.continuation, createContinuation());
    for (const key of Object.keys(CRAFT_RESOURCE_NAMES)) assert.equal(restored.state.resources[key], 0);
    assert.deepEqual(restored.state.quests.claimed, raw.quests.claimed);
    assert.equal(restored.getContinuationQuests()[0].current, hadScavenging ? 1 : 0);
    if (hadScavenging) {
      const wood = restored.state.resources.wood, coin = restored.state.resources.coin;
      assert.equal(restored.claimContinuationQuest('supply-trip').ok, true);
      assert.equal(restored.state.resources.wood, wood + 12); assert.equal(restored.state.resources.coin, coin + 30);
      assert.equal(restored.claimContinuationQuest('supply-trip').ok, false);
      assert.deepEqual(new GameState({ storage, now: () => 1_000_000 }).state.continuation.claimed, ['supply-trip']);
    }
  }
  const storage = memoryStorage(), paid = factoryGame({ storage }); paid.queueProduction('fabric');
  const oldRecipe = JSON.parse(storage.getItem('fkssj-save-v1'));
  oldRecipe.production.version = 1;
  oldRecipe.continuation.claimed = CONTINUATION_QUESTS.slice(0, 12).map((quest) => quest.id);
  Object.assign(oldRecipe.production.queue[0], { duration: 30, remaining: 12, inputs: { cloth: 3 } });
  oldRecipe.resources.cloth += 17;
  storage.setItem('fkssj-save-v1', JSON.stringify(oldRecipe));
  const restored = new GameState({ storage, now: () => 1_000_000 });
  const job = restored.getProductionQueue()[0], cloth = restored.state.resources.cloth;
  assert.equal(restored.state.production.version, 6);
  assert.deepEqual(restored.state.continuation.claimed, oldRecipe.continuation.claimed, 'All twelve already claimed v0.7 rewards remain historical records');
  assert.equal(restored.claimContinuationQuest('logistics-reserve').ok, false);
  assert.equal(restored.getContinuationQuests().find((quest) => quest.active).id, 'seafood-kitchen-built');
  assert.equal(restored.getRecipes().find((recipe) => recipe.id === 'fabric').seconds, 300);
  assert.deepEqual(restored.getRecipes().find((recipe) => recipe.id === 'fabric').inputs, { cloth: 20 });
  assert.equal(job.duration, 30); assert.equal(job.remaining, 12); assert.deepEqual(job.inputs, { cloth: 3 });
  restored.tick(12); assert.equal(restored.claimQueuedProduction(job.id).ok, true);
  assert.equal(restored.state.resources.cloth, cloth, 'A newly verified recipe never retroactively charges a paid old batch');
});

test('the separate continuation chain can finish using real factory queues and pays each delivery and reward once', () => {
  const game = continuationGame(); build(game, 'scavenger');
  // A genuine earlier v0.6 voyage is an accepted cumulative milestone. It grants
  // only its task reward here, never recreates or credits a voyage cargo record.
  game.state.scavenging.completedTrips = 1;
  for (const definition of CONTINUATION_QUESTS) {
    if (definition.id === 'materials-built') build(game, 'materials');
    if (definition.id === 'fabric-made') craft(game, 'fabric', 2);
    if (definition.id === 'rope-made') craft(game, 'rope');
    if (definition.id === 'construction-built') build(game, 'construction');
    if (definition.id === 'planks-made') craft(game, 'plank', 2);
    if (definition.id === 'tailor-built') { craft(game, 'fabric', 2); build(game, 'tailor'); }
    if (definition.id === 'lifejacket-made') craft(game, 'lifejacket');
    if (definition.id === 'scavenger-enhanced') assert.equal(game.upgradeScavenging().ok, true);
    if (definition.id === 'second-boat') build(game, 'scavenger');
    if (definition.id === 'logistics-reserve') { craft(game, 'plank', 3); craft(game, 'fabric', 2); craft(game, 'rope', 2); craft(game, 'lifejacket'); }
    if (definition.id === 'seafood-kitchen-built') build(game, 'seafoodKitchen');
    if (definition.id === 'collector-grilled-fish') craft(game, 'grilledFish');
    const quest = game.getContinuationQuests().find((value) => value.id === definition.id);
    assert.equal(quest.active, true, definition.id); assert.equal(quest.complete, true, definition.id);
    assert.deepEqual(quest.cost, definition.cost); assert.ok(quest.action.type);
    const resources = clone(game.state.resources);
    const experience = game.state.profile.experience;
    assert.equal(game.claimContinuationQuest(definition.id).ok, true, definition.id);
    for (const key of Object.keys(game.state.resources)) assert.ok(Math.abs(game.state.resources[key] - (resources[key] - (definition.cost[key] || 0) + (definition.reward[key] || 0))) < 1e-6, `${definition.id}:${key}`);
    assert.equal(game.state.profile.experience, experience + (definition.reward.experience || 0));
    assert.equal(Object.hasOwn(game.state.resources, 'experience'), false);
    const once = game.getState(); assert.equal(game.claimContinuationQuest(definition.id).ok, false); assert.deepEqual(game.getState(), once);
  }
  assert.equal(game.state.continuation.claimed.length, 14); assert.equal(game.state.completed, true);
  assert.equal(game.state.quests.claimed.length, 14); assert.equal(game.state.scavenging.upgradeLevel, 1, 'The full chain does not require grinding optional tier-two enhancement');
  assert.equal(game.getContinuationQuests().every((quest) => quest.claimed), true);
});

test('the seafood kitchen preserves old kitchen saves, queues the recorded grilled fish and settles collector experience and coins once', () => {
  const storage = memoryStorage(), game = continuationGame({ storage });
  const oldKitchen = build(game, 'kitchen'); oldKitchen.stored = 5; oldKitchen.progress = 4;
  game.state.continuation.claimed = CONTINUATION_QUESTS.slice(0, 12).map((quest) => quest.id);
  game.state.profile.experience = 50; game.save();
  const raw = JSON.parse(storage.getItem('fkssj-save-v1'));
  delete raw.resources.grilledFish; delete raw.production.collected.grilledFish;
  for (const category of ['totalCollected', 'productionCollected', 'productionGenerated', 'salvageCollected']) delete raw.stats[category].grilledFish;
  storage.setItem('fkssj-save-v1', JSON.stringify(raw));
  const restored = new GameState({ storage, now: () => 1_000_000 });
  assert.deepEqual(restored.state.buildings.find((building) => building.id === oldKitchen.id), oldKitchen);
  assert.equal(restored.state.resources.grilledFish, 0); assert.equal(restored.state.production.collected.grilledFish, 0);
  assert.equal(restored.state.quests.claimed.length, 14); assert.equal(restored.state.continuation.claimed.length, 12);
  assert.equal(restored.getContinuationQuests().find((quest) => quest.active).id, 'seafood-kitchen-built');
  assert.equal(restored.getContinuationQuests().find((quest) => quest.active).complete, false, 'The old project kitchen is not silently counted as the new seafood kitchen');
  assert.equal(restored.getProductionInfo(oldKitchen.id).resource, 'food');
  assert.equal(restored.claimContinuationQuest('collector-grilled-fish').ok, false);
  assert.deepEqual(BUILDINGS.seafoodKitchen.cost, { wood: 22, scrap: 10 });
  assert.equal(BUILDINGS.seafoodKitchen.maxLevel, 2); assert.equal(BUILDINGS.seafoodKitchen.production, undefined);
  const resources = clone(restored.state.resources), kitchen = build(restored, 'seafoodKitchen');
  assert.equal(restored.state.resources.wood, resources.wood - 22); assert.equal(restored.state.resources.scrap, resources.scrap - 10);
  assert.equal(restored.getProductionInfo(kitchen.id), null); assert.deepEqual(restored.getUpgradeCost(kitchen.id), { coin: 1500, fish: 200 });
  const beforeBuildClaim = restored.getState();
  assert.deepEqual(restored.claimContinuationQuest('seafood-kitchen-built').reward, {});
  assert.deepEqual(restored.state.resources, beforeBuildClaim.resources, 'No unknown build reward is fabricated');
  assert.equal(restored.claimContinuationQuest('seafood-kitchen-built').ok, false);
  const collector = restored.getContinuationQuests().find((quest) => quest.id === 'collector-grilled-fish');
  assert.equal(collector.active, true); assert.equal(collector.complete, false); assert.deepEqual(collector.missing, { grilledFish: 1 });
  const recipe = restored.getRecipes(kitchen.id)[0];
  assert.deepEqual(recipe.inputs, { fish: 1, wood: 5 }); assert.equal(recipe.seconds, 300); assert.equal(recipe.storage, 50);
  const paidFish = restored.state.resources.fish, paidWood = restored.state.resources.wood;
  const queued = restored.queueProduction('grilledFish', 1, kitchen.id);
  assert.equal(queued.ok, true); assert.equal(restored.state.resources.fish, paidFish - 1); assert.equal(restored.state.resources.wood, paidWood - 5);
  assert.equal(restored.claimQueuedProduction(queued.job.id).ok, false);
  restored.tick(299.9); assert.equal(restored.getProductionQueue(kitchen.id)[0].status, 'running');
  assert.equal(restored.state.resources.grilledFish, 0);
  restored.tick(0.1); assert.equal(restored.getProductionQueue(kitchen.id)[0].status, 'ready');
  assert.deepEqual(restored.claimQueuedProduction(queued.job.id).resources, { grilledFish: 1 });
  assert.equal(restored.claimQueuedProduction(queued.job.id).ok, false);
  const coin = restored.state.resources.coin, experience = restored.state.profile.experience, nestedClaims = [];
  restored.onChange((state, event) => { if (event.type === 'continuationQuestClaimed' && event.quest.id === 'collector-grilled-fish') nestedClaims.push(restored.claimContinuationQuest(event.quest.id).ok); }, { immediate: false });
  const delivered = restored.claimContinuationQuest('collector-grilled-fish');
  assert.equal(delivered.ok, true); assert.deepEqual(delivered.reward, { experience: 40, coin: 75 });
  assert.deepEqual(delivered.resources, { coin: 75 }); assert.deepEqual(delivered.profile, { experience: 90, level: 2 });
  assert.equal(restored.state.resources.grilledFish, 0); assert.equal(restored.state.resources.coin, coin + 75);
  assert.equal(restored.state.profile.experience, experience + 40); assert.equal(Object.hasOwn(restored.state.resources, 'experience'), false);
  assert.deepEqual(nestedClaims, [false]);
  const settled = restored.getState(); assert.equal(restored.claimContinuationQuest('collector-grilled-fish').ok, false); assert.deepEqual(restored.getState(), settled);
  const again = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(again.claimContinuationQuest('collector-grilled-fish').ok, false);
  assert.equal(again.state.profile.experience, 90); assert.equal(again.state.resources.coin, coin + 75);
  assert.deepEqual(again.state.continuation.claimed.slice(0, 12), raw.continuation.claimed);
  assert.equal(again.state.continuation.claimed.length, 14); assert.equal(again.state.production.version, 6);
});

test('future or damaged paid production and task records lock automatic persistence instead of discarding purchases or rewards', () => {
  assert.throws(() => normalizeProduction({ version: 7 }, [], []), /更新版本/);
  for (const [key, value] of [['production', { version: 7 }], ['production', { version: 0 }], ['production', { version: 'invalid' }], ['continuation', { version: 2 }], ['production', { version: 1, queue: [{ id: 'paid-but-damaged' }] }], ['continuation', { version: 1, claimed: ['future-task'] }]]) {
    const storage = memoryStorage(), game = continuationGame({ storage }); game.save();
    const raw = JSON.parse(storage.getItem('fkssj-save-v1')); raw[key] = value;
    const original = JSON.stringify(raw); storage.setItem('fkssj-save-v1', original);
    let now = 1_000_000;
    const locked = new GameState({ storage, now: () => now });
    assert.equal(locked.persistenceLocked, true, key); now += 6000; locked.tick(6); locked.collect('coin');
    assert.equal(storage.getItem('fkssj-save-v1'), original); assert.equal(locked.save().persisted, false);
    locked.reset(); assert.equal(locked.persistenceLocked, false); assert.deepEqual(locked.state.production, createProduction());
  }
  assert.equal(RECIPES.find((recipe) => recipe.id === 'lifejacket').seconds, 300);
});

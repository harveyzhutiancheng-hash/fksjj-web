import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState, BUILDINGS, QUESTS } from './game-state.js';
import { STORY_QUESTS } from './story-state.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function memoryStorage() { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }
function camp(options = {}) {
  const game = new GameState({ storage: null, autoLoad: false, now: () => 1_000_000, ...options });
  game.state.quests.claimed = QUESTS.map((quest) => quest.id); game.state.completed = true;
  game.state.profile.experience = 305; game.state.profile.level = 6;
  for (const key of Object.keys(game.state.resources)) game.state.resources[key] = 10000;
  game.state.resources.grilledFish = 0; game.state.resources.seaweedJuice = 0;
  const broadcast = game.placeBuilding('broadcast', -1, -1); assert.equal(broadcast.ok, true);
  return game;
}
function startDock(game) { const result = game.placeBuilding('divingDock', 1, 0); assert.equal(result.ok, true, result.message); return result; }
function kitchen(game) { const result = game.placeBuilding('seafoodKitchen', 0, 1); assert.equal(result.ok, true); return result.building; }
function rawSave(storage) { return JSON.parse(storage.getItem('fkssj-save-v1')); }

test('a twenty-second dock reserves its tile and payment but cannot dive, count as built or finish its story early', () => {
  const game = camp(), coin = game.state.resources.coin, completed = [];
  game.state.story.claimed = STORY_QUESTS.slice(0, STORY_QUESTS.findIndex((quest) => quest.id === 'diving-dock-built')).map((quest) => quest.id);
  game.onChange((state, event) => { if (event.type === 'tick') completed.push(...event.constructionCompleted); }, { immediate: false });
  const result = startDock(game), id = result.id;
  assert.equal(BUILDINGS.divingDock.buildSeconds, 20); assert.equal(result.queued, true); assert.equal(result.building.level, 1);
  assert.equal(game.state.resources.coin, coin - 1500); assert.equal(game.isBuildingReady(id), false); assert.equal(game.getFactoryUnlock('divingDock').unlocked, true);
  assert.equal(game.state.stats.buildingsBuilt.divingDock || 0, 0); assert.equal(game.getCurrentTask().complete, false);
  assert.equal(game.startDiving().ok, false); assert.equal(game.claimStoryQuest('diving-dock-built').ok, false);
  const snapshot = game.getConstruction(id); assert.equal(snapshot.kind, 'build'); assert.equal(snapshot.remaining, 20); assert.equal(snapshot.progress, 0);
  snapshot.remaining = 0; snapshot.cost.coin = 0; assert.equal(game.getConstruction(id).remaining, 20); assert.equal(game.getConstruction(id).cost.coin, 1500);
  const paid = game.getState(); assert.equal(game.placeBuilding('divingDock', 1, 0).ok, false); assert.equal(game.upgradeBuilding(id).ok, false); assert.deepEqual(game.getState(), paid);
  game.tick(19.75); assert.equal(game.getConstruction(id).remaining, 0.25); assert.equal(game.isBuildingReady(id), false); assert.equal(game.startDiving().ok, false); assert.equal(game.getCurrentTask().complete, false);
  const last = game.tick(0.25); assert.equal(last.constructionCompleted.length, 1); assert.equal(last.constructionCompleted[0].buildingId, id);
  assert.equal(game.getConstruction(id), null); assert.equal(game.isBuildingReady(id), true); assert.equal(game.state.stats.buildingsBuilt.divingDock, 1); assert.equal(game.getCurrentTask().complete, true);
  assert.equal(game.startDiving().ok, true); game.tick(20); assert.equal(completed.length, 1); assert.equal(game.state.stats.buildingsBuilt.divingDock, 1); assert.equal(game.state.resources.coin, coin - 1500);
  assert.equal(game.getConstruction('missing'), null); assert.equal(game.isBuildingReady('missing'), false);
});

test('a kitchen retains level one and existing paid production during the full upgrade, then unlocks new recipes exactly once', () => {
  const game = camp(), building = kitchen(game), old = game.queueProduction('grilledFish', 1, building.id); assert.equal(old.ok, true);
  game.tick(100); const remaining = game.getProductionQueue(building.id)[0].remaining, stock = clone(game.state.resources), upgrades = game.state.stats.upgrades;
  const upgrade = game.upgradeBuilding(building.id); assert.equal(upgrade.ok, true); assert.equal(upgrade.queued, true); assert.equal(BUILDINGS.seafoodKitchen.upgradeSeconds, 1200);
  assert.equal(building.level, 1); assert.equal(game.isBuildingReady(building.id), true); assert.equal(game.getConstruction(building.id).targetLevel, 2); assert.equal(game.state.stats.upgrades, upgrades);
  assert.equal(game.state.resources.coin, stock.coin - 1500); assert.equal(game.state.resources.fish, stock.fish - 200);
  assert.equal(game.getRecipes(building.id).find((recipe) => recipe.id === 'seaweedJuice').unlocked, false);
  assert.equal(game.getRecipes(building.id).find((recipe) => recipe.id === 'grilledFish').canQueue, true);
  assert.equal(game.getProductionQueue(building.id)[0].remaining, remaining);
  const paid = game.getState(); assert.equal(game.upgradeBuilding(building.id).ok, false); assert.equal(game.queueProduction('seaweedJuice', 1, building.id).ok, false); assert.deepEqual(game.getState(), paid);
  const second = game.queueProduction('grilledFish', 1, building.id); assert.equal(second.ok, true, 'New old-level batches remain available by the documented compatibility rule');
  game.tick(200); assert.equal(game.getConstruction(building.id).remaining, 1000); assert.equal(building.level, 1);
  assert.equal(game.claimQueuedProduction(old.job.id).ok, true); assert.equal(game.claimQueuedProduction(old.job.id).ok, false);
  game.tick(999.75); assert.equal(game.getConstruction(building.id).remaining, 0.25); assert.equal(building.level, 1);
  assert.equal(game.claimQueuedProduction(second.job.id).ok, true); assert.equal(game.getRecipes(building.id).find((recipe) => recipe.id === 'seaweedJuice').unlocked, false);
  const finish = game.tick(0.25); assert.equal(finish.constructionCompleted.length, 1); assert.equal(building.level, 2); assert.equal(game.getConstruction(building.id), null); assert.equal(game.state.stats.upgrades, upgrades + 1);
  assert.equal(game.getRecipes(building.id).find((recipe) => recipe.id === 'seaweedJuice').canQueue, true); assert.equal(game.getProductionQueue(building.id).length, 0);
  const done = game.getState(); assert.equal(game.upgradeBuilding(building.id).ok, false); assert.deepEqual(game.getState(), done);
});

test('saved partial docks stay incomplete through normalization and offline time finishes them once without charging again', () => {
  const storage = memoryStorage(); let now = 1_000_000;
  const game = camp({ storage, now: () => now }), id = startDock(game).id, paidCoin = game.state.resources.coin;
  now += 7000; game.tick(7); assert.equal(rawSave(storage).buildings.find((building) => building.id === id).construction.remaining, 13);
  now += 12000; const restored = new GameState({ storage, now: () => now });
  assert.equal(restored.persistenceLocked, false); assert.equal(restored.getConstruction(id).remaining, 1); assert.equal(restored.isBuildingReady(id), false); assert.equal(restored.state.stats.buildingsBuilt.divingDock, 0); assert.equal(restored.startDiving().ok, false);
  const again = new GameState({ storage, now: () => now }); assert.equal(again.getConstruction(id).remaining, 1); assert.equal(again.state.stats.buildingsBuilt.divingDock, 0);
  now += 1000; const finished = new GameState({ storage, now: () => now }); assert.equal(finished.getConstruction(id), null); assert.equal(finished.state.stats.buildingsBuilt.divingDock, 1); assert.equal(finished.state.resources.coin, paidCoin);
  const last = new GameState({ storage, now: () => now }); assert.equal(last.state.stats.buildingsBuilt.divingDock, 1); assert.equal(last.state.resources.coin, paidCoin); assert.equal(last.getConstruction(id), null);
});

test('bounded offline advancement completes an upgrade and its old paid batches without replaying completions or auto-crediting products', () => {
  const storage = memoryStorage(); let now = 1_000_000;
  const game = camp({ storage, now: () => now }), building = kitchen(game), batch = game.queueProduction('grilledFish', 1, building.id); assert.equal(batch.ok, true);
  assert.equal(game.upgradeBuilding(building.id).ok, true); const paid = clone(game.state.resources);
  now += 3 * 60 * 60 * 1000; const restored = new GameState({ storage, now: () => now });
  assert.equal(restored.state.offlineReport.seconds, 7200); assert.equal(restored.state.offlineReport.constructionCompleted.length, 1); assert.equal(restored.state.offlineReport.constructionCompleted[0].kind, 'upgrade');
  assert.equal(restored.getConstruction(building.id), null); assert.equal(restored.state.buildings.find((value) => value.id === building.id).level, 2); assert.equal(restored.state.stats.upgrades, 1);
  assert.equal(restored.getProductionQueue(building.id)[0].status, 'ready'); assert.equal(restored.state.resources.grilledFish, 0); assert.equal(restored.state.resources.coin, paid.coin); assert.equal(restored.state.resources.fish, paid.fish);
  assert.equal(restored.claimQueuedProduction(batch.job.id).ok, true); assert.equal(restored.state.resources.grilledFish, 1);
  const again = new GameState({ storage, now: () => now }); assert.equal(again.state.offlineReport, null); assert.equal(again.state.stats.upgrades, 1); assert.equal(again.claimQueuedProduction(batch.job.id).ok, false); assert.equal(again.state.stats.productionGenerated.grilledFish, 1);
});

test('old version-four completed buildings and levels never acquire retroactive waiting or reprice an already-paid juice batch', () => {
  const storage = memoryStorage(), game = camp({ storage });
  const id = startDock(game).id; game.tick(20); const building = kitchen(game); game.upgradeBuilding(building.id); game.tick(1200);
  const batch = game.queueProduction('seaweedJuice', 1, building.id); assert.equal(batch.ok, true); game.save();
  const raw = rawSave(storage); raw.production.version = 4; Object.assign(raw.production.queue[0], { duration: 900, remaining: 37, inputs: { seaweed: 12, glass: 6 } });
  const job = clone(raw.production.queue[0]), stock = clone(raw.resources); storage.setItem('fkssj-save-v1', JSON.stringify(raw));
  const restored = new GameState({ storage, now: () => 1_000_000 }); assert.equal(restored.state.production.version, 6); assert.equal(restored.persistenceLocked, false);
  assert.equal(restored.isBuildingReady(id), true); assert.equal(restored.getConstruction(id), null); assert.equal(restored.getConstruction(building.id), null); assert.equal(restored.state.buildings.find((value) => value.id === building.id).level, 2);
  assert.deepEqual(restored.state.resources, stock); assert.deepEqual(restored.state.production.queue[0], job);
  restored.tick(37); assert.equal(restored.claimQueuedProduction(job.id).ok, true); assert.equal(restored.state.resources.seaweed, stock.seaweed); assert.equal(restored.state.resources.glass, stock.glass); assert.equal(restored.state.resources.coin, stock.coin);
});

test('zero and extremely small persisted remaining times finish once, without losing a positive remainder below the ordinary camp step', () => {
  for (const remainder of [0, 5e-8]) {
    const storage = memoryStorage(), game = camp({ storage }), id = startDock(game).id, raw = rawSave(storage);
    raw.buildings.find((building) => building.id === id).construction.remaining = remainder; storage.setItem('fkssj-save-v1', JSON.stringify(raw));
    const restored = new GameState({ storage, now: () => 1_000_000 }), completions = [];
    restored.onChange((state, event) => completions.push(...(event.constructionCompleted || [])), { immediate: false });
    if (remainder > 0) {
      assert.equal(restored.isBuildingReady(id), false); restored.tick(2e-8); assert.ok(restored.getConstruction(id).remaining > 0); assert.equal(restored.state.stats.buildingsBuilt.divingDock, 0);
      restored.tick(restored.getConstruction(id).remaining); assert.equal(completions.length, 1);
    }
    assert.equal(restored.getConstruction(id), null); assert.equal(restored.state.stats.buildingsBuilt.divingDock, 1); restored.tick(1); assert.equal(restored.state.stats.buildingsBuilt.divingDock, 1);
    const again = new GameState({ storage, now: () => 1_000_000 }); assert.equal(again.getConstruction(id), null); assert.equal(again.state.stats.buildingsBuilt.divingDock, 1);
  }
});

test('independent construction snapshots advance together while only the expired operation completes', () => {
  const game = camp(), dock = startDock(game).id, building = kitchen(game); assert.equal(game.upgradeBuilding(building.id).ok, true);
  const first = game.tick(20); assert.deepEqual(first.constructionCompleted.map((event) => event.buildingId), [dock]); assert.equal(game.getConstruction(building.id).remaining, 1180); assert.equal(building.level, 1);
  const second = game.tick(1180); assert.deepEqual(second.constructionCompleted.map((event) => event.buildingId), [building.id]); assert.equal(building.level, 2); assert.equal(game.state.stats.buildingsBuilt.divingDock, 1); assert.equal(game.state.stats.upgrades, 1);
});

test('synchronous subscribers cannot duplicate a paid upgrade or replay its completion during a nested tick', () => {
  const game = camp(), building = kitchen(game), coin = game.state.resources.coin, fish = game.state.resources.fish, attempts = [], completed = [];
  game.onChange((state, event) => {
    if (event.type === 'upgrade' && event.queued) { attempts.push(game.upgradeBuilding(building.id).ok); game.tick(1200); }
    if (event.type === 'tick' && event.constructionCompleted.length) { completed.push(...event.constructionCompleted); game.tick(0); }
  }, { immediate: false });
  const result = game.upgradeBuilding(building.id);
  assert.equal(result.ok, true); assert.equal(result.job.targetLevel, 2); assert.equal(building.level, 2); assert.deepEqual(attempts, [false]);
  assert.equal(completed.length, 1); assert.equal(game.state.stats.upgrades, 1); assert.equal(game.state.resources.coin, coin - 1500); assert.equal(game.state.resources.fish, fish - 200);
});

test('damaged or future construction snapshots and colliding paid sites keep the original raw save locked until reset', () => {
  const mutations = [
    (raw, building) => { building.construction = null; },
    (raw, building) => { building.construction.version = 2; },
    (raw, building) => { delete building.construction.version; },
    (raw, building) => { building.construction.remaining = -1; },
    (raw, building) => { building.construction.remaining = 21; },
    (raw, building) => { building.construction.targetLevel = 2; },
    (raw, building) => { building.construction.kind = 'upgrade'; },
    (raw, building) => { building.construction.cost = {}; },
    (raw, building) => { building.construction.cost = { unknownCurrency: 1500 }; },
    (raw, building) => { building.x = 99; },
    (raw, building) => { raw.buildings.push({ id: 'colliding', type: 'bed', x: building.x, z: building.z, level: 1 }); },
    (raw) => { raw.production.version = 7; },
  ];
  for (const mutate of mutations) {
    const storage = memoryStorage(); let now = 1_000_000; const source = camp({ storage, now: () => now }), id = startDock(source).id;
    const raw = rawSave(storage); mutate(raw, raw.buildings.find((building) => building.id === id)); const original = JSON.stringify(raw); storage.setItem('fkssj-save-v1', original);
    const locked = new GameState({ storage, now: () => now }); assert.equal(locked.persistenceLocked, true); now += 6000; locked.tick(6); locked.collect('wood'); assert.equal(locked.save().persisted, false); assert.equal(storage.getItem('fkssj-save-v1'), original);
    locked.reset(); assert.equal(locked.persistenceLocked, false); assert.equal(locked.state.production.version, 6); assert.equal(locked.state.buildings.some((building) => building.construction), false);
  }
});

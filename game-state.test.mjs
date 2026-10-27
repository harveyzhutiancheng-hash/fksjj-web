import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState, BUILDINGS, QUESTS, RESIDENT_ORDERS } from './game-state.js';
const createGame = () => new GameState({ storage: null, autoLoad: false });
const memoryStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
function fund(game, cost) {
  for (const [key, amount] of Object.entries(cost)) while (game.state.resources[key] < amount) assert.equal(game.collect(key).ok, true);
}
function build(game, type) {
  fund(game, BUILDINGS[type].cost);
  const tile = game.state.raft.find((candidate) => !game.state.buildings.some((building) => building.x === candidate.x && building.z === candidate.z));
  assert.ok(tile, `An empty tile exists for ${type}`);
  const result = game.placeBuilding(type, tile.x, tile.z);
  assert.equal(result.ok, true, result.message);
  return result.building;
}
function claim(game, id) {
  const result = game.claimQuest(id);
  assert.equal(result.ok, true, `${id}: ${result.message}`);
}

test('initial raft, occupancy and expansion rules preserve resources on invalid actions', () => {
  const game = createGame();
  assert.equal(game.state.raft.length, 9);
  assert.equal(game.state.buildings[0].type, 'command');
  const before = structuredClone(game.state.resources);
  assert.equal(game.placeBuilding('fishing', 0, 0).ok, false);
  assert.equal(game.expand(5, 5).ok, false);
  assert.equal(game.expand(1.5, 1).ok, false);
  assert.deepEqual(game.state.resources, before);
  assert.equal(game.expand(2, 0).ok, true);
  assert.equal(game.state.raft.length, 10);
  assert.equal(game.expand(2, 0).ok, false);
});

test('guide progress uses cumulative collected resources and rewards are claimed once in order', () => {
  const game = createGame();
  assert.equal(game.questStatus('salvage').current, 0);
  assert.equal(game.claimQuest('salvage').ok, false);
  assert.equal(game.claimQuest('fishing').ok, false);
  game.collect('wood'); game.collect('wood'); game.collect('wood');
  const fishing = build(game, 'fishing');
  assert.ok(fishing);
  assert.equal(game.questStatus('salvage').current, 18);
  assert.equal(game.questStatus('salvage').complete, true);
  claim(game, 'salvage');
  const resources = structuredClone(game.state.resources);
  assert.equal(game.claimQuest('salvage').ok, false);
  assert.deepEqual(game.state.resources, resources);
  claim(game, 'fishing');
});

test('manual fishing has a persistent cooldown and counts towards the fish mission', () => {
  const game = createGame();
  assert.equal(game.castLine().ok, false);
  build(game, 'fishing');
  assert.equal(game.castLine().amount, 3);
  assert.equal(game.castLine().ok, false);
  game.tick(2.49);
  assert.equal(game.castLine().ok, false);
  game.tick(0.01);
  assert.equal(game.castLine().amount, 4);
  assert.equal(game.state.stats.fishCollected, 7);
  assert.equal(game.state.stats.productionCollected.fish, 0);
});

test('manual sashimi pays fish only when queued and never produces or credits food without an explicit batch and collection', () => {
  const game = createGame();
  const slicer = build(game, 'slicer');
  game.tick(100);
  assert.equal(slicer.stored, 0);
  assert.equal(game.getProductionInfo(slicer.id).blocked, 'manual');
  assert.equal(game.getProductionInfo(slicer.id).manual, true);
  game.collect('fish');
  const insufficient = game.getState(); assert.equal(game.queueProduction('sashimi', 1, slicer.id).ok, false); assert.deepEqual(game.getState(), insufficient);
  game.tick(10);
  assert.equal(slicer.stored, 0);
  game.collect('fish');
  const queued = game.queueProduction('sashimi', 1, slicer.id); assert.equal(queued.ok, true); assert.deepEqual(queued.cost, { fish: 6 });
  assert.equal(game.state.resources.fish, 0); game.tick(89.75); assert.equal(game.claimQueuedProduction(queued.job.id).ok, false); game.tick(.25);
  assert.equal(slicer.stored, 0);
  assert.equal(game.state.stats.productionCollected.food, 0);
  assert.equal(game.collectProduction(slicer.id).ok, false);
  assert.deepEqual(game.claimQueuedProduction(queued.job.id).resources, { food: 1 });
  assert.equal(game.state.stats.productionCollected.food, 1); assert.equal(game.state.production.collected.food, 1); assert.equal(game.state.resources.food, 1);
  game.tick(90); assert.equal(game.state.resources.food, 1); assert.equal(game.state.resources.fish, 0); assert.equal(game.state.stats.productionGenerated.food, 1); assert.equal(game.claimQueuedProduction(queued.job.id).ok, false);
});

test('workers are bounded by residents while unstaffed facilities still produce', () => {
  const game = createGame();
  const fishing = build(game, 'fishing');
  const purifier = build(game, 'purifier');
  assert.equal(fishing.workers, 1);
  assert.equal(purifier.workers, 0);
  assert.equal(game.availableWorkers, 0);
  assert.equal(game.assignWorker(purifier.id).ok, false);
  game.tick(30);
  assert.ok(purifier.stored > 0);
  assert.equal(game.assignWorker(fishing.id, -1).ok, true);
  assert.equal(game.assignWorker(purifier.id, 1).ok, true);
  assert.equal(game.assignWorker(purifier.id, 2).ok, false);
  assert.equal(game.assignWorker(purifier.id, -2).ok, false);
});

test('offline production is bounded, stored rather than auto-collected, and applied only once', () => {
  const storage = memoryStorage();
  let now = 1_000_000;
  const game = new GameState({ storage, now: () => now, autoLoad: false });
  const fishing = build(game, 'fishing');
  game.castLine();
  game.save();
  now += 10 * 60 * 60 * 1000;
  const restored = new GameState({ storage, now: () => now });
  assert.equal(restored.state.offlineReport.seconds, 7200);
  assert.equal(restored.state.offlineReport.capped, true);
  assert.equal(restored.state.buildings.find((building) => building.id === fishing.id).stored, BUILDINGS.fishing.production.capacity);
  assert.equal(restored.state.stats.productionCollected.fish, 0);
  assert.equal(restored.state.resources.fish, 3);
  assert.ok(restored.state.population.hunger >= 0);
  assert.equal(restored.state.population.total, 1);
  const reloaded = new GameState({ storage, now: () => now });
  assert.equal(reloaded.state.offlineReport, null);
  assert.equal(reloaded.state.elapsed, restored.state.elapsed);
});

test('invalid or future saves remain intact and persistence failures do not break actions', () => {
  const storage = memoryStorage();
  storage.setItem('fkssj-save-v1', '{broken');
  const game = new GameState({ storage });
  assert.equal(storage.getItem('fkssj-save-v1'), '{broken');
  assert.equal(game.state.population.total, 1);
  storage.setItem('fkssj-save-v1', JSON.stringify({ version: 99 }));
  assert.equal(new GameState({ storage }).state.raft.length, 9);
  assert.equal(JSON.parse(storage.getItem('fkssj-save-v1')).version, 99);
  const blockedStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const temporary = new GameState({ storage: blockedStorage });
  assert.equal(temporary.collect('wood').ok, true);
  assert.ok(temporary.storageError);
});

test('invalid saves stay protected through autosave and actions until an explicit reset', () => {
  for (const raw of ['{broken', JSON.stringify({ version: 99 }), JSON.stringify({ version: 1, raft: [] })]) {
    const storage = memoryStorage();
    let now = 1_000_000;
    storage.setItem('fkssj-save-v1', raw);
    const game = new GameState({ storage, now: () => now });
    assert.equal(game.persistenceLocked, true);
    assert.match(game.storageError, /暂停自动保存/);
    now += 6000;
    game.tick(6);
    assert.equal(game.collect('wood').ok, true);
    assert.equal(storage.getItem('fkssj-save-v1'), raw);
    assert.equal(game.save().ok, false);
    assert.equal(game.save().persisted, false);
    assert.equal(storage.getItem('fkssj-save-v1'), raw);
    assert.equal(game.reset().ok, true);
    assert.equal(game.persistenceLocked, false);
    assert.equal(game.storageError, null);
    assert.equal(game.save().persisted, true);
    const restored = new GameState({ storage, now: () => now });
    assert.equal(restored.persistenceLocked, false);
    assert.equal(restored.state.resources.wood, 8);
    assert.equal(restored.state.stats.salvageCount, 0);
  }
});

test('successfully loading a repaired valid save unlocks persistence without a reset', () => {
  const storage = memoryStorage();
  const original = new GameState({ storage, now: () => 1_000_000, autoLoad: false });
  original.collect('wood');
  const validRaw = storage.getItem('fkssj-save-v1');
  storage.setItem('fkssj-save-v1', '{broken');
  const game = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(game.persistenceLocked, true);
  storage.setItem('fkssj-save-v1', validRaw);
  assert.equal(game.load().loaded, true);
  assert.equal(game.persistenceLocked, false);
  assert.equal(game.storageError, null);
  assert.equal(game.state.stats.salvageCount, 1);
  assert.equal(game.save().persisted, true);
});

test('resident orders require actual production, protect the first meal and settle once in unlock order', () => {
  const game = createGame();
  assert.equal(RESIDENT_ORDERS.length, 10);
  assert.deepEqual(game.state.profile, { experience: 0, level: 1 });
  assert.deepEqual(game.getResidentOrder().missing, { food: 5 });
  for (let index = 0; index < 3; index++) game.collect('food');
  game.tick(300);
  assert.equal(game.state.resources.food, 6);
  assert.equal(game.state.resources.water, 3);
  assert.ok(game.state.population.hunger < 100);
  assert.equal(game.getResidentOrder().productionReady, false);
  assert.equal(game.deliverResidentOrder('first-meal').ok, false);
  const slicer = build(game, 'slicer');
  fund(game, { fish: 30 }); const sashimi = game.queueProduction('sashimi', 5, slicer.id); assert.equal(sashimi.ok, true);
  game.tick(450);
  assert.equal(game.claimQueuedProduction(sashimi.job.id).ok, true); assert.equal(game.state.stats.productionCollected.food, 5);
  assert.equal(game.getResidentOrder().canDeliver, true);
  const foodBefore = game.state.resources.food;
  const coinBefore = game.state.resources.coin;
  const delivered = game.deliverResidentOrder('first-meal');
  assert.equal(delivered.ok, true);
  assert.equal(game.state.resources.food, foodBefore - 5);
  assert.equal(game.state.resources.coin, coinBefore + RESIDENT_ORDERS[0].reward.coin);
  assert.deepEqual(game.state.profile, { experience: 60, level: 2 });
  assert.equal(game.questStatus('food').complete, true);
  const settledState = game.getState();
  assert.equal(game.deliverResidentOrder('first-meal').ok, false);
  assert.deepEqual(game.getState(), settledState);
  assert.equal(game.getResidentOrder().id, 'fresh-water');
  assert.equal(game.getResidentOrder().status, 'locked');
  const purifier = build(game, 'purifier');
  game.tick(100);
  assert.ok(game.state.resources.food < foodBefore - 5, 'Normal physiological consumption resumes after the first delivery');
  assert.equal(game.collectProduction(purifier.id).ok, true);
  assert.equal(game.getResidentOrder().status, 'active');
  assert.equal(game.deliverResidentOrder('welcome-meal').ok, false);
  fund(game, game.getResidentOrder().order.cost);
  assert.equal(game.deliverResidentOrder('fresh-water').ok, true);
  assert.equal(game.getResidentOrder().status, 'locked');
  build(game, 'scavenger');
  fund(game, { water: 3, food: 3 });
  assert.equal(game.explore().ok, true);
  assert.equal(game.getResidentOrder().id, 'welcome-meal');
  fund(game, game.getResidentOrder().order.cost);
  assert.equal(game.deliverResidentOrder().ok, true);
  assert.equal(game.getResidentOrder().id, 'deodorizer-meal');
  assert.equal(game.getResidentOrder().status, 'locked');
  assert.deepEqual(game.state.profile, { experience: 240, level: 5 });
  assert.equal(game.deliverResidentOrder().ok, false);
});

test('an old three-order save exposes the recorded deodorizer meal after collection and settles its actual cooked fish exactly once', () => {
  const storage = memoryStorage(), now = () => 1_000_000;
  const legacy = new GameState({ storage: null, now, autoLoad: false }).getState();
  legacy.quests.claimed = QUESTS.map((quest) => quest.id);
  legacy.residentOrders = { completed: ['first-meal', 'fresh-water', 'welcome-meal'] };
  legacy.profile = { experience: 240, level: 5 }; legacy.resources.water = 0; legacy.resources.plastic = 40;
  storage.setItem('fkssj-save-v1', JSON.stringify(legacy));
  const game = new GameState({ storage, now });
  assert.equal(game.persistenceLocked, false);
  assert.deepEqual(game.state.residentOrders, { version: 1, completed: legacy.residentOrders.completed });
  assert.deepEqual(game.state.profile, legacy.profile); assert.deepEqual(game.state.resources, legacy.resources);
  assert.equal(game.getResidentOrder().id, 'deodorizer-meal'); assert.equal(game.getResidentOrder().status, 'locked');

  assert.equal(game.claimStoryQuest('plastic-reserve').ok, true);
  build(game, 'bed'); assert.equal(game.claimStoryQuest('small-residence').ok, true);
  const kitchen = build(game, 'seafoodKitchen'); assert.equal(game.claimStoryQuest('seafood-kitchen-built').ok, true);
  assert.equal(game.getResidentOrder().unlocked, false, 'A ready kitchen alone does not bypass the collector prerequisite');
  fund(game, { fish: 2, wood: 10 });
  const job = game.queueProduction('grilledFish', 2, kitchen.id); assert.equal(job.ok, true);
  game.tick(600); assert.equal(game.claimQueuedProduction(job.job.id).ok, true);
  assert.equal(game.state.resources.grilledFish, 2);
  assert.equal(game.claimStoryQuest('collector-grilled-fish').ok, true);
  assert.equal(game.state.profile.experience, 305);
  const current = game.getResidentOrder();
  assert.equal(current.status, 'active'); assert.deepEqual(current.missing, { water: 1 });
  assert.deepEqual(current.order.resident, { id: 'deodorizer', name: '防臭大师', portrait: 2 });
  assert.deepEqual(current.order.cost, { grilledFish: 1, water: 1 }); assert.deepEqual(current.order.reward, { experience: 40, coin: 120 });
  current.order.cost.grilledFish = 99; assert.equal(game.getResidentOrder().order.cost.grilledFish, 1);
  const missingStock = game.getState(); assert.equal(game.deliverResidentOrder('deodorizer-meal').ok, false); assert.deepEqual(game.getState(), missingStock);

  fund(game, { water: 1 }); const before = game.getState(), nested = [], deliveredEvents = [];
  game.onChange((state, event) => {
    if (event.type === 'residentOrderDelivered') {
      deliveredEvents.push(event.order.id); nested.push(game.deliverResidentOrder('deodorizer-meal').ok);
    }
  }, { immediate: false });
  const result = game.deliverResidentOrder('deodorizer-meal');
  assert.equal(result.ok, true); assert.deepEqual(result.cost, { grilledFish: 1, water: 1 }); assert.deepEqual(result.reward, { experience: 40, coin: 120 });
  assert.equal(game.state.resources.grilledFish, before.resources.grilledFish - 1); assert.equal(game.state.resources.water, before.resources.water - 1);
  assert.equal(game.state.resources.coin, before.resources.coin + 120);
  assert.deepEqual(game.state.profile, { experience: 345, level: 6 });
  assert.deepEqual(nested, [false]); assert.deepEqual(deliveredEvents, ['deodorizer-meal']);
  assert.equal(game.getResidentOrder().id, 'xiaoqiang-fish-meal'); assert.equal(game.getResidentOrder().status, 'active');
  const settled = game.getState(); assert.equal(game.deliverResidentOrder('deodorizer-meal').ok, false); assert.deepEqual(game.getState(), settled);
  const restored = new GameState({ storage, now }); assert.deepEqual(restored.state.resources, settled.resources); assert.deepEqual(restored.state.profile, settled.profile);
  assert.equal(restored.state.residentOrders.completed.filter((id) => id === 'deodorizer-meal').length, 1);
  assert.equal(restored.deliverResidentOrder('deodorizer-meal').ok, false); assert.deepEqual(restored.state.profile, { experience: 345, level: 6 });
  assert.equal(restored.getCurrentTask().id, 'leader-six', 'The optional order never claims or inserts a story checkpoint');
});

test('the legacy collector ledger unlocks the new meal only after a usable seafood kitchen exists', () => {
  const storage = memoryStorage(), now = () => 1_000_000;
  const raw = new GameState({ storage: null, now, autoLoad: false }).getState();
  raw.quests.claimed = QUESTS.map((quest) => quest.id);
  raw.residentOrders = { completed: ['first-meal', 'fresh-water', 'welcome-meal'] };
  raw.continuation.claimed = ['collector-grilled-fish']; delete raw.story;
  raw.resources.grilledFish = 1; raw.resources.water = 1; raw.profile = { experience: 305, level: 6 };
  storage.setItem('fkssj-save-v1', JSON.stringify(raw));
  const game = new GameState({ storage, now });
  assert.equal(game.getResidentOrder().id, 'deodorizer-meal'); assert.equal(game.getResidentOrder().status, 'locked');
  const before = game.getState(); assert.equal(game.deliverResidentOrder().ok, false); assert.deepEqual(game.getState(), before);
  build(game, 'seafoodKitchen'); assert.equal(game.getResidentOrder().canDeliver, true);
  assert.equal(game.deliverResidentOrder().ok, true); assert.equal(game.state.profile.experience, 345);
});

test('unknown or future resident-order ledgers remain untouched by normalization and automatic saves', () => {
  const ledgers = [
    { version: 2, completed: ['first-meal'] },
    { completed: ['first-meal', 'future-order'] },
    { version: 1, completed: ['deodorizer-meal', 'future-order'] },
    { version: 1, completed: 'first-meal' },
    [],
  ];
  for (const ledger of ledgers) {
    const storage = memoryStorage(), now = () => 1_000_000, raw = new GameState({ storage: null, now, autoLoad: false }).getState();
    raw.residentOrders = ledger; const original = JSON.stringify(raw); storage.setItem('fkssj-save-v1', original);
    const game = new GameState({ storage, now }); assert.equal(game.persistenceLocked, true);
    game.tick(6); game.collect('wood'); assert.equal(game.save().persisted, false); assert.equal(storage.getItem('fkssj-save-v1'), original);
    game.reset(); assert.equal(game.persistenceLocked, false); assert.deepEqual(game.state.residentOrders, { version: 1, completed: [] });
    assert.equal(new GameState({ storage, now }).persistenceLocked, false);
  }
});

test('the six recorded orders extend old completed saves, debit exactly once and never invent repeatable demand', () => {
  const storage = memoryStorage(), now = () => 1_000_000;
  const raw = new GameState({ storage: null, now, autoLoad: false }).getState();
  raw.quests.claimed = QUESTS.map((quest) => quest.id);
  raw.residentOrders.completed = ['first-meal', 'fresh-water', 'welcome-meal', 'deodorizer-meal'];
  raw.story.claimed = ['seafood-kitchen-built', 'collector-grilled-fish'];
  raw.continuation.claimed = ['seafood-kitchen-built', 'collector-grilled-fish'];
  storage.setItem('fkssj-save-v1', JSON.stringify(raw));
  const game = new GameState({ storage, now });
  assert.equal(game.persistenceLocked, false);
  assert.deepEqual(game.state.resources, raw.resources);
  assert.equal(game.state.profile.experience, raw.profile.experience);
  assert.equal(game.getResidentDemandProgress().completed, 5);
  assert.equal(game.getResidentDemandProgress().knownTotal, 11);
  const kitchen = build(game, 'seafoodKitchen');
  assert.ok(kitchen);
  const expected = [
    ['xiaoqiang-fish-meal', { food: 1, grilledFish: 1 }, 40, 105],
    ['sailor-fish-vest', { grilledFish: 1, lifejacket: 1 }, 40, 180],
    ['blade-food-vest', { food: 2, lifejacket: 1 }, 40, 165],
    ['collector-vest-water', { lifejacket: 1, water: 2 }, 40, 195],
    ['coral-line-vest', { fishLine: 1, lifejacket: 1 }, 45, 105],
    ['jellyfish-fish-water', { grilledFish: 1, water: 2 }, 40, 165],
  ];
  const originalProduction = structuredClone(game.state.production.collected), nested = [];
  game.onChange((state, event) => {
    if (event.type === 'residentOrderDelivered') nested.push(game.deliverResidentOrder(event.order.id).ok);
  }, { immediate: false });
  let coins = 0, experience = 0;
  for (const [id, cost, xp, coin] of expected) {
    const order = game.getResidentOrder();
    assert.equal(order.id, id); assert.deepEqual(order.order.cost, cost);
    assert.deepEqual(order.order.reward, { experience: xp, coin });
    const missingBefore = game.getState();
    assert.equal(game.deliverResidentOrder(id).ok, false); assert.deepEqual(game.getState(), missingBefore);
    // Explicit isolated unit-test inventory, separate from public-action browser fixtures.
    for (const [key, amount] of Object.entries(cost)) game.state.resources[key] = amount;
    const before = game.getState(), progress = game.getResidentDemandProgress().completed;
    const result = game.deliverResidentOrder(id); assert.equal(result.ok, true);
    for (const [key, amount] of Object.entries(cost)) assert.equal(game.state.resources[key], before.resources[key] - amount);
    assert.equal(game.state.resources.coin, before.resources.coin + coin);
    assert.equal(game.state.profile.experience, before.profile.experience + xp);
    assert.equal(game.getResidentDemandProgress().completed, progress + 1);
    assert.deepEqual(game.state.production.collected, originalProduction);
    coins += coin; experience += xp;
    const settled = game.getState();
    assert.equal(game.deliverResidentOrder(id).ok, false); assert.deepEqual(game.getState(), settled);
  }
  assert.equal(coins, 915); assert.equal(experience, 245); assert.deepEqual(nested, Array(6).fill(false));
  assert.equal(game.getResidentOrder().status, 'completed'); assert.equal(game.getResidentDemandProgress().completed, 11);
  assert.equal(game.getResidentDemandProgress().completedIds.filter(id => id === 'collector-grilled-fish').length, 1);
  const restored = new GameState({ storage, now });
  assert.deepEqual(restored.state.resources, game.state.resources);
  assert.deepEqual(restored.state.residentOrders, game.state.residentOrders);
  assert.equal(restored.getResidentDemandProgress().completed, 11);
  const settled = restored.getState(); assert.equal(restored.deliverResidentOrder().ok, false); assert.deepEqual(restored.getState(), settled);
});

test('demand progress derives a unique collector event from either legacy entry and does not count construction, gifts or side goals', () => {
  for (const [story, continuation] of [[true, false], [false, true], [true, true]]) {
    const game = createGame();
    game.state.story.claimed = ['seafood-kitchen-built', ...(story ? ['collector-grilled-fish'] : [])];
    game.state.continuation.claimed = ['rescue-kit', ...(continuation ? ['collector-grilled-fish'] : [])];
    game.state.story.sideClaimed = ['side-grilled-fish-20'];
    game.state.resources.lifejacket = 20;
    assert.deepEqual(game.getResidentDemandProgress(), { completedIds: ['collector-grilled-fish'], completed: 1, knownTotal: 11 });
    const view = game.getResidentDemandProgress(); view.completedIds.push('fake');
    assert.equal(game.getResidentDemandProgress().completed, 1);
    game.state.residentOrders.completed = ['first-meal', 'first-meal'];
    assert.equal(game.getResidentDemandProgress().completed, 2);
  }
});

test('intro and resident-order saves preserve old food-task progress without charging historical inventory', () => {
  const storage = memoryStorage();
  const now = () => 1_000_000;
  const fresh = new GameState({ storage, now, autoLoad: false });
  assert.equal(fresh.state.tutorial.introSeen, false);
  const events = [];
  fresh.onChange((state, event) => events.push(event.type), { immediate: false });
  assert.equal(fresh.completeIntro().introSeen, true);
  assert.equal(fresh.completeIntro().introSeen, true);
  assert.deepEqual(events, ['introCompleted']);
  assert.equal(new GameState({ storage, now }).state.tutorial.introSeen, true);

  const legacy = fresh.getState();
  delete legacy.profile;
  delete legacy.residentOrders;
  delete legacy.tutorial;
  legacy.quests.claimed = QUESTS.slice(0, 5).map((quest) => quest.id);
  legacy.stats.salvageCount = 3;
  legacy.stats.productionCollected.food = 6;
  legacy.resources = { wood: 24, scrap: 14, fish: 7, water: 9, food: 11, coin: 33 };
  storage.setItem('fkssj-save-v1', JSON.stringify(legacy));
  const migrated = new GameState({ storage, now });
  assert.deepEqual(migrated.state.resources, { ...legacy.resources, plastic: 0, cloth: 0, fabric: 0, rope: 0, plank: 0, lifejacket: 0, fishLine: 0, grilledFish: 0, seaweed: 0, glass: 0, seaweedJuice: 0, dailyGoods: 0 });
  assert.deepEqual(migrated.state.residentOrders.completed, ['first-meal']);
  assert.deepEqual(migrated.state.profile, { experience: 60, level: 2 });
  assert.equal(migrated.state.tutorial.introSeen, true);
  assert.equal(migrated.questStatus('food').claimed, true);
  assert.equal(migrated.deliverResidentOrder('first-meal').ok, false);
  assert.deepEqual(migrated.state.resources, { ...legacy.resources, plastic: 0, cloth: 0, fabric: 0, rope: 0, plank: 0, lifejacket: 0, fishLine: 0, grilledFish: 0, seaweed: 0, glass: 0, seaweedJuice: 0, dailyGoods: 0 });
  const migratedAgain = new GameState({ storage, now });
  assert.deepEqual(migratedAgain.state.profile, migrated.state.profile);
  assert.deepEqual(migratedAgain.state.residentOrders.completed, ['first-meal']);

  legacy.quests.claimed = QUESTS.slice(0, 4).map((quest) => quest.id);
  legacy.stats.productionCollected.food = 5;
  legacy.resources.food = 5;
  storage.setItem('fkssj-save-v1', JSON.stringify(legacy));
  const unfinishedMeal = new GameState({ storage, now });
  assert.equal(unfinishedMeal.getResidentOrder().id, 'first-meal');
  assert.equal(unfinishedMeal.getResidentOrder().canDeliver, true);
  assert.equal(unfinishedMeal.deliverResidentOrder().ok, true);
  assert.equal(unfinishedMeal.state.resources.food, 0);
  assert.equal(unfinishedMeal.questStatus('food').complete, true);

  legacy.quests.claimed = [];
  legacy.stats.salvageCount = 0;
  legacy.buildings.push({ id: 'legacy-fishing', type: 'fishing', x: -1, z: -1, level: 1, workers: 0, stored: 0, progress: 0 });
  storage.setItem('fkssj-save-v1', JSON.stringify(legacy));
  assert.equal(new GameState({ storage, now }).state.tutorial.introSeen, true);
});

test('old slicer saves retain legal tail stock and paid fish-line snapshots while progress migrates to a one-time manual credit', () => {
  const source = new GameState({ storage: null, autoLoad: false, now: () => 1_000_000 }), station = build(source, 'slicer');
  for (const version of [undefined, 1, 2, 3, 4, 5]) for (const level of [1, 2, 3]) {
    const storage = memoryStorage(), raw = source.getState(), slicer = raw.buildings.find((building) => building.id === station.id);
    const capacity = 16 * (1 + (level - 1) * .5), progress = version === undefined && level === 1 ? 0 : version === 5 && level === 3 ? 10 : 5;
    Object.assign(slicer, { level, stored: capacity, progress, workers: 1 }); delete slicer.legacySlicerProgress;
    if (version === undefined) delete raw.production.version; else raw.production.version = version;
    delete raw.production.collected.food;
    const job = { id: 'production-41', buildingId: station.id, recipeId: 'fishLine', name: '旧已付鱼肠线', quantity: 2, inputs: { fish: 40 }, outputs: { fishLine: 2 }, duration: 600, remaining: 137, status: 'running' };
    raw.production.queue = [structuredClone(job)]; raw.production.nextJobId = 42; raw.resources.fish = 17; raw.stats.productionGenerated.food = capacity;
    const originalResources = structuredClone(raw.resources); storage.setItem('fkssj-save-v1', JSON.stringify(raw));
    const migrated = new GameState({ storage, now: () => 1_000_000 }), restored = migrated.state.buildings.find((building) => building.id === station.id);
    assert.equal(migrated.persistenceLocked, false); assert.equal(migrated.state.production.version, 6); assert.equal(restored.stored, capacity); assert.equal(restored.progress, 0); assert.equal(restored.legacySlicerProgress, progress * 9);
    assert.equal(restored.workers, 0); assert.equal(migrated.availableWorkers, 1); assert.deepEqual(migrated.state.resources, originalResources); assert.equal(migrated.state.stats.productionGenerated.food, capacity); assert.equal(migrated.state.stats.productionCollected.food, 0); assert.equal(migrated.state.production.collected.food, 0);
    assert.deepEqual(migrated.state.production.queue[0], job); assert.equal(migrated.state.production.nextJobId, 42);
    assert.equal(migrated.save().ok, true); const again = new GameState({ storage, now: () => 1_000_000 });
    assert.equal(again.state.buildings.find((building) => building.id === station.id).legacySlicerProgress, progress * 9); assert.deepEqual(again.state.production.queue[0], job); assert.deepEqual(again.state.resources, originalResources);
  }
});

test('version-six slicers with no credit field never infer new work from stale progress or alter an already paid sashimi batch', () => {
  const storage = memoryStorage(), source = new GameState({ storage: null, autoLoad: false, now: () => 1_000_000 }), station = build(source, 'slicer'), raw = source.getState();
  const slicer = raw.buildings.find((building) => building.id === station.id); Object.assign(slicer, { stored: 4, progress: 10 }); delete slicer.legacySlicerProgress;
  raw.production.version = 6; raw.resources.fish = 12; raw.production.nextJobId = 2;
  const old = { id: 'production-1', buildingId: station.id, recipeId: 'sashimi', name: '已付生鱼片', quantity: 1, inputs: { fish: 6 }, outputs: { food: 1 }, duration: 90, remaining: 45, status: 'running' };
  raw.production.queue = [structuredClone(old)]; storage.setItem('fkssj-save-v1', JSON.stringify(raw));
  const game = new GameState({ storage, now: () => 1_000_000 }), restored = game.state.buildings.find((building) => building.id === station.id);
  assert.equal(game.persistenceLocked, false); assert.equal(restored.legacySlicerProgress, 0); assert.equal(restored.progress, 0); assert.equal(restored.stored, 4); assert.deepEqual(game.state.production.queue[0], old);
  const next = game.queueProduction('sashimi', 1, station.id); assert.equal(next.ok, true); assert.equal(next.legacyProgressUsed, 0); assert.equal(next.job.remaining, 90); assert.equal(next.job.status, 'queued'); assert.equal(game.state.resources.fish, 6);
  const again = new GameState({ storage, now: () => 1_000_000 }); assert.equal(again.state.buildings.find((building) => building.id === station.id).legacySlicerProgress, 0); assert.deepEqual(again.state.production.queue[0], old); assert.equal(again.state.production.queue[1].remaining, 90);
});

test('damaged manual slicer credit, stock and future production snapshots preserve the original raw save until reset', () => {
  const source = new GameState({ storage: null, autoLoad: false, now: () => 1_000_000 }), station = build(source, 'slicer');
  const mutations = [
    ...[null, -1, 90.1, '45', {}, [], true].map((value) => (raw, slicer) => { slicer.legacySlicerProgress = value; }),
    ...[null, -1, 50.1, '5'].map((value) => (raw, slicer) => { slicer.stored = value; }),
    (raw, slicer) => { delete slicer.stored; },
    (raw) => { raw.production.version = 7; },
  ];
  for (const mutate of mutations) {
    const storage = memoryStorage(); let now = 1_000_000; const raw = source.getState(), slicer = raw.buildings.find((building) => building.id === station.id);
    slicer.legacySlicerProgress = 45; raw.production.version = 6; mutate(raw, slicer); const original = JSON.stringify(raw); storage.setItem('fkssj-save-v1', original);
    const game = new GameState({ storage, now: () => now }); assert.equal(game.persistenceLocked, true); now += 6000; game.tick(6); assert.equal(game.collect('wood').ok, true); assert.equal(game.save().persisted, false); assert.equal(storage.getItem('fkssj-save-v1'), original);
    assert.equal(game.reset().ok, true); assert.equal(game.persistenceLocked, false); assert.equal(game.state.production.version, 6); assert.equal(new GameState({ storage, now: () => now }).persistenceLocked, false);
  }
});

test('long term thirst and hunger reduce efficiency but never remove residents or soft-lock gathering', () => {
  const game = createGame();
  const purifier = build(game, 'purifier');
  game.tick(7200);
  assert.equal(game.state.population.total, 1);
  assert.ok(game.getProductionInfo(purifier.id).efficiency > 0);
  assert.ok(purifier.stored > 0);
  assert.equal(game.collectProduction(purifier.id).ok, true);
  assert.equal(game.collect('crate').ok, true);
});

test('storm objectives expose independent supply and command progress with navigation targets', () => {
  const game = createGame();
  game.state.storm.status = 'approaching';
  game.state.resources.food = 2;
  game.state.resources.water = 6;
  game.state.stats.productionCollected.food = 100;
  game.state.stats.productionCollected.water = 100;
  const status = game.getStormStatus();
  assert.equal(status.ready, false);
  assert.deepEqual(status.requirements, { commandLevel: 2, water: 6, food: 6 });
  assert.deepEqual(status.objectives, [
    { id: 'food', current: 2, target: 6, complete: false, action: { type: 'production', buildingType: 'slicer', recipeId: 'sashimi' } },
    { id: 'command', current: 1, target: 2, complete: false, action: { type: 'building', buildingType: 'command' } },
    { id: 'water', current: 6, target: 6, complete: true, action: { type: 'building', buildingType: 'purifier' } },
  ]);
  assert.equal(game.state.buildings.some((building) => building.type === 'slicer' || building.type === 'purifier'), false, 'Absent facilities still have navigation targets');
  fund(game, game.getUpgradeCost('command'));
  assert.equal(game.upgradeBuilding('command').ok, true);
  fund(game, { food: 6 });
  assert.equal(game.getStormStatus().ready, true);
  assert.equal(game.getStormStatus().objectives.every((objective) => objective.complete), true);
  game.state.resources.food = 1;
  game.state.resources.water = 4;
  assert.deepEqual(game.getStormStatus().objectives.map(({ current, complete }) => ({ current, complete })), [
    { current: 1, complete: false }, { current: 2, complete: true }, { current: 4, complete: false },
  ], 'Unpassed supply goals track declining inventory despite high lifetime production');
  assert.equal(game.getStormStatus().ready, false);
});

test('storm objective reads do not consume supplies, save, emit events or expose mutable state', () => {
  let writes = 0;
  const game = new GameState({ storage: { getItem: () => null, setItem: () => { writes++; } }, autoLoad: false });
  const events = [];
  game.onChange((state, event) => events.push(event.type), { immediate: false });
  const before = game.getState();
  const status = game.getStormStatus();
  status.objectives[0].current = 999;
  status.objectives[0].action.buildingType = 'farm';
  status.objectives.splice(1);
  assert.equal(game.getStormStatus().objectives.length, 3);
  assert.equal(game.getStormStatus().objectives[0].action.buildingType, 'slicer');
  assert.deepEqual(game.getState(), before);
  assert.deepEqual(events, []);
  assert.equal(writes, 0);
});

test('storm food reserves remain separate from the five-portion first-meal production and delivery', () => {
  const game = createGame();
  const slicer = build(game, 'slicer');
  fund(game, { fish: 30 });
  const queued = game.queueProduction('sashimi', 5, slicer.id);
  assert.equal(queued.ok, true);
  game.tick(450);
  assert.equal(game.claimQueuedProduction(queued.job.id).ok, true);
  assert.deepEqual(game.getResidentOrder().productionRequired, { food: 5 });
  assert.equal(game.getResidentOrder().canDeliver, true);
  assert.deepEqual(game.getStormStatus().objectives[0], {
    id: 'food', current: 5, target: 6, complete: false,
    action: { type: 'production', buildingType: 'slicer', recipeId: 'sashimi' },
  });
  assert.equal(game.deliverResidentOrder('first-meal').ok, true);
  assert.equal(game.state.resources.food, 0);
  assert.equal(game.state.stats.productionCollected.food, 5);
  assert.equal(game.questStatus('food').complete, true);
  assert.equal(game.getStormStatus().objectives[0].current, 0);
  assert.equal(game.getStormStatus().objectives[0].complete, false);
  fund(game, { food: 6 });
  assert.equal(game.getStormStatus().objectives[0].complete, true, 'Reserve stock can be replenished without a second first meal');
  assert.equal(game.state.stats.productionCollected.food, 5);
});

test('storm reserves preserve shared food compatibility with farm and legacy kitchen production', () => {
  for (const type of ['farm', 'kitchen']) {
    const game = createGame();
    const facility = build(game, type);
    fund(game, { water: 2, fish: 8 });
    game.tick(BUILDINGS[type].production.interval * 2 + 2);
    assert.equal(game.collectProduction(facility.id).ok, true);
    assert.equal(game.state.resources.food, 6, type);
    assert.equal(game.getStormStatus().objectives[0].current, 6, type);
    assert.equal(game.getStormStatus().objectives[0].complete, true, type);
  }
});

test('passed storm objectives stay complete while storm charges and quest rewards remain one-time', () => {
  const game = createGame();
  game.state.storm.status = 'approaching';
  game.state.buildings[0].level = 2;
  game.state.resources.food = 6;
  game.state.resources.water = 6;
  game.state.quests.claimed = QUESTS.slice(0, QUESTS.findIndex((quest) => quest.id === 'command')).map((quest) => quest.id);
  const before = structuredClone(game.state.resources);
  assert.equal(game.faceStorm().ok, true);
  assert.equal(game.state.resources.food, before.food - 4);
  assert.equal(game.state.resources.water, before.water - 4);
  assert.equal(game.state.resources.coin, before.coin + 10);
  assert.equal(game.state.storm.attempts, 1);
  assert.equal(game.getStormStatus().ready, false, 'Existing live-inventory readiness semantics are preserved');
  assert.deepEqual(game.getStormStatus().objectives.map(({ id, current, target, complete }) => ({ id, current, target, complete })), [
    { id: 'food', current: 6, target: 6, complete: true },
    { id: 'command', current: 2, target: 2, complete: true },
    { id: 'water', current: 6, target: 6, complete: true },
  ]);
  const passedState = game.getState();
  assert.equal(game.faceStorm().ok, false);
  assert.deepEqual(game.getState(), passedState);
  const reward = QUESTS.find((quest) => quest.id === 'command').reward;
  assert.deepEqual(game.claimQuest('command').reward, reward);
  for (const [resource, amount] of Object.entries(reward)) assert.equal(game.state.resources[resource], passedState.resources[resource] + amount, resource);
  const claimedState = game.getState();
  assert.equal(game.claimQuest('command').ok, false);
  assert.deepEqual(game.getState(), claimedState);
  game.state.resources.food = 0;
  game.state.resources.water = 0;
  assert.equal(game.getStormStatus().objectives.every((objective) => objective.complete), true);
});

test('storm objectives restore from existing saves without adding persisted fields', () => {
  for (const status of ['approaching', 'passed']) {
    const storage = memoryStorage();
    const game = new GameState({ storage, now: () => 1_000_000, autoLoad: false });
    game.state.storm.status = status;
    game.state.storm.attempts = status === 'passed' ? 1 : 0;
    game.state.buildings[0].level = 2;
    game.state.resources.food = 2;
    game.state.resources.water = 3;
    const stateKeys = Object.keys(game.state);
    const stormKeys = Object.keys(game.state.storm);
    const expected = game.getStormStatus();
    assert.equal(game.save().persisted, true);
    const raw = JSON.parse(storage.getItem('fkssj-save-v1'));
    assert.deepEqual(Object.keys(raw), stateKeys);
    assert.deepEqual(Object.keys(raw.storm), stormKeys);
    assert.equal(raw.version, 1);
    assert.equal(Object.hasOwn(raw.storm, 'objectives'), false);
    const restored = new GameState({ storage, now: () => 1_000_000 });
    assert.equal(restored.persistenceLocked, false);
    assert.deepEqual(restored.getStormStatus(), expected);
    assert.deepEqual(Object.keys(restored.state), stateKeys);
    assert.deepEqual(Object.keys(restored.state.storm), stormKeys);
  }
});

test('the entire first chapter is reachable using public actions, including rescue and storm', () => {
  const game = createGame();
  for (let index = 0; index < 3; index++) game.collect('wood');
  claim(game, 'salvage');
  const fishing = build(game, 'fishing');
  claim(game, 'fishing');
  for (let index = 0; index < 4; index++) {
    if (index) game.tick(2.5);
    assert.equal(game.castLine().ok, true);
  }
  claim(game, 'fish');
  const slicer = build(game, 'slicer');
  claim(game, 'slicer');
  fund(game, { fish: 30 }); const sashimi = game.queueProduction('sashimi', 5, slicer.id); assert.equal(sashimi.ok, true);
  game.tick(450);
  assert.equal(game.claimQueuedProduction(sashimi.job.id).ok, true);
  assert.equal(game.questStatus('food').complete, false);
  assert.equal(game.deliverResidentOrder('first-meal').ok, true);
  claim(game, 'food');
  const purifier = build(game, 'purifier');
  claim(game, 'purifier');
  game.tick(60);
  assert.equal(game.collectProduction(purifier.id).ok, true);
  claim(game, 'water');
  assert.equal(game.state.storm.status, 'approaching');
  assert.equal(game.faceStorm().ok, false);
  fund(game, game.getExpandCost()); assert.equal(game.expand(2, 0).ok, true);
  fund(game, game.getExpandCost()); assert.equal(game.expand(2, 1).ok, true);
  claim(game, 'expand');
  build(game, 'scavenger'); claim(game, 'scavenger');
  fund(game, { water: 3, food: 3 });
  assert.equal(game.explore().ok, true);
  assert.equal(game.state.population.total, 3);
  const afterRescue = structuredClone(game.state.resources);
  assert.equal(game.explore().ok, false);
  assert.deepEqual(game.state.resources, afterRescue);
  claim(game, 'rescue');
  build(game, 'bed'); claim(game, 'bed');
  assert.ok(game.state.population.capacity >= game.state.population.total);
  build(game, 'farm'); claim(game, 'farm');
  fund(game, game.getUpgradeCost('command'));
  assert.equal(game.upgradeBuilding('command').ok, true);
  fund(game, { water: 6, food: 6 });
  assert.equal(game.faceStorm().ok, true);
  claim(game, 'command');
  build(game, 'beacon'); claim(game, 'beacon');
  assert.equal(game.state.completed, true);
  assert.equal(game.state.quests.claimed.length, QUESTS.length);
  assert.equal(game.getQuests().every((quest) => quest.status === 'claimed'), true);
  assert.ok(fishing);
});

test('successful state changes notify subscribers; rejected actions preserve state', () => {
  const game = createGame();
  const events = [];
  const unsubscribe = game.onChange((state, event) => events.push(event.type));
  game.collect('crate');
  game.tick(1);
  game.expand(5, 5);
  assert.deepEqual(events, ['init', 'collect', 'tick']);
  unsubscribe();
  game.collect('crate');
  assert.equal(events.length, 3);
});

// Level three remains readable for existing camps; it has no new manual recipe.
test('manual slicer upgrades stop at the useful fish-line unlock without charging for a third level', () => {
  const game = createGame(), slicer = build(game, 'slicer');
  fund(game, game.getUpgradeCost(slicer.id));
  assert.equal(game.upgradeBuilding(slicer.id).ok, true);
  assert.equal(slicer.level, 2);
  assert.equal(game.getRecipes(slicer.id).find(r => r.id === 'fishLine').unlocked, true);
  const resources = structuredClone(game.state.resources);
  assert.equal(game.getUpgradeCost(slicer.id), null);
  assert.equal(game.upgradeBuilding(slicer.id).ok, false);
  assert.deepEqual(game.state.resources, resources);
  assert.equal(slicer.level, 2);
});

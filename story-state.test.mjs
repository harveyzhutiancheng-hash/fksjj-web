import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { GameState, BUILDINGS, QUESTS, CONTINUATION_QUESTS } from './game-state.js';
import { createStory, normalizeStory, STORY_QUESTS, SIDE_QUESTS } from './story-state.js';
import { ProgressState } from './progress-state.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const MIDDLE_IDS = ['story-tailor-built', 'story-lifejacket-made', 'story-slicer-level-two', 'story-fish-line-made', 'story-materials-built', 'story-fabric-made'];
const OLD_STORY_IDS = ['plastic-reserve', 'small-residence', 'seafood-kitchen-built', 'collector-grilled-fish', 'leader-six', 'broadcast-built', 'recruit-first', 'diving-dock-built', 'diving-scrap', 'hospital-built', 'daily-factory-built', 'daily-goods-made', 'kitchen-level-two', 'seaweed-juice-made'];
function memoryStorage() { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }
function chapterGame(options = {}) {
  const game = new GameState({ storage: null, autoLoad: false, now: () => 1_000_000, ...options });
  game.state.quests.claimed = QUESTS.map((quest) => quest.id); game.state.completed = true;
  for (const key of Object.keys(game.state.resources)) game.state.resources[key] = 1000;
  return game;
}
function build(game, type) {
  const tile = game.state.raft.find((candidate) => !game.state.buildings.some((building) => building.x === candidate.x && building.z === candidate.z));
  const result = game.placeBuilding(type, tile.x, tile.z); assert.equal(result.ok, true, result.message); return result.building;
}
function reachKitchen(game) {
  assert.equal(game.claimStoryQuest('plastic-reserve').ok, true); build(game, 'bed'); assert.equal(game.claimStoryQuest('small-residence').ok, true);
  return build(game, 'seafoodKitchen');
}
function grilledFish(game, kitchen) {
  game.state.resources.grilledFish = 0;
  const job = game.queueProduction('grilledFish', 1, kitchen.id); assert.equal(job.ok, true);
  game.tick(300); assert.equal(game.claimQueuedProduction(job.job.id).ok, true);
}

test('the original chapter stays first, then the twenty recorded story checkpoints take priority without rewriting either old quest array', () => {
  const game = new GameState({ storage: null, autoLoad: false }), before = game.getState();
  assert.equal(game.getCurrentTask().category, 'tutorial'); assert.equal(game.getCurrentTask().id, 'salvage');
  assert.equal(game.claimStoryQuest('plastic-reserve').ok, false); assert.deepEqual(game.getState(), before);
  game.state.quests.claimed = QUESTS.map((quest) => quest.id); game.state.completed = true;
  assert.equal(game.getCurrentTask().id, 'plastic-reserve'); assert.equal(game.getCurrentTask().category, 'story');
  assert.equal(game.getCurrentTask().story, true); assert.equal(game.getCurrentTask().followup, true);
  assert.equal(QUESTS.length, 14); assert.equal(CONTINUATION_QUESTS.length, 14); assert.equal(STORY_QUESTS.length, 20);
  assert.deepEqual(STORY_QUESTS.filter((quest) => !MIDDLE_IDS.includes(quest.id)).map((quest) => quest.id), OLD_STORY_IDS);
  assert.equal(game.getContinuationQuests()[0].id, 'supply-trip');
  assert.ok(game.getStoryQuests().every((quest) => quest.source.startsWith('https:') && quest.note));
});

test('plastic storage pays its recorded reward once, rejects out-of-order delivery and leaves old construction tasks available independently', () => {
  const storage = memoryStorage(), game = chapterGame({ storage }); game.state.resources.plastic = 39;
  const before = game.getState(); assert.equal(game.claimStoryQuest('plastic-reserve').ok, false); assert.equal(game.claimStoryQuest('collector-grilled-fish').ok, false); assert.deepEqual(game.getState(), before);
  game.state.resources.plastic = 40; const fish = game.state.resources.fish, experience = game.state.profile.experience;
  const result = game.claimStoryQuest('plastic-reserve'); assert.equal(result.ok, true); assert.deepEqual(result.reward, { experience: 25, fish: 40 });
  assert.equal(game.state.resources.plastic, 40); assert.equal(game.state.resources.fish, fish + 40); assert.equal(game.state.profile.experience, experience + 25);
  assert.equal(Object.hasOwn(game.state.resources, 'experience'), false);
  const settled = game.getState(); assert.equal(game.claimStoryQuest('plastic-reserve').ok, false); assert.deepEqual(game.getState(), settled);
  game.state.scavenging.completedTrips = 1;
  assert.equal(game.getCurrentTask().id, 'small-residence'); assert.equal(game.claimContinuationQuest('supply-trip').ok, true);
  assert.equal(game.getCurrentTask().id, 'small-residence');
  const reloaded = new GameState({ storage, now: () => 1_000_000 }); assert.equal(reloaded.claimStoryQuest('plastic-reserve').ok, false); assert.equal(reloaded.state.profile.experience, experience + 25);
});

test('story collection shares the legacy kitchen and collector ledger, including reentrant claims and actual queued fish delivery', () => {
  const storage = memoryStorage(), game = chapterGame({ storage });
  game.state.continuation.claimed = CONTINUATION_QUESTS.slice(0, 12).map((quest) => quest.id);
  game.state.profile.experience = 240;
  const kitchen = reachKitchen(game); assert.equal(game.claimStoryQuest('seafood-kitchen-built').ok, true);
  assert.equal(game.state.continuation.claimed.includes('seafood-kitchen-built'), true);
  grilledFish(game, kitchen); const coin = game.state.resources.coin, experience = game.state.profile.experience, nested = [];
  game.onChange((state, event) => { if (event.type === 'storyQuestClaimed' && event.quest.id === 'collector-grilled-fish') nested.push(game.claimContinuationQuest('collector-grilled-fish').ok); }, { immediate: false });
  const result = game.claimStoryQuest('collector-grilled-fish'); assert.equal(result.ok, true); assert.deepEqual(result.cost, { grilledFish: 1 });
  assert.equal(game.state.resources.grilledFish, 0); assert.equal(game.state.resources.coin, coin + 75); assert.equal(game.state.profile.experience, experience + 40); assert.equal(game.state.profile.level, 6);
  assert.deepEqual(nested, [false]); assert.equal(game.state.continuation.claimed.length, 14);
  assert.equal(game.getCurrentTask().id, 'leader-six'); assert.equal(game.getCurrentTask().complete, true);
  const once = game.getState(); assert.equal(game.claimContinuationQuest('collector-grilled-fish').ok, false); assert.equal(game.claimStoryQuest('collector-grilled-fish').ok, false); assert.deepEqual(game.getState(), once);
  const restored = new GameState({ storage, now: () => 1_000_000 }); assert.equal(restored.state.resources.coin, coin + 75); assert.equal(restored.state.profile.experience, experience + 40); assert.equal(restored.claimStoryQuest('collector-grilled-fish').ok, false);
});

test('legacy collection updates the story ledger and loading v0.8 completed histories never charges or pays them again', () => {
  const storage = memoryStorage(), game = chapterGame({ storage });
  game.state.continuation.claimed = CONTINUATION_QUESTS.slice(0, 12).map((quest) => quest.id);
  const kitchen = build(game, 'seafoodKitchen'); assert.equal(game.claimContinuationQuest('seafood-kitchen-built').ok, true);
  assert.equal(game.state.story.claimed.includes('seafood-kitchen-built'), true);
  grilledFish(game, kitchen); assert.equal(game.claimContinuationQuest('collector-grilled-fish').ok, true);
  assert.equal(game.getStoryQuests().find((quest) => quest.id === 'collector-grilled-fish').claimed, true);
  const raw = JSON.parse(storage.getItem('fkssj-save-v1')); delete raw.story; raw.production.version = 2;
  const resources = clone(raw.resources), experience = raw.profile.experience;
  storage.setItem('fkssj-save-v1', JSON.stringify(raw));
  const migrated = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(migrated.persistenceLocked, false); assert.deepEqual(migrated.state.resources, resources); assert.equal(migrated.state.profile.experience, experience);
  assert.deepEqual(migrated.state.continuation.claimed, raw.continuation.claimed); assert.deepEqual(migrated.state.quests.claimed, raw.quests.claimed);
  assert.deepEqual(migrated.state.story.claimed, ['seafood-kitchen-built', 'collector-grilled-fish']);
  assert.equal(migrated.claimStoryQuest('collector-grilled-fish').ok, false);
  assert.equal(migrated.getCurrentTask().id, 'plastic-reserve');
  const continuation = { claimed: [] }, recovered = normalizeStory({ version: 1, claimed: ['collector-grilled-fish'] }, continuation);
  assert.deepEqual(continuation.claimed, ['collector-grilled-fish']); assert.deepEqual(recovered.claimed, ['collector-grilled-fish']);
});

test('broadcast has the actual level-six gate, existing facilities remain usable, and future story data is never overwritten', () => {
  const game = chapterGame(); assert.equal(game.getFactoryUnlock('broadcast').unlocked, false);
  game.state.profile.experience = 300; game.state.profile.level = 6; assert.equal(game.getFactoryUnlock('broadcast').unlocked, true);
  assert.equal(game.getFactoryUnlock('divingDock').unlocked, false);
  const factory = build(game, 'materials'); game.state.completed = false;
  assert.equal(game.getFactoryUnlock('materials').unlocked, true); assert.equal(game.getRecipes(factory.id)[0].unlocked, true);
  assert.throws(() => normalizeStory({ version: 3 }), /更新版本/);
  for (const story of [{ version: 3, claimed: [] }, { version: 1, claimed: ['future-story'] }, { version: 2, claimed: [], sideClaimed: ['future-side'] }, { version: 2, claimed: [], sideClaimed: 'side-water-20' }]) {
    const storage = memoryStorage(), source = chapterGame({ storage }); source.save();
    const raw = JSON.parse(storage.getItem('fkssj-save-v1')); raw.story = story; const original = JSON.stringify(raw); storage.setItem('fkssj-save-v1', original);
    let now = 1_000_000; const locked = new GameState({ storage, now: () => now }); assert.equal(locked.persistenceLocked, true);
    now += 6000; locked.tick(6); locked.collect('wood'); assert.equal(storage.getItem('fkssj-save-v1'), original);
    locked.reset(); assert.deepEqual(locked.state.story, createStory()); assert.equal(locked.persistenceLocked, false);
  }
});

test('the five recorded side goals count claimed production, remain independent and award experience once without consuming inventory', () => {
  assert.deepEqual(SIDE_QUESTS.map(({ resource, target, reward }) => [resource, target, reward.experience]), [['water', 20, 15], ['grilledFish', 20, 25], ['lifejacket', 20, 35], ['fishLine', 20, 40], ['fabric', 20, 40]]);
  assert.ok(SIDE_QUESTS.every((quest) => quest.source.endsWith('t=2160') && quest.note.includes('兼容口径')));
  const fresh = new GameState({ storage: null, autoLoad: false }); fresh.state.stats.productionCollected.water = 20;
  const locked = fresh.getState(); assert.equal(fresh.getSideQuests()[0].complete, true); assert.equal(fresh.getSideQuests()[0].unlocked, false);
  assert.equal(fresh.claimSideQuest('side-water-20').ok, false); assert.deepEqual(fresh.getState(), locked);
  const stockOnly = chapterGame();
  for (const quest of SIDE_QUESTS) stockOnly.state.stats.productionGenerated[quest.resource] = 20;
  assert.ok(stockOnly.getSideQuests().every((quest) => quest.current === 0 && !quest.canClaim), 'Existing inventory and generated-but-uncollected goods are not claimed production');
  stockOnly.state.production.collected.fabric = 19;
  const insufficient = stockOnly.getState(), rejected = stockOnly.claimSideQuest('side-fabric-20');
  assert.equal(rejected.ok, false); assert.equal(rejected.remaining, 1); assert.deepEqual(stockOnly.getState(), insufficient);
  assert.equal(stockOnly.claimSideQuest('unknown-side').ok, false); assert.deepEqual(stockOnly.getState(), insufficient);

  const storage = memoryStorage(), game = chapterGame({ storage });
  const originalTask = game.getCurrentTask().id, main = clone(game.state.story.claimed), continuation = clone(game.state.continuation.claimed), tutorial = clone(game.state.quests.claimed);
  const purifier = build(game, 'purifier');
  const stations = { grilledFish: build(game, 'seafoodKitchen'), lifejacket: build(game, 'tailor'), fishLine: build(game, 'slicer'), fabric: build(game, 'materials') };
  assert.equal(game.upgradeBuilding(stations.fishLine.id).ok, true);
  const jobs = [];
  for (const recipeId of Object.keys(stations)) for (let batch = 0; batch < 2; batch++) {
    const result = game.queueProduction(recipeId, 10, stations[recipeId].id); assert.equal(result.ok, true, result.message); jobs.push(result.job);
  }
  game.tick(6000);
  assert.ok(game.getSideQuests().every((quest) => quest.current === 0), 'Even completed paid batches do not count before collection');
  for (const job of jobs) assert.equal(game.claimQueuedProduction(job.id).ok, true);
  assert.equal(game.collectProduction(purifier.id).ok, true); game.tick(50); assert.equal(game.collectProduction(purifier.id).ok, true);
  assert.ok(game.getSideQuests().every((quest) => quest.canClaim && quest.current >= 20));
  const view = game.getSideQuests(); view[0].reward.experience = 999; assert.equal(game.getSideQuests()[0].reward.experience, 15);
  const inventory = clone(game.state.resources), experience = game.state.profile.experience, nested = [], events = [];
  game.onChange((state, event) => {
    if (event.type === 'sideQuestClaimed') { events.push(event.quest.id); nested.push(game.claimSideQuest(event.quest.id).ok); }
  }, { immediate: false });
  let earned = 0;
  for (const definition of [...SIDE_QUESTS].reverse()) {
    const reward = game.claimSideQuest(definition.id); assert.equal(reward.ok, true); assert.deepEqual(reward.cost, {}); assert.deepEqual(reward.resources, {}); assert.deepEqual(reward.reward, definition.reward);
    earned += definition.reward.experience; assert.equal(reward.profile.experience, experience + earned); assert.deepEqual(game.state.resources, inventory);
    const settled = game.getState(); assert.equal(game.claimSideQuest(definition.id).ok, false); assert.deepEqual(game.getState(), settled);
  }
  assert.equal(earned, 155); assert.equal(game.state.profile.experience, experience + 155);
  assert.deepEqual(nested, Array(5).fill(false)); assert.deepEqual(events, [...SIDE_QUESTS].reverse().map((quest) => quest.id));
  assert.deepEqual(game.state.story.claimed, main); assert.deepEqual(game.state.continuation.claimed, continuation); assert.deepEqual(game.state.quests.claimed, tutorial); assert.equal(game.getCurrentTask().id, originalTask);
  const restored = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(restored.state.story.version, 2); assert.deepEqual(new Set(restored.state.story.sideClaimed), new Set(SIDE_QUESTS.map((quest) => quest.id)));
  assert.equal(restored.state.profile.experience, experience + 155); assert.deepEqual(restored.state.resources, inventory);
  assert.ok(restored.getSideQuests().every((quest) => quest.status === 'claimed' && !quest.canClaim));
  for (const quest of SIDE_QUESTS) assert.equal(restored.claimSideQuest(quest.id).ok, false);
});

test('story version one retains every old main and continuation claim while cumulative side goals become manually claimable without retroactive rewards', () => {
  const storage = memoryStorage(), source = chapterGame({ storage });
  const raw = source.getState(); raw.story = { version: 1, claimed: OLD_STORY_IDS }; raw.continuation.claimed = CONTINUATION_QUESTS.map((quest) => quest.id);
  raw.profile = { experience: 305, level: 6 }; raw.stats.productionCollected.water = 20; raw.production.collected.fabric = 20; raw.resources.fabric = 0; raw.resources.water = 0;
  const stock = clone(raw.resources); storage.setItem('fkssj-save-v1', JSON.stringify(raw));
  const migrated = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(migrated.persistenceLocked, false); assert.deepEqual(migrated.state.story, { version: 2, claimed: raw.story.claimed, sideClaimed: [] });
  assert.deepEqual(migrated.state.continuation.claimed, raw.continuation.claimed); assert.deepEqual(migrated.state.quests.claimed, raw.quests.claimed);
  assert.deepEqual(migrated.state.resources, stock); assert.deepEqual(migrated.state.profile, raw.profile); assert.equal(migrated.getCurrentTask().id, MIDDLE_IDS[0]);
  assert.equal(migrated.getSideQuests().find((quest) => quest.resource === 'fabric').canClaim, true); assert.equal(migrated.getSideQuests().find((quest) => quest.resource === 'water').canClaim, true);
  assert.equal(migrated.claimSideQuest('side-fabric-20').ok, true); assert.deepEqual(migrated.state.resources, stock); assert.equal(migrated.state.profile.experience, 345);
  const again = new GameState({ storage, now: () => 1_000_000 }); assert.deepEqual(again.state.story.sideClaimed, ['side-fabric-20']); assert.equal(again.claimSideQuest('side-fabric-20').ok, false); assert.equal(again.state.profile.experience, 345);
  assert.deepEqual(again.state.story.claimed, raw.story.claimed); assert.deepEqual(again.state.continuation.claimed, raw.continuation.claimed);
});

test('existing normal or legacy recruitment counts satisfy the inserted task without another draw or a duplicated reward', () => {
  for (const counts of [{ normalCount: 1, legendCount: 0 }, { normalCount: 0, legendCount: 1 }]) {
    const storage = memoryStorage(), game = chapterGame({ storage });
    game.state.profile.experience = 300; game.state.profile.level = 6; build(game, 'broadcast');
    game.state.story.claimed = STORY_QUESTS.slice(0, 6).map((quest) => quest.id);
    Object.assign(game.state.progression.recruitment, counts); game.save();
    const restored = new GameState({ storage, now: () => 1_000_000 }), wallet = clone(restored.state.progression.wallet), resources = clone(restored.state.resources), experience = restored.state.profile.experience;
    assert.equal(restored.getCurrentTask().id, 'recruit-first'); assert.equal(restored.getCurrentTask().current, 1); assert.equal(restored.getCurrentTask().complete, true);
    const result = restored.claimStoryQuest('recruit-first'); assert.equal(result.ok, true); assert.deepEqual(result.reward, {});
    assert.deepEqual(restored.state.progression.wallet, wallet); assert.deepEqual(restored.state.resources, resources); assert.equal(restored.state.profile.experience, experience);
    assert.equal(restored.getCurrentTask().id, MIDDLE_IDS[0]); assert.equal(restored.claimStoryQuest('recruit-first').ok, false);
  }
});

test('the six inserted checkpoints require actual collected output and issue only their own recorded rewards once', () => {
  const first = STORY_QUESTS.findIndex((quest) => quest.id === 'recruit-first');
  assert.deepEqual(STORY_QUESTS.slice(first, first + 8).map((quest) => quest.id), ['recruit-first', ...MIDDLE_IDS, 'diving-dock-built']);
  assert.deepEqual(MIDDLE_IDS.map((id) => STORY_QUESTS.find((quest) => quest.id === id).reward), [{ experience: 35, plastic: 80 }, { experience: 35, lifejacket: 2 }, { experience: 40, fish: 160 }, { experience: 40 }, { experience: 40, cloth: 150 }, { experience: 40, fabric: 2 }]);
  assert.ok(MIDDLE_IDS.every((id) => !STORY_QUESTS.find((quest) => quest.id === id).legacyId), 'The recorded story checkpoints do not alias the old project construction rewards');
  const storage = memoryStorage(), game = chapterGame({ storage });
  game.state.story.claimed = STORY_QUESTS.slice(0, first + 1).map((quest) => quest.id);
  game.state.continuation.claimed = CONTINUATION_QUESTS.map((quest) => quest.id);
  const materials = build(game, 'materials'), tailor = build(game, 'tailor'), slicer = build(game, 'slicer');
  const continuation = clone(game.state.continuation.claimed), wallet = clone(game.state.progression.wallet), nested = [];
  game.onChange((state, event) => {
    if (event.type === 'storyQuestClaimed' && MIDDLE_IDS.includes(event.quest.id)) nested.push(game.claimStoryQuest(event.quest.id).ok);
  }, { immediate: false });
  const claimRecorded = (id) => {
    const quest = game.getCurrentTask(); assert.equal(quest.id, id); assert.equal(quest.complete, true);
    const stock = clone(game.state.resources), xp = game.state.profile.experience, collected = clone(game.state.stats.productionCollected), queuedCollected = clone(game.state.production.collected);
    const result = game.claimStoryQuest(id); assert.equal(result.ok, true); assert.deepEqual(result.cost, {}); assert.deepEqual(result.reward, quest.reward);
    for (const key of Object.keys(stock)) assert.equal(game.state.resources[key], stock[key] + (quest.reward[key] || 0), `${id} rewards only its explicit ${key}`);
    assert.equal(game.state.profile.experience, xp + (quest.reward.experience || 0));
    assert.deepEqual(game.state.stats.productionCollected, collected); assert.deepEqual(game.state.production.collected, queuedCollected, 'Reward goods are not produced goods');
    const once = game.getState(); assert.equal(game.claimStoryQuest(id).ok, false); assert.deepEqual(game.getState(), once);
  };
  const produce = (id, building) => {
    assert.equal(game.getCurrentTask().current, 0, 'Large inventory alone never counts as production');
    const before = game.getState(); assert.equal(game.claimStoryQuest(game.getCurrentTask().id).ok, false); assert.deepEqual(game.getState(), before);
    const queued = game.queueProduction(id, 1, building.id); assert.equal(queued.ok, true, queued.message);
    game.tick(queued.job.duration - 1); assert.equal(game.getCurrentTask().complete, false);
    game.tick(1); assert.equal(game.getCurrentTask().complete, false, 'Ready but unclaimed production is not recorded progress');
    assert.equal(game.claimQueuedProduction(queued.job.id).ok, true); assert.equal(game.getCurrentTask().current, 1);
    assert.equal(game.claimQueuedProduction(queued.job.id).ok, false);
  };
  claimRecorded('story-tailor-built');
  produce('lifejacket', tailor); claimRecorded('story-lifejacket-made');
  assert.equal(game.getCurrentTask().current, 1); assert.equal(game.getCurrentTask().complete, false);
  assert.equal(game.claimStoryQuest('story-slicer-level-two').ok, false);
  assert.equal(game.upgradeBuilding(slicer.id).ok, true); claimRecorded('story-slicer-level-two');
  produce('fishLine', slicer); claimRecorded('story-fish-line-made');
  claimRecorded('story-materials-built'); produce('fabric', materials); claimRecorded('story-fabric-made');
  assert.deepEqual(nested, Array(6).fill(false)); assert.deepEqual(game.state.continuation.claimed, continuation); assert.deepEqual(game.state.progression.wallet, wallet);
  assert.equal(game.state.profile.experience, 230); assert.equal(game.getCurrentTask().id, 'diving-dock-built');
  const stock = clone(game.state.resources), restored = new GameState({ storage, now: () => 1_000_000 });
  assert.deepEqual(restored.state.resources, stock); assert.equal(restored.state.profile.experience, 230);
  for (const id of MIDDLE_IDS) assert.equal(restored.claimStoryQuest(id).ok, false);
});

test('v0.11 completed later goals and paid batches survive insertion without automatic rewards, while earned old progress can be manually backfilled', () => {
  const storage = memoryStorage(), game = chapterGame({ storage });
  const materials = build(game, 'materials'), tailor = build(game, 'tailor'), slicer = build(game, 'slicer');
  assert.equal(game.upgradeBuilding(slicer.id).ok, true);
  for (const [recipeId, building] of [['fabric', materials], ['lifejacket', tailor], ['fishLine', slicer]]) {
    const queued = game.queueProduction(recipeId, 1, building.id); assert.equal(queued.ok, true); game.tick(queued.job.duration); assert.equal(game.claimQueuedProduction(queued.job.id).ok, true);
  }
  const kitchen = build(game, 'seafoodKitchen');
  while (game.state.resources.coin < 1500) assert.equal(game.collect('coin').ok, true);
  assert.equal(game.upgradeBuilding(kitchen.id).ok, true); game.tick(1200);
  const paid = game.queueProduction('seaweedJuice', 1, kitchen.id); assert.equal(paid.ok, true);
  const upgradingKitchen = build(game, 'seafoodKitchen');
  while (game.state.resources.coin < 1500) assert.equal(game.collect('coin').ok, true);
  assert.equal(game.upgradeBuilding(upgradingKitchen.id).ok, true); game.tick(7);
  game.state.story = { version: 2, claimed: [...OLD_STORY_IDS], sideClaimed: ['side-water-20'] };
  game.state.continuation.claimed = CONTINUATION_QUESTS.map((quest) => quest.id);
  game.state.profile = { experience: 305, level: 6 }; assert.equal(game.save().ok, true);
  const raw = game.getState(), stock = clone(raw.resources), oldJob = clone(raw.production.queue[0]), oldConstruction = clone(upgradingKitchen.construction);
  const restored = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(restored.persistenceLocked, false); assert.equal(restored.state.story.version, 2); assert.deepEqual(restored.state.story.claimed, OLD_STORY_IDS); assert.deepEqual(restored.state.story.sideClaimed, ['side-water-20']);
  assert.deepEqual(restored.state.continuation.claimed, raw.continuation.claimed); assert.deepEqual(restored.state.quests.claimed, raw.quests.claimed);
  assert.deepEqual(restored.state.resources, stock); assert.equal(restored.state.profile.experience, 305); assert.equal(restored.getCurrentTask().id, MIDDLE_IDS[0]);
  assert.deepEqual(restored.state.production.queue[0], oldJob); assert.deepEqual(restored.state.buildings.find((building) => building.id === upgradingKitchen.id).construction, oldConstruction);
  for (const id of MIDDLE_IDS) { assert.equal(restored.getCurrentTask().id, id); assert.equal(restored.getCurrentTask().complete, true); assert.equal(restored.claimStoryQuest(id).ok, true); }
  assert.equal(restored.state.profile.experience, 535); assert.equal(restored.state.resources.fish, stock.fish + 160); assert.equal(restored.state.resources.cloth, stock.cloth + 150); assert.equal(restored.state.resources.fabric, stock.fabric + 2); assert.equal(restored.state.resources.plastic, stock.plastic + 80); assert.equal(restored.state.resources.lifejacket, stock.lifejacket + 2);
  assert.equal(restored.getCurrentTask(), null); assert.equal(restored.state.story.claimed.length, 20); assert.deepEqual(restored.state.story.sideClaimed, ['side-water-20']); assert.deepEqual(restored.state.continuation.claimed, raw.continuation.claimed);
  assert.deepEqual(restored.state.production.queue[0], oldJob); assert.deepEqual(restored.state.buildings.find((building) => building.id === upgradingKitchen.id).construction, oldConstruction);
  restored.tick(oldConstruction.remaining); assert.equal(restored.state.buildings.find((building) => building.id === upgradingKitchen.id).level, 2);
  assert.equal(restored.claimQueuedProduction(oldJob.id).ok, true); assert.equal(restored.claimQueuedProduction(oldJob.id).ok, false); assert.equal(restored.state.resources.seaweedJuice, stock.seaweedJuice + 1);
  const again = new GameState({ storage, now: () => 1_000_000 }); assert.equal(again.state.profile.experience, 535); assert.equal(again.claimStoryQuest('story-fabric-made').ok, false); assert.equal(again.claimQueuedProduction(oldJob.id).ok, false);
});

test('completed v0.9 story saves backfill the three inserted goals without replaying old rewards or repricing a paid kitchen batch', () => {
  const insertedIds = new Set(['hospital-built', 'daily-factory-built', 'daily-goods-made']);
  const oldIds = OLD_STORY_IDS.filter((id) => !insertedIds.has(id));
  assert.equal(oldIds.length, 11);
  const first = STORY_QUESTS.findIndex((quest) => quest.id === 'diving-scrap');
  assert.deepEqual(STORY_QUESTS.slice(first, first + 5).map((quest) => quest.id), ['diving-scrap', 'hospital-built', 'daily-factory-built', 'daily-goods-made', 'kitchen-level-two']);
  const storage = memoryStorage(), game = chapterGame({ storage });
  game.state.story.claimed = oldIds; game.state.continuation.claimed = CONTINUATION_QUESTS.map((quest) => quest.id);
  game.state.profile.experience = 305; game.state.profile.level = 6;
  const kitchen = build(game, 'seafoodKitchen');
  while (game.state.resources.coin < 1500) game.collect('coin');
  assert.equal(game.upgradeBuilding(kitchen.id).ok, true);
  game.tick(1200);
  const queued = game.queueProduction('seaweedJuice', 1, kitchen.id); assert.equal(queued.ok, true);
  const raw = JSON.parse(storage.getItem('fkssj-save-v1')); raw.production.version = 3; raw.production.queue[0].remaining = 37;
  // Reconstruct the actual v0.9 upgrade payment (26 wood, 16 scrap, 10 coins),
  // rather than accidentally testing an old-version label on a new-price save.
  raw.resources.coin += 1490; raw.resources.fish += 200; raw.resources.wood -= 26; raw.resources.scrap -= 16;
  delete raw.resources.dailyGoods; delete raw.production.collected.dailyGoods;
  for (const category of ['totalCollected', 'salvageCollected', 'productionGenerated', 'productionCollected']) delete raw.stats[category].dailyGoods;
  const paid = clone(raw.production.queue[0]), stock = clone(raw.resources), population = clone(raw.population);
  storage.setItem('fkssj-save-v1', JSON.stringify(raw));
  const restored = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(restored.persistenceLocked, false); assert.equal(restored.state.production.version, 6);
  assert.deepEqual(restored.state.story.claimed, oldIds); assert.deepEqual(restored.state.continuation.claimed, raw.continuation.claimed);
  assert.deepEqual(restored.state.resources, { ...stock, dailyGoods: 0 }); assert.deepEqual(restored.state.population, population); assert.equal(restored.state.profile.experience, 305);
  assert.deepEqual(restored.state.production.queue[0], paid); assert.equal(restored.getCurrentTask().id, MIDDLE_IDS[0]);
  assert.equal(restored.getFactoryUnlock('hospital').unlocked, true); assert.equal(restored.getFactoryUnlock('dailyFactory').unlocked, false);
  assert.equal(restored.getFactoryUnlock('seafoodKitchen').unlocked, true);
  assert.equal(restored.claimStoryQuest('kitchen-level-two').ok, false); assert.equal(restored.claimStoryQuest('collector-grilled-fish').ok, false);
  const before = restored.getState(); assert.equal(restored.claimStoryQuest('hospital-built').ok, false); assert.deepEqual(restored.getState(), before);
  restored.tick(37); assert.equal(restored.claimQueuedProduction(paid.id).ok, true); assert.equal(restored.claimQueuedProduction(paid.id).ok, false);
  assert.equal(restored.state.resources.seaweed, stock.seaweed); assert.equal(restored.state.resources.glass, stock.glass); assert.equal(restored.state.resources.seaweedJuice, stock.seaweedJuice + 1);
});

test('hospital adds forty capacity without creating residents and the recorded daily-goods chain charges, completes and credits once', () => {
  const storage = memoryStorage(), game = chapterGame({ storage });
  game.state.resources.dailyGoods = 0;
  game.state.story.claimed = STORY_QUESTS.slice(0, STORY_QUESTS.findIndex((quest) => quest.id === 'hospital-built')).map((quest) => quest.id);
  game.state.resources.coin = 1499;
  const before = game.getState(); assert.equal(game.placeBuilding('hospital', 1, 0).ok, false); assert.deepEqual(game.getState(), before);
  game.collect('coin'); const people = game.state.population.total, capacity = game.state.population.capacity, coin = game.state.resources.coin;
  const hospital = build(game, 'hospital');
  assert.deepEqual(BUILDINGS.hospital.cost, { coin: 1500 }); assert.equal(BUILDINGS.hospital.capacity, 40); assert.equal(BUILDINGS.hospital.maxLevel, 1);
  assert.equal(game.state.resources.coin, coin - 1500); assert.equal(game.state.population.capacity, capacity + 40); assert.equal(game.state.population.total, people);
  assert.equal(game.getProductionInfo(hospital.id), null); assert.equal(game.getUpgradeCost(hospital.id), null);
  assert.equal(game.getFactoryUnlock('dailyFactory').unlocked, false);
  const notClaimed = game.getState(); assert.equal(game.placeBuilding('dailyFactory', 1, 1).ok, false); assert.deepEqual(game.getState(), notClaimed);
  const experience = game.state.profile.experience; assert.deepEqual(game.claimStoryQuest('hospital-built').reward, {}); assert.equal(game.state.profile.experience, experience);
  while (game.state.resources.coin < 1500) assert.equal(game.collect('coin').ok, true);
  const stock = clone(game.state.resources), factory = build(game, 'dailyFactory');
  assert.deepEqual(BUILDINGS.dailyFactory.cost, { coin: 1500, scrap: 200 }); assert.equal(game.state.resources.coin, stock.coin - 1500); assert.equal(game.state.resources.scrap, stock.scrap - 200);
  assert.equal(game.claimStoryQuest('daily-factory-built').ok, true);
  const recipe = game.getRecipes(factory.id).find((value) => value.id === 'dailyGoods');
  assert.equal(recipe.referenceStatus, undefined); assert.deepEqual(recipe.inputs, { glass: 20, scrap: 20 }); assert.deepEqual(recipe.outputs, { dailyGoods: 1 });
  assert.equal(recipe.seconds, 1200); assert.equal(recipe.storage, 50); assert.equal(recipe.minBuildingLevel, 1); assert.match(recipe.source, /t=2113/);
  const scrap = game.state.resources.scrap, glass = game.state.resources.glass, queued = game.queueProduction('dailyGoods', 1, factory.id);
  assert.equal(queued.ok, true); assert.equal(game.state.resources.scrap, scrap - 20); assert.equal(game.state.resources.glass, glass - 20);
  game.tick(1199); assert.equal(game.claimQueuedProduction(queued.job.id).ok, false); assert.equal(game.state.resources.dailyGoods, 0);
  game.tick(1); assert.equal(game.state.resources.dailyGoods, 0); assert.equal(game.claimQueuedProduction(queued.job.id).ok, true);
  assert.equal(game.state.resources.dailyGoods, 1); assert.equal(game.claimQueuedProduction(queued.job.id).ok, false);
  assert.equal(game.claimStoryQuest('daily-goods-made').ok, true); assert.equal(game.claimStoryQuest('daily-goods-made').ok, false);
  const restored = new GameState({ storage, now: () => 1_000_000 });
  assert.equal(restored.state.population.total, people); assert.equal(restored.state.population.capacity, capacity + 40); assert.equal(restored.state.resources.dailyGoods, 1);
  assert.equal(restored.state.production.version, 6); assert.equal(restored.state.stats.productionCollected.dailyGoods, 1); assert.equal(restored.state.profile.experience, experience);
});

test('the recorded seafood-kitchen upgrade charges 1500 coins and 200 fish atomically after competing production without changing the old kitchen', () => {
  const game = chapterGame(), kitchen = build(game, 'seafoodKitchen'), slicer = build(game, 'slicer'), oldKitchen = build(game, 'kitchen');
  assert.deepEqual(game.getUpgradeCost(kitchen.id), { coin: 1500, fish: 200 });
  assert.deepEqual(game.getUpgradeCost(oldKitchen.id), { wood: 26, scrap: 16, coin: 10 });
  game.state.resources.coin = 1500; game.state.resources.fish = 200;
  const batch = game.queueProduction('sashimi', 1, slicer.id); assert.equal(batch.ok, true); assert.deepEqual(batch.cost, { fish: 6 });
  game.tick(11); assert.equal(game.state.resources.fish, 194, 'The manually paid sashimi batch consumes six of the same fish, without further automatic spending');
  const insufficient = game.getState(); assert.equal(game.upgradeBuilding(kitchen.id).ok, false); assert.deepEqual(game.getState(), insufficient);
  game.collect('fish'); game.collect('fish');
  const stock = clone(game.state.resources); assert.equal(game.upgradeBuilding(kitchen.id).ok, true);
  assert.equal(kitchen.level, 1); assert.equal(game.upgradeBuilding(kitchen.id).ok, false);
  game.tick(1200);
  assert.equal(kitchen.level, 2); assert.equal(game.state.resources.coin, stock.coin - 1500); assert.equal(game.state.resources.fish, stock.fish - 200);
  assert.equal(game.state.resources.wood, stock.wood); assert.equal(game.state.resources.scrap, stock.scrap);
  assert.equal(game.getUpgradeCost(kitchen.id), null);
  const once = game.getState(); assert.equal(game.upgradeBuilding(kitchen.id).ok, false); assert.deepEqual(game.getState(), once);
  assert.equal(game.getRecipes(kitchen.id).find((recipe) => recipe.id === 'seaweedJuice').unlocked, true);
});

test('all fourteen opening tasks and all twenty story tasks are reachable through public gathering, building, orders, recruitment, diving and paid production actions', () => {
  const game = new GameState({ storage: null, autoLoad: false, now: () => 1_000_000 });
  const act = (result) => { assert.equal(result.ok, true, result.message); return result; };
  const fixtureDirectory = new URL('./test-results/v0.13-qa/', import.meta.url);
  const writeFixtures = process.env.FKSSJ_WRITE_FIXTURES === '1';
  const publicGathering = {}, publicDiving = [], publicCrafting = [], hospitalBudget = {}, upgradeReserveCheck = {};
  const saveEarnedFixture = (filename) => {
    if (!writeFixtures) return;
    mkdirSync(fixtureDirectory, { recursive: true });
    writeFileSync(new URL(filename, fixtureDirectory), JSON.stringify(game.getState(), null, 2));
  };
  const scavIntro = () => {
    act(game.startScavenging());
    for (let index = 0; index < 20; index++) act(game.moveScavenging({ x: 0, z: 1 }, 0.05));
    act(game.returnScavenging());
  };
  const diveIntro = () => {
    const trip = act(game.startDiving()); let movementCalls = 0;
    for (const object of game.getDiving().objects.slice(0, 12)) {
      let attempts = 0;
      while (true) {
        const player = game.getDiving().player, dx = object.x - player.x, dy = object.y - player.y, distance = Math.hypot(dx, dy);
        if (distance < 0.21) break;
        assert.ok(attempts++ < 200); act(game.moveDiving({ x: dx / distance, y: dy / distance }, 0.05)); movementCalls++;
      }
    }
    const returned = act(game.returnDiving());
    publicDiving.push({ tripId: trip.tripId, movementCalls, resources: clone(returned.resources) });
  };
  const fund = (cost) => {
    for (const [key, amount] of Object.entries(cost)) {
      let attempts = 0;
      while (game.state.resources[key] + 1e-7 < amount) {
        assert.ok(attempts++ < 10000, `A public material source exists for ${key}`);
        if (['plastic', 'cloth'].includes(key)) scavIntro();
        else if (['glass', 'seaweed'].includes(key)) diveIntro();
        else { act(game.collect(key)); publicGathering[key] = (publicGathering[key] || 0) + 1; }
      }
    }
  };
  const expandPublic = () => {
    const occupied = new Set(game.state.raft.map(({ x, z }) => `${x},${z}`));
    const edge = game.state.raft.flatMap(({ x, z }) => [{ x: x + 1, z }, { x: x - 1, z }, { x, z: z + 1 }, { x, z: z - 1 }]).find(({ x, z }) => !occupied.has(`${x},${z}`) && Math.abs(x) <= 6 && Math.abs(z) <= 6);
    assert.ok(edge); fund(game.getExpandCost()); act(game.expand(edge.x, edge.z));
  };
  const construct = (type) => {
    if (!game.state.raft.some((tile) => !game.state.buildings.some((building) => tile.x === building.x && tile.z === building.z))) expandPublic();
    fund(BUILDINGS[type].cost); const building = build(game, type);
    const construction = game.getConstruction(building.id);
    if (construction) { assert.equal(game.isBuildingReady(building.id), false); game.tick(construction.remaining); assert.equal(game.isBuildingReady(building.id), true); }
    return building;
  };
  const craftPublic = (recipeId, quantity, building) => {
    const recipe = game.getRecipes(building.id).find((recipe) => recipe.id === recipeId); assert.ok(recipe);
    fund(Object.fromEntries(Object.entries(recipe.inputs).map(([key, amount]) => [key, amount * quantity])));
    const queued = act(game.queueProduction(recipeId, quantity, building.id)); game.tick(queued.job.duration); act(game.claimQueuedProduction(queued.job.id));
    publicCrafting.push({ recipeId, quantity, buildingId: building.id, inputs: clone(queued.job.inputs), duration: queued.job.duration, collected: clone(queued.job.outputs) });
  };
  const claim = (id) => act(game.claimQuest(id));
  for (let index = 0; index < 3; index++) act(game.collect('wood'));
  claim('salvage'); construct('fishing'); claim('fishing');
  for (let index = 0; index < 4; index++) { if (index) game.tick(2.5); act(game.castLine()); }
  claim('fish'); const slicer = construct('slicer'); claim('slicer'); craftPublic('sashimi', 5, slicer); act(game.deliverResidentOrder()); claim('food');
  const purifier = construct('purifier'); claim('purifier'); game.tick(60); act(game.collectProduction(purifier.id)); claim('water');
  fund(game.getExpandCost()); act(game.expand(2, 0)); fund(game.getExpandCost()); act(game.expand(2, 1)); claim('expand');
  construct('scavenger'); claim('scavenger'); craftPublic('sashimi', 3, slicer); act(game.explore()); claim('rescue'); construct('bed'); claim('bed'); construct('farm'); claim('farm');
  fund(game.getUpgradeCost('command')); act(game.upgradeBuilding('command')); fund({ water: 6, food: 6 }); act(game.faceStorm()); claim('command'); construct('beacon'); claim('beacon');
  assert.equal(game.state.quests.claimed.length, 14); assert.equal(game.getCurrentTask().id, 'plastic-reserve');
  let kitchen, dailyFactory, materials, tailor;
  const finished = [];
  for (const definition of STORY_QUESTS) {
    assert.equal(game.getCurrentTask().id, definition.id);
    if (definition.id === 'plastic-reserve') fund({ plastic: 40 });
    if (definition.id === 'seafood-kitchen-built') kitchen = construct('seafoodKitchen');
    if (definition.id === 'collector-grilled-fish') {
      fund({ fish: 1, wood: 5 }); const job = act(game.queueProduction('grilledFish', 1, kitchen.id)); game.tick(300); act(game.claimQueuedProduction(job.job.id));
    }
    if (definition.id === 'leader-six') {
      for (const id of ['first-meal', 'fresh-water', 'welcome-meal']) {
        if (game.state.residentOrders.completed.includes(id)) continue;
        const order = game.getResidentOrder(); assert.equal(order.id, id);
        fund(order.order.cost); act(game.deliverResidentOrder(id));
      }
      assert.equal(game.state.profile.experience, 305); assert.equal(game.state.profile.level, 6);
      assert.equal(game.state.residentOrders.completed.includes('deodorizer-meal'), false, 'The optional recorded order is not required or silently delivered by the story route');
    }
    if (definition.id === 'broadcast-built') {
      fund(BUILDINGS.broadcast.cost);
      // Browser acceptance continues through two builds and a kitchen upgrade;
      // keep a genuine, publicly gathered wood reserve for that complete route.
      for (let index = 0; index < 14; index++) act(game.collect('wood'));
      saveEarnedFixture('earned-before-broadcast.json'); construct('broadcast');
    }
    if (definition.id === 'recruit-first') {
      const progress = new ProgressState(game), before = game.state.progression.wallet.tickets;
      const result = act(progress.recruit('normal', 1)); assert.equal(result.freeFirst, true); assert.equal(game.state.progression.wallet.tickets, before);
    }
    if (definition.id === 'story-tailor-built') {
      materials = construct('materials'); craftPublic('fabric', 4, materials); craftPublic('rope', 1, materials);
      const construction = construct('construction'); craftPublic('plank', 2, construction); tailor = construct('tailor');
    }
    if (definition.id === 'story-lifejacket-made') craftPublic('lifejacket', 1, tailor);
    if (definition.id === 'story-slicer-level-two') { fund(game.getUpgradeCost(slicer.id)); act(game.upgradeBuilding(slicer.id)); }
    if (definition.id === 'story-fish-line-made') craftPublic('fishLine', 1, slicer);
    if (definition.id === 'story-materials-built') assert.equal(materials.type, 'materials', 'The earlier genuine material factory satisfies its later recorded story goal without rebuilding');
    if (definition.id === 'story-fabric-made') assert.equal(game.state.stats.productionCollected.fabric, 4, 'Four genuinely crafted and claimed fabric used in factory construction also satisfy the later cumulative story goal');
    if (definition.id === 'diving-dock-built') construct('divingDock');
    if (definition.id === 'diving-scrap') {
      while (game.state.diving.totalCollected.scrap < 20 || game.state.resources.seaweed < 20 || game.state.resources.glass < 10) {
        diveIntro();
      }
    }
    if (definition.id === 'hospital-built') {
      const dailyRecipe = game.getRecipes().find((recipe) => recipe.id === 'dailyGoods'); assert.ok(dailyRecipe);
      const juiceRecipe = game.getRecipes().find((recipe) => recipe.id === 'seaweedJuice');
      const expansion = game.getExpandCost();
      // Reserve both buildings, the kitchen upgrade, one batch of daily goods,
      // one juice batch and a conservative two-expansion buffer before the UI
      // fixture. Gathering below uses only public, authoritative domain actions.
      for (const bundle of [BUILDINGS.hospital.cost, BUILDINGS.dailyFactory.cost, game.getUpgradeCost(kitchen.id), dailyRecipe.inputs, juiceRecipe.inputs, { wood: (expansion.wood + 2) * 2, scrap: expansion.scrap * 2 }]) {
        for (const [key, amount] of Object.entries(bundle)) hospitalBudget[key] = (hospitalBudget[key] || 0) + amount;
      }
      fund(hospitalBudget);
      assert.equal(hospitalBudget.glass, 30, 'One verified daily-goods batch and the later juice batch reserve 20 + 10 glass');
      assert.ok(game.state.resources.glass >= 30); assert.ok(game.state.resources.seaweed >= 20);
      upgradeReserveCheck.beforeHospital = { fish: game.state.resources.fish, coin: game.state.resources.coin, glass: game.state.resources.glass, requiredGlassForDailyAndJuice: hospitalBudget.glass, fishCollectActions: publicGathering.fish || 0, publicDivingTrips: publicDiving.length };
      saveEarnedFixture('earned-before-hospital.json');
      const residents = game.state.population.total, capacity = game.state.population.capacity;
      construct('hospital'); assert.equal(game.state.population.total, residents); assert.equal(game.state.population.capacity, capacity + 40);
    }
    if (definition.id === 'daily-factory-built') dailyFactory = construct('dailyFactory');
    if (definition.id === 'daily-goods-made') {
      const recipe = game.getRecipes(dailyFactory.id).find((value) => value.id === 'dailyGoods'); assert.equal(recipe.canQueue, true);
      const before = clone(game.state.resources), queued = act(game.queueProduction('dailyGoods', 1, dailyFactory.id));
      for (const [key, amount] of Object.entries(recipe.inputs)) assert.equal(game.state.resources[key], before[key] - amount);
      game.tick(recipe.seconds); assert.equal(game.state.resources.dailyGoods, 0); act(game.claimQueuedProduction(queued.job.id));
      assert.equal(game.claimQueuedProduction(queued.job.id).ok, false); assert.equal(game.state.resources.dailyGoods, 1);
    }
    if (definition.id === 'kitchen-level-two') {
      const cost = game.getUpgradeCost(kitchen.id);
      // The pre-hospital earned fixture must cover this later payment without
      // silently regathering fish or coins after the daily-goods timer advances.
      for (const [key, amount] of Object.entries(cost)) assert.ok(game.state.resources[key] >= amount, `Reserved upgrade ${key} survives previously paid queues and daily production`);
      assert.ok(game.state.resources.glass >= 10, 'The later seaweed-juice glass reserve survives the verified daily-goods payment');
      upgradeReserveCheck.afterDailyProduction = { fish: game.state.resources.fish, coin: game.state.resources.coin, glass: game.state.resources.glass, requiredCost: clone(cost), additionalFishCollectActions: (publicGathering.fish || 0) - upgradeReserveCheck.beforeHospital.fishCollectActions };
      assert.equal(upgradeReserveCheck.afterDailyProduction.additionalFishCollectActions, 0, 'The pre-hospital fish reserve survives the full route without replenishment');
      saveEarnedFixture('earned-before-kitchen-upgrade.json'); act(game.upgradeBuilding(kitchen.id));
      assert.equal(game.getCurrentTask().complete, false); assert.equal(kitchen.level, 1); game.tick(1200);
    }
    if (definition.id === 'seaweed-juice-made') {
      const recipe = game.getRecipes(kitchen.id).find((value) => value.id === 'seaweedJuice'); assert.equal(recipe.canQueue, true);
      const before = clone(game.state.resources), job = act(game.queueProduction('seaweedJuice', 1, kitchen.id));
      assert.equal(game.state.resources.seaweed, before.seaweed - 20); assert.equal(game.state.resources.glass, before.glass - 10);
      game.tick(1200); assert.equal(game.state.resources.seaweedJuice, 0); act(game.claimQueuedProduction(job.job.id));
      assert.equal(game.claimQueuedProduction(job.job.id).ok, false); assert.equal(game.state.resources.seaweedJuice, 1);
    }
    assert.equal(game.getCurrentTask().complete, true, definition.id);
    act(game.claimStoryQuest(definition.id)); finished.push(definition.id);
    assert.equal(game.claimStoryQuest(definition.id).ok, false);
  }
  assert.deepEqual(finished, STORY_QUESTS.map((quest) => quest.id)); assert.equal(game.state.story.claimed.length, 20);
  assert.equal(game.state.profile.experience, 535, 'Two thirty-five-XP and four forty-XP confirmed rewards add to the original 305-XP route');
  assert.deepEqual(game.state.continuation.claimed, ['seafood-kitchen-built', 'collector-grilled-fish']);
  assert.equal(game.getCurrentTask().category, 'continuation'); assert.equal(game.getCurrentTask().id, 'supply-trip');
  if (writeFixtures) writeFileSync(new URL('earned-fixture-provenance.json', fixtureDirectory), JSON.stringify({
    generator: 'story-state.test.mjs: all fourteen opening tasks and all twenty story tasks are reachable through public gathering, building, orders, recruitment, diving and paid production actions',
    command: 'FKSSJ_WRITE_FIXTURES=1 node --test story-state.test.mjs',
    method: 'Starts an empty GameState and uses public domain actions for all opening and story progress, materials, XP, queues and claims. No injected currency, material inventory, quest claims, hero XP or fabricated cargo. Camp timers are advanced through GameState.tick; scavenging and diving use real bounded movement calls.',
    economyBoundary: 'This demonstrates reachability through public domain actions, not natural earning time. GameState.collect(coin) grants two coins per call; any such funding is explicitly counted below.',
    publicGathering, publicDiving, publicCrafting, hospitalBudget, upgradeReserveCheck,
    dailyGoodsRecipe: { source: 'https://www.bilibili.com/video/BV1Vt9MByEP8/?t=2113', inputs: { glass: 20, scrap: 20 }, seconds: 1200, storage: 50, evidence: ['public video at 2113s', 'public video at 2115s', 'public video at 2117s'], fixtureGlassMethod: 'Public startDiving/moveDiving/returnDiving trips fund at least 30 glass before hospital: 20 for daily goods plus 10 for seaweed juice. No injected glass or fabricated cargo.' },
    browserFixtureClock: 'The deterministic test uses now=1000000. Set savedAt to the current time when installing a fixture in browser storage to avoid unintended offline advancement.',
    browserPreparation: { fixture: 'earned-before-broadcast.json', method: 'Fourteen extra public GameState.collect(wood) calls before saving the broadcast fixture.', extraWood: 84, activeTask: 'broadcast-built', storyClaims: 5, broadcastBuilt: false },
    files: [
      { path: 'earned-before-broadcast.json', activeStory: 'broadcast-built', broadcastBuilt: false, fundedConstruction: true },
      { path: 'earned-before-hospital.json', activeStory: 'hospital-built', hospitalBuilt: false, fundedHospitalFactoryKitchenAndTwoExpansions: true, reservedRecipeBatches: ['dailyGoods', 'seaweedJuice'] },
      { path: 'earned-before-kitchen-upgrade.json', activeStory: 'kitchen-level-two', kitchenLevel: 1, seaweedAtLeast: 20, glassAtLeast: 10, fundedUpgrade: true },
    ],
    openingClaims: game.state.quests.claimed.length, storyClaims: game.state.story.claimed.length, finalLeaderExperience: game.state.profile.experience,
  }, null, 2));
});

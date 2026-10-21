import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from './game-state.js';
import { ProgressState, HEROES, STAGES, CONFIG_NOTE, createProgression, normalizeProgression, simulateBattle } from './progress-state.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
function host(raw, clock = () => 1_000_000) {
  const events = [];
  const game = { state: { progression: raw }, now: clock, _changed(type, detail, forceSave = true) { events.push({ type, ...detail, forceSave }); } };
  return { game, engine: new ProgressState(game), events };
}
function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function finish(engine) {
  const battle = engine.getBattle();
  const advanced = engine.advanceBattle(battle.duration);
  assert.equal(advanced.finished, true);
  return engine.getBattle();
}
function strongCheckpoint(stage = 0) {
  const raw = createProgression(1_000_000);
  for (const id of Object.keys(HEROES).filter((id) => id !== 'mia')) raw.heroes[id] = { id, level: 50, stars: 6, shards: 0 };
  raw.formation = ['sam', 'yilong', 'mechanic', 'rambo', 'wizard'];
  raw.campaign.highestCleared = stage;
  raw.campaign.claimedStages = Array.from({ length: stage }, (_, index) => index + 1);
  return raw;
}

test('default continuation exposes eight distinct heroes and 40 project-configured stages without rewriting future saves', () => {
  const { engine } = host();
  assert.match(CONFIG_NOTE, /本项目配置/);
  assert.equal(engine.getHeroes().length, 8);
  assert.equal(new Set(engine.getHeroes().map((hero) => hero.skill.kind)).size, 8);
  assert.equal(STAGES.length, 40);
  assert.equal(STAGES[39].miaRescue, true);
  assert.equal(engine.getStage(null).id, 1);
  assert.equal(engine.getStage(2).unlocked, false);
  assert.equal(engine.getHero('__proto__'), null);
  assert.equal(engine.upgradeHero('toString').ok, false);
  assert.equal(engine.state.version, 2);
  assert.deepEqual(engine.state.formation, ['loyal', 'yilong', null, 'lei', 'mechanic']);
  assert.throws(() => normalizeProgression({ version: 3 }), /更新版本/);
});

test('single-wallet recruitment applies fifty-pull pity, alias compatibility and deterministic save continuation without overspending', () => {
  const raw = createProgression(1_000_000);
  raw.recruitment.normalCount = 49;
  raw.recruitment.pity = 49;
  for (const id of ['sam', 'rambo', 'wizard']) raw.heroes[id] = { id, level: 1, stars: 1, shards: 0 };
  const { engine } = host(raw);
  const result = engine.recruit('normal', 1);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].rarity, 'legendary');
  assert.equal(result.results[0].forcedLegend, true);
  assert.equal(result.results[0].duplicate, true);
  assert.equal(result.results[0].shards, 20);
  assert.equal(engine.state.heroes[result.results[0].heroId].shards, 20);
  assert.deepEqual(result.cost, { tickets: 1 });
  assert.equal(engine.state.wallet.tickets, 24);
  assert.equal(engine.state.wallet.legendTickets, 0);
  assert.equal(engine.state.recruitment.pity, 0);
  const saved = clone(engine.state);
  const replay = host(saved).engine;
  assert.deepEqual(engine.recruit('normal', 10).results, replay.recruit('legend', 10).results);
  assert.equal(engine.state.wallet.tickets, 14);
  assert.deepEqual(engine.state.recruitment, replay.state.recruitment);
  assert.equal(engine.state.recruitment.normalCount, 60);
  assert.equal(engine.state.recruitment.legendCount, 0);
  engine.state.wallet.tickets = 0;
  const before = clone(engine.state);
  assert.equal(engine.recruit('legend', 10).ok, false);
  assert.equal(engine.recruit('normal', 50).ok, false);
  assert.deepEqual(engine.state, before);
});

test('the first-ever single pull is free once across save/load, while ten pulls and any historical recruitment remain paid', () => {
  const raw = createProgression(1_000_000); raw.wallet.tickets = 0;
  const { engine } = host(raw);
  assert.deepEqual(engine.getRecruitCost(1), { tickets: 0 }); assert.deepEqual(engine.getRecruitCost(10), { tickets: 10 }); assert.equal(engine.getRecruitCost(50), null);
  const result = engine.recruit('legend', 1); assert.equal(result.ok, true); assert.equal(result.freeFirst, true); assert.deepEqual(result.cost, { tickets: 0 });
  assert.equal(engine.state.wallet.tickets, 0); assert.equal(engine.state.recruitment.normalCount, 1);
  const resumed = host(clone(engine.state)).engine, settled = clone(resumed.state);
  assert.deepEqual(resumed.getRecruitCost(1), { tickets: 1 }); assert.equal(resumed.recruit('normal', 1).ok, false); assert.deepEqual(resumed.state, settled);
  const firstTen = host().engine;
  assert.equal(firstTen.recruit('normal', 10).freeFirst, false); assert.equal(firstTen.state.wallet.tickets, 15); assert.equal(firstTen.state.recruitment.normalCount, 10);
  assert.equal(firstTen.recruit('normal', 1).freeFirst, false); assert.equal(firstTen.state.wallet.tickets, 14);
  const legacy = createProgression(1_000_000); legacy.recruitment.legendCount = 1; legacy.wallet.tickets = 0;
  const old = host(legacy).engine; assert.deepEqual(old.getRecruitCost(1), { tickets: 1 }); assert.equal(old.recruit('normal', 1).ok, false);
});

test('legacy tickets and idle fractions merge once while old pull counts and shared pity continue across both API names', () => {
  for (const version of [1, 2]) {
    const raw = createProgression(1_000_000); raw.version = version;
    raw.wallet.tickets = 4; raw.wallet.legendTickets = 6;
    raw.recruitment = { ...raw.recruitment, normalCount: 17, legendCount: 23, pity: 48, seed: 1 };
    raw.campaign.highestCleared = 1; raw.campaign.claimedStages = [1];
    raw.idle.pending.tickets = 0.4; raw.idle.pending.legendTickets = 1.2;
    const { engine } = host(raw);
    assert.equal(engine.state.wallet.tickets, 10);
    assert.equal(engine.state.wallet.legendTickets, 0);
    assert.equal(engine.state.recruitment.normalCount + engine.state.recruitment.legendCount, 40);
    assert.equal(engine.state.recruitment.pity, 48);
    assert.ok(Math.abs(engine.state.idle.pending.tickets - 1.6) < 1e-8);
    assert.equal(engine.state.idle.pending.legendTickets, 0);
    assert.deepEqual(normalizeProgression(clone(engine.state), 1_000_000), engine.state);
    assert.notEqual(engine.recruit('normal', 1).results[0].rarity, 'legendary');
    assert.equal(engine.state.recruitment.pity, 49);
    assert.equal(engine.recruit('legend', 1).results[0].forcedLegend, true);
    assert.equal(engine.state.recruitment.pity, 0);
    assert.equal(engine.state.recruitment.normalCount, 19);
    assert.equal(engine.state.recruitment.legendCount, 23);
    assert.equal(engine.state.wallet.tickets, 8);
    assert.equal(engine.state.wallet.legendTickets, 0);
    const idle = engine.getIdle();
    assert.equal(idle.pending.tickets, 1);
    assert.equal(idle.perMinute.tickets, 0.06);
    assert.equal(idle.perMinute.legendTickets, 0);
    assert.equal(engine.claimIdle().ok, true);
    assert.equal(engine.state.wallet.tickets, 9);
    const restored = host(clone(engine.state)).engine;
    assert.equal(restored.state.wallet.tickets, 9);
    assert.equal(restored.claimIdle().ok, false);
    assert.ok(Math.abs(restored.state.idle.pending.tickets - 0.6) < 1e-8);
  }
});

test('hero upgrades and stars charge aggregate costs atomically and obey level/star limits', () => {
  const { engine } = host();
  const cost = engine.getUpgradeCost('yilong', 2);
  const coin = engine.state.wallet.coin, experience = engine.state.wallet.heroExp;
  assert.deepEqual(Object.keys(cost), ['heroExp']);
  assert.equal(engine.upgradeHero('yilong', 2).ok, true);
  assert.equal(engine.state.heroes.yilong.level, 3);
  assert.equal(engine.state.wallet.coin, coin);
  assert.equal(engine.state.wallet.heroExp, experience - cost.heroExp);
  engine.state.wallet.coin = 0;
  assert.equal(engine.upgradeHero('yilong').ok, true, 'Zero coins do not block an experience-only upgrade');
  engine.state.wallet.heroExp = 0;
  const before = clone(engine.state);
  assert.equal(engine.upgradeHero('yilong', 5).ok, false);
  assert.deepEqual(engine.state, before);
  engine.state.wallet.coin = 1000;
  engine.state.heroes.yilong.shards = 12;
  const stars = engine.starUpHero('yilong');
  assert.equal(stars.ok, true);
  assert.equal(engine.state.heroes.yilong.stars, 2);
  assert.equal(engine.state.heroes.yilong.shards, 0);
  assert.equal(engine.state.wallet.essence, 10);
  engine.state.heroes.yilong.level = 50; engine.state.heroes.yilong.stars = 6;
  assert.equal(engine.getUpgradeCost('yilong'), null);
  assert.equal(engine.getStarCost('yilong'), null);
});

test('five-position formation supports real swaps and rejects extra, duplicate or unknown hero slots', () => {
  const { engine } = host(strongCheckpoint());
  const initial = [...engine.state.formation];
  assert.equal(engine.assignSlot('yilong', 0).ok, true);
  assert.equal(engine.state.formation[0], 'yilong');
  assert.equal(engine.state.formation[1], 'sam');
  const before = [...engine.state.formation];
  assert.equal(engine.setFormation(['sam', 'sam', null, null, null]).ok, false);
  assert.equal(engine.setFormation(['sam', 'yilong', 'rambo', 'wizard', 'mechanic', 'lei']).ok, false);
  assert.equal(engine.assignSlot('__proto__', 2).ok, false);
  assert.equal(engine.assignSlot('sam', 5).ok, false);
  assert.deepEqual(engine.state.formation, before);
  assert.equal(engine.setFormation(initial).ok, true);
});

test('v1 migration refunds legacy level coins exactly once without changing levels, stars or other materials', () => {
  const storage = memoryStorage(), now = 1_000_000;
  const initialGame = new GameState({ storage, now: () => now, autoLoad: false });
  initialGame.save();
  const raw = JSON.parse(storage.getItem('fkssj-save-v1'));
  const legacy = raw.progression;
  legacy.version = 1;
  legacy.heroes.yilong = { id: 'yilong', level: 4, stars: 3, shards: 7 };
  legacy.heroes.lei.level = 3;
  legacy.wallet = { tickets: 13, legendTickets: 2, heroExp: 37, coin: 17, essence: 11 };
  legacy.formation.push(null);
  storage.setItem('fkssj-save-v1', JSON.stringify(raw));
  const migratedGame = new GameState({ storage, now: () => now });
  const migrated = new ProgressState(migratedGame);
  assert.equal(migrated.state.version, 2);
  assert.equal(migrated.state.wallet.coin, 17 + 8 * (1 + 2 + 3) + 8 * (1 + 2));
  assert.deepEqual(migrated.state.heroes, legacy.heroes);
  assert.equal(migrated.state.wallet.tickets, legacy.wallet.tickets + legacy.wallet.legendTickets);
  assert.equal(migrated.state.wallet.legendTickets, 0);
  for (const key of ['heroExp', 'essence']) assert.equal(migrated.state.wallet[key], legacy.wallet[key]);
  const once = clone(migrated.state);
  assert.deepEqual(normalizeProgression(once, now), once);
  migratedGame.save();
  const reread = new ProgressState(new GameState({ storage, now: () => now }));
  assert.deepEqual(reread.state.wallet, once.wallet);
  assert.equal(reread.state.heroes.yilong.level, 4);
  assert.equal(createProgression(now).wallet.coin, 240);
  assert.equal(normalizeProgression(undefined, now).wallet.coin, 240, 'A missing progression is a fresh account, not a legacy refund');
  const capped = createProgression(now); capped.version = 1; capped.wallet.coin = 1_000_000_000; capped.heroes.yilong.level = 50;
  const refunded = normalizeProgression(capped, now);
  assert.equal(normalizeProgression(refunded, now).wallet.coin, 1_000_009_800, 'A maximum old balance also retains its refund after reload');
});

test('v1 sixth-slot hero moves into a free fifth-position roster while saved combat slots, events and time remain intact', () => {
  const raw = createProgression(1_000_000); raw.version = 1;
  raw.heroes.rambo = { id: 'rambo', level: 1, stars: 1, shards: 0 };
  raw.formation = ['loyal', 'yilong', null, 'lei', 'mechanic', 'rambo'];
  const allies = raw.formation.flatMap((id, slot) => id ? [{ id: `ally-${id}`, heroId: id, name: HEROES[id].name, job: HEROES[id].job, slot, ...HEROES[id].baseStats, skill: HEROES[id].skill, color: HEROES[id].color, portrait: HEROES[id].portrait }] : []);
  raw.battle = { id: 'legacy-battle-12', stage: 5, ...simulateBattle(allies, STAGES[4].enemies, { seed: 5 * 7919 }), time: 4.25, phase: 'playing', claimed: false };
  const originalBattle = clone(raw.battle);
  const { engine } = host(raw);
  assert.deepEqual(engine.state.formation, ['loyal', 'yilong', 'rambo', 'lei', 'mechanic']);
  assert.equal(new Set(engine.state.formation).size, 5);
  assert.deepEqual(engine.getBattle(), originalBattle);
  assert.equal(engine.getBattle().allies.find((unit) => unit.heroId === 'rambo').slot, 5);
  engine.advanceBattle(0.25);
  assert.equal(engine.getBattle().time, 4.5);
  assert.deepEqual(engine.getBattle().events, originalBattle.events);
  assert.deepEqual(host(clone(engine.state)).engine.getBattle(), engine.getBattle());
});

test('battle replays contain deterministic actual attacks, targeted damage, healing and shields rather than a power comparison', () => {
  const team = (side) => [
    { id: `${side}-tank`, name: '守卫', slot: 0, maxHp: 1400, attack: 25, armor: 10, interval: 1.2, skill: { name: '护盾', kind: 'guard', cooldown: 4, power: 2 } },
    { id: `${side}-healer`, name: '修复', slot: 3, maxHp: 600, attack: 28, armor: 5, interval: 1.6, skill: { name: '治疗', kind: 'heal', cooldown: 4, power: 3 } },
  ];
  const first = simulateBattle(team('ally'), team('enemy'), { seed: 73 });
  const again = simulateBattle(team('ally'), team('enemy'), { seed: 73 });
  assert.deepEqual(first, again);
  assert.ok(first.duration > 10);
  assert.ok(first.events.some((event) => event.type === 'heal' && event.amount > 0));
  assert.ok(first.events.some((event) => event.type === 'shield' && event.amount > 0));
  assert.ok(first.events.some((event) => event.type === 'damage' && event.amount > 0));
  assert.ok(first.events.every((event, index) => !index || event.at >= first.events[index - 1].at));
  const firstEnemyAttack = first.events.find((event) => event.type === 'attack' && event.actorId.startsWith('enemy'));
  assert.equal(firstEnemyAttack.targetId, 'ally-tank');
  const swapped = team('ally'); swapped[0].slot = 3; swapped[1].slot = 0;
  const reordered = simulateBattle(swapped, team('enemy'), { seed: 73 });
  assert.equal(reordered.events.find((event) => event.type === 'attack' && event.actorId.startsWith('enemy')).targetId, 'ally-healer');
  const initialUnits = new Map([...first.allies, ...first.enemies].map((unit) => [unit.id, unit]));
  for (const event of first.events) if ('hpAfter' in event) assert.ok(event.hpAfter >= 0 && event.hpAfter <= initialUnits.get(event.targetId).maxHp);
  assert.equal(first.allies[0].hp, first.allies[0].maxHp, 'Replay units retain initial hp for seek/reload');
});

test('campaign rewards are explicit, exactly-once across reload, and repeated clears do not repeat first rewards', () => {
  const { engine, events } = host();
  assert.equal(engine.startBattle(2).ok, false);
  const started = engine.startBattle(1);
  assert.equal(started.ok, true);
  assert.equal(engine.claimBattleReward().ok, false);
  engine.advanceBattle(0.25);
  assert.equal(events.at(-1).forceSave, false);
  assert.equal(finish(engine).result, 'victory');
  assert.equal(events.at(-1).forceSave, true);
  assert.equal(engine.startBattle(1).ok, false, 'Unclaimed victory cannot be overwritten');
  const claimed = engine.claimBattleReward();
  assert.equal(claimed.ok, true); assert.equal(claimed.firstClear, true);
  assert.equal(engine.state.campaign.highestCleared, 1);
  const after = clone(engine.state.wallet);
  assert.equal(engine.claimBattleReward().ok, false);
  const restored = host(clone(engine.state)).engine;
  assert.equal(restored.claimBattleReward().ok, false);
  assert.deepEqual(restored.state.wallet, after);
  assert.equal(restored.startBattle(1).ok, true);
  finish(restored);
  const repeated = restored.claimBattleReward();
  assert.equal(repeated.ok, true); assert.equal(repeated.firstClear, false);
  assert.deepEqual(restored.state.wallet, after);
});

test('an old won battle pays the same total tickets once after single-pool migration without changing its combat replay', () => {
  const previous = host(strongCheckpoint(4)).engine;
  previous.startBattle(5); finish(previous);
  const raw = clone(previous.state); raw.version = 1;
  raw.wallet.tickets = 4; raw.wallet.legendTickets = 3;
  const originalBattle = clone(raw.battle), migrated = host(raw).engine;
  assert.deepEqual(migrated.getBattle(), originalBattle);
  assert.equal(migrated.state.wallet.tickets, 7);
  assert.ok(STAGES.every((stage) => stage.rewards.legendTickets === 0));
  const reward = migrated.claimBattleReward();
  assert.equal(reward.ok, true);
  assert.equal(reward.firstClear, true);
  assert.equal(reward.rewards.tickets, 2, 'Old stage 5 awarded one ordinary and one legacy ticket');
  assert.equal(reward.rewards.legendTickets, 0);
  assert.equal(migrated.state.wallet.tickets, 9);
  assert.equal(migrated.state.wallet.legendTickets, 0);
  const restored = host(clone(migrated.state)).engine;
  assert.equal(restored.claimBattleReward().ok, false);
  assert.equal(restored.state.wallet.tickets, 9);
  assert.equal(restored.state.campaign.claimedStages.includes(5), true);
});

test('battle skip requires ten actual elapsed seconds and uses the existing simulated outcome; losses can retry without reward', () => {
  const raw = createProgression(1_000_000);
  raw.campaign.highestCleared = 4;
  raw.campaign.claimedStages = Array.from({ length: 4 }, (_, index) => index + 1);
  raw.formation = ['loyal', null, null, null, null];
  const { engine } = host(raw);
  const battle = engine.startBattle(5).battle;
  const originalOutcome = battle.result;
  assert.ok(battle.duration >= 10);
  engine.advanceBattle(9.75);
  assert.equal(engine.skipBattle().ok, false);
  const restored = host(clone(engine.state)).engine;
  assert.equal(restored.getBattle().time, 9.75);
  assert.equal(restored.getBattle().result, originalOutcome);
  restored.advanceBattle(0.25);
  assert.equal(restored.skipBattle().ok, true);
  assert.equal(restored.getBattle().result, originalOutcome);
  assert.equal(originalOutcome, 'defeat');
  assert.equal(restored.claimBattleReward().ok, false);
  assert.equal(restored.startBattle(5).ok, true);
});

test('Li Zhongcheng and Mechanic summon independent machines that absorb damage, attack and expire after fifteen seconds', () => {
  const ally = (heroId, slot) => ({ id: `ally-${heroId}`, name: HEROES[heroId].name, heroId, slot, maxHp: 2000, attack: 30, armor: 10, interval: 2, skill: HEROES[heroId].skill });
  const enemy = { id: 'enemy-training', name: '测试敌人', slot: 0, maxHp: 100000, attack: 20, interval: 1, armor: 0 };
  const battle = simulateBattle([ally('loyal', 0), ally('mechanic', 3)], [enemy], { seed: 9, maxDuration: 35 });
  for (const kind of ['summonDog', 'summonBot']) {
    const spawned = battle.events.filter((event) => event.type === 'spawn' && event.unit.summonKind === kind);
    assert.ok(spawned.length >= 2);
    const first = spawned[0];
    assert.equal(first.side, 'allies');
    assert.equal(first.unit.kind, kind === 'summonDog' ? 'dog' : 'robot');
    assert.equal(first.unit.hp, first.unit.maxHp);
    assert.ok(first.unit.ownerId && first.unit.id !== first.unit.ownerId);
    assert.ok(battle.events.some((event) => event.type === 'attack' && event.actorId === first.unit.id));
    assert.ok(battle.events.some((event) => event.type === 'damage' && event.targetId === first.unit.id && event.amount > 0));
    const expired = battle.events.find((event) => event.type === 'defeat' && event.targetId === first.unit.id && event.reason === 'expired');
    assert.ok(expired);
    assert.equal(expired.at - first.at, 15);
  }
  assert.deepEqual(simulateBattle(battle.allies, battle.enemies, { seed: 9, maxDuration: 35 }), battle, 'Spawn timeline is also deterministic from initial units');
});

test('wizard speed and critical buffs alter real attack cadence and add shields; Professor casts five lightning bolts', () => {
  const shooter = { id: 'ally-shooter', slot: 0, maxHp: 100000, attack: 50, interval: 2, armor: 0 };
  const wizard = { id: 'ally-wizard', slot: 3, maxHp: 100000, attack: 25, interval: 1.9, armor: 0, skill: HEROES.wizard.skill };
  const enemy = { id: 'enemy-target', slot: 0, maxHp: 100000, attack: 1, interval: 2, armor: 0 };
  const battle = simulateBattle([shooter, wizard], [enemy], { seed: 18, maxDuration: 24 });
  const baseline = simulateBattle([shooter, { ...wizard, skill: { kind: 'none' } }], [enemy], { seed: 18, maxDuration: 24 });
  const attacks = battle.events.filter((event) => event.type === 'attack' && event.actorId === shooter.id);
  const baselineAttacks = baseline.events.filter((event) => event.type === 'attack' && event.actorId === shooter.id);
  assert.ok(attacks.length > baselineAttacks.length);
  assert.ok(attacks.some((event, index) => index > 0 && event.at - attacks[index - 1].at < 1.5));
  assert.ok(battle.events.some((event) => event.type === 'buff' && event.targetId === shooter.id && event.speedMultiplier > 1 && event.critBonus > 0));
  assert.ok(battle.events.some((event) => event.type === 'shield' && event.targetId === shooter.id && event.amount > 0));
  const lightning = simulateBattle([{ ...shooter, id: 'ally-lei', skill: HEROES.lei.skill }], [enemy], { seed: 1, maxDuration: 10 });
  const skillAt = lightning.events.find((event) => event.type === 'skill').at;
  const bolts = lightning.events.filter((event) => event.at === skillAt && event.type === 'attack' && event.label?.startsWith('雷电 '));
  assert.equal(bolts.length, 5);
});

test('all forty stages resolve with actual events and stage 40 rescues Mia once', () => {
  const { engine } = host(strongCheckpoint());
  for (let stage = 1; stage <= 40; stage++) {
    assert.equal(engine.startBattle(stage).ok, true);
    const battle = finish(engine);
    assert.equal(battle.result, 'victory', `Configured max-grown team can clear stage ${stage}`);
    assert.ok(battle.events.some((event) => event.type === 'defeat'));
    const reward = engine.claimBattleReward();
    assert.equal(reward.ok, true);
    assert.equal(reward.rescuedHero, stage === 40 ? 'mia' : null);
  }
  assert.equal(engine.state.campaign.highestCleared, 40);
  assert.equal(engine.state.campaign.claimedStages.length, 40);
  assert.equal(engine.getHero('mia').owned, true);
  assert.equal(engine.state.heroes.mia.shards, 0);
  assert.equal(engine.claimBattleReward().ok, false);
});

test('idle accrual caps at two hours, survives reload without duplicate claims and retains sub-minute progress', () => {
  let now = 1_000_000;
  const raw = createProgression(now);
  raw.campaign.highestCleared = 1; raw.campaign.claimedStages = [1];
  const { engine } = host(raw, () => now);
  now += 10 * 60 * 60 * 1000;
  const idle = engine.getIdle();
  assert.equal(idle.seconds, 7200); assert.equal(idle.capped, true);
  assert.equal(idle.pending.coin, idle.perMinute.coin * 120);
  const claimed = engine.claimIdle();
  assert.equal(claimed.ok, true);
  const restored = host(clone(engine.state), () => now).engine;
  const after = clone(restored.state.wallet);
  assert.equal(restored.claimIdle().ok, false);
  assert.deepEqual(restored.state.wallet, after);
  now += 31_000;
  assert.equal(restored.getIdle().pending.coin, 4);
  assert.equal(restored.claimIdle().ok, true);
  now += 29_000;
  assert.equal(restored.getIdle().pending.heroExp, 10, 'Fractional income survives a partial-minute claim');
  const later = restored.state.idle.lastAccruedAt;
  now -= 60_000;
  assert.equal(restored.claimIdle().ok, false);
  assert.equal(restored.state.idle.lastAccruedAt, later);
});

test('idle income accrued before clearing the next stage retains its old rate', () => {
  let now = 1_000_000;
  const raw = createProgression(now);
  raw.campaign.highestCleared = 1; raw.campaign.claimedStages = [1];
  const { engine } = host(raw, () => now);
  now += 60_000;
  engine.startBattle(2); finish(engine); engine.claimBattleReward();
  assert.equal(engine.getIdle().pending.coin, 8);
  now += 60_000;
  assert.equal(engine.getIdle().pending.coin, 18, 'One minute at stage 1 plus one minute at stage 2');
});

test('three offline hours before the first clear never fill the idle cap and income starts at the first reward claim', () => {
  let now = 1_000_000;
  const { engine } = host(undefined, () => now);
  now += 3 * 60 * 60 * 1000;
  assert.deepEqual(engine.getIdle().pending, { tickets: 0, legendTickets: 0, heroExp: 0, coin: 0, essence: 0 });
  assert.equal(engine.getIdle().seconds, 0);
  assert.equal(engine.getIdle().capped, false);
  assert.equal(engine.claimIdle().ok, false);
  // Also recover an old saved zero-income bank rather than requiring a reset.
  engine.state.idle.bankSeconds = 7200;
  engine.startBattle(1); finish(engine);
  assert.equal(engine.claimBattleReward().ok, true);
  assert.equal(engine.state.idle.lastAccruedAt, now);
  assert.equal(engine.getIdle().seconds, 0);
  assert.equal(engine.getIdle().canClaim, false);
  now += 60_000;
  const idle = engine.getIdle();
  assert.equal(idle.seconds, 60);
  assert.equal(idle.pending.coin, 8);
  assert.equal(idle.pending.heroExp, 20);
  const before = clone(engine.state.wallet);
  assert.equal(engine.claimIdle().ok, true);
  assert.equal(engine.state.wallet.coin, before.coin + 8);
  assert.equal(engine.state.wallet.heroExp, before.heroExp + 20);
  assert.equal(engine.claimIdle().ok, false);
});

test('real GameState preserves progression in the same version/key and future progress versions lock old raw data', () => {
  const storage = memoryStorage(); let now = 1_000_000;
  const game = new GameState({ storage, now: () => now, autoLoad: false });
  const engine = new ProgressState(game);
  engine.recruit('normal', 1); engine.upgradeHero('yilong');
  engine.startBattle(1); engine.advanceBattle(1);
  game.save();
  const restoredGame = new GameState({ storage, now: () => now });
  const restored = new ProgressState(restoredGame);
  assert.equal(restoredGame.state.version, 1);
  assert.equal(restored.state.heroes.yilong.level, 2);
  assert.equal(restored.state.wallet.tickets, 25);
  assert.equal(restored.state.recruitment.normalCount, 1);
  assert.deepEqual(restored.getRecruitCost(1), { tickets: 1 });
  assert.equal(restored.getBattle().time, 1);
  const raw = JSON.parse(storage.getItem('fkssj-save-v1'));
  raw.progression.version = 3;
  const future = JSON.stringify(raw); storage.setItem('fkssj-save-v1', future);
  const locked = new GameState({ storage, now: () => now });
  now += 6000; locked.tick(6); locked.collect('wood');
  assert.equal(locked.persistenceLocked, true);
  assert.equal(storage.getItem('fkssj-save-v1'), future);
});

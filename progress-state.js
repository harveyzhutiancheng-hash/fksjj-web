/**
 * 英雄的召唤、增益、群控定位参考发行方发布的玩家攻略；数值、范围、关卡与经济为本项目配置。
 * https://game.xiaomi.com/viewpoint/1672495402_1773974677374_13
 * https://test-game.xiaomi.com/viewpoint/1672495402_1768965996025_13
 * 本模块只修改 game.state.progression；其结构版本为 2，外层 GameState 的 key / version 1 不变。
 */
export const CONFIG_NOTE = '英雄机制参考发行方发布的攻略；招募分层、技能数值、关卡与培养经济均为本项目配置，非原作精确参数。';
const VERSION = 2;
const FORMATION_SIZE = 5;
const IDLE_CAP = 7200;
export const MAX_LEVEL = 50;
export const MAX_STARS = 6;
const WALLET_KEYS = ['tickets', 'legendTickets', 'heroExp', 'coin', 'essence'];
const clone = (value) => JSON.parse(JSON.stringify(value));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const bounded = (value, min, max, fallback = min) => Math.max(min, Math.min(max, number(value, fallback)));
const integer = (value, min, max, fallback = min) => Math.floor(bounded(value, min, max, fallback));
const emptyWallet = () => Object.fromEntries(WALLET_KEYS.map((key) => [key, 0]));
const timestamp = (value) => Math.max(0, number(value, Date.now()));
const roundedTime = (value) => Math.round(value * 1000) / 1000;
const knownHero = (id) => Object.hasOwn(HEROES, id);
const skill = (name, kind, description, cooldown = 7, power = 1.4) => ({ name, kind, description, cooldown, power });
const hero = (id, name, rarity, job, color, portrait, baseStats, ability, description) => ({ id, name, rarity, type: job, job, color, portrait, baseStats, skill: ability, description });

export const HEROES = Object.freeze({
  yilong: hero('yilong', '一龙', 'rare', 'ranger', '#dfad52', 0, { maxHp: 300, attack: 37, armor: 12, interval: 1.45 }, skill('破浪冲击', 'cleave', '普攻物理输出，大招对前方多名敌人造成能量伤害。', 6, 1.4), '群伤射手，用范围能量攻击打开阵线。'),
  lei: hero('lei', '雷教授', 'rare', 'mage', '#9c9bdb', 1, { maxHp: 215, attack: 43, armor: 5, interval: 1.8 }, skill('五重雷电', 'lightning', '连续释放五道雷电；召唤物也可能吸引雷电。', 8, 0.85), '爆发法师，五道雷电对目标造成连续伤害。'),
  loyal: hero('loyal', '李忠诚', 'common', 'ranger', '#70aaa1', 2, { maxHp: 370, attack: 25, armor: 20, interval: 1.85 }, skill('机器狗出击', 'summonDog', '召唤机器狗独立攻击、吸引火力，最多存在 15 秒。', 8, 0.7), '召唤射手，让机器狗攻击敌人并承担伤害。'),
  mechanic: hero('mechanic', '机修萝莉', 'rare', 'mage', '#e8a390', 3, { maxHp: 235, attack: 30, armor: 9, interval: 1.7 }, skill('机器人支援', 'summonBot', '召唤机器人协同承伤与攻击，最多存在 15 秒。', 9, 0.55), '召唤法师，以独立机器人为队伍争取输出空间。'),
  sam: hero('sam', '大嘴山姆', 'legendary', 'tank', '#d18a5c', 4, { maxHp: 440, attack: 35, armor: 24, interval: 1.8 }, skill('铁壁咆哮', 'smash', '获得护盾、吸引攻击，并打击前排两名敌人。', 8, 1.1), '传说前排，吸收伤害并维持阵线。'),
  rambo: hero('rambo', '兰博', 'legendary', 'ranger', '#76aa78', 5, { maxHp: 280, attack: 49, armor: 10, interval: 1.25 }, skill('火力覆盖', 'barrage', '对最多四名敌人发动连续火力。', 7, 0.95), '传说射手，快速清理多名敌人。'),
  wizard: hero('wizard', '巫师老侃', 'legendary', 'mage', '#a48fbd', 6, { maxHp: 250, attack: 35, armor: 7, interval: 1.9 }, skill('狂热鼓舞', 'buff', '为两名伙伴提升攻速和暴击率，并赋予护盾。', 8, 2.1), '辅助法师，用攻速、暴击增益和护盾保护输出核心。'),
  mia: hero('mia', '米娅', 'legendary', 'mage', '#80bccc', 7, { maxHp: 300, attack: 39, armor: 13, interval: 1.55 }, skill('海风禁锢', 'massControl', '对最多五名敌人造成伤害并施加群体控制。', 8, 1.2), '第 40 关救援获得的群控辅助，限制敌人的行动。'),
});

function seeded(seed) {
  let state = Number(seed) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

function statsFor(record) {
  const definition = HEROES[record.id];
  const scale = (1 + (record.level - 1) * 0.12) * (1 + (record.stars - 1) * 0.2);
  return { maxHp: Math.round(definition.baseStats.maxHp * scale), attack: Math.round(definition.baseStats.attack * scale), armor: Math.round(definition.baseStats.armor + (record.level - 1) * 1.1 + (record.stars - 1) * 4), interval: definition.baseStats.interval };
}

function enemyFor(stage, slot, boss) {
  const front = slot < 3;
  const names = front ? ['漂流劫掠者', '锈甲守卫', '狂浪打手'] : ['礁石投手', '废船炮手', '深海术士'];
  const bossUnit = boss && slot === 0;
  const maxHp = Math.round((135 + stage * 19) * (bossUnit ? 1.8 : 1));
  return { id: `enemy-${stage}-${slot}`, name: bossUnit ? `风暴首领 · ${stage}` : names[slot % 3], job: bossUnit || front ? 'tank' : slot === 5 ? 'mage' : 'ranger', slot, maxHp, hp: maxHp, shield: 0, attack: Math.round((14 + stage * 3.2) * (bossUnit ? 1.25 : 1)), armor: Math.round(stage * 0.65), interval: 1.75 - Math.min(stage * 0.006, 0.2), color: bossUnit ? '#c67570' : '#8496a0', portrait: slot % 3, skill: bossUnit ? skill('浪潮重击', 'cleave', '攻击前排两名目标。', 8, 1.1) : skill('普通攻击', 'none', '依次攻击前方伙伴。', 99, 1) };
}

export const STAGES = Object.freeze(Array.from({ length: 40 }, (_, index) => {
  const id = index + 1;
  const zone = ['漂流近海', '沉没街区', '锈港航道', '风暴救援'][Math.floor(index / 10)];
  const boss = id % 5 === 0;
  const count = id < 5 ? 2 : id < 10 ? 3 : id < 20 ? 4 : id < 30 ? 5 : 6;
  const slots = [0, 1, 3, 4, 2, 5].slice(0, count);
  return { id, name: id === 40 ? '第 40 关 · 救援米娅' : `第 ${id} 关 · ${boss ? '首领拦截' : zone}`, zone, description: id === 40 ? '击退救生艇附近的敌人，首次通关领奖后米娅加入。' : boss ? '强敌守住航道，注意前排承伤、召唤掩护与输出增益。' : '消灭航道敌人，推进救援路线并提高挂机收益。', boss, miaRescue: id === 40, enemies: slots.map((slot) => enemyFor(id, slot, boss)), rewards: { coin: 60 + id * 12, heroExp: 90 + id * 24, essence: 2 + Math.floor(id / 5), tickets: (id % 2 === 0 ? 2 : 1) + (boss ? 1 : 0), legendTickets: 0 } };
}));

function cleanUnit(raw, side, index) {
  const maxHp = integer(raw.maxHp, 1, 1000000, 100);
  return { id: String(raw.id || `${side}-${index}`), name: String(raw.name || '海上伙伴'), heroId: raw.heroId || null, job: String(raw.job || 'warrior'), slot: integer(raw.slot, 0, 5, index % 6), maxHp, hp: maxHp, shield: 0, attack: integer(raw.attack, 1, 100000, 20), armor: integer(raw.armor, 0, 100000, 0), interval: bounded(raw.interval, 0.5, 5, 1.5), color: raw.color || '#82a5ac', portrait: integer(raw.portrait, 0, 7, 0), skill: { name: String(raw.skill?.name || '普通攻击'), description: String(raw.skill?.description || ''), kind: ['none', 'cleave', 'chain', 'guard', 'heal', 'smash', 'barrage', 'curse', 'allheal', 'summonDog', 'summonBot', 'buff', 'lightning', 'massControl'].includes(raw.skill?.kind) ? raw.skill.kind : 'none', cooldown: bounded(raw.skill?.cooldown, 2, 99, 7), power: bounded(raw.skill?.power, 0.1, 6, 1.3) } };
}

/** Deterministic individual turns, targeting, summons, shields, buffs and control. */
export function simulateBattle(allies, enemies, options = {}) {
  if (!Array.isArray(allies) || !allies.length || !Array.isArray(enemies) || !enemies.length || allies.length > 5 || enemies.length > 6) throw new Error('战斗需要 1–5 位伙伴和 1–6 名敌人。');
  const initialAllies = allies.map((unit, index) => cleanUnit(unit, 'ally', index));
  const initialEnemies = enemies.map((unit, index) => cleanUnit(unit, 'enemy', index));
  const ids = [...initialAllies, ...initialEnemies].map((unit) => unit.id);
  if (new Set(ids).size !== ids.length) throw new Error('战斗单位 id 不可重复。');
  const random = seeded(options.seed ?? 1);
  const maxDuration = bounded(options.maxDuration, 10, 90, 75);
  const units = [...initialAllies.map((unit) => ({ ...clone(unit), side: 'ally' })), ...initialEnemies.map((unit) => ({ ...clone(unit), side: 'enemy' }))].map((unit) => ({ ...unit, nextAttack: 0.65 + unit.slot * 0.08, nextSkill: 3.5 + unit.slot * 0.15, stunnedUntil: 0, tauntUntil: 0, speedMultiplier: 1, critBonus: 0, buffUntil: 0 }));
  const events = [], dots = [];
  let time = 0, summonCount = 0;
  const alive = (side) => units.filter((unit) => unit.side === side && unit.hp > 0);
  const opponents = (unit) => alive(unit.side === 'ally' ? 'enemy' : 'ally');
  const orderedTargets = (unit) => opponents(unit).sort((a, b) => (b.tauntUntil > time ? 1 : 0) - (a.tauntUntil > time ? 1 : 0) || Math.floor(a.slot / 3) - Math.floor(b.slot / 3) || Math.abs(a.slot % 3 - unit.slot % 3) - Math.abs(b.slot % 3 - unit.slot % 3) || a.slot - b.slot);
  const emit = (event) => events.push({ at: roundedTime(time), ...event });
  const damage = (actor, target, power, label, critical = false) => {
    if (!target || target.hp <= 0) return;
    const raw = Math.max(1, Math.round(actor.attack * power * (critical ? 1.5 : 1) * 70 / (70 + target.armor)));
    const absorbed = Math.min(target.shield, raw);
    target.shield -= absorbed;
    const actual = Math.min(target.hp, raw - absorbed);
    target.hp -= actual;
    emit({ type: 'damage', actorId: actor.id, targetId: target.id, amount: actual, absorbed, hpAfter: target.hp, shieldAfter: target.shield, label: critical ? '暴击' : label });
    if (!target.hp) emit({ type: 'defeat', actorId: actor.id, targetId: target.id, hpAfter: 0, shieldAfter: target.shield });
  };
  const shield = (actor, target, amount, label) => { if (!target) return; const added = Math.round(amount); target.shield += added; emit({ type: 'shield', actorId: actor.id, targetId: target.id, amount: added, hpAfter: target.hp, shieldAfter: target.shield, label }); };
  const heal = (actor, target, amount, label) => { if (!target) return; const actual = Math.min(target.maxHp - target.hp, Math.round(amount)); target.hp += actual; emit({ type: 'heal', actorId: actor.id, targetId: target.id, amount: actual, hpAfter: target.hp, shieldAfter: target.shield, label }); };
  const weakest = (side) => alive(side).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.slot - b.slot)[0];
  const summon = (actor, kind) => {
    const dog = kind === 'summonDog';
    const definition = cleanUnit({ id: `${actor.id}-summon-${++summonCount}`, name: dog ? '机器狗' : '支援机器人', job: 'tank', slot: actor.slot % 3, maxHp: actor.maxHp * (dog ? 0.7 : 1.1), attack: actor.attack * actor.skill.power, armor: actor.armor + (dog ? 5 : 12), interval: dog ? 1.25 : 1.9, color: dog ? '#78aaa0' : '#dca18c', skill: { kind: 'none' } }, actor.side, 0);
    Object.assign(definition, { summon: true, ownerId: actor.id, kind: dog ? 'dog' : 'robot', summonKind: kind, lifetime: 15 });
    const expiresAt = roundedTime(time + 15);
    units.push({ ...clone(definition), side: actor.side, nextAttack: time + 0.5, nextSkill: Infinity, stunnedUntil: 0, tauntUntil: expiresAt, expiresAt, speedMultiplier: 1, critBonus: 0, buffUntil: 0 });
    emit({ type: 'spawn', actorId: actor.id, ownerId: actor.id, side: actor.side === 'ally' ? 'allies' : 'enemies', unit: definition, duration: 15, label: definition.name });
  };
  const buff = (actor, target) => {
    const oldSpeed = target.speedMultiplier;
    target.speedMultiplier = 1.65; target.critBonus = 0.25; target.buffUntil = time + 5;
    target.nextAttack = time + Math.max(0, target.nextAttack - time) * oldSpeed / target.speedMultiplier;
    emit({ type: 'buff', actorId: actor.id, targetId: target.id, label: actor.skill.name, duration: 5, speedMultiplier: target.speedMultiplier, critBonus: target.critBonus });
    shield(actor, target, actor.attack * actor.skill.power, actor.skill.name);
  };
  while (time <= maxDuration + 1e-7 && alive('ally').length && alive('enemy').length) {
    for (const unit of units) {
      if (unit.hp > 0 && unit.expiresAt <= time) { unit.hp = 0; unit.shield = 0; emit({ type: 'defeat', targetId: unit.id, hpAfter: 0, shieldAfter: 0, reason: 'expired', label: '召唤结束' }); }
      if (unit.buffUntil > 0 && unit.buffUntil <= time) { unit.nextAttack = time + Math.max(0, unit.nextAttack - time) * unit.speedMultiplier; unit.speedMultiplier = 1; unit.critBonus = 0; unit.buffUntil = 0; }
    }
    for (let index = dots.length - 1; index >= 0; index--) {
      const dot = dots[index];
      if (dot.at <= time + 1e-7) { damage(dot.actor, dot.target, dot.power, '诅咒'); dots.splice(index, 1); }
    }
    for (const actor of [...units].sort((a, b) => a.nextAttack - b.nextAttack || a.slot - b.slot || a.id.localeCompare(b.id))) {
      if (!actor.hp || actor.stunnedUntil > time || !opponents(actor).length) continue;
      const ability = actor.skill;
      if (ability.kind !== 'none' && actor.nextSkill <= time + 1e-7) {
        const targets = orderedTargets(actor);
        emit({ type: 'skill', actorId: actor.id, targetId: targets[0]?.id, label: ability.name, duration: 0.6 });
        if (ability.kind === 'summonDog' || ability.kind === 'summonBot') summon(actor, ability.kind);
        else if (ability.kind === 'buff') for (const target of alive(actor.side).filter((unit) => !unit.summon).sort((a, b) => b.attack - a.attack || a.slot - b.slot).slice(0, 2)) buff(actor, target);
        else if (ability.kind === 'lightning') for (let bolt = 0; bolt < 5; bolt++) {
          const remaining = orderedTargets(actor), taunting = remaining.filter((unit) => unit.tauntUntil > time), candidates = taunting.length ? taunting : remaining;
          if (!candidates.length) break;
          const target = candidates[Math.floor(random() * candidates.length)];
          emit({ type: 'attack', actorId: actor.id, targetId: target.id, label: `雷电 ${bolt + 1}/5`, duration: 0.12 });
          damage(actor, target, ability.power, '雷电');
        }
        else if (ability.kind === 'massControl') for (const target of targets.slice(0, 5)) { damage(actor, target, ability.power, ability.name); if (target.hp > 0) { target.stunnedUntil = time + 1.5; emit({ type: 'buff', actorId: actor.id, targetId: target.id, label: '禁锢', duration: 1.5, stunned: true }); } }
        else if (ability.kind === 'guard') shield(actor, weakest(actor.side), actor.attack * ability.power, ability.name);
        else if (ability.kind === 'heal') heal(actor, weakest(actor.side), actor.attack * ability.power, ability.name);
        else if (ability.kind === 'allheal') for (const target of alive(actor.side)) { heal(actor, target, actor.attack * ability.power, ability.name); shield(actor, target, actor.attack * 0.65, ability.name); }
        else if (ability.kind === 'smash') { shield(actor, actor, actor.maxHp * 0.2, ability.name); actor.tauntUntil = time + 3; for (const target of targets.slice(0, 2)) damage(actor, target, ability.power, ability.name); }
        else if (ability.kind === 'curse') { damage(actor, targets[0], ability.power * 0.5, ability.name); for (let tick = 1; tick <= 3; tick++) dots.push({ actor, target: targets[0], power: ability.power, at: time + tick }); }
        else for (const target of targets.slice(0, ability.kind === 'barrage' ? 4 : ability.kind === 'chain' ? 3 : 2)) { damage(actor, target, ability.power, ability.name); if (ability.kind === 'chain' && target.hp > 0) target.stunnedUntil = time + 0.75; }
        actor.nextSkill = time + ability.cooldown;
        actor.nextAttack = Math.max(actor.nextAttack, time + 0.35);
      } else if (actor.nextAttack <= time + 1e-7) {
        const target = orderedTargets(actor)[0];
        emit({ type: 'attack', actorId: actor.id, targetId: target.id, duration: 0.35 });
        damage(actor, target, 1, '攻击', random() < 0.1 + actor.critBonus);
        actor.nextAttack = time + actor.interval / actor.speedMultiplier;
      }
    }
    if (!alive('ally').length || !alive('enemy').length) break;
    time = roundedTime(time + 0.25);
  }
  const result = alive('ally').length > 0 && alive('enemy').length === 0 ? 'victory' : 'defeat';
  const duration = Math.max(0.25, Math.min(maxDuration, time));
  return { allies: initialAllies, enemies: initialEnemies, events, duration, result, seed: Number(options.seed ?? 1) >>> 0 };
}

export function createProgression(nowMs = Date.now()) {
  const now = timestamp(nowMs);
  const heroes = Object.fromEntries(['loyal', 'yilong', 'lei', 'mechanic'].map((id) => [id, { id, level: 1, stars: 1, shards: 0 }]));
  return { version: VERSION, wallet: { tickets: 25, legendTickets: 0, heroExp: 600, coin: 240, essence: 20 }, heroes, formation: ['loyal', 'yilong', null, 'lei', 'mechanic'], recruitment: { normalCount: 0, legendCount: 0, pity: 0, seed: (Math.floor(now) ^ 0x9e3779b9) >>> 0, history: [] }, campaign: { highestCleared: 0, claimedStages: [], miaRescued: false }, battle: null, idle: { lastAccruedAt: now, bankSeconds: 0, pending: emptyWallet() }, battleCounter: 0 };
}

export function normalizeProgression(raw, nowMs = Date.now()) {
  const state = createProgression(nowMs);
  if (raw === undefined || raw === null) return state;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('英雄进度存档格式不完整，已保留原存档。');
  const sourceVersion = number(raw.version, 1);
  if (sourceVersion > VERSION) throw new Error('英雄进度来自更新版本，暂不能读取，已保留原存档。');
  // Preserve even a capped v1 balance plus the largest possible one-time refund.
  const maxLegacyRefund = Object.keys(HEROES).length * 8 * MAX_LEVEL * (MAX_LEVEL - 1) / 2;
  for (const key of WALLET_KEYS) state.wallet[key] = integer(raw.wallet?.[key], 0, key === 'tickets' && sourceVersion >= 2 ? 2000000000 : 1000000000 + (key === 'coin' && sourceVersion >= 2 ? maxLegacyRefund : 0), state.wallet[key]);
  // Folding any legacy balance into tickets is naturally idempotent, including
  // v2 saves made during development before the single-pool transition.
  state.wallet.tickets += state.wallet.legendTickets; state.wallet.legendTickets = 0;
  const records = raw.heroes && typeof raw.heroes === 'object' ? raw.heroes : state.heroes;
  state.heroes = {};
  for (const [id, value] of Object.entries(records)) if (knownHero(id) && value && typeof value === 'object') state.heroes[id] = { id, level: integer(value.level, 1, MAX_LEVEL, 1), stars: integer(value.stars, 1, MAX_STARS, 1), shards: integer(value.shards, 0, 1000000, 0) };
  if (!Object.keys(state.heroes).length) state.heroes = createProgression(nowMs).heroes;
  if (sourceVersion < 2) state.wallet.coin += Object.values(state.heroes).reduce((sum, record) => sum + 8 * record.level * (record.level - 1) / 2, 0);
  const used = new Set();
  const savedSlots = Array.isArray(raw.formation) ? raw.formation : state.formation;
  state.formation = Array.from({ length: FORMATION_SIZE }, (_, index) => {
    const id = savedSlots[index];
    if (!Object.hasOwn(state.heroes, id) || used.has(id) || used.size >= 5) return null;
    used.add(id); return id;
  });
  const displaced = savedSlots[5], vacant = state.formation.indexOf(null);
  if (sourceVersion < 2 && vacant >= 0 && Object.hasOwn(state.heroes, displaced) && !used.has(displaced)) { state.formation[vacant] = displaced; used.add(displaced); }
  if (!used.size) Object.keys(state.heroes).slice(0, 5).forEach((id, index) => { state.formation[index] = id; });
  for (const key of ['normalCount', 'legendCount']) state.recruitment[key] = integer(raw.recruitment?.[key], 0, 1000000000, 0);
  state.recruitment.pity = integer(raw.recruitment?.pity, 0, 49, 0);
  state.recruitment.seed = number(raw.recruitment?.seed, state.recruitment.seed) >>> 0;
  state.recruitment.history = Array.isArray(raw.recruitment?.history) ? raw.recruitment.history.filter((item) => item && knownHero(item.heroId)).slice(-20).map((item) => ({ heroId: item.heroId, pool: item.pool === 'legend' ? 'legend' : 'normal', duplicate: item.duplicate === true, shards: integer(item.shards, 0, 20, 0) })) : [];
  state.campaign.claimedStages = [...new Set((Array.isArray(raw.campaign?.claimedStages) ? raw.campaign.claimedStages : []).filter((id) => Number.isInteger(id) && id >= 1 && id <= 40))].sort((a, b) => a - b);
  state.campaign.highestCleared = Math.max(integer(raw.campaign?.highestCleared, 0, 40, 0), ...state.campaign.claimedStages, 0);
  state.campaign.miaRescued = raw.campaign?.miaRescued === true || state.campaign.claimedStages.includes(40);
  if (state.campaign.miaRescued && !state.heroes.mia) state.heroes.mia = { id: 'mia', level: 1, stars: 1, shards: 0 };
  state.battleCounter = integer(raw.battleCounter, 0, 1000000000, 0);
  state.idle.lastAccruedAt = Math.max(0, number(raw.idle?.lastAccruedAt, timestamp(nowMs)));
  state.idle.bankSeconds = bounded(raw.idle?.bankSeconds, 0, IDLE_CAP, 0);
  for (const key of WALLET_KEYS) state.idle.pending[key] = bounded(raw.idle?.pending?.[key], 0, key === 'tickets' ? 2000000 : 1000000, 0);
  state.idle.pending.tickets += state.idle.pending.legendTickets; state.idle.pending.legendTickets = 0;
  if (raw.battle && typeof raw.battle === 'object') {
    const battle = raw.battle;
    if (Number.isInteger(battle.stage) && battle.stage >= 1 && battle.stage <= 40 && Array.isArray(battle.allies) && Array.isArray(battle.enemies)) {
      // Saved combat snapshots keep their original 0..5 slots. The five-position
      // roster migration must not change targets, events or a running result.
      const simulated = simulateBattle(battle.allies, battle.enemies, { seed: number(battle.seed, battle.stage), maxDuration: 75 });
      const time = bounded(battle.time, 0, simulated.duration, 0);
      const claimed = battle.claimed === true && state.campaign.claimedStages.includes(battle.stage);
      state.battle = { id: String(battle.id || `battle-${state.battleCounter}`), stage: battle.stage, ...simulated, time, phase: claimed ? 'claimed' : time >= simulated.duration ? 'finished' : 'playing', claimed };
    }
  }
  return state;
}

function idleRate(stage) { return stage > 0 ? { coin: 6 + stage * 2, heroExp: 15 + stage * 5, essence: 1 + Math.floor(stage / 10), tickets: 0.06, legendTickets: 0 } : emptyWallet(); }

export class ProgressState {
  constructor(game, options = {}) {
    if (!game?.state) throw new Error('ProgressState 需要已有 GameState。');
    this.game = game;
    this.now = typeof options.now === 'function' ? options.now : typeof game.now === 'function' ? () => game.now() : Date.now;
    game.state.progression = normalizeProgression(game.state.progression, this.now());
  }

  get state() { if (!this.game.state.progression) this.game.state.progression = createProgression(this.now()); return this.game.state.progression; }
  _changed(action, detail = {}, forceSave = true) { this.game._changed?.('progression', { action, ...detail }, forceSave); }
  _canAfford(cost) { return Object.entries(cost).every(([key, value]) => this.state.wallet[key] + 1e-7 >= value); }
  _spend(cost) { for (const [key, value] of Object.entries(cost)) this.state.wallet[key] -= value; }
  _add(reward) { for (const key of WALLET_KEYS) if (reward[key]) this.state.wallet[key === 'legendTickets' ? 'tickets' : key] += reward[key]; }

  getHero(id) {
    const definition = knownHero(id) ? HEROES[id] : null; if (!definition) return null;
    const record = knownHero(id) ? this.state.heroes[id] : null;
    return { ...clone(definition), owned: Boolean(record), level: record?.level || 0, stars: record?.stars || 0, shards: record?.shards || 0, stats: record ? statsFor(record) : clone(definition.baseStats), upgradeCost: this.getUpgradeCost(id), starCost: this.getStarCost(id) };
  }
  getHeroes() { return Object.keys(HEROES).map((id) => this.getHero(id)); }
  getUpgradeCost(id, levels = 1) {
    const record = knownHero(id) ? this.state.heroes[id] : null;
    if (!record || !Number.isInteger(levels) || levels < 1 || record.level + levels > MAX_LEVEL) return null;
    let heroExp = 0;
    for (let level = record.level; level < record.level + levels; level++) heroExp += level * 20;
    return { heroExp };
  }
  upgradeHero(id, levels = 1) {
    const cost = this.getUpgradeCost(id, levels);
    if (!cost) return { ok: false, message: '请选择已拥有且可升级的伙伴，最高 50 级。' };
    if (!this._canAfford(cost)) return { ok: false, cost, message: '英雄经验不足。' };
    this._spend(cost); this.state.heroes[id].level += levels;
    this._changed('heroUpgrade', { heroId: id });
    return { ok: true, cost, hero: this.getHero(id), message: `${HEROES[id].name}升至 ${this.state.heroes[id].level} 级。` };
  }
  getStarCost(id) { const record = knownHero(id) ? this.state.heroes[id] : null; return record && record.stars < MAX_STARS ? { shards: 12 * record.stars, essence: 10 * record.stars, coin: 60 * record.stars } : null; }
  starUpHero(id) {
    const record = this.state.heroes[id], cost = this.getStarCost(id);
    if (!record || !cost) return { ok: false, message: '请选择可升星的伙伴，最高 6 星。' };
    if (record.shards < cost.shards || !this._canAfford({ essence: cost.essence, coin: cost.coin })) return { ok: false, cost, message: '同名碎片、精粹或培养金币不足。' };
    record.shards -= cost.shards; this._spend({ essence: cost.essence, coin: cost.coin }); record.stars += 1;
    this._changed('heroStar', { heroId: id });
    return { ok: true, cost, hero: this.getHero(id), message: `${HEROES[id].name}升至 ${record.stars} 星。` };
  }

  getRecruitCost(count = 1) {
    if (![1, 10].includes(count)) return null;
    const first = this.state.recruitment.normalCount + this.state.recruitment.legendCount === 0;
    return { tickets: first && count === 1 ? 0 : count };
  }

  recruit(pool = 'normal', count = 1) {
    if (!['normal', 'legend'].includes(pool) || ![1, 10].includes(count)) return { ok: false, message: '请选择英雄招募与单次/十次招募。' };
    // 'legend' remains an API alias for old callers, never a separate pool.
    const cost = this.getRecruitCost(count), freeFirst = cost.tickets === 0;
    if (!this._canAfford(cost)) return { ok: false, cost, message: '游戏内招募券不足，可通过闯关或挂机继续获得。' };
    this._spend(cost);
    const state = this.state, results = [];
    const next = () => { state.recruitment.seed = (Math.imul(state.recruitment.seed, 1664525) + 1013904223) >>> 0; return state.recruitment.seed / 4294967296; };
    for (let index = 0; index < count; index++) {
      const forcedLegend = state.recruitment.pity >= 49;
      const roll = next();
      const rarity = forcedLegend || roll < 0.04 ? 'legendary' : roll < 0.6 ? 'rare' : 'common';
      const candidates = Object.values(HEROES).filter((item) => item.rarity === rarity && item.id !== 'mia');
      const definition = candidates[Math.floor(next() * candidates.length)];
      const duplicate = Boolean(state.heroes[definition.id]);
      const shards = duplicate ? rarity === 'legendary' ? 20 : rarity === 'rare' ? 8 : 4 : 0;
      if (duplicate) state.heroes[definition.id].shards += shards;
      else state.heroes[definition.id] = { id: definition.id, level: 1, stars: 1, shards: 0 };
      state.recruitment.normalCount++;
      state.recruitment.pity = rarity === 'legendary' ? 0 : state.recruitment.pity + 1;
      results.push({ heroId: definition.id, name: definition.name, rarity, duplicate, shards, forcedLegend });
      state.recruitment.history.push({ heroId: definition.id, pool: 'normal', duplicate, shards });
    }
    state.recruitment.history = state.recruitment.history.slice(-20);
    this._changed('recruit', { results });
    return { ok: true, results, cost, freeFirst, pity: state.recruitment.pity, message: `${freeFirst ? '首次单抽免费，' : ''}招募了 ${count} 位伙伴${results.some((result) => result.duplicate) ? '，重复伙伴已转为同名碎片' : ''}。` };
  }

  setFormation(slots) {
    if (!Array.isArray(slots) || slots.length !== FORMATION_SIZE) return { ok: false, message: '基础阵型需要 5 个位置。' };
    const ids = slots.filter((id) => id !== null);
    if (!ids.length || ids.length > 5 || new Set(ids).size !== ids.length || ids.some((id) => !Object.hasOwn(this.state.heroes, id))) return { ok: false, message: '请安排 1–5 位已拥有且不重复的伙伴。' };
    this.state.formation = [...slots]; this._changed('formation');
    return { ok: true, formation: [...slots], message: '阵容已调整。' };
  }
  assignSlot(heroId, index) {
    if (!Number.isInteger(index) || index < 0 || index >= FORMATION_SIZE || heroId !== null && !Object.hasOwn(this.state.heroes, heroId)) return { ok: false, message: '请选择有效伙伴和阵容位置。' };
    const slots = [...this.state.formation], previous = slots.indexOf(heroId), replaced = slots[index];
    if (heroId !== null && previous >= 0) slots[previous] = replaced;
    slots[index] = heroId;
    return this.setFormation(slots);
  }

  getStage(id) { const stageId = id ?? Math.min(40, this.state.campaign.highestCleared + 1); const definition = STAGES.find((stage) => stage.id === stageId); return definition ? { ...clone(definition), unlocked: stageId <= this.state.campaign.highestCleared + 1, cleared: this.state.campaign.claimedStages.includes(stageId) } : null; }
  getStages() { return STAGES.map((stage) => this.getStage(stage.id)); }
  startBattle(stageId = Math.min(40, this.state.campaign.highestCleared + 1)) {
    const stage = this.getStage(stageId), current = this.state.battle;
    if (!stage?.unlocked) return { ok: false, message: '请先通关前一关，再挑战这片海域。' };
    if (current?.phase === 'playing' || current?.phase === 'finished' && current.result === 'victory' && !current.claimed) return { ok: false, message: current.phase === 'playing' ? '当前战斗还没有结束。' : '先领取当前战斗的通关奖励。' };
    const allies = this.state.formation.flatMap((id, slot) => { const record = this.state.heroes[id]; return record ? [{ id: `ally-${id}`, heroId: id, name: HEROES[id].name, job: HEROES[id].job, slot, ...statsFor(record), color: HEROES[id].color, portrait: HEROES[id].portrait, skill: clone(HEROES[id].skill) }] : []; });
    if (!allies.length) return { ok: false, message: '请先安排至少一位伙伴上阵。' };
    const seed = stage.id * 7919;
    const battle = { id: `battle-${++this.state.battleCounter}`, stage: stage.id, ...simulateBattle(allies, stage.enemies, { seed }), time: 0, phase: 'playing', claimed: false };
    this.state.battle = battle; this._changed('battleStart', { battleId: battle.id });
    return { ok: true, battle: this.getBattle(), message: `进入${stage.name}。` };
  }
  getBattle() { return this.state.battle ? clone(this.state.battle) : null; }
  advanceBattle(dt) {
    const battle = this.state.battle;
    if (!battle || battle.phase !== 'playing') return { ok: false, message: '当前没有进行中的战斗。', events: [] };
    const seconds = bounded(dt, 0, 90, 0);
    if (!seconds) return { ok: true, time: battle.time, phase: battle.phase, events: [], message: '' };
    const before = battle.time; battle.time = Math.min(battle.duration, roundedTime(battle.time + seconds));
    const finished = battle.time >= battle.duration;
    if (finished) battle.phase = 'finished';
    const events = battle.events.filter((event) => event.at > before && event.at <= battle.time);
    this._changed(finished ? 'battleFinish' : 'battleTick', { battleId: battle.id }, finished);
    return { ok: true, time: battle.time, phase: battle.phase, finished, result: finished ? battle.result : null, events: clone(events), message: finished ? battle.result === 'victory' ? '航道清理成功，领取通关奖励吧。' : '这次未能突破，调整阵容和养成后再试。' : '' };
  }
  skipBattle() {
    const battle = this.state.battle;
    if (!battle || battle.phase !== 'playing') return { ok: false, message: '当前没有可跳过的战斗。' };
    if (battle.time < 10) return { ok: false, secondsRemaining: Math.ceil(10 - battle.time), message: '战斗进行满 10 秒后可以跳到结算。' };
    const result = this.advanceBattle(battle.duration - battle.time);
    return { ...result, skipped: result.ok };
  }
  claimBattleReward() {
    const state = this.state, battle = state.battle;
    if (!battle || battle.phase === 'playing') return { ok: false, message: '战斗还没有结束。' };
    if (battle.claimed) return { ok: false, message: '这场战斗已经结算过了。' };
    if (battle.result !== 'victory') return { ok: false, message: '本次未能通关，没有首次奖励。' };
    this._settleIdle();
    const firstClear = !state.campaign.claimedStages.includes(battle.stage);
    const rewards = firstClear ? clone(STAGES[battle.stage - 1].rewards) : emptyWallet();
    if (firstClear) { this._add(rewards); state.campaign.claimedStages.push(battle.stage); state.campaign.claimedStages.sort((a, b) => a - b); state.campaign.highestCleared = Math.max(state.campaign.highestCleared, battle.stage); }
    let rescuedHero = null;
    if (firstClear && battle.stage === 40 && !state.campaign.miaRescued) { state.campaign.miaRescued = true; if (state.heroes.mia) state.heroes.mia.shards += 20; else state.heroes.mia = { id: 'mia', level: 1, stars: 1, shards: 0 }; rescuedHero = 'mia'; }
    battle.claimed = true; battle.phase = 'claimed';
    this._changed('battleReward', { battleId: battle.id, firstClear, rescuedHero });
    return { ok: true, firstClear, rewards, reward: rewards, rescuedHero, highestCleared: state.campaign.highestCleared, message: rescuedHero ? '第 40 关救援成功，米娅加入队伍！' : firstClear ? '首次通关奖励已领取，挂机收益提高了。' : '已回顾这场战斗；首次通关奖励不会重复发放。' };
  }

  _idlePreview() {
    const state = this.state, now = timestamp(this.now()), rate = idleRate(state.campaign.highestCleared);
    const elapsed = Math.max(0, (now - state.idle.lastAccruedAt) / 1000);
    const productive = Object.values(rate).some((amount) => amount > 0);
    // Unlocked income starts at the first-clear claim time; waiting before then
    // must not fill the two-hour bank, including a stale zero-income saved bank.
    const seconds = productive ? Math.min(elapsed, Math.max(0, IDLE_CAP - state.idle.bankSeconds)) : 0;
    const pending = Object.fromEntries(WALLET_KEYS.map((key) => [key, state.idle.pending[key] + rate[key] * seconds / 60]));
    return { now, seconds, elapsed, pending, perMinute: rate, bankSeconds: productive ? state.idle.bankSeconds + seconds : 0 };
  }
  _settleIdle() {
    const preview = this._idlePreview();
    this.state.idle.lastAccruedAt = Math.max(this.state.idle.lastAccruedAt, preview.now);
    this.state.idle.bankSeconds = preview.bankSeconds; this.state.idle.pending = preview.pending;
    return preview;
  }
  getIdle() {
    const preview = this._idlePreview(), pending = Object.fromEntries(WALLET_KEYS.map((key) => [key, Math.floor(preview.pending[key] + 1e-7)]));
    return { pending, seconds: Math.floor(preview.bankSeconds), capSeconds: IDLE_CAP, perMinute: clone(preview.perMinute), capped: preview.bankSeconds >= IDLE_CAP, canClaim: Object.values(pending).some((amount) => amount > 0) };
  }
  claimIdle() {
    const status = this.getIdle();
    if (!status.canClaim) return { ok: false, message: '挂机物资还在积累，稍后再来领取。' };
    this._settleIdle(); this._add(status.pending);
    for (const key of WALLET_KEYS) this.state.idle.pending[key] = Math.max(0, this.state.idle.pending[key] - status.pending[key]);
    this.state.idle.bankSeconds = 0;
    this._changed('idleClaim', { rewards: status.pending });
    return { ok: true, rewards: status.pending, reward: status.pending, seconds: status.seconds, message: '挂机物资已收进培养仓库。' };
  }
}

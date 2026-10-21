/**
 * Recorded story checkpoints, bridged after the retained fourteen-step opening.
 * Old construction quests remain a separate journal with their original IDs.
 * Two shared rewards use the same claim ledger from either entry point.
 */
import { CONTINUATION_QUESTS } from './production-state.js';

const sourceAt = (seconds) => `https://www.bilibili.com/video/BV1Vt9MByEP8/?t=${seconds}`;
const legacy = (id) => CONTINUATION_QUESTS.find((quest) => quest.id === id);
const recordedNote = '参考公开视频；该录像渠道未独立证实为抖音。原14步后接入为项目兼容方案，并非声称原作完整连续任务。';
export const STORY_QUESTS = Object.freeze([
  { id: 'plastic-reserve', title: '储备40份塑料', description: '拾荒带回塑料，让仓库储备达到40份。', metric: 'stock:plastic', target: 40, cost: {}, reward: { experience: 25, fish: 40 }, action: { type: 'scavenge' }, source: sourceAt(626), note: '40份塑料及25经验、40鲜鱼奖励参考626秒任务画面；按当前仓库存量判断储备，不额外扣除塑料。' },
  { id: 'small-residence', title: '为居民准备一个家', description: '拥有一座居民睡铺，安置海上的伙伴。', metric: 'build:bed', target: 1, cost: {}, reward: {}, action: { type: 'build', buildingType: 'bed' }, source: 'https://www.bilibili.com/video/BV1Vt9MByEP8/', note: '原作目标为小型民居；本项目沿用既有bed居民睡铺映射，不声称模型、成本或奖励完全一致。已有睡铺可计入。' },
  { id: 'seafood-kitchen-built', title: '建造海产厨房', description: '建造1座海产厨房，准备为居民烹饪。', metric: 'build:seafoodKitchen', target: 1, cost: {}, reward: legacy('seafood-kitchen-built').reward, legacyId: 'seafood-kitchen-built', action: { type: 'build', buildingType: 'seafoodKitchen' }, source: sourceAt(650), note: '建造1座海产厨房参考650秒任务；建设费用和兼容接入位置另有项目配置，未知任务奖励保持为空。' },
  { id: 'collector-grilled-fish', title: '收藏家想吃一条烤鱼', description: '交付1条烤鱼，获得40领袖经验与75金币。', metric: 'deliver', target: 1, cost: legacy('collector-grilled-fish').cost, reward: legacy('collector-grilled-fish').reward, legacyId: 'collector-grilled-fish', action: { type: 'deliver', buildingType: 'seafoodKitchen', recipeId: 'grilledFish' }, source: sourceAt(684), note: '烤鱼1、40经验和75金币参考684秒订单；与旧后续任务共用领取记录，不重复扣料或发奖。' },
  { id: 'leader-six', title: '领袖达到6级', description: '满足居民需求，提升领袖等级至6级。', metric: 'leader-level', target: 6, cost: {}, reward: {}, action: { type: 'resident-order' }, source: sourceAt(690), note: '6级目标参考690秒任务。现有每60经验升级与三份居民订单为项目配置；未核实额外任务奖励，保持为空。' },
  { id: 'broadcast-built', title: '建造广播站', description: '建造广播站，向更远的海域发送招募讯息。', metric: 'build:broadcast', target: 1, cost: {}, reward: {}, action: { type: 'build', buildingType: 'broadcast' }, source: sourceAt(700), note: '广播站建造目标与领袖6级门槛参考实录。未核实任务奖励，保持为空。' },
  { id: 'recruit-first', title: '招募1次英雄', description: '通过广播站招募1次英雄。此前已有的招募次数也计入。', metric: 'recruits', target: 1, cost: {}, reward: {}, action: { type: 'progression', tab: 'recruit' }, source: sourceAt(724), note: '722秒广播站建成，724秒显示招募英雄1次0/1、734秒变1/1；726秒首单免费。任务奖励未核实，保持为空。单池概率仍为项目配置，免费资格只根据历史总招募次数为0判断。' },
  { id: 'story-tailor-built', title: '建造服装作坊', description: '建造1座服装作坊，准备加工救生衣。', metric: 'build:tailor', target: 1, cost: {}, reward: { experience: 35, plastic: 80 }, action: { type: 'build', buildingType: 'tailor' }, source: sourceAt(1250), references: [sourceAt(1279), sourceAt(1280)], note: '1250秒确认建造服装作坊目标，1279秒绿色1/1后1280秒切换救生衣目标并出现35经验、80塑料奖励。建设成本仍为项目配置，既有可用设施可计入。仅确认这些节点的相对次序，期间12/15份居民需求等目标仍有缺口，不声称完整连续链；独立于旧后续建设任务账本。' },
  { id: 'story-lifejacket-made', title: '生产1份救生衣', description: '从服装作坊累计领取1份救生衣。', metric: 'produce:lifejacket', target: 1, cost: {}, reward: { experience: 35, lifejacket: 2 }, action: { type: 'production', buildingType: 'tailor', recipeId: 'lifejacket' }, source: sourceAt(1280), references: [sourceAt(1281), sourceAt(1282)], note: '1280秒绿色任务6/1确认生产1份救生衣，1281秒转为累计12份居民需求并出现35经验、2救生衣奖励，1282秒仍可见救生衣飞字。以实际领取入库累计数计入为兼容口径，既有累计也认可；任务不扣救生衣，奖励成品不计生产累计，不自动补发奖励。仅接入已确认相对节点，不补造缺失需求链，独立于旧后续建设任务账本。' },
  { id: 'story-slicer-level-two', title: '切鱼厂升至2级', description: '将任意一座切鱼厂升至2级，准备加工鱼肠线。', metric: 'building-level:slicer', target: 2, cost: {}, reward: { experience: 40, fish: 160 }, action: { type: 'upgrade', buildingType: 'slicer' }, source: sourceAt(1490), references: [sourceAt(1491)], note: '1490秒升至2级目标绿色1/1，1491秒切换至鱼肠线0/1并出现40经验、160鲜鱼奖励。升级成本与即时升级仍为项目配置，已有2级切鱼厂可计入。中间居民需求等目标尚有缺口，只确认相对次序，独立于旧后续建设任务账本。' },
  { id: 'story-fish-line-made', title: '生产1份鱼肠线', description: '从切鱼厂累计领取1份鱼肠线。', metric: 'produce:fishLine', target: 1, cost: {}, reward: { experience: 40 }, action: { type: 'production', buildingType: 'slicer', recipeId: 'fishLine' }, source: sourceAt(1491), references: [sourceAt(1519), sourceAt(1520)], note: '1491秒显示生产1份鱼肠线0/1，1519秒完成，1520秒领奖可辨认40经验；另有50000橙色资源但品类未确认，本项目只发已确认经验、不擅自映射材料。以实际领取入库累计数量判断为兼容口径，既有累计可计入，不扣成品、不自动领奖。独立于旧后续建设任务账本。' },
  { id: 'story-materials-built', title: '建造材料厂', description: '建造1座材料厂，加工拾荒带回的原料。', metric: 'build:materials', target: 1, cost: {}, reward: { experience: 40, cloth: 150 }, action: { type: 'build', buildingType: 'materials' }, source: sourceAt(1520), references: [sourceAt(1528)], note: '1520秒确认建造材料厂目标，1528秒转为布匹0/1并出现40经验、150碎布奖励。建设成本仍为项目配置，既有可用材料厂可计入。服装作坊建设所需的项目加工材料可提前准备，不要求重建。未知中间任务不补造，独立于旧后续建设任务账本。' },
  { id: 'story-fabric-made', title: '生产1份布匹', description: '从材料厂累计领取1份布匹。', metric: 'produce:fabric', target: 1, cost: {}, reward: { experience: 40, fabric: 2 }, action: { type: 'production', buildingType: 'materials', recipeId: 'fabric' }, source: sourceAt(1528), references: [sourceAt(1537)], note: '1528秒显示生产1份布匹0/1，1537秒转为累计15份居民需求并出现40经验、2布匹奖励。以实际领取入库累计数量判断为兼容口径，既有累计可计入，任务不扣成品。12/15份居民需求等中间节点尚未完整还原，不声称连续完整链；独立于旧后续建设任务账本。' },
  { id: 'diving-dock-built', title: '建造潜水船坞', description: '建造潜水船坞，开始探索水下物资。', metric: 'build:divingDock', target: 1, cost: {}, reward: {}, action: { type: 'build', buildingType: 'divingDock' }, source: sourceAt(1940), note: '潜水船坞参考1940秒任务；广播站至船坞之间的原作任务尚有缺口，按广播站建成衔接为项目简化，未推断领袖10级硬门槛。' },
  { id: 'diving-scrap', title: '从水下带回20份废金属', description: '通过潜水累计带回20份废金属。只计算实际返航入库。', metric: 'diving:scrap', target: 20, cost: {}, reward: {}, action: { type: 'dive' }, source: sourceAt(1950), note: '目标20参考1950/2040秒任务，2040秒拾取文字确认废金属、海藻、玻璃。原任务为储备金属；本项目按潜水累计返航入库统计，不计算既有营地废料来源，属于兼容口径。' },
  { id: 'hospital-built', title: '建造医院', description: '建造1座医院，为家园增加人口空间。', metric: 'build:hospital', target: 1, cost: {}, reward: {}, action: { type: 'build', buildingType: 'hospital' }, source: sourceAt(2090), references: ['https://game.xiaomi.com/viewpoint/1672495402_1765245600055_13'], note: '2090秒显示建造医院目标；发行方转载攻略将医院列为增加基地人口的特殊民居，不据此虚构伤病治疗或自动收费。领取潜水物资目标后开放为本项目接入门槛。未核实任务奖励，保持为空。' },
  { id: 'daily-factory-built', title: '建造日用品厂', description: '建造1座日用品厂，为居民准备生活用品。', metric: 'build:dailyFactory', target: 1, cost: {}, reward: {}, action: { type: 'build', buildingType: 'dailyFactory' }, source: sourceAt(2100), note: '2100秒显示建造日用品厂目标，位于医院目标之后；领取医院目标后开放为本项目接入门槛。未核实任务奖励，保持为空。' },
  { id: 'daily-goods-made', title: '生产1份日用品', description: '从日用品厂加工并领取1份日用品。', metric: 'produce:dailyGoods', target: 1, cost: {}, reward: {}, action: { type: 'production', buildingType: 'dailyFactory', recipeId: 'dailyGoods' }, source: sourceAt(2110), note: '2110秒明确生产1份日用品，位于海产厨房升2之前；以加工完成并领取入库累计数量判断为项目兼容口径。2113秒配方面板明确玻璃20、废金属20、1200秒和库存50；旧已付批次保留原成本与计时，不追扣玻璃。未知任务奖励保持为空。' },
  { id: 'kitchen-level-two', title: '海产厨房升至2级', description: '升级海产厨房，为海藻汁加工做准备。', metric: 'building-level:seafoodKitchen', target: 2, cost: {}, reward: {}, action: { type: 'upgrade', buildingType: 'seafoodKitchen' }, source: sourceAt(2124), note: '2级目标参考2120秒任务；2124秒升级弹窗明确解锁海藻汁，2123至2125秒已见扣除1500金币和200鲜鱼。完整其他材料未核实，施工1200秒后等级与新配方才生效。未知额外任务奖励保持为空。' },
  { id: 'seaweed-juice-made', title: '生产1份海藻汁', description: '从海产厨房加工并领取1份海藻汁。', metric: 'produce:seaweedJuice', target: 1, cost: {}, reward: {}, action: { type: 'production', buildingType: 'seafoodKitchen', recipeId: 'seaweedJuice' }, source: sourceAt(2130), note: '2130秒任务明确生产1份海藻汁，配方参考2140秒；以领取入库后的累计数量判断为项目兼容口径。海产厨房升2至此目标的相邻顺序已确认，未知奖励保持为空。' },
].map((quest) => ({ ...quest, note: `${quest.note} ${recordedNote}` })));

const sideNote = '目标与经验奖励参考实录2160秒成就任务面板；该录像渠道未独立证实为抖音。完成原14教程后开放为项目接入规则，按实际领取入库累计数量统计为兼容口径。各项独立、一次领取，只加经验，不扣库存，不自动领奖；不据此推断原作完整支线或刷新规则。';
export const SIDE_QUESTS = Object.freeze([
  { id: 'side-water-20', title: '生产20份淡水', description: '从生产设施累计领取20份淡水。', resource: 'water', target: 20, cost: {}, reward: { experience: 15 }, action: { type: 'collect-production', buildingType: 'purifier', resource: 'water' } },
  { id: 'side-grilled-fish-20', title: '生产20份烤鱼', description: '从海产厨房累计领取20份烤鱼。', resource: 'grilledFish', target: 20, cost: {}, reward: { experience: 25 }, action: { type: 'production', buildingType: 'seafoodKitchen', recipeId: 'grilledFish' } },
  { id: 'side-lifejacket-20', title: '生产20份救生衣', description: '从服装作坊累计领取20份救生衣。', resource: 'lifejacket', target: 20, cost: {}, reward: { experience: 35 }, action: { type: 'production', buildingType: 'tailor', recipeId: 'lifejacket' } },
  { id: 'side-fish-line-20', title: '生产20份鱼肠线', description: '从切鱼厂累计领取20份鱼肠线。', resource: 'fishLine', target: 20, cost: {}, reward: { experience: 40 }, action: { type: 'production', buildingType: 'slicer', recipeId: 'fishLine' } },
  { id: 'side-fabric-20', title: '生产20份布匹', description: '从材料厂累计领取20份布匹。', resource: 'fabric', target: 20, cost: {}, reward: { experience: 40 }, action: { type: 'production', buildingType: 'materials', recipeId: 'fabric' } },
].map((quest) => ({ ...quest, source: sourceAt(2160), note: sideNote })));

const clone = (value) => JSON.parse(JSON.stringify(value));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export function createStory() { return { version: 2, claimed: [], sideClaimed: [] }; }

export function normalizeStory(raw, continuation = { claimed: [] }) {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw) || ![1, 2].includes(raw.version ?? 1) || raw.claimed !== undefined && !Array.isArray(raw.claimed) || raw.sideClaimed !== undefined && !Array.isArray(raw.sideClaimed))) throw new Error('故事进度来自更新版本或格式不完整，已保留原存档。');
  const claimed = new Set(raw?.claimed || []), sideClaimed = new Set(raw?.sideClaimed || []);
  if ([...claimed].some((id) => !STORY_QUESTS.some((quest) => quest.id === id))) throw new Error('故事领取记录暂不兼容，已保留原存档。');
  if ([...sideClaimed].some((id) => !SIDE_QUESTS.some((quest) => quest.id === id))) throw new Error('支线领取记录暂不兼容，已保留原存档。');
  for (const quest of STORY_QUESTS) {
    if (!quest.legacyId) continue;
    if (continuation.claimed.includes(quest.legacyId)) claimed.add(quest.id);
    if (claimed.has(quest.id) && !continuation.claimed.includes(quest.legacyId)) continuation.claimed.push(quest.legacyId);
  }
  return { version: 2, claimed: STORY_QUESTS.filter((quest) => claimed.has(quest.id)).map((quest) => quest.id), sideClaimed: SIDE_QUESTS.filter((quest) => sideClaimed.has(quest.id)).map((quest) => quest.id) };
}

export class StoryState {
  constructor(game) { this.game = game; }
  get state() { return this.game.state.story; }
  isClaimed(quest) { return this.state.claimed.includes(quest.id) || !!quest.legacyId && this.game.state.continuation.claimed.includes(quest.legacyId); }
  _current(quest, missing) {
    if (quest.metric.startsWith('stock:')) return this.game.state.resources[quest.metric.slice(6)] || 0;
    if (quest.metric.startsWith('diving:')) return this.game.state.diving.totalCollected[quest.metric.slice(7)] || 0;
    if (quest.metric.startsWith('building-level:')) return Math.max(0, ...this.game.state.buildings.filter((building) => building.type === quest.metric.slice(15)).map((building) => building.level));
    if (quest.metric === 'leader-level') return this.game.state.profile.level;
    if (quest.metric === 'recruits') return this.game.state.progression.recruitment.normalCount + this.game.state.progression.recruitment.legendCount;
    if (quest.metric === 'deliver') return Object.keys(missing).length ? 0 : 1;
    return this.game._questValue(quest.metric);
  }
  getQuests() {
    return STORY_QUESTS.map((quest, index) => {
      const claimed = this.isClaimed(quest), missing = Object.fromEntries(Object.entries(quest.cost).filter(([key, value]) => this.game.state.resources[key] + 1e-7 < value).map(([key, value]) => [key, Math.ceil(value - this.game.state.resources[key] - 1e-7)]));
      const current = this._current(quest, missing), active = !claimed && this.game.state.completed && STORY_QUESTS.slice(0, index).every((previous) => this.isClaimed(previous));
      const complete = claimed || current >= quest.target && !Object.keys(missing).length;
      return { ...clone(quest), story: true, followup: true, category: 'story', current, progress: clamp(current / quest.target, 0, 1), claimed, active, complete, missing, status: claimed ? 'claimed' : !active ? 'locked' : complete ? 'ready' : 'active' };
    });
  }
  getSideQuests() {
    return SIDE_QUESTS.map((quest) => {
      const current = quest.resource === 'water' ? this.game.state.stats.productionCollected.water : this.game.state.production.collected[quest.resource] || 0;
      const claimed = this.state.sideClaimed.includes(quest.id), unlocked = this.game.state.completed, active = unlocked && !claimed, complete = claimed || current >= quest.target;
      return { ...clone(quest), side: true, category: 'side', story: false, followup: true, current, progress: clamp(current / quest.target, 0, 1), claimed, unlocked, active, complete, canClaim: active && complete, missing: {}, status: claimed ? 'claimed' : !unlocked ? 'locked' : complete ? 'ready' : 'active' };
    });
  }
  claimSide(id) {
    const quest = this.getSideQuests().find((value) => value.id === id);
    if (!quest) return { ok: false, message: '找不到这项支线目标。' };
    if (quest.claimed) return { ok: false, message: '这项支线奖励已经领取过。' };
    if (!quest.unlocked) return { ok: false, message: '先完成海上家园原14项教程，再领取支线奖励。' };
    if (!quest.complete) return { ok: false, current: quest.current, target: quest.target, remaining: quest.target - quest.current, message: `继续生产并领取物资，当前累计${quest.current}/${quest.target}。` };
    this.state.sideClaimed.push(id);
    this.game.state.profile.experience += quest.reward.experience;
    this.game._changed('sideQuestClaimed', { quest, reward: clone(quest.reward) });
    return { ok: true, questId: id, quest, cost: {}, reward: clone(quest.reward), resources: {}, profile: clone(this.game.state.profile), message: `支线目标完成：${quest.title}。` };
  }
  claim(id) {
    const quest = this.getQuests().find((value) => value.id === id);
    if (!quest) return { ok: false, message: '找不到这项故事目标。' };
    if (quest.claimed) return { ok: false, message: '这项故事奖励已经领取过。' };
    if (!quest.active) return { ok: false, message: '先完成海上家园，并按顺序领取前面的故事目标。' };
    if (!quest.complete) return { ok: false, missing: quest.missing, message: quest.metric === 'deliver' ? '交付物资还不够，领取时会扣除明示材料。' : '这项故事目标还没有完成。' };
    this.game._spend(quest.cost);
    this.state.claimed.push(id);
    if (quest.legacyId && !this.game.state.continuation.claimed.includes(quest.legacyId)) this.game.state.continuation.claimed.push(quest.legacyId);
    const resources = Object.fromEntries(Object.entries(quest.reward).filter(([key]) => Object.hasOwn(this.game.state.resources, key)));
    this.game._addResources(resources);
    this.game.state.profile.experience += quest.reward.experience || 0;
    this.game._changed('storyQuestClaimed', { quest, resources: clone(resources), reward: clone(quest.reward) });
    return { ok: true, cost: clone(quest.cost), reward: clone(quest.reward), resources, profile: clone(this.game.state.profile), message: `故事目标完成：${quest.title}。` };
  }
}

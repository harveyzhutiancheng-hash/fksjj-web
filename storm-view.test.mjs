import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from './game-state.js';
import { renderStormObjectives, renderStormTask, stormButtonState } from './storm-view.js';

const fresh = () => new GameState({ storage: null, autoLoad: false });

test('storm card exposes three independently labelled destinations and live progress', () => {
  const game=fresh();game.state.resources.food=3;game.state.resources.water=6;
  const html=renderStormObjectives(game.getStormStatus());
  assert.equal((html.match(/data-action="storm-goal"/g)||[]).length,3);
  for(const id of ['food','command','water'])assert.match(html,new RegExp(`data-goal="${id}"`));
  assert.match(html,/3\/6 份/);assert.match(html,/1\/2 级/);assert.match(html,/6\/6 份 · 已备妥/);
  assert.match(html,/aria-label="储备生鱼片，前往切鱼厂"/);
  assert.match(html,/aria-label="升级指挥中心，前往指挥中心"/);
  assert.match(html,/aria-label="储备淡水，前往净水器"/);
  assert.equal((html.match(/role="progressbar"/g)||[]).length,3);
});

test('task claim requires quest completion, even when every preparation is ready', () => {
  const game=fresh();game.state.resources.food=6;game.state.resources.water=6;game.state.buildings.find(b=>b.type==='command').level=2;
  const before=renderStormTask(game.getStormStatus(),{complete:false});
  assert.match(before,/data-action="go-quest" data-id="command"/);assert.doesNotMatch(before,/data-action="claim"/);
  const after=renderStormTask(game.getStormStatus(),{complete:true});
  assert.match(after,/data-action="claim" data-id="command"/);assert.match(after,/奖励待领取/);
});

test('storm button blocks dormant, incomplete, recovering and passed states', () => {
  assert.deepEqual(stormButtonState({status:'approaching',ready:true}),{disabled:false,label:'迎接风暴'});
  for(const status of ['dormant','recovering','passed'])assert.equal(stormButtonState({status,ready:true}).disabled,true);
  assert.equal(stormButtonState({status:'approaching',ready:false}).disabled,true);
});

test('fractional and abundant stocks show bounded accessible progress without corrupting markup', () => {
  const state={objectives:[{id:'food',current:20.7,target:6,complete:true},{id:'command',current:NaN,target:2},{id:'water',current:-2,target:6},{id:'<script>',current:1,target:1}]};
  const html=renderStormObjectives(state);
  assert.match(html,/20\/6 份/);assert.match(html,/aria-valuemax="6" aria-valuenow="6"/);
  assert.doesNotMatch(html,/NaN|Infinity|<script>|width:-/);
  assert.equal((html.match(/data-action="storm-goal"/g)||[]).length,3);
  assert.doesNotMatch(renderStormTask(state,{chapter:{current:'<img>',total:14}}),/<img>/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountUI } from './account-ui.js';

// Event-handler unit regressions only: this harness does not render a browser DOM.
function harness(initial) {
  let state=initial;
  const calls=[];
  const ui=Object.create(AccountUI.prototype);
  Object.assign(ui, {
    localBusy:false, confirmLocal:null,
    manager:{snapshot:()=>state,resolveConflict:(...args)=>calls.push(args)},
    el:{querySelector:()=>({focus(){}})},
    sync(){}, clearError(){}, showError(message){this.error=message;},
    perform(action){return action();}
  });
  return {ui,calls,setState(value){state=value;},click(action){
    const button={disabled:false,dataset:{accountAction:action}};
    ui.handle({stopPropagation(){},target:{hasAttribute:()=>false,closest:()=>button}});
  }};
}
const conflict=(id=1,revision=3)=>({user:{id,username:`user_${id}`},phase:'conflict',conflict:{revision},busy:false});

test('local overwrite passes the exact identity and revision the user reviewed',()=>{
  const h=harness(conflict());
  h.click('review-local');h.click('confirm-local');
  assert.deepEqual(h.calls,[['local',{userId:1,revision:3}]]);
});
test('changing accounts invalidates the pending overwrite confirmation',()=>{
  const h=harness(conflict());h.click('review-local');
  h.setState(conflict(2));h.click('confirm-local');
  assert.equal(h.calls.length,0);assert.equal(h.ui.confirmLocal,null);
  assert.match(h.ui.error,/重新查看/);
});
test('a different cloud revision requires another review before overwriting',()=>{
  const h=harness(conflict());h.click('review-local');
  h.setState(conflict(1,4));h.click('confirm-local');
  assert.equal(h.calls.length,0);
  h.click('review-local');h.click('confirm-local');
  assert.deepEqual(h.calls,[['local',{userId:1,revision:4}]]);
});
test('leaving the conflict phase prevents an old confirm event from writing',()=>{
  const h=harness(conflict());h.click('review-local');
  h.setState({...conflict(),phase:'expired'});h.click('confirm-local');
  assert.equal(h.calls.length,0);
});
test('choosing cloud is also bound to the displayed identity and revision',()=>{
  const h=harness(conflict());h.click('cloud');
  assert.deepEqual(h.calls,[['cloud',{userId:1,revision:3}]]);
});
test('a stale cloud choice does nothing after the account expires',()=>{
  const h=harness({...conflict(),phase:'expired'});h.click('cloud');
  assert.equal(h.calls.length,0);
});

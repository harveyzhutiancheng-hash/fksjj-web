"""Offline workflow contracts and shell-state fixtures, never a deployment.

No real key, archive, dependency installation, game build, API account, GitHub
run or server request occurs here. YAML shell steps use inert fake clients.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
import yaml

WORKFLOW=Path(__file__).resolve().parents[1]/'.github/workflows/fkssj-release.yml'
REPO='harveyzhutiancheng-hash/fksjj-web'
COMMIT='a'*40
CURRENT='releases/INERT-OLD'
MANIFEST='b20e11a258007f39129a47601be7a291391c9275ad5ea6b51ab0e9e7f21aa272'
FIXTURE_KEY='PUBLIC-NONSECRET-WORKFLOW-FIXTURE'
PINS={
 'actions/checkout':'d23441a48e516b6c34aea4fa41551a30e30af803',
 'actions/setup-node':'249970729cb0ef3589644e2896645e5dc5ba9c38',
 'actions/setup-python':'ece7cb06caefa5fff74198d8649806c4678c61a1',
}

CLIENT=r'''import hashlib,json,os,pathlib,sys
args=sys.argv[1:]
def arg(name):return args[args.index(name)+1]
root=pathlib.Path.cwd()
def trace(name):
 with (root/'trace.jsonl').open('a') as out:out.write(json.dumps(name)+'\n')
metadata=pathlib.Path(arg('--metadata'))
if args[0]=='prepare-upload':
 if 'FKSSJ_RELEASE_HMAC_KEY_HEX' in os.environ:raise SystemExit(91)
 raw=pathlib.Path(arg('--artifact')).read_bytes()
 value={'schema':1,'type':'fkssj-release-client-state','bindings':{
 'repo':'harveyzhutiancheng-hash/fksjj-web','ref':'refs/heads/main','commit':arg('--commit'),
 'releaseId':arg('--release-id'),'artifactSha256':hashlib.sha256(raw).hexdigest(),
 'artifactBytes':len(raw),'manifestSha256':arg('--manifest-sha256'),'expectedCurrent':arg('--expected-current')}}
 with metadata.open('x') as out:json.dump(value,out)
 trace('prepare')
elif args[0]=='upload':
 value=json.loads(metadata.read_text())
 if os.environ.get('FKSSJ_RELEASE_HMAC_KEY_HEX')!='PUBLIC-NONSECRET-WORKFLOW-FIXTURE':raise SystemExit(92)
 summary=pathlib.Path(os.environ['GITHUB_STEP_SUMMARY']).read_text()
 if not all(str(v) in summary for v in value['bindings'].values()):raise SystemExit(93)
 with pathlib.Path(str(metadata)+'.upload-attempted').open('x') as out:out.write('INERT ONE ATTEMPT')
 trace('upload')
 if os.environ.get('FIXTURE_UPLOAD')=='unknown':raise SystemExit(3)
else:raise SystemExit(94)
'''

ORCHESTRATOR=r'''import json,os,pathlib,sys
args=sys.argv[1:]
def arg(name):return args[args.index(name)+1]
metadata=pathlib.Path(arg('--metadata'));root=pathlib.Path.cwd()
def trace(name):
 with (root/'trace.jsonl').open('a') as out:out.write(json.dumps(name)+'\n')
if os.environ.get('FKSSJ_RELEASE_HMAC_KEY_HEX')!='PUBLIC-NONSECRET-WORKFLOW-FIXTURE':raise SystemExit(95)
if not pathlib.Path(str(metadata)+'.upload-attempted').is_file():raise SystemExit(96)
if arg('--timeout')!='180' or arg('--interval')!='5':raise SystemExit(97)
if args[0]=='wait':
 if arg('--target')!='staged':raise SystemExit(98)
 trace('wait-staged')
 if os.environ.get('FIXTURE_STAGE') in ('received','unknown','rejected','timeout'):raise SystemExit(3)
 with pathlib.Path(str(metadata)+'.fixture-staged').open('x') as out:out.write('INERT STAGED')
elif args[0]=='activate':
 if '--verify-files' not in args or arg('--expected-version')!='0.14.0' or not pathlib.Path(str(metadata)+'.fixture-staged').is_file():raise SystemExit(99)
 with pathlib.Path(str(metadata)+'.activate-attempted').open('x') as out:out.write('INERT ACTIVATE')
 trace('activate')
 if os.environ.get('FIXTURE_ACTIVATE') in ('unknown','api_failed','timeout'):raise SystemExit(3)
 trace('public-verify')
else:raise SystemExit(100)
'''


def load():return yaml.load(WORKFLOW.read_text(),Loader=yaml.BaseLoader)


class WorkflowContracts(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.text=WORKFLOW.read_text();cls.w=load();cls.job=cls.w['jobs']['release'];cls.steps=cls.job['steps']

 def test_only_manual_exact_main_and_existing_environment(self):
  self.assertEqual(set(self.w['on']),{'workflow_dispatch'})
  inputs=self.w['on']['workflow_dispatch']['inputs']
  self.assertEqual(set(inputs),{'commit','expected_current','mode'})
  self.assertEqual(inputs['mode']['default'],'stage');self.assertEqual(inputs['mode']['options'],['stage','activate'])
  self.assertEqual(set(self.w['jobs']),{'release'})
  self.assertEqual(self.job['environment'],'fkssj-release-receive')
  self.assertEqual(self.w['permissions'],{});self.assertEqual(self.job['permissions'],{'contents':'read'})
  self.assertEqual(self.w['concurrency']['cancel-in-progress'],'false')
  for value in ("github.repository == '"+REPO+"'","github.ref == 'refs/heads/main'","github.event_name == 'workflow_dispatch'"):
   self.assertIn(value,self.job['if'])

 def test_readiness_and_source_fail_before_checkout_or_secret(self):
  step=self.steps[0];self.assertEqual(step['id'],'paths')
  self.assertEqual(step['env']['CHANNEL_READY'],'${{ vars.FKSSJ_RELEASE_CHANNEL_READY }}')
  self.assertEqual(step['env']['ACTIVATION_READY'],'${{ vars.FKSSJ_RELEASE_ACTIVATION_READY }}')
  self.assertIn("mode == 'activate' and os.environ.get('ACTIVATION_READY') != 'true'",step['run'])
  self.assertIn("commit != os.environ.get('GITHUB_SHA')",step['run'])
  self.assertIn("os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'",step['run'])
  self.assertNotIn('secrets.',json.dumps(step))

 def test_official_actions_are_exact_pins_and_checkout_does_not_persist_credentials(self):
  used={step['uses'].split('@')[0]:step for step in self.steps if 'uses' in step}
  self.assertEqual(set(used),set(PINS))
  for name,pin in PINS.items():self.assertEqual(used[name]['uses'],name+'@'+pin)
  self.assertEqual(used['actions/checkout']['with'],{'ref':'${{ github.sha }}','persist-credentials':'false','fetch-depth':'1'})
  self.assertEqual(used['actions/setup-node']['with']['node-version'],'24.19.0')
  self.assertEqual(used['actions/setup-node']['with']['package-manager-cache'],'false')
  self.assertEqual(used['actions/setup-python']['with']['python-version'],'3.12')

 def test_test_build_normalize_package_then_one_upload_and_controlled_activation(self):
  scripts='\n'.join(s.get('run','') for s in self.steps)
  tokens=('npm ci --ignore-scripts','npm run test:source','api.test_api api.test_boundaries',
   'deploy.test_manual_browser_checks','deploy.test_publisher_pipeline','npm run test:http','node deploy/package-static.mjs',
   'deploy/normalize_approved_release.py','deploy/release_orchestrator.py bundle',
   "'prepare-upload'",'deploy/release_client.py upload','deploy/release_orchestrator.py wait',
   'deploy/release_orchestrator.py activate')
  positions=[scripts.index(t) for t in tokens];self.assertEqual(positions,sorted(positions))
  self.assertEqual(scripts.count('deploy/release_client.py upload'),1)
  self.assertEqual(scripts.count('deploy/release_orchestrator.py activate'),1)
  self.assertIn(MANIFEST,scripts);self.assertIn('secrets.token_hex(16)',scripts)
  activation=next(s for s in self.steps if 'release_orchestrator.py activate' in s.get('run',''))
  self.assertEqual(activation['if'],"${{ inputs.mode == 'activate' }}")
  self.assertIn('--verify-files',activation['run'])

 def test_secret_scope_no_credential_or_gate_shortcuts(self):
  injected=[s for s in self.steps if 'FKSSJ_RELEASE_HMAC_KEY_HEX' in s.get('env',{})]
  self.assertEqual(len(injected),3)
  self.assertEqual([('upload' if 'release_client.py upload' in s['run'] else 'wait' if 'release_orchestrator.py wait' in s['run'] else 'activate') for s in injected],['upload','wait','activate'])
  self.assertNotIn('FKSSJ_RELEASE_HMAC_KEY_HEX',json.dumps(self.job.get('env',{})))
  for s in injected:
   self.assertEqual(s['env']['FKSSJ_RELEASE_HMAC_KEY_HEX'],'${{ secrets.FKSSJ_RELEASE_HMAC_KEY_HEX }}')
   self.assertNotRegex(s['run'],r'(?m)^\s*(while|until|for)\s')
  for value in ('continue-on-error:','always()','inputs.endpoint','ssh ', 'scp ', 'sudo ', 'curl ', 'wget ',
                'fkssj-release-activate','contents: write','api-acceptance.json'):
   self.assertNotIn(value,self.text)
  self.assertIn('waived_not_run',self.text)
  self.assertIn('server must independently pass API acceptance',self.text)

 def test_all_shell_and_inline_python_parse_without_running_actions(self):
  blocks=[]
  for step in self.steps:
   if 'run' not in step:continue
   parsed=subprocess.run(['bash','-n'],input=step['run'],text=True,capture_output=True,timeout=5)
   self.assertEqual(parsed.returncode,0,step['name']+' '+parsed.stderr)
   for found in re.finditer(r"(?m)^python3[^\n]* <<'PY'\n(.*?)^PY$",step['run'],re.S|re.M):
    compile(found[1],'<workflow Python>','exec');blocks.append(found[1])
  self.assertGreaterEqual(len(blocks),5)


class OfflineSteps(unittest.TestCase):
 def setUp(self):
  temporary=tempfile.TemporaryDirectory(prefix='INERT-workflow-');self.addCleanup(temporary.cleanup)
  self.root=Path(temporary.name);(self.root/'deploy').mkdir();(self.root/'runner').mkdir()
  (self.root/'deploy/release_client.py').write_text(CLIENT)
  (self.root/'deploy/release_orchestrator.py').write_text(ORCHESTRATOR)
  (self.root/'package.json').write_text('{"version":"0.14.0"}')
  self.artifact=self.root/'INERT-NOT-AN-ARCHIVE.txt';self.artifact.write_bytes(b'INERT fixture only')
  self.info=self.root/'info.json';self.info.write_text(json.dumps({'version':'0.14.0','manifestSha256':MANIFEST,
   'artifactSha256':hashlib.sha256(self.artifact.read_bytes()).hexdigest(),'artifactBytes':self.artifact.stat().st_size}))
  self.metadata=self.root/'metadata.json'
  self.env={'PATH':os.environ['PATH'],'HOME':str(self.root),'LC_ALL':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1',
   'GITHUB_REPOSITORY':REPO,'GITHUB_REF':'refs/heads/main','GITHUB_SHA':COMMIT,'GITHUB_EVENT_NAME':'workflow_dispatch',
   'INPUT_COMMIT':COMMIT,'INPUT_CURRENT':CURRENT,'INPUT_MODE':'stage','CHANNEL_READY':'true','ACTIVATION_READY':'true',
   'RUNNER_TEMP':str(self.root/'runner'),'GITHUB_OUTPUT':str(self.root/'output'),
   'GITHUB_STEP_SUMMARY':str(self.root/'summary'),'RELEASE_ARTIFACT':str(self.artifact),
   'RELEASE_INFO':str(self.info),'RELEASE_METADATA':str(self.metadata)}
  self.steps=load()['jobs']['release']['steps']
  self.preflight=self.steps[0]
  self.prepare=next(s for s in self.steps if s.get('id')=='prepare')
  self.upload=next(s for s in self.steps if 'release_client.py upload' in s.get('run',''))
  self.wait=next(s for s in self.steps if 'release_orchestrator.py wait' in s.get('run',''))
  self.activate=next(s for s in self.steps if 'release_orchestrator.py activate' in s.get('run',''))

 def step(self,step,extra=None):
  env=dict(self.env);env.update(extra or {})
  if 'FKSSJ_RELEASE_HMAC_KEY_HEX' in step.get('env',{}):env['FKSSJ_RELEASE_HMAC_KEY_HEX']=FIXTURE_KEY
  return subprocess.run(['bash','-e','-o','pipefail','-c',step['run']],cwd=self.root,env=env,
   text=True,capture_output=True,timeout=10)

 def trace(self):
  p=self.root/'trace.jsonl';return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []

 def pipeline(self,mode='stage',extra=None):
  self.env['INPUT_MODE']=mode;results=[]
  for step in [self.preflight,self.prepare,self.upload,self.wait]+([self.activate] if mode=='activate' else []):
   reply=self.step(step,extra);results.append(reply)
   if reply.returncode:break
  return results

 def test_stage_default_has_no_activation_and_summary_precedes_upload(self):
  results=self.pipeline();self.assertEqual([r.returncode for r in results],[0,0,0,0])
  self.assertEqual(self.trace(),['prepare','upload','wait-staged'])
  summary=(self.root/'summary').read_text();self.assertIn(COMMIT,summary);self.assertIn(CURRENT,summary)
  self.assertIn('waived_not_run',summary)
  self.assertNotIn(FIXTURE_KEY,summary+''.join(r.stdout+r.stderr for r in results))
  self.assertRegex(json.loads(self.metadata.read_text())['bindings']['releaseId'],r'^[0-9a-f]{32}$')

 def test_explicit_activate_runs_once_after_staged(self):
  results=self.pipeline('activate');self.assertEqual([r.returncode for r in results],[0,0,0,0,0])
  self.assertEqual(self.trace(),['prepare','upload','wait-staged','activate','public-verify'])
  self.assertTrue(Path(str(self.metadata)+'.activate-attempted').is_file())

 def test_unready_channel_and_activation_stop_before_metadata_and_upload(self):
  for mode,changes in [('stage',{'CHANNEL_READY':''}),('activate',{'ACTIVATION_READY':''})]:
   self.env['INPUT_MODE']=mode
   result=self.step(self.preflight,changes);self.assertNotEqual(result.returncode,0)
   self.assertFalse(self.metadata.exists());self.assertEqual(self.trace(),[])

 def test_bad_source_or_current_is_not_shell_code(self):
  for changes in ({'GITHUB_REF':'refs/heads/topic'},{'GITHUB_EVENT_NAME':'push'},
    {'INPUT_COMMIT':'B'*40},{'INPUT_COMMIT':'b'*40},{'INPUT_CURRENT':'releases/x$(touch INERT_MARKER)'},
    {'INPUT_CURRENT':'releases/../bad'}):
   with self.subTest(changes=changes):
    result=self.step(self.preflight,changes);self.assertNotEqual(result.returncode,0)
    self.assertFalse((self.root/'INERT_MARKER').exists());self.assertEqual(self.trace(),[])

 def test_upload_unknown_never_waits_or_retries(self):
  results=self.pipeline('activate',{'FIXTURE_UPLOAD':'unknown'})
  self.assertEqual([r.returncode for r in results],[0,0,3]);self.assertEqual(self.trace(),['prepare','upload'])

 def test_received_rejected_or_unknown_stage_never_activates(self):
  for state in ('received','rejected','unknown','timeout'):
   with self.subTest(state=state):
    # Each subcase is a genuinely separate INERT runner, not a mutation retry.
    self.setUp()
    results=self.pipeline('activate',{'FIXTURE_STAGE':state})
    self.assertEqual([r.returncode for r in results],[0,0,0,3])
    self.assertEqual(self.trace(),['prepare','upload','wait-staged'])

 def test_activation_unknown_or_API_failure_never_retries_or_claims_verified(self):
  for state in ('unknown','api_failed','timeout'):
   with self.subTest(state=state):
    self.setUp()
    results=self.pipeline('activate',{'FIXTURE_ACTIVATE':state})
    self.assertEqual([r.returncode for r in results],[0,0,0,0,3])
    self.assertEqual(self.trace(),['prepare','upload','wait-staged','activate'])
    self.assertNotIn('The signed activation operation completed',(self.root/'summary').read_text())

if __name__=='__main__':unittest.main()

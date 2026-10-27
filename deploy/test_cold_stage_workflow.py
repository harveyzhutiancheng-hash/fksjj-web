"""Offline cold-stage workflow contracts; no game build, package or network.

YAML/shell/Python syntax is checked, then the actual preparation/upload/wait
shell blocks run in a temporary INERT checkout with explicit fake CLI helpers.
The fake helpers have no transport, signatures or real keys. They cannot prove
GitHub/environment/server behavior; those remain separate acceptance gates.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

import yaml


TEMPLATE = Path(__file__).with_name('templates') / 'github-cold-stage.yml'
COMMIT = 'a' * 40
CURRENT = 'releases/INERT-TEST-OLD'
TEST_KEY = 'PUBLIC-TEST-FIXTURE-NOT-A-REAL-KEY'


FAKE_CLIENT = r'''import hashlib,json,os,pathlib,sys
args=sys.argv[1:]
root=pathlib.Path.cwd()
def value(name): return args[args.index(name)+1]
def trace(code):
    with (root/'trace.jsonl').open('a') as out:out.write(json.dumps({'command':code})+'\n')
operation=args[0]
path=pathlib.Path(value('--metadata'))
if operation=='prepare-upload':
    if 'FKSSJ_RELEASE_HMAC_KEY_HEX' in os.environ:raise SystemExit(91)
    artifact=pathlib.Path(value('--artifact')).read_bytes()
    data={'schema':1,'type':'fkssj-release-client-state','bindings':{
        'repo':'harveyzhutiancheng-hash/fksjj-web','ref':'refs/heads/main',
        'commit':value('--commit'),'releaseId':value('--release-id'),
        'artifactSha256':hashlib.sha256(artifact).hexdigest(),'artifactBytes':len(artifact),
        'manifestSha256':value('--manifest-sha256'),'expectedCurrent':value('--expected-current')}}
    with path.open('x') as out:json.dump(data,out)
    trace('prepare-upload')
elif operation=='upload':
    metadata=json.loads(path.read_text())
    summary=pathlib.Path(os.environ['GITHUB_STEP_SUMMARY']).read_text()
    if not all(str(v) in summary for v in metadata['bindings'].values()):raise SystemExit(92)
    if os.environ.get('FKSSJ_RELEASE_HMAC_KEY_HEX')!='PUBLIC-TEST-FIXTURE-NOT-A-REAL-KEY':raise SystemExit(93)
    with pathlib.Path(str(path)+'.upload-attempted').open('x') as out:out.write('INERT ONE ATTEMPT\n')
    trace('upload')
    if os.environ.get('TEST_UPLOAD_RESULT')=='unknown':raise SystemExit(3)
    print(json.dumps({'state':'received','releaseId':metadata['bindings']['releaseId']}))
else:raise SystemExit(94)
'''

FAKE_ORCHESTRATOR = r'''import json,os,pathlib,sys
args=sys.argv[1:]
root=pathlib.Path.cwd()
if args[0]!='wait' or args[args.index('--target')+1]!='staged':raise SystemExit(95)
if args[args.index('--timeout')+1]!='180' or args[args.index('--interval')+1]!='5':raise SystemExit(96)
metadata=pathlib.Path(args[args.index('--metadata')+1])
if not pathlib.Path(str(metadata)+'.upload-attempted').is_file():raise SystemExit(97)
with (root/'trace.jsonl').open('a') as out:out.write(json.dumps({'command':'wait-staged'})+'\n')
if os.environ.get('TEST_WAIT_RESULT') in ('received','unknown','rejected','timeout'):raise SystemExit(3)
print(json.dumps({'state':'staged','lastOperation':{'operation':'upload','state':'completed'}}))
'''


class WorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = TEMPLATE.read_text()
        # BaseLoader preserves the literal 'on' and booleans for shape checks.
        cls.workflow = yaml.load(cls.text, Loader=yaml.BaseLoader)
        cls.job = cls.workflow['jobs']['stage']
        cls.steps = cls.job['steps']

    def test_manual_fixed_source_environment_and_permissions(self):
        self.assertEqual(set(self.workflow['on']), {'workflow_dispatch'})
        inputs = self.workflow['on']['workflow_dispatch']['inputs']
        self.assertEqual(set(inputs), {'commit', 'expected_current', 'operator_ready'})
        self.assertEqual(inputs['operator_ready']['default'], 'false')
        self.assertEqual(set(self.workflow['jobs']), {'stage'})
        self.assertEqual(self.workflow['permissions'], {})
        self.assertEqual(self.job['permissions'], {'contents': 'read'})
        self.assertEqual(self.job['environment'], 'fkssj-release-receive')
        for check in ("github.repository == 'harveyzhutiancheng-hash/fksjj-web'",
                      "github.ref == 'refs/heads/main'",
                      "github.event_name == 'workflow_dispatch'"):
            self.assertIn(check, self.job['if'])
        self.assertEqual(self.workflow['concurrency']['cancel-in-progress'], 'false')

    def test_explicit_readiness_fails_before_checkout_or_any_secret(self):
        first = self.steps[0]
        self.assertEqual(first['env']['COLD_STAGE_READY'], '${{ vars.FKSSJ_COLD_STAGE_READY }}')
        self.assertEqual(first['env']['OPERATOR_READY'], '${{ inputs.operator_ready }}')
        self.assertIn("os.environ.get('COLD_STAGE_READY') != 'true'", first['run'])
        self.assertIn("os.environ.get('OPERATOR_READY') != 'true'", first['run'])
        self.assertIn("commit != os.environ.get('GITHUB_SHA')", first['run'])
        self.assertNotIn('secrets.', json.dumps(first))
        self.assertIn('only AFTER the explicit stage-only server', self.text)

    def test_pinned_checkout_locked_dependencies_and_test_order(self):
        uses = [x for x in self.steps if 'uses' in x]
        self.assertEqual(len(uses), 1)
        self.assertEqual(uses[0]['uses'], 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683')
        self.assertEqual(uses[0]['with'], {'ref': '${{ github.sha }}',
                                         'persist-credentials': 'false', 'fetch-depth': '1'})
        scripts = '\n'.join(x.get('run', '') for x in self.steps)
        self.assertIn('npm ci --ignore-scripts', scripts)
        self.assertIn('PyYAML==6.0.2', scripts)
        self.assertIn("[('node', 24), ('npm', 11)]", scripts)
        positions = [scripts.index(x) for x in ('npm run test:source', 'api.test_api api.test_boundaries',
                     'deploy.test_cold_stage_worker',
                     'npm run test:http', 'node deploy/package-static.mjs',
                     'deploy/release_orchestrator.py bundle', 'deploy/release_client.py upload')]
        self.assertEqual(positions, sorted(positions))

    def test_secret_is_only_in_upload_and_bounded_status_steps(self):
        injected = [x for x in self.steps if 'FKSSJ_RELEASE_HMAC_KEY_HEX' in x.get('env', {})]
        self.assertEqual(len(injected), 2)
        self.assertIn('release_client.py upload', injected[0]['run'])
        self.assertIn('release_orchestrator.py wait', injected[1]['run'])
        self.assertIn('--target staged --timeout 180 --interval 5', injected[1]['run'])
        self.assertNotIn('FKSSJ_RELEASE_HMAC_KEY_HEX', json.dumps(self.job.get('env', {})))
        for x in injected:
            self.assertEqual(x['env']['FKSSJ_RELEASE_HMAC_KEY_HEX'], '${{ secrets.FKSSJ_RELEASE_HMAC_KEY_HEX }}')

    def test_no_switch_path_service_control_retry_or_arbitrary_endpoint(self):
        runs = '\n'.join(x.get('run', '') for x in self.steps)
        for forbidden in ('release_client.py activate', 'release_orchestrator.py activate',
                          '--target activated', 'systemctl', 'sudo ', 'ssh ', 'scp ',
                          'curl ', 'wget ', 'continue-on-error', 'inputs.endpoint',
                          'inputs.mode', 'fkssj-release-activate', 'FKSSJ_RELEASE_ACTIVATION_READY'):
            self.assertNotIn(forbidden, self.text)
        mutation_steps = [x for x in self.steps if 'FKSSJ_RELEASE_HMAC_KEY_HEX' in x.get('env', {})]
        for step in mutation_steps:
            self.assertNotRegex(step['run'], r'(?m)^\s*(?:while|until|for)\s')
        self.assertEqual(runs.count('deploy/release_client.py upload'), 1)
        self.assertIn('original upload envelope has at most 300 seconds', runs)
        self.assertIn('do not rerun upload', runs)
        self.assertIn('unchanged current symlink', self.text)

    def test_all_shell_and_inline_python_blocks_parse_without_running_pipeline(self):
        blocks = []
        for step in self.steps:
            if 'run' not in step:
                continue
            reply = subprocess.run(['bash', '-n'], input=step['run'], text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
            self.assertEqual(reply.returncode, 0, step['name'])
            for match in re.finditer(r"(?m)^\s*python3[^\n]* <<'PY'\n(.*?)^PY$", step['run'], re.S | re.M):
                compile(match[1], 'INERT workflow Python block', 'exec')
                blocks.append(match[1])
        self.assertGreaterEqual(len(blocks), 4)


class OfflineRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='INERT-cold-stage-workflow-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'deploy').mkdir()
        (self.root / 'runner-temp').mkdir()
        (self.root / 'deploy/release_client.py').write_text(FAKE_CLIENT)
        (self.root / 'deploy/release_orchestrator.py').write_text(FAKE_ORCHESTRATOR)
        (self.root / 'package.json').write_text('{"version":"0.14.0"}')
        self.artifact = self.root / 'INERT-NOT-A-GAME-ARCHIVE.txt'
        self.artifact.write_bytes(b'INERT TEST FIXTURE ONLY, not an archive or a game\n')
        import hashlib
        self.info = self.root / 'bundle-info.json'
        self.info.write_text(json.dumps({'version': '0.14.0', 'manifestSha256': 'f' * 64,
            'artifactSha256': hashlib.sha256(self.artifact.read_bytes()).hexdigest(),
            'artifactBytes': self.artifact.stat().st_size}))
        self.metadata = self.root / 'client-state.json'
        self.env = {'PATH': os.environ['PATH'], 'HOME': str(self.root), 'LC_ALL': 'C.UTF-8',
                    'PYTHONDONTWRITEBYTECODE': '1', 'GITHUB_REPOSITORY': 'harveyzhutiancheng-hash/fksjj-web',
                    'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                    'GITHUB_SHA': COMMIT, 'INPUT_COMMIT': COMMIT, 'INPUT_CURRENT': CURRENT,
                    'GITHUB_STEP_SUMMARY': str(self.root / 'summary.md'),
                    'GITHUB_OUTPUT': str(self.root / 'outputs.txt'),
                    'RUNNER_TEMP': str(self.root / 'runner-temp'),
                    'COLD_STAGE_READY': 'true', 'OPERATOR_READY': 'true',
                    'RELEASE_ARTIFACT': str(self.artifact), 'RELEASE_INFO': str(self.info),
                    'RELEASE_METADATA': str(self.metadata)}
        data = yaml.load(TEMPLATE.read_text(), Loader=yaml.BaseLoader)
        self.steps = data['jobs']['stage']['steps']
        self.prepare = next(x for x in self.steps if x.get('id') == 'prepare')
        self.upload = next(x for x in self.steps if 'release_client.py upload' in x.get('run', ''))
        self.wait = next(x for x in self.steps if x.get('id') == 'wait')

    def run_step(self, step, extra=None):
        env = dict(self.env)
        if 'FKSSJ_RELEASE_HMAC_KEY_HEX' in step.get('env', {}):
            env['FKSSJ_RELEASE_HMAC_KEY_HEX'] = TEST_KEY
        env.update(extra or {})
        return subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', step['run']], cwd=self.root,
                              env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=10)

    def trace(self):
        path = self.root / 'trace.jsonl'
        return [json.loads(x)['command'] for x in path.read_text().splitlines()] if path.exists() else []

    def run_three_steps(self, extra=None):
        results = []
        for step in (self.prepare, self.upload, self.wait):
            result = self.run_step(step, extra)
            results.append(result)
            if result.returncode:
                break
        return results

    def test_actual_shell_blocks_persist_bindings_then_upload_once_then_wait(self):
        results = self.run_three_steps()
        self.assertEqual([x.returncode for x in results], [0, 0, 0])
        self.assertEqual(self.trace(), ['prepare-upload', 'upload', 'wait-staged'])
        summary = (self.root / 'summary.md').read_text()
        self.assertIn(COMMIT, summary)
        self.assertIn(CURRENT, summary)
        self.assertIn('at most 300 seconds', summary)
        self.assertIn('Separately verify the old current target is unchanged', summary)
        self.assertNotIn(TEST_KEY, summary + ''.join(x.stdout + x.stderr for x in results))
        self.assertNotIn('signature', self.metadata.read_text())
        self.assertNotIn('requestId', self.metadata.read_text())
        self.assertTrue(Path(str(self.metadata) + '.upload-attempted').is_file())

    def test_upload_unknown_stops_without_wait_or_a_second_upload(self):
        results = self.run_three_steps({'TEST_UPLOAD_RESULT': 'unknown'})
        self.assertEqual([x.returncode for x in results], [0, 3])
        self.assertEqual(self.trace(), ['prepare-upload', 'upload'])
        self.assertTrue(self.metadata.is_file())
        self.assertNotIn('state=staged', (self.root / 'outputs.txt').read_text())

    def assert_wait_failure(self, outcome):
        results = self.run_three_steps({'TEST_WAIT_RESULT': outcome})
        self.assertEqual([x.returncode for x in results], [0, 0, 3])
        self.assertEqual(self.trace(), ['prepare-upload', 'upload', 'wait-staged'])
        self.assertNotIn('state=staged', (self.root / 'outputs.txt').read_text())

    def test_received_without_stage_never_retries_or_claims_staged(self):
        self.assert_wait_failure('received')

    def test_wait_unknown_never_retries_or_claims_staged(self):
        self.assert_wait_failure('unknown')

    def test_wait_rejected_never_retries_or_claims_staged(self):
        self.assert_wait_failure('rejected')

    def test_wait_timeout_never_retries_or_claims_staged(self):
        self.assert_wait_failure('timeout')

    def test_bad_bundle_binding_never_reaches_upload(self):
        value = json.loads(self.info.read_text())
        value['artifactSha256'] = 'e' * 64
        self.info.write_text(json.dumps(value))
        results = self.run_three_steps()
        self.assertEqual([x.returncode for x in results], [1])
        self.assertEqual(self.trace(), ['prepare-upload'])
        self.assertFalse(Path(str(self.metadata) + '.upload-attempted').exists())

    def test_source_readiness_and_operator_guards_stop_before_any_upload(self):
        cases = ({'COLD_STAGE_READY': ''}, {'COLD_STAGE_READY': 'false'},
                 {'OPERATOR_READY': 'false'}, {'GITHUB_EVENT_NAME': 'push'},
                 {'GITHUB_REF': 'refs/heads/other'}, {'GITHUB_REPOSITORY': 'other/repo'},
                 {'INPUT_COMMIT': 'b' * 40}, {'INPUT_CURRENT': 'releases/../unexpected'})
        for extra in cases:
            with self.subTest(extra=extra):
                result = self.run_step(self.steps[0], extra)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.trace(), [])
                self.assertFalse(self.metadata.exists())
                self.assertNotIn(TEST_KEY, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()

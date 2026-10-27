"""Client/INERT-template tests: mock transport, tiny fake ZIP data only.

No live HTTP, credentials, actual release tar, game build or service is used.
"""
import ast
import base64
import contextlib
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shlex
import ssl
import stat
import tempfile
import unittest
from unittest import mock
import zipfile

try:
    import yaml
except ImportError:
    yaml = None

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location('release_client', HERE / 'release_client.py')
client = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(client)
TEST_KEY = bytes(range(32))  # Explicit non-secret fixture, never real credential.
FAKE_DATA = b'TEST FIXTURE ONLY; deliberately not a deployable tar\n'


class ClientTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='TEST-FIXTURE-client-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root / 'TEST-FIXTURE-NOT-A-REAL-release.tar'
        self.archive.write_bytes(FAKE_DATA)
        self.metadata = self.root / 'TEST-FIXTURE-client-state.json'

    def envelope(self, operation='upload', **overrides):
        values = dict(operation=operation, commit='a' * 40, release_id='b' * 32,
                      artifact_sha256=hashlib.sha256(FAKE_DATA).hexdigest(), artifact_bytes=len(FAKE_DATA),
                      manifest_sha256='c' * 64, expected_current='releases/TEST-FIXTURE-old',
                      now=1792569600, request_id='d' * 32)
        values.update(overrides)
        return client.make_envelope(**values)

    def prepared(self):
        return client.prepare_upload(self.archive, 'a' * 40, 'b' * 32, 'c' * 64,
                                     'releases/TEST-FIXTURE-old', self.metadata)

    def run_cli(self, arguments):
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            result = client.main(arguments)
        return result, out.getvalue(), err.getvalue()

    def zip_fixture(self, entries):
        path = self.root / 'TEST-FIXTURE-artifact.zip'
        with zipfile.ZipFile(path, 'w') as zipped:
            for name, content in entries:
                zipped.writestr(name, content)
        return path

    def test_canonical_signed_protocol_and_domain_separation(self):
        envelope = self.envelope()
        canonical = client.canonical_envelope(envelope)
        self.assertNotIn(b' ', canonical)
        self.assertEqual(list(json.loads(canonical)), sorted(envelope))
        headers = client.sign_envelope(envelope, TEST_KEY)
        self.assertEqual(base64.b64decode(headers['X-FKSSJ-Envelope'], validate=True), canonical)
        expected = hmac.new(TEST_KEY, b'FKSSJ-RELEASE-V1\n' + canonical, hashlib.sha256).hexdigest()
        self.assertEqual(headers['X-FKSSJ-Signature'], expected)
        self.assertNotEqual(headers['X-FKSSJ-Signature'], hmac.new(TEST_KEY, canonical, hashlib.sha256).hexdigest())

    def test_fixed_binding_types_and_limits(self):
        original = self.envelope()
        changes = [('repo', 'attacker/repo'), ('ref', 'refs/heads/other'), ('commit', 'A' * 40),
                   ('releaseId', '../outside'), ('requestId', 'd' * 31), ('artifactBytes', True),
                   ('artifactBytes', client.MAX_ARTIFACT_BYTES + 1), ('expectedCurrent', 'absent'),
                   ('expectedCurrent', 'releases/../outside'), ('schema', True),
                   ('expiresAt', original['issuedAt'] + 301)]
        for key, value in changes:
            with self.subTest(key=key, value=value), self.assertRaises(client.ClientError):
                client.canonical_envelope(dict(original, **{key: value}))
        with self.assertRaises(client.ClientError):
            client.canonical_envelope(dict(original, extra=True))

    def test_key_format_does_not_accept_missing_newline_or_arbitrary_length(self):
        for value in ('', '00', TEST_KEY.hex() + '\n', TEST_KEY.hex().upper()):
            with self.subTest(value=value), mock.patch.dict(os.environ, {'FKSSJ_RELEASE_HMAC_KEY_HEX': value}):
                with self.assertRaises(client.ClientError):
                    client.environment_key()
        with mock.patch.dict(os.environ, {'FKSSJ_RELEASE_HMAC_KEY_HEX': TEST_KEY.hex()}):
            self.assertEqual(client.environment_key(), TEST_KEY)

    def test_upload_exact_one_request_ack_is_received_only(self):
        transport = mock.Mock(return_value=(202, json.dumps({'releaseId':'b' * 32, 'state':'received'}).encode()))
        result = client.ReleaseClient(TEST_KEY, transport=transport).send(self.envelope(), FAKE_DATA)
        self.assertEqual(result['state'], 'received')
        transport.assert_called_once()
        path, _, body = transport.call_args.args
        self.assertEqual(path, '/_fkssj-release/v1/upload')
        self.assertEqual(body, FAKE_DATA)

    def test_timeout_or_untrusted_response_never_retries_or_follows_redirect(self):
        outcomes = [TimeoutError('TEST FIXTURE timeout'),
                    (302, b'{"redirect":"https://other.invalid"}'),
                    (202, b'{"releaseId":"wrong","state":"received"}'),
                    (202, json.dumps({'releaseId':'b' * 32, 'state':'activated'}).encode()),
                    (202, b'not JSON')]
        for outcome in outcomes:
            transport = mock.Mock(side_effect=outcome) if isinstance(outcome, Exception) else mock.Mock(return_value=outcome)
            with self.subTest(outcome=outcome), self.assertRaises(client.UnknownOutcome):
                client.ReleaseClient(TEST_KEY, transport=transport).send(self.envelope(), FAKE_DATA)
            transport.assert_called_once()

    def test_payload_mismatch_rejected_before_transport(self):
        transport = mock.Mock()
        with self.assertRaisesRegex(client.ClientError, 'binding mismatch'):
            client.ReleaseClient(TEST_KEY, transport=transport).send(self.envelope(), b'wrong')
        transport.assert_not_called()

    def test_status_and_activate_zero_body_and_fresh_nonce(self):
        metadata = client.metadata_for(self.envelope())
        first, second = (client.envelope_from_metadata(metadata, op) for op in ('status', 'activate'))
        self.assertNotEqual(first['requestId'], second['requestId'])
        for envelope in (first, second):
            code = 200 if envelope['operation'] == 'status' else 202
            transport = mock.Mock(return_value=(code, json.dumps({'releaseId':'b' * 32,'state':'staged'}).encode()))
            client.ReleaseClient(TEST_KEY, transport=transport).send(envelope)
            self.assertEqual(transport.call_args.args[2], b'')
            self.assertEqual(envelope['releaseId'], metadata['bindings']['releaseId'])

    def test_placeholder_refuses_any_network_connection(self):
        with mock.patch.object(client, 'HOST', 'PLACEHOLDER.invalid'), \
                mock.patch.object(client, 'ORIGIN', 'https://PLACEHOLDER.invalid/_fkssj-release'), \
                mock.patch.object(client.http.client, 'HTTPSConnection') as connection:
            with self.assertRaises(client.ConfigurationError):
                client.https_transport('/_fkssj-release/v1/status', {}, b'')
        connection.assert_not_called()

    def test_https_transport_verifies_tls_and_sets_explicit_content_length(self):
        connection = mock.Mock()
        connection.getresponse.return_value.status = 200
        connection.getresponse.return_value.read.return_value = b'{}'
        with mock.patch.object(client, 'HOST', 'TEST-FIXTURE.test'), \
                mock.patch.object(client, 'ORIGIN', 'https://TEST-FIXTURE.test/_fkssj-release'), \
                mock.patch.object(client.http.client, 'HTTPSConnection', return_value=connection) as constructor:
            client.https_transport('/_fkssj-release/v1/status', {}, b'')
        context = constructor.call_args.kwargs['context']
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertEqual(connection.request.call_args.args[:2], ('POST', '/_fkssj-release/v1/status'))
        self.assertEqual(connection.request.call_args.kwargs['headers']['Content-Length'], '0')
        connection.request.assert_called_once()
        connection.close.assert_called_once()

    def test_prepare_is_offline_secret_free_and_never_overwrites(self):
        with mock.patch.object(client, 'environment_key', side_effect=AssertionError('must not read credentials')), \
                mock.patch.object(client, 'https_transport', side_effect=AssertionError('must not connect')):
            result = self.prepared()
        self.assertEqual(result['status'], 'prepared-only')
        metadata = json.loads(self.metadata.read_text())
        self.assertEqual(metadata['bindings']['artifactSha256'], hashlib.sha256(FAKE_DATA).hexdigest())
        self.assertNotIn(TEST_KEY.hex(), self.metadata.read_text())
        original = self.metadata.read_bytes()
        with self.assertRaises(FileExistsError):
            self.prepared()
        self.assertEqual(self.metadata.read_bytes(), original)

    def test_cli_unknown_retains_metadata_and_prevents_second_upload_or_activate(self):
        self.prepared()
        with mock.patch.dict(os.environ, {'FKSSJ_RELEASE_HMAC_KEY_HEX':TEST_KEY.hex()}), \
                mock.patch.object(client, 'https_transport', side_effect=TimeoutError('TEST FIXTURE secretish error')) as transport:
            for operation in ('upload', 'activate'):
                args = [operation, '--metadata', str(self.metadata)]
                if operation == 'upload':
                    args += ['--artifact', str(self.archive)]
                code, _, error = self.run_cli(args)
                self.assertEqual(code, 3)
                self.assertEqual(json.loads(error)['status'], 'unknown')
                self.assertNotIn('secretish', error)
                self.assertEqual(json.loads(error)['metadata'], str(self.metadata))
                self.assertTrue(Path(str(self.metadata) + '.' + operation + '-attempted').is_file())
                code, _, _ = self.run_cli(args)
                self.assertEqual(code, 1)
            self.assertEqual(transport.call_count, 2)  # one upload, one explicit activate; no retries
        self.assertTrue(self.metadata.exists())

    def test_cli_status_does_not_mutate_metadata_or_send_artifact(self):
        self.prepared()
        before = self.metadata.read_bytes()
        transport = mock.Mock(return_value=(200, json.dumps({'releaseId':'b' * 32,'state':'received'}).encode()))
        with mock.patch.dict(os.environ, {'FKSSJ_RELEASE_HMAC_KEY_HEX':TEST_KEY.hex()}), \
                mock.patch.object(client, 'https_transport', transport):
            code, output, _ = self.run_cli(['status','--metadata',str(self.metadata)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)['state'], 'received')
        self.assertEqual(self.metadata.read_bytes(), before)
        self.assertEqual(transport.call_args.args[2], b'')

    def test_zip_extracts_one_fake_data_file_only_and_never_overwrites(self):
        zipped = self.zip_fixture([('release.tar', FAKE_DATA)])
        output = self.root / 'TEST-FIXTURE-extracted-data'
        result = client.extract_artifact(zipped, output)
        self.assertEqual(result['status'], 'extracted-data-only')
        self.assertEqual(output.read_bytes(), FAKE_DATA)
        with self.assertRaises(FileExistsError):
            client.extract_artifact(zipped, output)

    def test_zip_rejects_traversal_extra_duplicate_or_link(self):
        link = zipfile.ZipInfo('release.tar')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        samples = [[('../release.tar',FAKE_DATA)], [('folder/release.tar',FAKE_DATA)],
                   [('release.tar',FAKE_DATA), ('extra',b'TEST FIXTURE')],
                   [('release.tar',FAKE_DATA), ('release.tar',FAKE_DATA)], [(link,b'/outside')]]
        for entries in samples:
            with self.subTest(entries=entries), self.assertRaises(client.ClientError):
                with mock.patch('warnings.warn'):
                    zipped = self.zip_fixture(entries)
                client.extract_artifact(zipped, self.root / 'TEST-FIXTURE-output')
            self.assertFalse((self.root / 'TEST-FIXTURE-output').exists())

    def test_zip_size_limit_and_local_links_rejected(self):
        zipped = self.zip_fixture([('release.tar',FAKE_DATA)])
        with mock.patch.object(client, 'MAX_ARTIFACT_BYTES', len(FAKE_DATA) - 1):
            with self.assertRaises(client.ClientError):
                client.extract_artifact(zipped, self.root / 'TEST-FIXTURE-output')
        linked = self.root / 'TEST-FIXTURE-link'
        linked.symlink_to(zipped)
        with self.assertRaises(OSError):
            client.extract_artifact(linked, self.root / 'TEST-FIXTURE-output')
        linked.unlink()
        os.link(zipped, linked)
        with self.assertRaises(client.ClientError):
            client.extract_artifact(linked, self.root / 'TEST-FIXTURE-output')


@unittest.skipIf(yaml is None, 'PyYAML unavailable; no dependency is installed by tests')
class TemplateContractTests(unittest.TestCase):
    def workflow(self):
        return yaml.load((HERE / 'templates/github-release.yml').read_text(), Loader=yaml.BaseLoader)

    def test_manual_only_fixed_main_default_stage_and_separate_activation_gate(self):
        workflow = self.workflow()
        self.assertEqual(set(workflow['on']), {'workflow_dispatch'})
        inputs = workflow['on']['workflow_dispatch']['inputs']
        self.assertEqual(set(inputs), {'commit', 'expected_current', 'mode'})
        self.assertEqual(inputs['mode']['type'], 'choice')
        self.assertEqual(inputs['mode']['default'], 'stage')
        self.assertEqual(inputs['mode']['options'], ['stage', 'activate'])
        self.assertEqual(workflow['permissions'], {})
        self.assertEqual(workflow['concurrency']['cancel-in-progress'], 'false')
        jobs = workflow['jobs']
        self.assertEqual(set(jobs), {'stage', 'activate'})
        self.assertNotEqual(jobs['stage']['environment'], jobs['activate']['environment'])
        self.assertEqual(jobs['activate']['needs'], 'stage')
        for condition in ("inputs.mode == 'activate'", "needs.stage.result == 'success'"):
            self.assertIn(condition, jobs['activate']['if'])
        self.assertNotIn('READY', jobs['activate']['if'])
        self.assertIn("github.ref == 'refs/heads/main'", jobs['stage']['if'])
        for job in jobs.values():
            self.assertEqual(job['permissions'], {'contents': 'read'})
            for step in job['steps']:
                self.assertNotIn('continue-on-error', step)
                if 'uses' in step:
                    self.assertEqual(step['uses'], 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683')
                    self.assertEqual(step['with']['persist-credentials'], 'false')
                    self.assertEqual(step['with']['ref'], '${{ github.sha }}')
        activation = '\n'.join(step.get('run', '') for step in jobs['activate']['steps'])
        self.assertNotIn('package-static.mjs', activation)
        self.assertNotIn('release_client.py upload', activation)
        self.assertNotIn('npm ', activation)
        self.assertIn('release_orchestrator.py activate', activation)
        self.assertIn("os.environ.get('ACTIVATION_READY') != 'true'", activation)
        self.assertIn("os.environ.get('STAGED_STATE') != 'staged'", activation)

    def test_embedded_python_and_real_cli_argument_contract_without_execution(self):
        # Import only stdlib protocol/helper definitions. All operations that
        # could build a fixture archive, write a file or use HTTP are replaced.
        spec = importlib.util.spec_from_file_location('TEST_FIXTURE_orchestrator', HERE / 'release_orchestrator.py')
        orchestrator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(orchestrator)
        parsed, commands = 0, []
        for job in self.workflow()['jobs'].values():
            for step in job['steps']:
                run = step.get('run', '')
                for embedded in re.findall(r"python3 - <<'PY'\n(.*?)\nPY", run, re.S):
                    tree = ast.parse(embedded)
                    parsed += 1
                    for node in ast.walk(tree):
                        if isinstance(node, ast.List) and len(node.elts) >= 4:
                            values = [part.value if isinstance(part, ast.Constant) else 'TEST-FIXTURE-ARG'
                                      for part in node.elts]
                            if values[:4] == ['python3', '-I', '-B', 'deploy/release_client.py']:
                                commands.append((values[3], values[4:]))
                joined = run.replace('\\\n', '')
                for line in joined.splitlines():
                    if line.strip().startswith(('python3 -I -B deploy/release_client.py ',
                                                'python3 -I -B deploy/release_orchestrator.py ')):
                        values = shlex.split(line)
                        commands.append((values[3], values[4:]))
        self.assertGreaterEqual(parsed, 6)
        operations = []
        for executable, args in commands:
            operations.append((executable, args[0]))
            with self.subTest(executable=executable, arguments=args), contextlib.redirect_stdout(io.StringIO()):
                if executable.endswith('release_client.py'):
                    with mock.patch.object(client, 'prepare_upload', return_value={}), \
                            mock.patch.object(client, 'environment_key', return_value=TEST_KEY), \
                            mock.patch.object(client, 'read_regular', return_value=b'{}'), \
                            mock.patch.object(client, 'envelope_from_metadata', return_value={
                                'artifactBytes': 2, 'artifactSha256': hashlib.sha256(b'{}').hexdigest()}), \
                            mock.patch.object(client, 'write_exclusive'), \
                            mock.patch.object(client.ReleaseClient, 'send', return_value={}):
                        self.assertEqual(client.main(args), 0)
                else:
                    with mock.patch.object(orchestrator, 'bundle', return_value={}) as bundle, \
                            mock.patch.object(orchestrator, 'orchestrate', return_value={}) as execute, \
                            mock.patch.object(orchestrator.client, 'environment_key', return_value=TEST_KEY), \
                            mock.patch.object(orchestrator.client, 'read_regular', return_value=b'{}'):
                        self.assertEqual(orchestrator.main(args), 0)
                        if args[0] == 'bundle':
                            bundle.assert_called_once()
                            execute.assert_not_called()
                        else:
                            execute.assert_called_once()
                            bundle.assert_not_called()
                            self.assertEqual(execute.call_args.kwargs['mode'],
                                             'stage' if args[0] == 'wait' else 'activate')
        self.assertEqual(operations.count(('deploy/release_client.py', 'upload')), 1)
        self.assertEqual(operations.count(('deploy/release_orchestrator.py', 'activate')), 1)
        self.assertIn(('deploy/release_client.py', 'prepare-upload'), operations)
        self.assertIn(('deploy/release_orchestrator.py', 'bundle'), operations)
        self.assertIn(('deploy/release_orchestrator.py', 'wait'), operations)

    def test_future_pipeline_order_and_pre_request_recovery_bindings(self):
        stage = self.workflow()['jobs']['stage']
        runs = [step.get('run', '') for step in stage['steps']]
        required = ['npm ci --ignore-scripts', 'npm run test:source',
                    'api.test_api api.test_boundaries', 'npm run test:http',
                    'node deploy/package-static.mjs', 'release_orchestrator.py bundle',
                    "'prepare-upload'", 'release_client.py upload', 'release_orchestrator.py wait']
        positions = [next(index for index, run in enumerate(runs) if phrase in run) for phrase in required]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn('npm run build', '\n'.join(runs))
        prepare = runs[positions[-3]]
        self.assertIn('GITHUB_STEP_SUMMARY', prepare)
        self.assertIn('metadata_json=', prepare)
        for field in ('artifactSha256', 'artifactBytes', 'manifestSha256'):
            self.assertIn(field, prepare)
        self.assertIn('metadata_json', stage['outputs'])
        # Build/test/bundle preparation has no HMAC key in its environment.
        for step in stage['steps'][:positions[-2]]:
            self.assertNotIn('FKSSJ_RELEASE_HMAC_KEY_HEX', step.get('env', {}))

    def test_real_precheckout_guard_rejects_changed_context_before_any_work(self):
        run = self.workflow()['jobs']['stage']['steps'][0]['run']
        embedded = re.search(r"python3 - <<'PY'\n(.*?)\nPY", run, re.S).group(1)
        code = compile(embedded, '<TEST-FIXTURE-template-preflight>', 'exec')
        environment = {'INPUT_COMMIT': 'a' * 40, 'INPUT_CURRENT': 'releases/TEST-FIXTURE-old',
                       'INPUT_MODE': 'stage', 'ACTIVATION_READY': '',
                       'GITHUB_REPOSITORY': 'harveyzhutiancheng-hash/fksjj-web',
                       'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': 'a' * 40}
        for key, value in (('INPUT_COMMIT', 'b' * 40), ('INPUT_COMMIT', 'A' * 40),
                           ('GITHUB_REF', 'refs/heads/other'), ('GITHUB_REPOSITORY', 'other/repo'),
                           ('INPUT_CURRENT', 'releases/../outside'), ('INPUT_MODE', 'force')):
            with self.subTest(key=key, value=value), \
                    mock.patch.dict(os.environ, dict(environment, **{key: value}), clear=True), \
                    mock.patch('tempfile.mkdtemp', side_effect=AssertionError('invalid guard reached file writes')):
                with self.assertRaises(SystemExit):
                    exec(code, {'__name__': '__test__'})

    def test_activation_missing_readiness_or_stage_result_is_an_explicit_failure(self):
        steps = self.workflow()['jobs']['activate']['steps']
        restore = next(step for step in steps if step.get('id') == 'restore')
        embedded = re.search(r"python3 - <<'PY'\n(.*?)\nPY", restore['run'], re.S).group(1)
        code = compile(embedded, '<TEST-FIXTURE-activation-readiness>', 'exec')
        for environment in ({'ACTIVATION_READY': '', 'STAGED_STATE': 'staged'},
                            {'ACTIVATION_READY': 'true', 'STAGED_STATE': 'received'}):
            with self.subTest(environment=environment), \
                    mock.patch.dict(os.environ, environment, clear=True), \
                    mock.patch('subprocess.check_output', side_effect=AssertionError('guard must fail before Git/HTTP')):
                with self.assertRaises(SystemExit):
                    exec(code, {'__name__': '__test__'})

    def test_exact_existing_https_paths_service_contract_and_inert_timer(self):
        from deploy import nginx_status_only
        added = (HERE / 'templates/nginx-release.conf').read_text()
        self.assertNotIn('location = /_fkssj-release/v1/status', added)
        nginx = added + '\n' + nginx_status_only.LOCATION.decode()
        for operation in ('upload','status','activate'):
            self.assertIn('location = /_fkssj-release/v1/' + operation, nginx)
            self.assertIn('proxy_pass http://127.0.0.1:8790/v1/' + operation + ';', nginx)
        self.assertEqual(nginx.count('proxy_next_upstream off;'), 3)
        self.assertNotRegex(nginx, r'(?m)^\s*(listen|server_name|ssl_certificate)\b')
        for template, user, role in (('fkssj-release.service','fkssj-release','receiver'),
                                      ('fkssj-stage-publisher.service','fkssj-deploy','stage-worker')):
            unit = (HERE / 'templates' / template).read_text()
            self.assertIn('User=' + user, unit)
            self.assertIn('Group=fkssj-release', unit)
            self.assertIn('UMask=0007', unit)
            entry = 'release_channel_stage.py' if role == 'stage-worker' else 'release_channel.py'
            self.assertIn('ExecStart=/usr/bin/python3 -I -B /opt/fkssj-release/' + entry + ' ' + role, unit)
            self.assertIn('ProtectSystem=strict', unit)
        publisher = (HERE / 'templates/fkssj-stage-publisher.service').read_text()
        self.assertIn('-/srv/fkssj/api-releases', publisher)
        timer = (HERE / 'templates/fkssj-publisher.timer').read_text()
        self.assertIn('OnUnitInactiveSec=10s', timer)
        self.assertIn('Unit=fkssj-publisher.service', timer)


if __name__ == '__main__':
    unittest.main()

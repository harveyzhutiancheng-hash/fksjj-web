"""Orchestration tests using PUBLIC TEST keys and inert temporary fixtures.

Scripted transports and clocks exercise state transitions without real waits.
Two integrations use real loopback channel HTTP; their final-site fetch is
injected fixture data, never evidence about a deployed site or backend.
No npm, build, game packager, real release, remote service or real key is used.
"""

import base64
import hashlib
import hmac
import http.client
import io
import json
import os
from pathlib import Path
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

from deploy import release_orchestrator as orchestrator
from deploy import test_release_channel as channel_fixture
from deploy import test_static_release as static_fixture


TEST_KEY = b'TEST-ONLY-NOT-A-REAL-KEY-0000000'
TEST_DATA = b'INERT TEST FIXTURE ONLY, not a real game archive\n'
COMMIT = 'a' * 40
RELEASE_ID = 'b' * 32
INSTANT = 1792569900


def sha(data):
    return hashlib.sha256(data).hexdigest()


class FakeClock:
    def __init__(self):
        self.value = 0.0
        self.sleeps = []

    def __call__(self):
        return self.value

    def sleep(self, seconds):
        if seconds <= 0:
            raise AssertionError('TEST wait must make positive bounded progress')
        self.sleeps.append(seconds)
        self.value += seconds


class ScriptedTransport:
    """Validate the actual client's signed bytes before returning a fixture."""

    def __init__(self, steps):
        self.steps = list(steps)
        self.calls = []

    def __call__(self, path, headers, body):
        raw = base64.b64decode(headers['X-FKSSJ-Envelope'], validate=True)
        envelope = json.loads(raw)
        if raw != orchestrator.client.canonical_envelope(envelope):
            raise AssertionError('Noncanonical TEST envelope')
        expected = hmac.new(TEST_KEY, b'FKSSJ-RELEASE-V1\n' + raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(headers['X-FKSSJ-Signature'], expected):
            raise AssertionError('Wrong TEST signature')
        if path != orchestrator.client.BASE_PATH + '/v1/' + envelope['operation']:
            raise AssertionError('Wrong fixed operation route')
        if body != b'':
            raise AssertionError('Status and activation bodies must be empty')
        self.calls.append((envelope, body))
        if not self.steps:
            raise AssertionError('Unexpected extra TEST network request')
        operation, reply = self.steps.pop(0)
        if envelope['operation'] != operation:
            raise AssertionError('Wrong TEST pipeline operation order')
        if isinstance(reply, Exception):
            raise reply
        if callable(reply):
            reply = reply(envelope)
        status = 200 if operation == 'status' else 202
        return status, json.dumps(reply, sort_keys=True).encode()


class OrchestratorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='TEST-FIXTURE-orchestrator-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.manifest = json.dumps({'version': '0.14.0', 'TEST': 'inert final-site response'},
                                   sort_keys=True, separators=(',', ':')).encode()
        envelope = orchestrator.client.make_envelope(
            'upload', COMMIT, RELEASE_ID, sha(TEST_DATA), len(TEST_DATA), sha(self.manifest),
            'releases/old', now=INSTANT, request_id='c' * 32)
        self.metadata = orchestrator.client.metadata_for(envelope)
        self.metadata_path = self.base / 'TEST-FIXTURE-client-state.json'
        self.metadata_path.write_text(json.dumps(self.metadata, sort_keys=True))
        self.clock = FakeClock()
        patcher = mock.patch.object(orchestrator.client.time, 'time', return_value=INSTANT)
        patcher.start()
        self.addCleanup(patcher.stop)

    def status(self, state='staged', *, operation='upload', op_state='completed',
               error=None, request_id='c' * 32, release_id=RELEASE_ID):
        return dict(releaseId=release_id, state=state,
                    lastOperation=dict(requestId=request_id, operation=operation, state=op_state, error=error))

    def instance(self, steps):
        transport = ScriptedTransport(steps)
        return orchestrator.client.ReleaseClient(TEST_KEY, transport=transport), transport

    def wait(self, instance, **overrides):
        values = dict(timeout=3, interval=1, clock=self.clock, sleep=self.clock.sleep)
        values.update(overrides)
        return orchestrator.wait_for_release(instance, self.metadata, **values)

    def run_orchestration(self, instance, **overrides):
        values = dict(timeout=3, interval=1, clock=self.clock, sleep=self.clock.sleep)
        values.update(overrides)
        return orchestrator.orchestrate(instance, self.metadata, self.metadata_path, **values)

    def marker(self):
        return Path(str(self.metadata_path) + '.activate-attempted')

    def test_wait_for_staged_polls_with_fresh_signed_nonces_and_empty_bodies(self):
        instance, transport = self.instance([
            ('status', self.status('received', op_state='queued')),
            ('status', self.status('received', op_state='processing')),
            ('status', self.status())])
        result = self.wait(instance)
        self.assertEqual(result['state'], 'staged')
        self.assertEqual(self.clock.sleeps, [1, 1])
        nonces = [envelope['requestId'] for envelope, _ in transport.calls]
        self.assertEqual(len(nonces), len(set(nonces)))
        for envelope, body in transport.calls:
            self.assertEqual(envelope['operation'], 'status')
            self.assertEqual(body, b'')
            for field, value in self.metadata['bindings'].items():
                self.assertEqual(envelope[field], value)

    def test_wait_reports_known_archive_rejection_without_further_polling(self):
        instance, transport = self.instance([
            ('status', self.status('rejected', op_state='rejected', error='archive_member'))])
        with self.assertRaisesRegex(orchestrator.OrchestrationFailure, 'release_operation_rejected'):
            self.wait(instance)
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(self.clock.sleeps, [])

    def test_wait_unknown_or_unexpected_state_stops_without_retry(self):
        for state in ('uncertain', 'unknown', 'activated', 'unexpected-test-state'):
            with self.subTest(state=state):
                instance, transport = self.instance([('status', self.status(state))])
                with self.assertRaises(orchestrator.OrchestrationUnknown):
                    self.wait(instance)
                self.assertEqual(len(transport.calls), 1)

    def test_wait_has_bounded_timeout_using_fake_clock(self):
        received = self.status('received', op_state='queued')
        instance, transport = self.instance([('status', received)] * 8)
        with self.assertRaises(orchestrator.OrchestrationTimeout):
            self.wait(instance)
        self.assertLessEqual(self.clock.value, 3)
        self.assertLessEqual(len(transport.calls), 4)
        self.assertTrue(self.clock.sleeps)

    def test_wait_wrong_release_binding_is_unknown_and_never_continues(self):
        instance, transport = self.instance([('status', self.status(release_id='d' * 32))])
        with self.assertRaises(orchestrator.OrchestrationUnknown):
            self.wait(instance)
        self.assertEqual(len(transport.calls), 1)

    def test_wait_transport_unknown_is_not_retried(self):
        instance, transport = self.instance([('status', TimeoutError('TEST status response lost'))])
        with self.assertRaises(orchestrator.OrchestrationUnknown):
            self.wait(instance)
        self.assertEqual(len(transport.calls), 1)

    def test_default_stage_never_activates_or_fetches_live_site(self):
        instance, transport = self.instance([('status', self.status())])
        fetch = mock.Mock(side_effect=AssertionError('Default stage must not fetch final site'))
        before = self.metadata_path.read_bytes()
        result = self.run_orchestration(instance, fetch=fetch)
        self.assertEqual(result['state'], 'staged')
        self.assertEqual([value['operation'] for value, _ in transport.calls], ['status'])
        self.assertFalse(self.marker().exists())
        self.assertEqual(self.metadata_path.read_bytes(), before)
        fetch.assert_not_called()

    def test_unsupported_expected_version_stops_before_any_activation_or_status(self):
        instance, transport = self.instance([])
        fetch = mock.Mock()
        with self.assertRaisesRegex(orchestrator.OrchestrationFailure, 'unsupported_expected_version_before_activation'):
            self.run_orchestration(instance, mode='activate', expected_version='0.15.0', fetch=fetch)
        self.assertEqual(transport.calls, [])
        self.assertFalse(self.marker().exists())
        fetch.assert_not_called()

    def test_explicit_activation_pipeline_is_ordered_and_uses_one_bound_nonce(self):
        events, activation_ids = [], []

        def acknowledge(envelope):
            events.append('activate')
            activation_ids.append(envelope['requestId'])
            self.assertTrue(self.marker().is_file(), 'Mutation marker must precede request')
            saved = json.loads(self.marker().read_text())
            self.assertEqual(saved, envelope)
            return dict(releaseId=RELEASE_ID, state='activation_queued', requestId=envelope['requestId'])

        def staged(_):
            events.append('staged')
            return self.status()

        def queued(_):
            events.append('activation-pending')
            return self.status(operation='activate', op_state='queued', request_id=activation_ids[0])

        def activated(_):
            events.append('activated')
            return self.status('activated', operation='activate', request_id=activation_ids[0])

        def fetch(path):
            events.append('fetch-manifest')
            self.assertEqual(path, '/release.json?fkssj_release=' + RELEASE_ID)
            return 200, self.manifest

        instance, transport = self.instance([('status', staged), ('activate', acknowledge),
                                               ('status', queued), ('status', activated)])
        self.run_orchestration(instance, mode='activate', fetch=fetch)
        self.assertEqual(events, ['staged', 'activate', 'activation-pending', 'activated', 'fetch-manifest'])
        self.assertEqual(len(activation_ids), 1)
        nonces = [envelope['requestId'] for envelope, _ in transport.calls]
        self.assertEqual(len(nonces), len(set(nonces)))
        self.assertTrue(self.marker().is_file())

    def test_unknown_activation_retains_marker_and_never_retries_or_fetches(self):
        instance, transport = self.instance([('status', self.status()),
                                               ('activate', TimeoutError('TEST activation response lost'))])
        fetch = mock.Mock()
        with self.assertRaises(orchestrator.OrchestrationUnknown):
            self.run_orchestration(instance, mode='activate', fetch=fetch)
        self.assertEqual([value['operation'] for value, _ in transport.calls], ['status', 'activate'])
        self.assertTrue(self.marker().is_file())
        fetch.assert_not_called()

    def test_marker_parent_fsync_failure_prevents_activation_send(self):
        instance, transport = self.instance([('status', self.status())])
        fetch, synced = mock.Mock(), []
        real_fsync = os.fsync

        def fail_directory_sync(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                synced.append('parent')
                raise OSError('INERT TEST parent fsync failed')
            synced.append('file')
            return real_fsync(fd)

        with mock.patch.object(orchestrator.os, 'fsync', side_effect=fail_directory_sync):
            with self.assertRaisesRegex(orchestrator.OrchestrationUnknown, 'activation_marker_unavailable'):
                self.run_orchestration(instance, mode='activate', fetch=fetch)
        self.assertEqual(synced, ['file', 'parent'])
        self.assertEqual([value['operation'] for value, _ in transport.calls], ['status'])
        self.assertTrue(self.marker().is_file(), 'Failed durability confirmation retains attempt evidence')
        self.assertEqual(stat.S_IMODE(self.marker().stat().st_mode), 0o600)
        self.assertEqual(json.loads(self.marker().read_text())['operation'], 'activate')
        fetch.assert_not_called()

    def test_existing_activation_marker_prevents_second_mutation(self):
        self.marker().write_bytes(b'INERT TEST prior attempt evidence')
        instance, transport = self.instance([('status', self.status())])
        with self.assertRaises((orchestrator.OrchestrationFailure, OSError)):
            self.run_orchestration(instance, mode='activate', fetch=mock.Mock())
        self.assertTrue(all(value['operation'] == 'status' for value, _ in transport.calls))
        self.assertEqual(self.marker().read_bytes(), b'INERT TEST prior attempt evidence')

    def test_activation_api_gate_rejection_is_clear_and_stops(self):
        ids = []

        def ack(envelope):
            ids.append(envelope['requestId'])
            return dict(releaseId=RELEASE_ID, state='activation_queued', requestId=ids[0])

        def rejected(_):
            return self.status(operation='activate', op_state='rejected', error='api_gate', request_id=ids[0])

        instance, transport = self.instance([('status', self.status()), ('activate', ack), ('status', rejected)])
        fetch = mock.Mock()
        with self.assertRaisesRegex(orchestrator.OrchestrationFailure, 'api_gate'):
            self.run_orchestration(instance, mode='activate', fetch=fetch)
        self.assertEqual(sum(value['operation'] == 'activate' for value, _ in transport.calls), 1)
        self.assertTrue(self.marker().is_file())
        fetch.assert_not_called()

    def test_activation_acknowledgement_wrong_nonce_or_state_is_unknown(self):
        replies = [dict(releaseId=RELEASE_ID, state='activation_queued', requestId='e' * 32),
                   lambda envelope: dict(releaseId=RELEASE_ID, state='activated', requestId=envelope['requestId'])]
        for index, reply in enumerate(replies):
            with self.subTest(reply=index):
                self.metadata_path = self.base / f'TEST-FIXTURE-state-{index}.json'
                self.metadata_path.write_text(json.dumps(self.metadata))
                instance, transport = self.instance([('status', self.status()), ('activate', reply)])
                fetch = mock.Mock()
                with self.assertRaises(orchestrator.OrchestrationUnknown):
                    self.run_orchestration(instance, mode='activate', fetch=fetch)
                self.assertEqual(len(transport.calls), 2)
                fetch.assert_not_called()

    def test_activated_status_from_different_nonce_cannot_verify_final_site(self):
        def ack(envelope):
            return dict(releaseId=RELEASE_ID, state='activation_queued', requestId=envelope['requestId'])

        wrong = self.status('activated', operation='activate', request_id='f' * 32)
        instance, transport = self.instance([('status', self.status()), ('activate', ack), ('status', wrong)])
        fetch = mock.Mock()
        with self.assertRaises(orchestrator.OrchestrationUnknown):
            self.run_orchestration(instance, mode='activate', fetch=fetch)
        self.assertEqual(sum(value['operation'] == 'activate' for value, _ in transport.calls), 1)
        fetch.assert_not_called()

    def test_final_manifest_matches_exact_hash_version_and_release_query(self):
        fetch = mock.Mock(return_value=(200, self.manifest))
        orchestrator.verify_live(self.metadata, '0.14.0', fetch=fetch)
        fetch.assert_called_once_with('/release.json?fkssj_release=' + RELEASE_ID)

    def test_final_manifest_wrong_hash_version_or_http_status_is_rejected(self):
        cases = [(self.manifest + b'\n', '0.14.0', 200),
                 (self.manifest, '0.15.0', 200), (self.manifest, '0.14.0', 302)]
        for data, version, code in cases:
            with self.subTest(version=version, code=code, data_sha=sha(data)):
                with self.assertRaises((orchestrator.OrchestrationFailure, orchestrator.OrchestrationUnknown)):
                    orchestrator.verify_live(self.metadata, version, fetch=lambda _: (code, data))

    def test_public_manifest_placeholder_refuses_network_connection(self):
        with mock.patch.object(orchestrator.client, 'HOST', 'PLACEHOLDER.invalid'), \
                mock.patch.object(orchestrator.client, 'ORIGIN', 'https://PLACEHOLDER.invalid/_fkssj-release'), \
                mock.patch.object(orchestrator.http.client, 'HTTPSConnection') as connection:
            with self.assertRaisesRegex(orchestrator.OrchestrationFailure, 'placeholder_not_configured'):
                orchestrator.https_manifest('/release.json?fkssj_release=' + RELEASE_ID)
        connection.assert_not_called()

    def test_public_manifest_transport_uses_fixed_tls_host_and_bounded_get(self):
        connection = mock.Mock()
        connection.getresponse.return_value.status = 200
        connection.getresponse.return_value.read.return_value = self.manifest
        path = '/release.json?fkssj_release=' + RELEASE_ID
        with mock.patch.object(orchestrator.client, 'HOST', 'TEST-FIXTURE.test'), \
                mock.patch.object(orchestrator.client, 'ORIGIN', 'https://TEST-FIXTURE.test/_fkssj-release'), \
                mock.patch.object(orchestrator.http.client, 'HTTPSConnection', return_value=connection) as constructor:
            self.assertEqual(orchestrator.https_manifest(path), (200, self.manifest))
        self.assertEqual(constructor.call_args.args[:2], ('TEST-FIXTURE.test', 443))
        context = constructor.call_args.kwargs['context']
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertEqual(connection.request.call_args.args, ('GET', path))
        self.assertEqual(connection.request.call_args.kwargs['headers']['Cache-Control'], 'no-cache')
        connection.getresponse.return_value.read.assert_called_once_with(256 * 1024 + 1)
        connection.request.assert_called_once()
        connection.close.assert_called_once()

    def test_bounded_client_sends_fixture_key_only_in_stdin_to_fixed_child(self):
        envelope = orchestrator.client.envelope_from_metadata(self.metadata, 'status')
        expected = self.status()
        completed = subprocess.CompletedProcess([], 0, json.dumps(expected).encode())
        with mock.patch.object(orchestrator.subprocess, 'run', return_value=completed) as run:
            result = orchestrator.BoundedClient(TEST_KEY).send(envelope, timeout=2.5)
        self.assertEqual(result, expected)
        run.assert_called_once()
        argv = run.call_args.args[0]
        self.assertEqual(argv, [sys.executable, '-I', '-B', str(Path(orchestrator.__file__).absolute()), '_http'])
        self.assertNotIn(TEST_KEY.hex(), repr(argv))
        options = run.call_args.kwargs
        self.assertEqual(json.loads(options['input']), {'kind': 'signed', 'key': TEST_KEY.hex(), 'envelope': envelope})
        self.assertEqual(options['timeout'], 2.5)
        self.assertEqual(options['env'], {'LC_ALL': 'C'})
        self.assertEqual(options['stdout'], subprocess.PIPE)
        self.assertEqual(options['stderr'], subprocess.DEVNULL)
        self.assertFalse(options['check'])

    def test_bounded_child_timeout_is_unknown_after_one_attempt(self):
        envelope = orchestrator.client.envelope_from_metadata(self.metadata, 'activate')
        timeout = subprocess.TimeoutExpired(['INERT-TEST-CHILD'], 0.1)
        with mock.patch.object(orchestrator.subprocess, 'run', side_effect=timeout) as run:
            with self.assertRaisesRegex(orchestrator.client.UnknownOutcome, 'exchange_deadline_unknown_no_retry'):
                orchestrator.BoundedClient(TEST_KEY).send(envelope, timeout=0.1)
        run.assert_called_once()

    def test_failed_oversized_or_malformed_child_output_is_unknown_without_retry(self):
        replies = [subprocess.CompletedProcess([], 3, b'{}'),
                   subprocess.CompletedProcess([], 0, b'x' * (512 * 1024 + 1)),
                   subprocess.CompletedProcess([], 0, b'INERT TEST not JSON'),
                   subprocess.CompletedProcess([], 0, b'{"duplicate":1,"duplicate":2}')]
        envelope = orchestrator.client.envelope_from_metadata(self.metadata, 'status')
        for index, reply in enumerate(replies):
            with self.subTest(reply=index):
                with mock.patch.object(orchestrator.subprocess, 'run', return_value=reply) as run:
                    with self.assertRaises(orchestrator.client.UnknownOutcome):
                        orchestrator.BoundedClient(TEST_KEY).send(envelope, timeout=1)
                run.assert_called_once()

    def test_production_status_child_receives_remaining_deadline_capped_at_thirty(self):
        for budget, expected in ((3, [3, 1.75]), (60, [30, 30])):
            with self.subTest(budget=budget):
                clock, limits = FakeClock(), []

                def exchange(message, timeout):
                    limits.append(timeout)
                    self.assertEqual(message['kind'], 'signed')
                    self.assertEqual(message['envelope']['operation'], 'status')
                    if len(limits) == 1:
                        clock.value += 0.25  # Simulated child runtime consumes the poll budget.
                        return self.status('received', op_state='queued')
                    return self.status()

                with mock.patch.object(orchestrator, 'bounded_exchange', side_effect=exchange):
                    result = orchestrator.wait_for_release(orchestrator.BoundedClient(TEST_KEY), self.metadata,
                                                           timeout=budget, interval=1, clock=clock, sleep=clock.sleep)
                self.assertEqual(result['state'], 'staged')
                self.assertEqual(limits, expected)

    def test_public_child_bad_base64_oversize_and_unknown_stop_verification(self):
        path = '/release.json?fkssj_release=' + RELEASE_ID
        cases = [({'httpStatus': 200, 'body': 'invalid***'}, orchestrator.OrchestrationUnknown),
                 ({'httpStatus': 200, 'body': 7}, orchestrator.OrchestrationUnknown),
                 ({'httpStatus': 200, 'body': base64.b64encode(b'x' * (256 * 1024 + 1)).decode()},
                  orchestrator.OrchestrationFailure)]
        for reply, error_type in cases:
            with self.subTest(error_type=error_type.__name__, body_type=type(reply['body']).__name__):
                with mock.patch.object(orchestrator, 'bounded_exchange', return_value=reply) as exchange:
                    with self.assertRaises(error_type):
                        orchestrator.verify_live(self.metadata, '0.14.0')
                exchange.assert_called_once_with({'kind': 'manifest', 'path': path}, 30)
        with mock.patch.object(orchestrator, 'bounded_exchange',
                               side_effect=orchestrator.client.UnknownOutcome('INERT TEST public child unknown')) as exchange:
            with self.assertRaisesRegex(orchestrator.OrchestrationUnknown, 'public_verification_exchange_unknown'):
                orchestrator.verify_live(self.metadata, '0.14.0')
        exchange.assert_called_once_with({'kind': 'manifest', 'path': path}, 30)

    def test_real_nonnetwork_fixture_child_timeout_is_killed_and_reaped(self):
        """Inject an inert blocking child; no production HTTP helper is run."""
        real_run = subprocess.run
        pid_file = self.base / 'TEST-FIXTURE-child.pid'
        code = ('import os,sys,time; '
                'open(sys.argv[1],"w").write(str(os.getpid())); '
                'time.sleep(2)')

        def run_inert_child(argv, **options):
            self.assertEqual(argv[-1], '_http')
            return real_run([sys.executable, '-I', '-B', '-c', code, str(pid_file)], **options)

        with mock.patch.object(orchestrator.subprocess, 'run', side_effect=run_inert_child) as run:
            with self.assertRaises(orchestrator.client.UnknownOutcome):
                orchestrator.bounded_exchange({'kind': 'INERT TEST nonnetwork blocker'}, 0.5)
        run.assert_called_once()
        self.assertEqual(run.call_args.kwargs['timeout'], 0.5)
        pid = int(pid_file.read_text())
        with self.assertRaises(ChildProcessError):
            os.waitpid(pid, os.WNOHANG)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)


class BundleFixtureTests(unittest.TestCase):
    def setUp(self):
        self.fixture = static_fixture.StaticReleaseTests(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.output = self.fixture.base / 'TEST-FIXTURE-INERT-release.tar'

    def test_bundle_contains_only_verified_inert_fixture_members(self):
        info = self.fixture.base / 'TEST-FIXTURE-bundle-info.json'
        result = orchestrator.bundle(self.fixture.source, self.output, info_path=info)
        data = self.output.read_bytes()
        self.assertLessEqual(len(data), orchestrator.client.MAX_ARTIFACT_BYTES)
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
            members = archive.getmembers()
            self.assertEqual({member.name for member in members}, channel_fixture.channel.release.FILES | {'release.json'})
            self.assertTrue(all(member.isfile() for member in members))
            for member in members:
                self.assertEqual(archive.extractfile(member).read(), (self.fixture.source / member.name).read_bytes())
        self.assertIsInstance(result, dict)
        self.assertEqual(json.loads(info.read_text()), result)
        self.fixture.assert_current_old()

    def test_bundle_refuses_unapproved_input_without_overwriting_evidence(self):
        (self.fixture.source / 'unapproved.js').write_bytes(b'INERT TEST extra file')
        with self.assertRaises((orchestrator.release.ReleaseError, orchestrator.OrchestrationFailure)):
            orchestrator.bundle(self.fixture.source, self.output)
        self.assertFalse(self.output.exists())
        self.output.write_bytes(b'INERT TEST prior output evidence')
        (self.fixture.source / 'unapproved.js').unlink()
        with self.assertRaises((FileExistsError, orchestrator.OrchestrationFailure)):
            orchestrator.bundle(self.fixture.source, self.output)
        self.assertEqual(self.output.read_bytes(), b'INERT TEST prior output evidence')


class LoopbackOrchestratorTests(unittest.TestCase):
    def setUp(self):
        self.http = channel_fixture.ReleaseChannelTests(methodName='runTest')
        self.http.setUp()
        self.addCleanup(self.http.doCleanups)
        self.metadata = orchestrator.client.metadata_for(self.http.envelope('upload'))
        self.metadata_path = self.http.fixture.base / 'TEST-FIXTURE-orchestrator-state.json'
        self.metadata_path.write_text(json.dumps(self.metadata, sort_keys=True))
        self.clock = FakeClock()
        self.calls = []
        self.instance = orchestrator.client.ReleaseClient(TEST_KEY, transport=self.transport)
        patcher = mock.patch.object(orchestrator.client.time, 'time', return_value=self.http.clock)
        patcher.start()
        self.addCleanup(patcher.stop)

    def transport(self, path, headers, body):
        envelope = json.loads(base64.b64decode(headers['X-FKSSJ-Envelope'], validate=True))
        self.calls.append((envelope, body))
        connection = http.client.HTTPConnection('127.0.0.1', self.http.server.server_address[1], timeout=2)
        try:
            connection.request('POST', path.removeprefix(orchestrator.client.BASE_PATH), body=body,
                               headers=dict(headers, **{'Content-Type': 'application/octet-stream',
                                                        'Content-Length': str(len(body))}))
            response = connection.getresponse()
            return response.status, response.read(65537)
        finally:
            connection.close()

    def test_real_http_default_stage_waits_for_worker_and_never_activates(self):
        self.assertEqual(self.http.upload()[0], 202)

        def sleep(seconds):
            self.clock.sleep(seconds)
            self.assertTrue(channel_fixture.channel.worker_once(self.http.config))

        fetch = mock.Mock()
        result = orchestrator.orchestrate(self.instance, self.metadata, self.metadata_path,
                                           timeout=3, interval=1, clock=self.clock, sleep=sleep, fetch=fetch)
        self.assertEqual(result['state'], 'staged')
        self.assertTrue(all(value['operation'] == 'status' and body == b'' for value, body in self.calls))
        self.assertFalse(Path(str(self.metadata_path) + '.activate-attempted').exists())
        self.http.assert_current_old()
        fetch.assert_not_called()

    def test_real_http_explicit_activation_uses_fake_api_and_fixture_final_fetch(self):
        self.assertEqual(self.http.upload()[0], 202)
        self.assertTrue(channel_fixture.channel.worker_once(self.http.config))
        api_config = self.http.configuration(api=True)

        def sleep(seconds):
            self.clock.sleep(seconds)
            self.assertTrue(channel_fixture.channel.worker_once(api_config))

        fetch = mock.Mock(return_value=(200, (self.http.fixture.source / 'release.json').read_bytes()))
        orchestrator.orchestrate(self.instance, self.metadata, self.metadata_path, mode='activate',
                                   timeout=3, interval=1, clock=self.clock, sleep=sleep, fetch=fetch)
        activations = [value for value, body in self.calls if value['operation'] == 'activate']
        self.assertEqual(len(activations), 1)
        self.assertTrue(all(body == b'' for _, body in self.calls))
        self.assertEqual(self.http.status()['state'], 'activated')
        self.assertEqual((self.http.root / 'current').readlink().as_posix(), 'releases/' + self.http.release_id)
        self.assertEqual(self.http.fixture.db.read_bytes(), b'TEST FIXTURE DB sentinel')
        fetch.assert_called_once_with('/release.json?fkssj_release=' + self.http.release_id)


if __name__ == '__main__':
    unittest.main()

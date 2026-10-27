"""Real loopback HTTP tests with a fixed PUBLIC TEST key and inert fixtures.

Every tar member comes from StaticReleaseTests' synthetic TEST FIXTURE tree.
No project packager, real release, external network, server credentials or key
generation is used. Synthetic API acceptance receipts are not live API proof.
"""

from concurrent.futures import ThreadPoolExecutor
import base64
import hashlib
import hmac
import http.client
import io
import json
import os
from pathlib import Path
import socket
import tarfile
import threading
import time
import unittest
from unittest import mock

from deploy import release_channel as channel
from deploy import test_static_release as static_fixture


TEST_KEY = b'TEST-ONLY-NOT-A-REAL-KEY-0000000'  # 32 PUBLIC, deliberately non-secret bytes.
PREFIX = b'FKSSJ-RELEASE-V1\n'
REPO = 'harveyzhutiancheng-hash/fksjj-web'
COMMIT = 'a' * 40


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def sha(data):
    return hashlib.sha256(data).hexdigest()


class ReleaseChannelTests(unittest.TestCase):
    def setUp(self):
        self.fixture = static_fixture.StaticReleaseTests(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.state = self.fixture.base / 'TEST-FIXTURE-channel-private-state'
        self.state.mkdir(mode=0o700)
        self.clock = int(self.fixture.now.timestamp())
        self.request_counter = 0
        self.release_counter = 1
        self.release_id = self.next_release_id()
        self.artifact = self.tar_bytes()
        self.config = self.configuration()
        self.server, self.thread = self.start_server(self.config)

    def configuration(self, *, api=False):
        values = dict(state=self.state, root=self.root, key=TEST_KEY, clock=lambda: self.clock)
        if api:
            values.update(receipt_path=self.fixture.receipt_path,
                          receipt_sha256=self.fixture.receipt_hash,
                          api_sha256=self.fixture.app_hash,
                          api_init_sha256=self.fixture.init_hash)
        return channel.Config(**values)

    def start_server(self, config):
        server = channel.make_server(config, host='127.0.0.1', port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.stop_server, server, thread)
        return server, thread

    def stop_server(self, server, thread):
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive(), 'Temporary loopback HTTP server did not stop')

    def next_release_id(self):
        value = f'{self.release_counter:032x}'
        self.release_counter += 1
        return value

    def envelope(self, operation, *, artifact=None, release_id=None, **changes):
        artifact = self.artifact if artifact is None else artifact
        self.request_counter += 1
        value = dict(schema=1, operation=operation, repo=REPO, ref='refs/heads/main', commit=COMMIT,
                     requestId=f'{self.request_counter:032x}', releaseId=release_id or self.release_id,
                     artifactSha256=sha(artifact), artifactBytes=len(artifact),
                     manifestSha256=self.fixture.manifest_hash, expectedCurrent='releases/old',
                     issuedAt=self.clock, expiresAt=self.clock + 180)
        value.update(changes)
        return value

    def post(self, operation, *, body=b'', envelope=None, raw=None, signature=None,
             unsigned=False, declared_length=None, path=None):
        envelope = self.envelope(operation) if envelope is None else envelope
        raw = canonical(envelope) if raw is None else raw
        headers = {'Content-Type': 'application/octet-stream',
                   'Content-Length': str(len(body) if declared_length is None else declared_length)}
        if not unsigned:
            headers['X-FKSSJ-Envelope'] = base64.b64encode(raw).decode('ascii')
            headers['X-FKSSJ-Signature'] = (hmac.new(TEST_KEY, PREFIX + raw, hashlib.sha256).hexdigest()
                                           if signature is None else signature)
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=3)
        try:
            connection.request('POST', path or '/v1/' + operation, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read(1024 * 1024 + 1)
            self.assertLessEqual(len(data), 1024 * 1024)
            payload = json.loads(data) if data else {}
            return response.status, payload
        finally:
            connection.close()

    def status(self, *, artifact=None, release_id=None):
        code, payload = self.post('status', envelope=self.envelope('status', artifact=artifact,
                                                                  release_id=release_id))
        self.assertEqual(code, 200, payload)
        return payload

    def upload(self, *, artifact=None, release_id=None):
        artifact = self.artifact if artifact is None else artifact
        envelope = self.envelope('upload', artifact=artifact, release_id=release_id)
        return self.post('upload', body=artifact, envelope=envelope)

    def stage(self):
        code, payload = self.upload()
        self.assertEqual(code, 202, payload)
        self.assertEqual(payload['state'], 'received')
        self.assert_current_old()
        self.assertTrue(channel.worker_once(self.config))
        self.assertEqual(self.status()['state'], 'staged')
        self.assert_current_old()

    def assert_current_old(self):
        self.fixture.assert_current_old()

    def tar_bytes(self, *, replace=None, extra=(), gzip=False, pax=False):
        replace = replace or {}
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz' if gzip else 'w',
                          format=tarfile.PAX_FORMAT if pax else tarfile.USTAR_FORMAT) as archive:
            paths = sorted(p for p in self.fixture.source.rglob('*') if p.is_file())
            for path in paths:
                name = path.relative_to(self.fixture.source).as_posix()
                item = replace.get(name)
                if item is not None:
                    info, data = item
                else:
                    data = path.read_bytes()
                    info = tarfile.TarInfo(name)
                    info.mode, info.mtime, info.size = 0o644, 0, len(data)
                    if pax:
                        info.pax_headers = {'comment': 'INERT TEST FIXTURE EXTENDED HEADER'}
                archive.addfile(info, io.BytesIO(data) if data else None)
            for info, data in extra:
                archive.addfile(info, io.BytesIO(data) if data else None)
        return output.getvalue()

    def assert_rejected_request(self, code, payload):
        self.assertGreaterEqual(code, 400, payload)
        self.assertLess(code, 500, payload)
        self.assert_current_old()

    def test_unsigned_and_bad_signature_are_rejected_without_jobs(self):
        for kwargs in ({'unsigned': True}, {'signature': '0' * 64}):
            with self.subTest(kwargs=kwargs):
                self.assert_rejected_request(*self.post('upload', body=self.artifact, **kwargs))
        self.assertFalse(channel.worker_once(self.config))

    def test_slow_incomplete_http_headers_are_closed_by_absolute_deadline(self):
        with mock.patch.object(channel, 'MAX_REQUEST_SECONDS', 0.1):
            started = time.monotonic()
            with socket.create_connection(('127.0.0.1', self.server.server_address[1]), timeout=1) as connection:
                connection.settimeout(1)
                connection.sendall(b'POST /v1/upload HTTP/1.1\r\nHost: localhost\r\nX-FKSSJ-Envelope: ')
                try:
                    data = connection.recv(1024)
                except ConnectionResetError:
                    data = b''
                self.assertEqual(data, b'', 'Incomplete headers should close without waiting for more bytes')
                self.assertLess(time.monotonic() - started, 1)
        self.assertFalse(channel.worker_once(self.config))
        self.assert_current_old()

    def test_envelope_tampering_after_signing_is_rejected(self):
        value = self.envelope('upload')
        signature = hmac.new(TEST_KEY, PREFIX + canonical(value), hashlib.sha256).hexdigest()
        value['expectedCurrent'] = 'releases/not-the-signed-value'
        self.assert_rejected_request(*self.post('upload', body=self.artifact, envelope=value,
                                                signature=signature))
        self.assertFalse(channel.worker_once(self.config))

    def test_expired_future_and_excessive_lifetime_envelopes_are_rejected(self):
        for changes in ({'issuedAt': self.clock - 200, 'expiresAt': self.clock - 1},
                        {'issuedAt': self.clock + 60, 'expiresAt': self.clock + 180},
                        {'expiresAt': self.clock + 301}):
            with self.subTest(changes=changes):
                value = self.envelope('upload', **changes)
                self.assert_rejected_request(*self.post('upload', body=self.artifact, envelope=value))
        self.assertFalse(channel.worker_once(self.config))

    def test_wrong_repo_ref_commit_type_and_extra_field_are_rejected(self):
        for changes in ({'repo': 'other/not-authorized'}, {'ref': 'refs/heads/other'},
                        {'commit': 'A' * 40}, {'artifactBytes': True}, {'extra': 'not-in-schema'}):
            with self.subTest(changes=changes):
                self.assert_rejected_request(*self.post('upload', body=self.artifact,
                                                        envelope=self.envelope('upload', **changes)))
        self.assertFalse(channel.worker_once(self.config))

    def test_noncanonical_or_duplicate_key_envelope_is_rejected_even_with_valid_mac(self):
        value = self.envelope('upload')
        spaced = json.dumps(value, sort_keys=True).encode('ascii')
        duplicate = canonical(value).replace(b'"schema":1', b'"schema":1,"schema":1')
        for raw in (spaced, duplicate):
            with self.subTest(raw=raw[:30]):
                self.assert_rejected_request(*self.post('upload', body=self.artifact, envelope=value, raw=raw))
        self.assertFalse(channel.worker_once(self.config))

    def test_envelope_operation_must_match_http_endpoint(self):
        self.assert_rejected_request(*self.post('status', body=self.artifact,
                                                envelope=self.envelope('status'), path='/v1/upload'))
        self.assertFalse(channel.worker_once(self.config))

    def test_upload_body_tampering_does_not_create_release(self):
        value = self.envelope('upload')
        altered = self.artifact[:-1] + bytes([self.artifact[-1] ^ 1])
        self.assert_rejected_request(*self.post('upload', body=altered, envelope=value))
        self.assertFalse(channel.worker_once(self.config))

    def test_received_upload_does_not_stage_or_activate_without_worker(self):
        code, payload = self.upload()
        self.assertEqual(code, 202, payload)
        self.assertEqual(payload['state'], 'received')
        self.assertEqual(self.status()['state'], 'received')
        self.assert_current_old()
        self.assertFalse((self.root / 'releases' / self.release_id).exists())

    def test_authenticated_status_and_unknown_release(self):
        self.assert_rejected_request(*self.post('status', unsigned=True))
        code, _ = self.post('status')
        self.assertEqual(code, 404)
        self.assertEqual(self.upload()[0], 202)
        self.assertEqual(self.status()['state'], 'received')

    def test_concurrent_replay_of_same_request_is_accepted_once(self):
        envelope = self.envelope('upload')
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: self.post('upload', body=self.artifact,
                                                           envelope=envelope), range(2)))
        self.assertEqual(sorted(code for code, _ in results), [202, 409], results)
        self.assertTrue(channel.worker_once(self.config))
        self.assertFalse(channel.worker_once(self.config))
        self.assertEqual(self.status()['state'], 'staged')
        self.assert_current_old()

    def test_rejected_activation_nonce_cannot_be_replayed_after_stage(self):
        code, payload = self.upload()
        self.assertEqual(code, 202, payload)
        self.assertEqual(payload['state'], 'received')
        activation = self.envelope('activate')
        code, payload = self.post('activate', envelope=activation)
        self.assertEqual(code, 409, payload)
        self.assertEqual(payload['error'], 'not_staged')
        self.assert_current_old()

        self.assertTrue(channel.worker_once(self.config))
        self.assertEqual(self.status()['state'], 'staged')
        code, payload = self.post('activate', envelope=activation)
        self.assertEqual(code, 409, payload)
        self.assertEqual(payload['error'], 'replay')
        self.assertFalse(channel.worker_once(self.config), 'Rejected nonce must not queue a later activation')
        self.assert_current_old()

    def test_duplicate_release_id_and_replayed_request_survive_server_restart(self):
        envelope = self.envelope('upload')
        self.assertEqual(self.post('upload', body=self.artifact, envelope=envelope)[0], 202)
        self.stop_server(self.server, self.thread)
        self.server, self.thread = self.start_server(self.config)
        self.assertEqual(self.post('upload', body=self.artifact, envelope=envelope)[0], 409)
        self.assertEqual(self.upload()[0], 409)
        self.assertEqual(self.status()['state'], 'received')
        self.assert_current_old()

    def test_status_and_activation_require_empty_http_body(self):
        self.stage()
        for operation in ('status', 'activate'):
            with self.subTest(operation=operation):
                self.assert_rejected_request(*self.post(operation, body=b'not empty'))
        self.assertEqual(self.status()['state'], 'staged')
        self.assertFalse(channel.worker_once(self.config))

    def assert_archive_rejected(self, artifact, *, expected_error=None):
        release_id = self.next_release_id()
        code, payload = self.upload(artifact=artifact, release_id=release_id)
        self.assertEqual(code, 202, payload)
        self.assertTrue(channel.worker_once(self.config))
        result = self.status(artifact=artifact, release_id=release_id)
        self.assertEqual(result['state'], 'rejected', result)
        self.assertEqual(result['lastOperation']['state'], 'rejected', result)
        if expected_error:
            self.assertEqual(result['lastOperation']['error'], expected_error)
        self.assertFalse((self.root / 'releases' / release_id).exists())
        self.assert_current_old()

    def test_non_tar_and_gzip_archive_are_rejected_by_worker(self):
        for artifact in (b'INERT TEST FIXTURE: not a tar archive\n', self.tar_bytes(gzip=True)):
            with self.subTest(length=len(artifact)):
                self.assert_archive_rejected(artifact, expected_error='invalid_archive')

    def test_archive_traversal_absolute_and_extra_directory_do_not_escape(self):
        outside = self.fixture.base / 'TEST-FIXTURE-outside-sentinel'
        outside.write_bytes(b'INERT outside sentinel unchanged')
        for name, kind in (('../TEST-FIXTURE-outside-sentinel', tarfile.REGTYPE),
                           (str(outside), tarfile.REGTYPE), ('unexpected-empty-directory', tarfile.DIRTYPE)):
            with self.subTest(name=name):
                info = tarfile.TarInfo(name)
                info.type = kind
                data = b'ATTEMPTED INERT TEST REPLACEMENT' if kind == tarfile.REGTYPE else b''
                info.size = len(data)
                self.assert_archive_rejected(self.tar_bytes(extra=[(info, data)]))
                self.assertEqual(outside.read_bytes(), b'INERT outside sentinel unchanged')

    def test_archive_symlink_hardlink_and_symlink_parent_are_rejected(self):
        for name, kind, target in (('app.js', tarfile.SYMTYPE, '../../outside'),
                                   ('app.js', tarfile.LNKTYPE, 'index.html'),
                                   ('node_modules', tarfile.SYMTYPE, '../outside')):
            with self.subTest(name=name, kind=kind):
                info = tarfile.TarInfo(name)
                info.type, info.linkname, info.size = kind, target, 0
                if name == 'app.js':
                    artifact = self.tar_bytes(replace={name: (info, b'')})
                else:
                    artifact = self.tar_bytes(extra=[(info, b'')])
                self.assert_archive_rejected(artifact)

    def test_preexisting_unpack_parent_symlink_cannot_write_outside_destination(self):
        destination = self.state / 'TEST-FIXTURE-direct-unpack'
        destination.mkdir()
        outside = self.fixture.base / 'TEST-FIXTURE-outside-unpack'
        outside.mkdir()
        sentinel = outside / 'TEST-FIXTURE-sentinel'
        sentinel.write_bytes(b'INERT TEST outside sentinel unchanged')
        (destination / 'node_modules').symlink_to(outside, target_is_directory=True)

        with self.assertRaisesRegex(channel.ChannelError, 'invalid_archive'):
            channel.unpack(self.artifact, destination, self.fixture.manifest_hash)

        self.assertTrue((destination / 'node_modules').is_symlink())
        self.assertEqual(set(outside.iterdir()), {sentinel})
        self.assertEqual(sentinel.read_bytes(), b'INERT TEST outside sentinel unchanged')
        self.assert_current_old()

    def test_duplicate_members_and_pax_extensions_are_rejected(self):
        duplicate = tarfile.TarInfo('app.js')
        data = (self.fixture.source / 'app.js').read_bytes()
        duplicate.size = len(data)
        for artifact in (self.tar_bytes(extra=[(duplicate, data)]), self.tar_bytes(pax=True)):
            with self.subTest(length=len(artifact)):
                self.assert_archive_rejected(artifact)

    def test_manifest_pin_mismatch_never_stages(self):
        envelope = self.envelope('upload', manifestSha256='0' * 64)
        self.assertEqual(self.post('upload', body=self.artifact, envelope=envelope)[0], 202)
        self.assertTrue(channel.worker_once(self.config))
        code, result = self.post('status', envelope=self.envelope('status', manifestSha256='0' * 64))
        self.assertEqual(code, 200, result)
        self.assertEqual(result['state'], 'rejected', result)
        self.assert_current_old()

    def test_member_and_extracted_byte_limits_are_enforced_without_large_fixture(self):
        for constant, value in (('MAX_MEMBERS', 3), ('MAX_EXTRACTED_BYTES', 1)):
            with self.subTest(constant=constant):
                release_id = self.next_release_id()
                self.assertEqual(self.upload(release_id=release_id)[0], 202)
                with mock.patch.object(channel, constant, value):
                    self.assertTrue(channel.worker_once(self.config))
                result = self.status(release_id=release_id)
                self.assertEqual(result['state'], 'rejected', result)
                self.assertEqual(result['lastOperation']['error'], 'archive_limit', result)
                self.assert_current_old()

    def test_oversize_upload_is_rejected_before_reading_declared_body(self):
        envelope = self.envelope('upload', artifactBytes=1025)
        with mock.patch.object(channel, 'MAX_ARTIFACT_BYTES', 1024):
            code, payload = self.post('upload', envelope=envelope, body=b'', declared_length=1025)
        self.assertEqual(code, 413, payload)
        self.assertEqual(payload['error'], 'artifact_limit')
        self.assertFalse(channel.worker_once(self.config))
        self.assert_current_old()

    def test_activation_request_queues_only_and_missing_api_is_fail_closed(self):
        self.stage()
        code, payload = self.post('activate')
        self.assertEqual(code, 202, payload)
        self.assertEqual(payload['state'], 'activation_queued')
        self.assert_current_old()
        self.assertTrue(channel.worker_once(self.config))
        result = self.status()
        self.assertEqual(result['state'], 'staged', result)
        self.assertEqual(result['lastOperation'], {'requestId': payload['requestId'], 'operation': 'activate',
                                                  'state': 'rejected', 'error': 'api_gate'})
        self.assert_current_old()

    def test_missing_backend_rejected_even_with_pinned_fake_acceptance(self):
        self.stage()
        api_config = self.configuration(api=True)
        (self.root / 'api-current').unlink()
        self.assertEqual(self.post('activate')[0], 202)
        self.assertTrue(channel.worker_once(api_config))
        result = self.status()
        self.assertEqual(result['state'], 'staged', result)
        self.assertEqual(result['lastOperation']['error'], 'api_gate', result)
        self.assert_current_old()

    def test_wrong_api_receipt_pin_and_expired_acceptance_are_rejected(self):
        self.stage()
        bad_pin = self.configuration(api=True)
        bad_pin.receipt_sha256 = '0' * 64
        self.assertEqual(self.post('activate')[0], 202)
        self.assertTrue(channel.worker_once(bad_pin))
        self.assertEqual(self.status()['lastOperation']['error'], 'api_gate')
        self.assert_current_old()

        self.fixture.receipt['expiresAt'] = '2026-10-21T08:04:59Z'
        self.fixture.save_receipt()
        self.assertEqual(self.post('activate')[0], 202)
        self.assertTrue(channel.worker_once(self.configuration(api=True)))
        self.assertEqual(self.status()['lastOperation']['error'], 'api_gate')
        self.assert_current_old()

    def test_fake_acceptance_allows_only_explicit_worker_activation(self):
        self.stage()
        code, queued = self.post('activate')
        self.assertEqual(code, 202, queued)
        self.assert_current_old()
        self.assertTrue(channel.worker_once(self.configuration(api=True)))
        result = self.status()
        self.assertEqual(result['state'], 'activated', result)
        self.assertEqual(result['lastOperation'], {'requestId': queued['requestId'], 'operation': 'activate',
                                                  'state': 'completed', 'error': None})
        self.assertEqual(os.readlink(self.root / 'current'), 'releases/' + self.release_id)
        self.assertTrue((self.root / 'releases' / 'old' / 'old.txt').exists())
        self.assertEqual(self.fixture.db.read_bytes(), b'TEST FIXTURE DB sentinel')
        self.assertEqual(self.post('activate')[0], 409)
        self.assertFalse(channel.worker_once(self.configuration(api=True)))

    def test_binding_change_is_rejected_without_overwriting_release(self):
        self.assertEqual(self.upload()[0], 202)
        for operation in ('status', 'activate'):
            with self.subTest(operation=operation):
                self.assertEqual(self.post(operation, envelope=self.envelope(operation, commit='b' * 40))[0], 409)
        self.assertEqual(self.status()['state'], 'received')
        self.assert_current_old()

    def test_unknown_post_switch_result_is_persistent_and_never_auto_retried(self):
        self.stage()
        self.assertEqual(self.post('activate')[0], 202)
        api_config = self.configuration(api=True)
        real_activate = channel.release.activate
        calls = []

        def switch_then_lose_outcome(*args, **kwargs):
            calls.append(1)
            real_activate(*args, **kwargs)
            raise channel.release.Uncertain('INERT TEST lost publisher acknowledgement')

        with mock.patch.object(channel.release, 'activate', side_effect=switch_then_lose_outcome):
            self.assertTrue(channel.worker_once(api_config))
        self.assertEqual(calls, [1])
        self.assertEqual(self.status()['state'], 'uncertain')
        self.assertEqual(os.readlink(self.root / 'current'), 'releases/' + self.release_id)
        self.stop_server(self.server, self.thread)
        self.server, self.thread = self.start_server(api_config)
        self.assertEqual(self.status()['state'], 'uncertain')
        with self.assertRaisesRegex(channel.ChannelError, 'pending_manual_review'):
            channel.worker_once(api_config)
        self.assertEqual(self.post('activate')[0], 409)
        self.assertEqual(calls, [1], 'Unknown switch outcome must not execute again after restart')

    def test_worker_crash_after_claim_leaves_processing_gate(self):
        self.stage()
        self.assertEqual(self.post('activate')[0], 202)
        api_config = self.configuration(api=True)
        with mock.patch.object(channel.release, 'activate', side_effect=KeyboardInterrupt('INERT TEST worker crash')) as action:
            with self.assertRaises(KeyboardInterrupt):
                channel.worker_once(api_config)
        self.assertEqual(action.call_count, 1)
        result = self.status()
        self.assertEqual(result['lastOperation']['state'], 'processing', result)
        self.assert_current_old()
        with self.assertRaisesRegex(channel.ChannelError, 'pending_manual_review'):
            channel.worker_once(api_config)
        self.assertEqual(self.post('activate')[0], 409)

    def test_post_switch_oserror_is_uncertain_and_never_automatically_retried(self):
        self.stage()
        self.assertEqual(self.post('activate')[0], 202)
        api_config = self.configuration(api=True)
        real_activate = channel.release.activate

        def switch_then_close_error(*args, **kwargs):
            # Injection after a real switch of the inert temporary TEST tree.
            # This models a lost close/ACK result; it is not a real disk fault.
            real_activate(*args, **kwargs)
            raise OSError('INERT TEST close failed after switch')

        with mock.patch.object(channel.release, 'activate', side_effect=switch_then_close_error) as action:
            self.assertTrue(channel.worker_once(api_config))
            self.assertEqual(action.call_count, 1)
            result = self.status()
            self.assertEqual(result['state'], 'uncertain', result)
            self.assertEqual(result['lastOperation']['state'], 'uncertain', result)
            self.assertNotEqual(result['lastOperation']['error'], 'api_gate', result)
            self.assertEqual(os.readlink(self.root / 'current'), 'releases/' + self.release_id)
            with self.assertRaisesRegex(channel.ChannelError, 'pending_manual_review'):
                channel.worker_once(api_config)
            self.assertEqual(self.post('activate')[0], 409)
            self.assertEqual(action.call_count, 1)
            self.assertEqual(os.readlink(self.root / 'current'), 'releases/' + self.release_id)

    def test_concurrent_publishers_stage_received_upload_only_once(self):
        code, payload = self.upload()
        self.assertEqual(code, 202, payload)
        self.assertEqual(payload['state'], 'received')
        entered, proceed = threading.Event(), threading.Event()
        results, failures = [], []
        real_stage = channel.release.stage

        def hold_stage(*args, **kwargs):
            entered.set()
            self.assertTrue(proceed.wait(timeout=1.5), 'TEST worker was not released in time')
            return real_stage(*args, **kwargs)

        def first_worker():
            try:
                results.append(channel.worker_once(self.config))
            except BaseException as exc:
                failures.append(exc)

        with mock.patch.object(channel.release, 'stage', side_effect=hold_stage) as action:
            worker = threading.Thread(target=first_worker, daemon=True)
            worker.start()
            try:
                self.assertTrue(entered.wait(timeout=1), 'TEST worker did not reach stage')
                self.assertFalse(channel.worker_once(self.config), 'Concurrent publisher must respect the lock')
                self.assertEqual(action.call_count, 1)
                self.assert_current_old()
            finally:
                proceed.set()
                worker.join(timeout=1.5)
            self.assertFalse(worker.is_alive(), 'TEST publisher thread did not stop')
            self.assertEqual(failures, [])
            self.assertEqual(results, [True])
            self.assertEqual(action.call_count, 1)
        self.assertEqual(self.status()['state'], 'staged')
        self.assertFalse(channel.worker_once(self.config))
        self.assert_current_old()


if __name__ == '__main__':
    unittest.main()

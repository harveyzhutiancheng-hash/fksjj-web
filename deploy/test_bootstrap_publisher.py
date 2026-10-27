import contextlib
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('bootstrap', HERE / 'bootstrap_publisher.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
COMMIT = 'a' * 40
RAW = b'fixed test bytes\n'

class Response:
    def __init__(self, data=RAW, status=200, headers=None):
        self.data, self.status, self.headers = data, status, headers or {}
    def getheader(self, name, default=None):
        return self.headers.get(name, default)
    def read(self, amount):
        return self.data[:amount]

class Connection:
    def __init__(self, response=None):
        self.response = response or Response()
        self.closed = False
        self.requests = []
    def request(self, *args, **kwargs):
        self.requests.append((args, kwargs))
    def getresponse(self):
        return self.response
    def close(self):
        self.closed = True

class BootstrapTests(unittest.TestCase):
    def fetch(self, response=None, path=None, commit=COMMIT, size=len(RAW), sha=None):
        connection = Connection(response)
        try:
            result = b.fetch(commit, path or b.CORE_PATH, size, sha or b.digest(RAW), connection)
        finally:
            self.connection = connection
        return result
    def test_fixed_https_path_and_bytes(self):
        self.assertEqual(self.fetch(), RAW)
        self.assertEqual(self.connection.requests[0][0], ('GET', '/' + b.REPO + '/' + COMMIT + '/' + b.CORE_PATH))
        self.assertTrue(self.connection.closed)
    def test_delivery_core_and_payload_pins_match_this_repository(self):
        core = (HERE / 'install_publisher.py').read_bytes()
        self.assertEqual((len(core), b.digest(core)), (b.CORE_BYTES, b.CORE_SHA256))
        bindings, data = self.fixture()
        data[b.CORE_PATH] = core
        raw, loaded, checked_core, payload = b.bundle(COMMIT, lambda commit, path, size, sha: data[path])
        self.assertEqual(checked_core, core)
        self.assertEqual(loaded['sourceCommit'], '754a6a522e17538c5b9769afd112844dc7ed02c7')
        self.assertEqual(len(payload), 12)
    def test_redirect_rejected_without_second_request(self):
        for code in (301, 302, 303, 307, 308):
            with self.subTest(code=code), self.assertRaises(b.Stopped):
                self.fetch(Response(status=code, headers={'Location': 'https://evil.invalid/secret'}))
            self.assertEqual(len(self.connection.requests), 1)
            self.assertTrue(self.connection.closed)
    def test_wrong_hash_rejected(self):
        with self.assertRaisesRegex(b.Stopped, 'digest'):
            self.fetch(sha='0' * 64)
    def test_size_declared_and_stream_overflow_rejected(self):
        for response in (Response(data=RAW + b'X'), Response(data=RAW[:-1]), Response(headers={'Content-Length': '99999'})):
            with self.subTest(response=response), self.assertRaisesRegex(b.Stopped, 'size'):
                self.fetch(response)
    def test_encoding_rejected(self):
        with self.assertRaisesRegex(b.Stopped, 'download'):
            self.fetch(Response(headers={'Content-Encoding': 'gzip'}))
    def test_unapproved_path_and_commit_rejected_before_network(self):
        for path in ('../../key', '/etc/secret', 'deploy/unknown.py', 'deploy/install_publisher.py?x=secret'):
            c = Connection()
            with self.subTest(path=path), self.assertRaisesRegex(b.Stopped, 'path'):
                b.fetch(COMMIT, path, len(RAW), b.digest(RAW), c)
            self.assertEqual(c.requests, [])
        with self.assertRaisesRegex(b.Stopped, 'arguments'):
            b.fetch('main', b.CORE_PATH, len(RAW), b.digest(RAW), Connection())
    def fixture(self):
        bindings = json.loads((HERE.parent / 'deploy/publisher-install-bindings.json').read_bytes())
        root = HERE.parent
        data = {row['path']: (root / row['path']).read_bytes() for row in bindings['files'].values()}
        data[b.BINDINGS_PATH] = (HERE.parent / 'deploy/publisher-install-bindings.json').read_bytes()
        data[b.CORE_PATH] = b'# fixture core; never executed\n'
        return bindings, data
    @contextlib.contextmanager
    def pinned_core(self, data):
        with mock.patch.object(b, 'CORE_BYTES', len(data[b.CORE_PATH])), mock.patch.object(b, 'CORE_SHA256', b.digest(data[b.CORE_PATH])):
            yield
    def test_bundle_fetches_helpers_once_and_all_payload_at_main(self):
        bindings, data = self.fixture()
        calls = []
        def download(commit, path, size, sha):
            calls.append((commit, path, size, sha))
            return data[path]
        with self.pinned_core(data):
            raw, loaded, core, payload = b.bundle(COMMIT, download)
        self.assertEqual(loaded, bindings)
        self.assertEqual(len(payload), 12)
        self.assertEqual([x[0] for x in calls[:2]], [COMMIT, COMMIT])
        self.assertTrue(all(x[0] == b.SOURCE_COMMIT for x in calls[2:]))
        self.assertEqual(len(calls), 14)
    def test_bundle_transport_tamper_rejected(self):
        bindings, data = self.fixture()
        def download(commit, path, size, sha):
            return data[path] + (b'x' if path == b.SOURCES['policy'] else b'')
        with self.pinned_core(data), self.assertRaisesRegex(b.Stopped, 'digest'):
            b.bundle(COMMIT, download)
    def test_binding_cannot_change_repository_or_source_path(self):
        for field in ('repo', 'sourceCommit', 'path'):
            bindings, data = self.fixture()
            if field == 'path':
                bindings['files']['policy']['path'] = '/etc/hmac.key'
            else:
                bindings[field] = 'unexpected'
            changed = (json.dumps(bindings, separators=(',', ':'), sort_keys=True) + '\n').encode()
            data[b.BINDINGS_PATH] = changed
            with self.subTest(field=field), self.pinned_core(data), mock.patch.object(b, 'BINDINGS_BYTES', len(changed)), mock.patch.object(b, 'BINDINGS_SHA256', b.digest(changed)), self.assertRaisesRegex(b.Stopped, 'bindings'):
                b.bundle(COMMIT, lambda commit, path, size, sha: data[path])
    def test_duplicate_json_keys_rejected(self):
        with self.assertRaisesRegex(b.Stopped, 'bindings'):
            b.parse(b'{"x":1,"x":2}')
    def test_run_preflight_loads_only_verified_bytes_and_keeps_reason(self):
        bindings, data = self.fixture()
        data[b.CORE_PATH] = b"class Failure(Exception):\n    code='metadata'\nclass Host: pass\nclass Engine:\n    def __init__(self, host, payload, bindings): self.digest='fixture'\n    def preflight(self): raise Failure('PRIVATE_ERROR_BAIT')\n"
        with self.pinned_core(data), mock.patch.object(b.os, 'geteuid', return_value=0), mock.patch.object(b, 'fetch') as ignored:
            # bundle() binds its default fetch function at definition time; supply
            # a verified fixture bundle to isolate execution, without file writes.
            result_bundle = b.bundle(COMMIT, lambda commit, path, size, sha: data[path])
            with mock.patch.object(b, 'bundle', return_value=result_bundle), mock.patch.object(b.os, 'open', side_effect=AssertionError('no disk source cache')):
                result = b.run(COMMIT, 'preflight')
        self.assertEqual(result['state'], 'preflight_stopped_no_changes')
        self.assertEqual(result['reason'], 'metadata')
        self.assertFalse(result['downloadedSourceStored'])
        self.assertNotIn('PRIVATE_ERROR_BAIT', json.dumps(result))
    def test_run_apply_passes_reviewed_engine_digest(self):
        bindings, data = self.fixture()
        data[b.CORE_PATH] = b"class Failure(Exception): pass\nclass Host: pass\nclass Engine:\n    def __init__(self, host, payload, bindings): self.digest='reviewed_binding'\n    def apply(self, digest): return {'state':'installed_verified','checked':digest}\n"
        with self.pinned_core(data), mock.patch.object(b.os, 'geteuid', return_value=0):
            result_bundle = b.bundle(COMMIT, lambda commit, path, size, sha: data[path])
            with mock.patch.object(b, 'bundle', return_value=result_bundle):
                result = b.run(COMMIT, 'apply')
        self.assertEqual(result['checked'], 'reviewed_binding')
        self.assertFalse(result['downloadedSourceStored'])
    def test_invalid_arguments_root_fail_before_fetch(self):
        with mock.patch.object(b.os, 'geteuid', return_value=1000), mock.patch.object(b, 'bundle') as read:
            with self.assertRaisesRegex(b.Stopped, 'root'):
                b.run(COMMIT, 'apply')
            read.assert_not_called()
        with mock.patch.object(b.os, 'geteuid', return_value=0), mock.patch.object(b, 'bundle') as read:
            with self.assertRaisesRegex(b.Stopped, 'arguments'):
                b.run(COMMIT, 'activate')
            read.assert_not_called()
    def test_exception_text_not_emitted(self):
        import io
        secret = 'PRIVATE_BAIT_NO_OUTPUT'
        out = io.StringIO()
        with mock.patch.object(b.sys, 'argv', ['bootstrap', COMMIT, 'preflight']), mock.patch.object(b, 'run', side_effect=ValueError(secret)), contextlib.redirect_stdout(out):
            self.assertEqual(b.main(), 1)
        self.assertNotIn(secret, out.getvalue())
        self.assertEqual(json.loads(out.getvalue())['reason'], 'unexpected')

if __name__ == '__main__':
    unittest.main()

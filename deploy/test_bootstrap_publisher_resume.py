import ast
import contextlib
import inspect
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('resume_bootstrap', HERE / 'bootstrap_publisher_resume.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
HELPER = 'a' * 40
RAW = b'PUBLIC FIXTURE\n'
CORE = b"class Failure(Exception):\n    code='metadata'\nREASONS={'metadata'}\nclass Host: pass\n"
RESUME = b"class Resume:\n    def __init__(self, core, host, payload, bindings): self.core=core\n    def preflight(self): return {'state':'resume_preflight_ready','mutations':False}\n    def apply(self): return {'state':'installed_verified'}\n"

class Response:
    def __init__(self, data=RAW, status=200, headers=None):
        self.data, self.status, self.headers = data, status, headers or {}
    def getheader(self, name, default=None): return self.headers.get(name, default)
    def read(self, size): return self.data[:size]

class Connection:
    def __init__(self, response=None): self.response, self.requests, self.closed = response or Response(), [], False
    def request(self, *args, **kwargs): self.requests.append((args, kwargs))
    def getresponse(self): return self.response
    def close(self): self.closed = True

class Tests(unittest.TestCase):
    def test_delivered_production_pins_and_complete_local_bundle(self):
        base_raw = (HERE / 'bootstrap_publisher.py').read_bytes()
        resume_raw = (HERE / 'resume_publisher.py').read_bytes()
        self.assertEqual((len(base_raw), b.digest(base_raw)), (b.BASE_BYTES, b.BASE_SHA256))
        self.assertEqual((len(resume_raw), b.digest(resume_raw)), (b.RESUME_BYTES, b.RESUME_SHA256))
        base = b.module(base_raw, 'pinned_production_base')
        original_bundle = base.bundle
        base.bundle = lambda commit: original_bundle(commit, lambda ref, path, size, sha: (HERE.parent / path).read_bytes())
        with mock.patch.object(b, 'module', return_value=base):
            core, resume, payload, bindings = b.sources(HELPER, lambda ref, path, size, sha: base_raw if path == b.BASE_PATH else resume_raw)
        self.assertEqual(core, (HERE / 'install_publisher.py').read_bytes())
        self.assertEqual(resume, resume_raw)
        self.assertEqual(len(payload), 12)
        self.assertEqual(bindings['sourceCommit'], b.SOURCE_COMMIT)
    def fetch(self, response=None, sha=None):
        self.conn = Connection(response)
        return b.fetch(HELPER, b.RESUME_PATH, len(RAW), sha or b.digest(RAW), self.conn)
    def test_exact_source_path_no_redirect(self):
        self.assertEqual(self.fetch(), RAW)
        self.assertEqual(self.conn.requests[0][0], ('GET', '/' + b.REPO + '/' + HELPER + '/' + b.RESUME_PATH))
        self.assertTrue(self.conn.closed)
        for code in (301, 302, 303, 307, 308):
            with self.subTest(code=code), self.assertRaisesRegex(b.Stopped, 'download'):
                self.fetch(Response(status=code, headers={'Location': 'https://forbidden.invalid'}))
            self.assertEqual(len(self.conn.requests), 1)
    def test_size_hash_encoding_and_status_failure(self):
        for resp in (Response(data=RAW + b'X'), Response(data=RAW[:-1]), Response(headers={'Content-Length': '500'})):
            with self.subTest(response=resp), self.assertRaisesRegex(b.Stopped, 'size'):
                self.fetch(resp)
        with self.assertRaisesRegex(b.Stopped, 'digest'): self.fetch(sha='0' * 64)
        for resp in (Response(status=404), Response(headers={'Content-Encoding':'gzip'})):
            with self.assertRaisesRegex(b.Stopped, 'download'): self.fetch(resp)
    def test_only_two_fixed_paths_and_old_source_commit(self):
        for path, commit in (('../../secret', HELPER), ('/etc/secret', HELPER), (b.BASE_PATH, HELPER), (b.RESUME_PATH+'?token=x', HELPER)):
            conn = Connection()
            with self.subTest(path=path), self.assertRaisesRegex(b.Stopped, 'path'):
                b.fetch(commit, path, len(RAW), b.digest(RAW), conn)
            self.assertEqual(conn.requests, [])
        conn = Connection()
        b.fetch(b.BASE_COMMIT, b.BASE_PATH, len(RAW), b.digest(RAW), conn)
        self.assertIn(b.BASE_COMMIT, conn.requests[0][0][1])
    def test_invalid_commit_and_unfinalized_pin_stop_before_network(self):
        conn = Connection()
        for commit in ('main', '../main', None, 123):
            with self.subTest(commit=commit), self.assertRaisesRegex(b.Stopped, 'arguments'):
                b.fetch(commit, b.RESUME_PATH, len(RAW), b.digest(RAW), conn)
        with self.assertRaisesRegex(b.Stopped, 'pin'):
            b.fetch(HELPER, b.RESUME_PATH, 0, 'UNFINALIZED', conn)
        self.assertEqual(conn.requests, [])
    def base_fixture(self, core=CORE, source=None):
        return ("SOURCE_COMMIT=" + repr(source or b.SOURCE_COMMIT) + "\n"
                "def bundle(commit):\n"
                "    assert commit == " + repr(b.BASE_COMMIT) + "\n"
                "    return b'bindings', {'fixed':'bindings'}, " + repr(core) + ", {'fixed':b'payload'}\n"
                "def run(*args): raise AssertionError('OLD_RUN_MUST_NOT_EXECUTE')\n"
                "def main(): raise AssertionError('OLD_MAIN_MUST_NOT_EXECUTE')\n").encode()
    @contextlib.contextmanager
    def pins(self, base, resume=RESUME):
        with mock.patch.object(b, 'BASE_BYTES', len(base)), mock.patch.object(b, 'BASE_SHA256', b.digest(base)), mock.patch.object(b, 'RESUME_BYTES', len(resume)), mock.patch.object(b, 'RESUME_SHA256', b.digest(resume)):
            yield
    def test_verified_base_bundle_uses_exact_old_commit_and_new_resume_path(self):
        base = self.base_fixture()
        calls = []
        def downloader(commit, path, size, sha):
            calls.append((commit, path))
            return base if path == b.BASE_PATH else RESUME
        with self.pins(base):
            core, resume, payload, bindings = b.sources(HELPER, downloader)
        self.assertEqual(calls, [(b.BASE_COMMIT, b.BASE_PATH), (HELPER, b.RESUME_PATH)])
        self.assertEqual((core, resume), (CORE, RESUME))
        self.assertEqual(payload, {'fixed':b'payload'})
    def test_tampered_base_not_executed(self):
        base = self.base_fixture()
        with self.pins(base), mock.patch.object(b, 'module') as load, self.assertRaisesRegex(b.Stopped, 'digest'):
            b.sources(HELPER, lambda *args: base + b'tampered')
        load.assert_not_called()
    def test_tampered_resume_not_returned(self):
        base = self.base_fixture()
        with self.pins(base), self.assertRaisesRegex(b.Stopped, 'digest'):
            b.sources(HELPER, lambda commit, path, size, sha: base if path == b.BASE_PATH else RESUME+b'tampered')
    def test_base_cannot_use_other_main_payload(self):
        base = self.base_fixture(source='c' * 40)
        with self.pins(base), self.assertRaisesRegex(b.Stopped, 'source'):
            b.sources(HELPER, lambda *args: base)
    def test_old_bundle_failure_uses_only_fixed_reason(self):
        for code, expected in (('digest', 'digest'), ('PRIVATE_BAIT', 'unexpected')):
            base = self.base_fixture() + ("class Stopped(Exception):\n    def __init__(self, reason): self.reason=reason\ndef bundle(commit): raise Stopped(" + repr(code) + ")\n").encode()
            with self.subTest(code=code), self.pins(base), self.assertRaisesRegex(b.Stopped, '^' + expected + '$'):
                b.sources(HELPER, lambda *args: base)
    def test_root_and_mode_gate_before_sources(self):
        with mock.patch.object(b.os, 'geteuid', return_value=1000), mock.patch.object(b, 'sources') as get:
            with self.assertRaisesRegex(b.Stopped, 'root'): b.run(HELPER, 'apply')
            get.assert_not_called()
        with mock.patch.object(b.os, 'geteuid', return_value=0), mock.patch.object(b, 'sources') as get:
            with self.assertRaisesRegex(b.Stopped, 'arguments'): b.run(HELPER, 'restart')
            get.assert_not_called()
    def test_resume_methods_called_without_old_engine_and_no_cache(self):
        with mock.patch.object(b.os, 'geteuid', return_value=0), mock.patch.object(b, 'sources', return_value=(CORE, RESUME, {}, {})), mock.patch.object(b.os, 'open', side_effect=AssertionError('NO_SOURCE_CACHE')):
            self.assertEqual(b.run(HELPER, 'preflight')['state'], 'resume_preflight_ready')
            result = b.run(HELPER, 'apply')
        self.assertEqual(result['state'], 'installed_verified')
        self.assertFalse(result['downloadedSourceStored'])
        self.assertEqual(result['baseInstallerCommit'], b.BASE_COMMIT)
    def test_fixed_preflight_failure_without_exception_text(self):
        bad = RESUME.replace(b"return {'state':'resume_preflight_ready','mutations':False}", b"raise self.core.Failure('PRIVATE_BAIT')")
        with mock.patch.object(b.os, 'geteuid', return_value=0), mock.patch.object(b, 'sources', return_value=(CORE, bad, {}, {})):
            result = b.run(HELPER, 'preflight')
        self.assertEqual(result['reason'], 'metadata')
        self.assertNotIn('PRIVATE_BAIT', json.dumps(result))
    def test_all_other_exceptions_are_redacted(self):
        out = io.StringIO()
        with mock.patch.object(b.sys, 'argv', ['bootstrap', HELPER, 'apply']), mock.patch.object(b, 'run', side_effect=ValueError('PRIVATE_BAIT')), contextlib.redirect_stdout(out):
            self.assertEqual(b.main(), 1)
        self.assertNotIn('PRIVATE_BAIT', out.getvalue())
        self.assertEqual(json.loads(out.getvalue())['reason'], 'unexpected')
    def test_actual_resume_interface_and_success_state_match_bootstrap(self):
        raw = (HERE.parent / 'deploy' / 'resume_publisher.py').read_bytes()
        production = b.module(raw, 'actual_resume_interface')
        self.assertEqual(list(inspect.signature(production.Resume).parameters), ['core', 'host', 'payload', 'bindings'])
        self.assertEqual(list(inspect.signature(production.Resume.preflight).parameters), ['self'])
        self.assertEqual(list(inspect.signature(production.Resume.apply).parameters), ['self'])
        apply = next(node for node in ast.walk(ast.parse(raw)) if isinstance(node, ast.FunctionDef) and node.name == 'apply')
        success_states = {keyword.value.value for node in ast.walk(apply) if isinstance(node, ast.Call)
                          for keyword in node.keywords if keyword.arg == 'state' and isinstance(keyword.value, ast.Constant)}
        self.assertIn('installed_verified', success_states)
        with mock.patch.object(b.sys, 'argv', ['bootstrap', HELPER, 'apply']), mock.patch.object(b, 'run', return_value={'state':'installed_verified'}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(b.main(), 0)
    def test_success_exit_states_only(self):
        for state in ('resume_preflight_ready', 'installed_verified', 'partial', 'unknown'):
            with self.subTest(state=state), mock.patch.object(b.sys, 'argv', ['bootstrap', HELPER, 'preflight']), mock.patch.object(b, 'run', return_value={'state':state}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(b.main(), 0 if state in ('resume_preflight_ready', 'installed_verified') else 1)

if __name__ == '__main__': unittest.main()

"""Offline unit tests; every static/API/receipt byte is a TEMP TEST FIXTURE.

No archive, packager, network, real deployment tree or live API is used.
Acceptance booleans below are deliberately fake test data, not test evidence
about a deployed backend or browser.
"""
import contextlib
import datetime as dt
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('static_release', Path(__file__).with_name('static-release.py'))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class StaticReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='TEST-FIXTURE-static-release-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / 'TEST-FIXTURE-source'
        self.source.mkdir()
        entries = []
        for name in sorted(release.FILES):
            data = ('TEST FIXTURE ONLY; not deployable: ' + name + '\n').encode()
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            entries.append({'path': name, 'bytes': len(data), 'sha256': sha(data)})
        self.manifest = {'version': release.VERSION, 'createdAt': '2026-10-21T08:00:00Z',
                         'fileCount': len(entries), 'totalBytes': sum(e['bytes'] for e in entries),
                         'files': entries}
        self.save_manifest()
        self.root = self.base / 'TEST-FIXTURE-root'
        (self.root / 'releases' / 'old').mkdir(parents=True)
        (self.root / 'releases' / 'old' / 'old.txt').write_text('TEST FIXTURE old preserved')
        (self.root / 'current').symlink_to('releases/old')
        self.db = self.root / 'TEST-FIXTURE-database-do-not-touch'
        self.db.write_bytes(b'TEST FIXTURE DB sentinel')
        self.now = dt.datetime(2026, 10, 21, 8, 5, tzinfo=dt.timezone.utc)
        backend = self.root / 'api-releases' / 'TEST-FIXTURE-api' / 'api'
        backend.mkdir(parents=True)
        self.app = backend / 'app.py'
        self.app.write_bytes(b'# TEST FIXTURE ONLY, not a real backend\n')
        self.init = backend / '__init__.py'
        self.init.write_bytes(b'# TEST FIXTURE initializer\n')
        (self.root / 'api-current').symlink_to('api-releases/TEST-FIXTURE-api')
        self.app_hash, self.init_hash = sha(self.app.read_bytes()), sha(self.init.read_bytes())
        self.receipt = {'schema': 1, 'type': 'fkssj-api-acceptance', 'manifestSha256': self.manifest_hash,
                        'origin': release.ORIGIN, 'checkedAt': '2026-10-21T08:00:00Z',
                        'expiresAt': '2026-10-21T08:15:00Z',
                        'backendTarget': 'api-releases/TEST-FIXTURE-api',
                        'apiAppSha256': self.app_hash, 'apiInitSha256': self.init_hash,
                        'checks': dict.fromkeys(release.CHECKS, True)}
        self.receipt_path = self.base / 'TEST-FIXTURE-FAKE-acceptance.json'
        self.save_receipt()

    def save_manifest(self, raw=None):
        data = raw if raw is not None else release.encode(self.manifest)
        (self.source / 'release.json').write_bytes(data)
        self.manifest_hash = sha(data)

    def save_receipt(self):
        data = release.encode(self.receipt)
        self.receipt_path.write_bytes(data)
        self.receipt_hash = sha(data)

    def check(self, **overrides):
        kwargs = dict(source=self.source, manifest_sha256=self.manifest_hash,
                      release_id='TEST-FIXTURE-v014', expected_current='releases/old')
        kwargs.update(overrides)
        return release.check(**kwargs)

    def stage(self, **overrides):
        kwargs = dict(source=self.source, manifest_sha256=self.manifest_hash,
                      release_id='TEST-FIXTURE-v014', expected_current='releases/old', root=self.root)
        kwargs.update(overrides)
        return release.stage(**kwargs)

    def activate(self, **overrides):
        kwargs = dict(release_id='TEST-FIXTURE-v014', manifest_sha256=self.manifest_hash,
                      expected_current='releases/old', api_receipt=self.receipt_path,
                      api_receipt_sha256=self.receipt_hash, expected_api_sha256=self.app_hash,
                      expected_api_init_sha256=self.init_hash, root=self.root, now=self.now)
        kwargs.update(overrides)
        return release.activate(**kwargs)

    def assert_current_old(self):
        self.assertEqual(os.readlink(self.root / 'current'), 'releases/old')
        self.assertEqual(self.db.read_bytes(), b'TEST FIXTURE DB sentinel')

    def test_check_exact_34_files_readonly(self):
        self.assertEqual(len(release.FILES), 34)
        before = set(self.root.iterdir())
        result = self.check()
        self.assertEqual(result['status'], 'verified')
        self.assertFalse(result['currentChecked'])
        self.assertEqual(set(self.root.iterdir()), before)
        self.assertFalse((self.root / release.LOCK).exists())

    def test_independently_pinned_manifest_required(self):
        for value in ('', '0' * 64, None, 'A' * 64):
            with self.subTest(value=value), self.assertRaises(release.ReleaseError):
                self.check(manifest_sha256=value)

    def test_modified_payload_rejected(self):
        (self.source / 'app.js').write_text('different TEST FIXTURE')
        with self.assertRaisesRegex(release.ReleaseError, 'payload mismatch'):
            self.check()

    def test_extra_file_and_empty_directory_rejected(self):
        for name, directory in (('extra.js', False), ('extra-empty', True)):
            with self.subTest(name=name):
                path = self.source / name
                path.mkdir() if directory else path.write_text('TEST FIXTURE')
                with self.assertRaisesRegex(release.ReleaseError, 'extra'):
                    self.check()
                path.rmdir() if directory else path.unlink()

    def test_symlink_payload_and_parent_rejected(self):
        app = self.source / 'app.js'
        outside = self.base / 'TEST-FIXTURE-outside'
        outside.write_bytes(app.read_bytes())
        app.unlink()
        app.symlink_to(outside)
        with self.assertRaises((release.ReleaseError, OSError)):
            self.check()
        link = self.base / 'TEST-FIXTURE-source-link'
        link.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(OSError):
            self.check(source=link)

    def test_hardlink_payload_and_manifest_rejected(self):
        for name in ('app.js', 'release.json'):
            with self.subTest(name=name):
                link = self.base / 'TEST-FIXTURE-link'
                os.link(self.source / name, link)
                with self.assertRaisesRegex(release.ReleaseError, 'hard ?link|one hard link'):
                    self.check()
                link.unlink()

    def test_fifo_rejected_without_blocking(self):
        path = self.source / 'app.js'
        path.unlink()
        os.mkfifo(path)
        with self.assertRaisesRegex(release.ReleaseError, 'special'):
            self.check()

    def test_manifest_structure_and_traversal(self):
        original = json.loads(json.dumps(self.manifest))
        mutations = [lambda m: m.update(version='0.13.0'),
                     lambda m: m.update(fileCount=True),
                     lambda m: m.update(totalBytes=m['totalBytes'] + 1),
                     lambda m: m['files'][0].update(path='../outside'),
                     lambda m: m['files'][0].update(bytes=True),
                     lambda m: m['files'].__setitem__(0, m['files'][1]),
                     lambda m: m.update(unexpected='TEST FIXTURE')]
        for mutate in mutations:
            self.manifest = json.loads(json.dumps(original))
            mutate(self.manifest)
            self.save_manifest()
            with self.subTest(manifest=self.manifest), self.assertRaises(release.ReleaseError):
                self.check()

    def test_duplicate_json_keys_rejected(self):
        raw = (self.source / 'release.json').read_bytes().replace(b'"version":', b'"version":"0.14.0","version":', 1)
        self.save_manifest(raw)
        with self.assertRaisesRegex(release.ReleaseError, 'duplicate JSON'):
            self.check()

    def test_release_ids_and_current_escape_rejected(self):
        for name in ('../outside', '/absolute', 'a/b', '.', 'a..b', ''):
            with self.subTest(name=name), self.assertRaises(release.ReleaseError):
                self.check(release_id=name)
        for value in ('current', '/srv/fkssj/releases/old', 'releases/../old', ''):
            with self.subTest(value=value), self.assertRaises(release.ReleaseError):
                self.stage(expected_current=value)

    def test_stage_preserves_current_old_version_and_data_no_api_needed(self):
        (self.root / 'api-current').unlink()
        result = self.stage()
        self.assertEqual(result['status'], 'staged')
        self.assert_current_old()
        staged = self.root / 'releases' / 'TEST-FIXTURE-v014'
        self.assertTrue(staged.is_dir())
        self.assertEqual(self.check(source=staged)['fileCount'], 34)
        self.assertTrue((self.root / 'releases' / 'old' / 'old.txt').exists())
        self.assertFalse(any(path.name.startswith('.stage-') for path in staged.parent.iterdir()))

    def test_stage_requests_0755_for_all_new_directories_without_chmod_or_umask(self):
        real_mkdir = release.os.mkdir
        with mock.patch.object(release.os, 'mkdir', wraps=real_mkdir) as mkdir:
            self.stage()
        self.assertGreater(len(mkdir.call_args_list), 1)
        self.assertTrue(all(call.args[1] == 0o755 for call in mkdir.call_args_list))

    def test_stage_never_overwrites_even_empty_release(self):
        candidate = self.root / 'releases' / 'TEST-FIXTURE-v014'
        candidate.mkdir()
        with self.assertRaisesRegex(release.ReleaseError, 'already exists'):
            self.stage()
        self.assertEqual(list(candidate.iterdir()), [])
        self.assert_current_old()

    def test_stage_cas_and_unsafe_current_rejected(self):
        with self.assertRaisesRegex(release.ReleaseError, 'CAS'):
            self.stage(expected_current='absent')
        (self.root / 'current').unlink()
        (self.root / 'current').symlink_to('../outside')
        with self.assertRaises(release.ReleaseError):
            self.stage()
        self.assertFalse((self.root / 'releases' / 'TEST-FIXTURE-v014').exists())

    def test_noreplace_atomic_primitive_refuses_existing_directory(self):
        with release.directory(self.root / 'releases') as fd:
            os.mkdir('TEST-FIXTURE-source-dir', dir_fd=fd)
            os.mkdir('TEST-FIXTURE-existing-dir', dir_fd=fd)
            with self.assertRaises(FileExistsError):
                release.rename_new(fd, 'TEST-FIXTURE-source-dir', 'TEST-FIXTURE-existing-dir')
            self.assertTrue((self.root / 'releases' / 'TEST-FIXTURE-source-dir').exists())

    def test_no_noreplace_support_fails_closed_and_cleans_own_temp(self):
        with mock.patch.object(release.ctypes, 'CDLL', return_value=object()):
            with self.assertRaisesRegex(release.ReleaseError, 'unavailable'):
                self.stage()
        self.assert_current_old()
        self.assertEqual([p.name for p in (self.root / 'releases').iterdir()], ['old'])

    def test_stage_rename_completed_then_error_is_uncertain_preserves_published(self):
        real_rename = release.rename_new

        def rename_then_fail(*args):
            real_rename(*args)
            raise OSError('TEST FIXTURE injected after successful rename')

        with mock.patch.object(release, 'rename_new', side_effect=rename_then_fail):
            with self.assertRaisesRegex(release.Uncertain, 'publish was attempted'):
                self.stage()
        self.assertTrue((self.root / 'releases' / 'TEST-FIXTURE-v014').is_dir())
        self.assert_current_old()

    def test_concurrent_lock_refuses_stage(self):
        with (self.root / release.LOCK).open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(release.ReleaseError, 'holds the lock'):
                self.stage()
        self.assert_current_old()

    def test_valid_fake_receipt_activation_only_switches_current(self):
        self.stage()
        result = self.activate()
        self.assertEqual(result['status'], 'activated')
        self.assertEqual(os.readlink(self.root / 'current'), 'releases/TEST-FIXTURE-v014')
        self.assertTrue((self.root / 'releases' / 'old' / 'old.txt').exists())
        self.assertEqual(self.db.read_bytes(), b'TEST FIXTURE DB sentinel')
        self.assertFalse((self.root / release.PENDING).exists())
        journals = list(self.root.glob('.static-release-completed-*.json'))
        self.assertEqual(len(journals), 1)
        self.assertEqual(json.loads(journals[0].read_text())['state'], 'completed')
        self.assertIn('not a live probe', result['apiEvidence'])

    def test_receipt_is_not_its_own_trust_anchor(self):
        self.stage()
        with self.assertRaisesRegex(release.ReleaseError, 'receipt SHA'):
            self.activate(api_receipt_sha256='0' * 64)
        self.receipt['apiAppSha256'] = '0' * 64
        self.save_receipt()
        with self.assertRaisesRegex(release.ReleaseError, 'code pin'):
            self.activate()
        self.assert_current_old()

    def test_missing_receipt_and_missing_backend_refuse_activation(self):
        self.stage()
        with self.assertRaises(FileNotFoundError):
            self.activate(api_receipt=self.base / 'missing.json')
        (self.root / 'api-current').unlink()
        with self.assertRaises(FileNotFoundError):
            self.activate()
        self.assert_current_old()
        self.assertFalse((self.root / release.PENDING).exists())

    def test_receipt_bindings_exact_checks_and_validity(self):
        self.stage()
        original = json.loads(json.dumps(self.receipt))
        mutations = [lambda r: r.update(origin='https://elsewhere.invalid'),
                     lambda r: r.update(manifestSha256='0' * 64),
                     lambda r: r.update(apiInitSha256='0' * 64),
                     lambda r: r.update(checkedAt='2026-10-21T08:06:00Z'),
                     lambda r: r.update(expiresAt='2026-10-21T08:05:00Z'),
                     lambda r: r.update(expiresAt='2026-10-21T08:16:00Z'),
                     lambda r: r.update(backendTarget='../outside'),
                     lambda r: r['checks'].pop('get_user_mismatch'),
                     lambda r: r['checks'].update(health=1),
                     lambda r: r['checks'].update(secure_cookie=False),
                     lambda r: r['checks'].update(extra=True)]
        for mutate in mutations:
            self.receipt = json.loads(json.dumps(original))
            mutate(self.receipt)
            self.save_receipt()
            with self.subTest(receipt=self.receipt), self.assertRaises(release.ReleaseError):
                self.activate()
            self.assert_current_old()

    def test_backend_two_files_hashes_and_target_pinned(self):
        self.stage()
        for path in (self.app, self.init):
            data = path.read_bytes()
            path.write_bytes(b'# changed TEST FIXTURE\n')
            with self.subTest(path=path), self.assertRaisesRegex(release.ReleaseError, 'SHA-256'):
                self.activate()
            path.write_bytes(data)
        link = self.root / 'api-current'
        link.unlink()
        link.symlink_to('api-releases/other')
        with self.assertRaisesRegex(release.ReleaseError, 'target mismatch'):
            self.activate()
        self.assert_current_old()

    def test_backend_symlink_parent_file_and_hardlink_refused(self):
        self.stage()
        data = self.app.read_bytes()
        outside = self.base / 'TEST-FIXTURE-outside-app.py'
        outside.write_bytes(data)
        self.app.unlink()
        self.app.symlink_to(outside)
        with self.assertRaises(OSError):
            self.activate()
        self.app.unlink()
        self.app.write_bytes(data)
        hardlink = self.base / 'TEST-FIXTURE-hardlink.py'
        os.link(self.app, hardlink)
        with self.assertRaisesRegex(release.ReleaseError, 'one hard link'):
            self.activate()
        hardlink.unlink()
        api_dir = self.app.parent
        moved = api_dir.with_name('TEST-FIXTURE-moved-api')
        api_dir.rename(moved)
        api_dir.symlink_to(moved)
        with self.assertRaises(OSError):
            self.activate()
        self.assert_current_old()

    def test_activation_candidate_reverified(self):
        self.stage()
        (self.root / 'releases' / 'TEST-FIXTURE-v014' / 'app.js').write_text('changed TEST FIXTURE')
        with self.assertRaisesRegex(release.ReleaseError, 'payload mismatch'):
            self.activate()
        self.assert_current_old()

    def test_receipt_expiring_during_validation_never_switches_current(self):
        self.stage()
        times = [self.now]
        real_backend = release.backend

        def backend_advances_clock(*args):
            real_backend(*args)
            times[0] = dt.datetime(2026, 10, 21, 8, 16, tzinfo=dt.timezone.utc)

        with mock.patch.object(release, 'backend', side_effect=backend_advances_clock):
            with self.assertRaises(release.Uncertain) as error:
                self.activate(now=lambda: times[0])
        self.assertIn('expired', str(error.exception.__cause__))
        self.assert_current_old()
        self.assertTrue((self.root / release.PENDING).exists())

    def test_activation_link_name_collision_does_not_delete_existing_path(self):
        self.stage()
        operation_id = 'TEST-FIXTURE-fixed-id'
        collision = self.root / ('.current-static-' + operation_id)
        collision.write_bytes(b'TEST FIXTURE pre-existing file must survive')
        fake_uuid = mock.Mock(hex=operation_id)
        with mock.patch.object(release.uuid, 'uuid4', return_value=fake_uuid):
            with self.assertRaises(FileExistsError):
                self.activate()
        self.assertEqual(collision.read_bytes(), b'TEST FIXTURE pre-existing file must survive')
        self.assertFalse((self.root / release.PENDING).exists())
        self.assert_current_old()

    def test_replace_completed_then_error_retains_pending_no_rollback(self):
        self.stage()
        real_replace = release.os.replace

        def replace_then_fail(*args, **kwargs):
            real_replace(*args, **kwargs)
            raise OSError('TEST FIXTURE injected post-replace error')

        with mock.patch.object(release.os, 'replace', side_effect=replace_then_fail):
            with self.assertRaisesRegex(release.Uncertain, 'uncertain'):
                self.activate()
        self.assertEqual(os.readlink(self.root / 'current'), 'releases/TEST-FIXTURE-v014')
        self.assertTrue((self.root / release.PENDING).is_file())
        with self.assertRaisesRegex(release.ReleaseError, 'pending activation'):
            self.activate(expected_current='releases/TEST-FIXTURE-v014')
        with self.assertRaisesRegex(release.ReleaseError, 'pending activation'):
            self.stage(release_id='TEST-FIXTURE-another', expected_current='releases/TEST-FIXTURE-v014')

    def test_completion_write_failure_retains_pending(self):
        self.stage()
        real_write = release.write_new

        def fail_completed(fd, name, data):
            if name.startswith('.static-release-completed-'):
                raise OSError('TEST FIXTURE completion write failure')
            return real_write(fd, name, data)

        with mock.patch.object(release, 'write_new', side_effect=fail_completed):
            with self.assertRaises(release.Uncertain):
                self.activate()
        self.assertTrue((self.root / release.PENDING).is_file())
        self.assertEqual(os.readlink(self.root / 'current'), 'releases/TEST-FIXTURE-v014')

    def test_final_pending_unlink_fsync_failure_restores_gate(self):
        self.stage()
        real_fsync = release.os.fsync
        armed = False

        def fail_after_pending_unlink(fd):
            nonlocal armed
            if (self.root / release.PENDING).exists():
                armed = True
            elif armed and list(self.root.glob('.static-release-completed-*.json')):
                raise OSError('TEST FIXTURE final fsync failure')
            return real_fsync(fd)

        with mock.patch.object(release.os, 'fsync', side_effect=fail_after_pending_unlink):
            with self.assertRaises(release.Uncertain):
                self.activate()
        self.assertTrue((self.root / release.PENDING).is_file())

    def test_cli_default_check_and_no_root_or_bypass_flag(self):
        arguments = ['--source', str(self.source), '--manifest-sha256', self.manifest_hash,
                     '--release-id', 'TEST-FIXTURE-v014', '--expected-current', 'releases/old']
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(release.main(arguments), 0)
        self.assertEqual(json.loads(output.getvalue())['operation'], 'check')
        self.assertFalse((self.root / release.LOCK).exists())
        for flags in (['--root', str(self.root)], ['--skip-api'], ['--force']):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                release.main(['check'] + arguments + flags)
            self.assertEqual(error.exception.code, 2)


if __name__ == '__main__':
    unittest.main()

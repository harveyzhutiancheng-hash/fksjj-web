"""Status-only transaction fixtures; never invoke nginx/systemctl/chown.

All configuration bytes, directory descriptors and permission changes belong
to temporary roots. Command success/failure/unknown receipts are simulations,
not nginx syntax validation or evidence of a real reload/public endpoint.
"""
import difflib
import hashlib
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from deploy import nginx_status_only as n


def receipt(returncode=0, state='finished'):
    return {'state': state, 'returncode': returncode}


class FixtureHost(n.Host):
    def __init__(self, root):
        super().__init__(root=root)
        self.root_uid = 0
        self.owners, self.owner_calls, self.commands = {}, [], []
        self.outcomes, self.hooks = {}, {}
        self.counts = {'active': 0, 'test': 0, 'reload': 0}
        self.fail_pending_owner = False

    def euid(self):
        return self.root_uid

    def meta(self, fd):
        info = os.fstat(fd)
        values = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
        values.update(st_uid=0, st_gid=0)
        values.update(self.owners.get((info.st_dev, info.st_ino), {}))
        return SimpleNamespace(**values)

    def owner(self, fd, uid, gid):
        info = os.fstat(fd)
        self.owner_calls.append((info.st_ino, uid, gid))
        pending = self.path(str(Path(n.TARGET).parent / '.fkssj-status-only.pending'))
        if self.fail_pending_owner and pending.exists() and pending.stat().st_ino == info.st_ino:
            raise OSError('INERT TEST pending-file ownership failed')
        self.owners[(info.st_dev, info.st_ino)] = {'st_uid': uid, 'st_gid': gid}

    def command(self, name):
        if name not in self.counts:
            raise AssertionError('Unapproved TEST command name: ' + repr(name))
        self.commands.append(name)
        self.counts[name] += 1
        if name in self.hooks:
            self.hooks[name](self.counts[name])
        values = self.outcomes.get(name, [])
        return values.pop(0) if values else receipt()


class NginxStatusOnlyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='TEST-FIXTURE-nginx-status-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / 'root'
        self.root.mkdir(mode=0o700)
        self.host = FixtureHost(self.root)
        for logical in ('/etc', '/etc/nginx', '/etc/nginx/conf.d', '/var', '/var/backups'):
            self.host.path(logical).mkdir(parents=True, exist_ok=True)
            self.host.path(logical).chmod(0o755)
        self.target = self.host.path(n.TARGET)
        self.target.write_bytes(n.BASELINE)
        self.target.chmod(0o644)
        self.protected = self.root / 'INERT-OLD-STATIC-AND-DATABASE-SENTINEL'
        self.protected.write_bytes(b'INERT TEST old site and database remain untouched')

    def snapshot(self):
        values = {}
        for path in self.root.rglob('*'):
            info = path.lstat()
            content = path.readlink().as_posix() if path.is_symlink() else path.read_bytes() if path.is_file() else None
            values[str(path.relative_to(self.root))] = (info.st_ino, info.st_mode, info.st_nlink, info.st_mtime_ns, content)
        return values

    def call(self, operation='apply', approved_sha=None):
        with mock.patch.object(n.os, 'fchown') as owner, \
                mock.patch.object(n.subprocess, 'run') as command, \
                mock.patch.object(n.subprocess, 'Popen') as process:
            try:
                return (n.preflight(self.host) if operation == 'preflight' else
                        n.apply(self.host, n.CANDIDATE_SHA if approved_sha is None else approved_sha))
            finally:
                owner.assert_not_called()
                command.assert_not_called()
                process.assert_not_called()
                self.assertEqual(self.protected.read_bytes(), b'INERT TEST old site and database remain untouched')

    def test_preflight_is_readonly_and_reports_bound_hashes(self):
        before = self.snapshot()
        result = self.call('preflight')
        self.assertEqual(result['state'], 'preflight_ok_await_authorization')
        self.assertEqual(result['baselineSha256'], n.BASELINE_SHA)
        self.assertEqual(result['candidateSha256'], n.CANDIDATE_SHA)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.host.commands, ['active'])
        self.assertEqual(self.host.owner_calls, [])

    def test_exact_baseline_mode_owner_regular_and_nlink_are_required(self):
        for kind in ('content', 'mode', 'owner', 'hardlink', 'directory'):
            with self.subTest(kind=kind):
                self.setUp()
                if kind == 'content':
                    self.target.write_bytes(n.BASELINE + b'\n# INERT foreign edit\n')
                elif kind == 'mode':
                    self.target.chmod(0o666)
                elif kind == 'owner':
                    info = self.target.stat()
                    self.host.owners[(info.st_dev, info.st_ino)] = {'st_uid': 1000}
                elif kind == 'hardlink':
                    os.link(self.target, self.base / 'INERT-second-link')
                else:
                    self.target.unlink()
                    self.target.mkdir()
                before = self.snapshot()
                with self.assertRaises((n.Failure, OSError)):
                    self.call('preflight')
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(self.host.owner_calls, [])

    def test_symlinked_target_or_parent_cannot_escape_temporary_root(self):
        for kind in ('leaf', 'parent'):
            with self.subTest(kind=kind):
                self.setUp()
                outside = self.base / 'INERT-outside'
                outside.mkdir()
                sentinel = outside / self.target.name
                sentinel.write_bytes(n.BASELINE)
                if kind == 'leaf':
                    self.target.unlink()
                    self.target.symlink_to(sentinel)
                else:
                    self.target.unlink()
                    self.target.parent.rmdir()
                    self.target.parent.symlink_to(outside, target_is_directory=True)
                with self.assertRaises((n.Failure, OSError)):
                    self.call('preflight')
                self.assertEqual(sentinel.read_bytes(), n.BASELINE)
                self.assertFalse(self.host.path(n.BACKUP).exists())
                self.assertEqual(self.host.owner_calls, [])

    def test_candidate_preserves_all_original_lines_and_adds_only_exact_status_proxy(self):
        self.assertEqual(hashlib.sha256(n.BASELINE).hexdigest(), n.BASELINE_SHA)
        self.assertEqual(hashlib.sha256(n.CANDIDATE).hexdigest(), n.CANDIDATE_SHA)
        diff = list(difflib.ndiff(n.BASELINE.decode().splitlines(), n.CANDIDATE.decode().splitlines()))
        self.assertEqual([line for line in diff if line.startswith('- ')], [], 'Original version/headers/80 ACME lines must stay unchanged')
        added = '\n'.join(line[2:] for line in diff if line.startswith('+ '))
        self.assertIn('location = /_fkssj-release/v1/status', added)
        self.assertIn('proxy_pass http://127.0.0.1:8790/v1/status;', added)
        self.assertNotIn('location /_fkssj-release', added)
        self.assertNotIn('/v1/upload', added)
        self.assertNotIn('/v1/activate', added)
        for line in n.BASELINE.decode().splitlines():
            if 'add_header' in line or 'acme-challenge' in line or 'listen 80' in line:
                self.assertGreaterEqual(n.CANDIDATE.decode().splitlines().count(line),
                                        n.BASELINE.decode().splitlines().count(line))
        self.assertIn('limit_except POST { deny all; }', added)
        self.assertIn('location ^~ /_fkssj-release/ { return 404; }', added)

    def test_wrong_approval_hash_cannot_create_backup_or_run_mutation_commands(self):
        before = self.snapshot()
        with self.assertRaises(n.Failure):
            self.call(approved_sha='0' * 64)
        self.assertEqual(self.snapshot(), before)
        self.assertNotIn('test', self.host.commands)
        self.assertNotIn('reload', self.host.commands)

    def test_success_keeps_private_original_backup_and_reports_only_reload_ack(self):
        result = self.call()
        self.assertEqual(result['state'], 'applied_reload_acknowledged')
        self.assertEqual(self.target.read_bytes(), n.CANDIDATE)
        backup = self.host.path(n.BACKUP)
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o700)
        self.assertEqual((backup / 'original.conf').read_bytes(), n.BASELINE)
        self.assertEqual((backup / 'candidate.conf').read_bytes(), n.CANDIDATE)
        for name in ('original.conf', 'candidate.conf', 'journal.jsonl'):
            self.assertEqual(stat.S_IMODE((backup / name).stat().st_mode), 0o600)
        self.assertEqual(self.host.commands, ['active', 'test', 'test', 'reload'])
        self.assertFalse(self.host.path(str(Path(n.TARGET).parent / '.fkssj-status-only.pending')).exists())

    def test_existing_backup_is_never_adopted_or_overwritten(self):
        backup = self.host.path(n.BACKUP)
        backup.mkdir(mode=0o700)
        evidence = backup / 'INERT-existing-evidence'
        evidence.write_bytes(b'INERT RETAINED EVIDENCE')
        before = self.snapshot()
        with self.assertRaises(n.Failure):
            self.call()
        self.assertEqual(self.snapshot(), before)
        self.assertNotIn('reload', self.host.commands)

    def test_baseline_nginx_test_failure_keeps_original_without_reload(self):
        self.host.outcomes['test'] = [receipt(1)]
        result = self.call()
        self.assertEqual(result['state'], 'stopped_original_retained')
        self.assertEqual(self.target.read_bytes(), n.BASELINE)
        self.assertEqual(self.host.commands, ['active', 'test'])

    def test_candidate_nginx_test_failure_restores_original_without_reload(self):
        self.host.outcomes['test'] = [receipt(), receipt(1), receipt()]
        result = self.call()
        self.assertEqual(result['state'], 'stopped_original_restored')
        self.assertEqual(self.target.read_bytes(), n.BASELINE)
        self.assertEqual(self.host.commands, ['active', 'test', 'test', 'test'])

    def test_reload_failure_restores_disk_and_remains_uncertain(self):
        self.host.outcomes['reload'] = [receipt(1), receipt()]
        result = self.call()
        self.assertEqual(result['state'], 'uncertain')
        self.assertEqual(self.target.read_bytes(), n.BASELINE)
        self.assertEqual(self.host.commands, ['active', 'test', 'test', 'reload', 'test', 'reload'])

    def test_edits_during_restored_validation_are_preserved_without_recovery_reload(self):
        for kind in ('content', 'inode', 'metadata'):
            with self.subTest(kind=kind):
                self.setUp()
                foreign = n.BASELINE + (b'\n# INERT edit during recovery\n' if kind == 'content' else b'')
                identities = []

                def change_restored_target(count):
                    if count != 3:
                        return
                    if kind == 'content':
                        self.target.write_bytes(foreign)
                    elif kind == 'inode':
                        replacement = self.target.parent / 'INERT-recovery-editor'
                        replacement.write_bytes(foreign)
                        replacement.chmod(0o644)
                        os.replace(replacement, self.target)
                    else:
                        self.target.chmod(0o640)
                    identities.append((self.target.stat().st_ino, stat.S_IMODE(self.target.stat().st_mode)))

                self.host.outcomes['reload'] = [receipt(1)]
                self.host.hooks['test'] = change_restored_target
                result = self.call()
                self.assertEqual(result['state'], 'uncertain')
                self.assertEqual(self.target.read_bytes(), foreign)
                self.assertEqual((self.target.stat().st_ino, stat.S_IMODE(self.target.stat().st_mode)), identities[0])
                self.assertEqual(self.host.commands, ['active', 'test', 'test', 'reload', 'test'])
                self.assertEqual((self.host.path(n.BACKUP) / 'original.conf').read_bytes(), n.BASELINE)

    def test_unknown_reload_receipt_never_becomes_success_or_retries_apply(self):
        self.host.outcomes['reload'] = [receipt(None, 'unknown'), receipt()]
        result = self.call()
        self.assertEqual(result['state'], 'uncertain')
        self.assertEqual(self.target.read_bytes(), n.BASELINE)
        before = self.snapshot()
        commands = list(self.host.commands)
        with self.assertRaises(n.Failure):
            self.call()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.host.commands.count('reload'), commands.count('reload'))

    def test_external_baseline_edit_is_not_overwritten(self):
        for phase in ('baseline', 'candidate-content', 'candidate-inode'):
            with self.subTest(phase=phase):
                self.setUp()
                foreign = ((n.BASELINE if phase == 'baseline' else n.CANDIDATE) +
                           (b'' if phase == 'candidate-inode' else b'\n# INERT independent root edit\n'))
                foreign_inodes = []

                def external_edit(count):
                    if count != (1 if phase == 'baseline' else 2):
                        return
                    if phase == 'candidate-inode':
                        replacement = self.target.parent / 'INERT-foreign-pending'
                        replacement.write_bytes(foreign)
                        replacement.chmod(0o644)
                        os.replace(replacement, self.target)
                    else:
                        self.target.write_bytes(foreign)
                    foreign_inodes.append(self.target.stat().st_ino)

                self.host.hooks['test'] = external_edit
                if phase == 'candidate-inode':
                    self.host.outcomes['test'] = [receipt(), receipt(1)]
                try:
                    result = self.call()
                except n.Failure:
                    result = None
                if result is not None:
                    self.assertNotEqual(result['state'], 'applied_reload_acknowledged')
                self.assertEqual(self.target.read_bytes(), foreign)
                self.assertEqual(self.target.stat().st_ino, foreign_inodes[0])
                self.assertNotIn('reload', self.host.commands)

    def test_concurrent_second_apply_cannot_pass_exclusive_backup_claim(self):
        blocked = []

        def second_apply(count):
            if count == 1:
                with self.assertRaises(n.Failure):
                    n.apply(self.host, n.CANDIDATE_SHA)
                blocked.append(1)

        self.host.hooks['test'] = second_apply
        result = self.call()
        self.assertEqual(result['state'], 'applied_reload_acknowledged')
        self.assertEqual(blocked, [1])
        self.assertEqual(self.host.commands.count('reload'), 1)
        self.assertEqual(self.target.read_bytes(), n.CANDIDATE)

    def test_repeat_successful_apply_cannot_change_evidence_or_reload_again(self):
        self.call()
        before = self.snapshot()
        reloads = self.host.commands.count('reload')
        with self.assertRaises(n.Failure):
            self.call()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.host.commands.count('reload'), reloads)

    def test_pending_write_failure_preserves_evidence_and_original(self):
        self.host.fail_pending_owner = True
        result = self.call()
        self.assertNotEqual(result['state'], 'applied_reload_acknowledged')
        self.assertEqual(self.target.read_bytes(), n.BASELINE)
        self.assertTrue(self.host.path(n.BACKUP).is_dir())
        self.assertNotIn('reload', self.host.commands)
        before = self.snapshot()
        self.host.fail_pending_owner = False
        with self.assertRaises(n.Failure):
            self.call()
        self.assertEqual(self.snapshot(), before)

    def test_interrupted_reload_keeps_transaction_evidence_and_blocks_reapply(self):
        def interrupt(_):
            raise KeyboardInterrupt('INERT TEST lost reload result')

        self.host.hooks['reload'] = interrupt
        try:
            result = self.call()
        except KeyboardInterrupt:
            result = None
        if result is not None:
            self.assertEqual(result['state'], 'uncertain')
        self.assertTrue(self.host.path(n.BACKUP).is_dir())
        self.assertIn(self.target.read_bytes(), (n.BASELINE, n.CANDIDATE))
        before = self.snapshot()
        reloads = self.host.commands.count('reload')
        with self.assertRaises(n.Failure):
            self.call()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.host.commands.count('reload'), reloads)


if __name__ == '__main__':
    unittest.main()

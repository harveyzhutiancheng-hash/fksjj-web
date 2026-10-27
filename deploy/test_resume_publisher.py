import contextlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import types
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
SOURCE = Path(os.environ.get('FKSSJ_TEST_SOURCE', HERE))

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

m = load('reviewed_resume', HERE / 'deploy/resume_publisher.py')
fixtures = load('reviewed_installer_tests', SOURCE / 'deploy/test_install_publisher.py')
c = fixtures.m


class PartialHost(fixtures.FakeHost):
    def __init__(self, payload, bindings):
        super().__init__(payload)
        self.enabled = True
        self.runtime_failures = 0
        self.runtime_code = 'runtime'
        self.runtime_calls = 0
        self.guard_depth = 0
        self.guard_at_timer = None
        self.directory_mode = 0o700
        self.extra_listing = {}
        self.dirs |= {c.BACKUP, c.AUDIT, c.AUDIT + '/releases'}
        for index, path in enumerate(c.OLD_FILES):
            self.files[c.BACKUP + '/original-' + str(index)] = self.files[path]
        self.files[c.BACKUP + '/original-nginx'] = fixtures.BASE
        engine = c.Engine(self, payload, bindings)
        self.files[c.NGINX] = engine._candidate(fixtures.BASE)
        for name in c.PROGRAMS:
            self.files[c.PREFIX + name] = payload[name]
        for name in c.UNITS:
            self.files[c.SYSTEM + name] = payload[name]
        self.files[c.CONFIG + 'publisher.json'] = c.encode(engine.policy)
        self.files[c.ATTEMPT] = c.encode({'schema': 1, 'bindingsSha256': m.BINDINGS,
            'sourceCommit': m.SOURCE, 'state': 'attempted'})
        self.files[c.BACKUP + '/journal.jsonl'] = b''.join(c.encode({'step': step}) for step in m.STEPS)
        for path in self.files:
            self.marks[path] = 1
            self.mode[path] = 0o600 if path.startswith(c.BACKUP + '/') or path == c.CONFIG + 'publisher.json' else 0o644

    def listing(self, path):
        if path == c.PREFIX.rstrip('/'):
            answer = {'.phase1', *c.PROGRAMS}
        else:
            prefix = path.rstrip('/') + '/'
            answer = {p[len(prefix):].split('/')[0] for p in self.files.keys() | self.dirs if p.startswith(prefix)}
        return answer | self.extra_listing.get(path, set())

    @contextlib.contextmanager
    def directory(self, path):
        yield path

    def info(self, fd):
        return types.SimpleNamespace(st_uid=0, st_gid=0, st_mode=stat.S_IFDIR | self.directory_mode)

    def runtime(self, new=False):
        self.runtime_calls += 1
        c.need(new and self.enabled and not self.timer, 'runtime')
        if self.runtime_failures:
            self.runtime_failures -= 1
            raise c.Failure(self.runtime_code)

    def read(self, path, *args, **kwargs):
        result = super().read(path, *args, **kwargs)
        if 'mode' in kwargs:
            c.need(self.mode[path] == kwargs['mode'], 'metadata')
        return result

    def unit(self, name):
        return dict(super().unit(name), Id=name, LoadState='loaded', NeedDaemonReload='no')

    @contextlib.contextmanager
    def worker_guard(self):
        self.guard_depth += 1
        try:
            yield
        finally:
            self.guard_depth -= 1

    def command(self, argv, uncertain=False):
        if argv == ['/usr/bin/systemctl', 'enable', '--now', 'fkssj-publisher.timer']:
            self.guard_at_timer = self.guard_depth
        return super().command(argv, uncertain)


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.patch = mock.patch.dict(c.OLD_FILES, {path: (len(raw), c.sha(raw)) for path, raw in fixtures.OLD_RAW.items()}, clear=True)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.p, self.b = fixtures.fixture()
        self.h = PartialHost(self.p, self.b)
        self.e = m.Resume(c, self.h, self.p, self.b)
        self.original_audit = {path: raw for path, raw in self.h.files.items() if path.startswith(c.BACKUP + '/')}

    def test_exact_partial_preflight_has_no_writes_commands_or_key_reads(self):
        result = self.e.preflight()
        self.assertEqual(result['state'], 'resume_preflight_ready')
        self.assertFalse(self.h.writes)
        self.assertFalse(self.h.commands)
        self.assertNotIn(c.CONFIG + 'hmac.key', self.h.files)
        self.assertFalse(self.h.timer)

    def test_complete_remaining_only_with_original_audit_unchanged(self):
        result = self.e.apply()
        self.assertEqual(result['state'], 'installed_verified', result)
        self.assertTrue(self.h.timer)
        self.assertEqual(self.h.commands, [('/usr/bin/systemctl', 'enable', '--now', 'fkssj-publisher.timer')])
        self.assertEqual(self.h.guard_at_timer, 1)
        self.assertEqual({path: self.h.files[path] for path in self.original_audit}, self.original_audit)
        targets = {path for _, path in self.h.writes}
        self.assertEqual(targets, {self.e.attempt, self.e.journal, c.CONFIG + 'publisher.json'})
        self.assertEqual(result['accountsCreated'], 0)
        self.assertFalse(result['currentChangedByResume'])
        self.assertTrue(json.loads(self.h.files[c.CONFIG + 'publisher.json'])['enabled'])

    def test_different_source_or_bindings_refused(self):
        for key in ('repo', 'sourceCommit'):
            b = json.loads(json.dumps(self.b))
            b[key] = 'unexpected'
            with self.subTest(key=key), self.assertRaises(c.Failure):
                m.Resume(c, self.h, self.p, b)

    def test_unknown_original_steps_refused_before_write(self):
        for raw in (self.h.files[c.BACKUP + '/journal.jsonl'] + c.encode({'step': 'policy_enabled'}), b'\n', b'{"step":"SECRET_BAIT"}\n'):
            self.h.files[c.BACKUP + '/journal.jsonl'] = raw
            result = self.e.apply()
            self.assertEqual(result['state'], 'resume_stopped_no_changes')
            self.assertEqual(result['reason'], 'attempt')
            self.assertFalse(self.h.writes)
            self.assertNotIn('SECRET_BAIT', json.dumps(result))

    def test_foreign_original_attempt_refused(self):
        self.h.files[c.ATTEMPT] += b'\n'
        self.assertEqual(self.e.apply()['reason'], 'attempt')
        self.assertFalse(self.h.writes)

    def test_original_backups_or_nginx_drift_refused(self):
        for path in (c.BACKUP + '/original-0', c.BACKUP + '/original-nginx', c.NGINX):
            original = self.h.files[path]
            self.h.files[path] = original + b'changed'
            result = self.e.apply()
            self.assertIn(result['reason'], ('changed', 'nginx'))
            self.assertFalse(self.h.writes)
            self.h.files[path] = original

    def test_installed_program_or_unit_drift_refused(self):
        for path in (c.PREFIX + 'publisher_pipeline.py', c.SYSTEM + 'fkssj-publisher.service'):
            original = self.h.files[path]
            self.h.files[path] = b'foreign'
            self.assertEqual(self.e.apply()['reason'], 'changed')
            self.assertFalse(self.h.writes)
            self.h.files[path] = original

    def test_already_enabled_policy_or_running_timer_refused(self):
        self.h.files[c.CONFIG + 'publisher.json'] = c.encode(dict(self.e.e.policy, enabled=True))
        self.assertEqual(self.e.apply()['reason'], 'existing')
        self.assertFalse(self.h.writes)
        self.h.files[c.CONFIG + 'publisher.json'] = c.encode(self.e.e.policy)
        self.h.timer = True
        with mock.patch.object(m.time, 'sleep'):
            self.assertEqual(self.e.apply()['reason'], 'runtime')
        self.assertFalse(self.h.writes)

    def test_extra_audit_or_installed_file_and_private_directory_modes_refused(self):
        for path in (c.BACKUP, c.AUDIT, c.PREFIX.rstrip('/')):
            self.h.extra_listing[path] = {'unknown'}
            self.assertIn(self.e.apply()['reason'], ('attempt', 'existing'))
            self.assertFalse(self.h.writes)
            self.h.extra_listing.clear()
        self.h.directory_mode = 0o750
        self.assertEqual(self.e.apply()['reason'], 'metadata')
        self.assertFalse(self.h.writes)

    def test_runtime_transient_is_bounded_read_only_and_rechecked_strictly(self):
        self.h.runtime_failures = 2
        with mock.patch.object(m.time, 'sleep') as sleep:
            self.assertEqual(self.e.preflight()['state'], 'resume_preflight_ready')
        self.assertEqual(self.h.runtime_calls, 3)
        self.assertEqual(sleep.call_args_list, [mock.call(1), mock.call(1)])
        self.assertFalse(self.h.writes)

    def test_runtime_never_ready_stops_after_five_without_writes(self):
        self.h.runtime_failures = 20
        with mock.patch.object(m.time, 'sleep') as sleep:
            result = self.e.apply()
        self.assertEqual(result['reason'], 'runtime')
        self.assertEqual(self.h.runtime_calls, 5)
        self.assertEqual(sleep.call_count, 4)
        self.assertFalse(self.h.writes)

    def test_non_runtime_error_never_retried(self):
        self.h.runtime_failures = 20
        self.h.runtime_code = 'unit'
        with mock.patch.object(m.time, 'sleep') as sleep:
            self.assertEqual(self.e.apply()['reason'], 'unit')
        self.assertEqual(self.h.runtime_calls, 1)
        sleep.assert_not_called()
        self.assertFalse(self.h.writes)

    def test_queue_and_account_budget_block_before_writes(self):
        self.h.queue_fail_at = 1
        self.assertEqual(self.e.apply()['reason'], 'queue')
        self.assertFalse(self.h.writes)
        self.h.queue_fail_at = None
        self.h.files[c.BUDGET] = b'preserved'
        self.assertEqual(self.e.apply()['reason'], 'existing')
        self.assertFalse(self.h.writes)

    def test_existing_resume_marker_refuses_replay(self):
        self.h.files[self.e.attempt] = b'preserved'
        self.assertEqual(self.e.apply()['reason'], 'attempt')
        self.assertFalse(self.h.writes)

    def test_success_cannot_run_again(self):
        self.assertEqual(self.e.apply()['state'], 'installed_verified')
        before = list(self.h.writes)
        again = m.Resume(c, self.h, self.p, self.b).apply()
        self.assertEqual(again['reason'], 'attempt')
        self.assertEqual(self.h.writes, before)

    def test_unknown_timer_start_is_not_retried_or_rolled_back(self):
        self.h.fail = lambda argv: argv == ['/usr/bin/systemctl', 'enable', '--now', 'fkssj-publisher.timer']
        result = self.e.apply()
        self.assertEqual(result['state'], 'resume_partial_or_uncertain_inspect_no_retry')
        self.assertTrue(result['uncertain'])
        self.assertTrue(result['servicesMayHaveChanged'])
        self.assertTrue(result['policyMayHaveChanged'])
        self.assertEqual(len(self.h.commands), 1)
        self.assertTrue(json.loads(self.h.files[c.CONFIG + 'publisher.json'])['enabled'])
        self.assertEqual({path: self.h.files[path] for path in self.original_audit}, self.original_audit)

    def test_policy_cas_conflict_stops_before_timer(self):
        original = self.h.write
        def write(path, raw, mode=0o644, replace=None):
            if path == c.CONFIG + 'publisher.json':
                self.h.marks[path] += 1
            return original(path, raw, mode, replace)
        self.h.write = write
        result = self.e.apply()
        self.assertEqual(result['reason'], 'changed')
        self.assertTrue(result['policyMayHaveChanged'])
        self.assertFalse(self.h.commands)
        self.assertFalse(self.h.timer)

    def test_new_queue_after_enable_stops_timer_and_retains_attempt(self):
        # Two _verify calls and one guarded _verify precede this queue.
        self.h.queue_fail_at = 5
        result = self.e.apply()
        self.assertEqual(result['reason'], 'queue')
        self.assertTrue(self.h.exists(self.e.attempt))
        self.assertFalse(self.h.commands)
        self.assertFalse(self.h.timer)

    def test_exception_text_never_in_result(self):
        self.h.read = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError('SECRET_BAIT'))
        result = self.e.apply()
        self.assertEqual(result['reason'], 'unexpected')
        self.assertNotIn('SECRET_BAIT', json.dumps(result))


if __name__ == '__main__':
    unittest.main()

"""Cold-stage tests: public fixture key, synthetic tar and local HTTP only."""
from pathlib import Path
import contextlib
import os
import sqlite3
import stat
import tempfile
import unittest
from unittest import mock

from deploy import release_channel as channel
from deploy import test_release_channel as fixture_channel


class ColdStageWorkerTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixture_channel.ReleaseChannelTests(methodName='runTest')
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        # Real server DB was explicitly repaired to this shared-write mode.
        (self.fx.state / 'state.sqlite3').chmod(0o660)

    def row(self, request_id):
        with channel.Store(self.fx.config).connect() as db:
            value = db.execute('SELECT operation,state,error FROM requests WHERE request_id=?',
                               (request_id,)).fetchone()
            return dict(value)

    def test_empty_stage_worker_does_no_release_mutation(self):
        with mock.patch.object(channel.release, 'activate') as activation:
            self.assertFalse(channel.worker_once(self.fx.config, stage_only=True))
        activation.assert_not_called()
        self.fx.assert_current_old()

    def test_received_upload_stages_once_and_never_activates(self):
        code, reply = self.fx.upload()
        self.assertEqual(code, 202)
        self.assertEqual(reply['state'], 'received')
        with mock.patch.object(channel.release, 'activate') as activation:
            self.assertTrue(channel.worker_once(self.fx.config, stage_only=True))
            self.assertFalse(channel.worker_once(self.fx.config, stage_only=True))
        activation.assert_not_called()
        result = self.fx.status()
        self.assertEqual(result['state'], 'staged')
        self.assertEqual(result['lastOperation']['state'], 'completed')
        self.fx.assert_current_old()

    def test_activation_is_unclaimed_even_with_valid_fixture_receipt(self):
        self.fx.stage()
        code, reply = self.fx.post('activate')
        self.assertEqual(code, 202)
        with mock.patch.object(channel.release, 'activate') as activation:
            with self.assertRaisesRegex(channel.ChannelError, '^stage_only_queue_not_upload$'):
                channel.worker_once(self.fx.configuration(api=True), stage_only=True)
        activation.assert_not_called()
        self.assertEqual(self.row(reply['requestId'])['state'], 'queued')
        self.fx.assert_current_old()

    def test_multiple_uploads_are_not_claimed(self):
        first = self.fx.upload()[1]
        second = self.fx.upload(release_id=self.fx.next_release_id())[1]
        with mock.patch.object(channel.release, 'stage') as stage:
            with self.assertRaisesRegex(channel.ChannelError, '^stage_only_queue_not_exclusive$'):
                channel.worker_once(self.fx.config, stage_only=True)
        stage.assert_not_called()
        for value in [first, second]:
            self.assertEqual(self.row(value['requestId'])['state'], 'queued')

    def test_upload_and_activation_queue_is_not_claimed(self):
        self.fx.stage()
        activation_request = self.fx.post('activate')[1]
        upload = self.fx.upload(release_id=self.fx.next_release_id())[1]
        with mock.patch.object(channel.release, 'activate') as activation:
            with self.assertRaisesRegex(channel.ChannelError, '^stage_only_queue_not_exclusive$'):
                channel.worker_once(self.fx.configuration(api=True), stage_only=True)
        activation.assert_not_called()
        for value in [activation_request, upload]:
            self.assertEqual(self.row(value['requestId'])['state'], 'queued')
        self.fx.assert_current_old()

    def test_signed_activation_disguised_as_upload_cannot_reach_activation(self):
        self.fx.stage()
        reply = self.fx.post('activate')[1]
        with channel.Store(self.fx.config).transaction() as db:
            db.execute("UPDATE requests SET operation='upload' WHERE request_id=?", (reply['requestId'],))
        with mock.patch.object(channel.release, 'activate') as activation:
            self.assertTrue(channel.worker_once(self.fx.configuration(api=True), stage_only=True))
        activation.assert_not_called()
        self.assertEqual(self.row(reply['requestId'])['error'], 'job_operation_mismatch')
        self.fx.assert_current_old()

    def test_expired_upload_is_rejected_without_rewriting_signature_or_switching(self):
        reply = self.fx.upload()[1]
        self.fx.clock += 181
        with mock.patch.object(channel.release, 'stage') as stage, \
                mock.patch.object(channel.release, 'activate') as activation:
            self.assertTrue(channel.worker_once(self.fx.config, stage_only=True))
        stage.assert_not_called()
        activation.assert_not_called()
        self.assertEqual(self.row(reply['requestId'])['state'], 'rejected')
        self.fx.assert_current_old()

    def test_processing_and_uncertain_stop_before_claim(self):
        reply = self.fx.upload()[1]
        for state in ['processing', 'uncertain']:
            with channel.Store(self.fx.config).transaction() as db:
                db.execute('UPDATE requests SET state=? WHERE request_id=?', (state, reply['requestId']))
            with self.assertRaisesRegex(channel.ChannelError, '^pending_manual_review$'):
                channel.worker_once(self.fx.config, stage_only=True)
            self.assertEqual(self.row(reply['requestId'])['state'], state)

    def test_stage_cli_selects_restricted_mode_and_cannot_take_extra_arguments(self):
        with mock.patch.object(channel.sys, 'argv', ['release_channel.py', 'stage-worker']), \
                mock.patch.object(channel, 'load_config', return_value=self.fx.config), \
                mock.patch.object(channel, 'worker_once', return_value=False) as worker, \
                mock.patch('builtins.print'), mock.patch.object(channel.os, 'umask'):
            channel.main()
        worker.assert_called_once_with(self.fx.config, stage_only=True)
        with mock.patch.object(channel.sys, 'argv', ['release_channel.py', 'stage-worker', 'worker']), \
                mock.patch.object(channel, 'load_config') as load:
            with self.assertRaises(channel.ChannelError):
                channel.main()
        load.assert_not_called()

    def test_restricted_unit_does_not_expand_permissions_or_enable_timer(self):
        unit = Path(__file__).with_name('templates').joinpath('fkssj-stage-publisher.service').read_text()
        self.assertIn('release_channel_stage.py stage-worker', unit)
        self.assertNotIn('release_channel.py worker\n', unit)
        self.assertIn('User=fkssj-deploy', unit)
        self.assertIn('Group=fkssj-release', unit)
        self.assertIn('InaccessiblePaths=-/var/lib/fkssj', unit)
        self.assertNotIn('WantedBy=', unit)
        writable = next(line.split('=', 1)[1].split() for line in unit.splitlines()
                        if line.startswith('ReadWritePaths='))
        self.assertEqual(writable, ['/var/lib/fkssj-release', '/srv/fkssj/releases',
                                    '/srv/fkssj/.static-release.lock'])
        self.assertNotIn('/srv/fkssj', writable)

    def test_stage_missing_database_is_not_created_and_generic_receiver_still_can_initialize(self):
        db_path = self.fx.state / 'state.sqlite3'
        saved = self.fx.state / 'saved-state.sqlite3'
        db_path.rename(saved)
        with self.assertRaisesRegex(channel.ChannelError, '^existing_state_required$'):
            channel.worker_once(self.fx.config, stage_only=True)
        self.assertFalse(db_path.exists())
        self.assertFalse((self.fx.state / 'publisher.lock').exists())
        generic = channel.Store(self.fx.config)
        self.assertTrue(db_path.is_file())
        with generic.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM requests').fetchone()[0], 0)

    def test_stage_empty_existing_database_does_not_create_schema_or_header(self):
        db_path = self.fx.state / 'state.sqlite3'
        db_path.rename(self.fx.state / 'saved-state.sqlite3')
        db_path.touch(mode=0o660)
        db_path.chmod(0o660)
        before = db_path.read_bytes()
        with self.assertRaisesRegex(channel.ChannelError, '^existing_schema_required$'):
            channel.worker_once(self.fx.config, stage_only=True)
        self.assertEqual(db_path.read_bytes(), before)
        self.assertFalse((self.fx.state / 'publisher.lock').exists())
        with contextlib.closing(sqlite3.connect(db_path)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sqlite_master').fetchone()[0], 0)

    def test_stage_bad_mode_is_not_repaired(self):
        db_path = self.fx.state / 'state.sqlite3'
        db_path.chmod(0o640)
        before = db_path.read_bytes()
        with self.assertRaisesRegex(channel.ChannelError, '^shared_state_mode_required$'):
            channel.worker_once(self.fx.config, stage_only=True)
        self.assertEqual(stat.S_IMODE(db_path.stat().st_mode), 0o640)
        self.assertEqual(db_path.read_bytes(), before)

    def test_existing_only_connect_uses_rw_uri_and_cannot_create_after_last_check(self):
        db_path = self.fx.state / 'state.sqlite3'
        real_connect = channel.sqlite3.connect
        saved = self.fx.state / 'saved-state.sqlite3'
        def disappear(path, *args, **kwargs):
            self.assertTrue(kwargs.get('uri'))
            self.assertTrue(path.endswith('?mode=rw'))
            db_path.rename(saved)
            return real_connect(path, *args, **kwargs)
        with mock.patch.object(channel.sqlite3, 'connect', side_effect=disappear):
            with self.assertRaises(sqlite3.OperationalError):
                channel.Store(self.fx.config, existing_only=True)
        self.assertFalse(db_path.exists())
        self.assertFalse((self.fx.state / 'publisher.lock').exists())

    def test_existing_only_uri_escapes_question_mark_and_fragment_in_path(self):
        with tempfile.TemporaryDirectory(prefix='TEST-FIXTURE-?mode=rwc#') as base:
            state = Path(base) / 'state ?mode=rwc#'
            state.mkdir()
            config = channel.Config(state, self.fx.root, fixture_channel.TEST_KEY)
            channel.Store(config)
            db_path = state / 'state.sqlite3'
            db_path.chmod(0o660)
            store = channel.Store(config, existing_only=True)
            with store.connect() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM requests').fetchone()[0], 0)
            self.assertEqual(set(path.name for path in state.iterdir()), {'state.sqlite3'})

    def test_existing_only_rejects_extra_schema_and_keeps_bytes(self):
        db_path = self.fx.state / 'state.sqlite3'
        with contextlib.closing(sqlite3.connect(db_path)) as db, db:
            db.execute('CREATE TABLE unrelated(value TEXT)')
        before = db_path.read_bytes()
        with self.assertRaisesRegex(channel.ChannelError, '^existing_schema_required$'):
            channel.worker_once(self.fx.config, stage_only=True)
        self.assertEqual(db_path.read_bytes(), before)

    def test_existing_only_rejects_symlink_and_hardlink_before_sqlite_open(self):
        db_path = self.fx.state / 'state.sqlite3'
        saved = self.fx.state / 'saved-state.sqlite3'
        db_path.rename(saved)
        db_path.symlink_to(saved.name)
        with mock.patch.object(channel.sqlite3, 'connect') as connect:
            with self.assertRaisesRegex(channel.ChannelError, '^unsafe_state$'):
                channel.Store(self.fx.config, existing_only=True)
        connect.assert_not_called()
        db_path.unlink()
        os.link(saved, db_path)
        with mock.patch.object(channel.sqlite3, 'connect') as connect:
            with self.assertRaisesRegex(channel.ChannelError, '^unsafe_state$'):
                channel.Store(self.fx.config, existing_only=True)
        connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()

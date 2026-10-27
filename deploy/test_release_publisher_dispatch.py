"""Real loopback ledger dispatch with inert archives; no remote service or credentials."""
import os
from pathlib import Path
import stat
import unittest
from unittest import mock

from deploy import release_channel as channel
from deploy import test_release_channel as channel_fixture


class FixedPipelineError(Exception):
    def __init__(self,*,attempted=False,uncertain=False):
        self.attempted,self.uncertain=attempted,uncertain
        super().__init__('FIXTURE_PRIVATE_DO_NOT_REFLECT')


class PublisherDispatchTests(unittest.TestCase):
    def setUp(self):
        self.fx=channel_fixture.ReleaseChannelTests(methodName='runTest');self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        (self.fx.state/'state.sqlite3').chmod(0o660)
        self.calls=[]

    def coordinator(self,behavior='pass'):
        fx=self.fx;calls=self.calls
        class FixedCoordinator:
            error_type=FixedPipelineError
            def activate(self,value):
                calls.append(dict(value))
                if behavior=='precheck':raise FixedPipelineError()
                if behavior=='unknown':raise RuntimeError('FIXTURE_PRIVATE_DO_NOT_REFLECT')
                if behavior=='bad_result':return {'state':'not_activated'}
                channel.release.activate(value['releaseId'],value['manifestSha256'],value['expectedCurrent'],
                    fx.fixture.receipt_path,fx.fixture.receipt_hash,fx.fixture.app_hash,fx.fixture.init_hash,
                    root=fx.root,now=fx.fixture.now)
                if behavior=='after_switch':raise FixedPipelineError(attempted=True,uncertain=True)
                return {'state':'activated_verified'}
        return FixedCoordinator()

    def queue(self):
        self.fx.stage()
        code,reply=self.fx.post('activate')
        self.assertEqual(code,202,reply)
        return reply['requestId']

    def row(self,request):
        with channel.Store(self.fx.config).connect() as db:
            return dict(db.execute('SELECT state,error FROM requests WHERE request_id=?',(request,)).fetchone())

    def test_publish_worker_uses_verified_coordinator_and_existing_ledger(self):
        request=self.queue()
        self.assertTrue(channel.worker_once(self.fx.config,coordinator=self.coordinator()))
        self.assertEqual(self.row(request),{'state':'completed','error':None})
        self.assertEqual(self.fx.status()['state'],'activated')
        self.assertEqual(len(self.calls),1)
        self.assertEqual(os.readlink(self.fx.root/'current'),'releases/'+self.fx.release_id)

    def test_known_precheck_rejection_keeps_staged_and_does_not_retry(self):
        request=self.queue();actor=self.coordinator('precheck')
        self.assertTrue(channel.worker_once(self.fx.config,coordinator=actor))
        self.assertEqual(self.row(request),{'state':'rejected','error':'publisher_gate'})
        self.assertEqual(self.fx.status()['state'],'staged')
        self.fx.assert_current_old()
        self.assertFalse(channel.worker_once(self.fx.config,coordinator=actor))
        self.assertEqual(len(self.calls),1)

    def test_unknown_and_wrong_outcome_are_permanent_gates_without_raw_errors(self):
        for behavior in ('unknown','bad_result'):
            with self.subTest(behavior=behavior):
                # One independent fixture per uncertain attempt; no ledger reset.
                if behavior!='unknown':
                    other=PublisherDispatchTests(methodName='runTest');other.setUp()
                    self.addCleanup(other.doCleanups)
                    other.check_uncertain(behavior)
                else:self.check_uncertain(behavior)

    def check_uncertain(self,behavior):
        request=self.queue();actor=self.coordinator(behavior)
        self.assertTrue(channel.worker_once(self.fx.config,coordinator=actor))
        self.assertEqual(self.row(request),{'state':'uncertain','error':'manual_review'})
        self.assertNotIn('PRIVATE',str(self.fx.status()))
        with self.assertRaisesRegex(channel.ChannelError,'pending_manual_review'):
            channel.worker_once(self.fx.config,coordinator=actor)
        self.assertEqual(len(self.calls),1)

    def test_error_after_real_fixture_switch_stays_uncertain_no_auto_rollback(self):
        self.check_uncertain('after_switch')
        self.assertEqual(os.readlink(self.fx.root/'current'),'releases/'+self.fx.release_id)
        self.assertTrue((self.fx.root/'releases/old').is_dir())

    def test_public_static_mode_does_not_inherit_shared_queue_umask(self):
        code,reply=self.fx.upload();self.assertEqual(code,202)
        previous=os.umask(0o007)
        try:self.assertTrue(channel.worker_once(self.fx.config))
        finally:os.umask(previous)
        candidate=self.fx.root/'releases'/self.fx.release_id
        self.assertEqual(stat.S_IMODE(candidate.stat().st_mode),0o755)
        self.assertEqual(stat.S_IMODE((candidate/'index.html').stat().st_mode),0o644)

    def test_coordinator_requires_existing_0660_schema_and_cannot_be_stage_only(self):
        actor=self.coordinator()
        with self.assertRaisesRegex(channel.ChannelError,'invalid_worker_mode'):
            channel.worker_once(self.fx.config,stage_only=True,coordinator=actor)
        (self.fx.state/'state.sqlite3').chmod(0o640)
        with self.assertRaisesRegex(channel.ChannelError,'shared_state_mode_required'):
            channel.worker_once(self.fx.config,coordinator=actor)
        self.assertEqual(self.calls,[])

    def test_production_receiver_mode_will_not_create_missing_database(self):
        fresh=self.fx.fixture.base/'fixture-empty-receiver';fresh.mkdir()
        cfg=channel.Config(fresh,self.fx.root,self.fx.config.key)
        with self.assertRaisesRegex(channel.ChannelError,'existing_state_required'):
            channel.make_server(cfg,existing_only=True)
        self.assertFalse((fresh/'state.sqlite3').exists())

    def test_disabled_publisher_stops_before_key_or_ledger_access(self):
        class DisabledCoordinator:
            @staticmethod
            def load_policy():return {'enabled':False}
            def __init__(self,*args,**kwargs):raise AssertionError('disabled constructor must not run')
        module=type('Module',(),{'Coordinator':DisabledCoordinator})
        spec=mock.Mock();spec.loader.exec_module.return_value=None
        with mock.patch.object(channel.sys,'argv',['channel','publish-worker']),\
             mock.patch.object(channel.os,'geteuid',return_value=0),\
             mock.patch.object(channel.importlib.util,'spec_from_file_location',return_value=spec),\
             mock.patch.object(channel.importlib.util,'module_from_spec',return_value=module),\
             mock.patch.object(channel,'load_config') as config,\
             mock.patch.object(channel,'Store') as store:
            with self.assertRaisesRegex(channel.ChannelError,'publisher_disabled'):channel.main()
            config.assert_not_called();store.assert_not_called()

    def test_administrator_rollback_is_bound_and_does_not_load_key_or_reenable_policy(self):
        result={'state':'rolled_back_verified','databaseChanged':False}
        actor=mock.Mock();actor.rollback.return_value=result
        class DisabledCoordinator:
            @staticmethod
            def load_policy():return {'enabled':False}
            def __new__(cls,*args,**kwargs):return actor
        module=type('Module',(),{'Coordinator':DisabledCoordinator})
        spec=mock.Mock()
        with mock.patch.object(channel.sys,'argv',['channel','rollback-static','b'*32]),\
             mock.patch.object(channel.os,'geteuid',return_value=0),\
             mock.patch.object(channel.importlib.util,'spec_from_file_location',return_value=spec),\
             mock.patch.object(channel.importlib.util,'module_from_spec',return_value=module),\
             mock.patch.object(channel,'load_config') as config,\
             mock.patch('builtins.print'):
            channel.main()
            actor.rollback.assert_called_once_with('b'*32);config.assert_not_called()
        with mock.patch.object(channel.sys,'argv',['channel','rollback-static','../../other']),\
             mock.patch.object(channel,'load_config') as config:
            with self.assertRaises(channel.ChannelError):channel.main()
            config.assert_not_called()

    def test_publish_worker_nonroot_stops_before_policy_key_or_database_access(self):
        with mock.patch.object(channel.sys,'argv',['channel','publish-worker']),\
             mock.patch.object(channel.os,'geteuid',return_value=1000),\
             mock.patch.object(channel,'load_config') as config:
            with self.assertRaisesRegex(channel.ChannelError,'publisher_requires_root'):channel.main()
            config.assert_not_called()


if __name__=='__main__':unittest.main()

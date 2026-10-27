"""Publisher choreography/temporary filesystem tests; never a server install."""
import contextlib
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest import mock

from deploy import publisher_pipeline as p
from deploy import manual_api_acceptance as acceptance

ROOT=Path(__file__).resolve().parents[1]
BAIT='PRIVATE_FIXTURE_PASSWORD_COOKIE_NEVER_PRINT'


def policy(enabled=True):
    return {'schema':1,'enabled':enabled,'maximumAutomaticAccounts':2,
        'approvedManifestSha256':p.APPROVED_MANIFEST,
        'apiBindings':{'manifestSha256':p.APPROVED_MANIFEST,'apiAppSha256':'a'*64,'apiInitSha256':'b'*64,
            'apiPreviewSha256':'c'*64,'backendTarget':'api-releases/fixture',
            'apiUnitSha256':'d'*64,'nginxConfigSha256':'e'*64}}


def envelope(release_id='1'*32):
    return {'schema':1,'operation':'activate','repo':p.REPO,'ref':p.REF,'commit':'f'*40,
        'releaseId':release_id,'artifactSha256':'a'*64,'artifactBytes':1234,
        'manifestSha256':p.APPROVED_MANIFEST,'expectedCurrent':p.OLD,
        'requestId':'2'*32,'issuedAt':1793062800,'expiresAt':1793063100}


class MemoryHost:
    audit=Path('/var/backups/fkssj-publisher')
    budget=p.GLOBAL_BUDGET
    closed=p.CLOSED
    def __init__(self):
        self.files={};self.directories=set();self.events=[];self.account_requests=0
        self.target=p.OLD;self.time=dt.datetime.fromtimestamp(1793062801,dt.timezone.utc)
        self.fail=None;self.last_receipt=None;self.candidate_changed=False;self.old_changed=False
        self.snapshot={'manifest':{'version':'0.14.0'},'files':{'release.json':p.APPROVED_MANIFEST,'index.html':'1'*64}}
        self.old={'target':p.OLD,'files':['unchanged-legacy-fixture']}
    def euid(self):return 0
    def now(self):return self.time
    @contextlib.contextmanager
    def locked(self):self.events.append('lock');yield
    def exists(self,path):return str(path) in self.files or str(path) in self.directories
    def new_release(self,release_id):
        target=self.audit/'releases'/release_id
        if self.exists(target):raise FileExistsError(BAIT)
        self.directories.add(str(target));self.events.append('new_release');return target
    def new_file(self,path,data,mode=0o600):
        if self.exists(path):raise FileExistsError(BAIT)
        self.events.append(('write',str(path)))
        self.files[str(path)]=bytes(data)
    def private_read(self,path):return self.files[str(path)]
    def current(self):return self.target
    def old_snapshot(self):return self.old|({'changed':True} if self.old_changed else {})
    def candidate(self,release_id,manifest):return self.snapshot|({'changed':True} if self.candidate_changed else {})
    def verify_api(self,bindings):
        self.events.append('verify_api')
        if self.fail=='api_precheck':raise RuntimeError(BAIT)
    def run_acceptance(self,bindings):
        self.events.append('api_acceptance')
        assert self.exists(self.budget),'global budget marker must precede first account'
        assert any(k.endswith('/acceptance-attempt.json') and k!=str(self.budget) for k in self.files)
        self.account_requests+=2
        if self.fail=='api_acceptance':
            error=acceptance.AcceptanceError('identity_isolation_failed');error.args=(BAIT,)
            error.summary={'accountCreationRequests':2,'accountsConfirmed':1,
                'requestOutcomeMayBeUncertain':True,'password':BAIT}
            raise error
        if self.fail=='expires_after_api':self.time+=dt.timedelta(seconds=400)
        if self.fail=='candidate_drift':self.candidate_changed=True
        if self.fail=='legacy_drift':self.old_changed=True
        return {'receipt':b'INERT_FIXTURE_FULL_RECEIPT',
                'summary':{'accountCreationRequests':2,'accountsConfirmed':2,'restartAttempted':True,
                           'requestOutcomeMayBeUncertain':False,'password':BAIT}}
    def receipt(self,path,digest,bindings):
        self.events.append('receipt')
        assert hashlib.sha256(self.files[str(path)]).hexdigest()==digest
        if self.fail=='receipt':raise RuntimeError(BAIT)
    def activate(self,value,path,digest,bindings,clock):
        self.events.append('activate');clock()
        self.target='releases/'+value['releaseId']
        if self.fail=='activate_after_switch':raise OSError(BAIT)
        return {'status':'activated'}
    def close_preview(self):
        self.events.append('close_preview')
        if self.fail=='close_preview':raise OSError(BAIT)
        self.new_file(self.closed,b'closed',0o644)
    def rollback(self,value,old,snapshot,record,write):
        self.events.append('rollback')
        assert self.target=='releases/'+value['releaseId']
        assert old==self.old_snapshot() and snapshot==self.candidate(value['releaseId'],value['manifestSha256'])
        write('rollback-attempt.json',{'state':'attempted'})
        self.target=p.OLD;write('rolled-back.json',{'state':'rolled_back'})
        return {'state':'rolled_back_verified','current':p.OLD,'databaseChanged':False}


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.h=MemoryHost();self.policy=policy()
        source={'api/api/app.py':'a'*64,'api/api/__init__.py':'b'*64,'api/api/preview.py':'c'*64,
            **{'static/'+name:value for name,value in self.h.snapshot['files'].items()}}
        patch=mock.patch.object(p,'APPROVED_SOURCE',p.sha(p.canonical(source)))
        patch.start();self.addCleanup(patch.stop)
        self.c=p.Coordinator(self.policy,self.h)
    def call(self,**changes):return self.c.activate(envelope()|changes)
    def fail(self,code=None,**changes):
        with self.assertRaises(p.PipelineError) as ended:self.call(**changes)
        self.assertNotIn(BAIT,str(ended.exception))
        if code:self.assertEqual(ended.exception.code,code)
        self.assertEqual(set(self.c.safe_summary({'password':BAIT})),set())
        for value in self.h.files.values():self.assertNotIn(BAIT.encode(),value)
        return ended.exception

    def test_fixed_scope_policy_and_default_disabled_never_creates_accounts(self):
        for change in ({'enabled':True,'maximumAutomaticAccounts':3},{'schema':True},
                       {'approvedManifestSha256':'b'*64},{'extra':True}):
            with self.assertRaises(p.PipelineError):p.Coordinator(self.policy|change,self.h)
        self.c=p.Coordinator(policy(False),self.h);error=self.fail('disabled')
        self.assertFalse(error.attempted);self.assertEqual(self.h.files,{})

    def test_success_keeps_truthful_waiver_new32hex_release_and_full_budget_markers(self):
        result=self.call()
        self.assertEqual(result['state'],'activated_verified');self.assertEqual(self.h.account_requests,2)
        self.assertEqual(result['manualBrowserChecks'],'waived_not_run');self.assertIs(result['browserChecksPerformed'],False)
        journal=self.h.audit/'releases'/('1'*32)
        decision=json.loads(self.h.private_read(journal/'manual-qa-waiver.json'))
        self.assertEqual(set(decision['manualChecks'].values()),{'waived_not_run'})
        self.assertEqual(decision['releaseId'],'1'*32);self.assertEqual(decision['commit'],'f'*40)
        self.assertEqual(decision['injectionEvidence']['runner'],'cloud_node_fixture')
        self.assertFalse(any('browser-acceptance' in path for path in self.h.files))
        self.assertLess(self.h.events.index(('write',str(self.h.budget))),self.h.events.index('api_acceptance'))
        self.assertLess(self.h.events.index('receipt'),self.h.events.index('activate'))
        self.assertLess(self.h.events.index('activate'),self.h.events.index('close_preview'))
        self.assertTrue(self.h.exists(journal/'activated.json'))
        self.assertEqual(json.loads(self.h.private_read(self.h.budget))['maximumAutomaticAccounts'],2)

    def test_any_existing_global_manual_or_channel_attempt_blocks_all_other_release_ids(self):
        self.h.files[str(self.h.budget)]=b'old manual or unknown attempt preserved'
        for release_id in ('1'*32,'2'*32):
            error=self.fail('global_account_budget_used',releaseId=release_id)
            self.assertFalse(error.attempted)
        self.assertEqual(self.h.account_requests,0);self.assertEqual(len(self.h.files),1)

    def test_replay_never_creates_more_accounts_and_keeps_per_release_audit(self):
        self.call();before=dict(self.h.files)
        self.fail('global_account_budget_used',releaseId='3'*32)
        self.assertEqual(self.h.account_requests,2);self.assertEqual(self.h.files,before)

    def test_existing_release_directory_or_preview_closed_is_unknown_no_reuse(self):
        self.h.directories.add(str(self.h.audit/'releases'/('1'*32)))
        self.fail('existing_attempt');self.assertEqual(self.h.account_requests,0)
        self.h.directories.clear();self.h.files[str(self.h.closed)]=b'closed'
        self.fail('existing_attempt');self.assertEqual(self.h.account_requests,0)

    def test_source_scope_type_timestamp_and_current_rejections_are_premutation(self):
        for change in ({'manifestSha256':'a'*64},{'releaseId':'manual-old-id'},{'expectedCurrent':'releases/unknown'},
                       {'repo':'attacker/repo'},{'ref':'refs/heads/other'},{'artifactBytes':True},
                       {'issuedAt':1793062802},{'expiresAt':1793062800},{'expiresAt':1793063101}):
            self.fail(**change);self.assertEqual(self.h.account_requests,0);self.assertEqual(self.h.files,{})
        self.h.target='releases/newer';self.fail('current_changed');self.assertEqual(self.h.files,{})

    def test_candidate_source_digest_or_API_precheck_failure_never_reserves_accounts(self):
        self.h.snapshot['files']['index.html']='4'*64
        self.fail('candidate_changed');self.assertEqual(self.h.files,{})
        self.h.snapshot['files']['index.html']='1'*64;self.h.fail='api_precheck'
        self.fail();self.assertEqual(self.h.files,{})

    def test_API_failure_retains_all_audit_and_global_budget_without_activation_or_secret(self):
        self.h.fail='api_acceptance';error=self.fail('api_acceptance')
        self.assertTrue(error.attempted and error.uncertain);self.assertEqual(self.h.account_requests,2)
        self.assertNotIn('activate',self.h.events);self.assertEqual(self.h.target,p.OLD)
        failure=json.loads(self.h.private_read(self.h.audit/'releases'/('1'*32)/'failure.json'))
        self.assertEqual(failure['summary']['accountCreationRequests'],2)
        self.h.fail=None;self.fail('global_account_budget_used',releaseId='4'*32)
        self.assertEqual(self.h.account_requests,2)

    def test_expiry_during_API_or_drift_or_bad_receipt_blocks_activation(self):
        for failure in ('expires_after_api','candidate_drift','legacy_drift','receipt'):
            with self.subTest(failure=failure):
                self.setUp();self.h.fail=failure;error=self.fail()
                self.assertTrue(error.attempted and error.uncertain);self.assertNotIn('activate',self.h.events)
                self.assertEqual(self.h.target,p.OLD)

    def test_post_switch_or_preview_failure_is_uncertain_without_retry_or_rollback(self):
        for failure in ('activate_after_switch','close_preview'):
            with self.subTest(failure=failure):
                self.setUp();self.h.fail=failure;error=self.fail()
                self.assertTrue(error.attempted and error.uncertain)
                self.assertEqual(self.h.target,'releases/'+'1'*32)
                self.assertEqual(self.h.events.count('activate'),1)
                self.assertNotIn('rollback',self.h.events)

    def test_only_confirmed_per_release_can_static_rollback_once_without_API_or_budget_changes(self):
        self.call();before=self.h.account_requests
        result=self.c.rollback('1'*32)
        self.assertEqual(result['state'],'rolled_back_verified');self.assertFalse(result['databaseChanged'])
        self.assertEqual(self.h.account_requests,before);self.assertTrue(self.h.exists(self.h.budget))
        with self.assertRaises(p.PipelineError):self.c.rollback('1'*32)
        with self.assertRaises((p.PipelineError,KeyError)):self.c.rollback('2'*32)

    def test_policy_reader_normalizes_missing_IO_and_duplicate_keys(self):
        with mock.patch.object(p,'trusted_read',side_effect=FileNotFoundError(BAIT)):
            with self.assertRaisesRegex(p.PipelineError,'invalid_policy'):p.Coordinator.load_policy()
        with self.assertRaises(p.PipelineError):p.strict_json(b'{"enabled":false,"enabled":true}')


class PrivateFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        @contextlib.contextmanager
        def directory(path):
            fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:yield fd
            finally:os.close(fd)
        self.patch=mock.patch.object(p,'trusted_directory',directory);self.patch.start();self.addCleanup(self.patch.stop)
        real_fstat=os.fstat
        def virtual(fd):
            info=real_fstat(fd);values={key:getattr(info,key) for key in dir(info) if key.startswith('st_')};values['st_uid']=0
            return types.SimpleNamespace(**values)
        patch=mock.patch.object(p.os,'fstat',side_effect=virtual);patch.start();self.addCleanup(patch.stop)

    def test_private_no_follow_regular_single_link_size_mode_and_changed_bytes(self):
        path=self.root/'record.json';path.write_bytes(b'{"fixture":true}\n');path.chmod(0o600)
        self.assertEqual(p.trusted_read(path,100,private=True),path.read_bytes())
        path.chmod(0o640)
        with self.assertRaises(p.PipelineError):p.trusted_read(path,100,private=True)
        path.chmod(0o600);os.link(path,self.root/'hardlink')
        with self.assertRaises(p.PipelineError):p.trusted_read(path,100,private=True)
        (self.root/'hardlink').unlink()
        with self.assertRaises(p.PipelineError):p.trusted_read(path,2,private=True)
        target=self.root/'target';path.rename(target);path.symlink_to(target)
        with self.assertRaises(OSError):p.trusted_read(path,100,private=True)

    def test_exclusive_private_writes_do_not_overwrite_or_chown(self):
        h=object.__new__(p.Host);path=self.root/'new.json';h.new_file(path,b'fixed nonsecret')
        self.assertEqual(path.read_bytes(),b'fixed nonsecret');self.assertEqual(path.stat().st_mode&0o777,0o600)
        with self.assertRaises(FileExistsError):h.new_file(path,b'REPLACEMENT')
        self.assertEqual(path.read_bytes(),b'fixed nonsecret')


class ApprovedScopeTests(unittest.TestCase):
    def test_real_public_manifest_payload_and_API_code_match_approved_source(self):
        path=ROOT/'deploy/approved-v014-release.json'
        self.assertTrue(path.is_file(),'the trusted approved manifest is source input, not workspace state')
        raw=path.read_bytes();manifest=json.loads(raw)
        self.assertEqual(hashlib.sha256(raw).hexdigest(),p.APPROVED_MANIFEST)
        self.assertEqual(manifest['fileCount'],34)
        sources={'api/'+name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest()
            for name in ('api/app.py','api/__init__.py','api/preview.py')}
        sources.update({'static/'+row['path']:row['sha256'] for row in manifest['files']})
        sources['static/release.json']=p.APPROVED_MANIFEST
        self.assertEqual(p.sha(p.canonical(sources)),p.APPROVED_SOURCE)
        old=json.loads((ROOT/'deploy/receipt-v0.13.0-2026-10-20.json').read_text())
        self.assertEqual(len(old['files']),29)


class RealStaticBoundaryTests(unittest.TestCase):
    def setUp(self):
        from deploy import test_static_release as fixture
        self.s=fixture.release
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)/'root';self.root.mkdir()
        old=self.root/p.OLD;old.mkdir(parents=True);(old/'legacy.txt').write_bytes(b'OLD FIXTURE')
        self.release_id='7'*32
        new=self.root/'releases'/self.release_id;new.mkdir();(new/'new.txt').write_bytes(b'NEW FIXTURE')
        (self.root/'current').symlink_to('releases/'+self.release_id)
        self.sentinel=Path(self.tmp.name)/'PLAYER-FIXTURE-NOT-TOUCHED';self.sentinel.write_bytes(b'SYNTHETIC PLAYER DATA')
        self.audit=Path(self.tmp.name)/'audit';self.audit.mkdir();self.writes={}
        self.h=object.__new__(p.Host);self.h.s=self.s;self.h.root=self.root
        def info(fd):
            actual=os.fstat(fd);values={k:getattr(actual,k) for k in dir(actual) if k.startswith('st_')};values['st_uid']=0
            return types.SimpleNamespace(**values)
        self.h.info=info
        self.old={'hash':hashlib.sha256((old/'legacy.txt').read_bytes()).hexdigest()}
        self.snapshot={'hash':hashlib.sha256((new/'new.txt').read_bytes()).hexdigest()}
        self.h.old_snapshot=lambda:self.old;self.h.candidate=lambda *args:self.snapshot
        self.value=envelope(self.release_id)

    def write(self,name,value):
        path=self.audit/name
        with path.open('xb') as f:f.write(p.canonical(value))
        self.writes[name]=value

    def run_rollback(self):return self.h.rollback(self.value,self.old,self.snapshot,{},self.write)

    def test_real_atomic_static_rollback_preserves_both_trees_and_data(self):
        result=self.run_rollback()
        self.assertEqual(result['state'],'rolled_back_verified')
        self.assertEqual(os.readlink(self.root/'current'),p.OLD)
        self.assertTrue((self.root/'releases'/self.release_id/'new.txt').is_file())
        self.assertEqual(self.sentinel.read_bytes(),b'SYNTHETIC PLAYER DATA')
        self.assertFalse((self.root/self.s.PENDING).exists())
        self.assertEqual(set(self.writes),{'rollback-attempt.json','rolled-back.json'})

    def test_fault_after_replace_or_pending_unlink_retains_unknown_gate(self):
        real_replace=os.replace
        def fail_after_replace(*args,**kwargs):real_replace(*args,**kwargs);raise OSError(BAIT)
        with mock.patch.object(p.os,'replace',side_effect=fail_after_replace):
            with self.assertRaises(p.PipelineError) as ended:self.run_rollback()
        self.assertTrue(ended.exception.uncertain)
        self.assertEqual(os.readlink(self.root/'current'),p.OLD)
        self.assertTrue((self.root/self.s.PENDING).is_file())
        self.assertEqual(self.sentinel.read_bytes(),b'SYNTHETIC PLAYER DATA')

    def test_failure_after_unlink_restores_pending_without_reverting_static(self):
        real_unlink,real_sync=os.unlink,os.fsync;state={'unlinked':False,'failed':False}
        def unlink(name,*args,**kwargs):
            result=real_unlink(name,*args,**kwargs)
            if name==self.s.PENDING:state['unlinked']=True
            return result
        def sync(fd):
            if state['unlinked'] and not state['failed']:
                state['failed']=True;raise OSError(BAIT)
            return real_sync(fd)
        with mock.patch.object(p.os,'unlink',side_effect=unlink),mock.patch.object(p.os,'fsync',side_effect=sync):
            with self.assertRaises(p.PipelineError) as ended:self.run_rollback()
        self.assertTrue(ended.exception.uncertain and ended.exception.attempted)
        self.assertEqual(os.readlink(self.root/'current'),p.OLD)
        self.assertTrue((self.root/self.s.PENDING).is_file())

    def test_foreign_pending_replacement_is_retained_and_reports_uncertain(self):
        original_write=self.write
        foreign=b'UNRELATED PENDING FIXTURE MUST SURVIVE'
        def replace_after_confirmation(name,value):
            original_write(name,value)
            if name=='rolled-back.json':
                target=self.root/self.s.PENDING
                target.unlink();target.write_bytes(foreign);target.chmod(0o600)
        self.write=replace_after_confirmation
        with self.assertRaises(p.PipelineError) as ended:self.run_rollback()
        self.assertTrue(ended.exception.attempted and ended.exception.uncertain)
        self.assertEqual(os.readlink(self.root/'current'),p.OLD)
        self.assertEqual((self.root/self.s.PENDING).read_bytes(),foreign)
        self.assertEqual(self.sentinel.read_bytes(),b'SYNTHETIC PLAYER DATA')

    def test_identical_foreign_pending_inode_is_not_treated_as_our_created_file(self):
        original_write=self.write
        def replace_after_confirmation(name,value):
            original_write(name,value)
            if name=='rolled-back.json':
                target=self.root/self.s.PENDING;raw=target.read_bytes()
                replacement=self.root/'foreign-pending';replacement.write_bytes(raw);replacement.chmod(0o600)
                os.replace(replacement,target)
        self.write=replace_after_confirmation
        with self.assertRaises(p.PipelineError) as ended:self.run_rollback()
        self.assertTrue(ended.exception.uncertain)
        self.assertTrue((self.root/self.s.PENDING).is_file())
        self.assertEqual(os.readlink(self.root/'current'),p.OLD)

    def test_envelope_clock_is_rechecked_inside_existing_low_level_activation(self):
        from deploy import test_static_release as fixture
        fx=fixture.StaticReleaseTests(methodName='runTest');fx.setUp();self.addCleanup(fx.doCleanups)
        fx.stage(release_id=self.release_id)
        h=object.__new__(p.Host);h.root=fx.root;h.s=self.s
        value=envelope(self.release_id)|{'expectedCurrent':'releases/old','manifestSha256':fx.manifest_hash}
        calls=[]
        def clock():
            calls.append(1)
            if len(calls)>1:raise p.PipelineError('expired')
            return fx.now
        with self.assertRaises(self.s.Uncertain):
            h.activate(value,fx.receipt_path,fx.receipt_hash,
                {'apiAppSha256':fx.app_hash,'apiInitSha256':fx.init_hash},clock)
        self.assertGreaterEqual(len(calls),2)
        self.assertEqual(os.readlink(fx.root/'current'),'releases/old')
        self.assertTrue((fx.root/self.s.PENDING).is_file())


if __name__=='__main__':unittest.main()

"""All trees, API receipts, browser attestations and ownership are fixtures."""
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import types
import unittest
from unittest import mock

from deploy import manual_static_switch as subject
from deploy import test_static_release as fixture


def virtual(info, uid, gid):
    fields = {k:getattr(info,k) for k in dir(info) if k.startswith('st_')}
    fields.update(st_uid=uid,st_gid=gid)
    return types.SimpleNamespace(**fields)


class FixtureHost(subject.Host):
    def __init__(self, fx):
        self.fx=fx;self.root=fx.root;self.source=fx.source
        self.backup=fx.base/'private-rollback-records';self.receipt=fx.receipt_path
        self.owners={}
    def euid(self): return 0
    def now(self): return self.fx.now
    def owner(self, fd, uid, gid):
        info=os.fstat(fd);self.owners[(info.st_dev,info.st_ino)]=(uid,gid)
    def info(self, fd):
        info=os.fstat(fd);return virtual(info,*self.owners.get((info.st_dev,info.st_ino),(0,0)))
    def metadata_at(self, parent, name):
        return virtual(os.stat(name,dir_fd=parent,follow_symlinks=False),1001,1001)
    @contextlib.contextmanager
    def directory(self,path):
        with fixture.release.directory(path) as fd: yield fd


class ManualSwitchTests(unittest.TestCase):
    def setUp(self):
        self.fx=fixture.StaticReleaseTests(methodName='runTest');self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        old=self.fx.root/'releases/old';(old/'old.txt').unlink()
        old.rename(self.fx.root/subject.OLD)
        self.old=self.fx.root/subject.OLD
        (self.fx.root/'current').unlink();(self.fx.root/'current').symlink_to(subject.OLD)
        entries=[]
        for name in sorted(subject.OLD_FILES):
            path=self.old/name;path.parent.mkdir(parents=True,exist_ok=True)
            raw=('FIXTURE LEGACY PUBLIC '+name+'\n').encode();path.write_bytes(raw)
            entries.append({'path':name,'bytes':len(raw),'sha256':subject.sha(raw)})
        manifest={'version':'0.13.0','createdAt':'2026-10-20T07:10:30Z','fileCount':29,
                  'totalBytes':sum(r['bytes'] for r in entries),'files':entries}
        (self.old/'release.json').write_bytes(subject.encode(manifest))
        self.h=FixtureHost(self.fx)
        self.bindings={'releaseId':'TEST-FIXTURE-v014','manifestSha256':self.fx.manifest_hash,
                       'sourceSha256':'d'*64,'apiAppSha256':self.fx.app_hash,
                       'apiInitSha256':self.fx.init_hash,'legacyFiles':entries}
        self.engine=subject.Engine(self.h,self.bindings,fixture.release)
        self.fx.receipt_path.chmod(0o600)
        self.sentinel=self.fx.db.read_bytes()

    def stage(self):
        result=self.engine.stage();self.assertEqual(result['state'],'staged_verified',result)

    def browser(self, **updates):
        record={'schema':1,'type':'fkssj-browser-acceptance',
                'basis':'operator_attestation_after_real_browser_checks',
                'origin':fixture.release.ORIGIN,'manifestSha256':self.fx.manifest_hash,
                'sourceSha256':self.bindings['sourceSha256'],'checkedAt':'2026-10-21T08:00:00Z',
                'checks':dict.fromkeys(subject.BROWSER_CHECKS,True)}
        record.update(updates);path=self.h.backup/subject.BROWSER
        path.write_bytes(subject.encode(record));path.chmod(0o600)
        return subject.sha(path.read_bytes())

    def activate(self):
        self.stage();browser=self.browser()
        result=self.engine.activate(self.fx.receipt_hash,browser)
        self.assertEqual(result['state'],'activated_verified',result)
        return result

    def unchanged_data(self):
        self.assertEqual(self.fx.db.read_bytes(),self.sentinel)
        self.assertEqual(os.readlink(self.fx.root/'api-current'),'api-releases/TEST-FIXTURE-api')

    def test_plan_zero_writes_and_no_browser_claim(self):
        before=set(self.fx.root.rglob('*'))
        result=self.engine.plan()
        self.assertEqual(result['state'],'plan_ready')
        self.assertFalse(result['browserChecksPerformed'])
        self.assertEqual(set(self.fx.root.rglob('*')),before)
        self.assertFalse(self.h.backup.exists())
        self.unchanged_data()

    def test_stage_never_switches_and_keeps_public_modes(self):
        self.stage()
        self.assertEqual(os.readlink(self.fx.root/'current'),subject.OLD)
        new=self.fx.root/'releases'/self.bindings['releaseId']
        self.assertEqual(stat.S_IMODE(new.stat().st_mode),0o755)
        self.assertEqual(stat.S_IMODE((new/'index.html').stat().st_mode),0o644)
        self.assertEqual(stat.S_IMODE(self.h.backup.stat().st_mode),0o700)
        self.assertEqual(stat.S_IMODE((self.h.backup/'old-tree.json').stat().st_mode),0o600)
        self.unchanged_data()

    def test_actual_static_activate_then_only_static_rollback(self):
        self.activate()
        self.assertEqual(os.readlink(self.fx.root/'current'),self.engine.new)
        result=self.engine.rollback()
        self.assertEqual(result['state'],'rolled_back_verified',result)
        self.assertEqual(os.readlink(self.fx.root/'current'),subject.OLD)
        self.assertTrue((self.fx.root/self.engine.new).is_dir())
        self.assertFalse((self.fx.root/fixture.release.PENDING).exists())
        self.unchanged_data()

    def test_missing_browser_and_false_or_wrong_bindings_never_switch(self):
        self.stage()
        missing=self.engine.activate(self.fx.receipt_hash,'0'*64)
        self.assertEqual(missing['reason'],'browser_gate_missing')
        cases=[{'manifestSha256':'0'*64},{'sourceSha256':'0'*64},
               {'basis':'unit_test_only'}, {'checkedAt':'2026-10-20T08:00:00Z'},
               {'checks':dict.fromkeys(subject.BROWSER_CHECKS,False)}]
        for case in cases:
            with self.subTest(case=case):
                result=self.engine.activate(self.fx.receipt_hash,self.browser(**case))
                self.assertEqual(result['state'],'stopped_no_switch_attempt',result)
                self.assertEqual(result['reason'],'browser_gate_invalid')
                self.assertFalse((self.h.backup/'activate-attempt.json').exists())
        self.assertEqual(os.readlink(self.fx.root/'current'),subject.OLD)

    def test_bad_api_hash_or_expired_receipt_keeps_old(self):
        self.stage();browser=self.browser()
        result=self.engine.activate('0'*64,browser)
        self.assertEqual(result['reason'],'api_receipt_invalid')
        self.fx.receipt['expiresAt']='2026-10-21T08:04:00Z';self.fx.save_receipt();self.fx.receipt_path.chmod(0o600)
        result=self.engine.activate(self.fx.receipt_hash,browser)
        self.assertEqual(result['state'],'stopped_no_switch_attempt',result)
        self.assertEqual(os.readlink(self.fx.root/'current'),subject.OLD)

    def test_legacy_payload_or_manifest_drift_blocks_staging(self):
        (self.old/'index.html').write_text('UNAPPROVED PUBLIC FILE')
        result=self.engine.stage()
        self.assertEqual(result['state'],'stopped_no_changes',result)
        self.assertFalse(self.h.backup.exists())
        self.assertFalse((self.fx.root/fixture.release.LOCK).exists())

    def test_extra_secret_bait_never_read_or_output(self):
        bait=self.old/'never-read-private.key';bait.write_text('FIXTURE-SECRET-DO-NOT-PRINT')
        original=fixture.release.read_file
        def guarded(fd,name,*args):
            self.assertNotEqual(name,bait.name)
            return original(fd,name,*args)
        with mock.patch.object(fixture.release,'read_file',side_effect=guarded):
            result=self.engine.stage()
        self.assertEqual(result['state'],'stopped_no_changes')
        self.assertNotIn('FIXTURE-SECRET',json.dumps(result))

    def test_symlink_or_hardlink_legacy_rejected(self):
        target=self.old/'index.html';raw=target.read_bytes();target.unlink()
        outside=self.fx.base/'fixture-outside';outside.write_bytes(raw);target.symlink_to(outside)
        self.assertEqual(self.engine.stage()['state'],'stopped_no_changes')
        target.unlink();target.write_bytes(raw);os.link(target,self.fx.base/'fixture-hardlink')
        self.assertEqual(self.engine.stage()['state'],'stopped_no_changes')

    def test_attempts_are_not_retried_and_unknown_activation_no_rollback(self):
        self.stage();browser=self.browser()
        with mock.patch.object(fixture.release,'activate',side_effect=fixture.release.Uncertain('FIXTURE SENSITIVE')):
            result=self.engine.activate(self.fx.receipt_hash,browser)
        self.assertEqual(result['state'],'uncertain_after_activation_attempt')
        self.assertNotIn('FIXTURE SENSITIVE',json.dumps(result))
        self.assertEqual(self.engine.activate(self.fx.receipt_hash,browser)['reason'],'existing_attempt')
        self.assertEqual(self.engine.rollback()['reason'],'activated_record_missing')

    def test_pending_tool_journal_blocks_all_switches(self):
        self.stage();browser=self.browser()
        (self.fx.root/fixture.release.PENDING).write_text('FIXTURE PENDING')
        result=self.engine.activate(self.fx.receipt_hash,browser)
        self.assertEqual(result['reason'],'pending_unknown')
        self.assertEqual(os.readlink(self.fx.root/'current'),subject.OLD)

    def test_rollback_rejects_wrong_current_or_old_tree_changes(self):
        self.activate()
        (self.old/'app.js').write_text('unexpected public edit')
        result=self.engine.rollback()
        self.assertEqual(result['state'],'stopped_no_switch_attempt')
        self.assertEqual(result['reason'],'legacy_tree_changed')
        self.assertEqual(os.readlink(self.fx.root/'current'),self.engine.new)

    def test_missing_activation_record_cannot_forge_rollback(self):
        self.stage()
        result=self.engine.rollback()
        self.assertEqual(result['state'],'stopped_no_switch_attempt')
        self.assertEqual(result['reason'],'activated_record_missing')

    def test_rollback_temp_collision_preserves_foreign_link_and_no_retry(self):
        self.activate();collision='.manual-v014-rollback-'+'a'*32
        (self.fx.root/collision).symlink_to(self.engine.new)
        fake=types.SimpleNamespace(hex='a'*32)
        with mock.patch.object(subject.uuid,'uuid4',return_value=fake):
            result=self.engine.rollback()
        self.assertEqual(result['state'],'uncertain_after_rollback_attempt',result)
        self.assertEqual(os.readlink(self.fx.root/collision),self.engine.new)
        self.assertEqual(os.readlink(self.fx.root/'current'),self.engine.new)
        self.assertEqual(self.engine.rollback()['reason'],'pending_unknown')
        self.assertTrue((self.fx.root/fixture.release.PENDING).exists())

    def test_error_after_rollback_replace_is_uncertain_and_keeps_both_trees(self):
        self.activate();real=subject.os.replace
        def fail_after(*args,**kwargs):
            real(*args,**kwargs);raise OSError('FIXTURE SENSITIVE RAW EXCEPTION')
        with mock.patch.object(subject.os,'replace',side_effect=fail_after):
            result=self.engine.rollback()
        self.assertEqual(result['state'],'uncertain_after_rollback_attempt')
        self.assertEqual(os.readlink(self.fx.root/'current'),subject.OLD)
        self.assertNotIn('FIXTURE SENSITIVE',json.dumps(result))
        self.assertTrue((self.fx.root/fixture.release.PENDING).exists())
        self.assertTrue((self.fx.root/self.engine.new).is_dir());self.unchanged_data()

    def test_bad_lock_metadata_or_busy_stops_without_switch(self):
        self.engine.lock_file();lock=self.fx.root/fixture.release.LOCK
        lock.chmod(0o666)
        result=self.engine.stage()
        self.assertEqual(result['reason'],'lock_metadata')
        self.assertEqual(os.readlink(self.fx.root/'current'),subject.OLD)
        lock.chmod(0o600)
        fd=os.open(lock,os.O_RDWR)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            result=self.engine.stage()
            self.assertEqual(result['state'],'partial_or_uncertain_inspect')
            self.assertEqual(result['reason'],'lock_busy')
        finally:os.close(fd)


if __name__ == '__main__': unittest.main()

"""Real temporary files, injected accounts/commands; no host installation."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest import mock

from deploy import manual_api_install as m

BAIT = b'FIXTURE_PRIVATE_DO_NOT_PRINT_28d9'


class FixtureHost(m.Host):
    def __init__(self, directory):
        self.root = Path(directory)
        self.owners = {}
        self.calls = []
        self.user = self.group = None
        self.fail = None
        self.pending_dropin = False
        self.exec_start = '{ path=/opt/fkssj-api/venv/bin/gunicorn ; argv[]=' + m.EXEC_ARGV + ' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }'
        self.enabled = self.started = self.reloaded = False
        for directory in ('opt', 'var/lib', 'var/backups', 'usr/lib/systemd/system', 'usr/sbin',
                          'etc/systemd/system', 'run/systemd/system', 'srv/fkssj/releases/' + m.CURRENT.split('/')[-1]):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        for path in self.root.rglob('*'):
            path.chmod(0o755)
        for path in ('srv/fkssj', 'srv/fkssj/releases', 'srv/fkssj/' + m.CURRENT):
            self.set_owner(self.root / path, 1001, 1001)
        (self.root/'srv/fkssj/current').symlink_to(m.CURRENT)
        self.set_owner(self.root/'srv/fkssj/current', 1001, 1001)
        (self.root/'usr/lib/os-release').write_bytes(b'ID=ubuntu\nVERSION_ID="24.04"\n')
        (self.root/'usr/lib/os-release').chmod(0o644)

    def euid(self): return 0

    def set_owner(self, path, uid, gid):
        value = path.lstat()
        self.owners[(value.st_dev, value.st_ino)] = (uid, gid)

    def virt(self, value):
        fields = {key: getattr(value, key) for key in dir(value) if key.startswith('st_')}
        fields['st_uid'], fields['st_gid'] = self.owners.get((value.st_dev, value.st_ino), (0, 0))
        return types.SimpleNamespace(**fields)

    def meta(self, fd): return self.virt(os.fstat(fd))

    def owner(self, fd, uid, gid):
        info = os.fstat(fd)
        self.owners[(info.st_dev, info.st_ino)] = uid, gid

    def identities(self): return self.user, self.group

    def current(self):
        path = self.root/'srv/fkssj/current'
        m.need(path.is_symlink() and os.readlink(path) == m.CURRENT, 'current_changed')
        return m.stamp(self.virt(path.lstat()))

    def api_link(self, expected):
        path = self.root / 'srv/fkssj/api-current'
        m.need(path.is_symlink() and os.readlink(path) == expected, 'changed_file')

    def show(self):
        if not (self.root/m.UNIT.lstrip('/')).exists():
            return dict(LoadState='not-found', ActiveState='inactive', SubState='dead', FragmentPath='', DropInPaths='', UnitFileState='')
        return dict(Id=m.NAME+'.service',LoadState='loaded',ActiveState='active' if self.started else 'inactive',
                    SubState='running' if self.started else 'dead',FragmentPath=m.UNIT,DropInPaths='unexpected' if self.pending_dropin else '',
                    User=m.NAME,Group=m.NAME,UnitFileState='enabled' if self.enabled else 'disabled',NeedDaemonReload='no' if self.reloaded else 'yes',ExecStart=self.exec_start)

    def run(self, argv, timeout=30):
        self.calls.append(tuple(argv))
        if self.fail and self.fail in argv:
            return dict(state='unknown',returncode=None,stdout=BAIT)
        out = b''
        if argv[:2] == ['/usr/sbin/groupadd','--system']:
            self.group = types.SimpleNamespace(gr_gid=984,gr_mem=[])
        elif argv[:2] == ['/usr/sbin/useradd','--system']:
            self.user = types.SimpleNamespace(pw_uid=993,pw_gid=984,pw_shell='/usr/sbin/nologin',pw_dir='/nonexistent')
        elif argv[:3] == ['/usr/bin/systemctl','--version'][:3]:
            out = b'systemd 255 (255.4)\n'
        elif argv[:2] == ['/usr/bin/ss','-H']:
            out = b''
        elif argv[:2] == ['/usr/bin/systemctl','daemon-reload']:
            self.reloaded = True
        elif argv[:2] == ['/usr/bin/systemctl','enable']:
            self.enabled = True
        elif argv[:2] == ['/usr/bin/systemctl','start']:
            self.started = True
        elif argv[:5] == ['/usr/bin/python3','-I','-B','-m','venv']:
            (self.root/'opt/fkssj-api/venv').mkdir()
        elif 'import sys,venv,ensurepip; print("%d.%d" % sys.version_info[:2])' in argv:
            out = b'3.12\n'
        return dict(state='finished',returncode=0,stdout=out)


class InstallTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.h = FixtureHost(temporary.name)
        self.wheel = b'PUBLIC_FIXTURE_WHEEL'
        self.sha = hashlib.sha256(self.wheel).hexdigest()
        self.patch = mock.patch.object(m, 'WHEEL_SHA', self.sha)
        self.patch.start();self.addCleanup(self.patch.stop)
        self.payload = {'api/app.py':b'# inert app\n','api/__init__.py':b'# inert init\n','api/preview.py':b'# inert preview\n',
                        'requirements.txt': ('gunicorn==26.2.0 --hash=sha256:'+self.sha+'\n').encode(),m.WHEEL:self.wheel}
        self.bindings = {'apiVersionId':'fkssj-api-'+m.digest(m.canonical({name:m.digest(self.payload[name]) for name in m.CODE_KEYS}))[:16],
                         'previewManifestSha256':'b20e11a258007f39129a47601be7a291391c9275ad5ea6b51ab0e9e7f21aa272',
                         'files':{k:dict(bytes=len(v),sha256=m.digest(v)) for k,v in self.payload.items()}}
        self.e = m.Engine(self.h, self.payload, self.bindings)

    def snapshot(self):
        return {str(p.relative_to(self.h.root)):(p.lstat().st_mode,os.readlink(p) if p.is_symlink() else None if p.is_dir() else p.read_bytes()) for p in self.h.root.rglob('*')}

    def test_plan_is_read_only_and_reports_no_acceptance_or_activation(self):
        before = self.snapshot()
        report = self.e.plan()
        self.assertEqual(report['state'],'api_install_plan_ready')
        self.assertEqual(before,self.snapshot())
        self.assertTrue(all(call[0] in ('/usr/bin/python3','/usr/bin/systemctl','/usr/bin/ss') for call in self.h.calls))

    def test_install_creates_only_named_identity_unit_paths_and_retains_current(self):
        report = self.e.install(self.e.manifest_sha256)
        self.assertEqual(report['state'],'api_installed_started_not_publicly_accepted',report)
        self.assertEqual(report['serviceUid'],993)
        self.assertFalse(report['publicApiVerified'])
        self.assertTrue(report['currentUnchanged'])
        self.assertEqual(os.readlink(self.h.root/'srv/fkssj/current'),m.CURRENT)
        self.assertEqual(os.readlink(self.h.root/m.LINK.lstrip('/')),'api-releases/'+self.bindings['apiVersionId'])
        self.assertEqual((self.h.root/m.UNIT.lstrip('/')).read_bytes(),m.unit_bytes(self.bindings))
        self.assertEqual(stat.S_IMODE((self.h.root/m.DATA.lstrip('/')).stat().st_mode),0o700)
        self.assertTrue(self.h.enabled and self.h.started)
        self.assertFalse(any('fkssj-publisher' in ' '.join(call) for call in self.h.calls))
        pip = next(call for call in self.h.calls if 'pip' in call)
        self.assertIn('--no-index',pip);self.assertIn('--require-hashes',pip)
        self.assertNotIn(BAIT.decode(),json.dumps(report))

    def test_unknown_command_after_account_creation_retains_partial_and_no_retry(self):
        self.h.fail='pip'
        report = self.e.install(self.e.manifest_sha256)
        self.assertEqual(report['state'],'partial_retained_inspect_no_retry',report)
        self.assertEqual(report['reason'],'command_unknown')
        self.assertFalse(self.h.started)
        self.assertTrue((self.h.root/m.BACKUP.lstrip('/')).is_dir())
        self.assertNotIn(BAIT.decode(),json.dumps(report))
        again = self.e.install(self.e.manifest_sha256)
        self.assertEqual(again['state'],'stopped_no_changes')
        self.assertEqual(again['reason'],'account_conflict')

    def test_wrong_approval_or_conflicting_account_stops_before_writes(self):
        before=self.snapshot()
        report=self.e.install('0'*64)
        self.assertEqual(report['reason'],'approval_mismatch')
        self.assertEqual(before,self.snapshot())
        self.h.user=types.SimpleNamespace(pw_uid=0)
        report=self.e.install(self.e.manifest_sha256)
        self.assertEqual(report['reason'],'account_conflict')
        self.assertEqual(before,self.snapshot())

    def test_any_existing_target_is_preserved_even_empty_or_symlink(self):
        for target in (m.ROOT,m.DATA,m.BACKUP,m.VERSIONS,m.LINK,m.UNIT):
            with self.subTest(target=target):
                path=self.h.root/target.lstrip('/')
                path.symlink_to('/never-read')
                report=self.e.install(self.e.manifest_sha256)
                self.assertEqual(report['state'],'stopped_no_changes')
                self.assertEqual(report['reason'],'existing_target')
                self.assertTrue(path.is_symlink())
                path.unlink()

    def test_parent_symlink_and_world_write_are_rejected(self):
        path=self.h.root/'opt'
        path.chmod(0o777)
        report=self.e.install(self.e.manifest_sha256)
        self.assertEqual(report['reason'],'unsafe_parent')
        path.chmod(0o755);path.rename(self.h.root/'moved');path.symlink_to(self.h.root/'moved')
        report=self.e.install(self.e.manifest_sha256)
        self.assertEqual(report['state'],'stopped_no_changes')

    def test_current_drift_before_and_during_install_blocks_success(self):
        current=self.h.root/'srv/fkssj/current'
        current.unlink();current.symlink_to('releases/unapproved')
        report=self.e.install(self.e.manifest_sha256)
        self.assertEqual(report['reason'],'current_changed')
        current.unlink();current.symlink_to(m.CURRENT)
        original=self.h.run
        def changed(argv,timeout=30):
            answer=original(argv,timeout)
            if 'pip' in argv:
                current.unlink();current.symlink_to('releases/unapproved')
            return answer
        with mock.patch.object(self.h,'run',side_effect=changed):
            report=self.e.install(self.e.manifest_sha256)
        self.assertEqual(report['state'],'partial_retained_inspect_no_retry')
        self.assertEqual(report['reason'],'current_changed')
        self.assertFalse(self.h.started)

    def test_dropin_at_effective_unit_stage_does_not_claim_success(self):
        self.h.pending_dropin=True
        report=self.e.install(self.e.manifest_sha256)
        self.assertEqual(report['state'],'partial_retained_inspect_no_retry')
        self.assertEqual(report['reason'],'unit_not_ready')
        self.assertFalse(report['startAttempted'])
        self.assertFalse(report['enableAttempted'])
        self.assertFalse(self.h.started)

    def test_unknown_exec_start_and_changed_enable_state_never_start(self):
        valid=self.h.exec_start
        for execution in (valid.replace(' --workers 2 ',' --workers 4 '),
                          valid.replace(' ; ignore_errors=no ;',' EXTRA ; ignore_errors=no ;'),
                          valid+' '+valid, '/unmodeled command'):
            with self.subTest(execution=execution):
                # Each attempt uses a fresh isolated server root.
                temporary=tempfile.TemporaryDirectory()
                try:
                    host=FixtureHost(temporary.name);host.exec_start=execution
                    engine=m.Engine(host,self.payload,self.bindings)
                    report=engine.install(engine.manifest_sha256)
                    self.assertEqual(report['reason'],'unit_not_ready')
                    self.assertFalse(report['startAttempted'])
                    self.assertFalse(host.started)
                finally:temporary.cleanup()
        original=self.h.run
        def drift_after_enable(argv,timeout=30):
            reply=original(argv,timeout)
            if argv[:2]==['/usr/bin/systemctl','enable']:self.h.pending_dropin=True
            return reply
        with mock.patch.object(self.h,'run',side_effect=drift_after_enable):
            report=self.e.install(self.e.manifest_sha256)
        self.assertTrue(report['enableAttempted'])
        self.assertFalse(report['startAttempted'])
        self.assertFalse(self.h.started)

    def test_fixed_requirements_hash_binding_and_filename_whitelist(self):
        for key,value in (('requirements.txt',b'--index-url https://never.invalid\n'),('api/app.py',b'changed')):
            payload=dict(self.payload);payload[key]=value
            with self.assertRaises(m.Failure):m.Engine(self.h,payload,self.bindings)
        payload=dict(self.payload);payload['wheels/../escape.whl']=b'x'
        with self.assertRaises(m.Failure):m.Engine(self.h,payload,self.bindings)

    def test_nonroot_unknown_platform_and_busy_port_are_fixed_failures(self):
        with mock.patch.object(self.h,'euid',return_value=1000):
            self.assertEqual(self.e.install(self.e.manifest_sha256)['reason'],'root_required')
        for reason in ('platform_unknown','port_occupied','insufficient_space'):
            with mock.patch.object(self.h,'platform',side_effect=m.Failure(reason)):
                report=self.e.install(self.e.manifest_sha256)
                self.assertEqual(report['state'],'stopped_no_changes')
                self.assertEqual(report['reason'],reason)

    def test_unit_has_no_new_credentials_and_only_one_writable_business_root(self):
        text=m.unit_bytes(self.bindings).decode()
        self.assertIn('127.0.0.1:8787',text)
        self.assertIn('User=fkssj-api\nGroup=fkssj-api',text)
        self.assertIn('api.preview:create_app()',text)
        self.assertIn('Environment=FKSSJ_PREVIEW_MANIFEST_SHA256='+self.bindings['previewManifestSha256'],text)
        self.assertEqual([x for x in text.splitlines() if x.startswith('ReadWritePaths=')],['ReadWritePaths=/var/lib/fkssj'])
        self.assertNotIn('HMAC',text);self.assertNotIn('sudo',text)

    def test_actual_platform_branches_reject_wrong_os_python_busy_port_and_low_space(self):
        osrelease=self.h.root/'usr/lib/os-release'
        osrelease.write_bytes(b'ID=debian\nVERSION_ID="12"\n')
        self.assertEqual(self.e.install(self.e.manifest_sha256)['reason'],'platform_unknown')
        osrelease.write_bytes(b'ID=ubuntu\nVERSION_ID="24.04"\n')
        original=self.h.run
        def wrong_python(argv,timeout=30):
            reply=original(argv,timeout)
            if 'import sys,venv,ensurepip; print("%d.%d" % sys.version_info[:2])' in argv:
                reply['stdout']=b'3.11\n'
            return reply
        with mock.patch.object(self.h,'run',side_effect=wrong_python):
            self.assertEqual(self.e.install(self.e.manifest_sha256)['reason'],'platform_unknown')
        def occupied(argv,timeout=30):
            reply=original(argv,timeout)
            if argv[0]=='/usr/bin/ss':reply['stdout']=BAIT
            return reply
        with mock.patch.object(self.h,'run',side_effect=occupied):
            result=self.e.install(self.e.manifest_sha256)
            self.assertEqual(result['reason'],'port_occupied')
            self.assertNotIn(BAIT.decode(),json.dumps(result))
        with mock.patch.object(m.os,'fstatvfs',return_value=types.SimpleNamespace(f_bavail=0,f_frsize=4096)):
            self.assertEqual(self.e.install(self.e.manifest_sha256)['reason'],'insufficient_space')

    def test_effective_preexisting_unit_dropin_and_bad_created_identity_stop(self):
        with mock.patch.object(self.h,'show',return_value=dict(LoadState='not-found',ActiveState='inactive',SubState='dead',DropInPaths='unexpected')):
            report=self.e.install(self.e.manifest_sha256)
            self.assertEqual(report['reason'],'unit_conflict')
            self.assertEqual(report['state'],'stopped_no_changes')
        original=self.h.run
        def bad_account(argv,timeout=30):
            reply=original(argv,timeout)
            if argv[0]=='/usr/sbin/useradd':self.h.user.pw_uid=0
            return reply
        with mock.patch.object(self.h,'run',side_effect=bad_account):
            report=self.e.install(self.e.manifest_sha256)
        self.assertEqual(report['reason'],'account_create_unconfirmed')
        self.assertEqual(report['state'],'partial_retained_inspect_no_retry')
        self.assertFalse((self.h.root/m.DATA.lstrip('/')).exists())

    def test_manifest_and_version_cover_preview_code_too(self):
        payload=dict(self.payload);payload['api/preview.py']=b'changed preview'
        bindings=dict(self.bindings);bindings['files']={k:dict(bytes=len(v),sha256=m.digest(v)) for k,v in payload.items()}
        with self.assertRaises(m.Failure):m.Engine(self.h,payload,bindings)
        bindings['apiVersionId']='fkssj-api-'+m.digest(m.canonical({n:m.digest(payload[n]) for n in m.CODE_KEYS}))[:16]
        self.assertNotEqual(m.Engine(self.h,payload,bindings).manifest_sha256,self.e.manifest_sha256)


if __name__=='__main__':unittest.main()

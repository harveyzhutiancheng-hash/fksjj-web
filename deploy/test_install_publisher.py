import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock
import types

HERE=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('installer',HERE/'deploy/install_publisher.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
SOURCE=Path(os.environ.get('FKSSJ_TEST_SOURCE',HERE))
sys.path.insert(0,str(SOURCE))
from deploy import manual_api_nginx,nginx_status_only,manual_api_install
BASE=manual_api_nginx.candidate(nginx_status_only.CANDIDATE)
OLD_RAW={path:('reviewed-old-'+str(index)).encode() for index,path in enumerate(m.OLD_FILES)}

def fixture():
    p={key:(SOURCE/path).read_bytes() for key,path in m.SOURCES.items()}
    b={'schema':1,'repo':m.REPO,'sourceCommit':'754a6a522e17538c5b9769afd112844dc7ed02c7','files':{key:{'path':m.SOURCES[key],'bytes':len(raw),'sha256':m.sha(raw)} for key,raw in p.items()}}
    return p,b

class FakeHost:
    def __init__(self,p):
        self.p=p;self.files={};self.marks={};self.dirs=set();self.commands=[];self.writes=[];self.mode={};self.metadata_reads=[];self.http_calls=[];self.fail=None;self.timer=False;self.enabled=False;self.daemon=False;self.busy=False;self.change_static=False;self.queue_calls=0;self.queue_fail_at=None
        self.files.update(OLD_RAW)
        self.files[m.NGINX]=BASE
        for path,key in (('/srv/fkssj/api-releases/fkssj-api-2aa9c0eb6dc0c3a6/api/app.py','api/app.py'),('/srv/fkssj/api-releases/fkssj-api-2aa9c0eb6dc0c3a6/api/__init__.py','api/__init__.py'),('/srv/fkssj/api-releases/fkssj-api-2aa9c0eb6dc0c3a6/api/preview.py','api/preview.py'),(m.SYSTEM+'fkssj-api.service','deploy/fkssj-api.service')):
            self.files[path]=(manual_api_install.unit_bytes({'previewManifestSha256':m.MANIFEST}) if key=='deploy/fkssj-api.service' else (SOURCE/key).read_bytes())
        self.files[m.CONFIG+'publisher.json']=b'';del self.files[m.CONFIG+'publisher.json']
        for path in self.files:self.marks[path]=1;self.mode[path]=0o644
    def euid(self):return 0
    def account(self):return (995,986,1001,1001)
    def exists(self,path):return path in self.files or path in self.dirs
    def listing(self,path):return {'.phase1','release_channel.py','static-release.py'}
    def metadata(self,path,*args):self.metadata_reads.append(path);return ('metadata',path)
    def read(self,path,*args,**kwargs):
        if path not in self.files:raise FileNotFoundError()
        return self.files[path],self.marks[path]
    def link(self,name,expected):return ('link',name,expected)
    def tree(self,relative,manifest_raw,legacy=False):return ('tree',relative,self.change_static)
    def runtime(self,new=False):
        m.need(self.enabled==new,'runtime')
    def unit(self,name):return {'ActiveState':'active' if self.timer else 'inactive','UnitFileState':'enabled' if self.timer else 'disabled','DropInPaths':'','FragmentPath':m.SYSTEM+name}
    def http(self,path,expected):self.http_calls.append((path,expected))
    def queue(self):
        self.queue_calls+=1
        if self.queue_fail_at==self.queue_calls:raise m.Failure('queue')
    @contextlib.contextmanager
    def static_lock(self):
        m.need(not self.busy,'lock');yield
    def command(self,argv,uncertain=False):
        self.commands.append(tuple(argv))
        if self.fail and self.fail(argv):raise m.Uncertain('command') if uncertain else m.Failure('command')
        if argv==['/usr/bin/systemctl','daemon-reload']:self.daemon=True
        if argv==['/usr/bin/systemctl','enable','fkssj-release.service']:self.enabled=True
        if argv==['/usr/bin/systemctl','enable','--now','fkssj-publisher.timer']:self.timer=True
        return b''
    @contextlib.contextmanager
    def worker_guard(self):
        yield
    def mkdir(self,path,mode=0o700):
        m.need(not self.exists(path),'existing');self.dirs.add(path);self.writes.append(('mkdir',path))
    def write(self,path,raw,mode=0o644,replace=None):
        if replace is None:m.need(not self.exists(path),'existing')
        else:m.need(path in self.files and self.marks[path]==replace,'changed')
        self.files[path]=raw;self.marks[path]=self.marks.get(path,0)+1;self.mode[path]=mode;self.writes.append(('write',path));return self.marks[path]
    def journal(self,path,step):self.files[path]+=m.encode({'step':step})

class EngineTests(unittest.TestCase):
    def setUp(self):
        self.patch=mock.patch.dict(m.OLD_FILES,{path:(len(raw),m.sha(raw)) for path,raw in OLD_RAW.items()},clear=True)
        self.patch.start();self.addCleanup(self.patch.stop)
        self.p,self.b=fixture();self.h=FakeHost(self.p);self.e=m.Engine(self.h,self.p,self.b)
    def test_preflight_no_mutations(self):
        result=self.e.preflight();self.assertEqual(result['state'],'preflight_ready');self.assertFalse(self.h.writes);self.assertFalse(self.h.enabled);self.assertNotIn(m.CONFIG+'hmac.key',self.h.files)
    def test_complete_exact_order_no_dispatch_current_or_account_writes(self):
        result=self.e.apply(self.e.digest);self.assertEqual(result['state'],'installed_verified',result)
        self.assertTrue(self.h.timer);self.assertTrue(self.h.enabled);self.assertEqual(m.sha(self.h.files[m.NGINX]),m.NEW_NGINX)
        self.assertTrue(json.loads(self.h.files[m.CONFIG+'publisher.json'])['enabled'])
        self.assertEqual(self.h.commands[-1],('/usr/bin/systemctl','enable','--now','fkssj-publisher.timer'))
        targets=[p for kind,p in self.h.writes];self.assertTrue(all(not p.startswith('/srv/') and p!=m.LEDGER for p in targets))
        self.assertEqual([p for p,s in self.h.http_calls if p!=' /api/health' and s==401],['/_fkssj-release/v1/status','/_fkssj-release/v1/upload','/_fkssj-release/v1/activate'])
    def test_existing_attempt_blocks_any_replay(self):
        self.assertEqual(self.e.apply(self.e.digest)['state'],'installed_verified')
        before=list(self.h.writes);again=m.Engine(self.h,self.p,self.b).apply(self.e.digest)
        self.assertEqual(again['state'],'stopped_no_changes');self.assertEqual(again['reason'],'attempt');self.assertEqual(before,self.h.writes)
    def test_binding_digest_cannot_change(self):
        with self.assertRaises(m.Failure):self.e.apply('0'*64)
        self.assertFalse(self.h.writes)
    def test_payload_extra_changed_hash_wrong_path_and_commit_rejected(self):
        variants=[]
        p=copy.deepcopy(self.p);p['unexpected']=b'secret';variants.append((p,self.b))
        p=copy.deepcopy(self.p);p['release_channel.py']+=b'x';variants.append((p,self.b))
        b=copy.deepcopy(self.b);b['files']['policy']['path']='private.pem';variants.append((self.p,b))
        b=copy.deepcopy(self.b);b['sourceCommit']='main';variants.append((self.p,b))
        for p,b in variants:
            with self.subTest():
                with self.assertRaises(m.Failure):m.Engine(self.h,p,b)
    def test_unknown_existing_program_refuses_before_write(self):
        self.h.files[m.PREFIX+'publisher_pipeline.py']=b'unknown'
        r=self.e.apply(self.e.digest);self.assertEqual(r['reason'],'existing');self.assertFalse(self.h.writes)
    def test_changed_installed_program_refuses_before_write(self):
        self.h.files[m.PREFIX+'release_channel.py']=b'unknown'
        r=self.e.apply(self.e.digest);self.assertEqual(r['reason'],'changed');self.assertFalse(self.h.writes)
    def test_nginx_drift_refuses_before_write(self):
        self.h.files[m.NGINX]+=b'changed'
        self.assertEqual(self.e.apply(self.e.digest)['reason'],'nginx');self.assertFalse(self.h.writes)
    def test_busy_static_lock_refuses_before_write(self):
        self.h.busy=True;self.assertEqual(self.e.apply(self.e.digest)['reason'],'lock');self.assertFalse(self.h.writes)
    def test_budget_marker_blocks_before_write(self):
        self.h.files[m.BUDGET]=b'unchanged';self.assertEqual(self.e.apply(self.e.digest)['reason'],'existing');self.assertFalse(self.h.writes)
    def test_nginx_candidate_test_failure_restores_only_exact_candidate(self):
        count=0
        def fail(argv):
            nonlocal count
            if argv==['/usr/sbin/nginx','-t']:count+=1;return count==2
        self.h.fail=fail;r=self.e.apply(self.e.digest)
        self.assertEqual(r['state'],'partial_or_uncertain_inspect_no_retry');self.assertEqual(self.h.files[m.NGINX],BASE)
        self.assertFalse(any('reload' in c for c in self.h.commands));self.assertFalse(self.h.timer)
    def test_unknown_reload_stops_no_restore_no_retry_no_timer(self):
        self.h.fail=lambda a:a==['/usr/bin/systemctl','reload','nginx.service']
        r=self.e.apply(self.e.digest);self.assertTrue(r['uncertain']);self.assertEqual(m.sha(self.h.files[m.NGINX]),m.NEW_NGINX);self.assertFalse(self.h.timer)
        self.assertEqual(self.h.commands.count(('/usr/bin/systemctl','reload','nginx.service')),1)
    def test_new_queue_stops_before_policy_enable_timer(self):
        self.h.queue_fail_at=3;r=self.e.apply(self.e.digest)
        self.assertEqual(r['reason'],'queue');self.assertFalse(json.loads(self.h.files[m.CONFIG+'publisher.json'])['enabled']);self.assertFalse(self.h.timer)
    def test_cas_file_replaced_between_preflight_and_install_stops(self):
        original=self.h.mkdir
        def mkdir(path,mode=0o700):
            original(path,mode)
            if path==m.BACKUP:self.h.marks[m.PREFIX+'release_channel.py']+=1
        self.h.mkdir=mkdir;r=self.e.apply(self.e.digest)
        self.assertEqual(r['reason'],'changed');self.assertFalse(self.h.timer)
    def test_sanitized_failure_does_not_emit_exception_content(self):
        self.h.fail=lambda a:(_ for _ in ()).throw(RuntimeError('SECRET_DECOY'))
        r=self.e.apply(self.e.digest);self.assertNotIn('SECRET_DECOY',json.dumps(r));self.assertEqual(r['reason'],'unexpected')

    def test_daemon_reload_unknown_reports_possible_service_mutation(self):
        self.h.fail=lambda a:a==['/usr/bin/systemctl','daemon-reload']
        r=self.e.apply(self.e.digest);self.assertTrue(r['uncertain']);self.assertTrue(r['servicesMayHaveChanged']);self.assertFalse(self.h.timer)

class PrimitiveTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.base=Path(self.temp.name)
        original_stat=m.os.stat;original_fstat=m.os.fstat
        def mapped(i):
            values={k:getattr(i,k) for k in dir(i) if k.startswith('st_')};values['st_uid']=0;values['st_gid']=0
            return types.SimpleNamespace(**values)
        self.statpatch=mock.patch.object(m.os,'stat',side_effect=lambda *a,**k:mapped(original_stat(*a,**k)))
        self.fdpatch=mock.patch.object(m.os,'fstat',side_effect=lambda *a,**k:mapped(original_fstat(*a,**k)))
        self.statpatch.start();self.fdpatch.start();self.addCleanup(self.statpatch.stop);self.addCleanup(self.fdpatch.stop)
        class TempHost(m.Host):
            @contextlib.contextmanager
            def directory(_,path):
                fd=os.open(self.base,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                try:yield fd
                finally:os.close(fd)
        self.h=TempHost()
    def test_real_fd_create_replace_and_stale_cas(self):
        mark=self.h.write('/fixed/value',b'first',0o600)
        mark2=self.h.write('/fixed/value',b'second',0o600,mark)
        self.assertEqual((self.base/'value').read_bytes(),b'second');self.assertNotEqual(mark,mark2)
        with self.assertRaises(m.Failure):self.h.write('/fixed/value',b'bad',0o600,mark)
        self.assertEqual((self.base/'value').read_bytes(),b'second')
    def test_real_fd_exclusive_no_follow_symlink_and_hardlink(self):
        self.h.write('/fixed/value',b'first',0o600)
        with self.assertRaises(FileExistsError):self.h.write('/fixed/value',b'overwrite',0o600)
        (self.base/'link').symlink_to(self.base/'value')
        with self.assertRaises(OSError):self.h.read('/fixed/link',mode=0o600)
        os.link(self.base/'value',self.base/'hard')
        with self.assertRaises(m.Failure):self.h.read('/fixed/value',mode=0o600)
    def test_timer_unit_parser_does_not_require_service_properties(self):
        values={'Id':'fkssj-publisher.timer','LoadState':'loaded','ActiveState':'inactive','SubState':'dead','UnitFileState':'disabled','FragmentPath':m.SYSTEM+'fkssj-publisher.timer','DropInPaths':'','NeedDaemonReload':'no'}
        self.h.command=lambda *a,**k:('\n'.join(k+'='+v for k,v in values.items())+'\n').encode()
        self.assertEqual(self.h.unit('fkssj-publisher.timer'),values)
    def test_real_worker_flock_excludes_timer_until_final_checks_end(self):
        path=self.base/'publisher.lock';path.write_bytes(b'');os.chmod(path,0o660)
        old_info=self.h.info
        def worker_info(fd):
            value=old_info(fd);value.st_gid=986;return value
        self.h.info=worker_info
        original_stat=m.os.stat
        def worker_stat(*args,**kwargs):
            value=original_stat(*args,**kwargs)
            if str(args[0])=='publisher.lock':value.st_gid=986
            return value
        with mock.patch.object(m.os,'stat',side_effect=worker_stat):
            with self.h.worker_guard():
                other=os.open(path,os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError):m.fcntl.flock(other,m.fcntl.LOCK_EX|m.fcntl.LOCK_NB)
                finally:os.close(other)
            other=os.open(path,os.O_RDWR)
            try:m.fcntl.flock(other,m.fcntl.LOCK_EX|m.fcntl.LOCK_NB)
            finally:os.close(other)
    def test_fixed_https_request_rejects_redirects_and_has_no_auth_headers(self):
        class Response:
            status=401
            def read(_,n):return b'{"error":"auth_failed"}'
            def getheader(_,key):return {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'}[key]
        response=Response();calls=[]
        class Connection:
            def __init__(_,host,**kwargs):calls.append(('connect',host,kwargs));self.assertIn('context',kwargs)
            def request(_,method,path,**kwargs):calls.append(('request',method,path,kwargs))
            def getresponse(_):return response
            def close(_):pass
        with mock.patch.object(m.http.client,'HTTPSConnection',Connection):
            self.h.http('/_fkssj-release/v1/upload',401)
            response.status=302
            with self.assertRaises(m.Failure):self.h.http('/_fkssj-release/v1/activate',401)
        self.assertTrue(all(c[1]=='fkssj.harvey-ai.xyz' for c in calls if c[0]=='connect'))
        self.assertTrue(all(c[3]['headers']=={'Content-Length':'0'} for c in calls if c[0]=='request'))
    def test_real_runtime_static_publisher_and_timer_without_service_properties(self):
        units={}
        for name in m.UNITS+('fkssj-api.service',):
            v={'Id':name,'LoadState':'loaded','ActiveState':'inactive','SubState':'dead','UnitFileState':'disabled','FragmentPath':m.SYSTEM+name,'DropInPaths':'','NeedDaemonReload':'no'}
            if name.endswith('.service'):v.update(User='fkssj-release',Group='fkssj-release',ExecStart='')
            units[name]=v
        units['fkssj-release.service'].update(ActiveState='active',SubState='running',ExecStart='{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -I -B '+m.PREFIX+'release_channel.py receiver ; }')
        units['fkssj-publisher.service'].update(User='fkssj-deploy',UnitFileState='static',ExecStart='{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -I -B '+m.PREFIX+'release_channel.py worker ; }')
        units['fkssj-api.service'].update(ActiveState='active',SubState='running',UnitFileState='enabled',User='fkssj-api',Group='fkssj-api',ExecStart='/opt/fkssj-api/venv/bin/gunicorn --bind 127.0.0.1:8787')
        self.h.unit=lambda name:units[name]
        self.h.command=lambda *a,**k:b'LISTEN 0 128 127.0.0.1:8790 0.0.0.0:*\n'
        self.h.runtime(False)
        units['fkssj-publisher.service']['UnitFileState']='enabled'
        with self.assertRaises(m.Failure):self.h.runtime(False)
    def test_queue_snapshot_nofollow_replacement_and_no_disk_sqlite(self):
        path=self.base/'state.sqlite3';db=sqlite3.connect(path)
        db.executescript('CREATE TABLE requests ( request_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, operation TEXT NOT NULL, envelope BLOB NOT NULL, signature TEXT NOT NULL, state TEXT NOT NULL, error TEXT); CREATE TABLE releases ( release_id TEXT PRIMARY KEY, upload_id TEXT NOT NULL, state TEXT NOT NULL, envelope BLOB NOT NULL, bytes INTEGER NOT NULL);');db.close();os.chmod(path,0o660)
        # Only queue FD ownership maps to its already approved service identity.
        old_info=self.h.info
        def queue_info(fd):
            value=old_info(fd);value.st_uid=995;value.st_gid=986;return value
        self.h.info=queue_info
        old_stat=m.os.stat
        def queue_stat(*args,**kwargs):
            value=old_stat(*args,**kwargs)
            if str(args[0])=='state.sqlite3':value.st_uid=995;value.st_gid=986
            return value
        with mock.patch.object(m.os,'stat',side_effect=queue_stat):
            original_connect=sqlite3.connect
            def connect(name,*args,**kwargs):
                self.assertEqual(name,':memory:');return original_connect(name,*args,**kwargs)
            with mock.patch.object(m.sqlite3,'connect',side_effect=connect):self.h.queue()
            self.assertEqual(set(p.name for p in self.base.iterdir()),{'state.sqlite3'})
            original_pread=m.os.pread
            def swapped_read(fd,size,offset):
                raw=original_pread(fd,size,offset);path.rename(self.base/'old-inode');path.write_bytes(raw);os.chmod(path,0o660);return raw
            with mock.patch.object(m.os,'pread',side_effect=swapped_read):
                with self.assertRaises(m.Failure):self.h.queue()
            (self.base/'old-inode').unlink()
            path.rename(self.base/'retained');path.symlink_to(self.base/'retained')
            with self.assertRaises(OSError):self.h.queue()

class QueueTests(unittest.TestCase):
    def fixture(self):
        db=sqlite3.connect(':memory:')
        db.executescript('CREATE TABLE requests ( request_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, operation TEXT NOT NULL, envelope BLOB NOT NULL, signature TEXT NOT NULL, state TEXT NOT NULL, error TEXT); CREATE TABLE releases ( release_id TEXT PRIMARY KEY, upload_id TEXT NOT NULL, state TEXT NOT NULL, envelope BLOB NOT NULL, bytes INTEGER NOT NULL);')
        self.addCleanup(db.close);return db
    def test_empty_and_status_only_accepted(self):
        db=self.fixture();m.Host.check_queue(db);db.execute("INSERT INTO requests VALUES ('r','x','status',x'00','SECRET','rejected',NULL)");m.Host.check_queue(db)
    def test_any_mutation_state_rejected(self):
        for op in ('upload','activate'):
            for state in ('receiving','queued','processing','uncertain','completed','rejected'):
                db=self.fixture();db.execute('INSERT INTO requests VALUES (?,?,?,?,?,?,NULL)',('r','x',op,b'SECRET','SECRET',state))
                with self.subTest(op=op,state=state):
                    with self.assertRaises(m.Failure):m.Host.check_queue(db)
    def test_unknown_schema_trigger_rejected_without_running_query(self):
        db=self.fixture();db.execute("CREATE TRIGGER hidden AFTER INSERT ON requests BEGIN DELETE FROM releases; END;")
        with self.assertRaises(m.Failure):m.Host.check_queue(db)

if __name__=='__main__':unittest.main()

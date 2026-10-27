#!/usr/bin/env python3
"""One approved publisher installation; fixed bytes supplied by pinned bootstrap.

No network download CLI or arbitrary target paths. Import Engine from a separately
hash-verified bootstrap. Default preflight does not write. A durable attempt blocks
all replay, including a partially completed or uncertain first application.
"""
import contextlib
import fcntl
import grp
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import sqlite3
import ssl
import stat
import subprocess
import time
import uuid

REPO = 'harveyzhutiancheng-hash/fksjj-web'
OLD = 'releases/fkssj-0.13.0-20261020T071030Z'
MANUAL = 'releases/fkssj-0.14.0-b20e11a258007f39'
MANIFEST = 'b20e11a258007f39129a47601be7a291391c9275ad5ea6b51ab0e9e7f21aa272'
NGINX = '/etc/nginx/conf.d/fkssj-domain.conf'
OLD_NGINX = 'b2c7dc4c44a7e035be4762afa30000973e23f933769dd7b3673a9055a54fadf9'
NEW_NGINX = 'fb16acbd3164418ede79b01f2a4e01e195b118d6f82daea2f5b4e663f1c5d80a'
PREFIX = '/opt/fkssj-release/'
SYSTEM = '/etc/systemd/system/'
CONFIG = '/etc/fkssj-release/'
AUDIT = '/var/backups/fkssj-publisher'
BACKUP = '/var/backups/fkssj-publisher-install'
LEDGER = '/var/lib/fkssj-release/state.sqlite3'
ATTEMPT = BACKUP + '/install-attempt.json'
BUDGET = '/var/backups/fkssj-api/acceptance-attempt.json'
PROGRAMS = ('release_channel.py','static-release.py','publisher_pipeline.py',
            'manual_api_acceptance.py','manual_static_switch.py','receipt-v0.13.0-2026-10-20.json')
UNITS = ('fkssj-release.service','fkssj-publisher.service','fkssj-publisher.timer')
SOURCES = {n:'deploy/'+n for n in PROGRAMS}
SOURCES.update({n:'deploy/templates/'+n for n in UNITS})
SOURCES.update({'policy':'deploy/templates/publisher-config.example.json',
                'nginx':'deploy/templates/nginx-release.conf',
                'candidate':'deploy/approved-v014-release.json'})
OLD_FILES = {
 PREFIX+'release_channel.py': (25099,'a31ead1039f7697ba720b4526ed3cb7cc2d3d1854edaf40b017887890a275b2e'),
 PREFIX+'static-release.py': (23647,'80ee95fa9a412246c75ce3fbf09087210b14b8fb6c0aeecf40e89f310af92db3'),
 SYSTEM+'fkssj-release.service': (1568,'b67255915e1a96dc78fa8a184e70bffc581a2e962ffcfb0a4530a549b06e394c'),
 SYSTEM+'fkssj-publisher.service': (1523,'56fc3823157d4489f52e8712eae541a88a98e335c9b48176d4307fcbc0aea7a8'),
 SYSTEM+'fkssj-publisher.timer': (423,'682addb409d0ca9eccf51b5bfd69bd1019fe5d37d3fdadcc858c977d7e1ecb3a'),
}
REASONS = frozenset('bindings payload root path metadata changed existing user unit runtime lock queue schema static api nginx syntax command network attempt interrupted unexpected'.split())

class Failure(Exception):
    def __init__(self, code):
        self.code = code if code in REASONS else 'unexpected'
        super().__init__(self.code)

class Uncertain(Failure):
    pass

def need(value, code):
    if not value: raise Failure(code)

def sha(raw): return hashlib.sha256(raw).hexdigest()
def encode(value): return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
def strict(raw):
    def pairs(items):
        result={}
        for key,value in items:
            need(key not in result,'bindings');result[key]=value
        return result
    return json.loads(raw,object_pairs_hook=pairs)
def stamp(i):
    return tuple(getattr(i,k) for k in ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns'))

class Host:
    """Real fixed-host operations. Test doubles never execute system commands."""
    def euid(self):return os.geteuid()
    def info(self,fd):return os.fstat(fd)
    def account(self):
        return (pwd.getpwnam('fkssj-release').pw_uid,grp.getgrnam('fkssj-release').gr_gid,
                pwd.getpwnam('fkssj-deploy').pw_uid,pwd.getpwnam('fkssj-deploy').pw_gid)

    @contextlib.contextmanager
    def directory(self,path):
        p=Path(path);need(p.is_absolute() and '..' not in p.parts,'path')
        fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        walked=Path('/')
        root_info=self.info(fd);need(root_info.st_uid==0 and not stat.S_IMODE(root_info.st_mode)&0o022,'path')
        try:
            for part in p.parts[1:]:
                child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                os.close(fd);fd=child;walked/=part;i=self.info(fd);mode=stat.S_IMODE(i.st_mode)
                if str(walked)=='/opt/fkssj-release':
                    need((i.st_uid,i.st_gid,mode)==(0,0,0o755),'path')
                elif str(walked)=='/etc/fkssj-release':
                    need((i.st_uid,i.st_gid,mode)==(0,986,0o750),'path')
                elif str(walked) in ('/srv/fkssj','/srv/fkssj/releases'):
                    need((i.st_uid,i.st_gid,mode)==(1001,1001,0o755),'path')
                elif str(walked)=='/var/lib/fkssj-release':
                    need((i.st_uid,i.st_gid,mode)==(0,986,0o770),'path')
                elif str(walked).startswith('/srv/fkssj/releases/'):
                    need(i.st_uid in (0,1001) and i.st_gid in (0,986,1001) and mode==0o755,'path')
                else:need(i.st_uid==0 and not mode&0o022,'path')
            yield fd
        finally:os.close(fd)

    def exists(self,path):
        with self.directory(str(Path(path).parent)) as parent:
            try:os.stat(Path(path).name,dir_fd=parent,follow_symlinks=False);return True
            except FileNotFoundError:return False

    def listing(self,path):
        with self.directory(path) as fd:return set(os.listdir(fd))

    def metadata(self,path,uid=0,gid=0,mode=0o644,size=None):
        with self.directory(str(Path(path).parent)) as parent:
            i=os.stat(Path(path).name,dir_fd=parent,follow_symlinks=False)
            need(stat.S_ISREG(i.st_mode) and i.st_nlink==1 and i.st_uid==uid and i.st_gid==gid
                 and stat.S_IMODE(i.st_mode)==mode and (size is None or i.st_size==size),'metadata')
            return stamp(i)

    def read(self,path,uid=0,gid=0,mode=0o644,maximum=2*1024*1024):
        with self.directory(str(Path(path).parent)) as parent:
            fd=os.open(Path(path).name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
            try:
                i=self.info(fd)
                need(stat.S_ISREG(i.st_mode) and i.st_nlink==1 and i.st_uid==uid and i.st_gid==gid
                     and stat.S_IMODE(i.st_mode)==mode and 0<=i.st_size<=maximum,'metadata')
                data=os.pread(fd,maximum+1,0)
                need(len(data)==i.st_size and stamp(i)==stamp(self.info(fd))
                     and stamp(i)==stamp(os.stat(Path(path).name,dir_fd=parent,follow_symlinks=False)),'changed')
                return data,stamp(i)
            finally:os.close(fd)

    def link(self,name,expected):
        with self.directory('/srv/fkssj') as parent:
            i=os.stat(name,dir_fd=parent,follow_symlinks=False)
            need(stat.S_ISLNK(i.st_mode) and i.st_uid in (0,1001) and i.st_gid in (0,1001)
                 and os.readlink(name,dir_fd=parent)==expected,'static')
            need(stamp(i)==stamp(os.stat(name,dir_fd=parent,follow_symlinks=False)),'changed')
            return stamp(i)

    def tree(self,relative,manifest_raw,legacy=False):
        rows=strict(manifest_raw)['files'];need(isinstance(rows,list) and len(rows) in (29,34),'static')
        entries={row['path']:(row['bytes'],row['sha256']) for row in rows}
        need(len(entries)==len(rows) and all(re.fullmatch(r'[A-Za-z0-9_.\-/]+',n) and '..' not in Path(n).parts and not n.startswith('/') for n in entries),'static')
        entries['release.json']=(4537,'64c6d036725a0bf76ba7111442ade2efcb48c017af162d9d517f09aac63169ae') if legacy else (len(manifest_raw),sha(manifest_raw))
        dirs={str(p) for n in entries for p in Path(n).parents if str(p)!='.'};captured={}
        def walk(fd,prefix=''):
            expected={n[len(prefix):].split('/')[0] for n in entries if n.startswith(prefix)}
            need(set(os.listdir(fd))==expected,'static')
            for name in sorted(expected):
                rel=prefix+name;i=os.stat(name,dir_fd=fd,follow_symlinks=False)
                need(i.st_uid in (0,1001) and i.st_gid in (0,986,1001),'static')
                if rel in dirs:
                    need(stat.S_ISDIR(i.st_mode) and stat.S_IMODE(i.st_mode)==0o755,'static')
                    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                    try:
                        need(stamp(i)==stamp(self.info(child)),'changed');walk(child,rel+'/')
                        need(stamp(i)==stamp(self.info(child)),'changed')
                    finally:os.close(child)
                else:
                    need(stat.S_ISREG(i.st_mode) and i.st_nlink==1 and stat.S_IMODE(i.st_mode)==0o644,'static')
                    expected_size,digest=entries[rel];need(i.st_size==expected_size and i.st_size<=32*1024*1024,'static')
                    f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=fd)
                    try:
                        need(stamp(i)==stamp(self.info(f)),'changed');raw=os.pread(f,i.st_size+1,0)
                        need(len(raw)==i.st_size and sha(raw)==digest and stamp(i)==stamp(self.info(f)),'static')
                    finally:os.close(f)
                    captured[rel]=list(stamp(i))
                need(stamp(i)==stamp(os.stat(name,dir_fd=fd,follow_symlinks=False)),'changed')
        with self.directory('/srv/fkssj/'+relative) as fd:
            before=stamp(self.info(fd));walk(fd);need(before==stamp(self.info(fd)),'changed')
        return sha(encode(captured))

    def command(self,argv,uncertain=False):
        try:
            result=subprocess.run(argv,stdin=subprocess.DEVNULL,capture_output=True,timeout=35,
                                  env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
            if result.returncode!=0:raise (Uncertain('command') if uncertain else Failure('command'))
            need(len(result.stdout)<=16384 and len(result.stderr)<=16384,'command')
            return result.stdout
        except (Failure,Uncertain):raise
        except BaseException:raise (Uncertain('command') if uncertain else Failure('command')) from None

    def unit(self,name):
        need(name in UNITS+('fkssj-api.service',),'unit')
        keys=('Id','LoadState','ActiveState','SubState','UnitFileState','FragmentPath','DropInPaths','NeedDaemonReload')
        if name.endswith('.service'):keys+=('User','Group','ExecStart')
        raw=self.command(['/usr/bin/systemctl','show',name,'--no-pager','--property='+','.join(keys)])
        values={}
        for line in raw.decode('utf-8','strict').splitlines():
            k,sep,v=line.partition('=');need(sep and k in keys and k not in values,'unit');values[k]=v
        need(set(values)==set(keys),'unit');return values

    def runtime(self,new=False):
        r=self.unit('fkssj-release.service');p=self.unit('fkssj-publisher.service');t=self.unit('fkssj-publisher.timer');a=self.unit('fkssj-api.service')
        for name,v in zip(UNITS,(r,p,t)):
            need(v['Id']==name and v['LoadState']=='loaded' and v['FragmentPath']==SYSTEM+name
                 and v['DropInPaths']=='' and v['NeedDaemonReload']=='no','unit')
        need(r['ActiveState']=='active' and r['SubState']=='running' and r['User']=='fkssj-release'
             and r['Group']=='fkssj-release' and r['UnitFileState']==('enabled' if new else 'disabled')
             and 'path=/usr/bin/python3' in r['ExecStart'] and 'argv[]=/usr/bin/python3 -I -B '+PREFIX+'release_channel.py receiver ;' in r['ExecStart'],'runtime')
        need(p['ActiveState']=='inactive' and p['SubState']=='dead' and p['UnitFileState'] in ('static','disabled'),'runtime')
        need(p['User']==('root' if new else 'fkssj-deploy') and p['Group']=='fkssj-release'
             and 'argv[]=/usr/bin/python3 -I -B '+PREFIX+'release_channel.py '+('publish-worker' if new else 'worker')+' ;' in p['ExecStart'],'runtime')
        need(t['ActiveState']=='inactive' and t['UnitFileState']=='disabled','runtime')
        need(a['Id']=='fkssj-api.service' and a['LoadState']=='loaded' and a['ActiveState']=='active'
             and a['SubState']=='running' and a['UnitFileState']=='enabled' and a['User']=='fkssj-api'
             and a['Group']=='fkssj-api' and a['FragmentPath']==SYSTEM+'fkssj-api.service'
             and a['DropInPaths']=='' and a['NeedDaemonReload']=='no' and '127.0.0.1:8787' in a['ExecStart'],'runtime')
        raw=self.command(['/usr/bin/ss','-H','-ltn','sport = :8790']).decode('ascii','strict').splitlines()
        need(len(raw)==1 and raw[0].split()[3]=='127.0.0.1:8790','runtime')

    def http(self,path,expected):
        need(path in ('/api/health','/_fkssj-release/v1/status','/_fkssj-release/v1/upload','/_fkssj-release/v1/activate'),'network')
        conn=http.client.HTTPSConnection('fkssj.harvey-ai.xyz',timeout=10,context=ssl.create_default_context())
        try:
            conn.request('GET' if path=='/api/health' else 'POST',path,body=None if path=='/api/health' else b'',headers={'Content-Length':'0'})
            response=conn.getresponse();raw=response.read(1025)
            need(response.status==expected and len(raw)<=1024,'network')
            data=strict(raw)
            if path=='/api/health':need(data.get('ok') is True,'network')
            else:
                need(data=={'error':'auth_failed'} and response.getheader('Cache-Control')=='no-store'
                     and response.getheader('X-Content-Type-Options')=='nosniff'
                     and response.getheader('Referrer-Policy')=='same-origin','network')
        finally:conn.close()

    def queue(self):
        # Never let root SQLite open a mutable service-controlled pathname.
        # A kernel-pinned FD is copied under SQLite's standard SHARED lock;
        # only that bounded in-memory snapshot is parsed with SQL authorization.
        with self.directory('/var/lib/fkssj-release') as parent:
            fd=os.open('state.sqlite3',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
            db=None
            try:
                before=self.info(fd)
                need(stat.S_ISREG(before.st_mode) and before.st_nlink==1
                     and (before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode))==(995,986,0o660)
                     and 100<=before.st_size<=96*1024*1024,'metadata')
                # SQLite Unix locking: PENDING_BYTE+2, SHARED_SIZE=510.
                try:fcntl.lockf(fd,fcntl.LOCK_SH|fcntl.LOCK_NB,510,0x40000002,os.SEEK_SET)
                except OSError:raise Failure('queue') from None
                self.no_sidecars(parent)
                need(stamp(before)==stamp(os.stat('state.sqlite3',dir_fd=parent,follow_symlinks=False)),'changed')
                raw=os.pread(fd,before.st_size+1,0)
                need(len(raw)==before.st_size and stamp(before)==stamp(self.info(fd)),'changed')
                need(raw[:16]==b'SQLite format 3\x00' and raw[18:24]==bytes((1,1,0,64,32,32)),'schema')
                page=int.from_bytes(raw[16:18],'big');page=65536 if page==1 else page
                need(512<=page<=65536 and page&(page-1)==0
                     and int.from_bytes(raw[28:32],'big')*page==len(raw)
                     and int.from_bytes(raw[44:48],'big')==4
                     and int.from_bytes(raw[56:60],'big')==1,'schema')
                db=sqlite3.connect(':memory:',timeout=1,isolation_level=None)
                need(callable(getattr(db,'deserialize',None)),'schema')
                db.execute('PRAGMA temp_store=MEMORY');db.execute('PRAGMA query_only=ON');db.execute('PRAGMA trusted_schema=OFF')
                db.deserialize(raw);deadline=time.monotonic()+2
                db.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
                def auth(action,table,column,database,source):
                    if action==sqlite3.SQLITE_SELECT:return sqlite3.SQLITE_OK
                    if action==sqlite3.SQLITE_READ:
                        allowed={'requests':('','operation','state'),'releases':('','state'),'sqlite_master':('name','type','sql')}
                        return sqlite3.SQLITE_OK if database=='main' and column in allowed.get(table,()) else sqlite3.SQLITE_DENY
                    if action==sqlite3.SQLITE_FUNCTION and column.lower()=='count':return sqlite3.SQLITE_OK
                    return sqlite3.SQLITE_DENY
                db.set_authorizer(auth);self.check_queue(db)
                self.no_sidecars(parent)
                need(stamp(before)==stamp(self.info(fd))
                     and stamp(before)==stamp(os.stat('state.sqlite3',dir_fd=parent,follow_symlinks=False)),'changed')
            finally:
                if db is not None:db.close()
                os.close(fd)

    @staticmethod
    def no_sidecars(parent):
        for suffix in ('-wal','-shm','-journal'):
            try:os.stat('state.sqlite3'+suffix,dir_fd=parent,follow_symlinks=False)
            except FileNotFoundError:continue
            raise Failure('queue')

    @staticmethod
    def check_queue(db):
        expected={
            'requests':'CREATE TABLE requests ( request_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, operation TEXT NOT NULL, envelope BLOB NOT NULL, signature TEXT NOT NULL, state TEXT NOT NULL, error TEXT)',
            'releases':'CREATE TABLE releases ( release_id TEXT PRIMARY KEY, upload_id TEXT NOT NULL, state TEXT NOT NULL, envelope BLOB NOT NULL, bytes INTEGER NOT NULL)'}
        rows=db.execute('SELECT name,type,sql FROM sqlite_master').fetchall();need(len(rows)==4,'schema')
        for name,kind,sql in rows:
            if name in expected:need(kind=='table' and ' '.join(sql.split())==expected[name],'schema')
            else:need(name in ('sqlite_autoindex_requests_1','sqlite_autoindex_releases_1') and kind=='index' and sql is None,'schema')
        counts=db.execute('SELECT operation,state,COUNT(*) FROM requests GROUP BY operation,state').fetchall()
        need(all(op=='status' and state in ('completed','rejected') for op,state,count in counts),'queue')
        need(db.execute('SELECT COUNT(state) FROM releases').fetchone()[0]==0,'queue')

    @contextlib.contextmanager
    def static_lock(self):
        with self.directory('/srv/fkssj') as parent:
            name='.static-release.lock';fd=os.open(name,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
            try:
                i=self.info(fd);need(stat.S_ISREG(i.st_mode) and i.st_uid==1001 and i.st_gid==986 and i.st_nlink==1 and stat.S_IMODE(i.st_mode)==0o600,'lock')
                try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except OSError:raise Failure('lock') from None
                need(stamp(i)==stamp(os.stat(name,dir_fd=parent,follow_symlinks=False)),'changed')
                yield
                need(stamp(i)==stamp(self.info(fd)) and stamp(i)==stamp(os.stat(name,dir_fd=parent,follow_symlinks=False)),'changed')
            finally:os.close(fd)

    @contextlib.contextmanager
    def worker_guard(self):
        # Same flock as release_channel.worker_once: timer cannot claim work
        # while installation makes its last queue/current/budget checks.
        with self.directory('/var/lib/fkssj-release') as parent:
            name='publisher.lock'
            created=False
            try:fd=os.open(name,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
            except FileNotFoundError:
                fd=os.open(name,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o660,dir_fd=parent);created=True
            try:
                if created:os.fchown(fd,0,986);os.fchmod(fd,0o660);os.fsync(fd);os.fsync(parent)
                i=self.info(fd)
                need(stat.S_ISREG(i.st_mode) and i.st_nlink==1 and i.st_uid in (0,995,1001)
                     and i.st_gid==986 and stat.S_IMODE(i.st_mode)==0o660,'lock')
                try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except OSError:raise Failure('lock') from None
                need(stamp(i)==stamp(os.stat(name,dir_fd=parent,follow_symlinks=False)),'changed')
                yield
                need(stamp(i)==stamp(self.info(fd)) and stamp(i)==stamp(os.stat(name,dir_fd=parent,follow_symlinks=False)),'changed')
            finally:os.close(fd)

    def mkdir(self,path,mode=0o700):
        with self.directory(str(Path(path).parent)) as parent:
            os.mkdir(Path(path).name,mode,dir_fd=parent);os.fsync(parent)
        with self.directory(path) as fd:
            i=self.info(fd);need((i.st_uid,i.st_gid,stat.S_IMODE(i.st_mode))==(0,0,mode),'metadata')

    def write(self,path,raw,mode=0o644,replace=None):
        with self.directory(str(Path(path).parent)) as parent:
            name=Path(path).name;temp=name if replace is None else '.install-'+uuid.uuid4().hex
            fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,mode,dir_fd=parent)
            try:
                os.fchmod(fd,mode);view=memoryview(raw)
                while view:
                    n=os.write(fd,view);need(n>0,'interrupted');view=view[n:]
                os.fsync(fd);i=self.info(fd)
                need(stat.S_ISREG(i.st_mode) and i.st_nlink==1 and i.st_uid==0 and i.st_gid==0 and stat.S_IMODE(i.st_mode)==mode and i.st_size==len(raw),'metadata')
                need(stamp(i)==stamp(os.stat(temp,dir_fd=parent,follow_symlinks=False)),'changed')
                if replace is not None:
                    need(stamp(os.stat(name,dir_fd=parent,follow_symlinks=False))==replace,'changed')
                    os.replace(temp,name,src_dir_fd=parent,dst_dir_fd=parent)
                os.fsync(parent)
                after=self.info(fd)
                need(stamp(i)[:-1]==stamp(after)[:-1] and stamp(after)==stamp(os.stat(name,dir_fd=parent,follow_symlinks=False)),'changed')
                return stamp(after)
            finally:os.close(fd)

    def journal(self,path,step):
        with self.directory(str(Path(path).parent)) as parent:
            fd=os.open(Path(path).name,os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
            try:
                i=self.info(fd);need(stat.S_ISREG(i.st_mode) and i.st_nlink==1 and (i.st_uid,i.st_gid,stat.S_IMODE(i.st_mode))==(0,0,0o600),'metadata')
                raw=encode({'step':step});need(os.write(fd,raw)==len(raw),'interrupted');os.fsync(fd)
                need((i.st_dev,i.st_ino)==(os.stat(Path(path).name,dir_fd=parent,follow_symlinks=False).st_dev,os.stat(Path(path).name,dir_fd=parent,follow_symlinks=False).st_ino),'changed')
            finally:os.close(fd)

class Engine:
    def __init__(self,host,payload,bindings):
        self.h=host;self.p=payload;self.b=bindings;self.steps=[];self.attempted=False;self.uncertain=False
        need(isinstance(bindings,dict) and set(bindings)=={'schema','repo','sourceCommit','files'} and bindings['schema']==1
             and bindings['repo']==REPO and re.fullmatch('[0-9a-f]{40}',bindings['sourceCommit'] or ''),'bindings')
        need(isinstance(payload,dict) and set(payload)==set(SOURCES) and set(bindings['files'])==set(SOURCES),'payload')
        for name in SOURCES:
            row=bindings['files'][name]
            need(isinstance(row,dict) and set(row)=={'path','bytes','sha256'} and row['path']==SOURCES[name]
                 and type(row['bytes']) is int and 0<row['bytes']<=256*1024
                 and re.fullmatch('[0-9a-f]{64}',row['sha256'] or '')
                 and isinstance(payload[name],bytes) and len(payload[name])==row['bytes'] and sha(payload[name])==row['sha256'],'payload')
        self.digest=sha(encode(bindings));self.policy=strict(payload['policy'])
        need(self.policy.get('enabled') is False and self.policy.get('schema')==1
             and self.policy.get('maximumAutomaticAccounts')==2 and self.policy.get('approvedManifestSha256')==MANIFEST
             and self.policy.get('apiBindings',{}).get('nginxConfigSha256')==NEW_NGINX,'payload')
        need(sha(payload['candidate'])==MANIFEST,'payload')

    def _candidate(self,raw):
        marker=b'    location = /_fkssj-release/v1/status {'
        need(sha(raw)==OLD_NGINX and raw.count(marker)==1,'nginx')
        active=b'\n'.join(line for line in self.p['nginx'].splitlines() if not line.lstrip().startswith(b'#')).strip()+b'\n'
        addition=b''.join(b'    '+line+b'\n' if line else b'\n' for line in active.splitlines())
        candidate=raw.replace(marker,addition+marker)
        need(len(candidate)==4929 and sha(candidate)==NEW_NGINX,'nginx');return candidate

    def _fixed(self,new=False):
        h=self.h;need(h.euid()==0,'root');need(h.account()==(995,986,1001,1001),'user')
        keymark=h.metadata(CONFIG+'hmac.key',0,986,0o640,32)
        # Config is preserved byte-for-byte and is not parsed or printed.
        configmark=h.metadata(CONFIG+'config.json',0,986,0o640)
        need(not h.exists(BUDGET) and not h.exists('/opt/fkssj-api/preview.closed')
             and not h.exists('/srv/fkssj/.static-release-pending.json'),'existing')
        self.current=h.link('current',OLD)
        h.link('api-current',self.policy['apiBindings']['backendTarget'])
        legacy=h.tree(OLD,self.p['receipt-v0.13.0-2026-10-20.json'],True)
        manual=h.tree(MANUAL,self.p['candidate'])
        api=self.policy['apiBindings'];base='/srv/fkssj/'+api['backendTarget']+'/api/'
        for path,key in ((base+'app.py','apiAppSha256'),(base+'__init__.py','apiInitSha256'),(base+'preview.py','apiPreviewSha256'),(SYSTEM+'fkssj-api.service','apiUnitSha256')):
            need(sha(h.read(path)[0])==api[key],'api')
        h.queue();h.runtime(new);h.http('/api/health',200)
        return {'legacy':legacy,'manual':manual,'keyMetadata':keymark,'configMetadata':configmark,'currentMetadata':self.current}

    def preflight(self):
        need(not self.h.exists(BACKUP),'attempt')
        need(not self.h.exists(AUDIT) and not self.h.exists(CONFIG+'publisher.json'),'existing')
        for name in PROGRAMS[2:]:need(not self.h.exists(PREFIX+name),'existing')
        need(not self.h.exists(SYSTEM+'fkssj-stage-publisher.service') and not self.h.exists(PREFIX+'stage_publisher.py'),'existing')
        need(self.h.listing(PREFIX.rstrip('/'))=={'.phase1','release_channel.py','static-release.py'},'existing')
        for unit in UNITS:
            for prefix in ('/etc/systemd/system/','/run/systemd/system/','/usr/lib/systemd/system/'):
                need(not self.h.exists(prefix+unit+'.d'),'unit')
        self.old={}
        for path,(size,digest) in OLD_FILES.items():
            raw,mark=self.h.read(path);need(len(raw)==size and sha(raw)==digest,'changed');self.old[path]=(raw,mark)
        raw,mark=self.h.read(NGINX);self.nginx=(raw,mark);self.candidate=self._candidate(raw)
        with self.h.static_lock():self.static=self._fixed()
        self.h.command(['/usr/sbin/nginx','-t'])
        return {'state':'preflight_ready','bindingsSha256':self.digest,'sourceCommit':self.b['sourceCommit'],
                'current':OLD,'mutations':False,'accountsCreated':0}

    def record(self,step):
        self.steps.append(step);self.h.journal(BACKUP+'/journal.jsonl',step)

    def apply(self,approved_bindings_sha):
        need(approved_bindings_sha==self.digest,'bindings')
        result={'state':'stopped_no_changes','steps':self.steps,'currentChangedByInstaller':False,'accountsCreated':0,'servicesMayHaveChanged':False}
        try:
            self.preflight()
            with self.h.static_lock():
                need(self._fixed()==self.static,'changed')
                # Exclusive root-private parent is itself the durable attempt gate.
                self.attempted=True;self.h.mkdir(BACKUP)
                self.h.write(ATTEMPT,encode({'schema':1,'bindingsSha256':self.digest,'sourceCommit':self.b['sourceCommit'],'state':'attempted'}),0o600)
                self.h.write(BACKUP+'/journal.jsonl',b'',0o600);self.record('attempt_saved')
                for index,(path,(raw,mark)) in enumerate(self.old.items()):
                    need(self.h.read(path)[1]==mark,'changed');self.h.write(BACKUP+'/original-'+str(index),raw,0o600)
                self.h.write(BACKUP+'/original-nginx',self.nginx[0],0o600);self.record('backup_saved')
                self.h.mkdir(AUDIT);self.h.mkdir(AUDIT+'/releases')
                self.h.write(CONFIG+'publisher.json',encode(self.policy),0o600);self.record('disabled_policy_saved')
                for name in PROGRAMS:
                    path=PREFIX+name
                    self.h.write(path,self.p[name],0o644,replace=self.old[path][1] if path in self.old else None)
                for name in UNITS:
                    path=SYSTEM+name
                    # Matching receiver/timer are retained instead of gratuitous replacement.
                    if self.p[name]!=self.old[path][0]:self.h.write(path,self.p[name],0o644,replace=self.old[path][1])
                self.record('programs_units_installed')
                self.h.command(['/usr/bin/systemd-analyze','verify',SYSTEM+'fkssj-release.service',SYSTEM+'fkssj-publisher.service',SYSTEM+'fkssj-publisher.timer'])
                result['servicesMayHaveChanged']=True
                self.h.command(['/usr/bin/systemctl','daemon-reload'],True);self.record('daemon_reload_acknowledged')
                newmark=self.h.write(NGINX,self.candidate,0o644,replace=self.nginx[1]);self.record('nginx_candidate_saved')
                try:self.h.command(['/usr/sbin/nginx','-t'])
                except Failure:
                    self.h.write(NGINX,self.nginx[0],0o644,replace=newmark);self.record('nginx_original_restored_test_failure');raise
                # A failed reload is uncertain; do not assume which config is running.
                self.h.command(['/usr/bin/systemctl','reload','nginx.service'],True);self.record('nginx_reload_acknowledged')
                self.h.command(['/usr/bin/systemctl','restart','fkssj-release.service'],True);self.record('receiver_restart_acknowledged')
                self.h.command(['/usr/bin/systemctl','enable','fkssj-release.service'],True);self.record('receiver_enabled')
                need(self._fixed(True)==self.static,'changed')
                for route in ('status','upload','activate'):self.h.http('/_fkssj-release/v1/'+route,401)
                need(self.h.read(NGINX)[0]==self.candidate,'changed')
                for name in PROGRAMS:need(self.h.read(PREFIX+name)[0]==self.p[name],'changed')
                for name in UNITS:need(self.h.read(SYSTEM+name)[0]==self.p[name],'changed')
                with self.h.worker_guard():
                    self.h.queue();need(not self.h.exists(BUDGET),'existing')
                    raw,mark=self.h.read(CONFIG+'publisher.json',mode=0o600);need(raw==encode(self.policy),'changed')
                    enabled=dict(self.policy,enabled=True);self.h.write(CONFIG+'publisher.json',encode(enabled),0o600,replace=mark);self.record('policy_enabled')
                    self.h.queue()
                    self.h.command(['/usr/bin/systemctl','enable','--now','fkssj-publisher.timer'],True);self.record('timer_enable_start_acknowledged')
                    timer=self.h.unit('fkssj-publisher.timer')
                    need(timer['ActiveState']=='active' and timer['UnitFileState']=='enabled' and timer['DropInPaths']=='' and timer['FragmentPath']==SYSTEM+'fkssj-publisher.timer','runtime')
                    need(self.h.link('current',OLD)==self.current and not self.h.exists(BUDGET),'changed')
                    self.h.queue()
                    self.record('installed_verified_no_release_dispatched')
                return dict(result,state='installed_verified',bindingsSha256=self.digest,sourceCommit=self.b['sourceCommit'],timerEnabled=True)
        except BaseException as error:
            return dict(result,state='partial_or_uncertain_inspect_no_retry' if self.attempted else 'stopped_no_changes',
                        reason=error.code if isinstance(error,Failure) else 'unexpected',uncertain=isinstance(error,Uncertain))

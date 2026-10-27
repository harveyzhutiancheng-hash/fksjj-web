"""Fixed, root-owned publication coordinator for the approved v0.14 candidate.

Called only by the signed queue worker. Uploaded bytes are static files, never
Python, shell or commands. Root/clock/filesystem injection exists only for tests.
API credentials remain inside run_acceptance. A global durable attempt consumes
this approval's two-account allowance across manual and queue workflows alike.
"""
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types
import uuid

ROOT = Path('/srv/fkssj')
AUDIT = Path('/var/backups/fkssj-publisher')
POLICY = Path('/etc/fkssj-release/publisher.json')
GLOBAL_BUDGET = Path('/var/backups/fkssj-api/acceptance-attempt.json')
CLOSED = Path('/opt/fkssj-api/preview.closed')
OLD = 'releases/fkssj-0.13.0-20261020T071030Z'
APPROVED_MANIFEST = 'b20e11a258007f39129a47601be7a291391c9275ad5ea6b51ab0e9e7f21aa272'
APPROVED_SOURCE = '6c9a645f0a4af86d484bc4a735a83fe2fbfd0cebd4fe6a2915719e9b90e566d0'
OLD_MANIFEST = '64c6d036725a0bf76ba7111442ade2efcb48c017af162d9d517f09aac63169ae'
REPO, REF = 'harveyzhutiancheng-hash/fksjj-web', 'refs/heads/main'
BINDINGS = ('repo','ref','commit','releaseId','artifactSha256','artifactBytes','manifestSha256','expectedCurrent')
API_KEYS = frozenset(('manifestSha256','apiAppSha256','apiInitSha256','apiPreviewSha256','backendTarget','apiUnitSha256','nginxConfigSha256'))
DECISION = 'release-decision-v014-2026-10-27'
MANUAL = dict.fromkeys(('basic_ui','two_tabs','independent_context'),'waived_not_run')
INJECTIONS = ('guest_migration','identity_freeze','conflict_choices','late_response','storage_failure')
GAPS = ('real_browser','real_offline','real_quota','independent_account_restore')
CODES = frozenset(('disabled','invalid_policy','source_binding','expired','root_required',
    'unsafe_path','unsafe_file','changed_file','busy','existing_attempt','global_account_budget_used',
    'current_changed','legacy_changed','candidate_changed','api_precheck','api_acceptance',
    'receipt_invalid','activation_unconfirmed','post_activation_unconfirmed','rollback_gate',
    'rollback_uncertain','interrupted'))


class PipelineError(Exception):
    def __init__(self, code, *, attempted=False, uncertain=False):
        self.code = code if code in CODES else 'interrupted'
        self.attempted, self.uncertain = bool(attempted), bool(uncertain)
        super().__init__(self.code)


def need(value, code):
    if not value:
        raise PipelineError(code)


def canonical(value):
    return (json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode()


def sha(value):return hashlib.sha256(value).hexdigest()


def strict_json(raw):
    def pairs(items):
        result={}
        for key,value in items:
            need(key not in result,'invalid_policy');result[key]=value
        return result
    try:
        return json.loads(raw.decode('utf-8'),object_pairs_hook=pairs,
            parse_constant=lambda _:(_ for _ in ()).throw(PipelineError('invalid_policy')))
    except PipelineError:raise
    except BaseException:raise PipelineError('invalid_policy') from None


def stamp(info):
    return tuple(getattr(info,k) for k in ('st_dev','st_ino','st_mode','st_uid','st_gid',
        'st_nlink','st_size','st_mtime_ns','st_ctime_ns'))


@contextlib.contextmanager
def trusted_directory(path):
    path=Path(path)
    need(path.is_absolute() and '..' not in path.parts,'unsafe_path')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        for part in path.parts[1:]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            os.close(fd);fd=child;info=os.fstat(fd)
            need(info.st_uid==0 and not stat.S_IMODE(info.st_mode)&0o022,'unsafe_path')
        yield fd
    finally:os.close(fd)


def trusted_read(path,maximum=65536,private=False):
    with trusted_directory(Path(path).parent) as parent:
        fd=os.open(Path(path).name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
        try:
            before=os.fstat(fd)
            need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_uid==0
                 and not stat.S_IMODE(before.st_mode)&0o022 and 0<before.st_size<=maximum
                 and (not private or stat.S_IMODE(before.st_mode)==0o600),'unsafe_file')
            raw=os.pread(fd,maximum+1,0)
            named=os.stat(Path(path).name,dir_fd=parent,follow_symlinks=False)
            need(len(raw)==before.st_size and stamp(before)==stamp(os.fstat(fd))
                 and (named.st_dev,named.st_ino)==(before.st_dev,before.st_ino),'changed_file')
            return raw
        finally:os.close(fd)


def fixed_module(name,filename):
    path=Path(__file__).absolute().parent/filename
    raw=trusted_read(path,256*1024)
    value=types.ModuleType(name);value.__file__=str(path);sys.modules[name]=value
    exec(compile(raw,str(path),'exec'),value.__dict__)
    return value


class Host:
    root,audit,budget,closed = ROOT,AUDIT,GLOBAL_BUDGET,CLOSED

    def __init__(self,release_module=None,acceptance_module=None,manual_module=None):
        self.s=release_module or fixed_module('_publisher_static_release','static-release.py')
        self.a=acceptance_module or fixed_module('_publisher_api_acceptance','manual_api_acceptance.py')
        self.m=manual_module or fixed_module('_publisher_legacy_guard','manual_static_switch.py')
        rows=strict_json(trusted_read(Path(__file__).absolute().parent/'receipt-v0.13.0-2026-10-20.json'))
        self.legacy_rows=rows['files']
        self.api=self.a.Host();self.transport=self.a.HTTPSTransport()

    def euid(self):return os.geteuid()
    def now(self):return dt.datetime.now(dt.timezone.utc)
    def private_read(self,path):return trusted_read(path,65536,private=True)
    def exists(self,path):
        with trusted_directory(Path(path).parent) as parent:
            try:os.stat(Path(path).name,dir_fd=parent,follow_symlinks=False);return True
            except FileNotFoundError:return False

    def new_file(self,path,data,mode=0o600):
        with trusted_directory(Path(path).parent) as parent:
            fd=os.open(Path(path).name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,mode,dir_fd=parent)
            try:
                os.fchmod(fd,mode);remaining=memoryview(data)
                while remaining:
                    count=os.write(fd,remaining);need(count>0,'interrupted');remaining=remaining[count:]
                os.fsync(fd);info=os.fstat(fd)
                need(info.st_uid==0 and stat.S_ISREG(info.st_mode) and info.st_nlink==1
                     and stat.S_IMODE(info.st_mode)==mode and info.st_size==len(data),'unsafe_file')
                named=os.stat(Path(path).name,dir_fd=parent,follow_symlinks=False)
                need((named.st_dev,named.st_ino)==(info.st_dev,info.st_ino),'changed_file')
            finally:os.close(fd)
            os.fsync(parent)

    @contextlib.contextmanager
    def locked(self):
        with trusted_directory(self.audit) as parent:
            fd=os.open('publisher.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,0o600,dir_fd=parent)
            try:
                info=os.fstat(fd)
                need(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1
                     and stat.S_IMODE(info.st_mode)==0o600,'unsafe_file')
                try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except OSError:raise PipelineError('busy') from None
                yield
                named=os.stat('publisher.lock',dir_fd=parent,follow_symlinks=False)
                need((named.st_dev,named.st_ino)==(info.st_dev,info.st_ino),'changed_file')
            finally:os.close(fd)

    def new_release(self,release_id):
        path=self.audit/'releases'/release_id
        with trusted_directory(path.parent) as parent:
            os.mkdir(release_id,0o700,dir_fd=parent)
            fd=os.open(release_id,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
            try:
                info=os.fstat(fd)
                need(info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o700,'unsafe_path')
                os.fsync(fd);os.fsync(parent)
            finally:os.close(fd)
        return path

    def current(self):
        with self.s.directory(self.root) as fd:return self.s.current(fd)

    def old_snapshot(self):
        bindings={'releaseId':'legacy-audit','manifestSha256':APPROVED_MANIFEST,
            'sourceSha256':APPROVED_SOURCE,'apiAppSha256':'0'*64,'apiInitSha256':'0'*64,'legacyFiles':self.legacy_rows}
        host=self.m.Host();host.root=self.root
        engine=self.m.Engine(host,bindings,self.s)
        with host.directory(self.root) as fd:
            old=engine.legacy_snapshot(fd)
            with self.s.relative_directory(fd,OLD) as oldfd:
                need(sha(self.s.read_file(oldfd,'release.json',256*1024))==OLD_MANIFEST,'legacy_changed')
        return old

    def candidate(self,release_id,manifest_sha):
        with self.s.directory(self.root) as parent,self.s.relative_directory(parent,'releases/'+release_id) as fd:
            info=os.fstat(fd)
            need(info.st_uid in (0,1001) and stat.S_IMODE(info.st_mode)==0o755,'candidate_changed')
            manifest,files=self.s.snapshot_fd(fd,manifest_sha)
            def metadata(current,prefix=''):
                for name in os.listdir(current):
                    value=os.stat(name,dir_fd=current,follow_symlinks=False)
                    need(value.st_uid in (0,1001) and value.st_gid in (0,986,1001),'candidate_changed')
                    if stat.S_ISDIR(value.st_mode):
                        need(stat.S_IMODE(value.st_mode)==0o755,'candidate_changed')
                        with self.s.relative_directory(current,name) as child:metadata(child,prefix+name+'/')
                    else:need(stat.S_ISREG(value.st_mode) and value.st_nlink==1 and stat.S_IMODE(value.st_mode)==0o644,'candidate_changed')
            metadata(fd)
            return {'manifest':manifest,'files':{name:sha(raw) for name,raw in sorted(files.items())}}

    def verify_api(self,bindings):self.api.verify(bindings)
    def run_acceptance(self,bindings):return self.a.run_acceptance(self.transport,self.api,bindings)
    def receipt(self,path,digest,bindings):
        self.private_read(path)
        return self.s.acceptance(path,digest,bindings['manifestSha256'],bindings['apiAppSha256'],bindings['apiInitSha256'],self.now())
    def activate(self,value,path,receipt_sha,bindings,clock):
        return self.s.activate(value['releaseId'],value['manifestSha256'],value['expectedCurrent'],path,
            receipt_sha,bindings['apiAppSha256'],bindings['apiInitSha256'],root=self.root,now=clock)
    def close_preview(self):self.new_file(self.closed,b'closed after confirmed signed publication\n',0o644)

    def info(self,fd):return os.fstat(fd)

    def write_pending(self,parent,raw):
        fd=os.open(self.s.PENDING,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=parent)
        try:
            os.fchmod(fd,0o600);remaining=memoryview(raw)
            while remaining:
                count=os.write(fd,remaining);need(count>0,'rollback_uncertain');remaining=remaining[count:]
            os.fsync(fd);info=self.info(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1
                 and stat.S_IMODE(info.st_mode)==0o600 and info.st_size==len(raw),'rollback_uncertain')
            named=os.stat(self.s.PENDING,dir_fd=parent,follow_symlinks=False)
            need((named.st_dev,named.st_ino)==(info.st_dev,info.st_ino),'rollback_uncertain')
            os.fsync(parent)
            return stamp(info)
        finally:os.close(fd)

    def clear_owned_pending(self,parent,raw,created_stamp):
        fd=os.open(self.s.PENDING,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
        try:
            before=self.info(fd)
            need(stat.S_ISREG(before.st_mode) and before.st_uid==0 and before.st_nlink==1
                 and stat.S_IMODE(before.st_mode)==0o600 and before.st_size==len(raw)
                 and stamp(before)==created_stamp,'rollback_uncertain')
            need(os.pread(fd,len(raw)+1,0)==raw,'rollback_uncertain')
            named=os.stat(self.s.PENDING,dir_fd=parent,follow_symlinks=False)
            need(stamp(before)==stamp(self.info(fd))
                 and (named.st_dev,named.st_ino)==(before.st_dev,before.st_ino),'rollback_uncertain')
            os.unlink(self.s.PENDING,dir_fd=parent);os.fsync(parent)
        finally:os.close(fd)

    def rollback(self,value,old,snapshot,record,write):
        attempted=False
        with self.s.locked(self.root) as fd:
            need(self.s.current(fd)=='releases/'+value['releaseId'],'rollback_gate')
            need(self.old_snapshot()==old and self.candidate(value['releaseId'],value['manifestSha256'])==snapshot,'rollback_gate')
            temporary='.publisher-rollback-'+uuid.uuid4().hex
            pending={'schema':1,'operation':'publisher-static-only-rollback','target':OLD,
                     'expectedCurrent':'releases/'+value['releaseId'],'temporaryLink':temporary}
            attempted=True
            try:
                write('rollback-attempt.json',pending)
                pending_raw=canonical(pending)
                owned_pending=self.write_pending(fd,pending_raw)
                os.symlink(OLD,temporary,dir_fd=fd);os.fsync(fd)
                need(self.s.current(fd)=='releases/'+value['releaseId'] and self.old_snapshot()==old,'rollback_gate')
                os.replace(temporary,'current',src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd)
                need(self.s.current(fd)==OLD and self.old_snapshot()==old,'rollback_gate')
                write('rolled-back.json',{'state':'rolled_back','current':OLD})
                self.clear_owned_pending(fd,pending_raw,owned_pending)
            except BaseException:
                if attempted and not self.s.exists(fd,self.s.PENDING):
                    try:self.write_pending(fd,canonical(dict(pending,state='uncertain')))
                    except BaseException:pass
                raise PipelineError('rollback_uncertain',attempted=attempted,uncertain=True) from None
        return {'state':'rolled_back_verified','current':OLD,'databaseChanged':False}


class Coordinator:
    error_type = PipelineError

    def __init__(self,policy,host=None,release_module=None,acceptance_module=None):
        self.p=validate_policy(policy)
        self.h=host or Host(release_module,acceptance_module)

    @staticmethod
    def load_policy():
        try:return validate_policy(strict_json(trusted_read(POLICY,16384)))
        except PipelineError:raise
        except BaseException:raise PipelineError('invalid_policy') from None

    def fresh(self,value):
        start,end=value.get('issuedAt'),value.get('expiresAt');now=self.h.now().timestamp()
        need(type(start) is int and type(end) is int and 0<end-start<=300 and start<=now<end,'expired')
        return self.h.now()

    def binding(self,value):
        need(isinstance(value,dict) and all(key in value for key in BINDINGS),'source_binding')
        need(value.get('operation')=='activate' and value['repo']==REPO and value['ref']==REF
             and isinstance(value['commit'],str) and re.fullmatch('[0-9a-f]{40}',value['commit'])
             and isinstance(value['releaseId'],str) and re.fullmatch('[0-9a-f]{32}',value['releaseId'])
             and isinstance(value['artifactSha256'],str) and re.fullmatch('[0-9a-f]{64}',value['artifactSha256'])
             and type(value['artifactBytes']) is int and 0<value['artifactBytes']<=16*1024*1024
             and value['manifestSha256']==self.p['approvedManifestSha256']
             and value['expectedCurrent']==OLD,'source_binding')
        self.fresh(value)
        return {key:value[key] for key in BINDINGS}

    @staticmethod
    def safe_summary(value):
        result={}
        if not isinstance(value,dict):return result
        for key in ('accountCreationRequests','accountsConfirmed'):
            if type(value.get(key)) is int and 0<=value[key]<=2:result[key]=value[key]
        for key in ('restartAttempted','requestOutcomeMayBeUncertain'):
            if type(value.get(key)) is bool:result[key]=value[key]
        return result

    def activate(self,value):
        attempted=False;activated=False;audit_started=False;account_call_started=False
        phase='preflight';journal=None;summary={}
        try:
            need(self.p['enabled'] is True,'disabled');need(self.h.euid()==0,'root_required')
            binding=self.binding(value);binding_sha=sha(canonical(binding));api=self.p['apiBindings']
            with self.h.locked():
                need(not self.h.exists(self.h.budget),'global_account_budget_used')
                need(not self.h.exists(self.h.closed),'existing_attempt')
                need(not self.h.exists(self.h.audit/'releases'/value['releaseId']),'existing_attempt')
                need(self.h.current()==OLD,'current_changed')
                old=self.h.old_snapshot();candidate=self.h.candidate(value['releaseId'],value['manifestSha256'])
                source={'api/api/app.py':api['apiAppSha256'],'api/api/__init__.py':api['apiInitSha256'],
                        'api/api/preview.py':api['apiPreviewSha256'],
                        **{'static/'+name:digest for name,digest in candidate['files'].items()}}
                need(sha(canonical(source))==APPROVED_SOURCE,'candidate_changed')
                self.h.verify_api(api);self.fresh(value)
                phase='record_release';audit_started=True;journal=self.h.new_release(value['releaseId'])
                def write(name,data):self.h.new_file(journal/name,canonical(data))
                write('binding.json',dict(bindingSha256=binding_sha,bindings=binding))
                write('old-tree.json',old);write('candidate.json',candidate)
                decision={'schema':1,'type':'fkssj-channel-manual-qa-waiver','decisionReference':DECISION,
                    'releaseId':value['releaseId'],'commit':value['commit'],'manifestSha256':value['manifestSha256'],
                    'sourceSha256':APPROVED_SOURCE,'recordedAt':self.h.now().isoformat(),
                    'manualChecks':MANUAL,'injectionEvidence':{'runner':'cloud_node_fixture','checks':dict.fromkeys(INJECTIONS,True)},
                    'knownGaps':list(GAPS),'browserChecksPerformed':False}
                decision_raw=canonical(decision);self.h.new_file(journal/'manual-qa-waiver.json',decision_raw)
                phase='reserve_global_account_budget'
                write('acceptance-attempt.json',{'bindingSha256':binding_sha,'state':'started','maximumAutomaticAccounts':2})
                attempted=True
                self.h.new_file(self.h.budget,canonical({'schema':1,'releaseId':value['releaseId'],
                    'bindingSha256':binding_sha,'state':'started','maximumAutomaticAccounts':2}))
                phase='api_acceptance';account_call_started=True;reply=self.h.run_acceptance(api)
                summary=self.safe_summary(reply.get('summary'));receipt=reply['receipt']
                need(isinstance(receipt,bytes),'receipt_invalid')
                phase='save_receipt';self.h.new_file(journal/'api-acceptance.json',receipt)
                self.h.receipt(journal/'api-acceptance.json',sha(receipt),api)
                write('acceptance-summary.json',{'bindingSha256':binding_sha,'summary':summary,'browserChecks':'waived_not_run'})
                self.fresh(value);self.h.verify_api(api)
                need(self.h.current()==OLD and self.h.old_snapshot()==old,'legacy_changed')
                need(self.h.candidate(value['releaseId'],value['manifestSha256'])==candidate,'candidate_changed')
                need(self.h.private_read(journal/'manual-qa-waiver.json')==decision_raw,'changed_file')
                phase='activate'
                result=self.h.activate(value,journal/'api-acceptance.json',sha(receipt),api,lambda:self.fresh(value))
                need(result.get('status')=='activated','activation_unconfirmed');activated=True
                need(self.h.current()=='releases/'+value['releaseId'] and self.h.old_snapshot()==old,'post_activation_unconfirmed')
                phase='close_preview';self.h.close_preview()
                write('activated.json',{'bindingSha256':binding_sha,'state':'activated','current':'releases/'+value['releaseId'],
                    'oldTreeSha256':sha(canonical(old)),'candidateSha256':sha(canonical(candidate)),
                    'apiReceiptSha256':sha(receipt),'qaDecisionSha256':sha(decision_raw),'qaPolicy':'explicit_user_manual_qa_waiver'})
                return {'state':'activated_verified','releaseId':value['releaseId'],'current':'releases/'+value['releaseId'],
                        'manualBrowserChecks':'waived_not_run','browserChecksPerformed':False,
                        'automaticAccountsMaximum':2,'previewClosed':True,'qaDecisionSha256':sha(decision_raw)}
        except BaseException as error:
            code=error.code if isinstance(error,PipelineError) else ('api_acceptance' if phase=='api_acceptance' else 'interrupted')
            if isinstance(getattr(error,'summary',None),dict):summary=self.safe_summary(error.summary)
            if journal is not None:
                try:self.h.new_file(journal/'failure.json',canonical({'state':'uncertain' if attempted or audit_started else 'rejected',
                    'phase':phase,'reason':code,'summary':summary,
                    'automaticAccountCreationMayHaveOccurred':account_call_started and
                        (summary.get('accountCreationRequests',1)>0 or summary.get('requestOutcomeMayBeUncertain',False)),
                    'activationMayHaveOccurred':activated or phase in ('activate','close_preview')}))
                except BaseException:pass
            raise PipelineError(code,attempted=attempted,uncertain=attempted or activated or audit_started) from None

    def rollback(self,release_id):
        need(self.h.euid()==0,'root_required')
        need(isinstance(release_id,str) and re.fullmatch('[0-9a-f]{32}',release_id),'rollback_gate')
        journal=self.h.audit/'releases'/release_id
        with self.h.locked():
            record=strict_json(self.h.private_read(journal/'activated.json'))
            binding=strict_json(self.h.private_read(journal/'binding.json'))
            value=binding['bindings'];old=strict_json(self.h.private_read(journal/'old-tree.json'))
            snapshot=strict_json(self.h.private_read(journal/'candidate.json'))
            need(value.get('releaseId')==release_id and binding['bindingSha256']==sha(canonical(value))
                 and record.get('bindingSha256')==binding['bindingSha256'] and record.get('state')=='activated'
                 and record.get('oldTreeSha256')==sha(canonical(old))
                 and record.get('candidateSha256')==sha(canonical(snapshot)),'rollback_gate')
            need(not self.h.exists(journal/'rollback-attempt.json') and not self.h.exists(journal/'rolled-back.json'),'existing_attempt')
            return self.h.rollback(value,old,snapshot,record,lambda name,data:self.h.new_file(journal/name,canonical(data)))


def validate_policy(value):
    need(isinstance(value,dict) and set(value)=={'schema','enabled','maximumAutomaticAccounts','approvedManifestSha256','apiBindings'},'invalid_policy')
    need(type(value['schema']) is int and value['schema']==1 and type(value['enabled']) is bool
         and type(value['maximumAutomaticAccounts']) is int and value['maximumAutomaticAccounts']==2
         and value['approvedManifestSha256']==APPROVED_MANIFEST,'invalid_policy')
    api=value['apiBindings'];need(isinstance(api,dict) and set(api)==API_KEYS,'invalid_policy')
    need(api['manifestSha256']==value['approvedManifestSha256'],'invalid_policy')
    for key,data in api.items():
        if key=='backendTarget':need(isinstance(data,str) and re.fullmatch(r'api-releases/[A-Za-z0-9][A-Za-z0-9._-]{0,95}',data) and '..' not in data,'invalid_policy')
        else:need(isinstance(data,str) and re.fullmatch('[0-9a-f]{64}',data),'invalid_policy')
    return json.loads(json.dumps(value))

#!/usr/bin/env python3
"""Fixed manual static stage/switch/rollback. No API/database restoration.

The enclosing pinned bootstrap supplies validated bindings and the previously
installed static-release module. This file is not an arbitrary-path CLI.
Unknown or interrupted outcomes leave durable records and block another attempt.
"""
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import uuid

OLD = 'releases/fkssj-0.13.0-20261020T071030Z'
ROOT = Path('/srv/fkssj')
SOURCE = Path('/opt/fkssj-api/manual-static')
BACKUP = Path('/var/backups/fkssj-manual-v014')
RECEIPT = Path('/etc/fkssj-release/api-acceptance.json')
BROWSER = 'browser-acceptance.json'
BROWSER_CHECKS = frozenset('basic_ui two_tabs independent_context guest_migration identity_freeze conflict_choices late_response storage_failure'.split())
BROWSER_BASES = frozenset(('operator_attestation_after_real_browser_checks', 'automated_real_browser'))
# This explicit decision is scoped to one candidate; it is not a general bypass.
QA_WAIVER_FILE = 'manual-qa-waiver.json'
QA_WAIVER_MANIFEST = 'b20e11a258007f39129a47601be7a291391c9275ad5ea6b51ab0e9e7f21aa272'
QA_WAIVER_SOURCE = '6c9a645f0a4af86d484bc4a735a83fe2fbfd0cebd4fe6a2915719e9b90e566d0'
QA_WAIVER_RELEASE = 'fkssj-0.14.0-b20e11a258007f39'
# Public release approval reference; the private conversation is not published.
QA_WAIVER_MESSAGE = 'release-decision-v014-2026-10-27'
QA_WAIVER_TEXT = 'Explicit user approval to release this candidate with three manual QA checks not run.'
QA_WAIVER_MANUAL = dict.fromkeys(('basic_ui','two_tabs','independent_context'),'waived_not_run')
QA_WAIVER_GAPS = ['real_browser','real_offline','real_quota','independent_account_restore']
QA_WAIVER_INJECTIONS = {
    'runner':'cloud_node_fixture','testsPassed':10,
    'checks':dict.fromkeys(('guest_migration','identity_freeze','conflict_choices','late_response','storage_failure'),True),
    'reportSha256':'b206f18b4401258c5c0198fde963b60510a28cb415dd07e6301ec24b57ae15b4',
    'accountManagerSha256':'c12936be59d4b15e124cb6edac48d4ac33344dbf5eeff3907fb9d6a978635669',
    'apiPreviewSha256':'595e332bdd1449cedd63e8164a0b217a412685ac07edec348f715b29c134783c',
}
OLD_FILES = frozenset('''index.html bootstrap.js app.js scene.js game-state.js progress-state.js
progress-ui.js progress-ui.css battle-view.js campaign-view.js scavenging-state.js
scavenging-view.js scavenging-ui.js scavenging-ui.css production-state.js production-ui.js
production-ui.css story-state.js diving-state.js diving-view.js diving-ui.js diving-ui.css
battle-view.css icons.js style.css assets/favicon.svg node_modules/three/build/three.module.js
node_modules/three/build/three.core.js node_modules/three/LICENSE'''.split())
REASONS = frozenset('''bindings_unknown root_required unsafe_directory unsafe_file
file_changed wrong_current legacy_manifest_unknown legacy_tree_changed existing_attempt
lock_metadata lock_busy source_mismatch browser_gate_missing browser_gate_invalid
qa_waiver_missing qa_waiver_invalid qa_policy_invalid
api_receipt_invalid static_stage_failed static_activate_failed static_rollback_failed
staged_record_missing activated_record_missing pending_unknown unexpected_failure'''.split())


class Failure(Exception):
    def __init__(self, code):
        super().__init__(code if code in REASONS else 'unexpected_failure')


def need(ok, code):
    if not ok:
        raise Failure(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def stamp(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid',
                  'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


class Host:
    root, source, backup, receipt = ROOT, SOURCE, BACKUP, RECEIPT

    def euid(self): return os.geteuid()
    def now(self): return dt.datetime.now(dt.timezone.utc)
    def info(self, fd): return os.fstat(fd)
    def owner(self, fd, uid, gid): os.fchown(fd, uid, gid)
    def metadata_at(self, parent, name):
        return os.stat(name,dir_fd=parent,follow_symlinks=False)

    @contextlib.contextmanager
    def directory(self, path):
        path = Path(path)
        need(path.is_absolute() and '..' not in path.parts, 'unsafe_directory')
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        walked = Path('/')
        try:
            for part in path.parts[1:]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                os.close(fd); fd = child; walked /= part
                info = self.info(fd)
                if walked == self.root or walked == self.root / 'releases':
                    need((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1001,1001,0o755), 'unsafe_directory')
                else:
                    need(info.st_uid == 0 and not stat.S_IMODE(info.st_mode) & 0o022, 'unsafe_directory')
            yield fd
        finally:
            os.close(fd)

    def read_private(self, path):
        with self.directory(Path(path).parent) as parent:
            fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
            try:
                before = self.info(fd)
                need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                     and (before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode)) == (0,0,0o600)
                     and 0 < before.st_size <= 65536, 'unsafe_file')
                data = os.pread(fd, 65537, 0)
                need(len(data) == before.st_size and stamp(before) == stamp(self.info(fd)), 'file_changed')
                named = os.stat(Path(path).name, dir_fd=parent, follow_symlinks=False)
                need((named.st_dev,named.st_ino) == stamp(before)[:2], 'file_changed')
                return data
            finally:
                os.close(fd)


class Engine:
    def __init__(self, host, bindings, static_module):
        self.h, self.s = host, static_module
        required = {'releaseId','manifestSha256','sourceSha256','apiAppSha256','apiInitSha256','legacyFiles'}
        need(isinstance(bindings, dict) and set(bindings) == required, 'bindings_unknown')
        try:
            static_module.valid_id(bindings['releaseId'])
            for name in required - {'releaseId','legacyFiles'}: static_module.valid_hash(bindings[name])
            rows = bindings['legacyFiles']
            need(isinstance(rows,list) and len(rows) == len(OLD_FILES), 'bindings_unknown')
            legacy = {}
            for row in rows:
                need(isinstance(row,dict) and set(row) == {'path','bytes','sha256'} and row['path'] in OLD_FILES
                     and row['path'] not in legacy and type(row['bytes']) is int
                     and 0 <= row['bytes'] <= static_module.MAX_FILE, 'bindings_unknown')
                static_module.valid_hash(row['sha256']);legacy[row['path']] = row
            need(set(legacy) == OLD_FILES and sum(r['bytes'] for r in rows) <= static_module.MAX_TOTAL, 'bindings_unknown')
        except BaseException:
            raise Failure('bindings_unknown') from None
        self.b = json.loads(json.dumps(bindings))
        self.legacy = {row['path']:row for row in self.b['legacyFiles']}
        self.new = 'releases/' + bindings['releaseId']
        need(self.new != OLD, 'bindings_unknown')
        self.binding_sha = sha(encode(self.b))

    def private(self, name): return self.h.backup / name

    def exists(self, parent, name):
        return self.s.exists(parent, name)

    def write(self, parent, name, value):
        data = encode(value)
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
        try:
            self.h.owner(fd,0,0);os.fchmod(fd,0o600)
            view = memoryview(data)
            while view:
                n = os.write(fd, view);need(n > 0,'unexpected_failure');view = view[n:]
            os.fsync(fd)
        finally: os.close(fd)
        os.fsync(parent)

    def clear_owned_pending(self, parent, expected):
        fd = os.open(self.s.PENDING,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
        try:
            info = self.h.info(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                 and (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode)) == (0,0,0o600)
                 and info.st_size == len(expected),'pending_unknown')
            need(os.pread(fd,65537,0) == expected,'pending_unknown')
            named = os.stat(self.s.PENDING,dir_fd=parent,follow_symlinks=False)
            need(stamp(info) == stamp(self.h.info(fd))
                 and (named.st_dev,named.st_ino) == stamp(info)[:2],'pending_unknown')
            os.unlink(self.s.PENDING,dir_fd=parent)
            os.fsync(parent)
        finally: os.close(fd)

    def record(self, name):
        try:
            value = self.s.strict_json(self.h.read_private(self.private(name)))
            need(isinstance(value,dict) and value.get('bindingSha256') == self.binding_sha, 'bindings_unknown')
            return value
        except FileNotFoundError:
            raise Failure('staged_record_missing' if name == 'staged.json' else 'activated_record_missing') from None

    def legacy_snapshot(self, rootfd):
        # Only this immutable whitelist is opened. Unknown names are rejected
        # before any body read; no API, player data or credential file is read.
        expected = set(OLD_FILES) | {'release.json'}
        directories = {str(p) for n in expected for p in Path(n).parents if str(p) != '.'}
        captured = {}
        with self.s.relative_directory(rootfd, OLD) as oldfd:
            root_info = self.h.info(oldfd)
            need(root_info.st_uid in (0,1001) and root_info.st_gid in (0,1001),'legacy_tree_changed')
            def walk(fd, prefix=''):
                allowed_here = {n[len(prefix):].split('/')[0] for n in expected if n.startswith(prefix)}
                need(set(os.listdir(fd)) == allowed_here, 'legacy_tree_changed')
                for name in sorted(allowed_here):
                    relative = prefix + name
                    info = self.h.metadata_at(fd,name)
                    need(info.st_uid in (0,1001) and info.st_gid in (0,1001),'legacy_tree_changed')
                    if relative in directories:
                        need(stat.S_ISDIR(info.st_mode) and not stat.S_IMODE(info.st_mode) & 0o022,
                             'legacy_tree_changed')
                        with self.s.relative_directory(fd,name) as child: walk(child, relative+'/')
                    else:
                        need(relative in expected and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                             and not stat.S_IMODE(info.st_mode) & 0o022, 'legacy_tree_changed')
                        data = self.s.read_file(fd,name,256*1024 if relative == 'release.json' else self.s.MAX_FILE)
                        need(stamp(info) == stamp(self.h.metadata_at(fd,name)), 'legacy_tree_changed')
                        captured[relative] = {'path':relative,'bytes':len(data),'sha256':sha(data),'metadata':list(stamp(info))}
                        if relative == 'release.json': raw = data
                return locals().get('raw')
            manifest_bytes = walk(oldfd)
            need(stamp(root_info) == stamp(self.h.info(oldfd)), 'legacy_tree_changed')
        try:
            manifest = self.s.strict_json(manifest_bytes)
            need(set(manifest) == {'version','createdAt','fileCount','totalBytes','files'}
                 and manifest['version'] == '0.13.0' and manifest['fileCount'] == len(OLD_FILES)
                 and type(manifest['fileCount']) is int and isinstance(manifest['files'],list)
                 and manifest['totalBytes'] == sum(row['bytes'] for row in self.legacy.values()), 'legacy_manifest_unknown')
            self.s.timestamp(manifest['createdAt'])
            need(sorted(manifest['files'],key=lambda x:x['path']) == sorted(self.legacy.values(),key=lambda x:x['path']), 'legacy_manifest_unknown')
            need(all({k:captured[n][k] for k in ('path','bytes','sha256')} == row for n,row in self.legacy.items()), 'legacy_tree_changed')
        except Failure: raise
        except BaseException: raise Failure('legacy_manifest_unknown') from None
        return {'target':OLD,'rootMetadata':list(stamp(root_info)), 'files':[captured[n] for n in sorted(captured)]}

    def lock_file(self):
        with self.h.directory(self.h.root) as parent:
            try:
                fd = os.open(self.s.LOCK,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=parent)
                created = True
            except FileExistsError:
                fd = os.open(self.s.LOCK,os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
                created = False
            try:
                if created:
                    self.h.owner(fd,1001,986);os.fchmod(fd,0o600);os.fsync(fd);os.fsync(parent)
                info = self.h.info(fd)
                need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                     and (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_size) == (1001,986,0o600,0), 'lock_metadata')
                named = os.stat(self.s.LOCK,dir_fd=parent,follow_symlinks=False)
                need((named.st_dev,named.st_ino) == stamp(info)[:2], 'lock_metadata')
            finally: os.close(fd)

    @contextlib.contextmanager
    def locked(self):
        with self.h.directory(self.h.root) as parent:
            fd = os.open(self.s.LOCK,os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
            try:
                info = self.h.info(fd)
                need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                     and (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_size) == (1001,986,0o600,0),'lock_metadata')
                named = os.stat(self.s.LOCK,dir_fd=parent,follow_symlinks=False)
                need((named.st_dev,named.st_ino) == stamp(info)[:2],'lock_metadata')
                try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except OSError: raise Failure('lock_busy') from None
                need(not self.exists(parent,self.s.PENDING),'pending_unknown')
                try: yield parent
                finally:
                    named = os.stat(self.s.LOCK,dir_fd=parent,follow_symlinks=False)
                    need((named.st_dev,named.st_ino) == stamp(self.h.info(fd))[:2],'lock_metadata')
            finally: os.close(fd)

    def plan(self):
        need(self.h.euid() == 0, 'root_required')
        self.s.check(self.h.source,self.b['manifestSha256'],self.b['releaseId'],OLD)
        with self.h.directory(self.h.root) as rootfd:
            need(self.s.current(rootfd) == OLD,'wrong_current')
            need(not self.exists(rootfd,self.s.PENDING), 'pending_unknown')
            old = self.legacy_snapshot(rootfd)
        with self.h.directory(self.h.backup.parent) as parent:
            need(not self.exists(parent,self.h.backup.name),'existing_attempt')
        return {'state':'plan_ready','bindingSha256':self.binding_sha,'oldTreeSha256':sha(encode(old)),
                'current':OLD,'currentChangedByTool':False,'browserChecksPerformed':False}

    def stage(self):
        result = {'state':'stopped_no_changes','currentChangedByTool':False}
        mutated = False
        try:
            self.plan();mutated = True;self.lock_file()
            with self.h.directory(self.h.backup.parent) as parent:
                mutated = True;os.mkdir(self.h.backup.name,0o700,dir_fd=parent);os.fsync(parent)
            with self.h.directory(self.h.backup) as backup, self.locked() as rootfd:
                self.h.owner(backup,0,0);os.fchmod(backup,0o700)
                need(self.s.current(rootfd) == OLD,'wrong_current')
                old = self.legacy_snapshot(rootfd)
                self.write(backup,'old-tree.json',dict(bindingSha256=self.binding_sha,snapshot=old))
                self.write(backup,'stage-attempt.json',{'bindingSha256':self.binding_sha,'state':'attempted'})
            previous = os.umask(0o022)
            try:
                reply = self.s.stage(self.h.source,self.b['manifestSha256'],self.b['releaseId'],OLD,root=self.h.root)
            finally: os.umask(previous)
            need(reply.get('status') == 'staged','static_stage_failed')
            with self.locked() as rootfd, self.h.directory(self.h.backup) as backup:
                need(self.s.current(rootfd) == OLD and self.legacy_snapshot(rootfd) == old,'legacy_tree_changed')
                self.write(backup,'staged.json',{'bindingSha256':self.binding_sha,'state':'staged','oldTreeSha256':sha(encode(old))})
            return dict(result,state='staged_verified',current=OLD,releaseId=self.b['releaseId'])
        except BaseException as error:
            return dict(result,state='partial_or_uncertain_inspect' if mutated else 'stopped_no_changes',
                        reason=str(error) if isinstance(error,Failure) else 'static_stage_failed')

    def browser(self, expected_sha):
        try:
            self.s.valid_hash(expected_sha)
            data = self.h.read_private(self.private(BROWSER))
            need(sha(data) == expected_sha,'browser_gate_invalid')
            record = self.s.strict_json(data)
            need(set(record) == {'schema','type','basis','origin','manifestSha256','sourceSha256','checkedAt','checks'}
                 and type(record['schema']) is int and record['schema'] == 1
                 and record['type'] == 'fkssj-browser-acceptance'
                 and record['basis'] in BROWSER_BASES and record['origin'] == self.s.ORIGIN
                 and record['manifestSha256'] == self.b['manifestSha256']
                 and record['sourceSha256'] == self.b['sourceSha256']
                 and set(record['checks']) == BROWSER_CHECKS
                 and all(v is True for v in record['checks'].values()),'browser_gate_invalid')
            checked = self.s.timestamp(record['checkedAt'])
            need(dt.timedelta(0) <= self.h.now()-checked <= dt.timedelta(hours=2),'browser_gate_invalid')
            return record
        except FileNotFoundError: raise Failure('browser_gate_missing') from None
        except Failure: raise
        except BaseException: raise Failure('browser_gate_invalid') from None

    def _qa_waiver_scope(self):
        need(self.b['manifestSha256'] == QA_WAIVER_MANIFEST
             and self.b['sourceSha256'] == QA_WAIVER_SOURCE
             and self.b['releaseId'] == QA_WAIVER_RELEASE, 'qa_waiver_invalid')

    def qa_waiver_record(self):
        self._qa_waiver_scope()
        now = self.h.now()
        need(isinstance(now,dt.datetime) and now.tzinfo is not None, 'qa_waiver_invalid')
        return {'schema':1,'type':'fkssj-explicit-manual-qa-waiver',
                'basis':'explicit_user_release_decision','origin':self.s.ORIGIN,
                'manifestSha256':self.b['manifestSha256'],'sourceSha256':self.b['sourceSha256'],
                'recordedAt':now.astimezone(dt.timezone.utc).isoformat().replace('+00:00','Z'),
                'decisionMessageId':QA_WAIVER_MESSAGE,'decisionText':QA_WAIVER_TEXT,
                'manualChecks':dict(QA_WAIVER_MANUAL),
                'injectionEvidence':json.loads(json.dumps(QA_WAIVER_INJECTIONS)),
                'knownGaps':list(QA_WAIVER_GAPS)}

    def qa_waiver(self, expected_sha):
        try:
            self._qa_waiver_scope()
            self.s.valid_hash(expected_sha)
            data = self.h.read_private(self.private(QA_WAIVER_FILE))
            need(sha(data) == expected_sha,'qa_waiver_invalid')
            record = self.s.strict_json(data)
            need(isinstance(record,dict) and set(record) == {
                'schema','type','basis','origin','manifestSha256','sourceSha256','recordedAt',
                'decisionMessageId','decisionText','manualChecks','injectionEvidence','knownGaps'}
                and type(record['schema']) is int and record['schema'] == 1
                and record['type'] == 'fkssj-explicit-manual-qa-waiver'
                and record['basis'] == 'explicit_user_release_decision'
                and record['origin'] == self.s.ORIGIN
                and record['manifestSha256'] == self.b['manifestSha256']
                and record['sourceSha256'] == self.b['sourceSha256']
                and record['decisionMessageId'] == QA_WAIVER_MESSAGE
                and record['decisionText'] == QA_WAIVER_TEXT
                and record['manualChecks'] == QA_WAIVER_MANUAL
                and record['knownGaps'] == QA_WAIVER_GAPS, 'qa_waiver_invalid')
            evidence = record['injectionEvidence']
            need(evidence == QA_WAIVER_INJECTIONS and type(evidence['testsPassed']) is int
                 and all(v is True for v in evidence['checks'].values()),'qa_waiver_invalid')
            checked = self.s.timestamp(record['recordedAt'])
            need(dt.timedelta(0) <= self.h.now()-checked <= dt.timedelta(hours=2), 'qa_waiver_invalid')
            return record
        except FileNotFoundError: raise Failure('qa_waiver_missing') from None
        except Failure: raise
        except BaseException: raise Failure('qa_waiver_invalid') from None

    def activate(self, receipt_sha256, browser_record_sha256=None, *, qa_waiver_sha256=None):
        attempted = False
        try:
            need(self.h.euid() == 0,'root_required')
            stage = self.record('staged.json');old_record = self.record('old-tree.json')
            old = old_record['snapshot']
            need(stage.get('state') == 'staged' and stage.get('oldTreeSha256') == sha(encode(old)), 'staged_record_missing')
            need((browser_record_sha256 is not None) != (qa_waiver_sha256 is not None), 'qa_policy_invalid')
            if qa_waiver_sha256 is not None:
                self.qa_waiver(qa_waiver_sha256)
                qa_evidence = {'qaPolicy':'explicit_user_manual_qa_waiver','qaDecisionSha256':qa_waiver_sha256}
            else:
                self.browser(browser_record_sha256)
                qa_evidence = {'browserRecordSha256':browser_record_sha256}
            # Verify private record ownership and bytes before asking the
            # independently pinned static tool to perform its full API gate.
            api_data = self.h.read_private(self.h.receipt)
            need(sha(api_data) == receipt_sha256,'api_receipt_invalid')
            self.s.acceptance(self.h.receipt,receipt_sha256,self.b['manifestSha256'],self.b['apiAppSha256'],self.b['apiInitSha256'],self.h.now())
            with self.locked() as rootfd, self.h.directory(self.h.backup) as backup:
                need(self.s.current(rootfd) == OLD,'wrong_current')
                need(self.legacy_snapshot(rootfd) == old,'legacy_tree_changed')
                need(not self.exists(backup,'activate-attempt.json') and not self.exists(backup,'activated.json'), 'existing_attempt')
                with self.s.relative_directory(rootfd,self.new) as staged: self.s.snapshot_fd(staged,self.b['manifestSha256'])
                self.write(backup,'activate-attempt.json',{'bindingSha256':self.binding_sha,'state':'attempted',
                           'apiReceiptSha256':receipt_sha256,**qa_evidence})
                attempted = True
            previous = os.umask(0o022)
            try:
                reply = self.s.activate(self.b['releaseId'],self.b['manifestSha256'],OLD,self.h.receipt,
                    receipt_sha256,self.b['apiAppSha256'],self.b['apiInitSha256'],root=self.h.root,now=self.h.now)
            finally: os.umask(previous)
            need(reply.get('status') == 'activated','static_activate_failed')
            with self.locked() as rootfd, self.h.directory(self.h.backup) as backup:
                need(self.s.current(rootfd) == self.new and self.legacy_snapshot(rootfd) == old,'legacy_tree_changed')
                self.write(backup,'activated.json',{'bindingSha256':self.binding_sha,'state':'activated','oldTreeSha256':sha(encode(old)),
                           'newTarget':self.new,'oldTarget':OLD,'apiReceiptSha256':receipt_sha256,**qa_evidence})
            return {'state':'activated_verified','current':self.new,'oldVersionPreserved':True,
                    'browserEvidence':('explicit user decision; three manual checks waived_not_run'
                        if qa_waiver_sha256 is not None else 'externally supplied real-browser record; not inferred from HTTP'),
                    **({'qaPolicy':'explicit_user_manual_qa_waiver','qaDecisionSha256':qa_waiver_sha256}
                       if qa_waiver_sha256 is not None else {})}
        except BaseException as error:
            return {'state':'uncertain_after_activation_attempt' if attempted else 'stopped_no_switch_attempt',
                    'reason':str(error) if isinstance(error,Failure) else 'static_activate_failed'}

    def rollback(self):
        attempted = False
        try:
            need(self.h.euid() == 0,'root_required')
            record = self.record('activated.json');old_record = self.record('old-tree.json');old = old_record['snapshot']
            need(record.get('state') == 'activated' and record.get('newTarget') == self.new
                 and record.get('oldTarget') == OLD and record.get('oldTreeSha256') == sha(encode(old)), 'activated_record_missing')
            with self.locked() as rootfd, self.h.directory(self.h.backup) as backup:
                need(self.s.current(rootfd) == self.new,'wrong_current')
                need(self.legacy_snapshot(rootfd) == old,'legacy_tree_changed')
                need(not self.exists(backup,'rollback-attempt.json') and not self.exists(backup,'rolled-back.json'),'existing_attempt')
                with self.s.relative_directory(rootfd,self.new) as candidate: self.s.snapshot_fd(candidate,self.b['manifestSha256'])
                temporary = '.manual-v014-rollback-' + uuid.uuid4().hex
                # Record first: even interrupted symlink creation is not an
                # invitation to rerun or delete an unknown colliding name.
                pending = {'bindingSha256':self.binding_sha,'state':'pending','operation':'manual-static-rollback',
                           'expectedCurrent':self.new,'target':OLD,'temporaryLink':temporary}
                self.write(backup,'rollback-attempt.json',pending)
                attempted = True
                try:
                    # Same shared gate honored by the existing static tool;
                    # an interrupted rollback also blocks direct future calls.
                    self.write(rootfd,self.s.PENDING,pending)
                    os.symlink(OLD,temporary,dir_fd=rootfd)
                    os.fsync(rootfd)
                    need(self.s.current(rootfd) == self.new and self.legacy_snapshot(rootfd) == old,'legacy_tree_changed')
                    os.replace(temporary,'current',src_dir_fd=rootfd,dst_dir_fd=rootfd)
                    os.fsync(rootfd)
                    need(self.s.current(rootfd) == OLD and self.legacy_snapshot(rootfd) == old,'legacy_tree_changed')
                    self.write(backup,'rolled-back.json',{'bindingSha256':self.binding_sha,'state':'rolled_back','current':OLD})
                    self.clear_owned_pending(rootfd,encode(pending))
                except BaseException:
                    if not self.exists(rootfd,self.s.PENDING):
                        try: self.write(rootfd,self.s.PENDING,dict(pending,state='uncertain'))
                        except BaseException: pass
                    raise
            return {'state':'rolled_back_verified','current':OLD,'databaseChangedByTool':False,'apiChangedByTool':False}
        except BaseException as error:
            return {'state':'uncertain_after_rollback_attempt' if attempted else 'stopped_no_switch_attempt',
                    'reason':str(error) if isinstance(error,Failure) else 'static_rollback_failed'}


if __name__ == '__main__':
    print('{"state":"stopped_no_changes","reason":"pinned_bootstrap_required"}')
    raise SystemExit(1)

#!/usr/bin/env python3
"""Fixed status-only nginx change. Preflight is read-only; apply needs approval.

No download, key access, nginx -T, service start, game release or arbitrary path.
An interrupted attempt is retained and blocks another automatic apply.
"""
import argparse
import difflib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

TARGET = '/etc/nginx/conf.d/fkssj-domain.conf'
BACKUP = '/var/backups/fkssj-nginx-status-only'
PENDING = '.fkssj-status-only.pending'
ENDPOINT = 'https://fkssj.harvey-ai.xyz/_fkssj-release/v1/status'
BASELINE = b'''server {
    listen 80;
    server_name fkssj.harvey-ai.xyz;
    server_tokens off;
    location ^~ /.well-known/acme-challenge/ {
        root /srv/fkssj/acme;
        default_type text/plain;
        try_files $uri =404;
    }
    location / { return 301 https://fkssj.harvey-ai.xyz$request_uri; }
}

server {
    listen 443 ssl;
    server_name fkssj.harvey-ai.xyz;
    ssl_certificate /etc/letsencrypt/live/fkssj.harvey-ai.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fkssj.harvey-ai.xyz/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    root /srv/fkssj/current;
    index index.html;
    server_tokens off;
    autoindex off;
    default_type application/octet-stream;
    types {
        text/html html;
        text/css css;
        application/javascript js;
        application/json json;
        image/svg+xml svg;
    }
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "same-origin" always;
    location / { try_files $uri $uri/ =404; }
}
'''
LOCATION = b'''    location = /_fkssj-release/v1/status {
        limit_except POST { deny all; }
        client_max_body_size 1k;
        client_body_timeout 5s;
        proxy_pass http://127.0.0.1:8790/v1/status;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header X-FKSSJ-Envelope $http_x_fkssj_envelope;
        proxy_set_header X-FKSSJ-Signature $http_x_fkssj_signature;
        proxy_request_buffering on;
        proxy_buffering off;
        proxy_cache off;
        proxy_intercept_errors off;
        proxy_next_upstream off;
        proxy_connect_timeout 3s;
        proxy_send_timeout 5s;
        proxy_read_timeout 10s;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "same-origin" always;
    }
    location = /_fkssj-release { return 404; }
    location ^~ /_fkssj-release/ { return 404; }
'''
CANDIDATE = BASELINE[:-2] + LOCATION + b'}\n'
BASELINE_SHA = hashlib.sha256(BASELINE).hexdigest()
CANDIDATE_SHA = hashlib.sha256(CANDIDATE).hexdigest()
COMMANDS = {
    'active': ['/usr/bin/systemctl', 'is-active', '--quiet', 'nginx.service'],
    'test': ['/usr/sbin/nginx', '-t', '-q'],
    'reload': ['/usr/bin/systemctl', 'reload', 'nginx.service'],
}


class Failure(RuntimeError):
    def __init__(self, code, observed_sha256=None):
        super().__init__(code)
        self.observed_sha256 = observed_sha256


def need(condition, code):
    if not condition:
        raise Failure(code)


class Host:
    def __init__(self, root=Path('/')):
        self.root = Path(root)

    def path(self, absolute):
        need(absolute.startswith('/') and '..' not in Path(absolute).parts, 'fixed_absolute_path_required')
        return self.root / absolute.lstrip('/')

    def euid(self):
        return os.geteuid()

    def meta(self, fd):
        return os.fstat(fd)

    def owner(self, fd, uid, gid):
        need(self.root == Path('/'), 'fixture_must_stub_owner')
        os.fchown(fd, uid, gid)

    def command(self, name):
        need(self.root == Path('/'), 'fixture_must_stub_command')
        need(name in COMMANDS, 'unknown_fixed_command')
        try:
            result = subprocess.run(COMMANDS[name], capture_output=True, timeout=20,
                                    env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'},
                                    check=False)
            # Raw stderr can quote unrelated configuration; never print/save it.
            return {'state': 'finished', 'returncode': result.returncode}
        except subprocess.TimeoutExpired:
            return {'state': 'unknown', 'returncode': None}
        except OSError:
            return {'state': 'not_started', 'returncode': None}

    def directory(self, absolute):
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in Path(absolute).parts[1:]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
                info = self.meta(fd)
                need(info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe_parent_directory')
            return fd
        except BaseException:
            os.close(fd)
            raise


def stamp(info):
    return tuple(getattr(info, key) for key in (
        'st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
        'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def capture(host, fd, limit=16384, backup=False):
    before = host.meta(fd)
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
         (before.st_uid, before.st_gid) == (0, 0) and
         stat.S_IMODE(before.st_mode) in ((0o600,) if backup else (0o640, 0o644)) and
         0 < before.st_size <= limit, 'unsafe_file_metadata')
    data = bytearray()
    while len(data) <= limit:
        chunk = os.read(fd, limit + 1 - len(data))
        if not chunk:
            break
        data.extend(chunk)
    need(len(data) == before.st_size and stamp(before) == stamp(host.meta(fd)), 'file_changed_during_read')
    return bytes(data), stamp(before)


def current(host):
    parent = host.directory(str(Path(TARGET).parent))
    try:
        fd = os.open(Path(TARGET).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            return capture(host, fd)
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def exists(host, absolute):
    parent = host.directory(str(Path(absolute).parent))
    try:
        try:
            os.stat(Path(absolute).name, dir_fd=parent, follow_symlinks=False)
            return True
        except FileNotFoundError:
            return False
    finally:
        os.close(parent)


def ok(result):
    return result == {'state': 'finished', 'returncode': 0}


def preflight(host):
    need(host.euid() == 0, 'root_required')
    data, _ = current(host)
    if data != BASELINE:
        raise Failure('baseline_mismatch_no_changes', hashlib.sha256(data).hexdigest())
    need(not exists(host, BACKUP), 'attempt_directory_exists_stop_inspect')
    need(not exists(host, str(Path(TARGET).parent / PENDING)), 'pending_file_exists_stop_inspect')
    need(ok(host.command('active')), 'nginx_not_confirmed_active')
    return {'state': 'preflight_ok_await_authorization', 'endpoint': ENDPOINT,
            'baselineSha256': BASELINE_SHA, 'candidateSha256': CANDIDATE_SHA,
            'backupDirectory': BACKUP,
            'diff': ''.join(difflib.unified_diff(BASELINE.decode().splitlines(True),
                       CANDIDATE.decode().splitlines(True), fromfile=TARGET, tofile=TARGET))}


def write_all(fd, data):
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        need(count > 0, 'short_write_retained')
        view = view[count:]


def new_file(host, parent, name, data, mode):
    fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        host.owner(fd, 0, 0)
        os.fchmod(fd, mode)
        write_all(fd, data)
        os.fsync(fd)
        os.lseek(fd, 0, os.SEEK_SET)
        check, _ = capture(host, fd, backup=(mode == 0o600))
        need(check == data, 'new_file_verification_failed')
        created_stamp = stamp(host.meta(fd))
    finally:
        os.close(fd)
    os.fsync(parent)
    return created_stamp


def replace_expected(host, expected, replacement, mode, expected_stamp=None, owned=None):
    # Serialise this operation administratively. The lock cannot lock other root
    # editors; checks immediately before/after rename detect ordinary drift.
    parent = host.directory(str(Path(TARGET).parent))
    try:
        before, original_stamp = current(host)
        need(before == expected and (expected_stamp is None or original_stamp == expected_stamp),
             'concurrent_target_change_stop')
        created_stamp = new_file(host, parent, PENDING, replacement, mode)
        if owned is not None:
            owned['created'] = created_stamp
        again, again_stamp = current(host)
        need(again == expected and again_stamp == original_stamp, 'concurrent_target_change_stop')
        os.replace(PENDING, Path(TARGET).name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
        after, after_stamp = current(host)
        need(after == replacement and after_stamp[:2] == created_stamp[:2], 'replacement_verification_failed')
        if owned is not None:
            owned['committed'] = after_stamp
        return after_stamp
    finally:
        os.close(parent)


def apply(host, approved_sha):
    need(approved_sha == CANDIDATE_SHA, 'candidate_approval_digest_required')
    preflight(host)
    initial, initial_stamp = current(host)
    need(initial == BASELINE, 'baseline_mismatch_no_changes')
    mode = stat.S_IMODE(initial_stamp[2])
    parent = host.directory(str(Path(BACKUP).parent))
    try:
        os.mkdir(Path(BACKUP).name, 0o700, dir_fd=parent)  # exclusive durable attempt
        os.fsync(parent)
    finally:
        os.close(parent)
    directory = host.directory(BACKUP)
    journal = None
    reload_attempted = False
    swap_attempted = False
    owned = {}

    def event(phase, **fields):
        write_all(journal, (json.dumps(dict(phase=phase, **fields), sort_keys=True) + '\n').encode())
        os.fsync(journal)

    def result(state, **fields):
        return dict(state=state, backupDirectory=BACKUP, baselineSha256=BASELINE_SHA,
                    candidateSha256=CANDIDATE_SHA, **fields)

    try:
        fcntl.flock(directory, fcntl.LOCK_EX | fcntl.LOCK_NB)
        info = host.meta(directory)
        need((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (0, 0, 0o700), 'unsafe_backup_directory')
        journal = os.open('journal.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        host.owner(journal, 0, 0)
        os.fchmod(journal, 0o600)
        event('attempt_started', originalMode=oct(mode))
        os.fsync(directory)
        new_file(host, directory, 'original.conf', initial, 0o600)
        new_file(host, directory, 'candidate.conf', CANDIDATE, 0o600)
        event('backups_durable')
        baseline_test = host.command('test')
        event('baseline_test', **baseline_test)
        if not ok(baseline_test):
            return result('stopped_original_retained', reason='baseline_nginx_test_failed')
        # Recheck the original inode before starting any replacement.
        need(current(host) == (initial, initial_stamp), 'concurrent_target_change_stop')
        event('candidate_swap_pending')
        swap_attempted = True
        candidate_stamp = replace_expected(host, BASELINE, CANDIDATE, mode, initial_stamp, owned)
        event('candidate_written')
        candidate_test = host.command('test')
        event('candidate_test', **candidate_test)
        need(ok(candidate_test), 'candidate_nginx_test_failed')
        need(current(host) == (CANDIDATE, candidate_stamp), 'concurrent_target_change_stop')
        event('reload_pending')
        reload_attempted = True
        reply = host.command('reload')
        event('reload_reply', **reply)
        need(ok(reply), 'reload_not_confirmed')
        need(current(host) == (CANDIDATE, candidate_stamp), 'concurrent_target_change_stop')
        event('applied_reload_acknowledged')
        return result('applied_reload_acknowledged', publicEndpointVerified=False)
    except BaseException as error:
        code = str(error) if isinstance(error, Failure) else 'interrupted_or_io_failure'
        # If any unrelated bytes/metadata appear, preserve them, never overwrite.
        try:
            data, current_stamp = current(host)
            if not swap_attempted:
                state = 'stopped_original_retained' if data == BASELINE else 'uncertain'
                if journal is not None:
                    event(state, reason=code)
                return result(state, reason=code)
            expected_owned = owned.get('committed', owned.get('created'))
            # rename can change ctime; all other captured fields must agree.
            identity_ok = expected_owned is not None and current_stamp[:-1] == expected_owned[:-1]
            if 'committed' in owned:
                identity_ok = identity_ok and current_stamp == owned['committed']
            if data != CANDIDATE or not identity_ok:
                if journal is not None:
                    event('uncertain', reason='target_not_owned_candidate_no_restore')
                return result('uncertain', reason='target_not_owned_candidate_no_restore')
            if journal is not None:
                event('restore_pending', reason=code)
            restored_stamp = replace_expected(host, CANDIDATE, BASELINE, mode, current_stamp)
            restored_test = host.command('test')
            if journal is not None:
                event('restored_test', **restored_test)
            if not ok(restored_test):
                return result('uncertain', reason='original_restored_validation_not_confirmed')
            need(current(host) == (BASELINE, restored_stamp), 'concurrent_restored_target_change_stop')
            if reload_attempted:
                if journal is not None:
                    event('recovery_reload_pending')
                recovery = host.command('reload')
                if journal is not None:
                    event('recovery_reload_reply', **recovery)
                return result('uncertain', reason='original_restored_reload_outcome_requires_review',
                              recoveryReloadAcknowledged=ok(recovery))
            if journal is not None:
                event('stopped_original_restored')
            return result('stopped_original_restored', reason=code, reloadAttempted=False)
        except BaseException:
            return result('uncertain', reason='recovery_incomplete_retain_all_files')
    finally:
        if journal is not None:
            os.close(journal)
        os.close(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight', 'apply'])
    parser.add_argument('--approve-candidate-sha256')
    args = parser.parse_args()
    try:
        outcome = preflight(Host()) if args.action == 'preflight' else apply(Host(), args.approve_candidate_sha256)
        diff = outcome.pop('diff', None)
        print(json.dumps(outcome, sort_keys=True))
        if diff:
            print(diff, end='')
        return 3 if outcome['state'] == 'uncertain' else 0 if outcome['state'] in (
            'preflight_ok_await_authorization', 'applied_reload_acknowledged') else 1
    except BaseException as error:
        code = str(error) if isinstance(error, Failure) else 'io_or_execution_failure'
        info = {'state': 'stopped_no_automatic_retry', 'reason': code}
        if isinstance(error, Failure) and error.observed_sha256 is not None:
            info.update(observedSha256=error.observed_sha256, expectedBaselineSha256=BASELINE_SHA)
        print(json.dumps(info), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

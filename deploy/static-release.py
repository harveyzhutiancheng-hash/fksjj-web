#!/usr/bin/env python3
"""Offline v0.14 static verifier/stager/activator; never transports or unpacks.

CLI root is fixed. Function-level root/clock injection exists for temporary tests.
The root and its parent directories must be controlled by the trusted deployer;
the advisory lock serializes this tool, not arbitrary privileged writers.
An independently pinned receipt is external audit input, not a live API probe.
An interrupted activation leaves a pending journal. There is deliberately no
cleanup, retry, rollback, receipt-generation, or gate-bypass command.
"""

import argparse
import contextlib
import ctypes
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import uuid

ROOT = Path('/srv/fkssj')
VERSION = '0.14.0'
ORIGIN = 'https://fkssj.harvey-ai.xyz'
FILES = frozenset('''index.html bootstrap.js app.js account-manager.js
account-ui.js account-ui.css page-lock.js storm-view.js scene.js game-state.js
progress-state.js progress-ui.js progress-ui.css battle-view.js campaign-view.js
scavenging-state.js scavenging-view.js scavenging-ui.js scavenging-ui.css
production-state.js production-ui.js production-ui.css story-state.js
diving-state.js diving-view.js diving-ui.js diving-ui.css battle-view.css icons.js
style.css assets/favicon.svg node_modules/three/build/three.module.js
node_modules/three/build/three.core.js node_modules/three/LICENSE'''.split())
CHECKS = frozenset('''health auth_register_login get_user_mismatch
no_cross_account_disclosure cas_conflict origin_csrf secure_cookie persistence
service_running proxy_route'''.split())
PENDING = '.static-release-pending.json'
LOCK = '.static-release.lock'
MAX_FILE = 32 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


class ReleaseError(Exception):
    pass


class Uncertain(ReleaseError):
    """A filesystem mutation may have completed; preserve evidence and stop."""


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def valid_hash(value):
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value),
            'SHA-256 must be 64 lowercase hexadecimal characters')
    return value


def valid_id(value):
    require(isinstance(value, str) and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,95}', value)
            and '..' not in value, 'invalid release id')
    return value


def target(value, prefix='releases'):
    require(isinstance(value, str) and value.startswith(prefix + '/'), 'invalid relative target')
    valid_id(value[len(prefix) + 1:])
    return value


def expected(value):
    return value if value == 'absent' else target(value)


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate JSON key: ' + key)
            result[key] = value
        return result
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ReleaseError('invalid JSON constant')))
    except (UnicodeError, ValueError) as exc:
        raise ReleaseError('invalid UTF-8 JSON') from exc


@contextlib.contextmanager
def directory(path):
    """Open absolute directory without following any symlink component."""
    path = os.fspath(path)
    require(os.path.isabs(path) and '..' not in path.split('/'), 'absolute directory required')
    fd = os.open('/', DIR_FLAGS)
    try:
        for name in path.split('/'):
            if not name or name == '.':
                continue
            next_fd = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def relative_directory(parent, path):
    fd = os.dup(parent)
    try:
        for name in path.split('/'):
            require(name not in ('', '.', '..'), 'invalid directory component')
            next_fd = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    finally:
        os.close(fd)


def read_file(parent, name, limit=MAX_FILE):
    fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
                'file must be regular with one hard link: ' + name)
        require(before.st_size <= limit, 'file too large: ' + name)
        chunks, length = [], 0
        while True:
            chunk = os.read(fd, min(1024 * 1024, limit + 1 - length))
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
            require(length <= limit, 'file grew beyond bound: ' + name)
        after = os.fstat(fd)
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
        require(all(getattr(before, key) == getattr(after, key) for key in fields),
                'file changed during read: ' + name)
        return b''.join(chunks)
    finally:
        os.close(fd)


def read_absolute(path, limit):
    path = Path(path)
    require(path.is_absolute(), 'absolute file path required')
    with directory(path.parent) as fd:
        return read_file(fd, path.name, limit)


def snapshot_fd(fd, manifest_sha256):
    valid_hash(manifest_sha256)
    manifest_bytes = read_file(fd, 'release.json', 256 * 1024)
    require(digest(manifest_bytes) == manifest_sha256, 'manifest SHA-256 mismatch')
    manifest = strict_json(manifest_bytes)
    require(isinstance(manifest, dict) and set(manifest) ==
            {'version', 'createdAt', 'fileCount', 'totalBytes', 'files'}, 'invalid manifest fields')
    require(manifest['version'] == VERSION, 'only version ' + VERSION + ' is supported')
    require(isinstance(manifest['createdAt'], str), 'invalid createdAt')
    timestamp(manifest['createdAt'])
    require(type(manifest['fileCount']) is int and manifest['fileCount'] == len(FILES), 'fileCount mismatch')
    require(type(manifest['totalBytes']) is int and 0 <= manifest['totalBytes'] <= MAX_TOTAL,
            'invalid totalBytes')
    require(isinstance(manifest['files'], list) and len(manifest['files']) == len(FILES),
            'invalid manifest files')
    entries = {}
    for entry in manifest['files']:
        require(isinstance(entry, dict) and set(entry) == {'path', 'bytes', 'sha256'}, 'invalid file entry')
        name = entry['path']
        require(isinstance(name, str) and name in FILES and name not in entries,
                'unapproved or duplicate manifest path')
        require(type(entry['bytes']) is int and 0 <= entry['bytes'] <= MAX_FILE, 'invalid file bytes')
        valid_hash(entry['sha256'])
        entries[name] = entry
    require(set(entries) == FILES, 'manifest allowlist mismatch')
    require(sum(entry['bytes'] for entry in entries.values()) == manifest['totalBytes'], 'totalBytes mismatch')
    allowed_files = FILES | {'release.json'}
    allowed_dirs = {str(Path(name).parent) for name in allowed_files}
    allowed_dirs |= {str(parent) for name in list(allowed_dirs) for parent in Path(name).parents}
    allowed_dirs.discard('.')
    captured = {}

    def walk(current, prefix=''):
        for name in os.listdir(current):
            relative = prefix + name
            info = os.stat(name, dir_fd=current, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                require(relative in allowed_dirs, 'extra directory: ' + relative)
                with relative_directory(current, name) as child:
                    walk(child, relative + '/')
            else:
                require(relative in allowed_files, 'extra file: ' + relative)
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                        'symlink, hardlink or special file: ' + relative)
                data = read_file(current, name, 256 * 1024 if relative == 'release.json' else MAX_FILE)
                if relative == 'release.json':
                    require(data == manifest_bytes, 'manifest changed during capture')
                else:
                    entry = entries[relative]
                    require(len(data) == entry['bytes'] and digest(data) == entry['sha256'],
                            'payload mismatch: ' + relative)
                captured[relative] = data
    walk(fd)
    require(set(captured) == allowed_files, 'missing release file')
    return manifest, captured


def check(source, manifest_sha256, release_id, expected_current):
    valid_id(release_id)
    expected(expected_current)
    with directory(source) as fd:
        manifest, _ = snapshot_fd(fd, manifest_sha256)
    return {'status': 'verified', 'operation': 'check', 'version': VERSION,
            'releaseId': release_id, 'manifestSha256': manifest_sha256,
            'fileCount': manifest['fileCount'], 'totalBytes': manifest['totalBytes'],
            'currentChecked': False}


def exists(fd, name):
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


def current(fd):
    if not exists(fd, 'current'):
        return 'absent'
    require(stat.S_ISLNK(os.stat('current', dir_fd=fd, follow_symlinks=False).st_mode),
            'current must be a relative symlink')
    value = target(os.readlink('current', dir_fd=fd))
    with relative_directory(fd, value):
        pass
    return value


def cas(fd, expected_current):
    expected(expected_current)
    require(current(fd) == expected_current, 'expected-current CAS mismatch')


@contextlib.contextmanager
def locked(root):
    with directory(root) as fd:
        lock_fd = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                          0o600, dir_fd=fd)
        try:
            info = os.fstat(lock_fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe lock file')
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ReleaseError('another static release operation holds the lock') from exc
            require(not exists(fd, PENDING), 'pending activation: stop for manual read-only investigation')
            yield fd
        finally:
            os.close(lock_fd)


def write_new(fd, name, data):
    file_fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                      0o644, dir_fd=fd)
    try:
        view = memoryview(data)
        while view:
            written = os.write(file_fd, view)
            require(written > 0, 'short write')
            view = view[written:]
        os.fsync(file_fd)
        created = os.fstat(file_fd)
        named = os.stat(name, dir_fd=fd, follow_symlinks=False)
        require(stat.S_ISREG(created.st_mode) and created.st_nlink == 1
                and (created.st_dev, created.st_ino) == (named.st_dev, named.st_ino),
                'new journal identity changed')
        return journal_stamp(created)
    finally:
        os.close(file_fd)


def journal_stamp(info):
    return tuple(getattr(info, field) for field in
                 ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
                  'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def clear_owned_pending(parent, data, created):
    """Never remove an unknown marker, including a same-content replacement."""
    source = os.open(PENDING, FILE_FLAGS, dir_fd=parent)
    try:
        before = os.fstat(source)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and not stat.S_IMODE(before.st_mode) & 0o022
                and before.st_size == len(data) <= 65536
                and journal_stamp(before) == created, 'pending journal identity changed')
        require(os.pread(source, len(data) + 1, 0) == data, 'pending journal content changed')
        named = os.stat(PENDING, dir_fd=parent, follow_symlinks=False)
        require(journal_stamp(before) == journal_stamp(os.fstat(source))
                and journal_stamp(named) == created, 'pending journal name changed')
        os.unlink(PENDING, dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(source)


def rename_new(fd, source, destination):
    """Linux atomic NOREPLACE; no racy existence-check/rename fallback."""
    function = getattr(ctypes.CDLL(None, use_errno=True), 'renameat2', None)
    require(function is not None, 'renameat2 is unavailable; refusing unsafe fallback')
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(fd, os.fsencode(source), fd, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), destination)


def stage(source, manifest_sha256, release_id, expected_current, *, root=ROOT):
    valid_id(release_id)
    expected(expected_current)
    with directory(source) as source_fd:
        manifest, captured = snapshot_fd(source_fd, manifest_sha256)
    temporary = '.stage-' + uuid.uuid4().hex
    published = False
    publishing = False
    with locked(root) as fd, relative_directory(fd, 'releases') as releases_fd:
        cas(fd, expected_current)
        require(not exists(releases_fd, release_id), 'release id already exists')
        os.mkdir(temporary, 0o755, dir_fd=releases_fd)
        staging_info = os.stat(temporary, dir_fd=releases_fd, follow_symlinks=False)
        staging_identity = (staging_info.st_dev, staging_info.st_ino)
        try:
            with relative_directory(releases_fd, temporary) as staging_fd:
                directories = sorted({str(parent) for name in captured for parent in Path(name).parents
                                      if str(parent) != '.'}, key=lambda name: (name.count('/'), name))
                for name in directories:
                    parts = name.split('/')
                    if len(parts) == 1:
                        os.mkdir(name, 0o755, dir_fd=staging_fd)
                    else:
                        with relative_directory(staging_fd, '/'.join(parts[:-1])) as parent:
                            os.mkdir(parts[-1], 0o755, dir_fd=parent)
                for name, data in captured.items():
                    parent, _, leaf = name.rpartition('/')
                    with relative_directory(staging_fd, parent) if parent else contextlib.nullcontext(staging_fd) as parent_fd:
                        write_new(parent_fd, leaf, data)
                snapshot_fd(staging_fd, manifest_sha256)
                for name in reversed(directories):
                    with relative_directory(staging_fd, name) as child:
                        os.fsync(child)
                os.fsync(staging_fd)
            cas(fd, expected_current)
            publishing = True
            rename_new(releases_fd, temporary, release_id)
            published = True
            os.fsync(releases_fd)
        except BaseException as exc:
            if published:
                raise Uncertain('stage directory published; durability uncertain; inspect releases/' + release_id) from exc
            if publishing:
                # A signal or wrapper failure can arrive after successful rename,
                # before Python records the result. Never call that unexecuted.
                try:
                    original = os.stat(temporary, dir_fd=releases_fd, follow_symlinks=False)
                    original_matches = (original.st_dev, original.st_ino) == staging_identity
                    candidate = (os.stat(release_id, dir_fd=releases_fd, follow_symlinks=False)
                                 if exists(releases_fd, release_id) else None)
                    candidate_matches = candidate is not None and (candidate.st_dev, candidate.st_ino) == staging_identity
                    require(original_matches and not candidate_matches, 'stage directory identity changed')
                except (OSError, ReleaseError) as inspection_error:
                    raise Uncertain('stage publish was attempted; inspect releases/' + release_id
                                    + ' and ' + temporary + ' read-only before further actions') from inspection_error
            shutil.rmtree(temporary, dir_fd=releases_fd)
            raise
    return {'status': 'staged', 'operation': 'stage', 'version': VERSION,
            'releaseId': release_id, 'manifestSha256': manifest_sha256,
            'fileCount': manifest['fileCount'], 'current': expected_current}


def timestamp(value):
    require(isinstance(value, str) and value.endswith('Z'), 'UTC timestamp ending Z required')
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError as exc:
        raise ReleaseError('invalid timestamp') from exc
    require(parsed.utcoffset() == dt.timedelta(0), 'UTC required')
    return parsed


def acceptance(receipt_path, receipt_sha256, manifest_sha256, expected_api_sha256,
               expected_api_init_sha256, now):
    for value in (receipt_sha256, manifest_sha256, expected_api_sha256, expected_api_init_sha256):
        valid_hash(value)
    data = read_absolute(receipt_path, 64 * 1024)
    require(digest(data) == receipt_sha256, 'API receipt SHA-256 mismatch')
    receipt = strict_json(data)
    require(isinstance(receipt, dict) and set(receipt) ==
            {'schema', 'type', 'manifestSha256', 'origin', 'checkedAt', 'expiresAt',
             'backendTarget', 'apiAppSha256', 'apiInitSha256', 'checks'}, 'invalid API receipt fields')
    require(type(receipt['schema']) is int and receipt['schema'] == 1 and
            receipt['type'] == 'fkssj-api-acceptance', 'invalid API receipt schema/type')
    require(receipt['origin'] == ORIGIN and receipt['manifestSha256'] == manifest_sha256,
            'API receipt origin/manifest binding mismatch')
    require(receipt['apiAppSha256'] == expected_api_sha256 and
            receipt['apiInitSha256'] == expected_api_init_sha256, 'API receipt code pin mismatch')
    start, end = timestamp(receipt['checkedAt']), timestamp(receipt['expiresAt'])
    require(now.tzinfo is not None and start <= now < end and
            dt.timedelta(0) < end - start <= dt.timedelta(minutes=15), 'API receipt is future, expired or too long lived')
    target(receipt['backendTarget'], 'api-releases')
    require(isinstance(receipt['checks'], dict) and set(receipt['checks']) == CHECKS and
            all(value is True for value in receipt['checks'].values()), 'API acceptance checks incomplete')
    return receipt


def backend(fd, receipt, api_sha256, api_init_sha256):
    require(stat.S_ISLNK(os.stat('api-current', dir_fd=fd, follow_symlinks=False).st_mode),
            'api-current must be a relative symlink')
    require(os.readlink('api-current', dir_fd=fd) == receipt['backendTarget'], 'api-current target mismatch')
    with relative_directory(fd, receipt['backendTarget'] + '/api') as api_fd:
        require(digest(read_file(api_fd, 'app.py')) == api_sha256, 'installed api/app.py SHA-256 mismatch')
        require(digest(read_file(api_fd, '__init__.py')) == api_init_sha256,
                'installed api/__init__.py SHA-256 mismatch')


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode('utf-8')


def activate(release_id, manifest_sha256, expected_current, api_receipt,
             api_receipt_sha256, expected_api_sha256, expected_api_init_sha256, *,
             root=ROOT, now=None):
    valid_id(release_id)
    expected(expected_current)
    # Tests may inject a fixed instant or a clock callable. Production always
    # reads the clock afresh; a receipt may expire while a large tree is read.
    clock = now if callable(now) else ((lambda: now) if now is not None
                                      else lambda: dt.datetime.now(dt.timezone.utc))
    started_at = clock()
    receipt = acceptance(api_receipt, api_receipt_sha256, manifest_sha256,
                         expected_api_sha256, expected_api_init_sha256, started_at)
    destination = 'releases/' + release_id
    operation_id = uuid.uuid4().hex
    temporary = '.current-static-' + operation_id
    armed = False
    temporary_created = False
    journal = {'schema': 1, 'operationId': operation_id, 'state': 'pending',
               'expectedCurrent': expected_current, 'target': destination,
               'manifestSha256': manifest_sha256, 'receiptSha256': api_receipt_sha256,
               'apiAppSha256': expected_api_sha256, 'apiInitSha256': expected_api_init_sha256,
               'backendTarget': receipt['backendTarget'], 'at': started_at.isoformat(), 'temporaryLink': temporary}
    with locked(root) as fd:
        cas(fd, expected_current)
        require(expected_current != destination, 'release already current')
        with relative_directory(fd, destination) as candidate:
            snapshot_fd(candidate, manifest_sha256)
        backend(fd, receipt, expected_api_sha256, expected_api_init_sha256)
        try:
            os.symlink(destination, temporary, dir_fd=fd)
            temporary_created = True
            # Set armed before writing: partial journal also requires investigation.
            armed = True
            pending_bytes = encode(journal)
            pending_stamp = write_new(fd, PENDING, pending_bytes)
            os.fsync(fd)
            cas(fd, expected_current)
            backend(fd, receipt, expected_api_sha256, expected_api_init_sha256)
            acceptance(api_receipt, api_receipt_sha256, manifest_sha256,
                       expected_api_sha256, expected_api_init_sha256, clock())
            os.replace(temporary, 'current', src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
            require(current(fd) == destination, 'current did not resolve to requested release')
            completed = dict(journal, state='completed', observedCurrent=destination)
            write_new(fd, '.static-release-completed-' + operation_id + '.json', encode(completed))
            os.fsync(fd)
            clear_owned_pending(fd, pending_bytes, pending_stamp)
        except BaseException as exc:
            if armed:
                # Never automatically undo a possibly completed switch. Restore the
                # gate best-effort if final unlink/fsync failed; report uncertainty.
                if not exists(fd, PENDING):
                    try:
                        write_new(fd, PENDING, encode(dict(journal, state='uncertain')))
                        os.fsync(fd)
                    except BaseException:
                        pass
                raise Uncertain('activation outcome/durability uncertain; stop and inspect current, '
                                + PENDING + ' and completed journals read-only; no automatic retry') from exc
            if temporary_created and exists(fd, temporary):
                os.unlink(temporary, dir_fd=fd)
            raise
    return {'status': 'activated', 'operation': 'activate', 'version': VERSION,
            'releaseId': release_id, 'manifestSha256': manifest_sha256, 'current': destination,
            'apiEvidence': 'externally supplied pinned receipt; not a live probe',
            'localApiFilesVerified': ['api/app.py', 'api/__init__.py']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('check', 'stage', 'activate'):
        command = commands.add_parser(name)
        command.add_argument('--release-id', required=True)
        command.add_argument('--manifest-sha256', required=True)
        command.add_argument('--expected-current', required=True)
        if name in ('check', 'stage'):
            command.add_argument('--source', required=True)
        else:
            command.add_argument('--api-receipt', required=True)
            command.add_argument('--api-receipt-sha256', required=True)
            command.add_argument('--expected-api-sha256', required=True)
            command.add_argument('--expected-api-init-sha256', required=True)
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0].startswith('--') and argv[0] not in ('--help', '-h'):
        argv.insert(0, 'check')  # omitted command can only perform read-only verification
    args = vars(parser.parse_args(argv))
    command = args.pop('command')
    try:
        result = globals()[command](**args)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ReleaseError, OSError) as exc:
        print(json.dumps({'status': 'uncertain' if isinstance(exc, Uncertain) else 'failed',
                          'operation': command, 'error': str(exc)}, sort_keys=True), file=sys.stderr)
        return 3 if isinstance(exc, Uncertain) else 1


if __name__ == '__main__':
    sys.exit(main())

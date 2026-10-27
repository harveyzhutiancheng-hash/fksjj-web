#!/usr/bin/env python3
"""Signed receive-only HTTP endpoint and separate fixed static publisher.

No SSH, download URL, arbitrary command execution or API installation.
The separate opt-in publish-worker calls only the root-owned fixed coordinator;
the receiver and legacy/stage workers never generate API acceptance evidence.
CLI paths/identities are fixed; Config injection is for isolated fixture tests.
The state directory is trusted shared storage for the two service identities.
Processing/uncertain jobs stop the worker: there is no automatic retry/cleanup.
"""
import base64
import contextlib
from dataclasses import dataclass
import fcntl
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import stat
import sys
import tarfile
import threading
import time

_spec = importlib.util.spec_from_file_location('fixed_static_release', Path(__file__).with_name('static-release.py'))
release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release)
REPO = 'harveyzhutiancheng-hash/fksjj-web'
REF = 'refs/heads/main'
DOMAIN = b'FKSSJ-RELEASE-V1\n'
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_EXTRACTED_BYTES = 64 * 1024 * 1024
MAX_MEMBERS = 128
MAX_RESERVED_BYTES = 64 * 1024 * 1024
MAX_RELEASES = 16
MAX_REQUESTS = 10000
MAX_CONNECTIONS = 8
MAX_REQUEST_SECONDS = 45
FIELDS = frozenset('schema operation repo ref commit requestId releaseId artifactSha256 artifactBytes manifestSha256 expectedCurrent issuedAt expiresAt'.split())
BINDING = ('repo', 'ref', 'commit', 'releaseId', 'artifactSha256', 'artifactBytes', 'manifestSha256', 'expectedCurrent')


class ChannelError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


def require(value, code, status=400):
    if not value:
        raise ChannelError(code, status)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


@dataclass
class Config:
    state: Path
    root: Path
    key: bytes
    receipt_path: Path | None = None
    receipt_sha256: str | None = None
    api_sha256: str | None = None
    api_init_sha256: str | None = None
    clock: object = time.time


def verify(raw, signature, config, operation=None):
    require(isinstance(signature, str) and re.fullmatch('[0-9a-f]{64}', signature), 'auth_failed', 401)
    expected = hmac.new(config.key, DOMAIN + raw, hashlib.sha256).hexdigest()
    require(hmac.compare_digest(expected, signature), 'auth_failed', 401)
    try:
        value = release.strict_json(raw)
        require(isinstance(value, dict) and set(value) == FIELDS and canonical(value) == raw, 'invalid_envelope')
        require(type(value['schema']) is int and value['schema'] == 1, 'invalid_schema')
        require(value['operation'] in ('upload', 'activate', 'status') and
                (operation is None or value['operation'] == operation), 'operation_mismatch')
        require(value['repo'] == REPO and value['ref'] == REF, 'source_mismatch')
        for key, size in (('commit', 40), ('requestId', 32), ('releaseId', 32),
                          ('artifactSha256', 64), ('manifestSha256', 64)):
            require(isinstance(value[key], str) and re.fullmatch('[0-9a-f]{' + str(size) + '}', value[key]), 'invalid_' + key)
        require(type(value['artifactBytes']) is int and 0 < value['artifactBytes'] <= MAX_ARTIFACT_BYTES, 'artifact_limit', 413)
        release.target(value['expectedCurrent'])
        fresh(value, config)
        return value
    except (release.ReleaseError, TypeError, KeyError, ValueError):
        raise ChannelError('invalid_envelope') from None


def fresh(value, config):
    now = config.clock()
    start, end = value['issuedAt'], value['expiresAt']
    require(type(start) is int and type(end) is int and 0 < end - start <= 300
            and start <= now < end, 'expired', 401)


class Store:
    def __init__(self, config, *, existing_only=False):
        require(type(existing_only) is bool, 'invalid_store_mode')
        self.config = config
        self.existing_only = existing_only
        with release.directory(config.state) as fd:
            require(not existing_only or release.exists(fd, 'state.sqlite3'), 'existing_state_required')
            for name in ('state.sqlite3', 'state.sqlite3-journal', 'state.sqlite3-wal', 'state.sqlite3-shm'):
                if release.exists(fd, name):
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe_state')
                    if existing_only and name == 'state.sqlite3':
                        require(stat.S_IMODE(info.st_mode) == 0o660, 'shared_state_mode_required')
            with self.connect() as db:
                if existing_only:
                    self.check_existing_schema(db)
                else:
                    db.executescript('''
                CREATE TABLE IF NOT EXISTS requests (
                  request_id TEXT PRIMARY KEY, release_id TEXT NOT NULL,
                  operation TEXT NOT NULL, envelope BLOB NOT NULL, signature TEXT NOT NULL,
                  state TEXT NOT NULL, error TEXT);
                CREATE TABLE IF NOT EXISTS releases (
                  release_id TEXT PRIMARY KEY, upload_id TEXT NOT NULL, state TEXT NOT NULL,
                  envelope BLOB NOT NULL, bytes INTEGER NOT NULL);
                ''')
            os.fsync(fd)

    @staticmethod
    def check_existing_schema(db):
        # Stage-only never bootstraps or repairs a database. Reject additional
        # tables/views/triggers as well as incompatible definitions, before any
        # job is claimed. No request values are returned by this schema query.
        expected = {
            'requests': 'CREATE TABLE requests ( request_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, operation TEXT NOT NULL, envelope BLOB NOT NULL, signature TEXT NOT NULL, state TEXT NOT NULL, error TEXT)',
            'releases': 'CREATE TABLE releases ( release_id TEXT PRIMARY KEY, upload_id TEXT NOT NULL, state TEXT NOT NULL, envelope BLOB NOT NULL, bytes INTEGER NOT NULL)',
        }
        rows = db.execute('SELECT name,type,sql FROM sqlite_master').fetchall()
        require(len(rows) == 4, 'existing_schema_required')
        for name, kind, sql in rows:
            if name in expected:
                require(kind == 'table' and isinstance(sql, str) and
                        ' '.join(sql.split()) == expected[name], 'existing_schema_required')
            else:
                require(name in ('sqlite_autoindex_requests_1', 'sqlite_autoindex_releases_1')
                        and kind == 'index' and sql is None, 'existing_schema_required')

    def connect(self):
        path = self.config.state / 'state.sqlite3'
        if self.existing_only:
            with release.directory(self.config.state) as fd:
                info = os.stat('state.sqlite3', dir_fd=fd, follow_symlinks=False)
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe_state')
                require(stat.S_IMODE(info.st_mode) == 0o660, 'shared_state_mode_required')
            # mode=rw cannot create the database, including if it disappears
            # after the metadata check. as_uri escapes #, ? and other path data.
            db = sqlite3.connect(path.absolute().as_uri() + '?mode=rw', uri=True, timeout=2)
        else:
            db = sqlite3.connect(path, timeout=2)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA synchronous=FULL')
        return contextlib.closing(db)

    @contextlib.contextmanager
    def transaction(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise

    def reserve(self, value, raw, signature):
        rejected = None
        with self.transaction() as db:
            require(db.execute('SELECT 1 FROM requests WHERE request_id=?', (value['requestId'],)).fetchone() is None,
                    'replay', 409)
            require(db.execute('SELECT COUNT(*) FROM requests').fetchone()[0] < MAX_REQUESTS, 'ledger_full', 503)
            operation = value['operation']
            # A verified request rejected by a state precondition still consumes
            # its nonce. Otherwise a rejected activation could be replayed after
            # stage finishes and unexpectedly become executable.
            db.execute("INSERT INTO requests VALUES (?,?,?,?,?,'rejected',NULL)",
                       (value['requestId'], value['releaseId'], operation, raw, signature))
            try:
                existing = db.execute('SELECT * FROM releases WHERE release_id=?', (value['releaseId'],)).fetchone()
                if operation == 'upload':
                    require(existing is None, 'release_exists', 409)
                    count, size = db.execute('SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM releases').fetchone()
                    require(count < MAX_RELEASES and size + value['artifactBytes'] <= MAX_RESERVED_BYTES, 'storage_limit', 503)
                    db.execute('INSERT INTO releases VALUES (?,?,?,?,?)',
                               (value['releaseId'], value['requestId'], 'receiving', raw, value['artifactBytes']))
                    state = 'receiving'
                else:
                    require(existing is not None, 'unknown_release', 404)
                    original = release.strict_json(existing['envelope'])
                    require(all(value[key] == original[key] for key in BINDING), 'binding_mismatch', 409)
                    if operation == 'activate':
                        require(existing['state'] == 'staged', 'not_staged', 409)
                        require(db.execute("SELECT 1 FROM requests WHERE operation='activate' AND state IN ('queued','processing','uncertain')").fetchone() is None,
                                'activation_pending', 409)
                    state = 'completed' if operation == 'status' else 'queued'
                db.execute('UPDATE requests SET state=? WHERE request_id=?', (state, value['requestId']))
            except ChannelError as exc:
                db.execute('UPDATE requests SET error=? WHERE request_id=?', (exc.code, value['requestId']))
                rejected = exc
        if rejected is not None:
            raise rejected

    def finish(self, request_id, state, error=None, release_state=None):
        with self.transaction() as db:
            row = db.execute('SELECT release_id FROM requests WHERE request_id=?', (request_id,)).fetchone()
            require(row is not None, 'unknown_request')
            db.execute('UPDATE requests SET state=?, error=? WHERE request_id=?', (state, error, request_id))
            if release_state is not None:
                db.execute('UPDATE releases SET state=? WHERE release_id=?', (release_state, row['release_id']))

    def status(self, release_id):
        with self.connect() as db:
            row = db.execute('SELECT state FROM releases WHERE release_id=?', (release_id,)).fetchone()
            require(row is not None, 'unknown_release', 404)
            last = db.execute("SELECT request_id AS requestId,operation,state,error FROM requests WHERE release_id=? AND operation!='status' ORDER BY rowid DESC LIMIT 1",
                              (release_id,)).fetchone()
            return {'releaseId': release_id, 'state': row['state'], 'lastOperation': dict(last)}


def archive_name(request_id):
    require(re.fullmatch('[0-9a-f]{32}', request_id), 'invalid_id')
    return 'artifact-' + request_id + '.tar'


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.watchdog = threading.Timer(MAX_REQUEST_SECONDS, self.expire_connection)
        self.watchdog.daemon = True
        self.watchdog.start()

    def expire_connection(self):
        with contextlib.suppress(OSError):
            self.connection.shutdown(socket.SHUT_RDWR)

    def finish(self):
        try:
            super().finish()
        finally:
            self.watchdog.cancel()

    def log_message(self, *_):
        pass  # Never log signatures, envelopes or arbitrary client text.

    def answer(self, status, value):
        data = canonical(value)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        config = self.server.config
        request_id = None
        try:
            operation = {'/v1/upload': 'upload', '/v1/status': 'status', '/v1/activate': 'activate'}.get(self.path)
            require(operation is not None, 'unknown_route', 404)
            require(self.headers.get('Transfer-Encoding') is None and self.headers.get('Content-Encoding') is None,
                    'unsupported_encoding')
            for key in ('Content-Length', 'X-FKSSJ-Envelope', 'X-FKSSJ-Signature'):
                require(len(self.headers.get_all(key, [])) == 1, 'auth_failed', 401)
            header = self.headers['X-FKSSJ-Envelope']
            require(len(header) <= 4096, 'envelope_limit', 413)
            try:
                raw = base64.b64decode(header, validate=True)
            except (ValueError, TypeError):
                raise ChannelError('auth_failed', 401) from None
            value = verify(raw, self.headers['X-FKSSJ-Signature'], config, operation)
            length = self.headers['Content-Length']
            require(re.fullmatch('0|[1-9][0-9]{0,8}', length), 'invalid_length')
            length = int(length)
            require(length == (value['artifactBytes'] if operation == 'upload' else 0), 'length_mismatch')
            require(self.headers.get('Content-Type') == 'application/octet-stream' if operation == 'upload'
                    else self.headers.get('Content-Type') in (None, 'application/octet-stream'), 'content_type')
            store = Store(config, existing_only=self.server.existing_only)
            store.reserve(value, raw, self.headers['X-FKSSJ-Signature'])
            if operation == 'upload':
                request_id = value['requestId']
                self.connection.settimeout(15)
                deadline = time.monotonic() + 30
                with release.directory(config.state) as fd:
                    out = os.open(archive_name(request_id), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o660, dir_fd=fd)
                    with os.fdopen(out, 'wb') as artifact:
                        hasher = hashlib.sha256()
                        remaining = length
                        while remaining:
                            wait = deadline - time.monotonic()
                            require(wait > 0, 'upload_timeout')
                            self.connection.settimeout(min(15, wait))
                            chunk = self.rfile.read1(min(65536, remaining))
                            require(time.monotonic() <= deadline, 'upload_timeout')
                            require(chunk, 'truncated_upload')
                            artifact.write(chunk)
                            hasher.update(chunk)
                            remaining -= len(chunk)
                        artifact.flush()
                        os.fsync(artifact.fileno())
                    os.fsync(fd)
                require(hmac.compare_digest(hasher.hexdigest(), value['artifactSha256']), 'artifact_mismatch')
                require(time.monotonic() <= deadline, 'upload_timeout')
                fresh(value, config)
                store.finish(request_id, 'queued', release_state='received')
                self.answer(202, {'requestId': request_id, 'releaseId': value['releaseId'], 'state': 'received'})
            elif operation == 'activate':
                self.answer(202, {'requestId': value['requestId'], 'releaseId': value['releaseId'], 'state': 'activation_queued'})
            else:
                self.answer(200, store.status(value['releaseId']))
        except ChannelError as exc:
            if request_id:
                Store(config, existing_only=self.server.existing_only).finish(request_id, 'rejected', exc.code, 'rejected')
            self.answer(exc.status, {'error': exc.code})
        except (OSError, sqlite3.Error, release.ReleaseError):
            # A storage/connection error can follow a durable reservation or ACK.
            # Leave evidence; never reinterpret it as safe to retry a mutation.
            self.answer(503, {'error': 'outcome_unknown', 'inspectStatus': True})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, config, *, existing_only=False):
        self.config = config
        self.existing_only = existing_only
        self.slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        super().__init__(address, Handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(15)
        return connection, address

    def handle_error(self, request, client_address):
        # Do not dump arbitrary client text or headers through exception logging.
        print('{"error":"http_connection_closed"}', file=sys.stderr)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


def make_server(config, host='127.0.0.1', port=0, *, existing_only=False):
    require(host == '127.0.0.1', 'loopback_only')
    require(isinstance(config.key, bytes) and len(config.key) == 32, 'invalid_key')
    Store(config, existing_only=existing_only)
    return Server((host, port), config, existing_only=existing_only)


def unpack(data, destination, manifest_sha256):
    allowed = release.FILES | {'release.json'}
    directories = {str(parent) for name in allowed for parent in Path(name).parents if str(parent) != '.'}
    seen, total = set(), 0
    try:
        with release.directory(destination) as destination_fd, tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
            for count, member in enumerate(archive, 1):
                require(count <= MAX_MEMBERS and len(member.name) <= 256, 'archive_limit')
                require(not member.pax_headers and not member.sparse, 'archive_extensions')
                name = member.name
                require(name not in seen and name not in ('', '.', '..'), 'archive_duplicate')
                seen.add(name)
                require((member.isfile() and name in allowed) or (member.isdir() and name in directories), 'archive_member')
                require(not member.islnk() and not member.issym(), 'archive_link')
                if member.isdir():
                    continue
                total += member.size
                require(0 <= member.size <= release.MAX_FILE and total <= MAX_EXTRACTED_BYTES, 'archive_limit')
                payload = archive.extractfile(member)
                require(payload is not None, 'archive_truncated')
                content = payload.read(member.size + 1)
                require(len(content) == member.size, 'archive_truncated')
                parts = name.split('/')
                parent_fd = os.dup(destination_fd)
                try:
                    for part in parts[:-1]:
                        try:
                            os.mkdir(part, 0o770, dir_fd=parent_fd)
                        except FileExistsError:
                            pass
                        child_fd = os.open(part, release.DIR_FLAGS, dir_fd=parent_fd)
                        os.close(parent_fd)
                        parent_fd = child_fd
                    release.write_new(parent_fd, parts[-1], content)
                finally:
                    os.close(parent_fd)
            require(not any(data[archive.offset:]), 'archive_trailing_data')
        require(allowed <= seen, 'archive_missing')
        release.check(destination, manifest_sha256, 'checked-fixture', 'releases/checked')
    except (tarfile.TarError, EOFError, OSError, release.ReleaseError):
        raise ChannelError('invalid_archive') from None


def worker_once(config, *, stage_only=False, coordinator=None):
    require(type(stage_only) is bool, 'invalid_worker_mode')
    require(not stage_only or coordinator is None, 'invalid_worker_mode')
    store = Store(config, existing_only=stage_only or coordinator is not None)
    with release.directory(config.state) as fd:
        lock = os.open('publisher.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o660, dir_fd=fd)
        try:
            info = os.fstat(lock)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe_lock')
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return False
            with store.transaction() as db:
                require(db.execute("SELECT 1 FROM requests WHERE state IN ('processing','uncertain')").fetchone() is None,
                        'pending_manual_review', 409)
                if stage_only:
                    # This installed entry point may never consume activation,
                    # even if a valid API receipt is configured later. Claim at
                    # most one exclusive upload in the same write transaction.
                    queued = db.execute("SELECT operation FROM requests WHERE state='queued'").fetchall()
                    require(len(queued) <= 1, 'stage_only_queue_not_exclusive', 409)
                    require(all(item['operation'] == 'upload' for item in queued),
                            'stage_only_queue_not_upload', 409)
                row = db.execute("SELECT * FROM requests WHERE state='queued' ORDER BY rowid LIMIT 1").fetchone()
                if row is None:
                    return False
                db.execute("UPDATE requests SET state='processing' WHERE request_id=?", (row['request_id'],))
            try:
                value = verify(bytes(row['envelope']), row['signature'], config)
                require(value['operation'] == row['operation'], 'job_operation_mismatch')
                require(not stage_only or value['operation'] == 'upload',
                        'stage_only_activation_forbidden')
                if value['operation'] == 'upload':
                    data = release.read_file(fd, archive_name(value['requestId']), MAX_ARTIFACT_BYTES)
                    require(len(data) == value['artifactBytes'] and release.digest(data) == value['artifactSha256'], 'artifact_mismatch')
                    name = 'unpack-' + value['requestId']
                    # Never remove a pre-existing directory left by another attempt.
                    os.mkdir(name, 0o770, dir_fd=fd)
                    source = config.state / name
                    unpack(data, source, value['manifestSha256'])
                    fresh(value, config)
                    # Shared queue files use 0007; public static bytes must use
                    # 0755/0644 without granting the web server a release group.
                    previous = os.umask(0o022)
                    try:
                        release.stage(source, value['manifestSha256'], value['releaseId'], value['expectedCurrent'], root=config.root)
                    finally:
                        os.umask(previous)
                    store.finish(value['requestId'], 'completed', release_state='staged')
                else:
                    require(value['operation'] == 'activate', 'invalid_job')
                    if coordinator is not None:
                        # No receipt, QA verdict, paths or executable code is
                        # accepted from the signed request. The fixed local
                        # coordinator owns the independent gates and budget.
                        try:
                            result = coordinator.activate(value)
                            require(isinstance(result, dict) and result.get('state') == 'activated_verified',
                                    'publisher_outcome_unconfirmed')
                            with release.directory(config.root) as root_fd:
                                require(release.current(root_fd) == 'releases/' + value['releaseId'],
                                        'publisher_outcome_unconfirmed')
                        except BaseException as error:
                            error_type = getattr(coordinator, 'error_type', ())
                            known = isinstance(error_type, type) and isinstance(error, error_type)
                            safe_rejection = known and not error.attempted and not error.uncertain
                            store.finish(value['requestId'], 'rejected' if safe_rejection else 'uncertain',
                                         'publisher_gate' if safe_rejection else 'manual_review',
                                         None if safe_rejection else 'uncertain')
                            return True
                        store.finish(value['requestId'], 'completed', release_state='activated')
                        return True
                    require(all((config.receipt_path, config.receipt_sha256, config.api_sha256, config.api_init_sha256)), 'api_gate')
                    def activation_clock():
                        fresh(value, config)
                        import datetime as dt
                        return dt.datetime.fromtimestamp(config.clock(), dt.timezone.utc)
                    # Classify missing/invalid API evidence before any mutation.
                    # An OSError escaping activate itself can occur AFTER a switch
                    # (e.g. closing its lock), so it must remain uncertain.
                    try:
                        receipt = release.acceptance(config.receipt_path, config.receipt_sha256,
                                                     value['manifestSha256'], config.api_sha256,
                                                     config.api_init_sha256, activation_clock())
                        with release.directory(config.root) as root_fd:
                            release.backend(root_fd, receipt, config.api_sha256, config.api_init_sha256)
                    except (release.ReleaseError, OSError):
                        raise ChannelError('api_gate') from None
                    try:
                        release.activate(value['releaseId'], value['manifestSha256'], value['expectedCurrent'],
                                         config.receipt_path, config.receipt_sha256, config.api_sha256,
                                         config.api_init_sha256, root=config.root, now=activation_clock)
                    except release.Uncertain:
                        raise
                    except release.ReleaseError:
                        raise ChannelError('api_gate') from None
                    store.finish(value['requestId'], 'completed', release_state='activated')
            except release.Uncertain:
                store.finish(row['request_id'], 'uncertain', 'manual_review', 'uncertain')
            except ChannelError as exc:
                store.finish(row['request_id'], 'rejected', exc.code,
                             'rejected' if row['operation'] == 'upload' else None)
            except (OSError, sqlite3.Error, release.ReleaseError):
                # E.g. durable stage/activation succeeded but ledger commit failed.
                # Processing remains a permanent gate if even this write fails.
                store.finish(row['request_id'], 'uncertain', 'manual_review', 'uncertain')
            return True
        finally:
            os.close(lock)


def load_config():
    def trusted(path, limit, secret=False):
        with release.directory(Path(path).parent) as fd:
            parent = os.fstat(fd)
            require(parent.st_uid == 0 and not parent.st_mode & 0o022, 'untrusted_config_directory')
            source = os.open(Path(path).name, release.FILE_FLAGS, dir_fd=fd)
            try:
                info = os.fstat(source)
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit
                        and info.st_uid == 0 and not info.st_mode & 0o022, 'untrusted_config')
                require(not secret or not info.st_mode & 0o007, 'world_readable_key')
                data = bytearray()
                while len(data) <= limit:
                    chunk = os.read(source, limit + 1 - len(data))
                    if not chunk:
                        break
                    data.extend(chunk)
                after = os.fstat(source)
                require(len(data) <= limit and all(getattr(info, key) == getattr(after, key)
                        for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')),
                        'config_changed')
                return bytes(data)
            finally:
                os.close(source)
    key = trusted('/etc/fkssj-release/hmac.key', 32, secret=True)
    require(len(key) == 32, 'invalid_key')
    value = release.strict_json(trusted('/etc/fkssj-release/config.json', 4096))
    require(isinstance(value, dict) and set(value) <= {'apiReceiptSha256', 'apiAppSha256', 'apiInitSha256'}, 'invalid_config')
    return Config(Path('/var/lib/fkssj-release'), Path('/srv/fkssj'), key,
                  Path('/etc/fkssj-release/api-acceptance.json'), value.get('apiReceiptSha256'),
                  value.get('apiAppSha256'), value.get('apiInitSha256'))


def main():
    arguments = sys.argv[1:]
    rollback = (len(arguments) == 2 and arguments[0] == 'rollback-static'
                and re.fullmatch('[0-9a-f]{32}', arguments[1]))
    require(arguments in (['receiver'], ['worker'], ['stage-worker'], ['publish-worker']) or rollback,
            'usage_receiver_worker_stage_worker_publish_worker_or_rollback_static')
    os.umask(0o007)
    coordinator = None
    if sys.argv[1] == 'publish-worker' or rollback:
        require(os.geteuid() == 0, 'publisher_requires_root')
        spec = importlib.util.spec_from_file_location('fixed_publisher_pipeline', Path(__file__).with_name('publisher_pipeline.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        policy = module.Coordinator.load_policy()
        # The disabled policy is a total publisher switch, including staging.
        # Check it before loading a key or claiming any queue entry.
        require(rollback or policy.get('enabled') is True, 'publisher_disabled')
        coordinator = module.Coordinator(policy, release_module=release)
        if rollback:
            # Administrator-only, release-bound recovery. This branch does not
            # load a HMAC key, create accounts, reset a budget or expose HTTP.
            try:
                print(json.dumps(coordinator.rollback(arguments[1])))
            except BaseException:
                print('{"state":"rollback_not_confirmed","reason":"manual_review_no_retry"}')
                raise SystemExit(1)
            return
    config = load_config()
    if sys.argv[1] == 'receiver':
        # Production never silently recreates or repairs the shared ledger.
        # The existing 0660 database and exact schema are an installation gate.
        make_server(config, port=8790, existing_only=True).serve_forever()
    else:
        processed = (worker_once(config, stage_only=sys.argv[1] == 'stage-worker') if coordinator is None
                     else worker_once(config, coordinator=coordinator))
        print(json.dumps({'processed': processed}))


if __name__ == '__main__':
    try:
        main()
    except (ChannelError, release.ReleaseError, OSError, sqlite3.Error):
        print('{"error":"stopped_inspect_locally"}', file=sys.stderr)
        sys.exit(1)

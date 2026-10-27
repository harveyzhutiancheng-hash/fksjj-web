#!/usr/bin/env python3
"""Pinned, offline first API installation; never changes static current/Nginx.

Loaded by a separately pinned RAM bootstrap. No download, passwords, shell,
database repair or automatic retry. A partial attempt is retained for review.
"""
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess

NAME = 'fkssj-api'
ROOT = '/opt/fkssj-api'
DATA = '/var/lib/fkssj'
BACKUP = '/var/backups/fkssj-api'
UNIT = '/etc/systemd/system/fkssj-api.service'
VERSIONS = '/srv/fkssj/api-releases'
LINK = '/srv/fkssj/api-current'
CURRENT = 'releases/fkssj-0.13.0-20261020T071030Z'
WHEEL = 'wheels/gunicorn-26.2.0-py3-none-any.whl'
WHEEL_SHA = 'bd249d0b3f7972f7432f0a6b6ff3b3ee2d129f70cd1ff6c09a9dd9e29a2b88e3'
CODE_KEYS = ('api/app.py', 'api/__init__.py', 'api/preview.py')
KEYS = frozenset((*CODE_KEYS, 'requirements.txt', WHEEL))
PROPS = ('Id', 'LoadState', 'ActiveState', 'SubState', 'FragmentPath', 'DropInPaths',
         'UnitFileState', 'User', 'Group', 'NeedDaemonReload', 'ExecStart')
EXEC_ARGV = '/opt/fkssj-api/venv/bin/gunicorn --bind 127.0.0.1:8787 --workers 2 --worker-class sync --timeout 30 --error-logfile - api.preview:create_app()'
UNIT_BYTES = b'''[Unit]
Description=FKSSJ account and cloud save API
After=network.target

[Service]
Type=simple
User=fkssj-api
Group=fkssj-api
WorkingDirectory=/srv/fkssj/api-current
Environment=FKSSJ_DATA_DIR=/var/lib/fkssj
Environment=FKSSJ_WEB_ROOT=/srv/fkssj/current
Environment=FKSSJ_PUBLIC_ORIGIN=https://fkssj.harvey-ai.xyz
Environment=FKSSJ_TRUSTED_PROXIES=127.0.0.1,::1
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/opt/fkssj-api/venv/bin/gunicorn --bind 127.0.0.1:8787 --workers 2 --worker-class sync --timeout 30 --error-logfile - api.preview:create_app()
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
ReadWritePaths=/var/lib/fkssj
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
'''
CODES = frozenset('''payload_invalid approval_mismatch root_required unsafe_parent
unsafe_file changed_file existing_target account_conflict platform_unknown
unit_conflict port_occupied insufficient_space command_failed command_unknown
account_create_unconfirmed unit_not_ready current_changed unexpected_failure'''.split())


class Failure(Exception):
    def __init__(self, code):
        super().__init__(code if code in CODES else 'unexpected_failure')


def need(value, code):
    if not value:
        raise Failure(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def stamp(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid',
                 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def unit_bytes(bindings):
    value = bindings.get('previewManifestSha256')
    need(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value), 'payload_invalid')
    return UNIT_BYTES.replace(b'Environment=PYTHONDONTWRITEBYTECODE=1\n',
            b'Environment=FKSSJ_PREVIEW_MANIFEST_SHA256=' + value.encode('ascii') + b'\nEnvironment=PYTHONDONTWRITEBYTECODE=1\n')


class Host:
    root = Path('/')

    def euid(self):
        return os.geteuid()

    def meta(self, fd):
        return os.fstat(fd)

    def owner(self, fd, uid, gid):
        need(self.root == Path('/'), 'unexpected_failure')
        os.fchown(fd, uid, gid)

    def directory(self, logical):
        need(logical.startswith('/') and '..' not in Path(logical).parts, 'unsafe_parent')
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        current = ''
        try:
            need(self.meta(fd).st_uid == 0, 'unsafe_parent')
            for part in Path(logical).parts[1:]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                os.close(fd)
                fd = child
                current += '/' + part
                info = self.meta(fd)
                if current in ('/srv/fkssj', '/srv/fkssj/releases', '/srv/fkssj/' + CURRENT):
                    need((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (1001, 1001, 0o755), 'unsafe_parent')
                else:
                    need(info.st_uid == 0 and not stat.S_IMODE(info.st_mode) & 0o022, 'unsafe_parent')
            return fd
        except BaseException:
            os.close(fd)
            raise

    def metadata(self, logical):
        parent = self.directory(str(Path(logical).parent))
        try:
            try:
                return os.stat(Path(logical).name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                return None
        finally:
            os.close(parent)

    def identities(self):
        try:
            user = pwd.getpwnam(NAME)
        except KeyError:
            user = None
        try:
            group = grp.getgrnam(NAME)
        except KeyError:
            group = None
        return user, group

    def read(self, logical, maximum=1024 * 1024):
        parent = self.directory(str(Path(logical).parent))
        try:
            fd = os.open(Path(logical).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
            try:
                before = self.meta(fd)
                need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                     before.st_uid == 0 and not stat.S_IMODE(before.st_mode) & 0o022
                     and 0 < before.st_size <= maximum, 'unsafe_file')
                data = bytearray()
                while len(data) <= maximum:
                    chunk = os.read(fd, min(65536, maximum + 1 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                need(len(data) == before.st_size and stamp(before) == stamp(self.meta(fd)), 'changed_file')
                named = os.stat(Path(logical).name, dir_fd=parent, follow_symlinks=False)
                need((named.st_dev, named.st_ino) == (before.st_dev, before.st_ino), 'changed_file')
                return bytes(data)
            finally:
                os.close(fd)
        finally:
            os.close(parent)

    def current(self):
        fd = self.directory('/srv/fkssj')
        try:
            before = os.stat('current', dir_fd=fd, follow_symlinks=False)
            need(stat.S_ISLNK(before.st_mode) and (before.st_uid, before.st_gid) == (1001, 1001)
                 and os.readlink('current', dir_fd=fd) == CURRENT, 'current_changed')
            need(stamp(before) == stamp(os.stat('current', dir_fd=fd, follow_symlinks=False)), 'current_changed')
            old = self.directory('/srv/fkssj/' + CURRENT)
            os.close(old)
            return stamp(before)
        finally:
            os.close(fd)

    def api_link(self, expected):
        fd = self.directory('/srv/fkssj')
        try:
            before = os.stat('api-current', dir_fd=fd, follow_symlinks=False)
            need(stat.S_ISLNK(before.st_mode) and before.st_uid == 0
                 and os.readlink('api-current', dir_fd=fd) == expected, 'changed_file')
            need(stamp(before) == stamp(os.stat('api-current', dir_fd=fd, follow_symlinks=False)), 'changed_file')
        finally:
            os.close(fd)

    def run(self, argv, timeout=30):
        need(self.root == Path('/'), 'unexpected_failure')
        try:
            reply = subprocess.run(argv, capture_output=True, timeout=timeout, check=False,
                    env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'HOME': '/root',
                         'PIP_CONFIG_FILE': '/dev/null', 'PYTHONNOUSERSITE': '1'})
            return {'state': 'finished', 'returncode': reply.returncode, 'stdout': reply.stdout}
        except subprocess.TimeoutExpired:
            return {'state': 'unknown', 'returncode': None, 'stdout': b''}
        except OSError:
            return {'state': 'not_started', 'returncode': None, 'stdout': b''}

    def show(self):
        reply = self.run(['/usr/bin/systemctl', 'show', NAME + '.service', '--no-pager', '--property=' + ','.join(PROPS)])
        need(reply['state'] == 'finished' and reply['returncode'] in (0, 1) and len(reply['stdout']) <= 8192, 'unit_conflict')
        result = {}
        for line in reply['stdout'].decode('utf-8', 'strict').splitlines():
            key, sep, value = line.partition('=')
            need(sep and key in PROPS and key not in result, 'unit_conflict')
            result[key] = value
        return result

    def platform(self):
        system = dict(line.split('=', 1) for line in self.read('/usr/lib/os-release', 16384).decode('utf-8', 'strict').splitlines()
                      if line.startswith(('ID=', 'VERSION_ID=')))
        need(system.get('ID', '').strip('"') == 'ubuntu' and system.get('VERSION_ID', '').strip('"') == '24.04', 'platform_unknown')
        reply = self.run(['/usr/bin/python3', '-I', '-B', '-c', 'import sys,venv,ensurepip; print("%d.%d" % sys.version_info[:2])'])
        need(reply['state'] == 'finished' and reply['returncode'] == 0 and reply['stdout'].strip() == b'3.12', 'platform_unknown')
        reply = self.run(['/usr/bin/systemctl', '--version'])
        need(reply['state'] == 'finished' and reply['returncode'] == 0
             and re.match(rb'systemd 255(?:\s|$)', reply['stdout']), 'platform_unknown')
        reply = self.run(['/usr/bin/ss', '-H', '-ltn', 'sport = :8787'])
        need(reply['state'] == 'finished' and reply['returncode'] == 0 and not reply['stdout'].strip(), 'port_occupied')
        for path in ('/opt', '/var/lib', '/srv/fkssj'):
            fd = self.directory(path)
            try:
                space = os.fstatvfs(fd)
                need(space.f_bavail * space.f_frsize >= 128 * 1024 * 1024, 'insufficient_space')
            finally:
                os.close(fd)


class Engine:
    def __init__(self, host, payload, bindings):
        self.h, self.payload, self.bindings = host, payload, bindings
        need(isinstance(payload, dict) and set(payload) == KEYS
             and all(isinstance(v, bytes) and 0 < len(v) <= 1024 * 1024 for v in payload.values()), 'payload_invalid')
        need(isinstance(bindings, dict) and set(bindings) == {'apiVersionId', 'previewManifestSha256', 'files'}, 'payload_invalid')
        expected = {k: {'sha256': digest(v), 'bytes': len(v)} for k, v in payload.items()}
        code = {name: digest(payload[name]) for name in CODE_KEYS}
        need(bindings['files'] == expected and bindings['apiVersionId'] == 'fkssj-api-' + digest(canonical(code))[:16], 'payload_invalid')
        need(digest(payload[WHEEL]) == WHEEL_SHA, 'payload_invalid')
        lines = ' '.join(payload['requirements.txt'].decode('utf-8', 'strict').replace('\\\n', ' ').splitlines())
        need(re.fullmatch(r'\s*gunicorn==26\.2\.0\s+--hash=sha256:' + WHEEL_SHA + r'\s*', lines), 'payload_invalid')
        self.version = VERSIONS + '/' + bindings['apiVersionId']
        self.unit_bytes = unit_bytes(bindings)
        self.manifest_sha256 = digest(canonical(bindings))
        self.journal = None

    def plan(self):
        need(self.h.euid() == 0, 'root_required')
        self.h.platform()
        self.h.current()
        need(self.h.identities() == (None, None), 'account_conflict')
        for path in (ROOT, DATA, BACKUP, VERSIONS, LINK, UNIT):
            need(self.h.metadata(path) is None, 'existing_target')
        for prefix in ('/etc/systemd/system/', '/run/systemd/system/', '/usr/lib/systemd/system/'):
            need(self.h.metadata(prefix + NAME + '.service.d') is None, 'unit_conflict')
        show = self.h.show()
        need(show.get('LoadState') == 'not-found' and show.get('ActiveState') == 'inactive'
             and show.get('SubState') == 'dead' and not show.get('FragmentPath')
             and not show.get('DropInPaths') and show.get('UnitFileState', '') in ('', 'not-found'), 'unit_conflict')
        return {'state': 'api_install_plan_ready', 'manifestSha256': self.manifest_sha256,
                'apiVersionId': self.bindings['apiVersionId'], 'apiAppSha256': digest(self.payload['api/app.py']),
                'apiInitSha256': digest(self.payload['api/__init__.py']), 'apiPreviewSha256': digest(self.payload['api/preview.py']),
                'unitSha256': digest(self.unit_bytes), 'previewManifestSha256': self.bindings['previewManifestSha256'], 'dataDirectory': DATA,
                'backupDirectory': BACKUP, 'listen': '127.0.0.1:8787', 'staticCurrentChangedByInstaller': False}

    def command(self, argv, timeout=30):
        reply = self.h.run(argv, timeout=timeout)
        need(reply['state'] == 'finished', 'command_unknown')
        need(reply['returncode'] == 0, 'command_failed')
        return reply

    def verified_unit(self, *, enabled, active):
        value = self.h.show()
        # systemd255's selected-property serialization includes transient PID/
        # timestamp metadata. Pin the executable and entire argv, one command,
        # and ignore_errors=no; never accept merely an executable substring.
        execution = value.get('ExecStart', '')
        prefix = '{ path=/opt/fkssj-api/venv/bin/gunicorn ; argv[]=' + EXEC_ARGV + ' ; ignore_errors=no ;'
        exact = (execution.startswith(prefix) and execution.endswith(' }')
                 and execution.count('{') == execution.count('}') == 1
                 and execution.count('argv[]=') == execution.count('path=') == 1)
        need(value.get('LoadState') == 'loaded' and value.get('FragmentPath') == UNIT
             and not value.get('DropInPaths') and value.get('NeedDaemonReload') == 'no'
             and value.get('User') == NAME and value.get('Group') == NAME and exact
             and value.get('UnitFileState') == ('enabled' if enabled else 'disabled')
             and value.get('ActiveState') == ('active' if active else 'inactive')
             and value.get('SubState') == ('running' if active else 'dead'), 'unit_not_ready')
        need(self.h.read(UNIT) == self.unit_bytes, 'changed_file')
        self.h.api_link('api-releases/' + self.bindings['apiVersionId'])

    def mkdir(self, path, uid=0, gid=0, mode=0o755):
        fd = self.h.directory(str(Path(path).parent))
        try:
            os.mkdir(Path(path).name, 0o700, dir_fd=fd)
            created = os.open(Path(path).name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try:
                self.h.owner(created, uid, gid)
                os.fchmod(created, mode)
                info = self.h.meta(created)
                need((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (uid, gid, mode), 'unsafe_parent')
                named = os.stat(Path(path).name, dir_fd=fd, follow_symlinks=False)
                need((named.st_dev, named.st_ino) == (info.st_dev, info.st_ino), 'changed_file')
                os.fsync(created)
            finally:
                os.close(created)
            os.fsync(fd)
        finally:
            os.close(fd)

    def file(self, path, data, mode=0o644):
        parent = self.h.directory(str(Path(path).parent))
        try:
            fd = os.open(Path(path).name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
            try:
                self.h.owner(fd, 0, 0)
                os.fchmod(fd, mode)
                remaining = memoryview(data)
                while remaining:
                    count = os.write(fd, remaining)
                    need(count > 0, 'unexpected_failure')
                    remaining = remaining[count:]
                os.fsync(fd)
                info = self.h.meta(fd)
                need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == len(data)
                     and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (0, 0, mode)
                     and os.pread(fd, len(data), 0) == data, 'unsafe_file')
                named = os.stat(Path(path).name, dir_fd=parent, follow_symlinks=False)
                need((named.st_dev, named.st_ino) == (info.st_dev, info.st_ino), 'changed_file')
            finally:
                os.close(fd)
            os.fsync(parent)
        finally:
            os.close(parent)

    def event(self, phase):
        fd = os.open('install-journal.jsonl', os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.journal)
        try:
            data = canonical({'phase': phase})
            need(os.write(fd, data) == len(data), 'unexpected_failure')
            os.fsync(fd)
        finally:
            os.close(fd)

    def install(self, approved_manifest_sha256):
        result = {'state': 'stopped_no_changes', 'reason': None, 'manifestSha256': self.manifest_sha256,
                  'backupDirectory': BACKUP, 'staticCurrentChangedByInstaller': False,
                  'nginxChangedByInstaller': False, 'publicApiVerified': False,
                  'daemonReloadAttempted': False, 'enableAttempted': False, 'startAttempted': False}
        mutation = False
        try:
            need(approved_manifest_sha256 == self.manifest_sha256, 'approval_mismatch')
            self.plan()
            before = self.h.current()
            mutation = True
            self.mkdir(BACKUP, mode=0o700)
            self.file(BACKUP + '/install-bindings.json', canonical(self.bindings), mode=0o600)
            self.file(BACKUP + '/install-journal.jsonl', b'{"phase":"attempt_started"}\n', mode=0o600)
            self.journal = self.h.directory(BACKUP)
            self.command(['/usr/sbin/groupadd', '--system', NAME])
            self.command(['/usr/sbin/useradd', '--system', '--gid', NAME, '--home-dir', '/nonexistent',
                          '--no-create-home', '--shell', '/usr/sbin/nologin', NAME])
            user, group = self.h.identities()
            need(user is not None and group is not None and user.pw_gid == group.gr_gid
                 and user.pw_uid not in (0, 995, 1001) and group.gr_gid not in (0, 986, 1001)
                 and user.pw_shell == '/usr/sbin/nologin' and user.pw_dir == '/nonexistent'
                 and not group.gr_mem, 'account_create_unconfirmed')
            result.update(serviceUid=user.pw_uid, serviceGid=group.gr_gid)
            self.event('service_identity_created')
            self.mkdir(ROOT)
            self.mkdir(ROOT + '/wheels')
            self.file(ROOT + '/requirements.txt', self.payload['requirements.txt'])
            self.file(ROOT + '/' + WHEEL, self.payload[WHEEL])
            self.mkdir(VERSIONS)
            self.mkdir(self.version)
            self.mkdir(self.version + '/api')
            for name in CODE_KEYS:
                self.file(self.version + '/' + name, self.payload[name])
            self.mkdir(DATA, user.pw_uid, group.gr_gid, 0o700)
            self.event('exclusive_paths_created')
            old_umask = os.umask(0o022)
            try:
                self.command(['/usr/bin/python3', '-I', '-B', '-m', 'venv', '--copies', ROOT + '/venv'], timeout=60)
                self.command([ROOT + '/venv/bin/python3', '-I', '-B', '-m', 'pip', 'install', '--disable-pip-version-check',
                              '--no-index', '--only-binary=:all:', '--require-hashes', '--find-links', ROOT + '/wheels',
                              '-r', ROOT + '/requirements.txt'], timeout=60)
                self.command([ROOT + '/venv/bin/python3', '-I', '-B', '-c',
                              'import importlib.metadata; assert importlib.metadata.version("gunicorn")=="26.2.0"'])
            finally:
                os.umask(old_umask)
            self.event('offline_dependency_verified')
            parent = self.h.directory('/srv/fkssj')
            try:
                os.symlink('api-releases/' + self.bindings['apiVersionId'], 'api-current', dir_fd=parent)
                os.fsync(parent)
            finally:
                os.close(parent)
            self.h.api_link('api-releases/' + self.bindings['apiVersionId'])
            self.file(UNIT, self.unit_bytes)
            for name in CODE_KEYS:
                need(self.h.read(self.version + '/' + name) == self.payload[name], 'changed_file')
            need(self.h.read(UNIT) == self.unit_bytes, 'changed_file')
            self.event('unit_and_relative_link_created')
            need(self.h.current() == before, 'current_changed')
            result['daemonReloadAttempted'] = True
            self.command(['/usr/bin/systemctl', 'daemon-reload'])
            self.verified_unit(enabled=False, active=False)
            result['enableAttempted'] = True
            self.command(['/usr/bin/systemctl', 'enable', NAME + '.service'])
            self.verified_unit(enabled=True, active=False)
            self.event('api_start_pending')
            result['startAttempted'] = True
            self.command(['/usr/bin/systemctl', 'start', NAME + '.service'])
            self.verified_unit(enabled=True, active=True)
            need(self.h.current() == before, 'current_changed')
            self.h.api_link('api-releases/' + self.bindings['apiVersionId'])
            need(self.h.read(UNIT) == self.unit_bytes, 'changed_file')
            for name in CODE_KEYS:
                need(self.h.read(self.version + '/' + name) == self.payload[name], 'changed_file')
            self.event('api_started_not_publicly_accepted')
            result.update(state='api_installed_started_not_publicly_accepted', apiVersionId=self.bindings['apiVersionId'],
                          apiAppSha256=digest(self.payload['api/app.py']), apiInitSha256=digest(self.payload['api/__init__.py']),
                          apiPreviewSha256=digest(self.payload['api/preview.py']), unitSha256=digest(self.unit_bytes),
                          previewManifestSha256=self.bindings['previewManifestSha256'],
                          currentUnchanged=True)
        except BaseException as error:
            result.update(state='partial_retained_inspect_no_retry' if mutation else 'stopped_no_changes',
                          reason=str(error) if isinstance(error, Failure) else 'unexpected_failure')
            if self.journal is not None:
                try:
                    self.event('stopped_retain_all_inspect')
                except BaseException:
                    pass
        finally:
            if self.journal is not None:
                os.close(self.journal)
                self.journal = None
        return result


if __name__ == '__main__':
    print('{"state":"stopped_no_changes","reason":"pinned_bootstrap_required"}')
    raise SystemExit(1)

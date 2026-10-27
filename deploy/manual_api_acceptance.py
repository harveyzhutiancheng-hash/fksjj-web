#!/usr/bin/env python3
"""Fixed-site HTTP acceptance using at most two private synthetic accounts.

No CLI endpoint, key, credential, receipt-file or database options are exposed.
The pinned manual installer calls run_acceptance and durably saves its receipt
only after success. Production TLS and Secure cookies are never weakened.
Browser acceptance is a separate gate; these requests are not browser tests.
"""
import datetime as dt
from dataclasses import dataclass, field
import hashlib
from http.cookiejar import CookieJar
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import stat
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import (build_opener, HTTPCookieProcessor, HTTPRedirectHandler,
                            HTTPSHandler, Request)

ORIGIN = 'https://fkssj.harvey-ai.xyz'
COOKIE = '__Host-fkssj_session'
ROUTES = frozenset(('/api/health', '/api/auth/me', '/api/auth/register', '/api/auth/login', '/api/save'))
CHECKS = frozenset('''health auth_register_login get_user_mismatch
no_cross_account_disclosure cas_conflict origin_csrf secure_cookie persistence
service_running proxy_route'''.split())
BINDINGS = frozenset(('manifestSha256', 'apiAppSha256', 'apiInitSha256',
                      'apiPreviewSha256', 'backendTarget', 'apiUnitSha256', 'nginxConfigSha256'))
CODES = frozenset('''invalid_bindings unsafe_installed_metadata installed_binding_mismatch
service_metadata_unavailable service_not_confirmed restart_not_confirmed
https_request_failed response_unusable unexpected_response insecure_cookie
identity_isolation_failed save_mismatch conflict_check_failed origin_csrf_failed
health_unavailable acceptance_interrupted'''.split())
MISMATCH = {'code': 'user_mismatch', 'message': '当前账号已经变化，请重新载入账号存档。'}


class AcceptanceError(Exception):
    def __init__(self, code):
        self.code = code if code in CODES else 'acceptance_interrupted'
        self.summary = None
        super().__init__(self.code)


def need(value, code='unexpected_response'):
    if not value:
        raise AcceptanceError(code)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def _pairs(rows):
    result = {}
    for name, value in rows:
        if name in result:
            raise ValueError()
        result[name] = value
    return result


@dataclass(repr=False)
class Session:
    cookies: CookieJar = field(default_factory=CookieJar, repr=False)


@dataclass(repr=False)
class Response:
    status: int
    headers: tuple = field(repr=False)
    data: object = field(repr=False)

    def values(self, name):
        return [value for key, value in self.headers if key.lower() == name.lower()]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class HTTPSTransport:
    """No constructor options. Subclassing is reserved for local test fixtures."""
    def url(self, path):
        need(path in ROUTES, 'https_request_failed')
        return ORIGIN + path

    def context(self):
        return ssl.create_default_context()

    def request(self, method, path, session, body=None, headers=None):
        need(method in ('GET', 'POST', 'PUT') and path in ROUTES, 'https_request_failed')
        encoded = None if body is None else canonical(body)
        supplied = {'Accept': 'application/json'}
        if encoded is not None:
            supplied['Content-Type'] = 'application/json'
        supplied.update(headers or {})
        request = Request(self.url(path), data=encoded, headers=supplied, method=method)
        # Uses the environment's normal proxy support. No alternate proxy,
        # disabled TLS, user CA argument, redirect or retry is implemented.
        opener = build_opener(NoRedirect(), HTTPSHandler(context=self.context()),
                              HTTPCookieProcessor(session.cookies))
        try:
            try:
                reply = opener.open(request, timeout=10)
            except HTTPError as error:
                reply = error
            with reply:
                raw = reply.read(65537)
                need(len(raw) <= 65536, 'response_unusable')
                result = Response(reply.status, tuple(reply.headers.items()),
                    json.loads(raw.decode('utf-8'), object_pairs_hook=_pairs,
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError())))
                need(isinstance(result.data, dict), 'response_unusable')
                return result
        except AcceptanceError:
            raise
        except BaseException:
            raise AcceptanceError('https_request_failed') from None


class Host:
    """Read only fixed program/config metadata; restart only this API once."""
    def _directory(self, absolute):
        parts = Path(absolute).parts
        need(parts[0] == '/' and '..' not in parts, 'unsafe_installed_metadata')
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        current = ''
        try:
            for name in parts[1:]:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=fd)
                os.close(fd)
                fd = child
                current += '/' + name
                info = os.fstat(fd)
                trusted_uid = (0, 1001) if current in ('/srv/fkssj', '/srv/fkssj/api-releases') else (0,)
                need(info.st_uid in trusted_uid and not stat.S_IMODE(info.st_mode) & 0o022,
                     'unsafe_installed_metadata')
            return fd
        except BaseException:
            os.close(fd)
            raise

    def _hash(self, absolute):
        parent = self._directory(str(Path(absolute).parent))
        try:
            fd = os.open(Path(absolute).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                         dir_fd=parent)
            try:
                before = os.fstat(fd)
                need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                     and before.st_uid == 0 and before.st_gid == 0
                     and stat.S_IMODE(before.st_mode) == 0o644
                     and 0 <= before.st_size <= 128 * 1024, 'unsafe_installed_metadata')
                raw = bytearray()
                while len(raw) <= 128 * 1024:
                    part = os.read(fd, 128 * 1024 + 1 - len(raw))
                    if not part:
                        break
                    raw.extend(part)
                after = os.fstat(fd)
                fields = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_nlink',
                          'st_size', 'st_mtime_ns', 'st_ctime_ns')
                need(len(raw) == before.st_size and all(getattr(before, k) == getattr(after, k) for k in fields),
                     'unsafe_installed_metadata')
                named = os.stat(Path(absolute).name, dir_fd=parent, follow_symlinks=False)
                need(all(getattr(named, k) == getattr(before, k) for k in fields), 'unsafe_installed_metadata')
                return hashlib.sha256(raw).hexdigest()
            finally:
                os.close(fd)
        finally:
            os.close(parent)

    def _show(self):
        keys = ('Id', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'FragmentPath',
                'DropInPaths', 'NeedDaemonReload', 'User', 'Group', 'ExecStart')
        try:
            result = subprocess.run(['/usr/bin/systemctl', 'show', 'fkssj-api.service', '--no-pager',
                '--property=' + ','.join(keys)], capture_output=True, timeout=5, check=False,
                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
            need(result.returncode == 0 and len(result.stdout) <= 8192, 'service_metadata_unavailable')
            values = {}
            for line in result.stdout.decode('utf-8', 'strict').splitlines():
                key, sep, value = line.partition('=')
                need(sep and key in keys and key not in values, 'service_metadata_unavailable')
                values[key] = value
            return values
        except AcceptanceError:
            raise
        except BaseException:
            raise AcceptanceError('service_metadata_unavailable') from None

    def _api_link(self, bindings):
        parent = self._directory('/srv/fkssj')
        try:
            before = os.stat('api-current', dir_fd=parent, follow_symlinks=False)
            need(stat.S_ISLNK(before.st_mode) and before.st_uid in (0, 1001)
                 and os.readlink('api-current', dir_fd=parent) == bindings['backendTarget'],
                 'installed_binding_mismatch')
            after = os.stat('api-current', dir_fd=parent, follow_symlinks=False)
            need((before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns) ==
                 (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns), 'installed_binding_mismatch')
            return tuple(getattr(after, key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid',
                         'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))
        finally:
            os.close(parent)

    def verify(self, bindings):
        link = self._api_link(bindings)
        prefix = '/srv/fkssj/' + bindings['backendTarget'] + '/api/'
        for path, expected in ((prefix+'app.py', bindings['apiAppSha256']),
                               (prefix+'__init__.py', bindings['apiInitSha256']),
                               (prefix+'preview.py', bindings['apiPreviewSha256']),
                               ('/etc/systemd/system/fkssj-api.service', bindings['apiUnitSha256']),
                               ('/etc/nginx/conf.d/fkssj-domain.conf', bindings['nginxConfigSha256'])):
            need(self._hash(path) == expected, 'installed_binding_mismatch')
        unit = self._show()
        expected = {'Id': 'fkssj-api.service', 'LoadState': 'loaded', 'ActiveState': 'active',
                    'SubState': 'running', 'UnitFileState': 'enabled',
                    'FragmentPath': '/etc/systemd/system/fkssj-api.service', 'DropInPaths': '',
                    'NeedDaemonReload': 'no', 'User': 'fkssj-api', 'Group': 'fkssj-api'}
        need(all(unit.get(k) == v for k, v in expected.items())
             and '/opt/fkssj-api/venv/bin/gunicorn' in unit.get('ExecStart', '')
             and '127.0.0.1:8787' in unit.get('ExecStart', ''), 'service_not_confirmed')
        need(self._api_link(bindings) == link, 'installed_binding_mismatch')

    def restart(self):
        try:
            result = subprocess.run(['/usr/bin/systemctl', 'restart', 'fkssj-api.service'],
                capture_output=True, timeout=30, check=False,
                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
            need(result.returncode == 0, 'restart_not_confirmed')
        except AcceptanceError:
            raise
        except BaseException:
            raise AcceptanceError('restart_not_confirmed') from None

    def now(self):
        return dt.datetime.now(dt.timezone.utc)


def validate_bindings(bindings):
    need(isinstance(bindings, dict) and set(bindings) == BINDINGS, 'invalid_bindings')
    for name, value in bindings.items():
        if name == 'backendTarget':
            need(isinstance(value, str) and re.fullmatch(r'api-releases/[A-Za-z0-9][A-Za-z0-9._-]{0,95}', value)
                 and '..' not in value, 'invalid_bindings')
        else:
            need(isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value), 'invalid_bindings')


def secure_cookie(response):
    values = response.values('Set-Cookie')
    need(len(values) == 1, 'insecure_cookie')
    try:
        parsed = SimpleCookie()
        parsed.load(values[0])
        need(set(parsed) == {COOKIE}, 'insecure_cookie')
        item = parsed[COOKIE]
        need(item['secure'] and item['httponly'] and item['samesite'].lower() == 'lax'
             and item['path'] == '/' and not item['domain']
             and re.fullmatch(r'[A-Za-z0-9_-]{43}', item.value), 'insecure_cookie')
    except AcceptanceError:
        raise
    except BaseException:
        raise AcceptanceError('insecure_cookie') from None


def minimal_save(marker):
    return {'version': 1, 'savedAt': 1790000000000, 'elapsed': 0,
            'resources': {'wood': marker}, 'population': {'total': 1},
            'raft': [{'x': 0, 'z': 0}],
            'buildings': [{'id': 'command', 'type': 'command', 'x': 0, 'z': 0, 'level': 1}],
            'stats': {}, 'quests': {'claimed': []}, 'acceptanceSynthetic': True}


def run_acceptance(transport, host, bindings):
    """Mutating acceptance run. Never retries registration or returns credentials."""
    summary = {'schema': 1, 'state': 'stopped', 'phase': 'preflight',
               'accountCreationRequests': 0, 'accountsConfirmed': 0,
               'mutatingRequestsAttempted': 0, 'restartAttempted': False,
               'requestOutcomeMayBeUncertain': False, 'receiptWritten': False,
               'browserChecks': 'not_performed', 'realServerClaimsDependOnCaller': True}
    def call(method, path, session, body=None, headers=None):
        if method != 'GET':
            summary['mutatingRequestsAttempted'] += 1
        try:
            reply = transport.request(method, path, session, body, headers)
        except BaseException:
            summary['requestOutcomeMayBeUncertain'] = True
            raise AcceptanceError('https_request_failed') from None
        need(isinstance(reply, Response) and isinstance(reply.data, dict), 'response_unusable')
        need(reply.values('Cache-Control') == ['no-store']
             and reply.values('X-Content-Type-Options') == ['nosniff']
             and len(reply.values('Content-Type')) == 1
             and reply.values('Content-Type')[0].split(';', 1)[0].strip().lower() == 'application/json',
             'response_unusable')
        return reply
    def auth(session, path, credentials):
        reply = call('POST', path, session, credentials, {'Origin': ORIGIN})
        need(reply.status == 200)
        secure_cookie(reply)
        data = reply.data
        need(set(data) == {'user', 'csrfToken'} and isinstance(data['user'], dict)
             and set(data['user']) == {'id', 'username'} and type(data['user']['id']) is int
             and data['user']['id'] > 0 and data['user']['username'] == credentials['username']
             and isinstance(data['csrfToken'], str) and re.fullmatch('[0-9a-f]{64}', data['csrfToken']))
        return data['user']['id'], data['csrfToken']
    def read(session, identity):
        reply = call('GET', '/api/save', session, headers={'X-FKSSJ-User': str(identity)})
        need(reply.status == 200 and set(reply.data) == {'revision', 'save', 'updatedAt'}, 'save_mismatch')
        return reply.data
    try:
        validate_bindings(bindings)
        host.verify(bindings)
        anon = Session()
        health = call('GET', '/api/health', anon)
        need(health.status == 200 and health.data == {'ok': True}, 'health_unavailable')
        me = call('GET', '/api/auth/me', anon)
        need(me.status == 200 and me.data == {'user': None})
        sessions, credentials, identities, csrf = [Session(), Session()], [], [], []
        for index, session in enumerate(sessions):
            summary['phase'] = 'register_' + ('a' if index == 0 else 'b')
            private = {'username': 'qa_' + secrets.token_hex(8), 'password': secrets.token_urlsafe(36)}
            credentials.append(private)
            summary['accountCreationRequests'] += 1
            identity, token = auth(session, '/api/auth/register', private)
            summary['accountsConfirmed'] += 1
            identities.append(identity)
            csrf.append(token)
        need(identities[0] != identities[1], 'identity_isolation_failed')
        summary['phase'] = 'auth_and_saves'
        snapshots = [minimal_save(191), minimal_save(383)]
        for i, session in enumerate(sessions):
            identity, token = auth(session, '/api/auth/login', credentials[i])
            need(identity == identities[i], 'identity_isolation_failed')
            csrf[i] = token
            need(read(session, identity) == {'revision': 0, 'save': None, 'updatedAt': None}, 'save_mismatch')
            reply = call('PUT', '/api/save', session, {'expectedRevision': 0, 'save': snapshots[i]},
                         {'Origin': ORIGIN, 'X-FKSSJ-User': str(identity), 'X-CSRF-Token': token})
            need(reply.status == 200 and reply.data.get('revision') == 1, 'save_mismatch')
        expected = [read(sessions[i], identities[i]) for i in range(2)]
        need(all(expected[i]['revision'] == 1 and expected[i]['save'] == snapshots[i] for i in range(2)), 'save_mismatch')
        summary['phase'] = 'isolation_and_rejections'
        mismatch = call('GET', '/api/save', sessions[1], headers={'X-FKSSJ-User': str(identities[0])})
        need(mismatch.status == 403 and mismatch.data == MISMATCH, 'identity_isolation_failed')
        bad_write = call('PUT', '/api/save', sessions[1],
            {'expectedRevision': 1, 'save': minimal_save(575)},
            {'Origin': ORIGIN, 'X-FKSSJ-User': str(identities[0]), 'X-CSRF-Token': csrf[1]})
        need(bad_write.status == 403 and bad_write.data == MISMATCH, 'identity_isolation_failed')
        need(read(sessions[0], identities[0]) == expected[0] and read(sessions[1], identities[1]) == expected[1],
             'identity_isolation_failed')
        a_headers = {'Origin': ORIGIN, 'X-FKSSJ-User': str(identities[0]), 'X-CSRF-Token': csrf[0]}
        body = {'expectedRevision': 0, 'save': minimal_save(575)}
        conflict = call('PUT', '/api/save', sessions[0], body, a_headers)
        need(conflict.status == 409 and conflict.data.get('code') == 'save_conflict'
             and conflict.data.get('revision') == 1 and 'save' not in conflict.data, 'conflict_check_failed')
        body['expectedRevision'] = 1
        wrong_origin = call('PUT', '/api/save', sessions[0], body, a_headers | {'Origin': 'https://invalid.example'})
        missing_csrf = call('PUT', '/api/save', sessions[0], body,
                            {'Origin': ORIGIN, 'X-FKSSJ-User': str(identities[0])})
        need(wrong_origin.status == 403 and wrong_origin.data.get('code') == 'origin_invalid'
             and missing_csrf.status == 403 and missing_csrf.data.get('code') == 'csrf_invalid', 'origin_csrf_failed')
        need(read(sessions[0], identities[0]) == expected[0], 'save_mismatch')
        summary['phase'] = 'restart_persistence'
        summary['restartAttempted'] = True
        host.restart()
        # Only harmless health GET may be repeated during process startup.
        ready = False
        for attempt in range(10):
            try:
                health = call('GET', '/api/health', anon)
                ready = health.status == 200 and health.data == {'ok': True}
            except AcceptanceError:
                pass
            if ready:
                break
            time.sleep(0.25)
        need(ready, 'health_unavailable')
        host.verify(bindings)
        for i in range(2):
            # Session rows and the saved CSRF derivation must survive too;
            # a fresh login alone would only prove user/save persistence.
            me = call('GET', '/api/auth/me', sessions[i])
            need(me.status == 200 and me.data == {
                'user': {'id': identities[i], 'username': credentials[i]['username']},
                'csrfToken': csrf[i]} and read(sessions[i], identities[i]) == expected[i], 'save_mismatch')
            identity, token = auth(sessions[i], '/api/auth/login', credentials[i])
            need(identity == identities[i] and read(sessions[i], identity) == expected[i], 'save_mismatch')
        summary['phase'] = 'final_binding'
        host.verify(bindings)
        now = host.now()
        need(isinstance(now, dt.datetime) and now.tzinfo is not None, 'invalid_bindings')
        now = now.astimezone(dt.timezone.utc)
        receipt = {'schema': 1, 'type': 'fkssj-api-acceptance', 'origin': ORIGIN,
                   'manifestSha256': bindings['manifestSha256'], 'backendTarget': bindings['backendTarget'],
                   'apiAppSha256': bindings['apiAppSha256'], 'apiInitSha256': bindings['apiInitSha256'],
                   'checkedAt': now.isoformat().replace('+00:00', 'Z'),
                   'expiresAt': (now + dt.timedelta(minutes=15)).isoformat().replace('+00:00', 'Z'),
                   'checks': {name: True for name in sorted(CHECKS)}}
        summary.update(state='api_http_acceptance_passed', phase='complete',
                       requestOutcomeMayBeUncertain=False, checks={name: True for name in sorted(CHECKS)},
                       browserChecks='not_performed')
        return {'receipt': canonical(receipt), 'summary': summary}
    except BaseException as error:
        failure = error if isinstance(error, AcceptanceError) else AcceptanceError('acceptance_interrupted')
        if summary['accountCreationRequests'] > summary['accountsConfirmed']:
            # A 200 response with an unusable cookie/body may still have
            # committed registration. Never treat unconfirmed as not created.
            summary['requestOutcomeMayBeUncertain'] = True
        failure.summary = summary
        raise failure from None


if __name__ == '__main__':
    print('{"state":"stopped","reason":"pinned_manual_bootstrap_required","browserChecks":"not_performed"}')
    raise SystemExit(1)

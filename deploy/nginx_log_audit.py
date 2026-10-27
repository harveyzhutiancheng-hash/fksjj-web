#!/usr/bin/env python3
"""Bounded, read-only audit of ONE site's on-disk status-route logging.

This is a conservative configuration check, not nginx -t, nginx -T, a running
configuration attestation, or a general nginx parser. Unknown blocks requests.
No log, certificate, key, subprocess, network or configuration write is used.
"""
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import time
from dataclasses import dataclass

SITE = 'fkssj.harvey-ai.xyz'
ROUTE = '/_fkssj-release/v1/status'
ENDPOINT = 'https://' + SITE + ROUTE
ENTRY = '/etc/nginx/nginx.conf'
TARGET = '/etc/nginx/conf.d/fkssj-domain.conf'
TARGET_SHA256 = '779c662a0d5e97b55c8b15718a1eb13cabbb810edde554a3a5e7d23315e107a0'
MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES = 32, 65536, 512 * 1024
MAX_TOKENS, MAX_DEPTH, MAX_INCLUDES = 50000, 24, 12
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\Z')
VARIABLE = re.compile(r'\$(?:\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))')
COMBINED = frozenset('remote_addr remote_user time_local request status body_bytes_sent http_referer http_user_agent'.split())
SAFE_VARIABLES = COMBINED | frozenset('remote_port time_iso8601 bytes_sent request_length request_time connection connection_requests msec pipe gzip_ratio ssl_protocol ssl_cipher server_addr server_port request_completion upstream_addr upstream_status upstream_response_time upstream_connect_time upstream_header_time'.split())
SENSITIVE_VARIABLES = frozenset('http_x_fkssj_signature http_x_fkssj_envelope request_body request_body_file request_headers raw_request_headers http_authorization http_proxy_authorization http_cookie sent_http_set_cookie upstream_http_set_cookie'.split())
MAIN_DIRECTIVES = frozenset('user worker_processes pid error_log worker_rlimit_nofile worker_shutdown_timeout daemon master_process pcre_jit timer_resolution'.split())
HTTP_DIRECTIVES = frozenset('sendfile tcp_nopush tcp_nodelay types_hash_max_size types_hash_bucket_size server_tokens server_names_hash_bucket_size server_names_hash_max_size server_name_in_redirect default_type ssl_protocols ssl_prefer_server_ciphers access_log error_log log_format gzip gzip_vary gzip_proxied gzip_comp_level gzip_buffers gzip_http_version gzip_types gzip_min_length gzip_disable keepalive_timeout keepalive_requests client_max_body_size client_body_timeout client_header_timeout send_timeout reset_timedout_connection large_client_header_buffers client_header_buffer_size output_buffers open_file_cache open_file_cache_valid open_file_cache_min_uses open_file_cache_errors'.split())
SERVER_DIRECTIVES = HTTP_DIRECTIVES | frozenset('listen server_name ssl_certificate ssl_certificate_key ssl_session_cache ssl_session_timeout ssl_ciphers root index autoindex add_header charset etag'.split())
LOCATION_DIRECTIVES = SERVER_DIRECTIVES | frozenset('proxy_pass proxy_http_version proxy_set_header proxy_request_buffering proxy_buffering proxy_cache proxy_intercept_errors proxy_next_upstream proxy_connect_timeout proxy_send_timeout proxy_read_timeout proxy_hide_header deny allow'.split())
INTERNAL_REDIRECT = frozenset('rewrite error_page try_files return'.split())


class Unknown(Exception):
    pass


def need(value, code):
    if not value:
        raise Unknown(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def stamp(info):
    return tuple(getattr(info, name) for name in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def approved(path):
    parts = PurePosixPath(path).parts
    need(path.startswith('/') and '..' not in parts and '.' not in parts and '$' not in path,
         'include_path_not_allowed')
    if path in (ENTRY, '/etc/nginx/mime.types'):
        return
    need(len(parts) == 5 and parts[:3] == ('/', 'etc', 'nginx'), 'include_path_not_allowed')
    directory, name = parts[3:]
    need(NAME.fullmatch(name) and name not in ('.', '..'), 'include_path_not_allowed')
    need(not name.lower().startswith('hy2'), 'sensitive_site_not_read')
    need(not re.search(r'(?:secret|password|credential|private|\.key(?:\.|$))', name, re.I), 'include_path_not_allowed')
    need(directory in ('conf.d', 'snippets', 'modules-enabled', 'modules-available', 'sites-enabled', 'sites-available'), 'include_path_not_allowed')
    need(directory.startswith('sites-') or name.endswith('.conf'), 'include_path_not_allowed')


class Reader:
    def __init__(self, root, metadata):
        self.root, self.metadata = Path(root), metadata or (lambda info: info)
        self.hashes, self.records, self.cache = {}, {}, {}
        self.total = 0

    def directory(self, path):
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in PurePosixPath(path).parts[1:]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
                info = self.metadata(os.fstat(fd))
                need(info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe_config_parent')
            return fd
        except BaseException:
            os.close(fd)
            raise

    def source(self, path):
        approved(path)
        parent = self.directory(str(PurePosixPath(path).parent))
        try:
            name = PurePosixPath(path).name
            info = self.metadata(os.stat(name, dir_fd=parent, follow_symlinks=False))
            if stat.S_ISLNK(info.st_mode):
                need(PurePosixPath(path).parent == PurePosixPath('/etc/nginx/sites-enabled') and info.st_uid == 0,
                     'config_symlink_not_allowed')
                link = os.readlink(name, dir_fd=parent)
                destination = '/etc/nginx/sites-available/' + name
                need(link in ('../sites-available/' + name, destination), 'config_symlink_not_allowed')
                after = self.metadata(os.stat(name, dir_fd=parent, follow_symlinks=False))
                need(stamp(info) == stamp(after), 'config_changed')
                self.records[('link', path)] = (stamp(info), link)
                return self.source(destination)
            fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
            return fd, path
        finally:
            os.close(parent)

    def read(self, path):
        approved(path)  # Even a previously cached forbidden path is not read.
        if path in self.cache:
            return self.cache[path]
        need(len(self.hashes) < MAX_FILES, 'configuration_limit')
        fd, actual = self.source(path)
        try:
            before = self.metadata(os.fstat(fd))
            need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == 0
                 and not before.st_mode & 0o022 and 0 < before.st_size <= MAX_FILE_BYTES, 'unsafe_config_file')
            data = bytearray()
            while len(data) <= MAX_FILE_BYTES:
                chunk = os.read(fd, MAX_FILE_BYTES + 1 - len(data))
                if not chunk:
                    break
                data.extend(chunk)
            need(len(data) == before.st_size and stamp(before) == stamp(self.metadata(os.fstat(fd))), 'config_changed')
            self.total += len(data)
            need(self.total <= MAX_TOTAL_BYTES, 'configuration_limit')
            previous = self.records.get(('file', actual))
            need(previous is None or previous == stamp(before), 'config_changed')
            self.records[('file', actual)] = stamp(before)
            self.hashes[path] = digest(data)
            self.cache[path] = bytes(data)
            return bytes(data)
        finally:
            os.close(fd)

    def include(self, expression):
        expression = expression if expression.startswith('/') else '/etc/nginx/' + expression
        if not any(char in expression for char in '*?['):
            approved(expression)
            return [expression]
        directory, pattern = str(PurePosixPath(expression).parent), PurePosixPath(expression).name
        need(directory in ('/etc/nginx/conf.d', '/etc/nginx/snippets', '/etc/nginx/modules-enabled', '/etc/nginx/modules-available', '/etc/nginx/sites-enabled', '/etc/nginx/sites-available')
             and pattern in ('*.conf', '*') and (pattern != '*' or '/sites-' in directory), 'include_path_not_allowed')
        fd = self.directory(directory)
        try:
            before = self.metadata(os.fstat(fd))
            names = os.listdir(fd)
            need(len(names) <= 256, 'configuration_limit')
            paths = [directory + '/' + name for name in sorted(names) if fnmatch.fnmatchcase(name, pattern)]
            need(len(paths) <= MAX_FILES and stamp(before) == stamp(self.metadata(os.fstat(fd))), 'config_changed')
            previous = self.records.get(('directory', directory))
            need(previous is None or previous == stamp(before), 'config_changed')
            self.records[('directory', directory)] = stamp(before)
            for path in paths:
                approved(path)
            return paths
        finally:
            os.close(fd)

    def unchanged(self):
        for (kind, path), expected in self.records.items():
            if kind == 'directory':
                fd = self.directory(path)
                try:
                    need(stamp(self.metadata(os.fstat(fd))) == expected, 'config_changed')
                finally:
                    os.close(fd)
                continue
            parent = self.directory(str(PurePosixPath(path).parent))
            try:
                info = self.metadata(os.stat(PurePosixPath(path).name, dir_fd=parent, follow_symlinks=False))
                actual = (stamp(info), os.readlink(PurePosixPath(path).name, dir_fd=parent)) if kind == 'link' else stamp(info)
                need(actual == expected, 'config_changed')
            finally:
                os.close(parent)


@dataclass
class Node:
    name: str
    args: list
    children: list | None
    path: str


def tokens(data):
    text = data.decode('utf-8')
    need('\x00' not in text and all(ord(c) >= 32 or c in '\r\n\t' for c in text), 'unsupported_config_syntax')
    result, word, quoted, index = [], [], None, 0
    def emit():
        if word:
            result.append(''.join(word))
            word.clear()
    while index < len(text):
        char = text[index]
        if char == '\\':
            need(index + 1 < len(text), 'unsupported_config_syntax')
            word.append({'n': '\n', 'r': '\r', 't': '\t'}.get(text[index + 1], text[index + 1]))
            index += 2
            continue
        if quoted:
            if char == quoted:
                quoted = None
            else:
                word.append(char)
        elif char in ('"', "'"):
            quoted = char
        elif char == '#' and not word:
            end = text.find('\n', index)
            index = len(text) if end < 0 else end
            continue
        elif char.isspace():
            emit()
        elif char == '$' and text[index:index + 2] == '${':
            end = text.find('}', index + 2)
            need(end >= 0, 'unsupported_config_syntax')
            word.append(text[index:end + 1])
            index = end + 1
            continue
        elif char in '{};':
            emit()
            result.append(char)
        else:
            word.append(char)
        index += 1
    need(quoted is None, 'unsupported_config_syntax')
    emit()
    need(len(result) <= MAX_TOKENS, 'configuration_limit')
    return result


class Parser:
    def __init__(self, reader):
        self.reader, self.total_tokens = reader, 0

    def file(self, path, stack=()):
        need(path not in stack and len(stack) < MAX_INCLUDES, 'include_cycle_or_depth')
        words = tokens(self.reader.read(path))
        self.total_tokens += len(words)
        need(self.total_tokens <= MAX_TOKENS, 'configuration_limit')
        index = 0
        def block(depth=0, nested=False):
            nonlocal index
            need(depth <= MAX_DEPTH, 'configuration_limit')
            nodes = []
            while index < len(words):
                if words[index] == '}':
                    need(nested, 'unsupported_config_syntax')
                    index += 1
                    return nodes
                head = []
                while index < len(words) and words[index] not in (';', '{', '}'):
                    head.append(words[index])
                    index += 1
                need(head and index < len(words) and words[index] != '}', 'unsupported_config_syntax')
                delimiter = words[index]
                index += 1
                children = block(depth + 1, True) if delimiter == '{' else None
                node = Node(head[0], head[1:], children, path)
                if node.name == 'include':
                    need(children is None and len(node.args) == 1, 'unsupported_include')
                    for included in self.reader.include(node.args[0]):
                        nodes.extend(self.file(included, stack + (path,)))
                else:
                    nodes.append(node)
            need(not nested, 'unsupported_config_syntax')
            return nodes
        result = block()
        if path == '/etc/nginx/mime.types':
            need(len(result) == 1 and result[0].name == 'types' and result[0].children is not None
                 and all(item.children is None and re.fullmatch(r'[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+', item.name)
                         and item.args and all(re.fullmatch(r'[A-Za-z0-9_+-]+', value) for value in item.args)
                         for item in result[0].children), 'unsupported_mime_types')
        return result


def walk(nodes):
    for node in nodes:
        yield node
        if node.children is not None:
            yield from walk(node.children)


def named(nodes, name):
    return [node for node in nodes if node.name == name]


def fields(strings):
    value = ''.join(strings)
    found = list(VARIABLE.finditer(value))
    need('$' not in VARIABLE.sub('', value), 'unsupported_format_variable')
    names = {next(part for part in item.groups() if part is not None).lower() for item in found}
    need(all(len(name) <= 64 for name in names), 'unsupported_format_variable')
    return names


def inspect(nodes):
    reasons, summaries = set(), []
    unsafe = False
    all_nodes = list(walk(nodes))
    if any(node.name == 'debug_connection' for node in all_nodes):
        reasons.add('debug_connection_enabled')
        unsafe = True
    if any(node.name in ('load_module', 'map', 'geo', 'perl', 'js_import', 'js_set') or
           '_by_lua' in node.name or node.name.startswith(('lua_', 'perl_', 'js_')) for node in all_nodes):
        reasons.add('unsupported_dynamic_configuration')
    http = named(nodes, 'http')
    need(len(http) == 1 and http[0].children is not None, 'http_scope_not_unique')
    http = http[0].children
    for node in nodes:
        if node.name not in MAIN_DIRECTIVES | {'http', 'events'}:
            reasons.add('unsupported_main_directive')
    for events in named(nodes, 'events'):
        if events.children is None or any(node.children is not None or node.name not in {
                'worker_connections', 'multi_accept', 'accept_mutex', 'accept_mutex_delay',
                'use', 'worker_aio_requests', 'debug_connection'} for node in events.children):
            reasons.add('unsupported_events_directive')
    for node in http:
        if node.name not in HTTP_DIRECTIVES | {'server', 'types'}:
            reasons.add('unsupported_http_directive')
    candidates = []
    for server in named(http, 'server'):
        need(server.children is not None, 'unsupported_config_syntax')
        names = named(server.children, 'server_name')
        if not any(SITE in node.args for node in names):
            continue
        listeners = named(server.children, 'listen')
        if any(node.args and node.args[0] in ('443', '*:443', '0.0.0.0:443', '[::]:443') and 'ssl' in node.args for node in listeners):
            need(len(names) == 1 and names[0].args == [SITE], 'target_server_not_unique')
            candidates.append(server)
    need(len(candidates) == 1, 'target_server_not_unique')
    server = candidates[0]
    need(server.path == TARGET, 'target_server_source_mismatch')
    for node in server.children:
        if node.name not in SERVER_DIRECTIVES | {'location', 'types'}:
            reasons.add('unsupported_target_directive')
    exact = [node for node in named(server.children, 'location') if node.args == ['=', ROUTE]]
    need(len(exact) == 1 and exact[0].children is not None, 'status_location_not_unique')
    location = exact[0].children
    need([node.args for node in named(location, 'proxy_pass')] == [['http://127.0.0.1:8790/v1/status']], 'status_upstream_not_fixed')
    need([node.args for node in named(location, 'proxy_intercept_errors')] == [['off']], 'status_error_interception_unknown')
    for node in location:
        if node.children is not None:
            if node.name != 'limit_except' or node.args != ['POST'] or any(item.name != 'deny' or item.args != ['all'] or item.children is not None for item in node.children):
                reasons.add('unsupported_status_control_flow')
        elif node.name not in LOCATION_DIRECTIVES:
            reasons.add('unsupported_status_directive')
    for scope in (http, server.children, location):
        if any(node.name in INTERNAL_REDIRECT or node.name == 'if' for node in scope):
            reasons.add('status_internal_redirect_unknown')
    formats = {'combined': COMBINED}
    for node in named(http, 'log_format'):
        need(node.children is None and len(node.args) >= 2 and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,63}', node.args[0]), 'unsupported_log_format')
        name, body = node.args[0], node.args[1:]
        need(name not in formats, 'duplicate_log_format')
        if body[0].startswith('escape='):
            need(body.pop(0) in ('escape=default', 'escape=json', 'escape=none') and body, 'unsupported_log_format')
        formats[name] = fields(body)
    effective, source_scope = None, 'http/default'
    scopes = [(nodes, 'main'), (http, 'http'), (server.children, 'http/server443'), (location, 'http/server443/status')]
    for scope, label in scopes:
        logs = named(scope, 'access_log')
        if logs:
            effective, source_scope = logs, label
        # Check all earlier request phases, including before location selection.
        for node in named(scope, 'error_log'):
            if not (1 <= len(node.args) <= 2) or '$' in node.args[0] or node.args[0].startswith(('syslog:', 'memory:')):
                reasons.add('unsupported_error_log')
            elif len(node.args) == 2 and node.args[1] == 'debug':
                unsafe = True
                reasons.add('debug_error_log_enabled')
            elif len(node.args) == 2 and node.args[1] not in ('info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg'):
                reasons.add('unsupported_error_log')
    if effective is None:
        effective = [Node('access_log', ['logs/access.log', 'combined'], None, ENTRY)]
    for node in effective:
        if node.args == ['off']:
            reasons.add('access_log_disabled_requires_review')
            continue
        if not (1 <= len(node.args) <= 2) or '$' in node.args[0] or not re.fullmatch(r'/?[A-Za-z0-9_./-]+', node.args[0]):
            reasons.add('unsupported_access_log')
            continue
        name = node.args[1] if len(node.args) == 2 else 'combined'
        if name not in formats:
            reasons.add('undefined_log_format')
            continue
        variables = formats[name]
        summaries.append({'path': node.path, 'scope': source_scope, 'format': name, 'variables': sorted(variables)})
        if variables & SENSITIVE_VARIABLES or any('fkssj' in value or 'request_header' in value for value in variables):
            reasons.add('sensitive_log_variable')
            unsafe = True
        if variables - SAFE_VARIABLES - SENSITIVE_VARIABLES:
            reasons.add('unknown_log_variable')
    return ('unsafe' if unsafe else 'unknown' if reasons else 'safe'), sorted(reasons), summaries


def audit(root=Path('/'), metadata=None, now=None):
    reader = Reader(root, metadata)
    report = {'schema': 1, 'site': SITE, 'endpoint': ENDPOINT,
              'checkedAt': int(time.time() if now is None else now),
              'targetSha256': None, 'configSha256': digest(b'[]'),
              'status': 'unknown', 'reasons': [], 'basis': 'disk_configuration_only_not_running_attestation'}
    try:
        report['targetSha256'] = digest(reader.read(TARGET))
        need(report['targetSha256'] == TARGET_SHA256, 'target_configuration_mismatch')
        nodes = Parser(reader).file(ENTRY)
        status, reasons, summaries = inspect(nodes)
        reader.unchanged()
        report.update(status=status, reasons=reasons, summaries=summaries)
    except (Unknown, OSError, UnicodeError, ValueError, RecursionError) as error:
        report['status'] = 'unknown'
        report['reasons'] = [str(error) if isinstance(error, Unknown) else 'configuration_unreadable_or_unsupported']
    report['configSha256'] = digest(json.dumps(sorted(reader.hashes.items()), separators=(',', ':')).encode('ascii'))
    return report


def main():
    if len(sys.argv) != 1:
        print(json.dumps({'schema': 1, 'status': 'unknown', 'reasons': ['no_arguments_allowed']}))
        return 2
    report = audit()
    print(json.dumps(report, sort_keys=True))
    return 0 if report['status'] == 'safe' else 1


if __name__ == '__main__':
    raise SystemExit(main())

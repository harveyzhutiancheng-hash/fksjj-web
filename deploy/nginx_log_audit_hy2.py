#!/usr/bin/env python3
"""Narrow, opt-in local hy2 structure gate around the unchanged disk audit.

No subprocess, network, configuration writes, logs, referenced secrets or keys.
Only the two fixed hy2 paths gain permission. Their contents stay in memory;
only fixed reason codes and structural booleans enter the result. Unknown stops.
"""
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

BASE_SHA256 = 'd1bf183860dbe072b5368c7a9efd224f7ef67f2a7a475b9f07827aff8908f332'
ENABLED = '/etc/nginx/sites-enabled/hy2-subscription'
AVAILABLE = '/etc/nginx/sites-available/hy2-subscription'
SENSITIVE = frozenset((ENABLED, AVAILABLE))
DOMAIN = re.compile(r'[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?\Z')
STATIC = frozenset(('alias expires break empty_gif auth_basic auth_basic_user_file '
                    'ssl_session_tickets ssl_stapling ssl_stapling_verify resolver '
                    'resolver_timeout http2 proxy_ssl_server_name proxy_ssl_name '
                    'proxy_ssl_verify proxy_ssl_trusted_certificate').split())
FIXED_ERRORS = frozenset(('config_changed config_symlink_not_allowed configuration_limit '
    'duplicate_log_format http_scope_not_unique include_cycle_or_depth include_path_not_allowed '
    'sensitive_site_not_read status_error_interception_unknown status_location_not_unique '
    'status_upstream_not_fixed target_configuration_mismatch target_server_not_unique '
    'target_server_source_mismatch unsafe_config_file unsafe_config_parent unsupported_config_syntax '
    'unsupported_format_variable unsupported_include unsupported_log_format unsupported_mime_types '
    'hy2_dynamic_configuration hy2_further_include_not_read hy2_inclusion_not_unique '
    'hy2_inclusion_scope_unknown hy2_listen_ambiguous hy2_not_only_server_blocks '
    'hy2_server_name_ambiguous hy2_specific_or_ambiguous_443 hy2_structure_ambiguous '
    'hy2_target_name_overlap hy2_unknown_block hy2_unknown_directive hy2_verified_link_required '
    'hy2_debug_logging_requires_review').split())


def _base():
    source = globals().get('_VERIFIED_BASE_SOURCE')
    if source is None:
        path = Path(__file__).with_name('nginx_log_audit.py')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= 32768:
                raise ValueError()
            source = os.read(fd, 32769)
            after = os.fstat(fd)
            if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                    after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError()
        finally:
            os.close(fd)
    if not isinstance(source, bytes) or hashlib.sha256(source).hexdigest() != BASE_SHA256:
        raise ValueError()
    # A private module confines the two-path permission extension to this audit.
    name = '_fkssj_pinned_log_audit'
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader=None))
    sys.modules[name] = module
    exec(compile(source, 'pinned_nginx_log_audit.py', 'exec'), module.__dict__)
    original = module.approved
    def approved(path):
        if path not in SENSITIVE:
            original(path)
    module.approved = approved
    return module


def raw_nodes(base, data, path):
    """Parse structure without any include expansion, retaining token kinds."""
    text = data.decode('utf-8')
    base.need('\x00' not in text and all(ord(c) >= 32 or c in '\r\n\t' for c in text),
              'hy2_structure_ambiguous')
    words, word, quoted, active, index = [], [], None, False, 0
    def emit():
        nonlocal active
        if active:
            words.append(('word', ''.join(word)))
            word.clear()
            active = False
    while index < len(text):
        char = text[index]
        if char == '\\':
            base.need(index + 1 < len(text), 'hy2_structure_ambiguous')
            word.append({'n': '\n', 'r': '\r', 't': '\t'}.get(text[index + 1], text[index + 1]))
            active = True
            index += 2
            continue
        if quoted:
            if char == quoted:
                quoted = None
            else:
                word.append(char)
        elif char in ('"', "'"):
            quoted, active = char, True
        elif char == '#' and not active:
            end = text.find('\n', index)
            index = len(text) if end < 0 else end
            continue
        elif char.isspace():
            emit()
        elif text[index:index + 2] == '${':
            end = text.find('}', index + 2)
            base.need(end >= 0, 'hy2_structure_ambiguous')
            word.append(text[index:end + 1])
            active, index = True, end + 1
            continue
        elif char in '{};':
            emit()
            words.append((char, char))
        else:
            active = True
            word.append(char)
        index += 1
    base.need(quoted is None, 'hy2_structure_ambiguous')
    emit()
    base.need(len(words) <= base.MAX_TOKENS, 'configuration_limit')
    index = 0
    def block(depth=0, nested=False):
        nonlocal index
        base.need(depth <= base.MAX_DEPTH, 'configuration_limit')
        nodes = []
        while index < len(words):
            if words[index][0] == '}':
                base.need(nested, 'hy2_structure_ambiguous')
                index += 1
                return nodes
            head = []
            while index < len(words) and words[index][0] == 'word':
                head.append(words[index][1])
                index += 1
            base.need(head and index < len(words) and words[index][0] in (';', '{'),
                      'hy2_structure_ambiguous')
            delimiter = words[index][0]
            index += 1
            children = block(depth + 1, True) if delimiter == '{' else None
            nodes.append(base.Node(head[0], head[1:], children, path))
        base.need(not nested, 'hy2_structure_ambiguous')
        return nodes
    return block()


def structure(base, nodes, summary):
    all_nodes = list(base.walk(nodes))
    summary['furtherInclude'] = any(node.name == 'include' for node in all_nodes)
    outside_servers = [item for node in nodes if node.name != 'server' for item in base.walk([node])]
    summary['globalLogging'] = any(node.name in ('access_log', 'error_log', 'log_format') for node in outside_servers)
    summary['dynamicDirectives'] = any(
        node.name in ('load_module', 'map', 'geo', 'set', 'perl', 'js_import', 'js_set') or
        '_by_lua' in node.name or node.name.startswith(('lua_', 'perl_', 'js_')) for node in all_nodes)
    base.need(not summary['furtherInclude'], 'hy2_further_include_not_read')
    base.need(not summary['dynamicDirectives'], 'hy2_dynamic_configuration')
    base.need(nodes and all(node.name == 'server' and not node.args and node.children is not None
                            for node in nodes), 'hy2_not_only_server_blocks')
    def scopes(children, parent):
        for node in children:
            if node.children is not None:
                base.need(node.name in ({'server'} if parent == 'root' else
                                        {'location', 'types'} if parent in ('server', 'location') else set()),
                          'hy2_unknown_block')
                scopes(node.children, node.name)
    scopes(nodes, 'root')
    allowed = base.LOCATION_DIRECTIVES | base.INTERNAL_REDIRECT | STATIC
    type_entries = {id(item) for node in all_nodes if node.name == 'types' and node.children is not None
                    for item in node.children}
    for node in all_nodes:
        if node.children is not None:
            base.need(node.name in ('server', 'location', 'types'), 'hy2_unknown_block')
            if node.name == 'types':
                base.need(all(item.children is None and re.fullmatch(r'[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+', item.name)
                              and item.args and all(re.fullmatch(r'[A-Za-z0-9_+-]+', arg) for arg in item.args)
                              for item in node.children), 'hy2_structure_ambiguous')
        elif id(node) not in type_entries:
            base.need(node.name in allowed, 'hy2_unknown_directive')
        if node.name == 'error_log':
            base.need(node.children is None and 1 <= len(node.args) <= 2 and
                      (len(node.args) == 1 or node.args[1] in ('info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg')),
                      'hy2_debug_logging_requires_review')
    for server in nodes:
        names = base.named(server.children, 'server_name')
        base.need(len(names) == 1 and names[0].children is None and names[0].args and
                  all(DOMAIN.fullmatch(name) for name in names[0].args), 'hy2_server_name_ambiguous')
        if any(name.lower().rstrip('.') == base.SITE for name in names[0].args):
            summary['couldAffectTarget443'] = True
            raise base.Unknown('hy2_target_name_overlap')
        listeners = base.named(server.children, 'listen')
        base.need(listeners, 'hy2_listen_ambiguous')
        for listener in listeners:
            base.need(listener.children is None and listener.args and
                      all(arg in ('ssl', 'http2') for arg in listener.args[1:]), 'hy2_listen_ambiguous')
            address = listener.args[0]
            match = re.fullmatch(r'(?:(\*|[0-9.]+|\[[0-9A-Fa-f:]+\]):)?([0-9]{1,5})', address)
            base.need(match is not None and 0 < int(match[2]) <= 65535, 'hy2_listen_ambiguous')
            host, port = match[1], int(match[2])
            if host not in (None, '*'):
                try:
                    ipaddress.ip_address(host.strip('[]'))
                except ValueError:
                    raise base.Unknown('hy2_listen_ambiguous') from None
            if port == 443:
                base.need(host in (None, '*', '0.0.0.0', '[::]') and 'ssl' in listener.args[1:],
                          'hy2_specific_or_ambiguous_443')
    summary['onlyOtherServers'] = True
    summary['couldAffectTarget443'] = False


def audit(root=Path('/'), metadata=None, now=None, _core=None):
    report = {'schema': 1, 'site': 'fkssj.harvey-ai.xyz',
              'endpoint': 'https://fkssj.harvey-ai.xyz/_fkssj-release/v1/status',
              'checkedAt': int(time.time() if now is None else now), 'targetSha256': None,
              'configSha256': hashlib.sha256(b'[]').hexdigest(), 'status': 'unknown', 'reasons': [],
              'basis': 'disk_configuration_only_not_running_attestation'}
    summary = {'scope': 'hy2-structure', 'onlyOtherServers': None, 'globalLogging': None,
               'dynamicDirectives': None, 'furtherInclude': None, 'couldAffectTarget443': None}
    reader = None
    try:
        base = _core or _base()
        class Reader(base.Reader):
            def source(self, path):
                if path == ENABLED:
                    parent = self.directory('/etc/nginx/sites-enabled')
                    try:
                        info = self.metadata(os.stat('hy2-subscription', dir_fd=parent, follow_symlinks=False))
                        base.need(stat.S_ISLNK(info.st_mode) and info.st_uid == 0, 'hy2_verified_link_required')
                    finally:
                        os.close(parent)
                result = super().source(path)
                if path == ENABLED and result[1] != AVAILABLE:
                    os.close(result[0])
                    raise base.Unknown('hy2_verified_link_required')
                return result
        reader = Reader(root, metadata)
        report['targetSha256'] = base.digest(reader.read(base.TARGET))
        base.need(report['targetSha256'] == base.TARGET_SHA256, 'target_configuration_mismatch')
        sensitive_nodes = raw_nodes(base, reader.read(ENABLED), ENABLED)
        structure(base, sensitive_nodes, summary)
        class Parser(base.Parser):
            sensitive_calls = 0
            def file(self, path, stack=()):
                if path in SENSITIVE:
                    base.need(path not in stack and len(stack) < base.MAX_INCLUDES, 'include_cycle_or_depth')
                    self.sensitive_calls += 1
                    base.need(self.sensitive_calls == 1, 'hy2_inclusion_not_unique')
                    # Capture/check the alias too; no include can be followed from these nodes.
                    base.need(reader.read(path) == reader.read(ENABLED), 'config_changed')
                    return sensitive_nodes
                return super().file(path, stack)
        parser = Parser(reader)
        nodes = parser.file(base.ENTRY)
        http = base.named(nodes, 'http')
        base.need(parser.sensitive_calls == 1 and len(http) == 1 and http[0].children is not None and
                  all(any(node is candidate for candidate in http[0].children) for node in sensitive_nodes),
                  'hy2_inclusion_scope_unknown')
        status, reasons, summaries = base.inspect(nodes)
        reader.unchanged()
        report.update(status=status, reasons=reasons, summaries=summaries)
    except Exception as error:
        # Even arbitrary OS/parser exceptions cannot disclose content or paths.
        is_fixed = reader is not None and isinstance(error, base.Unknown) and str(error) in FIXED_ERRORS
        report['reasons'] = [str(error) if is_fixed else 'configuration_unreadable_or_unsupported']
    if reader is not None:
        report['configSha256'] = base.digest(json.dumps(sorted(reader.hashes.items()), separators=(',', ':')).encode('ascii'))
    report.setdefault('summaries', []).append(summary)
    return report


def main():
    if len(sys.argv) != 1:
        print(json.dumps({'schema': 1, 'status': 'unknown', 'reasons': ['no_arguments_allowed']}))
        return 2
    try:
        report = audit()
        print(json.dumps(report, sort_keys=True))
        return 0 if report['status'] == 'safe' else 1
    except BaseException:
        print(json.dumps({'schema': 1, 'status': 'unknown', 'reasons': ['local_audit_failure']}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

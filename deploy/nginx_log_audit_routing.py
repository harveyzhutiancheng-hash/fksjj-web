#!/usr/bin/env python3
"""Classify fixed-client TCP443 routing without changing the pinned read scope."""
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys

PINS = {
    '_VERIFIED_BASE_SOURCE': ('nginx_log_audit.py', 'd1bf183860dbe072b5368c7a9efd224f7ef67f2a7a475b9f07827aff8908f332'),
    '_VERIFIED_HY2_SOURCE': ('nginx_log_audit_hy2.py', 'a9940bbf5271dcb15b3f6b85aeb4731356dda2872313a88ee960fadea45c1ae7'),
    '_VERIFIED_BOUNDED_SOURCE': ('nginx_log_audit_bounded.py', '851cb257a4f234e1aa74da8f3afd8d58b7e9c4c4972476921bbe08270094ad5f'),
    '_VERIFIED_COMPAT_SOURCE': ('nginx_log_audit_compat.py', '873928158f088150ccc48082ddbbf0db3a9e2370318f9db2c51826410ca1c7cc'),
}
FLAGS = frozenset('ssl http2 default_server bind reuseport deferred proxy_protocol quic'.split())
TUNING = frozenset('bind reuseport deferred backlog fastopen rcvbuf sndbuf so_keepalive'.split())
LISTEN_ERRORS = frozenset(('listen_syntax_unknown listen_option_duplicate listen_option_unmodeled '
    'listen_address_unmodeled listen_protocol_combination_unmodeled listen_port_unmodeled '
    'listen_family_option_invalid').split())


def capture(path, pin):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= 32768:
            raise ValueError()
        data = bytearray()
        while len(data) < before.st_size:
            chunk = os.read(fd, before.st_size - len(data))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        keys = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        if len(data) != before.st_size or any(getattr(before, key) != getattr(after, key) for key in keys):
            raise ValueError()
        if hashlib.sha256(data).hexdigest() != pin:
            raise ValueError()
        return bytes(data)
    finally:
        os.close(fd)


def _modules():
    sources = {}
    for key, (filename, pin) in PINS.items():
        source = globals().get(key)
        if source is None:
            source = capture(Path(__file__).with_name(filename), pin)
        if not isinstance(source, bytes) or hashlib.sha256(source).hexdigest() != pin:
            raise ValueError()
        sources[key] = source
    name = '_fkssj_pinned_routing_compat'
    compat = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader=None))
    sys.modules[name] = compat
    compat.__dict__.update(sources)
    exec(compile(sources['_VERIFIED_COMPAT_SOURCE'], 'pinned_routing_compat.py', 'exec'), compat.__dict__)
    return (compat, *compat._modules())


class Unmodeled(Exception):
    """Only fixed codes from this source are raised; never configuration text."""


def listener(node):
    if node.children is not None or not node.args:
        raise Unmodeled('listen_syntax_unknown')
    address, options = node.args[0], {}
    for arg in node.args[1:]:
        key, sep, value = arg.partition('=')
        if key in options:
            raise Unmodeled('listen_option_duplicate')
        if key in FLAGS and not sep:
            options[key] = True
        elif key == 'ipv6only' and sep and value in ('on', 'off'):
            options[key] = value
        elif key in ('backlog', 'fastopen') and sep and re.fullmatch(r'[0-9]{1,10}', value) and 0 < int(value) < 2**31:
            options[key] = value
        elif key in ('rcvbuf', 'sndbuf') and sep and re.fullmatch(r'[1-9][0-9]{0,9}[kKmM]?', value):
            options[key] = value.lower()
        elif key == 'so_keepalive' and sep and (value in ('on', 'off') or
                re.fullmatch(r'(?:[0-9]+[smh]?)?:(?:[0-9]+[smh]?)?:(?:[0-9]+)?', value) and value != '::'):
            options[key] = value
        else:
            raise Unmodeled('listen_option_unmodeled')
    if '$' in address or not address or any(char.isspace() for char in address):
        raise Unmodeled('listen_address_unmodeled')
    if 'quic' in options and any(key in options for key in ('ssl', 'http2', 'proxy_protocol')):
        raise Unmodeled('listen_protocol_combination_unmodeled')
    transport = 'udp' if 'quic' in options else 'tcp'
    if address.startswith('unix:'):
        if len(address) <= 5 or 'ipv6only' in options or transport != 'tcp':
            raise Unmodeled('listen_address_unmodeled')
        return {'transport': 'unix', 'family': 'unix', 'host': None, 'port': None, 'options': options}
    if address.startswith('['):
        match = re.fullmatch(r'\[([^\]]+)\](?::([0-9]+))?', address)
        if match is None:
            raise Unmodeled('listen_address_unmodeled')
        host, port = match[1], match[2] or '80'
        try:
            parsed = ipaddress.IPv6Address(host)
        except ValueError:
            raise Unmodeled('listen_address_unmodeled') from None
        if '%' in host:
            raise Unmodeled('listen_address_unmodeled')
        host, family = str(parsed), 'v6'
    elif address.isdecimal():
        host, port, family = '0.0.0.0', address, 'v4'
    else:
        if address.count(':') > 1:
            raise Unmodeled('listen_address_unmodeled')
        host, sep, port = address.partition(':')
        port = port if sep else '80'
        if host == '*':
            host, family = '0.0.0.0', 'v4'
        else:
            try:
                host, family = str(ipaddress.IPv4Address(host)), 'v4'
            except ValueError:
                if not re.fullmatch(r'[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?', host) or re.fullmatch(r'[0-9.]+', host):
                    raise Unmodeled('listen_address_unmodeled') from None
                family = 'hostname'
    if not re.fullmatch(r'[0-9]{1,5}', port) or not 0 < int(port) <= 65535:
        raise Unmodeled('listen_port_unmodeled')
    if 'ipv6only' in options and family != 'v6':
        raise Unmodeled('listen_family_option_invalid')
    return {'transport': transport, 'family': family, 'host': host, 'port': int(port), 'options': options}


def checker_type(compat):
    class RoutingChecks(compat.Checks):
        def __init__(self, hy2, base):
            super().__init__(hy2, base)
            self.cache, self.name_cache, self.emitted = {}, {}, set()
            self.server_count = self.excluded_count = self.tcp443_count = 0
            self.default_logs_checked = False
            self.defer_scoped_debug = False

        def event(self, code, category='other', context='other', phase='structure', issue=True):
            if self.defer_scoped_debug and code == 'debug_or_unknown_error_log':
                # Debug is modeled explicitly at main/http/default scopes below.
                # Invalid log syntax was separately recorded before this pass.
                return super().event('scoped_error_log_deferred_to_routing', category, context, phase, issue=False)
            return super().event(code, category, context, phase, issue)

        def structure(self, ignored_base, nodes, summary):
            for node in self.base.walk(nodes):
                if node.name == 'error_log' and (node.children is not None or not 1 <= len(node.args) <= 2 or
                        len(node.args) == 2 and node.args[1] not in ('debug', 'info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg')):
                    self.emit(node, 'scoped_error_log_syntax_unmodeled', True, 'other', 'other')
            self.defer_scoped_debug = True
            try:
                return super().structure(ignored_base, nodes, summary)
            finally:
                self.defer_scoped_debug = False

        def emit(self, node, code, issue=False, category='server', context='server'):
            key = (id(node), code, category, context)
            if key not in self.emitted:
                self.emitted.add(key)
                self.event(code, category, context, 'isolation', issue=issue)

        def record(self, server):
            if id(server) in self.cache:
                return self.cache[id(server)]
            self.server_count += 1
            record = {'rows': [], 'unknown': False, 'active': []}
            self.cache[id(server)] = record
            items = self.base.named(server.children or [], 'listen')
            if not items:
                # Root/nonroot defaults are 80/8000, both outside fixed TCP443.
                self.emit(server, 'implicit_listener_non443')
            for item in items:
                try:
                    row = listener(item)
                except Unmodeled as error:
                    record['unknown'] = True
                    self.emit(item, str(error) if str(error) in LISTEN_ERRORS else 'listen_analysis_unknown', True)
                    continue
                except Exception:
                    record['unknown'] = True
                    self.emit(item, 'listen_analysis_unknown', True)
                    continue
                record['rows'].append(row)
                if row['transport'] == 'tcp' and row['port'] == 443:
                    record['active'].append(row)
                    if row['family'] == 'hostname':
                        self.emit(item, 'tcp443_hostname_address_unresolved', True)
                        record['unknown'] = True
                    if 'proxy_protocol' in row['options']:
                        self.emit(item, 'tcp443_proxy_protocol_unmodeled', True)
                        record['unknown'] = True
                    if row['family'] == 'v6' and row['options'].get('ipv6only') == 'off':
                        self.emit(item, 'tcp443_dual_stack_unmodeled', True)
                        record['unknown'] = True
                    if set(row['options']) & TUNING:
                        self.emit(item, 'socket_tuning_recognized')
                    if 'default_server' in row['options']:
                        self.emit(item, 'explicit_default_recognized')
                elif row['transport'] == 'udp':
                    self.emit(item, 'udp_listener_excluded')
                elif row['transport'] == 'unix':
                    self.emit(item, 'unix_listener_excluded')
                else:
                    self.emit(item, 'non443_listener_excluded')
            if not record['unknown'] and not record['active']:
                self.excluded_count += 1
                self.emit(server, 'server_outside_tcp443')
            elif record['active']:
                self.tcp443_count += 1
            return record

        def name_record(self, server, relevant=True):
            if id(server) in self.name_cache:
                result = self.name_cache[id(server)]
            else:
                result = {'exact': set(), 'lower': False, 'problem': None}
                items = self.base.named(server.children or [], 'server_name')
                if not items:
                    result['exact'].add('')
                for item in items:
                    if item.children is not None or not item.args:
                        result['problem'] = 'server_name_syntax_unmodeled'
                    for value in item.args:
                        if value.startswith('~') and len(value) > 1:
                            result['lower'] = True  # Never evaluate an opaque PCRE expression.
                        elif '$' in value:
                            result['problem'] = 'server_name_dynamic_unmodeled'
                        elif value.startswith('*.') and self.hy2.DOMAIN.fullmatch(value[2:]) or value.endswith('.*') and self.hy2.DOMAIN.fullmatch(value[:-2]) or value.startswith('.') and self.hy2.DOMAIN.fullmatch(value[1:]):
                            result['lower'] = True
                        elif value == '' or self.hy2.DOMAIN.fullmatch(value):
                            result['exact'].add(value.lower().rstrip('.'))
                        else:
                            result['problem'] = 'server_name_literal_unmodeled'
                self.name_cache[id(server)] = result
            if relevant:
                if result['problem']:
                    self.emit(server, result['problem'], True)
                if '_' in result['exact']:
                    self.emit(server, 'placeholder_literal_recognized')
                if '' in result['exact']:
                    self.emit(server, 'empty_name_recognized')
            return result

        def isolated_server(self, server):
            record = self.record(server)
            if record['unknown']:
                return False, set()
            if not record['active']:
                return True, self.name_record(server, relevant=False)['exact']
            names = self.name_record(server)
            if self.base.SITE in names['exact']:
                self.overlap = True
                self.emit(server, 'target_name_overlap', True)
            return not names['problem'] and self.base.SITE not in names['exact'], names['exact']

        def error_logs(self, scope, owner, context):
            for node in self.base.named(scope, 'error_log'):
                args = node.args
                if node.children is not None or not 1 <= len(args) <= 2 or '$' in args[0] or args[0].startswith(('syslog:', 'memory:')):
                    self.emit(node, 'default_error_log_sink_unmodeled', True, 'other', context)
                elif len(args) == 2 and args[1] == 'debug':
                    self.emit(node, 'default_debug_error_log', True, 'other', context)
                elif len(args) == 2 and args[1] not in ('info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg'):
                    self.emit(node, 'default_error_log_level_unmodeled', True, 'other', context)

        def peers(self, nodes):
            http = self.base.named(nodes, 'http')
            if len(http) != 1 or http[0].children is None:
                self.event('http_scope_unknown', 'other', 'root', 'isolation')
                return
            servers = self.base.named(http[0].children, 'server')
            groups, target_ids = {}, set()
            for server in servers:
                record = self.record(server)
                if not record['active']:
                    continue
                names = self.name_record(server)
                exact_target = (names['exact'] == {self.base.SITE} and not names['lower'] and not names['problem']
                                and server.path == self.base.TARGET)
                if self.base.SITE in names['exact'] and not exact_target:
                    self.overlap = True
                    self.emit(server, 'target_name_overlap', True)
                if exact_target:
                    target_ids.add(id(server))
                seen = set()
                for row in record['active']:
                    key = (row['family'], row['host'], row['port'])
                    if key in seen:
                        self.emit(server, 'duplicate_tcp443_binding', True)
                    seen.add(key)
                    groups.setdefault(key, []).append((server, row, names, exact_target))
            if len(target_ids) != 1:
                self.event('target_binding_unknown', 'server', 'server', 'isolation')
            self.error_logs(nodes, http[0], 'root')
            self.error_logs(http[0].children, http[0], 'root')
            for key, members in groups.items():
                targets = [member for member in members if member[3]]
                defaults = [member for member in members if member[1]['options'].get('default_server')]
                if not targets:
                    code = ('specific_tcp443_target_uncovered' if key[0] in ('v4', 'v6') and key[1] not in ('0.0.0.0', '::')
                            else 'tcp443_family_target_uncovered')
                    self.emit(members[0][0], code, True)
                if len(defaults) > 1:
                    self.emit(members[0][0], 'tcp443_default_conflict', True)
                if not any(member[1]['options'].get('ssl') for member in members):
                    self.emit(members[0][0], 'tcp443_tls_unproven', True)
                option_values = {}
                for server, row, names, exact_target in members:
                    for option in TUNING | {'ipv6only'}:
                        if option in row['options']:
                            old = option_values.setdefault(option, row['options'][option])
                            if old != row['options'][option]:
                                self.emit(server, 'tcp443_socket_option_conflict', True)
                    if names['lower'] and targets:
                        self.emit(server, 'name_lower_priority_than_exact_target')
                # The first server is the implicit default; explicit defaults
                # select the same address:port group, never all ports globally.
                default = defaults[0] if defaults else members[0]
                self.error_logs(default[0].children or [], default[0], 'server')
            self.default_logs_checked = True
            self.peers_verified = bool(self.local_isolated and len(target_ids) == 1 and groups and not self.isolation_failed)
    return RoutingChecks


def audit(root=Path('/'), metadata=None, now=None, _core=None):
    compat = old_checks = None
    instances = []
    try:
        compat, bounded, hy2, base = _core or _modules()
        old_checks = compat.Checks
        routing = checker_type(compat)
        class ActiveChecks(routing):
            def __init__(self, *args):
                super().__init__(*args)
                instances.append(self)
        compat.Checks = ActiveChecks
        report = compat.audit(root=root, metadata=metadata, now=now, _core=(bounded, hy2, base))
        if report.get('summaries') and instances:
            checks = instances[0]
            report['summaries'][0].update(scope='bounded-tcp443-routing', classifiedServers=checks.server_count,
                serversOutsideTcp443=checks.excluded_count, serversWithTcp443=checks.tcp443_count,
                defaultPhaseLogsChecked=checks.default_logs_checked)
        return report
    except Exception:
        return {'schema': 1, 'status': 'unknown', 'reasons': ['routing_analysis_unavailable']}
    finally:
        if old_checks is not None:
            compat.Checks = old_checks


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

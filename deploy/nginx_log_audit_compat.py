#!/usr/bin/env python3
"""Bounded disk audit with conservative static guards and enum diagnostics.

The pinned reader is unchanged. Unknown syntax stays in the original AST and
blocks acceptance; no code in a configuration is executed. No server operations.
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

BOUNDED_SHA256 = '851cb257a4f234e1aa74da8f3afd8d58b7e9c4c4972476921bbe08270094ad5f'
HY2_SHA256 = 'a9940bbf5271dcb15b3f6b85aeb4731356dda2872313a88ee960fadea45c1ae7'
BASE_SHA256 = 'd1bf183860dbe072b5368c7a9efd224f7ef67f2a7a475b9f07827aff8908f332'
MAX_DIAGNOSTICS = 64
METHODS = frozenset('GET HEAD POST PUT DELETE PATCH OPTIONS'.split())
CODES = frozenset('204 400 401 403 404 405 410 444 503'.split())
CATEGORIES = {'server': 'server', 'location': 'location', 'types': 'types',
              'if': 'conditional', 'limit_except': 'method_guard'}
CONTEXTS = frozenset('root server location types conditional method_guard other'.split())


def _capture(path, pin):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= 32768:
            raise ValueError()
        data = bytearray()
        while len(data) < before.st_size:
            part = os.read(fd, before.st_size - len(data))
            if not part:
                break
            data.extend(part)
        after = os.fstat(fd)
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        if len(data) != before.st_size or any(getattr(before, key) != getattr(after, key) for key in fields):
            raise ValueError()
        if hashlib.sha256(data).hexdigest() != pin:
            raise ValueError()
        return bytes(data)
    finally:
        os.close(fd)


def _modules():
    sources = {}
    for key, filename, pin in (
        ('_VERIFIED_BASE_SOURCE', 'nginx_log_audit.py', BASE_SHA256),
        ('_VERIFIED_HY2_SOURCE', 'nginx_log_audit_hy2.py', HY2_SHA256),
        ('_VERIFIED_BOUNDED_SOURCE', 'nginx_log_audit_bounded.py', BOUNDED_SHA256)):
        value = globals().get(key)
        if value is None:
            value = _capture(Path(__file__).with_name(filename), pin)
        if not isinstance(value, bytes) or hashlib.sha256(value).hexdigest() != pin:
            raise ValueError()
        sources[key] = value
    name = '_fkssj_pinned_bounded_compat'
    bounded = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader=None))
    sys.modules[name] = bounded
    bounded.__dict__.update(sources)
    exec(compile(sources['_VERIFIED_BOUNDED_SOURCE'], 'pinned_nginx_bounded.py', 'exec'), bounded.__dict__)
    hy2, base = bounded._modules()
    return bounded, hy2, base


class Checks:
    def __init__(self, hy2, base):
        self.hy2, self.base = hy2, base
        self.events, self.issues = {}, set()
        self.local_complete = self.local_isolated = self.peers_verified = False
        self.isolation_failed = False
        self.logging_complete, self.logging_status = False, 'not_run'
        self.conditional_shapes = self.method_shapes = 0
        self.overlap = False

    def event(self, code, category='other', context='other', phase='structure', issue=True):
        # Every argument is a caller-selected enum, never a configuration value.
        key = (phase, code, category, context)
        if issue and phase == 'isolation':
            self.isolation_failed = True
        if key not in self.events and len(self.events) >= MAX_DIAGNOSTICS:
            self.issues.add('diagnostic_limit')
            self.isolation_failed = True
            return
        self.events[key] = min(50000, self.events.get(key, 0) + 1)
        if issue:
            self.issues.add(code)

    def names(self, server):
        items = self.base.named(server.children or [], 'server_name')
        if len(items) != 1 or items[0].children is not None or not items[0].args:
            self.event('server_name_unknown', 'server', 'server', 'isolation')
            return None
        names = items[0].args
        if not all(self.hy2.DOMAIN.fullmatch(name) and name.strip('_.') for name in names):
            self.event('server_name_unknown', 'server', 'server', 'isolation')
            return None
        return {name.lower().rstrip('.') for name in names}

    def listeners(self, server):
        result = []
        items = self.base.named(server.children or [], 'listen')
        if not items:
            self.event('listen_unknown', 'server', 'server', 'isolation')
            return None
        for item in items:
            match = re.fullmatch(r'(?:(\*|[0-9.]+|\[[0-9A-Fa-f:]+\]):)?([0-9]{1,5})',
                                 item.args[0] if item.args else '')
            if item.children is not None or match is None or not 0 < int(match[2]) <= 65535 or any(
                    arg not in ('ssl', 'http2') for arg in item.args[1:]):
                self.event('listen_unknown', 'server', 'server', 'isolation')
                return None
            host, port = match[1], int(match[2])
            if host not in (None, '*'):
                try:
                    ipaddress.ip_address(host.strip('[]'))
                except ValueError:
                    self.event('listen_unknown', 'server', 'server', 'isolation')
                    return None
            if port == 443:
                if host not in (None, '*', '0.0.0.0', '[::]') or 'ssl' not in item.args[1:]:
                    self.event('specific_or_plain_443', 'server', 'server', 'isolation')
                    return None
                result.append(('v6' if host == '[::]' else 'v4', 443))
            else:
                result.append(('other', port))
        return result

    def isolated_server(self, server):
        names, listeners = self.names(server), self.listeners(server)
        if names and self.base.SITE in names:
            self.overlap = True
            self.event('target_name_overlap', 'server', 'server', 'isolation')
        return bool(names and self.base.SITE not in names and listeners), names

    def condition(self, args, names):
        match = re.fullmatch(r'\(\s*\$(host|request_method|scheme)\s*(=|!=)\s*([A-Za-z0-9_.-]{1,253})\s*\)', ' '.join(args))
        if match is None:
            return False
        variable, ignored_operator, value = match.groups()
        return (value.lower().rstrip('.') in names if variable == 'host' else
                value in METHODS if variable == 'request_method' else value in ('http', 'https'))

    def return_only(self, children, names):
        if len(children) != 1 or children[0].name != 'return' or children[0].children is not None:
            return False
        args = children[0].args
        if len(args) == 1:
            return args[0] in CODES
        if len(args) != 2 or args[0] not in ('301', '302', '307', '308'):
            return False
        if args[1] == 'https://$host$request_uri':
            return True
        match = re.fullmatch(r'https://([A-Za-z0-9_.-]+)(/|\$request_uri)', args[1])
        return bool(match and match[1].lower().rstrip('.') in names)

    def structure(self, ignored_base, nodes, summary):
        outside = [item for node in nodes if node.name != 'server' for item in self.base.walk([node])]
        summary['furtherInclude'] = False
        summary['globalLogging'] = any(n.name in ('access_log', 'error_log', 'log_format') for n in outside)
        summary['dynamicDirectives'] = False
        roots = bool(nodes) and all(n.name == 'server' and not n.args and n.children is not None for n in nodes)
        if not roots:
            self.event('root_scope_unknown', 'other', 'root')
        local_ok = roots
        allowed = self.base.LOCATION_DIRECTIVES | self.base.INTERNAL_REDIRECT | self.hy2.STATIC

        def visit(node, parent, names, own_isolated):
            category = CATEGORIES.get(node.name, 'other')
            context = parent if parent in CONTEXTS else 'other'
            dynamic = (node.name in ('load_module', 'map', 'geo', 'set', 'perl', 'js_import', 'js_set') or
                       '_by_lua' in node.name or node.name.startswith(('lua_', 'perl_', 'js_')))
            if dynamic:
                summary['dynamicDirectives'] = True
                self.event('dynamic_configuration', category, context)
            if node.children is not None:
                if node.name == 'server':
                    if parent != 'root' or node.args:
                        self.event('block_context_unknown', category, context)
                elif node.name == 'location':
                    if parent not in ('server', 'location') or not (len(node.args) == 1 or
                            len(node.args) == 2 and node.args[0] in ('=', '^~', '~', '~*')):
                        self.event('block_context_unknown', category, context)
                elif node.name == 'types':
                    if parent not in ('server', 'location') or node.args or not all(
                            n.children is None and re.fullmatch(r'[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+', n.name)
                            and n.args and all(re.fullmatch(r'[A-Za-z0-9_+-]+', arg) for arg in n.args)
                            for n in node.children):
                        self.event('types_shape_unknown', category, context)
                elif node.name == 'if':
                    shape = (parent in ('server', 'location') and self.condition(node.args, names) and
                             self.return_only(node.children, names))
                    if shape:
                        self.conditional_shapes += 1
                        self.event('conditional_shape_supported', category, context, issue=False)
                    else:
                        self.event('conditional_shape_unknown', category, context)
                    if not own_isolated:
                        self.event('guard_isolation_unknown', category, context, 'isolation')
                elif node.name == 'limit_except':
                    shape = (parent == 'location' and bool(node.args) and len(set(node.args)) == len(node.args)
                        and all(arg in METHODS for arg in node.args) and len(node.children) == 1
                        and node.children[0].name == 'deny' and node.children[0].args == ['all']
                        and node.children[0].children is None)
                    if shape:
                        self.method_shapes += 1
                        self.event('method_guard_shape_supported', category, context, issue=False)
                    else:
                        self.event('method_guard_shape_unknown', category, context)
                    if not own_isolated:
                        self.event('guard_isolation_unknown', category, context, 'isolation')
                else:
                    self.event('block_unknown', 'other', context)
                for child in node.children:
                    visit(child, category, names, own_isolated)
            else:
                if parent == 'types':
                    return  # The complete MIME leaf grammar was checked at the parent.
                if parent == 'conditional':
                    if node.name != 'return':
                        self.event('conditional_body_unknown', 'other', context)
                elif parent == 'method_guard':
                    if node.name != 'deny' or node.args != ['all']:
                        self.event('method_guard_body_unknown', 'other', context)
                elif node.name not in allowed:
                    self.event('directive_unknown', 'other', context)
                if node.name == 'error_log' and (not 1 <= len(node.args) <= 2 or
                        len(node.args) == 2 and node.args[1] not in ('info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg')):
                    self.event('debug_or_unknown_error_log', 'other', context)
        for node in nodes:
            own_isolated, names = self.isolated_server(node) if node.name == 'server' and node.children is not None else (False, None)
            local_ok = local_ok and own_isolated
            visit(node, 'root', names or set(), own_isolated)
        self.local_isolated, self.local_complete = local_ok, True
        summary['onlyOtherServers'] = None  # Final peer isolation is checked on the whole HTTP tree.
        summary['couldAffectTarget443'] = True if self.overlap else None

    def peers(self, nodes):
        http = self.base.named(nodes, 'http')
        if len(http) != 1 or http[0].children is None:
            self.event('http_scope_unknown', 'other', 'root', 'isolation')
            return
        servers = self.base.named(http[0].children, 'server')
        target, records = [], []
        for server in servers:
            names, listeners = self.names(server), self.listeners(server)
            if not names or not listeners:
                continue
            groups = {family for family, port in listeners if port == 443}
            if not groups:
                continue
            if self.base.SITE in names:
                if names != {self.base.SITE} or server.path != self.base.TARGET:
                    self.overlap = True
                    self.event('target_name_overlap', 'server', 'server', 'isolation')
                else:
                    target.append(groups)
            records.append((server, groups, names))
        if len(target) != 1:
            self.event('target_binding_unknown', 'server', 'server', 'isolation')
            return
        for server, groups, names in records:
            if not groups <= target[0]:
                self.event('uncovered_443_family', 'server', 'server', 'isolation')
            for node in self.base.walk(server.children or []):
                if node.name == 'error_log' and len(node.args) == 2 and node.args[1] == 'debug':
                    self.event('peer_debug_logging', 'other', 'server', 'isolation')
        self.peers_verified = bool(self.local_isolated and not self.isolation_failed and len(target) == 1)

    def diagnostics(self):
        return [{'phase': phase, 'code': code, 'category': category, 'context': context, 'count': count}
                for (phase, code, category, context), count in sorted(self.events.items())]


def audit(root=Path('/'), metadata=None, now=None, _core=None):
    bounded = hy2 = base = checks = None
    original_structure = original_inspect = None
    try:
        bounded, hy2, base = _core or _modules()
        checks = Checks(hy2, base)
        original_structure, original_inspect = hy2.structure, base.inspect
        def structure(*args):
            try:
                checks.structure(*args)
            except Exception:
                checks.event('structure_analysis_unknown')
        def inspect(nodes):
            try:
                checks.peers(nodes)
            except Exception:
                checks.peers_verified = False
                checks.event('peer_analysis_unknown', phase='isolation')
            try:
                status, reasons, ignored = original_inspect(nodes)
                checks.logging_complete, checks.logging_status = True, status
                if status == 'unknown' or set(reasons) - {
                        'debug_error_log_enabled', 'debug_connection_enabled', 'sensitive_log_variable'}:
                    checks.event('global_analysis_unknown', phase='logging')
                return status, reasons, []
            except Exception:
                checks.event('log_analysis_unknown', phase='logging')
                checks.logging_status = 'unknown'
                return 'unknown', ['compat_log_analysis_unknown'], []
        hy2.structure, base.inspect = structure, inspect
        report = bounded.audit(root=root, metadata=metadata, now=now, _core=(hy2, base))
        summary = report['summaries'][0]
        stable = bool(summary['diskAuditComplete'])
        verified = checks.local_complete and checks.peers_verified and not checks.issues
        summary.update(scope='bounded-compat-audit', onlyOtherServers=True if checks.peers_verified else None,
            couldAffectTarget443=True if checks.overlap else False if checks.peers_verified else None,
            isolationVerified=checks.peers_verified, structureVerified=bool(verified),
            loggingAnalysisComplete=checks.logging_complete, loggingStatus=checks.logging_status,
            snapshotStable=stable, conditionalGuardsAccepted=checks.conditional_shapes if verified else 0,
            methodGuardsAccepted=checks.method_shapes if verified else 0,
            diskAuditComplete=bool(stable and verified and checks.logging_complete and checks.logging_status in ('safe', 'unsafe')))
        if checks.issues:
            report['status'] = 'unknown'
            report['reasons'] = sorted(set(report['reasons']) | checks.issues)
        elif not verified and summary['referencesComplete']:
            report['status'] = 'unknown'
            report['reasons'] = sorted(set(report['reasons']) | {'structure_unverified'})
        report['diagnostics'] = checks.diagnostics()
        # Existing client accepts core fields plus summaries only. Diagnostics
        # live inside summaries to preserve that reviewed contract.
        summary['diagnostics'] = report.pop('diagnostics')
        return report
    except Exception:
        return {'schema': 1, 'status': 'unknown', 'reasons': ['compat_analysis_unavailable']}
    finally:
        if original_structure is not None:
            hy2.structure = original_structure
        if original_inspect is not None:
            base.inspect = original_inspect


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

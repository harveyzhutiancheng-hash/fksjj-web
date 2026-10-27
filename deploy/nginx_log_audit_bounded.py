#!/usr/bin/env python3
"""Opt-in bounded /etc/nginx include closure; disk-only, read-only, fail closed."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import time

HY2_SHA256 = 'a9940bbf5271dcb15b3f6b85aeb4731356dda2872313a88ee960fadea45c1ae7'
BASE_SHA256 = 'd1bf183860dbe072b5368c7a9efd224f7ef67f2a7a475b9f07827aff8908f332'
MAX_REFERENCE_FILES, MAX_REFERENCE_DEPTH = 16, 4
MAX_REFERENCE_BYTES, MAX_FILE_BYTES = 256 * 1024, 64 * 1024
MAX_EXPANSIONS, MAX_NODES = 128, 50000
SECRET_NAME = re.compile(r'cert|private|password|passwd|secret|credential|token|key|(?:^|[_.-])logs?(?:[_.-]|$)', re.I)
SECRET_SUFFIX = re.compile(r'\.(?:pem|crt|cer|der|p12|pfx|key|log|htpasswd)(?:\.|$)', re.I)
FILE_REFERENCES = frozenset(('ssl_certificate ssl_certificate_key ssl_client_certificate '
    'ssl_trusted_certificate ssl_dhparam ssl_password_file auth_basic_user_file '
    'proxy_ssl_certificate proxy_ssl_certificate_key proxy_ssl_trusted_certificate '
    'proxy_ssl_password_file uwsgi_ssl_certificate uwsgi_ssl_certificate_key '
    'grpc_ssl_certificate grpc_ssl_certificate_key grpc_ssl_trusted_certificate '
    'access_log error_log').split())
ERRORS = frozenset(('closure_path_not_allowed closure_variable_path closure_glob_not_supported '
    'closure_sensitive_target closure_config_type_unknown closure_link_not_allowed '
    'closure_file_limit closure_depth_limit closure_byte_limit closure_cycle '
    'closure_expansion_limit closure_scope_unknown closure_include_ambiguous '
    'closure_secret_reference closure_unsafe_file closure_config_changed '
    'closure_configuration_unreadable').split())


def capture(path, pin):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= 32768:
            raise ValueError()
        data = bytearray()
        while len(data) <= 32768:
            part = os.read(fd, 32769 - len(data))
            if not part:
                break
            data.extend(part)
        after = os.fstat(fd)
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        if any(getattr(before, key) != getattr(after, key) for key in fields) or len(data) != before.st_size:
            raise ValueError()
        if hashlib.sha256(data).hexdigest() != pin:
            raise ValueError()
        return bytes(data)
    finally:
        os.close(fd)


def _modules():
    base_source = globals().get('_VERIFIED_BASE_SOURCE')
    hy2_source = globals().get('_VERIFIED_HY2_SOURCE')
    if base_source is None:
        base_source = capture(Path(__file__).with_name('nginx_log_audit.py'), BASE_SHA256)
    if hy2_source is None:
        hy2_source = capture(Path(__file__).with_name('nginx_log_audit_hy2.py'), HY2_SHA256)
    if hashlib.sha256(base_source).hexdigest() != BASE_SHA256 or hashlib.sha256(hy2_source).hexdigest() != HY2_SHA256:
        raise ValueError()
    name = '_fkssj_pinned_hy2_structure'
    hy2 = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader=None))
    sys.modules[name] = hy2
    hy2.__dict__['_VERIFIED_BASE_SOURCE'] = base_source
    exec(compile(hy2_source, 'pinned_nginx_hy2.py', 'exec'), hy2.__dict__)
    return hy2, hy2._base()


def literal_path(base, expression):
    base.need(isinstance(expression, str) and expression and '$' not in expression, 'closure_variable_path')
    base.need(not any(char in expression for char in '*?['), 'closure_glob_not_supported')
    path = expression if expression.startswith('/') else '/etc/nginx/' + expression
    parts = path.split('/')
    base.need(parts[:3] == ['', 'etc', 'nginx'] and len(parts) > 3 and
              all(part not in ('', '.', '..') and re.fullmatch(r'[A-Za-z0-9_.-]{1,96}', part) for part in parts[3:]),
              'closure_path_not_allowed')
    base.need(not any(SECRET_NAME.search(part) or SECRET_SUFFIX.search(part) for part in parts[3:]),
              'closure_sensitive_target')
    return path


def audit(root=Path('/'), metadata=None, now=None, _core=None):
    report = {'schema': 1, 'site': 'fkssj.harvey-ai.xyz',
        'endpoint': 'https://fkssj.harvey-ai.xyz/_fkssj-release/v1/status',
        'checkedAt': int(time.time() if now is None else now), 'targetSha256': None,
        'configSha256': hashlib.sha256(b'[]').hexdigest(), 'status': 'unknown', 'reasons': [],
        'basis': 'disk_configuration_only_not_running_attestation'}
    summary = {'scope': 'bounded-config-closure', 'includeFound': None, 'referencesComplete': False,
        'referencedFileCount': 0, 'referenceBytes': 0, 'deepestReference': 0,
        'onlyOtherServers': None, 'globalLogging': None, 'dynamicDirectives': None,
        'couldAffectTarget443': None, 'diskAuditComplete': False}
    reader = base = original_approved = None
    try:
        hy2, base = _core or _modules()
        allowed_references, known_secret_refs, reference_sizes = set(), set(), {}
        approved = base.approved
        original_approved = approved
        def bounded_approved(path):
            if path not in allowed_references:
                approved(path)
        base.approved = bounded_approved

        class Reader(base.Reader):
            def source(self, path):
                if path == hy2.ENABLED:
                    parent = self.directory('/etc/nginx/sites-enabled')
                    try:
                        info = self.metadata(os.stat('hy2-subscription', dir_fd=parent, follow_symlinks=False))
                        base.need(stat.S_ISLNK(info.st_mode) and info.st_uid == 0, 'hy2_verified_link_required')
                    finally:
                        os.close(parent)
                    result = super().source(path)
                    if result[1] != hy2.AVAILABLE:
                        os.close(result[0])
                        raise base.Unknown('hy2_verified_link_required')
                    return result
                # All other leaf links are rejected, including new sites-enabled links.
                parent = self.directory(str(PurePosixPath(path).parent))
                try:
                    name = PurePosixPath(path).name
                    info = self.metadata(os.stat(name, dir_fd=parent, follow_symlinks=False))
                    base.need(not stat.S_ISLNK(info.st_mode), 'closure_link_not_allowed')
                    return os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent), path
                finally:
                    os.close(parent)

            def read(self, path):
                base.need(path not in known_secret_refs, 'closure_secret_reference')
                if path not in hy2.SENSITIVE:
                    literal_path(base, path)  # Sensitive types are refused even in main includes.
                if path not in allowed_references or path in self.cache:
                    return super().read(path)
                base.approved(path)
                base.need(len(self.hashes) < base.MAX_FILES, 'configuration_limit')
                fd, actual = self.source(path)
                try:
                    before = self.metadata(os.fstat(fd))
                    base.need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == 0
                              and not before.st_mode & 0o022 and 0 < before.st_size <= MAX_FILE_BYTES,
                              'closure_unsafe_file')
                    base.need(sum(reference_sizes.values()) + before.st_size <= MAX_REFERENCE_BYTES,
                              'closure_byte_limit')
                    data = bytearray()
                    while len(data) < before.st_size:
                        part = os.read(fd, before.st_size - len(data))
                        if not part:
                            break
                        data.extend(part)
                    base.need(len(data) == before.st_size and base.stamp(before) == base.stamp(self.metadata(os.fstat(fd))),
                              'closure_config_changed')
                    previous = self.records.get(('file', actual))
                    base.need(previous is None or previous == base.stamp(before), 'config_changed')
                    self.total += len(data)
                    base.need(self.total <= base.MAX_TOTAL_BYTES, 'configuration_limit')
                    self.records[('file', actual)] = base.stamp(before)
                    self.hashes[path], self.cache[path] = base.digest(data), bytes(data)
                    return bytes(data)
                finally:
                    os.close(fd)

            def reference(self, path):
                if path not in hy2.SENSITIVE and path not in reference_sizes:
                    base.need(len(reference_sizes) < MAX_REFERENCE_FILES, 'closure_file_limit')
                    base.need(path.endswith('.conf'), 'closure_config_type_unknown')
                    allowed_references.add(path)
                    if path in self.cache:
                        base.need(sum(reference_sizes.values()) + len(self.cache[path]) <= MAX_REFERENCE_BYTES,
                                  'closure_byte_limit')
                    data = self.read(path)
                    reference_sizes[path] = len(data)
                    return data
                return self.read(path)

        reader = Reader(root, metadata)
        report['targetSha256'] = base.digest(reader.read(base.TARGET))
        base.need(report['targetSha256'] == base.TARGET_SHA256, 'target_configuration_mismatch')
        sensitive_raw = hy2.raw_nodes(base, reader.read(hy2.ENABLED), hy2.ENABLED)
        marker = base.Node('__bounded_hy2_placeholder__', [], None, hy2.ENABLED)
        def scan_file_references(items):
            for node in base.walk(items):
                if node.name in FILE_REFERENCES and node.args:
                    expression = node.args[0]
                    # Reference values stay local; no referenced body is opened.
                    base.need('$' not in expression, 'closure_variable_path')
                    raw = expression if expression.startswith('/') else '/etc/nginx/' + expression
                    known_secret_refs.add(os.path.normpath(raw))
            base.need(not (set(reader.cache) & known_secret_refs), 'closure_secret_reference')
        scan_file_references(sensitive_raw)
        class Parser(base.Parser):
            sensitive_calls, calls = 0, 0
            def file(self, path, stack=()):
                self.calls += 1
                base.need(self.calls <= MAX_EXPANSIONS, 'closure_expansion_limit')
                if path in hy2.SENSITIVE:
                    self.sensitive_calls += 1
                    base.need(self.sensitive_calls == 1, 'hy2_inclusion_not_unique')
                    base.need(reader.read(path) == reader.read(hy2.ENABLED), 'config_changed')
                    return [marker]
                base.need(path not in stack and len(stack) < base.MAX_INCLUDES, 'include_cycle_or_depth')
                raw = hy2.raw_nodes(base, reader.read(path), path)
                # Inspect every visible file-reference directive before opening
                # this file's includes, including directives after an include.
                scan_file_references(raw)
                self.total_tokens += len(list(base.walk(raw)))
                base.need(self.total_tokens <= MAX_NODES, 'closure_expansion_limit')
                if path == '/etc/nginx/mime.types':
                    base.need(len(raw) == 1 and raw[0].name == 'types' and raw[0].children is not None
                        and all(item.children is None and re.fullmatch(r'[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+', item.name)
                                and item.args and all(re.fullmatch(r'[A-Za-z0-9_+-]+', arg) for arg in item.args)
                                for item in raw[0].children), 'unsupported_mime_types')
                def expand_main(items):
                    output = []
                    for node in items:
                        if node.name == 'include':
                            base.need(node.children is None and len(node.args) == 1, 'unsupported_include')
                            for included in reader.include(node.args[0]):
                                output.extend(self.file(included, stack + (path,)))
                        else:
                            children = None if node.children is None else expand_main(node.children)
                            output.append(base.Node(node.name, node.args[:], children, node.path))
                    return output
                return expand_main(raw)
        parser = Parser(reader)
        nodes = parser.file(base.ENTRY)
        http = base.named(nodes, 'http')
        base.need(parser.sensitive_calls == 1 and len(http) == 1 and http[0].children is not None and
                  any(node is marker for node in http[0].children), 'closure_scope_unknown')

        scan_file_references(nodes)
        summary['includeFound'] = any(node.name == 'include' for node in base.walk(sensitive_raw))
        calls = visited = 0
        def expand(items, stack, depth):
            nonlocal calls, visited
            output = []
            for node in items:
                visited += 1
                base.need(visited <= MAX_NODES, 'closure_expansion_limit')
                if node.name == 'include':
                    base.need(node.children is None and len(node.args) == 1, 'closure_include_ambiguous')
                    base.need(depth < MAX_REFERENCE_DEPTH, 'closure_depth_limit')
                    path = literal_path(base, node.args[0])
                    canonical = hy2.AVAILABLE if path == hy2.ENABLED else path
                    base.need(canonical not in stack, 'closure_cycle')
                    calls += 1
                    base.need(calls <= MAX_EXPANSIONS, 'closure_expansion_limit')
                    summary['deepestReference'] = max(summary['deepestReference'], depth + 1)
                    raw = hy2.raw_nodes(base, reader.reference(path), path)
                    scan_file_references(raw)
                    output.extend(expand(raw, stack + (canonical,), depth + 1))
                else:
                    children = None if node.children is None else expand(node.children, stack, depth)
                    output.append(base.Node(node.name, node.args[:], children, node.path))
            return output
        sensitive_nodes = expand(sensitive_raw, (hy2.AVAILABLE,), 0)
        summary['referencesComplete'] = True
        structural = {'furtherInclude': None, 'globalLogging': None, 'dynamicDirectives': None,
                      'onlyOtherServers': None, 'couldAffectTarget443': None}
        try:
            hy2.structure(base, sensitive_nodes, structural)
        finally:
            for key in ('globalLogging', 'dynamicDirectives', 'onlyOtherServers', 'couldAffectTarget443'):
                summary[key] = structural[key]
        location = next(index for index, node in enumerate(http[0].children) if node is marker)
        http[0].children[location:location + 1] = sensitive_nodes
        status, reasons, ignored_summaries = base.inspect(nodes)
        reader.unchanged()
        summary['diskAuditComplete'] = True
        report.update(status=status, reasons=reasons)
    except Exception as error:
        fixed = base is not None and isinstance(error, base.Unknown) and str(error) in ERRORS | hy2.FIXED_ERRORS
        report['reasons'] = [str(error) if fixed else 'closure_configuration_unreadable']
    finally:
        if original_approved is not None:
            base.approved = original_approved
    if reader is not None:
        report['configSha256'] = base.digest(json.dumps(sorted(reader.hashes.items()), separators=(',', ':')).encode('ascii'))
        summary['referencedFileCount'] = len(reference_sizes)
        summary['referenceBytes'] = sum(reference_sizes.values())
    report['summaries'] = [summary]
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

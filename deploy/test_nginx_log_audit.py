"""Read-only nginx audit fixtures; never inspect a server or real log/secret.

All configuration is public fixture text in temporary roots. Ownership is
adapted in metadata only: no chown, nginx command, service or network is used.
Parser-only target variants receive an explicit temporary test pin; a separate
test requires the production pin to reject a changed target.
"""
import builtins
from contextlib import ExitStack
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from deploy import nginx_log_audit as audit_module
from deploy import nginx_status_only as status_module


NOW = 1792713600
SENTINEL = 'INERT-CONFIG-BODY-MUST-NOT-APPEAR-IN-RESULT'
ENTRY = '/etc/nginx/nginx.conf'
TARGET = '/etc/nginx/conf.d/fkssj-domain.conf'
LOCATION = b'    location = /_fkssj-release/v1/status {\n'


class NginxLogAuditTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='TEST-FIXTURE-nginx-log-audit-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / 'root'
        self.root.mkdir(mode=0o700)
        self.owner_overrides = {}
        self.public_target = status_module.CANDIDATE
        self.write(TARGET, self.public_target)
        self.write('/etc/nginx/mime.types', 'types { text/html html; text/css css; }\n')
        self.entry()
        self.write('/srv/INERT-OLD-STATIC-DB-SENTINEL', SENTINEL)

    def path(self, logical):
        return self.root / logical.lstrip('/')

    def write(self, logical, value):
        target = self.path(logical)
        target.parent.mkdir(parents=True, exist_ok=True)
        for directory in [target.parent, *target.parent.parents]:
            if directory == self.base:
                break
            directory.chmod(0o755 if directory != self.root else 0o700)
        target.write_bytes(value.encode() if isinstance(value, str) else value)
        target.chmod(0o644)
        return target

    def entry(self, http='', events='', top=''):
        return self.write(ENTRY, 'user www-data;\n' + top + '\n'
                          'events { worker_connections 64; ' + events + ' }\n'
                          'http {\n include /etc/nginx/mime.types;\n'
                          ' access_log /var/log/nginx/access.log combined;\n'
                          + http + '\n include /etc/nginx/conf.d/*.conf;\n}\n')

    def metadata(self, value):
        fields = {name: getattr(value, name) for name in dir(value) if name.startswith('st_')}
        fields.update(st_uid=0, st_gid=0)
        fields.update(self.owner_overrides.get((value.st_dev, value.st_ino), {}))
        return SimpleNamespace(**fields)

    def snapshot(self):
        result = {}
        for path in [self.root, *self.root.rglob('*')]:
            info = path.lstat()
            payload = (os.readlink(path) if path.is_symlink() else
                       path.read_bytes() if stat.S_ISREG(info.st_mode) else None)
            result[str(path.relative_to(self.root))] = (
                info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                info.st_nlink, info.st_size, info.st_mtime_ns, payload)
        return result

    def call(self, *, variant_pin=False, denied_leaf=None):
        before = self.snapshot()
        real_open, real_builtin, real_io = os.open, builtins.open, io.open
        opened = []

        def guarded_os_open(path, flags, *args, **kwargs):
            self.assertFalse(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND),
                             'audit must never open files for writing')
            leaf = os.path.basename(os.fsdecode(path))
            self.assertNotEqual(leaf, denied_leaf, 'denied fixture body must never be opened')
            opened.append(leaf)
            return real_open(path, flags, *args, **kwargs)

        def guarded_file_open(original):
            def wrapped(path, mode='r', *args, **kwargs):
                self.assertFalse(any(flag in str(mode) for flag in 'wax+'),
                                 'audit must never open files for writing')
                if not isinstance(path, int):
                    self.assertNotEqual(os.path.basename(os.fsdecode(path)), denied_leaf,
                                        'denied fixture body must never be opened')
                return original(path, mode, *args, **kwargs)
            return wrapped

        with ExitStack() as stack:
            if variant_pin:
                stack.enter_context(mock.patch.object(audit_module, 'TARGET_SHA256',
                                                     hashlib.sha256(self.public_target).hexdigest()))
            stack.enter_context(mock.patch.object(os, 'open', side_effect=guarded_os_open))
            stack.enter_context(mock.patch.object(builtins, 'open', side_effect=guarded_file_open(real_builtin)))
            stack.enter_context(mock.patch.object(io, 'open', side_effect=guarded_file_open(real_io)))
            commands = [stack.enter_context(mock.patch.object(subprocess, name)) for name in ('run', 'Popen')]
            system = stack.enter_context(mock.patch.object(os, 'system'))
            chown = stack.enter_context(mock.patch.object(os, 'chown'))
            fchown = stack.enter_context(mock.patch.object(os, 'fchown'))
            stdout, stderr = io.StringIO(), io.StringIO()
            stack.enter_context(mock.patch('sys.stdout', stdout))
            stack.enter_context(mock.patch('sys.stderr', stderr))
            result = audit_module.audit(root=self.root, metadata=self.metadata, now=NOW)
            for command in [*commands, system, chown, fchown]:
                command.assert_not_called()
            self.assertEqual(stdout.getvalue(), '')
            self.assertEqual(stderr.getvalue(), '')
        self.assertEqual(self.snapshot(), before, 'audit must preserve every fixture file and inode')
        self.assertIsInstance(result, dict)
        self.assertEqual(result['schema'], 1)
        self.assertEqual(result['checkedAt'], NOW)
        self.assertIn(result['status'], ('safe', 'unsafe', 'unknown'))
        self.assertIsInstance(result['reasons'], list)
        self.assertTrue(all(isinstance(reason, str) for reason in result['reasons']))
        self.assertNotIn(SENTINEL, json.dumps(result))
        if result['status'] != 'safe':
            self.assertTrue(result['reasons'], 'a blocked audit must explain its fixed reason')
        return result

    def target_variant(self, injection):
        self.public_target = status_module.CANDIDATE.replace(LOCATION, LOCATION + injection)
        self.write(TARGET, self.public_target)

    def test_pinned_candidate_with_inherited_combined_is_safe_and_bound(self):
        self.assertEqual(audit_module.TARGET_SHA256, status_module.CANDIDATE_SHA)
        result = self.call()
        self.assertEqual(result['status'], 'safe', result)
        self.assertEqual(result['site'], 'fkssj.harvey-ai.xyz')
        self.assertEqual(result['endpoint'], status_module.ENDPOINT)
        self.assertEqual(result['targetSha256'], status_module.CANDIDATE_SHA)
        self.assertRegex(result['configSha256'], r'^[0-9a-f]{64}$')

    def test_multiple_effective_logs_cannot_hide_one_sensitive_format(self):
        self.entry(http="log_format leaked '$http_x_fkssj_signature';\n"
                        'access_log /var/log/nginx/second.log leaked;')
        self.assertEqual(self.call()['status'], 'unsafe')

    def test_sensitive_envelope_body_and_header_variables_are_unsafe(self):
        for variable in ('$http_x_fkssj_envelope', '$request_body', '$http_authorization', '$http_cookie'):
            with self.subTest(variable=variable):
                self.entry(http="log_format leak '" + variable + "';\naccess_log /var/log/nginx/leak.log leak;")
                self.assertEqual(self.call()['status'], 'unsafe')

    def test_location_off_overrides_unsafe_ancestor_logs(self):
        self.entry(http="log_format leaked '$http_x_fkssj_signature';\n"
                        'access_log /var/log/nginx/leaked.log leaked;')
        self.target_variant(b'        access_log off;\n')
        result = self.call(variant_pin=True)
        # The override removes inherited sensitive logging, but disabling the
        # audit trail still needs separate review and is never auto-approved.
        self.assertEqual(result['status'], 'unknown')
        self.assertIn('access_log_disabled_requires_review', result['reasons'])

    def test_unknown_format_variable_and_undefined_format_are_unknown(self):
        for directive in ("log_format custom '$unknown_mapped_value'; access_log /var/log/nginx/a.log custom;",
                          'access_log /var/log/nginx/a.log undefined_format;'):
            with self.subTest(directive=directive):
                self.entry(http=directive)
                self.assertEqual(self.call()['status'], 'unknown')

    def test_debug_error_log_or_debug_connection_is_unsafe(self):
        for top, events in (('error_log /var/log/nginx/error.log debug;', ''),
                            ('', 'debug_connection 127.0.0.1;')):
            with self.subTest(top=top, events=events):
                self.entry(top=top, events=events)
                self.assertEqual(self.call()['status'], 'unsafe')

    def test_unknown_events_directive_is_unknown(self):
        self.entry(events='custom_module_event on;')
        result = self.call()
        self.assertEqual(result['status'], 'unknown')
        self.assertIn('unsupported_events_directive', result['reasons'])

    def test_same_config_through_alias_cannot_replace_earlier_snapshot(self):
        source = '/etc/nginx/sites-available/other-site.conf'
        target = self.write(source, 'server { listen 8080; }\n')
        enabled = self.path('/etc/nginx/sites-enabled')
        enabled.mkdir(mode=0o755)
        (enabled / 'other-site.conf').symlink_to('../sites-available/other-site.conf')
        before = self.snapshot()
        reader = audit_module.Reader(self.root, self.metadata)
        reader.read(source)
        info = target.stat()
        # Public fixture metadata injection only: no real file is touched.
        self.owner_overrides[(info.st_dev, info.st_ino)] = {'st_mtime_ns': info.st_mtime_ns + 1}
        with self.assertRaises(audit_module.Unknown):
            reader.read('/etc/nginx/sites-enabled/other-site.conf')
        self.assertEqual(self.snapshot(), before)

    def test_allowed_glob_include_and_adjacent_quoted_format_are_safe(self):
        self.write('/etc/nginx/snippets/logging.conf',
                   "# " + SENTINEL + "\nlog_format custom '$remote_addr ' \"$status\" ' literal}#';\n")
        self.entry(http='include /etc/nginx/snippets/*.conf;\n'
                        'access_log /var/log/nginx/custom.log custom;')
        self.assertEqual(self.call()['status'], 'safe')

    def test_only_supported_sites_enabled_same_basename_link_is_safe(self):
        self.write('/etc/nginx/sites-available/other-site.conf',
                   'server { listen 8080; server_name example.invalid; access_log off; }\n')
        enabled = self.path('/etc/nginx/sites-enabled')
        enabled.mkdir(mode=0o755)
        (enabled / 'other-site.conf').symlink_to('../sites-available/other-site.conf')
        self.entry(http='include /etc/nginx/sites-enabled/*;')
        self.assertEqual(self.call()['status'], 'safe')

    def test_hy2_include_is_unknown_and_its_body_is_never_opened(self):
        self.write('/etc/nginx/sites-available/hy2-subscription', SENTINEL)
        enabled = self.path('/etc/nginx/sites-enabled')
        enabled.mkdir(mode=0o755)
        (enabled / 'hy2-subscription').symlink_to('../sites-available/hy2-subscription')
        self.entry(http='include /etc/nginx/sites-enabled/*;')
        self.assertEqual(self.call(denied_leaf='hy2-subscription')['status'], 'unknown')

    def test_hy2_named_variants_are_unknown_without_opening_body(self):
        for name in ('hy2-subscription.conf', 'hy2-extra.conf', 'Hy2Alias.conf', 'HY2.conf'):
            with self.subTest(name=name):
                self.setUp()
                self.write('/etc/nginx/conf.d/' + name, SENTINEL)
                result = self.call(denied_leaf=name)
                self.assertEqual(result['status'], 'unknown')
                self.assertIn('sensitive_site_not_read', result['reasons'])

    def test_out_of_allowlist_or_traversal_include_is_unknown_without_open(self):
        for include in ('/etc/ssl/private/INERT-secret.conf', '/etc/nginx/conf.d/../INERT-secret.conf'):
            with self.subTest(include=include):
                self.write('/etc/ssl/private/INERT-secret.conf', SENTINEL)
                self.entry(http='include ' + include + ';')
                self.assertEqual(self.call(denied_leaf='INERT-secret.conf')['status'], 'unknown')

    def test_target_hardlink_symlink_or_wrong_pin_is_unknown(self):
        for kind in ('hardlink', 'symlink', 'changed'):
            with self.subTest(kind=kind):
                self.setUp()
                target = self.path(TARGET)
                if kind == 'hardlink':
                    os.link(target, self.base / 'INERT-second-link')
                elif kind == 'symlink':
                    outside = self.base / 'INERT-outside.conf'
                    outside.write_bytes(status_module.CANDIDATE)
                    target.unlink()
                    target.symlink_to(outside)
                else:
                    target.write_bytes(status_module.CANDIDATE + b'\n# INERT drift\n')
                self.assertEqual(self.call()['status'], 'unknown')

    def test_unsafe_file_parent_permissions_or_owner_are_unknown(self):
        for kind in ('file_mode', 'parent_mode', 'owner'):
            with self.subTest(kind=kind):
                self.setUp()
                target = self.path(ENTRY)
                if kind == 'file_mode':
                    target.chmod(0o666)
                elif kind == 'parent_mode':
                    target.parent.chmod(0o777)
                else:
                    value = target.stat()
                    self.owner_overrides[(value.st_dev, value.st_ino)] = {'st_uid': 1001}
                self.assertEqual(self.call()['status'], 'unknown')

    def test_oversize_or_include_cycle_stops_as_unknown(self):
        for kind in ('oversize', 'cycle'):
            with self.subTest(kind=kind):
                self.setUp()
                if kind == 'oversize':
                    self.write(ENTRY, b'# INERT padding\n' * 100000)
                else:
                    self.write('/etc/nginx/snippets/cycle.conf', 'include /etc/nginx/snippets/cycle.conf;\n')
                    self.entry(http='include /etc/nginx/snippets/cycle.conf;')
                self.assertEqual(self.call()['status'], 'unknown')

    def test_dynamic_path_conditional_syslog_or_map_are_unknown(self):
        for directive in ('access_log /var/log/nginx/$host.log combined;',
                          'access_log /var/log/nginx/a.log combined if=$loggable;',
                          'access_log syslog:server=127.0.0.1:514 combined;',
                          'map $status $loggable { default 1; }'):
            with self.subTest(directive=directive):
                self.entry(http=directive)
                self.assertEqual(self.call()['status'], 'unknown')

    def test_target_internal_redirect_is_unknown_even_with_safe_logs(self):
        self.target_variant(b'        error_page 500 = /INERT-other;\n')
        self.assertEqual(self.call(variant_pin=True)['status'], 'unknown')

    def test_mime_file_is_limited_to_types_and_module_load_is_unknown(self):
        for kind in ('mime', 'module'):
            with self.subTest(kind=kind):
                self.setUp()
                if kind == 'mime':
                    self.write('/etc/nginx/mime.types', 'types { text/html html; }\nerror_log /INERT debug;\n')
                else:
                    self.write('/etc/nginx/modules-enabled/50-INERT.conf', 'load_module /INERT/module.so;\n')
                    self.entry(top='include /etc/nginx/modules-enabled/*.conf;')
                self.assertEqual(self.call()['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()

"""Only fictional temporary nginx trees; no server, real secret, log or service.

The ownership adapter changes metadata in memory, never file ownership. Every
audit checks for writes/processes/network and compares the entire fixture tree.
"""
import builtins
from contextlib import ExitStack
import io
import json
import os
import socket
import subprocess
import sys
import unittest
from unittest import mock

from deploy import nginx_log_audit as old
from deploy import nginx_log_audit_hy2 as subject
from deploy import release_auth_probe as probe
from deploy import test_nginx_log_audit as fixtures


SECRET = 'FICTIONAL-HY2-INLINE-SENSITIVE-DO-NOT-PRINT-4b8e'
NEVER = 'FICTIONAL-REFERENCED-SECRET-DO-NOT-OPEN'
NOW = fixtures.NOW
SAFE = ('server { listen 443 ssl; server_name other.invalid; '
        'ssl_certificate /etc/ssl/NEVER-READ-CERT; '
        'ssl_certificate_key /etc/ssl/NEVER-READ-PRIVATE; '
        'location /opaque { proxy_pass http://127.0.0.1:8081; '
        'proxy_set_header X-Test "' + SECRET + '"; } }\n')


class Hy2AuditTests(unittest.TestCase):
    def setUp(self):
        # Compose the existing fixture helper; do not inherit/run its tests here.
        self.fx = fixtures.NginxLogAuditTests(methodName='runTest')
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.base = subject._base()
        self.fx.write(subject.AVAILABLE, SAFE)
        enabled = self.fx.path(subject.ENABLED)
        enabled.parent.mkdir(mode=0o755)
        enabled.symlink_to('../sites-available/hy2-subscription')
        self.fx.entry(http='include /etc/nginx/sites-enabled/*;')
        self.opened = []

    def config(self, value):
        return self.fx.write(subject.AVAILABLE, value)

    def call(self, *, denied=(), metadata=None):
        before = self.fx.snapshot()
        real_open, real_builtin, real_io = os.open, builtins.open, io.open
        stdout, stderr = io.StringIO(), io.StringIO()
        violations = []
        def guarded_open(path, flags, *args, **kwargs):
            if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                violations.append('write_open_attempt')
            self.assertFalse(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            leaf = os.path.basename(os.fsdecode(path))
            if leaf in denied:
                violations.append('forbidden_read_attempt')
            self.assertNotIn(leaf, denied)
            self.opened.append(leaf)
            return real_open(path, flags, *args, **kwargs)
        def guarded_stream(original):
            def wrapped(path, mode='r', *args, **kwargs):
                if any(flag in str(mode) for flag in 'wax+'):
                    violations.append('write_stream_attempt')
                self.assertFalse(any(flag in str(mode) for flag in 'wax+'))
                if not isinstance(path, int):
                    if os.path.basename(os.fsdecode(path)) in denied:
                        violations.append('forbidden_stream_attempt')
                    self.assertNotIn(os.path.basename(os.fsdecode(path)), denied)
                return original(path, mode, *args, **kwargs)
            return wrapped
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(os, 'open', side_effect=guarded_open))
            stack.enter_context(mock.patch.object(builtins, 'open', side_effect=guarded_stream(real_builtin)))
            stack.enter_context(mock.patch.object(io, 'open', side_effect=guarded_stream(real_io)))
            stack.enter_context(mock.patch.object(sys, 'stdout', stdout))
            stack.enter_context(mock.patch.object(sys, 'stderr', stderr))
            side_effects = [stack.enter_context(mock.patch.object(owner, name)) for owner, name in (
                (socket, 'socket'), (subprocess, 'run'), (subprocess, 'Popen'), (os, 'system'),
                (os, 'chown'), (os, 'fchown'), (os, 'chmod'), (os, 'fchmod'), (os, 'unlink'),
                (os, 'rename'), (os, 'replace'), (os, 'mkdir'))]
            result = subject.audit(root=self.fx.root, metadata=metadata or self.fx.metadata,
                                   now=NOW, _core=self.base)
            for effect in side_effects:
                effect.assert_not_called()
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(stderr.getvalue(), '')
        # These assertions run outside audit's fail-closed exception handler.
        self.assertEqual(violations, [], 'even an attempted forbidden access must fail the test')
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertNotIn(NEVER, json.dumps(result))
        self.assertEqual(self.fx.snapshot(), before)
        self.assertIn(result['status'], ('safe', 'unsafe', 'unknown'))
        self.assertEqual(result['basis'], 'disk_configuration_only_not_running_attestation')
        self.assertEqual(result['checkedAt'], NOW)
        return result

    def unknown(self, value, reason=None):
        self.config(value)
        result = self.call()
        self.assertEqual(result['status'], 'unknown', result)
        if reason:
            self.assertIn(reason, result['reasons'])
        return result

    def test_safe_other_server_is_structural_only_and_full_audit_completes(self):
        result = self.call(denied=('NEVER-READ-CERT', 'NEVER-READ-PRIVATE'))
        self.assertEqual(result['status'], 'safe', result)
        self.assertEqual(result['reasons'], [])
        structure = result['summaries'][-1]
        self.assertEqual(structure, {'scope': 'hy2-structure', 'onlyOtherServers': True,
            'globalLogging': False, 'dynamicDirectives': False, 'furtherInclude': False,
            'couldAffectTarget443': False})
        self.assertTrue(any(item.get('format') == 'combined' for item in result['summaries']))
        self.assertEqual(result['targetSha256'], old.TARGET_SHA256)
        self.assertRegex(result['configSha256'], r'^[0-9a-f]{64}$')

    def test_safe_structural_report_is_compatible_with_existing_probe_gate(self):
        result = self.call()
        self.assertEqual(probe.validate_review(json.dumps(result), NOW), result)
        for blocked in ('unknown', 'unsafe'):
            with self.subTest(blocked=blocked):
                changed = dict(result, status=blocked, reasons=['hy2_structure_ambiguous'])
                with self.assertRaises(probe.ProbeError):
                    probe.validate_review(json.dumps(changed), NOW)

    def test_non443_ipv4_ipv6_wildcard_and_multiple_servers(self):
        for address in ('80', '127.0.0.1:8080', '[::1]:8443', '*:8080'):
            with self.subTest(address=address):
                self.config(SAFE + 'server { listen ' + address + '; server_name second.invalid; return 404; }')
                self.assertEqual(self.call()['status'], 'safe')

    def test_quoted_delimiters_escaped_quotes_and_include_string_are_not_directives(self):
        for literal in ('";{} include fake;"', '"escaped \\\" ' + SECRET + '"',
                        "'literal } ; { include " + SECRET + "'", '"${host} ' + SECRET + '"'):
            with self.subTest(literal=literal):
                self.config('server { listen 443 ssl; server_name other.invalid; location /x { '
                            'proxy_set_header X-Test ' + literal + '; } }')
                self.assertEqual(self.call()['status'], 'safe')

    def test_further_includes_at_any_scope_never_open_reference(self):
        self.fx.write('/etc/nginx/snippets/' + NEVER + '.conf', SECRET)
        for value in ('include /etc/nginx/snippets/' + NEVER + '.conf;\n' + SAFE,
                      SAFE.replace('location /opaque {', 'include /etc/nginx/snippets/' + NEVER + '.conf; location /opaque {'),
                      SAFE.replace('proxy_pass', 'include /etc/nginx/snippets/' + NEVER + '.conf; proxy_pass')):
            with self.subTest(scope=value[:8]):
                self.config(value)
                result = self.call(denied=(NEVER + '.conf',))
                self.assertEqual(result['status'], 'unknown')
                self.assertIn('hy2_further_include_not_read', result['reasons'])
                self.assertTrue(result['summaries'][-1]['furtherInclude'])

    def test_global_logging_and_nonserver_blocks_stop(self):
        for prefix in ('access_log /tmp/' + SECRET + ';',
                       "log_format hidden '" + SECRET + "';", 'error_log /tmp/' + SECRET + ';',
                       'upstream hidden { server 127.0.0.1:8888; }',
                       'stream { server { listen 8888; } }'):
            with self.subTest(prefix=prefix.split()[0]):
                self.unknown(prefix + SAFE, 'hy2_not_only_server_blocks')

    def test_dynamic_directives_stop_without_values(self):
        for directive in ('map $host $opaque { default ' + SECRET + '; }',
                          'load_module /tmp/' + SECRET + ';', 'lua_package_path "' + SECRET + '";',
                          'js_import ' + SECRET + ';', 'perl_set $opaque ' + SECRET + ';',
                          'set $opaque "' + SECRET + '";'):
            with self.subTest(directive=directive.split()[0]):
                self.unknown(directive + SAFE, 'hy2_dynamic_configuration')

    def test_exact_casefolded_and_trailing_dot_target_names_stop(self):
        for name in ('fkssj.harvey-ai.xyz', 'FKSSJ.HARVEY-AI.XYZ', 'fkssj.harvey-ai.xyz.'):
            with self.subTest(name=name):
                result = self.unknown(SAFE.replace('other.invalid', name), 'hy2_target_name_overlap')
                self.assertTrue(result['summaries'][-1]['couldAffectTarget443'])

    def test_regex_wildcard_variable_and_empty_names_stop(self):
        for name in ('*.invalid', '.invalid', '~^other', '$hostname', '""'):
            with self.subTest(name=name):
                self.unknown(SAFE.replace('other.invalid', name), 'hy2_server_name_ambiguous')

    def test_specific_ip_443_no_ssl_default_and_unknown_listeners_stop(self):
        for listener in ('127.0.0.1:443 ssl', '[::1]:443 ssl', '443', '443 ssl default_server',
                         '$opaque:443 ssl', 'unix:/tmp/opaque', '65536 ssl', '443 ssl reuseport'):
            with self.subTest(listener=listener):
                self.unknown(SAFE.replace('443 ssl', listener))

    def test_unknown_blocks_and_directives_stop(self):
        for directive in ('arbitrary_module "' + SECRET + '";',
                          'if ($opaque) { return 404; }', 'opaque_block { return 404; }',
                          'malicious/directive "' + SECRET + '";'):
            with self.subTest(directive=directive.split()[0]):
                self.unknown(SAFE.replace('location /opaque {', directive + ' location /opaque {'))

    def test_types_entries_are_validated_not_read_as_references(self):
        self.config(SAFE.replace('location /opaque {', 'types { application/json json; } location /opaque {'))
        self.assertEqual(self.call()['status'], 'safe')
        self.unknown(SAFE.replace('location /opaque {', 'types { strange/type { return 404; } } location /opaque {'))

    def test_duplicate_or_wrong_inclusion_scope_stops(self):
        for http, top in (('include /etc/nginx/sites-enabled/*; include /etc/nginx/sites-enabled/*;', ''),
                          ('', 'include /etc/nginx/sites-enabled/*;'),
                          ('server { listen 8181; include /etc/nginx/sites-enabled/*; }', ''),
                          ('', '')):
            with self.subTest(scope=http or top or 'absent'):
                self.fx.entry(http=http, top=top)
                self.assertEqual(self.call()['status'], 'unknown')

    def test_direct_available_include_keeps_fixed_link_verification(self):
        self.fx.entry(http='include /etc/nginx/sites-available/hy2-subscription;')
        self.assertEqual(self.call()['status'], 'safe')

    def test_only_exact_two_hy2_paths_gain_permission(self):
        for name in ('hy2-extra.conf', 'hy2-subscription.conf', 'HY2-subscription.conf'):
            with self.subTest(name=name):
                target = self.fx.write('/etc/nginx/conf.d/' + name, SECRET)
                try:
                    result = self.call(denied=(name,))
                    self.assertEqual(result['status'], 'unknown')
                    self.assertIn('sensitive_site_not_read', result['reasons'])
                finally:
                    target.unlink()

    def test_link_must_be_root_owned_exact_destination_not_regular_or_hardlinked(self):
        link = self.fx.path(subject.ENABLED)
        for kind in ('wrong_target', 'regular', 'owner', 'hardlink'):
            with self.subTest(kind=kind):
                link.unlink()
                self.fx.owner_overrides.clear()
                extra = None
                if kind == 'wrong_target':
                    link.symlink_to('../sites-available/' + NEVER)
                elif kind == 'regular':
                    self.fx.write(subject.ENABLED, SAFE)
                else:
                    link.symlink_to('../sites-available/hy2-subscription')
                    if kind == 'owner':
                        info = link.lstat()
                        self.fx.owner_overrides[(info.st_dev, info.st_ino)] = {'st_uid': 1001}
                    else:
                        extra = self.fx.path('/etc/nginx/sites-available/extra-link')
                        os.link(self.fx.path(subject.AVAILABLE), extra)
                self.assertEqual(self.call(denied=(NEVER,))['status'], 'unknown')
                if extra:
                    extra.unlink()

    def test_unsafe_file_parent_metadata_and_oversize_stop(self):
        target = self.fx.path(subject.AVAILABLE)
        for kind in ('file_mode', 'owner', 'parent_mode', 'oversize'):
            with self.subTest(kind=kind):
                self.fx.owner_overrides.clear()
                self.config(SAFE)
                target.parent.chmod(0o755)
                if kind == 'file_mode':
                    target.chmod(0o666)
                elif kind == 'parent_mode':
                    target.parent.chmod(0o777)
                elif kind == 'oversize':
                    self.config('# ' + SECRET * 3000)
                else:
                    info = target.stat()
                    self.fx.owner_overrides[(info.st_dev, info.st_ino)] = {'st_uid': 1001}
                self.assertEqual(self.call()['status'], 'unknown')

    def test_snapshot_race_metadata_stops_without_changing_fixture(self):
        target = self.fx.path(subject.AVAILABLE).stat()
        seen = 0
        def metadata(value):
            nonlocal seen
            result = self.fx.metadata(value)
            if value.st_ino == target.st_ino and value.st_dev == target.st_dev:
                seen += 1
                if seen >= 3:
                    result.st_mtime_ns += 1
            return result
        result = self.call(metadata=metadata)
        self.assertEqual(result['status'], 'unknown')
        self.assertIn('config_changed', result['reasons'])

    def test_malformed_or_invalid_utf8_content_never_leaks(self):
        for value in ('server { ' + SECRET, SAFE + '\x00' + SECRET,
                      'server { listen 443 ssl; server_name "' + SECRET,
                      b'\xff' + SECRET.encode()):
            with self.subTest(kind=type(value).__name__):
                self.unknown(value)

    def test_os_and_unexpected_exception_messages_are_redacted(self):
        for exception in (OSError(SECRET), RuntimeError(SECRET), UnicodeError(SECRET), self.base.Unknown(SECRET)):
            with self.subTest(kind=type(exception).__name__):
                with mock.patch.object(self.base.Reader, 'read', side_effect=exception):
                    result = self.call()
                self.assertEqual(result['reasons'], ['configuration_unreadable_or_unsupported'])

    def test_nested_server_scope_stops(self):
        for nested in ('server { listen 8181; server_name nested.invalid; }',
                       'location /outer { server { listen 8181; server_name nested.invalid; } }'):
            with self.subTest(nested=nested[:20]):
                self.unknown(SAFE.replace('location /opaque {', nested + ' location /opaque {'))

    def test_other_server_debug_error_log_stops(self):
        result = self.unknown(SAFE.replace('location /opaque {',
                              'error_log /tmp/' + SECRET + ' debug; location /opaque {'))
        self.assertTrue(result['reasons'])

    def test_old_audit_permission_remains_unchanged(self):
        with self.assertRaises(old.Unknown):
            old.approved(subject.ENABLED)
        self.assertEqual(self.call()['status'], 'safe')
        with self.assertRaises(old.Unknown):
            old.approved(subject.AVAILABLE)

    def test_main_exceptions_and_arguments_print_only_fixed_json(self):
        for argv, failure, expected in ((['checker', SECRET], False, 'no_arguments_allowed'),
                                        (['checker'], True, 'local_audit_failure')):
            with self.subTest(expected=expected):
                stdout, stderr = io.StringIO(), io.StringIO()
                with mock.patch.object(sys, 'argv', argv), mock.patch.object(sys, 'stdout', stdout), \
                        mock.patch.object(sys, 'stderr', stderr), \
                        mock.patch.object(subject, 'audit', side_effect=RuntimeError(SECRET) if failure else None):
                    code = subject.main()
                self.assertNotEqual(code, 0)
                self.assertEqual(stderr.getvalue(), '')
                self.assertNotIn(SECRET, stdout.getvalue())
                self.assertEqual(json.loads(stdout.getvalue())['reasons'], [expected])


if __name__ == '__main__':
    unittest.main()

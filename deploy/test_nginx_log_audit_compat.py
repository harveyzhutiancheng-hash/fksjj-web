"""Compatibility fixtures are fictional and confined to temporary directories.

No server, actual secret, process, network or permission mutation is used by
an audit. Assertions on forbidden operations run outside its exception handler.
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

from deploy import nginx_log_audit_compat as subject
from deploy import release_auth_probe as probe
from deploy import test_nginx_log_audit as original_fixtures
from deploy import test_nginx_log_audit_bounded as bounded_fixtures

SECRET = 'FICTIONAL-COMPAT-PRIVATE-VALUE-NEVER-ECHO-93ce'
NEVER = 'FICTIONAL-FILE-BODY-NEVER-OPEN-87ad'


class CompatAuditTests(unittest.TestCase):
    def setUp(self):
        self.fixture = bounded_fixtures.BoundedAuditTests(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fx = self.fixture.fx
        self.hy2 = self.fixture.hy2

    def config(self, body):
        self.fixture.config(body)

    def server(self, body='', *, name='other.invalid', listener='443 ssl'):
        self.fx.write(self.hy2.AVAILABLE, 'server { listen ' + listener + '; server_name ' + name + '; '
                      + body + ' location /opaque { return 404; } }')

    def peer(self, *, name='third.invalid', listener='443 ssl', extra=''):
        return self.fx.write('/etc/nginx/conf.d/ordinary-peer.conf',
            'server { listen ' + listener + '; server_name ' + name + '; ' + extra + ' location / { return 404; } }')

    def call(self, *, core=None, denied=(), denied_body=(), metadata=None):
        core = core or subject._modules()
        before = self.fx.snapshot()
        real_open, real_read, real_builtin, real_io = os.open, os.read, builtins.open, io.open
        violations, opened = [], {}
        stdout, stderr = io.StringIO(), io.StringIO()
        def guarded_open(path, flags, *args, **kwargs):
            leaf = os.path.basename(os.fsdecode(path))
            if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                violations.append('write')
                raise AssertionError()
            if leaf in denied:
                violations.append('forbidden_open')
                raise AssertionError()
            fd = real_open(path, flags, *args, **kwargs)
            opened[fd] = leaf
            return fd
        def guarded_read(fd, size):
            if opened.get(fd) in denied_body:
                violations.append('forbidden_body')
                raise AssertionError()
            return real_read(fd, size)
        def guarded_stream(original):
            def wrapped(path, mode='r', *args, **kwargs):
                if any(flag in str(mode) for flag in 'wax+'):
                    violations.append('write_stream')
                    raise AssertionError()
                if not isinstance(path, int) and os.path.basename(os.fsdecode(path)) in (*denied, *denied_body):
                    violations.append('forbidden_stream')
                    raise AssertionError()
                return original(path, mode, *args, **kwargs)
            return wrapped
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(os, 'open', side_effect=guarded_open))
            stack.enter_context(mock.patch.object(os, 'read', side_effect=guarded_read))
            stack.enter_context(mock.patch.object(builtins, 'open', side_effect=guarded_stream(real_builtin)))
            stack.enter_context(mock.patch.object(io, 'open', side_effect=guarded_stream(real_io)))
            stack.enter_context(mock.patch.object(sys, 'stdout', stdout))
            stack.enter_context(mock.patch.object(sys, 'stderr', stderr))
            effects = [stack.enter_context(mock.patch.object(owner, name)) for owner, name in (
                (socket, 'socket'), (subprocess, 'run'), (subprocess, 'Popen'), (os, 'system'),
                (os, 'chmod'), (os, 'fchmod'), (os, 'chown'), (os, 'fchown'), (os, 'unlink'),
                (os, 'rename'), (os, 'replace'), (os, 'mkdir'))]
            result = subject.audit(root=self.fx.root, metadata=metadata or self.fx.metadata,
                                   now=original_fixtures.NOW, _core=core)
            for effect in effects:
                effect.assert_not_called()
        self.assertEqual(violations, [])
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(stderr.getvalue(), '')
        self.assertEqual(self.fx.snapshot(), before)
        encoded = json.dumps(result)
        self.assertNotIn(SECRET, encoded)
        self.assertNotIn(NEVER, encoded)
        self.assertEqual(result['checkedAt'], original_fixtures.NOW)
        self.assertEqual(result['basis'], 'disk_configuration_only_not_running_attestation')
        self.assertEqual(len(result['summaries']), 1)
        summary = result['summaries'][0]
        self.assertLessEqual(len(summary['diagnostics']), subject.MAX_DIAGNOSTICS)
        for item in summary['diagnostics']:
            self.assertEqual(set(item), {'phase', 'code', 'category', 'context', 'count'})
            self.assertIn(item['phase'], ('structure', 'isolation', 'logging'))
            self.assertIn(item['category'], ('server', 'location', 'types', 'conditional', 'method_guard', 'other'))
            self.assertIn(item['context'], subject.CONTEXTS)
            self.assertRegex(item['code'], r'^[a-z0-9_]+$')
            self.assertIs(type(item['count']), int)
            self.assertGreater(item['count'], 0)
        return result

    def blocked(self, result):
        self.assertEqual(result['status'], 'unknown', result)
        self.assertTrue(result['reasons'])
        self.assertFalse(result['summaries'][0]['diskAuditComplete'])
        self.assertEqual(result['summaries'][0]['conditionalGuardsAccepted'], 0)
        self.assertEqual(result['summaries'][0]['methodGuardsAccepted'], 0)
        return result['summaries'][0]

    def test_simple_baseline_and_same_443_literal_peer_are_safe(self):
        self.peer()
        report = self.call()
        self.assertEqual(report['status'], 'safe', report)
        summary = report['summaries'][0]
        self.assertTrue(summary['isolationVerified'])
        self.assertTrue(summary['structureVerified'])
        self.assertTrue(summary['loggingAnalysisComplete'])
        self.assertTrue(summary['snapshotStable'])
        self.assertTrue(summary['diskAuditComplete'])

    def test_if_fixed_scalars_comparison_and_single_returns_are_supported(self):
        conditions = ('$host = other.invalid', '$host != other.invalid',
                      '$request_method = POST', '$request_method != GET', '$scheme = http', '$scheme != https')
        for condition in conditions:
            with self.subTest(condition=condition.split()[0]):
                self.config('if (' + condition + ') { return 403; }')
                result = self.call()
                self.assertEqual(result['status'], 'safe', result)
                self.assertEqual(result['summaries'][0]['conditionalGuardsAccepted'], 1)

    def test_server_context_and_fixed_https_redirect_templates_are_supported(self):
        for target in ('https://$host$request_uri', 'https://other.invalid$request_uri', 'https://other.invalid/'):
            with self.subTest(shape='fixed_https'):
                self.server('if ($host = other.invalid) { return 301 ' + target + '; }')
                result = self.call()
                self.assertEqual(result['status'], 'safe', result)
                self.assertEqual(result['summaries'][0]['conditionalGuardsAccepted'], 1)

    def test_method_guard_fixed_methods_and_deny_all_are_supported(self):
        for methods in ('GET', 'GET HEAD', 'POST PUT DELETE PATCH OPTIONS'):
            with self.subTest(methods=methods):
                self.config('limit_except ' + methods + ' { deny all; }')
                result = self.call()
                self.assertEqual(result['status'], 'safe', result)
                self.assertEqual(result['summaries'][0]['methodGuardsAccepted'], 1)

    def test_types_in_server_and_location_remain_supported(self):
        self.server('types { application/json json; }')
        self.assertEqual(self.call()['status'], 'safe')
        self.config('types { application/json json; }')
        self.assertEqual(self.call()['status'], 'safe')

    def test_complex_conditions_file_tests_regex_headers_and_composition_block(self):
        for condition in ('$host ~ other', '$request_method !~ ^(GET|POST)$',
                          '-f /tmp/' + SECRET, '$http_x_fkssj_signature = ' + SECRET,
                          '$request_body = ' + SECRET, '$host = other.invalid && $scheme = http',
                          '$host = another.invalid', '$scheme = unsupported'):
            with self.subTest(kind=condition.split()[0]):
                self.config('if (' + condition + ') { return 403; }')
                result = self.call()
                summary = self.blocked(result)
                self.assertTrue(summary['loggingAnalysisComplete'])
                self.assertTrue(summary['snapshotStable'])
                self.assertIn('conditional_shape_unknown', result['reasons'])

    def test_complex_return_bodies_and_payloads_are_not_accepted(self):
        for body in ('return 200 "' + SECRET + '";', 'return 403 $http_x_fkssj_signature;',
                     'return 301 https://evil.invalid$request_uri;', 'return 301 http://$host$request_uri;',
                     'return 301 https://other.invalid/?opaque=' + SECRET + ';',
                     'return 403; return 404;', 'rewrite ^ /opaque;', 'set $opaque "' + SECRET + '";',
                     'if ($scheme = http) { return 403; }', 'error_log /tmp/ordinary warn; return 403;'):
            with self.subTest(kind=body.split()[0]):
                self.config('if ($request_method = POST) { ' + body + ' }')
                self.blocked(self.call())

    def test_method_guard_bad_methods_context_body_or_nesting_block(self):
        for body in ('limit_except INVALID { deny all; }', 'limit_except GET GET { deny all; }',
                     'limit_except GET { allow all; }', 'limit_except GET { deny all; deny all; }',
                     'limit_except GET { if ($scheme = http) { return 403; } }',
                     'limit_except GET { error_log /tmp/ordinary warn; deny all; }'):
            with self.subTest(kind=body[:20]):
                self.config(body)
                self.blocked(self.call())
        self.server('limit_except GET { deny all; }')
        self.blocked(self.call())

    def test_hy2_name_casefold_tail_alias_wildcard_and_regex_do_not_misisolate(self):
        for name in ('fkssj.harvey-ai.xyz', 'FKSSJ.HARVEY-AI.XYZ', 'fkssj.harvey-ai.xyz.',
                     'other.invalid fkssj.harvey-ai.xyz', '*.invalid', '.invalid', '~^other', '""', '_'):
            with self.subTest(kind='private_name_shape'):
                self.server('if ($scheme = http) { return 403; }', name=name)
                self.blocked(self.call())

    def test_listener_specific_default_unknown_plain_and_ipv6_do_not_misisolate(self):
        for listener in ('127.0.0.1:443 ssl', '[::1]:443 ssl', '443 ssl default_server',
                         '443 ssl reuseport', '443', '$opaque:443 ssl', '[::]:443 ssl'):
            with self.subTest(listener=listener):
                self.server('if ($scheme = http) { return 403; }', listener=listener)
                self.blocked(self.call())

    def test_other_http_peer_unsafe_names_and_listeners_block_conditional_acceptance(self):
        for name, listener in (('FKSSJ.HARVEY-AI.XYZ.', '443 ssl'), ('*.harvey-ai.xyz', '443 ssl'),
                               ('~^fkssj', '443 ssl'), ('third.invalid', '127.0.0.1:443 ssl'),
                               ('third.invalid', '443 ssl default_server'), ('third.invalid', '[::]:443 ssl')):
            with self.subTest(kind='peer'):
                target = self.peer(name=name, listener=listener)
                try:
                    self.config('if ($scheme = http) { return 403; }')
                    self.blocked(self.call())
                finally:
                    target.unlink()

    def test_debug_error_log_on_nonhy2_peer_blocks_isolation(self):
        self.peer(extra='error_log /tmp/ordinary debug;')
        self.config('if ($scheme = http) { return 403; }')
        result = self.call()
        self.blocked(result)
        self.assertIn('peer_debug_logging', result['reasons'])

    def test_unknown_blocks_collect_all_categories_and_never_echo_unknown_names(self):
        self.config('if ($scheme ~ http) { return 403; } '
                    'limit_except INVALID { allow all; } '
                    'private_' + SECRET + ' { arbitrary_' + SECRET + ' "' + SECRET + '"; } '
                    'types { invalid_mime entry; }')
        result = self.call()
        summary = self.blocked(result)
        codes = {item['code'] for item in summary['diagnostics']}
        self.assertTrue({'conditional_shape_unknown', 'method_guard_shape_unknown', 'block_unknown',
                         'types_shape_unknown'} <= codes)
        self.assertTrue(summary['loggingAnalysisComplete'])
        self.assertTrue(summary['snapshotStable'])
        self.assertEqual(summary['loggingStatus'], 'safe')

    def test_illegal_nested_server_and_types_block_fail_closed(self):
        for body in ('server { listen 8080; server_name nested.invalid; }',
                     'types { application/json { return 404; } }'):
            with self.subTest(kind=body.split()[0]):
                self.config(body)
                self.blocked(self.call())

    def test_unsafe_logging_without_structural_unknown_remains_unsafe(self):
        self.fx.entry(http="log_format hidden '$http_x_fkssj_signature'; access_log /tmp/ordinary hidden; include /etc/nginx/sites-enabled/*;")
        result = self.call()
        self.assertEqual(result['status'], 'unsafe', result)
        summary = result['summaries'][0]
        self.assertTrue(summary['diskAuditComplete'])
        self.assertEqual(summary['loggingStatus'], 'unsafe')

    def test_structure_unknown_and_unsafe_log_remain_overall_unknown(self):
        self.config('unrecognized_block { opaque value; }')
        self.fx.entry(http="log_format hidden '$http_x_fkssj_signature'; access_log /tmp/ordinary hidden; include /etc/nginx/sites-enabled/*;")
        result = self.call()
        summary = self.blocked(result)
        self.assertEqual(summary['loggingStatus'], 'unsafe')
        self.assertIn('sensitive_log_variable', result['reasons'])

    def test_unsafe_log_cannot_hide_unverified_global_dynamic_structure(self):
        self.fx.entry(http="log_format hidden '$http_x_fkssj_signature'; access_log /tmp/ordinary hidden; "
                           'map $host $ordinary { default 1; } include /etc/nginx/sites-enabled/*;')
        result = self.call()
        summary = self.blocked(result)
        self.assertEqual(summary['loggingStatus'], 'unsafe')
        self.assertTrue(summary['loggingAnalysisComplete'])
        self.assertTrue(summary['snapshotStable'])
        self.assertIn('global_analysis_unknown', result['reasons'])
        self.assertIn('unsupported_dynamic_configuration', result['reasons'])

    def test_unknown_global_analysis_never_accepts_otherwise_supported_guards(self):
        self.config('if ($scheme = http) { return 403; }')
        self.fx.entry(http='map $host $ordinary { default 1; } include /etc/nginx/sites-enabled/*;')
        result = self.call()
        summary = self.blocked(result)
        self.assertEqual(summary['loggingStatus'], 'unknown')
        self.assertIn('global_analysis_unknown', result['reasons'])

    def test_partial_peer_analysis_exception_cannot_keep_verified_flag(self):
        def partially_fail(checks, nodes):
            checks.peers_verified = True
            raise RuntimeError(SECRET)
        with mock.patch.object(subject.Checks, 'peers', new=partially_fail):
            self.config('if ($scheme = http) { return 403; }')
            result = self.call()
        summary = self.blocked(result)
        self.assertFalse(summary['isolationVerified'])
        self.assertTrue(summary['loggingAnalysisComplete'])
        self.assertTrue(summary['snapshotStable'])
        self.assertIn('peer_analysis_unknown', result['reasons'])

    def test_logging_exception_is_fixed_and_snapshot_still_checked(self):
        core = subject._modules()
        original_inspect = core[2].inspect
        core[2].inspect = mock.Mock(side_effect=RuntimeError(SECRET))
        try:
            result = self.call(core=core)
            summary = self.blocked(result)
            self.assertFalse(summary['loggingAnalysisComplete'])
            self.assertTrue(summary['snapshotStable'])
            self.assertIn('log_analysis_unknown', result['reasons'])
        finally:
            core[2].inspect = original_inspect

    def test_structure_exception_is_fixed_and_other_phases_continue(self):
        with mock.patch.object(subject.Checks, 'structure', side_effect=RuntimeError(SECRET)):
            result = self.call()
        summary = self.blocked(result)
        self.assertTrue(summary['loggingAnalysisComplete'])
        self.assertTrue(summary['snapshotStable'])
        self.assertIn('structure_analysis_unknown', result['reasons'])

    def test_snapshot_failure_does_not_claim_complete_disk_acceptance(self):
        core = subject._modules()
        with mock.patch.object(core[2].Reader, 'unchanged', side_effect=core[2].Unknown('config_changed')):
            result = self.call(core=core)
        summary = self.blocked(result)
        self.assertTrue(summary['loggingAnalysisComplete'])
        self.assertFalse(summary['snapshotStable'])
        self.assertIn('config_changed', result['reasons'])

    def test_private_hooks_restore_on_success_and_failure(self):
        core = subject._modules()
        bounded, hy2, base = core
        originals = (hy2.structure, base.inspect, base.approved)
        self.call(core=core)
        self.assertEqual((hy2.structure, base.inspect, base.approved), originals)
        self.config('unknown_block { arbitrary value; }')
        self.call(core=core)
        self.assertEqual((hy2.structure, base.inspect, base.approved), originals)

    def test_original_ast_reaches_logging_with_unknown_and_supported_blocks_intact(self):
        core = subject._modules()
        captured = []
        original = core[2].inspect
        def inspect(nodes):
            captured.extend((node.name, tuple(node.args)) for node in core[2].walk(nodes))
            return original(nodes)
        core[2].inspect = inspect
        self.config('if ($scheme = http) { return 403; } unrecognized_block { opaque value; }')
        self.blocked(self.call(core=core))
        self.assertIn(('unrecognized_block', ()), captured)
        self.assertIn(('if', ('($scheme', '=', 'http)')), captured)

    def test_diagnostic_limit_is_fail_closed_and_does_not_emit_inputs(self):
        core = subject._modules()
        checks = subject.Checks(core[1], core[2])
        for index in range(subject.MAX_DIAGNOSTICS + 8):
            checks.event('fixture_code_' + str(index))
        self.assertEqual(len(checks.diagnostics()), subject.MAX_DIAGNOSTICS)
        self.assertIn('diagnostic_limit', checks.issues)
        with mock.patch.object(subject, 'MAX_DIAGNOSTICS', 1):
            self.config('if ($scheme ~ http) { return 403; } limit_except INVALID { allow all; }')
            result = self.call()
            self.blocked(result)
            self.assertIn('diagnostic_limit', result['reasons'])

    def test_capped_isolation_failure_still_blocks_peer_verification(self):
        core = subject._modules()
        hy2, base = core[1:]
        checks = subject.Checks(hy2, base)
        checks.local_isolated = True
        target = hy2.raw_nodes(base, ('server { listen 443 ssl; server_name ' + base.SITE + '; }').encode(), base.TARGET)
        nodes = [base.Node('http', [], target, base.ENTRY)]
        with mock.patch.object(subject, 'MAX_DIAGNOSTICS', 1):
            checks.event('conditional_shape_supported', issue=False)
            checks.event('target_name_overlap', phase='isolation')
            self.assertTrue(checks.isolation_failed)
            self.assertEqual(len(checks.diagnostics()), 1)
            checks.peers(nodes)
        self.assertFalse(checks.peers_verified)
        self.assertIn('diagnostic_limit', checks.issues)

    def test_safe_report_keeps_probe_schema_contract_and_unknown_is_rejected(self):
        self.config('if ($request_method = POST) { return 403; }')
        report = self.call()
        probe.validate_review(json.dumps(report), original_fixtures.NOW)
        self.config('unknown_block { opaque value; }')
        report = self.call()
        with self.assertRaises(probe.ProbeError):
            probe.validate_review(json.dumps(report), original_fixtures.NOW)

    def test_read_scope_outside_variable_glob_and_secret_bait_stays_closed(self):
        for expression in ('/var/tmp/ordinary.conf', '/etc/nginx/parts/../ordinary.conf',
                           'parts/$opaque.conf', 'parts/*.conf'):
            with self.subTest(kind='out_of_scope'):
                self.config('include ' + expression + ';')
                self.fixture.fragment('ordinary.conf', NEVER)
                self.blocked(self.call(denied=('ordinary.conf',)))
        self.server('ssl_certificate_key /etc/nginx/parts/ordinary.conf; include parts/ordinary.conf;')
        self.blocked(self.call(denied=('ordinary.conf',)))

    def test_read_limit_depth_and_bytes_stay_closed_before_target_body(self):
        self.config('include parts/oversize.conf;')
        self.fixture.fragment('oversize.conf', '#' + 'x' * 65536)
        self.blocked(self.call(denied_body=('oversize.conf',)))
        self.config('include parts/a.conf;')
        for current, following in (('a','b'),('b','c'),('c','d'),('d','e')):
            self.fixture.fragment(current + '.conf', 'include parts/' + following + '.conf;')
        self.fixture.fragment('e.conf', NEVER)
        self.blocked(self.call(denied=('e.conf',)))

    def test_main_argument_and_unexpected_failure_stdout_is_fixed(self):
        for argv, failure in ((['audit', SECRET], False), (['audit'], True)):
            out, err = io.StringIO(), io.StringIO()
            with mock.patch.object(sys, 'argv', argv), mock.patch.object(sys, 'stdout', out), \
                    mock.patch.object(sys, 'stderr', err), \
                    mock.patch.object(subject, 'audit', side_effect=RuntimeError(SECRET) if failure else None):
                code = subject.main()
            self.assertNotEqual(code, 0)
            self.assertEqual(err.getvalue(), '')
            self.assertNotIn(SECRET, out.getvalue())
            self.assertEqual(json.loads(out.getvalue())['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()

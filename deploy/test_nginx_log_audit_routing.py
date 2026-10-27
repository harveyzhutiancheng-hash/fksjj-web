"""Fictional TCP443 routing trees only; no actual server or secrets."""
import builtins
from contextlib import ExitStack
import hashlib
import io
import json
import os
import socket
import subprocess
import sys
import unittest
from unittest import mock

from deploy import nginx_log_audit_routing as subject
from deploy import release_auth_probe as probe
from deploy import test_nginx_log_audit as original_fixtures
from deploy import test_nginx_log_audit_compat as fixtures

SECRET = 'FICTIONAL-ROUTING-INLINE-PRIVATE-NEVER-PRINT-71ac'
NEVER = 'FICTIONAL-ROUTING-REFERENCE-NEVER-OPEN-62bd'
CONTEXTS = frozenset('root server location types conditional method_guard other'.split())


class RoutingAuditTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CompatAuditTests(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fx, self.hy2 = self.fixture.fx, self.fixture.hy2

    def server(self, body='', *, name='other.invalid', listener='443 ssl'):
        self.fixture.server(body, name=name, listener=listener)

    def peer(self, *, name='third.invalid', listener='443 ssl', extra=''):
        return self.fixture.peer(name=name, listener=listener, extra=extra)

    def config(self, body):
        self.fixture.config(body)

    def reset_peer(self):
        path = self.fx.path('/etc/nginx/conf.d/ordinary-peer.conf')
        if path.exists():
            path.unlink()

    def safe(self, report):
        self.assertEqual(report['status'], 'safe', report)
        s=report['summaries'][0]
        self.assertTrue(s['diskAuditComplete'])
        self.assertTrue(s['isolationVerified'])
        self.assertTrue(s['structureVerified'])
        self.assertTrue(s['loggingAnalysisComplete'])
        self.assertTrue(s['snapshotStable'])
        self.assertTrue(s['defaultPhaseLogsChecked'])
        return s

    def codes(self, report):
        return {item['code'] for item in report['summaries'][0]['diagnostics']}

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
        self.assertLessEqual(len(summary['diagnostics']), 64)
        for item in summary['diagnostics']:
            self.assertEqual(set(item), {'phase', 'code', 'category', 'context', 'count'})
            self.assertIn(item['phase'], ('structure', 'isolation', 'logging'))
            self.assertIn(item['category'], ('server', 'location', 'types', 'conditional', 'method_guard', 'other'))
            self.assertIn(item['context'], CONTEXTS)
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

    def test_non443_names_and_common_options_do_not_block(self):
        for name in ('_', '""', '$hostname', '*.invalid', '~^opaque'):
            for listener in ('80 default_server', '8080 backlog=511', '[::]:8080 ipv6only=on', '127.0.0.1', 'localhost:8080'):
                with self.subTest(kind='known_non443'):
                    self.peer(name=name, listener=listener)
                    s=self.safe(self.call())
                    self.assertGreaterEqual(s['serversOutsideTcp443'], 1)
                    self.reset_peer()

    def test_non443_hy2_guards_with_default_or_tuning_are_supported(self):
        for listener in ('80 default_server', '8080 reuseport', '127.0.0.1', '[::1]', 'localhost'):
            with self.subTest(kind='hy2_non443'):
                self.server('location /method { limit_except GET { deny all; } }', name='_', listener=listener)
                s=self.safe(self.call())
                self.assertEqual(s['methodGuardsAccepted'],1)

    def test_implicit_listen_and_name_are_non443(self):
        self.fx.write('/etc/nginx/conf.d/ordinary-peer.conf','server { location / { return 404; } }')
        r=self.call(); self.safe(r)
        self.assertIn('implicit_listener_non443',self.codes(r))
        self.assertNotIn('server_name_unknown',r['reasons'])

    def test_unix_and_quic_only_are_outside_fixed_tcp_client(self):
        for listener in ('unix:/var/run/ordinary.sock', '443 quic reuseport'):
            with self.subTest(kind='different_transport'):
                self.peer(name='$hostname',listener=listener)
                self.safe(self.call())
                self.reset_peer()

    def test_mixed_listeners_keep_tcp443_analysis(self):
        for extra in ('listen 8080;', 'listen 443 quic reuseport;', 'listen unix:/var/run/ordinary.sock;'):
            with self.subTest(kind='mixed'):
                self.server(extra+' location /method { limit_except GET { deny all; } }',name='_')
                s=self.safe(self.call())
                self.assertEqual(s['methodGuardsAccepted'],1)

    def test_exact_target_wins_same_group_placeholder_empty_wildcard_and_regex(self):
        for name in ('_', '""', '*.harvey-ai.xyz', '.harvey-ai.xyz', 'fkssj.*', '~^fkssj', '"~(a+)+$"'):
            with self.subTest(kind='lower_priority_or_nonmatching'):
                self.server('location /method { limit_except GET { deny all; } }',name=name)
                r=self.call();s=self.safe(r)
                self.assertEqual(s['methodGuardsAccepted'],1)
                if '*' in name or name.startswith('.') or '~' in name:
                    self.assertIn('name_lower_priority_than_exact_target',self.codes(r))

    def test_nonhy2_lower_priority_peers_same_group_are_supported(self):
        for name in ('_', '""', '*.harvey-ai.xyz', '.harvey-ai.xyz', '~^fkssj'):
            with self.subTest(kind='peer_priority'):
                self.peer(name=name)
                self.safe(self.call())
                self.reset_peer()

    def test_repeated_server_name_directives_merge_without_values_in_output(self):
        self.peer(name='_',extra='server_name third.invalid;')
        self.safe(self.call())

    def test_target_exact_name_alias_case_and_trailing_dot_stay_blocked(self):
        for name in ('fkssj.harvey-ai.xyz','FKSSJ.HARVEY-AI.XYZ.','third.invalid fkssj.harvey-ai.xyz'):
            with self.subTest(kind='exact_overlap'):
                self.peer(name=name)
                r=self.call();self.blocked(r)
                self.assertIn('target_name_overlap',r['reasons'])
                self.reset_peer()

    def test_dynamic_and_unmodeled_names_on_tcp443_stay_unknown(self):
        for name,code in (('$hostname','server_name_dynamic_unmodeled'),('$opaque','server_name_dynamic_unmodeled'),
                          ('"!@#"','server_name_literal_unmodeled'),('~','server_name_literal_unmodeled')):
            with self.subTest(kind='unknown_name'):
                self.peer(name=name)
                r=self.call();self.blocked(r);self.assertIn(code,r['reasons'])
                self.reset_peer()

    def test_specific_ipv4_ipv6_and_missing_family_cannot_steal_route(self):
        for listener,code in (('127.0.0.1:443 ssl','specific_tcp443_target_uncovered'),
                              ('[::1]:443 ssl','specific_tcp443_target_uncovered'),
                              ('[::]:443 ssl ipv6only=on','tcp443_family_target_uncovered'),
                              ('[::]:443 ssl ipv6only=off','tcp443_dual_stack_unmodeled'),
                              ('localhost:443 ssl','tcp443_hostname_address_unresolved')):
            with self.subTest(kind='uncovered_binding'):
                self.server(name='_',listener=listener)
                r=self.call();self.blocked(r);self.assertIn(code,r['reasons'])

    def test_target_covering_ipv6_or_specific_group_is_supported_with_explicit_test_pin(self):
        original=self.fx.public_target
        for listener in ('[::]:443 ssl ipv6only=on','127.0.0.1:443 ssl'):
            with self.subTest(kind='fixture_target_coverage'):
                # This temporary fixture pin is never the production target pin.
                variant=original.replace(b'    listen 443 ssl;',b'    listen 443 ssl;\n    listen '+listener.encode()+b';')
                self.assertNotEqual(variant,original)
                self.fx.write(original_fixtures.TARGET,variant)
                self.server(name='_',listener=listener)
                core=subject._modules();core[3].TARGET_SHA256=hashlib.sha256(variant).hexdigest()
                self.safe(self.call(core=core))
        self.fx.write(original_fixtures.TARGET,original)

    def test_default_server_same_group_is_supported_with_safe_error_log(self):
        self.peer(name='_',listener='443 ssl default_server',extra='error_log /tmp/ordinary warn;')
        r=self.call();self.safe(r)
        self.assertIn('explicit_default_recognized',self.codes(r))

    def test_duplicate_defaults_are_unknown(self):
        self.server(name='_',listener='443 ssl default_server')
        self.peer(listener='443 ssl default_server')
        r=self.call();self.blocked(r);self.assertIn('tcp443_default_conflict',r['reasons'])

    def test_default_error_logging_debug_sink_and_level_are_not_ignored(self):
        for directive,code in (('error_log /tmp/ordinary debug;','default_debug_error_log'),
                               ('error_log syslog:server=127.0.0.1:514 warn;','default_error_log_sink_unmodeled'),
                               ('error_log memory:32m warn;','default_error_log_sink_unmodeled'),
                               ('error_log /tmp/ordinary strange;','default_error_log_level_unmodeled')):
            with self.subTest(kind='default_logging'):
                self.peer(name='_',listener='443 ssl default_server',extra=directive)
                r=self.call();s=self.blocked(r)
                self.assertIn(code,r['reasons'])
                self.assertTrue(s['loggingAnalysisComplete']);self.assertTrue(s['snapshotStable'])
                self.reset_peer()

    def test_main_http_default_phase_logs_are_checked_before_target_location(self):
        for scope in ('main','http'):
            with self.subTest(scope=scope):
                text='error_log /tmp/ordinary debug;'
                self.fx.entry(top=text if scope=='main' else '',http=(text if scope=='http' else '')+' include /etc/nginx/sites-enabled/*;')
                r=self.call();self.blocked(r);self.assertIn('default_debug_error_log',r['reasons'])

    def test_nondefault_peer_location_logging_is_not_mistaken_for_default_phase(self):
        self.peer(extra='location /other { error_log /tmp/ordinary debug; }')
        self.safe(self.call())

    def test_default_location_debug_is_not_early_default_error_logging(self):
        self.server('location /debug { error_log /tmp/ordinary debug; }')
        self.safe(self.call())
        self.peer(name='_',listener='443 ssl default_server',extra='location /debug { error_log /tmp/ordinary debug; }')
        self.safe(self.call())

    def test_nondefault_hy2_root_debug_does_not_replace_selected_default_scope(self):
        self.server('error_log /tmp/ordinary debug;')
        self.peer(name='_',listener='443 ssl default_server',extra='error_log /tmp/ordinary notice;')
        self.safe(self.call())

    def test_hy2_implicit_default_root_debug_stays_unknown(self):
        # Fixture entry includes hy2 before the pinned target conf.d server.
        self.server('error_log /tmp/ordinary debug;')
        r=self.call();self.blocked(r)
        self.assertIn('default_debug_error_log',r['reasons'])

    def test_implicit_peer_before_target_is_the_default_and_debug_blocks(self):
        self.fx.write('/etc/nginx/snippets/earlier.conf',
            'server { listen 443 ssl; server_name _; error_log /tmp/ordinary debug; }')
        self.fx.entry(http='include /etc/nginx/snippets/earlier.conf; include /etc/nginx/sites-enabled/*;')
        r=self.call();self.blocked(r)
        self.assertIn('default_debug_error_log',r['reasons'])

    def test_invalid_error_log_syntax_or_severity_is_not_ignored_in_unused_location(self):
        for directive in ('error_log;', 'error_log /tmp/ordinary strange;', 'error_log /tmp/ordinary notice extra;'):
            with self.subTest(kind='invalid_log_shape'):
                self.server('location /debug { '+directive+' }')
                self.blocked(self.call())

    def test_ssl_http2_and_group_inherited_tls_are_supported(self):
        for listener in ('443 ssl http2','443 http2','443','*:443 ssl','0.0.0.0:443 ssl'):
            with self.subTest(kind='known_tls_group'):
                self.server(listener=listener)
                self.safe(self.call())

    def test_common_socket_tuning_parameters_are_classified(self):
        for option in ('bind','reuseport','deferred','backlog=511','fastopen=10','rcvbuf=64k','sndbuf=1m',
                       'so_keepalive=on','so_keepalive=off','so_keepalive=30m::10'):
            with self.subTest(kind='known_tuning'):
                self.server(listener='443 ssl '+option)
                r=self.call();self.safe(r);self.assertIn('socket_tuning_recognized',self.codes(r))

    def test_socket_parameter_conflicts_are_unknown(self):
        self.server(listener='443 ssl backlog=511')
        self.peer(listener='443 ssl backlog=1024')
        r=self.call();self.blocked(r);self.assertIn('tcp443_socket_option_conflict',r['reasons'])

    def test_duplicate_unknown_protocol_and_invalid_option_values_stay_unknown(self):
        for listener,code in (('443 ssl ssl','listen_option_duplicate'),
                              ('443 ssl private_'+SECRET,'listen_option_unmodeled'),
                              ('443 ssl backlog=0','listen_option_unmodeled'),
                              ('443 ssl ipv6only=on','listen_family_option_invalid'),
                              ('443 quic http2','listen_protocol_combination_unmodeled'),
                              ('443 ssl proxy_protocol','tcp443_proxy_protocol_unmodeled'),
                              ('443 ssl so_keepalive=::','listen_option_unmodeled'),
                              ('443 ssl rcvbuf=oops','listen_option_unmodeled')):
            with self.subTest(kind='invalid_or_unknown_option'):
                self.server(listener=listener)
                r=self.call();self.blocked(r);self.assertIn(code,r['reasons'])

    def test_unknown_non443_options_are_not_blanket_ignored(self):
        self.peer(name='_',listener='8080 unknown_'+SECRET)
        r=self.call();self.blocked(r);self.assertIn('listen_option_unmodeled',r['reasons'])

    def test_bad_ports_addresses_and_duplicate_binding_are_unknown(self):
        for listener in ('0 ssl','65536 ssl','[not-ip]:443 ssl','999.1.2.3:443 ssl','$opaque:443 ssl'):
            with self.subTest(kind='bad_binding'):
                self.server(listener=listener);self.blocked(self.call())
        self.server('listen 443 ssl;')
        r=self.call();self.blocked(r);self.assertIn('duplicate_tcp443_binding',r['reasons'])

    def test_same_server_unknown_option_is_reported_once_not_local_and_global(self):
        self.server(listener='443 ssl unknown_'+SECRET)
        r=self.call();self.blocked(r)
        entries=[d for d in r['summaries'][0]['diagnostics'] if d['code']=='listen_option_unmodeled']
        self.assertEqual(len(entries),1);self.assertEqual(entries[0]['count'],1)

    def test_unexpected_listener_exception_and_unknown_exception_code_are_redacted(self):
        for exception in (subject.Unmodeled(SECRET), RuntimeError(SECRET)):
            with self.subTest(kind=type(exception).__name__):
                with mock.patch.object(subject,'listener',side_effect=exception):
                    r=self.call()
                self.blocked(r)
                self.assertIn('listen_analysis_unknown',r['reasons'])

    def test_diagnostic_cap_preserves_fail_closed_isolation(self):
        core=subject._modules()
        with mock.patch.object(core[0],'MAX_DIAGNOSTICS',1):
            self.server(listener='443 ssl unknown_'+SECRET)
            self.peer(name='_',listener='443 ssl default_server')
            r=self.call(core=core)
        s=self.blocked(r)
        self.assertFalse(s['isolationVerified'])
        self.assertIn('diagnostic_limit',r['reasons'])
        self.assertEqual(len(s['diagnostics']),1)

    def test_private_valid_name_is_not_echoed_by_success_diagnostics(self):
        self.server(name=SECRET+'.invalid',listener='443 ssl default_server reuseport')
        self.safe(self.call())

    def test_complex_unknown_structure_remains_intact_and_blocks(self):
        core=subject._modules();captured=[];original=core[3].inspect
        def inspect(nodes):
            captured.extend(n.name for n in core[3].walk(nodes))
            return original(nodes)
        core[3].inspect=inspect
        self.config('if ($scheme ~ http) { return 403; } unknown_'+SECRET+' { opaque value; }')
        r=self.call(core=core);s=self.blocked(r)
        self.assertIn('conditional_shape_unknown',r['reasons']);self.assertIn('block_unknown',r['reasons'])
        self.assertIn('unknown_'+SECRET,captured)
        self.assertTrue(s['loggingAnalysisComplete']);self.assertTrue(s['snapshotStable'])

    def test_sensitive_global_logging_cannot_be_masked_by_routing_success(self):
        self.fx.entry(http="log_format hidden '$http_x_fkssj_signature'; access_log /tmp/ordinary hidden; include /etc/nginx/sites-enabled/*;")
        r=self.call();self.assertEqual(r['status'],'unsafe',r)
        self.assertEqual(r['summaries'][0]['loggingStatus'],'unsafe')

    def test_read_limits_and_secret_bait_are_unchanged(self):
        for expression in ('/var/tmp/ordinary.conf','parts/$opaque.conf','parts/*.conf','parts/../ordinary.conf'):
            with self.subTest(kind='read_scope'):
                self.fixture.fixture.fragment('ordinary.conf',NEVER)
                self.config('include '+expression+';')
                self.blocked(self.call(denied=('ordinary.conf',)))
        self.server('ssl_certificate_key /etc/nginx/parts/ordinary.conf; include parts/ordinary.conf;')
        self.blocked(self.call(denied=('ordinary.conf',)))
        self.server('include parts/oversize.conf;')
        self.fixture.fixture.fragment('oversize.conf','#'+'x'*65536)
        self.blocked(self.call(denied_body=('oversize.conf',)))

    def test_snapshot_failure_stays_unknown_with_hooks_restored(self):
        core=subject._modules();compat,bounded,hy2,base=core
        originals=(compat.Checks,hy2.structure,base.inspect,base.approved)
        with mock.patch.object(base.Reader,'unchanged',side_effect=base.Unknown('config_changed')):
            r=self.call(core=core)
        s=self.blocked(r);self.assertFalse(s['snapshotStable'])
        self.assertEqual((compat.Checks,hy2.structure,base.inspect,base.approved),originals)

    def test_hooks_restore_after_success_and_structure_failure(self):
        core=subject._modules();compat,bounded,hy2,base=core
        originals=(compat.Checks,hy2.structure,base.inspect,base.approved)
        self.safe(self.call(core=core))
        self.assertEqual((compat.Checks,hy2.structure,base.inspect,base.approved),originals)
        self.config('unknown_block { opaque value; }');self.blocked(self.call(core=core))
        self.assertEqual((compat.Checks,hy2.structure,base.inspect,base.approved),originals)

    def test_probe_report_schema_and_unknown_gate_remain_compatible(self):
        r=self.call();self.safe(r);probe.validate_review(json.dumps(r),original_fixtures.NOW)
        self.server(listener='[::]:443 ssl');r=self.call();self.blocked(r)
        with self.assertRaises(probe.ProbeError):
            probe.validate_review(json.dumps(r),original_fixtures.NOW)

    def test_main_never_prints_arguments_or_exception_details(self):
        for argv,failure in ((['audit',SECRET],False),(['audit'],True)):
            out,err=io.StringIO(),io.StringIO()
            with mock.patch.object(sys,'argv',argv),mock.patch.object(sys,'stdout',out),mock.patch.object(sys,'stderr',err),mock.patch.object(subject,'audit',side_effect=RuntimeError(SECRET) if failure else None):
                code=subject.main()
            self.assertNotEqual(code,0);self.assertEqual(err.getvalue(),'');self.assertNotIn(SECRET,out.getvalue())


if __name__ == '__main__':
    unittest.main()

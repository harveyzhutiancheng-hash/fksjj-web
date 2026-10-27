"""Fictional read-only config trees; no actual server, key, log or network."""
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

from deploy import nginx_log_audit_bounded as subject
from deploy import release_auth_probe as probe
from deploy import test_nginx_log_audit as fixtures


SECRET = 'FICTIONAL-BOUNDED-INLINE-SENSITIVE-NEVER-PRINT-51ad'
NEVER = 'FICTIONAL-BODY-NEVER-OPEN-32ab'
SAFE = ('server { listen 443 ssl; server_name other.invalid; '
        'location /opaque { proxy_pass http://127.0.0.1:8081; BODY } }\n')


class BoundedAuditTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixtures.NginxLogAuditTests(methodName='runTest')
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.hy2, self.base = subject._modules()
        self.fx.write(self.hy2.AVAILABLE, SAFE.replace('BODY', ''))
        enabled = self.fx.path(self.hy2.ENABLED)
        enabled.parent.mkdir(mode=0o755)
        enabled.symlink_to('../sites-available/hy2-subscription')
        self.fx.entry(http='include /etc/nginx/sites-enabled/*;')

    def config(self, body):
        self.fx.write(self.hy2.AVAILABLE, SAFE.replace('BODY', body))

    def fragment(self, name, body):
        logical = '/etc/nginx/parts/' + name
        return self.fx.write(logical, body)

    def include(self, name):
        return 'include /etc/nginx/parts/' + name + '; '

    def call(self, *, denied=(), denied_body=(), metadata=None, core=None, read_filter=None):
        core = core or subject._modules()
        before = self.fx.snapshot()
        real_open, real_read, real_builtin, real_io = os.open, os.read, builtins.open, io.open
        violations, opened, read_bodies, read_sizes = [], {}, [], []
        out, err = io.StringIO(), io.StringIO()
        def guarded_open(path, flags, *args, **kwargs):
            leaf = os.path.basename(os.fsdecode(path))
            if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                violations.append('write_open')
                raise AssertionError()
            if leaf in denied:
                violations.append('forbidden_open')
                raise AssertionError()
            fd = real_open(path, flags, *args, **kwargs)
            opened[fd] = leaf
            return fd
        def guarded_read(fd, size):
            leaf = opened.get(fd)
            if leaf in denied_body:
                violations.append('forbidden_body')
                raise AssertionError()
            read_bodies.append(leaf)
            data = real_read(fd, size) if read_filter is None else read_filter(leaf, fd, size, real_read)
            read_sizes.append((leaf, size, len(data)))
            return data
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
            stack.enter_context(mock.patch.object(sys, 'stdout', out))
            stack.enter_context(mock.patch.object(sys, 'stderr', err))
            effects = [stack.enter_context(mock.patch.object(owner, name)) for owner, name in (
                (socket, 'socket'), (subprocess, 'run'), (subprocess, 'Popen'), (os, 'system'),
                (os, 'chmod'), (os, 'fchmod'), (os, 'chown'), (os, 'fchown'),
                (os, 'unlink'), (os, 'rename'), (os, 'replace'), (os, 'mkdir'))]
            result = subject.audit(root=self.fx.root, metadata=metadata or self.fx.metadata,
                                   now=fixtures.NOW, _core=core)
            for effect in effects:
                effect.assert_not_called()
        # Assertions outside the audit exception handler cannot be swallowed.
        self.assertEqual(violations, [])
        self.assertEqual(out.getvalue(), '')
        self.assertEqual(err.getvalue(), '')
        self.assertEqual(self.fx.snapshot(), before)
        self.assertNotIn(SECRET, json.dumps(result))
        self.assertNotIn(NEVER, json.dumps(result))
        self.assertEqual(result['checkedAt'], fixtures.NOW)
        self.assertEqual(result['basis'], 'disk_configuration_only_not_running_attestation')
        self.assertEqual(len(result['summaries']), 1)
        for value in result['summaries'][0].values():
            self.assertTrue(value is None or type(value) in (bool, int) or value == 'bounded-config-closure')
        self.last_read_bodies = read_bodies
        self.last_read_sizes = read_sizes
        return result

    def blocked(self, result, reason=None):
        self.assertEqual(result['status'], 'unknown', result)
        self.assertTrue(result['reasons'])
        if reason:
            self.assertIn(reason, result['reasons'])

    def test_no_reference_still_finishes_full_audit(self):
        result = self.call()
        self.assertEqual(result['status'], 'safe', result)
        self.assertTrue(result['summaries'][0]['diskAuditComplete'])
        self.assertFalse(result['summaries'][0]['includeFound'])

    def test_literal_nested_relative_and_absolute_closure_is_safe(self):
        self.config(self.include('a.conf'))
        self.fragment('a.conf', 'include parts/b.conf;')
        self.fragment('b.conf', 'proxy_set_header X-Test "' + SECRET + '";')
        result = self.call()
        self.assertEqual(result['status'], 'safe', result)
        self.assertEqual(result['summaries'][0]['referencedFileCount'], 2)
        self.assertEqual(result['summaries'][0]['deepestReference'], 2)
        self.assertTrue(result['summaries'][0]['referencesComplete'])

    def test_quoted_literal_and_delimiters_do_not_leak(self):
        self.config('include "parts/a.conf";')
        self.fragment('a.conf', 'proxy_set_header X-Test "literal ;{} include fake; ' + SECRET + '";')
        self.assertEqual(self.call()['status'], 'safe')

    def test_path_escape_prefix_empty_component_and_outside_are_never_opened(self):
        for expression in ('/etc/nginx/parts/../escape.conf', '/etc/nginxish/escape.conf',
                           '/etc/nginx//escape.conf', '/etc/nginx/./escape.conf',
                           '/var/tmp/escape.conf', '../escape.conf'):
            with self.subTest(expression=expression):
                self.config('include ' + expression + ';')
                self.blocked(self.call(denied=('escape.conf',)), 'closure_path_not_allowed')

    def test_variable_and_glob_references_never_open_targets(self):
        for expression in ('parts/$opaque.conf', 'parts/${opaque}.conf',
                           'parts/*.conf', 'parts/a?.conf', 'parts/[ab].conf'):
            with self.subTest(expression=expression):
                self.config('include ' + expression + ';')
                self.fragment('a.conf', NEVER)
                self.blocked(self.call(denied=('a.conf',)))

    def test_sensitive_names_and_extensions_never_open_targets(self):
        for name in ('private.conf', 'cert-options.conf', 'password.conf', 'passwd.conf',
                     'secret.conf', 'credential.conf', 'token.conf', 'my-key.conf',
                     'access-log.conf', 'ordinary.pem', 'ordinary.crt', 'ordinary.key',
                     'ordinary.log', 'ordinary.htpasswd'):
            with self.subTest(name=name):
                self.config(self.include(name))
                self.fragment(name, NEVER)
                self.blocked(self.call(denied=(name,)), 'closure_sensitive_target')

    def test_regular_non_config_extension_is_not_opened(self):
        self.config(self.include('ordinary.txt'))
        self.fragment('ordinary.txt', NEVER)
        self.blocked(self.call(denied=('ordinary.txt',)), 'closure_config_type_unknown')

    def test_other_directive_references_are_not_followed(self):
        self.fragment('ordinary.conf', NEVER)
        self.fx.write(self.hy2.AVAILABLE, SAFE.replace('BODY', '').replace('location /opaque {',
            'ssl_certificate_key /etc/nginx/parts/ordinary.conf; location /opaque {'))
        self.assertEqual(self.call(denied=('ordinary.conf',))['status'], 'safe')

    def test_ordinary_names_used_as_secret_or_log_files_are_denied_before_open(self):
        self.fragment('ordinary.conf', NEVER)
        for directive in ('ssl_certificate_key', 'auth_basic_user_file', 'access_log', 'error_log'):
            with self.subTest(directive=directive):
                self.config(self.include('ordinary.conf') + directive + ' /etc/nginx/parts/ordinary.conf;')
                self.blocked(self.call(denied=('ordinary.conf',)), 'closure_secret_reference')

    def test_secret_reference_in_nested_fragment_is_seen_before_its_include(self):
        self.config(self.include('a.conf'))
        self.fragment('a.conf', self.include('ordinary.conf') +
                      'auth_basic_user_file /etc/nginx/parts/ordinary.conf;')
        self.fragment('ordinary.conf', NEVER)
        self.blocked(self.call(denied=('ordinary.conf',)), 'closure_secret_reference')

    def test_main_log_reference_is_seen_before_hy2_reference_body(self):
        self.fragment('ordinary.conf', NEVER)
        self.config(self.include('ordinary.conf'))
        self.fx.entry(http='include /etc/nginx/sites-enabled/*; '
                      'access_log /etc/nginx/parts/ordinary.conf combined;')
        self.blocked(self.call(denied=('ordinary.conf',)), 'closure_secret_reference')

    def test_main_entry_secret_reference_after_include_is_seen_before_open(self):
        self.fx.write('/etc/nginx/snippets/ordinary.conf', NEVER)
        self.fx.entry(top='include /etc/nginx/snippets/ordinary.conf;\n'
                      'error_log /etc/nginx/snippets/ordinary.conf;')
        self.blocked(self.call(denied=('ordinary.conf',)), 'closure_secret_reference')

    def test_variable_secret_file_reference_stops_without_guessing_target(self):
        self.config('auth_basic_user_file /etc/nginx/parts/$opaque.conf;')
        self.fragment('ordinary.conf', NEVER)
        self.blocked(self.call(denied=('ordinary.conf',)), 'closure_variable_path')

    def test_symlink_leaf_and_parent_are_not_followed(self):
        self.fragment('destination.conf', NEVER)
        link = self.fx.path('/etc/nginx/parts/link.conf')
        link.symlink_to('destination.conf')
        self.config(self.include('link.conf'))
        self.blocked(self.call(denied=('destination.conf',)), 'closure_link_not_allowed')
        directory_link = self.fx.path('/etc/nginx/alias')
        directory_link.symlink_to('parts')
        self.config('include /etc/nginx/alias/destination.conf;')
        self.blocked(self.call(denied=('destination.conf',)))

    def test_hardlink_and_unsafe_owner_or_mode_stop_before_body(self):
        file = self.fragment('a.conf', '# inert\n')
        self.config(self.include('a.conf'))
        for kind in ('hardlink', 'owner', 'mode'):
            with self.subTest(kind=kind):
                self.fx.owner_overrides.clear()
                extra = None
                if kind == 'hardlink':
                    extra = file.with_name('extra.conf'); os.link(file, extra)
                elif kind == 'owner':
                    info = file.stat(); self.fx.owner_overrides[(info.st_dev, info.st_ino)] = {'st_uid':1001}
                else:
                    file.chmod(0o666)
                self.blocked(self.call(denied_body=('a.conf',)), 'closure_unsafe_file')
                if extra: extra.unlink()
                file.chmod(0o644)

    def test_unsafe_parent_stops_before_reference_body(self):
        file = self.fragment('a.conf', '# inert\n')
        file.parent.chmod(0o777)
        self.config(self.include('a.conf'))
        # config helper only visits sites-available, not the unsafe parts dir.
        self.blocked(self.call(denied_body=('a.conf',)), 'unsafe_config_parent')

    def test_file_limit_16_is_accepted_and_17th_is_not_opened(self):
        for index in range(17): self.fragment('p%d.conf' % index, '# inert\n')
        self.config(''.join(self.include('p%d.conf' % index) for index in range(16)))
        result = self.call(); self.assertEqual(result['status'], 'safe', result)
        self.assertEqual(result['summaries'][0]['referencedFileCount'],16)
        self.config(''.join(self.include('p%d.conf' % index) for index in range(17)))
        self.blocked(self.call(denied=('p16.conf',)), 'closure_file_limit')

    def test_depth_four_is_accepted_fifth_is_not_opened(self):
        self.config(self.include('p1.conf'))
        for index in range(1,4): self.fragment('p%d.conf' % index, self.include('p%d.conf' % (index+1)))
        self.fragment('p4.conf', '# inert\n')
        result=self.call();self.assertEqual(result['status'],'safe',result)
        self.assertEqual(result['summaries'][0]['deepestReference'],4)
        self.fragment('p4.conf',self.include('p5.conf'));self.fragment('p5.conf',NEVER)
        self.blocked(self.call(denied=('p5.conf',)), 'closure_depth_limit')

    def test_single_file_byte_limit_and_total_limit_are_checked_before_body(self):
        exact = '#' + 'x' * (65536 - 2) + '\n'
        self.fragment('a.conf',exact);self.config(self.include('a.conf'))
        self.assertEqual(self.call()['status'],'safe')
        self.fragment('a.conf',exact+'x')
        self.blocked(self.call(denied_body=('a.conf',)), 'closure_unsafe_file')
        for index in range(5):self.fragment('p%d.conf'%index,exact)
        self.config(''.join(self.include('p%d.conf'%index) for index in range(4)))
        result=self.call();self.assertEqual(result['status'],'safe',result)
        self.assertEqual(result['summaries'][0]['referenceBytes'],262144)
        self.config(''.join(self.include('p%d.conf'%index) for index in range(5)))
        self.blocked(self.call(denied_body=('p4.conf',)), 'closure_byte_limit')

    def test_duplicate_reference_counts_unique_bytes_and_cycles_stop(self):
        self.fragment('a.conf','# inert\n');self.config(self.include('a.conf')*2)
        result=self.call();self.assertEqual(result['status'],'safe',result)
        self.assertEqual(result['summaries'][0]['referencedFileCount'],1)
        self.fragment('a.conf',self.include('a.conf'))
        self.blocked(self.call(),'closure_cycle')

    def test_expansion_limit_stops_duplicate_fanout(self):
        self.fragment('a.conf','# inert\n');self.config(self.include('a.conf')*129)
        self.blocked(self.call(),'closure_expansion_limit')

    def test_unexpected_and_unknown_exception_messages_are_redacted(self):
        for exception in (OSError(SECRET), RuntimeError(SECRET)):
            with self.subTest(kind=type(exception).__name__):
                core=subject._modules()
                with mock.patch.object(core[1].Reader,'read',side_effect=exception):
                    self.blocked(self.call(core=core),'closure_configuration_unreadable')
        core=subject._modules()
        with mock.patch.object(core[1].Reader,'read',side_effect=core[1].Unknown(SECRET)):
            self.blocked(self.call(core=core),'closure_configuration_unreadable')

    def test_nested_invalid_utf8_and_malformed_content_never_leaks(self):
        self.config(self.include('a.conf'))
        for body in (b'\xff'+SECRET.encode(),'proxy_set_header "'+SECRET,SECRET+' {'):
            with self.subTest(kind=type(body).__name__):
                self.fragment('a.conf',body);self.blocked(self.call())

    def test_full_audit_unsafe_global_logging_is_not_bypassed(self):
        self.fx.entry(http='include /etc/nginx/sites-enabled/*; '
            "log_format hidden '$http_x_fkssj_signature'; access_log /var/log/nginx/extra.log hidden;")
        result=self.call();self.assertEqual(result['status'],'unsafe',result)
        self.assertIn('sensitive_log_variable',result['reasons'])
        self.assertTrue(result['summaries'][0]['diskAuditComplete'])

    def test_sensitive_global_format_name_and_variable_values_are_not_echoed(self):
        self.fx.entry(http='include /etc/nginx/sites-enabled/*; '
            'log_format '+SECRET+" '$remote_addr'; access_log /var/log/nginx/extra.log "+SECRET+';')
        self.assertEqual(self.call()['status'],'safe')

    def test_hy2_target_overlap_specific_443_and_dynamic_fragments_still_block(self):
        for variant in (SAFE.replace('BODY','').replace('other.invalid','fkssj.harvey-ai.xyz'),
                        SAFE.replace('BODY','').replace('443 ssl','127.0.0.1:443 ssl')):
            with self.subTest(kind=variant[:12]):
                self.fx.write(self.hy2.AVAILABLE,variant);self.blocked(self.call())
        self.config(self.include('a.conf'));self.fragment('a.conf','set $opaque "'+SECRET+'";')
        self.blocked(self.call(),'hy2_dynamic_configuration')

    def test_final_stability_check_rejects_changed_reference_metadata(self):
        self.config(self.include('a.conf'));file=self.fragment('a.conf','# inert\n');info=file.stat();seen=0
        def metadata(value):
            nonlocal seen
            result=self.fx.metadata(value)
            if (value.st_dev,value.st_ino)==(info.st_dev,info.st_ino):
                seen+=1
                if seen>=3:result.st_mtime_ns+=1
            return result
        self.blocked(self.call(metadata=metadata))

    def test_growing_file_is_read_only_to_prechecked_size_then_stops(self):
        self.config(self.include('a.conf'))
        file=self.fragment('a.conf','# inert padding\n');info=file.stat();seen=0
        def metadata(value):
            nonlocal seen
            result=self.fx.metadata(value)
            if (value.st_dev,value.st_ino)==(info.st_dev,info.st_ino):
                seen+=1
                if seen<=2:result.st_size=info.st_size-1
            return result
        self.blocked(self.call(metadata=metadata),'closure_config_changed')
        sizes=[(requested,actual) for leaf,requested,actual in self.last_read_sizes if leaf=='a.conf']
        self.assertTrue(sizes)
        self.assertLessEqual(sum(actual for requested,actual in sizes),info.st_size-1)
        self.assertLessEqual(sum(requested for requested,actual in sizes),info.st_size-1)

    def test_short_read_and_early_eof_stop_without_reading_extra_bytes(self):
        self.config(self.include('a.conf'))
        file=self.fragment('a.conf','# inert padding\n');seen=0
        def short(leaf,fd,size,read):
            nonlocal seen
            if leaf=='a.conf':
                seen+=1
                return read(fd,1) if seen==1 else b''
            return read(fd,size)
        self.blocked(self.call(read_filter=short),'closure_config_changed')
        sizes=[(requested,actual) for leaf,requested,actual in self.last_read_sizes if leaf=='a.conf']
        self.assertEqual(sum(actual for requested,actual in sizes),1)
        self.assertEqual(sizes[1][0],file.stat().st_size-1)

    def test_private_base_permission_extension_is_restored(self):
        self.config(self.include('a.conf'));self.fragment('a.conf','# inert\n')
        core=subject._modules();approved=core[1].approved
        self.assertEqual(self.call(core=core)['status'],'safe')
        self.assertIs(core[1].approved,approved)

    def test_safe_report_remains_compatible_with_existing_probe(self):
        result=self.call()
        self.assertEqual(probe.validate_review(json.dumps(result),fixtures.NOW),result)

    def test_main_errors_never_echo_arguments_or_exception(self):
        for args,exception,reason in ((['checker',SECRET],None,'no_arguments_allowed'),
             (['checker'],RuntimeError(SECRET),'local_audit_failure')):
            out,err=io.StringIO(),io.StringIO()
            with mock.patch.object(sys,'argv',args),mock.patch.object(sys,'stdout',out), \
                 mock.patch.object(sys,'stderr',err),mock.patch.object(subject,'audit',side_effect=exception):
                code=subject.main()
            self.assertNotEqual(code,0);self.assertEqual(err.getvalue(),'')
            self.assertNotIn(SECRET,out.getvalue());self.assertEqual(json.loads(out.getvalue())['reasons'],[reason])


if __name__ == '__main__':
    unittest.main()

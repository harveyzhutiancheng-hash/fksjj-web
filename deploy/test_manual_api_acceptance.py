"""Real loopback TLS/WSGI requests; no server connection or real credentials."""
import contextlib
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import ssl
import subprocess
import tempfile
import threading
import types
import unittest
from unittest import mock
from urllib.request import ProxyHandler
from wsgiref.simple_server import make_server, WSGIRequestHandler, WSGIServer

from api import app as api
from deploy import manual_api_acceptance as subject
from deploy import release_channel as channel

BAIT = 'FICTIONAL_PASSWORD_COOKIE_OR_PRIVATE_BODY_NEVER_PRINT'
ROOT = Path(__file__).resolve().parents[1]
BINDINGS = {'manifestSha256': '3'*64,
            'apiAppSha256': hashlib.sha256((ROOT/'api/app.py').read_bytes()).hexdigest(),
            'apiInitSha256': hashlib.sha256((ROOT/'api/__init__.py').read_bytes()).hexdigest(),
            'apiPreviewSha256': '4'*64,
            'backendTarget': 'api-releases/fkssj-api-fixture',
            'apiUnitSha256': '1'*64, 'nginxConfigSha256': '2'*64}


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


class ReusableServer(WSGIServer):
    allow_reuse_address = True


class TLSFixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.key, self.cert = self.root/'fixture-key.pem', self.root/'fixture-cert.pem'
        reply = subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-days', '1', '-keyout', str(self.key), '-out', str(self.cert),
            '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        if reply.returncode:
            raise RuntimeError('fixture TLS setup failed')
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(self.cert, self.key)
        self.data = self.root/'data'
        self.host_port = 0
        self.httpd = self.thread = None
        self.calls, self.restarts = [], 0
        self.mode = None
        self.start()

    def start(self):
        application = api.create_app(str(self.data), subject.ORIGIN)
        def wsgi(environ, response):
            self.calls.append((environ['REQUEST_METHOD'], environ['PATH_INFO']))
            if self.mode == 'redirect' and environ['PATH_INFO'] == '/api/health':
                raw = b'{}'
                response('302 Found', [('Content-Type','application/json'),
                    ('Content-Length','2'),('Location','https://invalid.example/'+BAIT)])
                return [raw]
            return application(environ, response)
        self.httpd = make_server('127.0.0.1', self.host_port, wsgi,
                                server_class=ReusableServer, handler_class=QuietHandler)
        self.host_port = self.httpd.server_port
        self.httpd.socket = self.context.wrap_socket(self.httpd.socket, server_side=True)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        if self.httpd is not None:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.thread.join(timeout=5)
            self.httpd = self.thread = None

    def restart(self):
        self.restarts += 1
        self.stop()
        self.start()

    def close(self):
        self.stop()
        self.temp.cleanup()

    def transport(self, *, trusted=True):
        fixture = self
        class LocalTLS(subject.HTTPSTransport):
            def url(self, path):
                subject.need(path in subject.ROUTES, 'https_request_failed')
                return 'https://localhost:' + str(fixture.host_port) + path
            def context(self):
                return ssl.create_default_context(cafile=str(fixture.cert)) if trusted else ssl.create_default_context()
        return LocalTLS()

    def host(self):
        fixture = self
        class LocalHost:
            calls = 0
            def verify(self, bindings):
                self.calls += 1
                subject.need(bindings == BINDINGS, 'installed_binding_mismatch')
            def restart(self):
                fixture.restart()
            def now(self):
                return dt.datetime.now(dt.timezone.utc)
        return LocalHost()


class RealHTTPSAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.fx = TLSFixture()
        self.addCleanup(self.fx.close)
        # Only the localhost test fixture bypasses proxy discovery, never the
        # production fixed-origin client or a restricted external connection.
        real = subject.build_opener
        patch = mock.patch.object(subject, 'build_opener', side_effect=lambda *args: real(ProxyHandler({}), *args))
        patch.start()
        self.addCleanup(patch.stop)

    def test_full_real_tls_http_acceptance_exact_two_accounts_and_actual_wsgi_restart(self):
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            result = subject.run_acceptance(self.fx.transport(), self.fx.host(), dict(BINDINGS))
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(errors.getvalue(), '')
        summary = result['summary']
        self.assertEqual(summary['state'], 'api_http_acceptance_passed')
        self.assertEqual(summary['accountsConfirmed'], 2)
        self.assertEqual(summary['accountCreationRequests'], 2)
        self.assertEqual(summary['browserChecks'], 'not_performed')
        self.assertFalse(summary['receiptWritten'])
        self.assertEqual(self.fx.restarts, 1)
        self.assertEqual(sum(path == '/api/auth/register' for _,path in self.fx.calls), 2)
        receipt = json.loads(result['receipt'])
        self.assertEqual(set(receipt['checks']), subject.CHECKS)
        self.assertTrue(all(receipt['checks'].values()))
        self.assertNotIn('username', result['receipt'].decode())
        self.assertNotIn('password', result['receipt'].decode())
        with sqlite3.connect(self.fx.data/'fkssj.sqlite3') as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 2)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM cloud_saves').fetchone()[0], 2)
            saves = [json.loads(row[0]) for row in db.execute('SELECT save_json FROM cloud_saves')]
            self.assertEqual({save['resources']['wood'] for save in saves}, {191,383})
        receipt_path = self.fx.root/'receipt.json'
        receipt_path.write_bytes(result['receipt'])
        verified = channel.release.acceptance(receipt_path, hashlib.sha256(result['receipt']).hexdigest(),
            BINDINGS['manifestSha256'], BINDINGS['apiAppSha256'], BINDINGS['apiInitSha256'],
            dt.datetime.now(dt.timezone.utc))
        self.assertEqual(verified, receipt)

    def test_untrusted_tls_is_rejected_without_registration(self):
        with self.assertRaises(subject.AcceptanceError) as ctx:
            subject.run_acceptance(self.fx.transport(trusted=False), self.fx.host(), dict(BINDINGS))
        self.assertEqual(ctx.exception.code, 'https_request_failed')
        self.assertEqual(self.fx.calls, [])
        self.assertEqual(ctx.exception.summary['accountCreationRequests'], 0)

    def test_redirect_is_not_followed_or_treated_as_health(self):
        self.fx.mode = 'redirect'
        with self.assertRaises(subject.AcceptanceError) as ctx:
            subject.run_acceptance(self.fx.transport(), self.fx.host(), dict(BINDINGS))
        self.assertEqual(self.fx.calls, [('GET','/api/health')])
        self.assertNotIn(BAIT, str(ctx.exception))
        self.assertEqual(ctx.exception.summary['accountCreationRequests'], 0)

    def test_network_unknown_after_registration_is_not_retried_or_receipted(self):
        real = self.fx.transport()
        class DroppedReply:
            def request(inner, method, path, *args):
                reply = real.request(method, path, *args)
                if path == '/api/auth/register':
                    raise OSError(BAIT)
                return reply
        with self.assertRaises(subject.AcceptanceError) as ctx:
            subject.run_acceptance(DroppedReply(), self.fx.host(), dict(BINDINGS))
        self.assertEqual(ctx.exception.code, 'https_request_failed')
        self.assertTrue(ctx.exception.summary['requestOutcomeMayBeUncertain'])
        self.assertEqual(ctx.exception.summary['accountCreationRequests'], 1)
        self.assertEqual(sum(path == '/api/auth/register' for _,path in self.fx.calls), 1)
        with sqlite3.connect(self.fx.data/'fkssj.sqlite3') as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 1)
        self.assertNotIn(BAIT, str(ctx.exception))

    def test_isolation_failure_stops_no_restart_and_no_third_account(self):
        real = self.fx.transport()
        class LeakyServer:
            def request(inner, method, path, *args):
                reply = real.request(method, path, *args)
                if reply.status == 403 and reply.data.get('code') == 'user_mismatch':
                    reply.data['save'] = {'private': BAIT}
                return reply
        with self.assertRaises(subject.AcceptanceError) as ctx:
            subject.run_acceptance(LeakyServer(), self.fx.host(), dict(BINDINGS))
        self.assertEqual(ctx.exception.code, 'identity_isolation_failed')
        self.assertEqual(self.fx.restarts, 0)
        self.assertEqual(ctx.exception.summary['accountCreationRequests'], 2)
        self.assertNotIn(BAIT, str(ctx.exception))
        self.assertNotIn(BAIT, json.dumps(ctx.exception.summary))

    def test_insecure_cookie_is_rejected(self):
        real = self.fx.transport()
        class StrippedCookie:
            def request(inner, method, path, *args):
                reply = real.request(method, path, *args)
                if path == '/api/auth/register':
                    reply.headers = tuple((k,v.replace('HttpOnly; ','')) for k,v in reply.headers)
                return reply
        with self.assertRaises(subject.AcceptanceError) as ctx:
            subject.run_acceptance(StrippedCookie(), self.fx.host(), dict(BINDINGS))
        self.assertEqual(ctx.exception.code, 'insecure_cookie')
        self.assertEqual(ctx.exception.summary['accountCreationRequests'], 1)
        self.assertTrue(ctx.exception.summary['requestOutcomeMayBeUncertain'])

    def test_mismatch_message_cannot_smuggle_private_save(self):
        real=self.fx.transport()
        class LeakyMessage:
            def request(inner, method, path, *args):
                reply=real.request(method,path,*args)
                if reply.status==403 and reply.data.get('code')=='user_mismatch':
                    reply.data['message'] += BAIT
                return reply
        with self.assertRaises(subject.AcceptanceError) as ctx:
            subject.run_acceptance(LeakyMessage(),self.fx.host(),dict(BINDINGS))
        self.assertEqual(ctx.exception.code,'identity_isolation_failed')
        self.assertNotIn(BAIT,str(ctx.exception))

    def test_restart_uncertain_stops_without_more_mutations_or_receipt(self):
        host = self.fx.host()
        def uncertain():
            raise subject.AcceptanceError('restart_not_confirmed')
        host.restart = uncertain
        with self.assertRaises(subject.AcceptanceError) as ctx:
            subject.run_acceptance(self.fx.transport(), host, dict(BINDINGS))
        self.assertEqual(ctx.exception.code, 'restart_not_confirmed')
        self.assertTrue(ctx.exception.summary['restartAttempted'])
        self.assertEqual(ctx.exception.summary['accountsConfirmed'], 2)
        self.assertEqual(sum(path == '/api/auth/register' for _,path in self.fx.calls), 2)
        self.assertFalse(ctx.exception.summary['receiptWritten'])

    def test_binding_drift_after_restart_stops_and_never_calls_register_again(self):
        host = self.fx.host()
        original = host.verify
        def verify(bindings):
            original(bindings)
            if host.calls > 1:
                raise subject.AcceptanceError('installed_binding_mismatch')
        host.verify = verify
        with self.assertRaises(subject.AcceptanceError) as ctx:
            subject.run_acceptance(self.fx.transport(), host, dict(BINDINGS))
        self.assertEqual(ctx.exception.code, 'installed_binding_mismatch')
        self.assertEqual(self.fx.restarts, 1)
        self.assertEqual(sum(path == '/api/auth/register' for _,path in self.fx.calls), 2)

    def test_session_loss_on_restart_is_not_hidden_by_fresh_login(self):
        host=self.fx.host()
        original=host.restart
        def drop_fixture_sessions():
            original()
            with sqlite3.connect(self.fx.data/'fkssj.sqlite3') as db:
                db.execute('DELETE FROM sessions')
        host.restart=drop_fixture_sessions
        with self.assertRaises(subject.AcceptanceError) as ctx:
            subject.run_acceptance(self.fx.transport(),host,dict(BINDINGS))
        self.assertEqual(ctx.exception.code,'save_mismatch')
        self.assertEqual(sum(path=='/api/auth/register' for _,path in self.fx.calls),2)
        self.assertEqual(sum(path=='/api/auth/login' for _,path in self.fx.calls),2)


class MetadataAndContractTests(unittest.TestCase):
    def test_bindings_strict_and_backend_directory_bounded(self):
        for change in ({'extra':1}, {'backendTarget':'api-releases/../key'},
                       {'manifestSha256':'not-a-hash'}, {'backendTarget':'/srv/fkssj/api-current'}):
            with self.subTest(change=change), self.assertRaises(subject.AcceptanceError):
                subject.validate_bindings(BINDINGS|change)

    def test_fixed_production_https_routes_no_endpoint_parameter(self):
        transport = subject.HTTPSTransport()
        self.assertEqual(transport.url('/api/health'), subject.ORIGIN+'/api/health')
        with self.assertRaises(subject.AcceptanceError):
            transport.url('https://other.example/api/health')
        with self.assertRaises(TypeError):
            subject.HTTPSTransport(endpoint='https://other.example')
        self.assertTrue(transport.context().check_hostname)
        self.assertEqual(transport.context().verify_mode, ssl.CERT_REQUIRED)

    def test_production_restart_uses_only_fixed_unit_and_suppresses_errors(self):
        host = subject.Host()
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(subject.subprocess,'run',return_value=types.SimpleNamespace(returncode=0)) as command:
            host.restart()
        self.assertEqual(command.call_args.args[0], ['/usr/bin/systemctl','restart','fkssj-api.service'])
        with mock.patch.object(subject.subprocess,'run',side_effect=OSError(BAIT)), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), \
             self.assertRaises(subject.AcceptanceError) as ctx:
            host.restart()
        self.assertEqual(ctx.exception.code,'restart_not_confirmed')
        self.assertEqual(stdout.getvalue()+stderr.getvalue(),'')

    def test_preflight_failure_performs_no_requests_or_accounts(self):
        host = mock.Mock()
        host.verify.side_effect = subject.AcceptanceError('installed_binding_mismatch')
        transport = mock.Mock()
        with self.assertRaises(subject.AcceptanceError) as ctx:
            subject.run_acceptance(transport, host, dict(BINDINGS))
        transport.request.assert_not_called()
        self.assertEqual(ctx.exception.summary['accountCreationRequests'],0)

    def test_response_and_session_repr_do_not_dump_secrets(self):
        self.assertNotIn(BAIT, repr(subject.Response(200,(('Set-Cookie',BAIT),),{'password':BAIT})))
        self.assertNotIn('cookies=', repr(subject.Session()))

    def test_cookie_name_flags_path_domain_and_shape_all_required(self):
        valid = subject.COOKIE+'='+'a'*43+'; Path=/; Secure; HttpOnly; SameSite=Lax'
        subject.secure_cookie(subject.Response(200,(('Set-Cookie',valid),),{}))
        invalid = (valid.replace('Secure; ',''), valid.replace('HttpOnly; ',''),
                   valid.replace('Path=/','Path=/api'), valid+'; Domain=example.test',
                   valid.replace('SameSite=Lax','SameSite=None'),
                   valid.replace('a'*43,'short'), 'ordinary='+valid.split('=',1)[1])
        for value in invalid:
            with self.subTest(value=value[:20]), self.assertRaises(subject.AcceptanceError):
                subject.secure_cookie(subject.Response(200,(('Set-Cookie',value),),{}))

    def test_production_verify_requires_fixed_link_code_config_and_loaded_unit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'api-current').symlink_to(BINDINGS['backendTarget'])
            values = {'Id':'fkssj-api.service','LoadState':'loaded','ActiveState':'active',
                'SubState':'running','UnitFileState':'enabled',
                'FragmentPath':'/etc/systemd/system/fkssj-api.service','DropInPaths':'',
                'NeedDaemonReload':'no','User':'fkssj-api','Group':'fkssj-api',
                'ExecStart':'/opt/fkssj-api/venv/bin/gunicorn --bind 127.0.0.1:8787 api.app:create_app()'}
            hashes = {'/srv/fkssj/'+BINDINGS['backendTarget']+'/api/app.py':BINDINGS['apiAppSha256'],
                '/srv/fkssj/'+BINDINGS['backendTarget']+'/api/__init__.py':BINDINGS['apiInitSha256'],
                '/srv/fkssj/'+BINDINGS['backendTarget']+'/api/preview.py':BINDINGS['apiPreviewSha256'],
                '/etc/systemd/system/fkssj-api.service':BINDINGS['apiUnitSha256'],
                '/etc/nginx/conf.d/fkssj-domain.conf':BINDINGS['nginxConfigSha256']}
            class MetadataHost(subject.Host):
                def _directory(self, absolute):
                    if absolute != '/srv/fkssj':
                        raise AssertionError('unexpected path')
                    return os.open(root, os.O_RDONLY|os.O_DIRECTORY)
                def _hash(self, absolute):
                    return hashes[absolute]
                def _show(self):
                    return dict(values)
            host=MetadataHost()
            original_stat=os.stat
            def root_link(*args,**kwargs):
                info=original_stat(*args,**kwargs)
                fields={name:getattr(info,name) for name in dir(info) if name.startswith('st_')}
                fields['st_uid']=0
                return types.SimpleNamespace(**fields)
            with mock.patch.object(subject.os,'stat',side_effect=root_link):
                host.verify(dict(BINDINGS))
                for key,bad in (('DropInPaths',BAIT),('NeedDaemonReload','yes'),('User','root'),
                                ('UnitFileState','disabled'),('ActiveState','failed'),('ExecStart','unknown')):
                    saved=values[key];values[key]=bad
                    with self.subTest(key=key),self.assertRaises(subject.AcceptanceError) as ctx:
                        host.verify(dict(BINDINGS))
                    self.assertEqual(ctx.exception.code,'service_not_confirmed')
                    self.assertNotIn(BAIT,str(ctx.exception));values[key]=saved
                hashes['/etc/nginx/conf.d/fkssj-domain.conf']='f'*64
                with self.assertRaises(subject.AcceptanceError) as ctx:
                    host.verify(dict(BINDINGS))
                self.assertEqual(ctx.exception.code,'installed_binding_mismatch')


if __name__ == '__main__':
    unittest.main()

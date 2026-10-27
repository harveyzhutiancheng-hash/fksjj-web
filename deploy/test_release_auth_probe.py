"""Status-auth probe tests with PUBLIC TEST keys and zero network access.

Injected response fixtures and a real temporary SQLite Store establish local
protocol/state behavior only. No real Secret, server, subprocess or Actions run.
"""
import base64
import contextlib
import hashlib
import hmac
import io
import itertools
import json
from pathlib import Path
import socket
import ssl
import tempfile
import unittest
from unittest import mock

from deploy import release_auth_probe as p
from deploy import release_channel as channel

try:
    import yaml
except ImportError:
    yaml = None


KEY = bytes(range(32))  # PUBLIC, deliberately non-secret TEST key.
NOW = 1792713600


def reply(code=401, error='auth_failed', *, body=None, headers=None):
    raw = json.dumps({'error': error}, sort_keys=True, separators=(',', ':')).encode() if body is None else body
    fields = [('Content-Type', 'application/json'), ('Cache-Control', 'no-store'),
              ('X-Content-Type-Options', 'nosniff'), ('Referrer-Policy', 'same-origin'),
              ('Content-Length', str(len(raw)))] if headers is None else headers
    return code, fields, raw


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.env = {'GITHUB_REPOSITORY': p.REPO, 'GITHUB_REF': p.REF,
                    'GITHUB_SHA': 'a' * 40, 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                    'GITHUB_ACTIONS': 'true', 'FKSSJ_RELEASE_HMAC_KEY_HEX': KEY.hex(),
                    'FKSSJ_STATUS_LOGS_CURRENT_CONFIRMED': 'true'}
        self.review = {'schema': 1, 'site': p.HOST,
                       'endpoint': p.ENDPOINT,
                       'checkedAt': NOW - 60, 'targetSha256': p.TARGET_SHA,
                       'configSha256': 'b' * 64, 'status': 'safe', 'reasons': [],
                       'basis': 'disk_configuration_only_not_running_attestation'}
        self.nonces, self.sent = itertools.count(1), []
        patcher = mock.patch.object(socket, 'create_connection', side_effect=AssertionError('Real network prohibited'))
        patcher.start()
        self.addCleanup(patcher.stop)

    def nonce(self):
        return f'{next(self.nonces):032x}'

    def raw_review(self):
        return json.dumps(self.review, sort_keys=True, separators=(',', ':'))

    def invoke(self, responses=None, *, transport=None, raw_review=None):
        queue = list(responses if responses is not None else [reply(), reply(404, 'unknown_release')])

        def send(headers):
            self.sent.append(dict(headers))
            if transport is not None:
                return transport(headers)
            if not queue:
                raise AssertionError('Unexpected extra TEST transport request')
            value = queue.pop(0)
            if isinstance(value, BaseException):
                raise value
            return value

        output, errors = io.StringIO(), io.StringIO()
        visible = ''
        try:
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                try:
                    result = p.run_probe(self.env, self.raw_review() if raw_review is None else raw_review,
                                         transport=send, now=NOW, nonce=self.nonce)
                except p.ProbeError as error:
                    visible = str(error)
                    raise
            visible = json.dumps(result)
            return result
        finally:
            visible += output.getvalue() + errors.getvalue()
            self.assertNotIn(KEY.hex(), visible)
            self.assertNotIn('X-FKSSJ-Signature', visible)
            self.assertNotIn('X-FKSSJ-Envelope', visible)
            for headers in self.sent:
                for name in ('X-FKSSJ-Signature', 'X-FKSSJ-Envelope'):
                    if name in headers:
                        self.assertNotIn(headers[name], visible)

    def envelope(self, headers):
        raw = base64.b64decode(headers['X-FKSSJ-Envelope'], validate=True)
        return raw, json.loads(raw)

    def test_tampered_401_precedes_correct_404_with_distinct_nonce_and_status_only(self):
        result = self.invoke()
        self.assertEqual(result['state'], 'hmac_verified_status_only')
        self.assertEqual(result['requests'], 2)
        self.assertEqual(result['expectedNonceRecords'], 1)
        first_raw, first = self.envelope(self.sent[0])
        second_raw, second = self.envelope(self.sent[1])
        self.assertNotEqual(first['requestId'], second['requestId'])
        for envelope in (first, second):
            self.assertEqual(envelope['operation'], 'status')
            self.assertEqual(envelope['repo'], p.REPO)
            self.assertEqual(envelope['ref'], p.REF)
            self.assertEqual(envelope['commit'], self.env['GITHUB_SHA'])
        first_mac = hmac.new(KEY, p.DOMAIN + first_raw, hashlib.sha256).hexdigest()
        second_mac = hmac.new(KEY, p.DOMAIN + second_raw, hashlib.sha256).hexdigest()
        self.assertNotEqual(self.sent[0]['X-FKSSJ-Signature'], first_mac)
        self.assertEqual(self.sent[1]['X-FKSSJ-Signature'], second_mac)

    def test_first_response_failure_never_sends_correct_signature(self):
        for response in (reply(200), reply(404, 'unknown_release'), reply(403), reply(302)):
            with self.subTest(code=response[0]):
                self.sent.clear()
                with self.assertRaises(p.ProbeError):
                    self.invoke([response])
                self.assertEqual(len(self.sent), 1)

    def test_wrong_correct_key_stops_after_two_requests_without_retry(self):
        with self.assertRaises(p.ProbeError):
            self.invoke([reply(), reply()])  # Correctly signed request still gets 401.
        self.assertEqual(len(self.sent), 2)

    def test_redirects_and_unexpected_second_code_or_error_are_rejected(self):
        for second in (reply(301), reply(302), reply(307), reply(308), reply(200),
                       reply(404, 'not_found'), reply(403, 'forbidden')):
            with self.subTest(code=second[0], body=second[2]):
                self.sent.clear()
                with self.assertRaises(p.ProbeError):
                    self.invoke([reply(), second])
                self.assertEqual(len(self.sent), 2)

    def test_nonexact_duplicate_or_invalid_json_error_body_stops_immediately(self):
        bodies = [b'{"error":"auth_failed","extra":1}', b'{"error":"auth_failed","error":"auth_failed"}',
                  b'[{"error":"auth_failed"}]', b'not JSON', b'{"error":NaN}', b'{}']
        for body in bodies:
            with self.subTest(body=body):
                self.sent.clear()
                with self.assertRaises(p.ProbeError):
                    self.invoke([reply(body=body)])
                self.assertEqual(len(self.sent), 1)

    def test_missing_duplicate_or_wrong_security_headers_stop_before_correct_request(self):
        standard = reply()[1]
        names = ('Content-Type', 'Cache-Control', 'X-Content-Type-Options', 'Referrer-Policy')
        variants = []
        for name in names:
            variants.extend(([item for item in standard if item[0] != name],
                             standard + [next(item for item in standard if item[0] == name)],
                             [(key, 'INERT-wrong' if key == name else value) for key, value in standard]))
        for fields in variants:
            with self.subTest(fields=fields):
                self.sent.clear()
                with self.assertRaises(p.ProbeError):
                    self.invoke([reply(headers=fields)])
                self.assertEqual(len(self.sent), 1)

    def test_timeout_is_unknown_and_secret_bearing_transport_error_is_not_logged(self):
        for phase in ('negative', 'positive'):
            with self.subTest(phase=phase):
                self.sent.clear()

                def timeout(headers):
                    if phase == 'positive' and len(self.sent) == 1:
                        return reply()
                    raise TimeoutError('INERT TEST ' + KEY.hex() + ' ' + repr(headers))

                with self.assertRaises(p.ProbeError) as error:
                    self.invoke(transport=timeout)
                self.assertTrue(error.exception.unknown)
                self.assertEqual(len(self.sent), 1 if phase == 'negative' else 2)

    def test_main_stdout_success_gate_failure_and_unknown_never_print_signed_material(self):
        for case, expected_code, expected_calls in (('success', 0, 2), ('gate', 1, 0), ('timeout', 3, 2)):
            with self.subTest(case=case):
                environment = dict(self.env, FKSSJ_STATUS_LOG_REVIEW_JSON=self.raw_review())
                if case == 'gate':
                    environment['GITHUB_ACTIONS'] = 'false'
                sent = []

                def exchange(headers):
                    sent.append(dict(headers))
                    if len(sent) == 1:
                        return reply()
                    if case == 'timeout':
                        raise TimeoutError(KEY.hex() + repr(headers))
                    return reply(404, 'unknown_release')

                output, errors = io.StringIO(), io.StringIO()
                with mock.patch.dict(p.os.environ, environment, clear=True), \
                        mock.patch.object(p.sys, 'argv', ['release_auth_probe.py']), \
                        mock.patch.object(p.time, 'time', return_value=NOW), \
                        mock.patch.object(p.secrets, 'token_hex', side_effect=lambda _: self.nonce()), \
                        mock.patch.object(p, 'https_status', side_effect=exchange), \
                        contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    code = p.main()
                self.assertEqual(code, expected_code)
                self.assertEqual(len(sent), expected_calls)
                visible = output.getvalue() + errors.getvalue()
                self.assertEqual(json.loads(output.getvalue())['state'],
                                 'hmac_verified_status_only' if case == 'success' else 'unknown' if case == 'timeout' else 'not_verified')
                self.assertNotIn(KEY.hex(), visible)
                self.assertNotIn('X-FKSSJ-Signature', visible)
                self.assertNotIn('X-FKSSJ-Envelope', visible)
                for headers in sent:
                    self.assertNotIn(headers['X-FKSSJ-Signature'], visible)
                    self.assertNotIn(headers['X-FKSSJ-Envelope'], visible)

    def test_wrong_context_and_missing_or_malformed_key_make_zero_transport_calls(self):
        changes = [('GITHUB_REPOSITORY', 'other/repo'), ('GITHUB_REF', 'refs/heads/other'),
                   ('GITHUB_SHA', 'A' * 40), ('GITHUB_EVENT_NAME', 'push'), ('GITHUB_ACTIONS', 'false'),
                   ('FKSSJ_RELEASE_HMAC_KEY_HEX', ''), ('FKSSJ_RELEASE_HMAC_KEY_HEX', KEY.hex().upper()),
                   ('FKSSJ_RELEASE_HMAC_KEY_HEX', KEY.hex() + '\n'), ('FKSSJ_RELEASE_HMAC_KEY_HEX', '00')]
        for name, value in changes:
            with self.subTest(name=name, value_kind=len(value)):
                original = self.env[name]
                self.env[name] = value
                with self.assertRaises(p.ProbeError):
                    self.invoke()
                self.env[name] = original
                self.assertEqual(self.sent, [])

    def test_log_review_binding_freshness_and_safety_failures_make_zero_transport_calls(self):
        changes = [('schema', True), ('site', 'https://other.invalid'), ('endpoint', 'https://' + p.HOST + '/wrong'),
                   ('checkedAt', NOW + 1), ('checkedAt', NOW - 1801), ('targetSha256', '0' * 64),
                   ('configSha256', 'A' * 64), ('status', 'unsafe'), ('reasons', ['INERT unsafe log']),
                   ('basis', 'running_configuration_attested')]
        for name, value in changes:
            with self.subTest(name=name):
                original = self.review[name]
                self.review[name] = value
                with self.assertRaises(p.ProbeError):
                    self.invoke()
                self.review[name] = original
                self.assertEqual(self.sent, [])

    def test_missing_or_false_loaded_confirmation_makes_zero_transport_calls(self):
        name = 'FKSSJ_STATUS_LOGS_CURRENT_CONFIRMED'
        for value in (None, 'false', 'True'):
            with self.subTest(value=value):
                if value is None:
                    self.env.pop(name, None)
                else:
                    self.env[name] = value
                with self.assertRaises(p.ProbeError):
                    self.invoke()
                self.assertEqual(self.sent, [])

    def test_duplicate_review_json_or_unknown_field_is_rejected_without_transport(self):
        raw = self.raw_review()
        duplicate = raw.replace('"schema":1', '"schema":1,"schema":1')
        for review in (duplicate, raw[:-1] + ',"unknown":true}'):
            with self.subTest(review=review[:30]):
                with self.assertRaises(p.ProbeError):
                    self.invoke(raw_review=review)
                self.assertEqual(self.sent, [])

    def test_production_transport_has_fixed_tls_host_post_path_empty_body_and_no_redirect(self):
        response = mock.Mock()
        response.status, response.getheaders.return_value, response.read.return_value = reply()
        connection = mock.Mock()
        connection.getresponse.return_value = response
        headers = {'X-FKSSJ-Envelope': 'INERT-TEST', 'X-FKSSJ-Signature': '0' * 64}
        with mock.patch.object(p.http.client, 'HTTPSConnection', return_value=connection) as constructor:
            result = p.https_status(headers)
        self.assertEqual(result, reply())
        self.assertEqual(p.HOST, 'fkssj.harvey-ai.xyz')
        self.assertEqual(p.PATH, '/_fkssj-release/v1/status')
        self.assertEqual(constructor.call_args.args[:2], (p.HOST, 443))
        context = constructor.call_args.kwargs['context']
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertEqual(connection.request.call_args.args[:2], ('POST', p.PATH))
        self.assertEqual(connection.request.call_args.kwargs['body'], b'')
        self.assertEqual(connection.request.call_args.kwargs['headers']['Content-Length'], '0')
        connection.set_debuglevel.assert_called_once_with(0)
        response.read.assert_called_once_with(p.MAX_RESPONSE + 1)
        connection.request.assert_called_once()
        connection.close.assert_called_once()

    def test_store_integration_creates_one_rejected_status_nonce_and_no_release_or_queue(self):
        temporary = tempfile.TemporaryDirectory(prefix='TEST-FIXTURE-status-probe-')
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        state, root = base / 'state', base / 'root'
        state.mkdir()
        (root / 'releases' / 'INERT-old').mkdir(parents=True)
        current = root / 'current'
        current.symlink_to('releases/INERT-old')
        sentinel = root / 'releases' / 'INERT-old' / 'INERT-static-and-DB-sentinel'
        sentinel.write_bytes(b'INERT old release/database unchanged')
        config = channel.Config(state, root, KEY, clock=lambda: NOW)
        store = channel.Store(config)

        def actual_store(headers):
            raw, value = self.envelope(headers)
            try:
                channel.verify(raw, headers['X-FKSSJ-Signature'], config, 'status')
                store.reserve(value, raw, headers['X-FKSSJ-Signature'])
            except channel.ChannelError as error:
                return reply(error.status, error.code)
            raise AssertionError('Fresh random TEST release must be unknown')

        result = self.invoke(transport=actual_store)
        self.assertEqual(result['state'], 'hmac_verified_status_only')
        with store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM releases').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM requests').fetchone()[0], 1)
            row = db.execute('SELECT operation,state,error FROM requests').fetchone()
            self.assertEqual(tuple(row), ('status', 'rejected', 'unknown_release'))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM requests WHERE state IN ('queued','processing','uncertain')").fetchone()[0], 0)
        self.assertEqual(current.readlink().as_posix(), 'releases/INERT-old')
        self.assertEqual(sentinel.read_bytes(), b'INERT old release/database unchanged')


@unittest.skipIf(yaml is None, 'PyYAML unavailable; no test dependency is installed')
class WorkflowTests(unittest.TestCase):
    def workflow(self):
        path = Path(__file__).resolve().parents[1] / '.github/workflows/fkssj-status-auth-probe.yml'
        return yaml.load(path.read_text(), Loader=yaml.BaseLoader)

    def test_workflow_is_manual_only_and_checkout_is_pinned_without_credentials(self):
        workflow = self.workflow()
        self.assertEqual(set(workflow['on']), {'workflow_dispatch'})
        confirmation = workflow['on']['workflow_dispatch']['inputs']['logs_current']
        self.assertEqual(confirmation['type'], 'boolean')
        self.assertEqual(confirmation['default'], 'false')
        self.assertEqual(workflow['permissions'], {})
        for job in workflow['jobs'].values():
            self.assertIn("github.ref == 'refs/heads/main'", job['if'])
            self.assertEqual(job['permissions'], {'contents': 'read'})
            for step in job['steps']:
                if 'uses' in step:
                    self.assertRegex(step['uses'], r'^actions/checkout@11bd719[0-9a-f]{33}$')
                    self.assertEqual(step['with']['persist-credentials'], 'false')

    def test_secret_is_only_in_probe_step_env_and_workflow_has_no_mutation_path(self):
        workflow = self.workflow()
        self.assertNotIn('env', workflow)
        secret_steps = []
        for job in workflow['jobs'].values():
            self.assertNotIn('env', job)
            for step in job['steps']:
                env = step.get('env', {})
                if 'FKSSJ_RELEASE_HMAC_KEY_HEX' in env:
                    secret_steps.append(step)
                    self.assertIn('secrets.FKSSJ_RELEASE_HMAC_KEY_HEX', env['FKSSJ_RELEASE_HMAC_KEY_HEX'])
                    index = job['steps'].index(step)
                    self.assertEqual(index, len(job['steps']) - 1)
                    self.assertTrue(any('validate_review' in previous.get('run', '') for previous in job['steps'][:index]))
                run = step.get('run', '')
                lowered = run.lower()
                for forbidden in ('npm ', 'pip ', 'apt ', 'sudo ', 'systemctl ', 'nginx ', 'release_client.py upload',
                                  'release_client.py activate', 'release_orchestrator.py activate', 'package-static',
                                  'hmac_export.py', 'install_phase1.py', 'curl ', 'wget '):
                    self.assertNotIn(forbidden, lowered)
                self.assertNotIn('secrets.', run)
        self.assertEqual(len(secret_steps), 1)
        self.assertIn('release_auth_probe.py', secret_steps[0].get('run', ''))


if __name__ == '__main__':
    unittest.main()

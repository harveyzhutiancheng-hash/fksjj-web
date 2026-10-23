#!/usr/bin/env python3
"""One status-only HMAC check in the approved GitHub receive environment.

No release files, arbitrary endpoint, redirects, retry, upload or activation.
Only fixed outcome codes reach stdout. Never log exception/response/header data.
"""
import base64
import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import ssl
import sys
import time

HOST = 'fkssj.harvey-ai.xyz'
PATH = '/_fkssj-release/v1/status'
ENDPOINT = 'https://' + HOST + PATH
REPO = 'harveyzhutiancheng-hash/fksjj-web'
REF = 'refs/heads/main'
DOMAIN = b'FKSSJ-RELEASE-V1\n'
TARGET_SHA = '779c662a0d5e97b55c8b15718a1eb13cabbb810edde554a3a5e7d23315e107a0'
REVIEW_MAX_AGE = 1800
MAX_RESPONSE = 4096
PUBLIC_DIGEST = hashlib.sha256(b'FKSSJ-STATUS-AUTH-PROBE-NOT-A-RELEASE').hexdigest()


class ProbeError(Exception):
    def __init__(self, code, unknown=False):
        self.code, self.unknown = code, unknown
        super().__init__(code)


def need(condition, code):
    if not condition:
        raise ProbeError(code)


def hex_value(value, length=64):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{' + str(length) + '}', value) is not None


def strict_json(data):
    def pairs(values):
        result = {}
        for key, value in values:
            need(key not in result, 'duplicate_json_key')
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ProbeError('invalid_json')))
    except (ValueError, TypeError, UnicodeError):
        raise ProbeError('invalid_json') from None


def validate_context(environ):
    need(environ.get('GITHUB_ACTIONS') == 'true' and
         environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and
         environ.get('GITHUB_REPOSITORY') == REPO and environ.get('GITHUB_REF') == REF and
         hex_value(environ.get('GITHUB_SHA'), 40), 'unapproved_source_context')
    need(environ.get('FKSSJ_STATUS_LOGS_CURRENT_CONFIRMED') == 'true',
         'running_log_configuration_not_confirmed')


def validate_review(review_json, now):
    need(isinstance(review_json, str) and 0 < len(review_json.encode()) <= 16384,
         'missing_or_oversized_log_review')
    review = strict_json(review_json)
    required = {'schema', 'site', 'endpoint', 'checkedAt', 'targetSha256', 'configSha256',
                'status', 'reasons', 'basis'}
    need(isinstance(review, dict) and required <= set(review) and
         set(review) <= required | {'summaries'}, 'invalid_log_review_shape')
    need(type(review['schema']) is int and review['schema'] == 1 and
         review['site'] == HOST and review['endpoint'] == ENDPOINT and
         review['basis'] == 'disk_configuration_only_not_running_attestation' and
         review['targetSha256'] == TARGET_SHA and hex_value(review['configSha256']) and
         review['status'] == 'safe' and review['reasons'] == [] and
         type(review['checkedAt']) is int and
         0 <= now - review['checkedAt'] <= REVIEW_MAX_AGE, 'log_review_not_safe_current')
    return review


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def make_headers(commit, release_id, request_id, key, now):
    need(hex_value(request_id, 32) and hex_value(release_id, 32), 'invalid_local_nonce')
    # Syntactically valid diagnostic bindings; these identify no package/current.
    envelope = dict(schema=1, operation='status', repo=REPO, ref=REF, commit=commit,
                    requestId=request_id, releaseId=release_id,
                    artifactSha256=PUBLIC_DIGEST, artifactBytes=1,
                    manifestSha256=PUBLIC_DIGEST, expectedCurrent='releases/auth-probe-unused',
                    issuedAt=now, expiresAt=now + 120)
    raw = canonical(envelope)
    return {'X-FKSSJ-Envelope': base64.b64encode(raw).decode('ascii'),
            'X-FKSSJ-Signature': hmac.new(key, DOMAIN + raw, hashlib.sha256).hexdigest()}


def https_status(headers):
    # The stdlib verifies the certificate/hostname and does not follow redirects.
    connection = http.client.HTTPSConnection(HOST, 443, timeout=10,
                                            context=ssl.create_default_context())
    try:
        connection.set_debuglevel(0)
        connection.request('POST', PATH, body=b'', headers=dict(headers, **{
            'Content-Length': '0', 'Content-Type': 'application/octet-stream',
            'User-Agent': 'FKSSJ-Status-Auth-Probe/1'}))
        response = connection.getresponse()
        body = response.read(MAX_RESPONSE + 1)
        return response.status, response.getheaders(), body
    finally:
        connection.close()


def check_response(reply, expected_status, expected_error, phase):
    status, headers, body = reply
    need(type(status) is int and status == expected_status and isinstance(body, bytes)
         and len(body) <= MAX_RESPONSE, phase + '_unexpected_response')
    values = {}
    need(isinstance(headers, (list, tuple)), phase + '_invalid_headers')
    for name, value in headers:
        need(isinstance(name, str) and isinstance(value, str), phase + '_invalid_headers')
        values.setdefault(name.lower(), []).append(value.strip())
    for name, expected in [('cache-control', 'no-store'), ('x-content-type-options', 'nosniff'),
                           ('referrer-policy', 'same-origin')]:
        need(values.get(name) == [expected], phase + '_security_headers_missing')
    content_type = values.get('content-type', [])
    need(len(content_type) == 1 and content_type[0].split(';')[0].strip().lower() == 'application/json',
         phase + '_not_json_response')
    need(strict_json(body) == {'error': expected_error}, phase + '_unexpected_error_body')


def run_probe(environ, review_json, transport=None, *, now=None, nonce=None):
    instant = int(time.time()) if now is None else now
    need(type(instant) is int, 'invalid_clock')
    validate_context(environ)
    validate_review(review_json, instant)
    value = environ.get('FKSSJ_RELEASE_HMAC_KEY_HEX', '')
    need(hex_value(value), 'invalid_secret_format')
    key = bytes.fromhex(value)
    fresh = nonce or (lambda: secrets.token_hex(16))
    release_id, negative_id, positive_id = fresh(), fresh(), fresh()
    need(len({release_id, negative_id, positive_id}) == 3 and
         all(hex_value(v, 32) for v in (release_id, negative_id, positive_id)), 'invalid_local_nonce')
    exchange = transport or https_status
    bad = make_headers(environ['GITHUB_SHA'], release_id, negative_id, key, instant)
    signature = bad['X-FKSSJ-Signature']
    bad['X-FKSSJ-Signature'] = ('0' if signature[0] != '0' else '1') + signature[1:]
    try:
        check_response(exchange(bad), 401, 'auth_failed', 'negative')
    except ProbeError:
        raise
    except BaseException:
        raise ProbeError('negative_transport_outcome_unknown', unknown=True) from None
    # Never send a valid signature if the negative control was not exact.
    good = make_headers(environ['GITHUB_SHA'], release_id, positive_id, key, instant)
    try:
        check_response(exchange(good), 404, 'unknown_release', 'positive')
    except ProbeError:
        raise
    except BaseException:
        raise ProbeError('positive_transport_outcome_unknown', unknown=True) from None
    return {'state': 'hmac_verified_status_only', 'requests': 2, 'expectedNonceRecords': 1,
            'releaseCreated': False, 'activationRequested': False}


def main():
    try:
        need(len(sys.argv) == 1, 'no_cli_arguments_allowed')
        result = run_probe(os.environ, os.environ.get('FKSSJ_STATUS_LOG_REVIEW_JSON', ''))
        print(json.dumps(result, sort_keys=True))
        return 0
    except ProbeError as error:
        print(json.dumps({'state': 'unknown' if error.unknown else 'not_verified',
                          'reason': error.code, 'automaticRetry': False}, sort_keys=True))
        return 3 if error.unknown else 1
    except BaseException:
        print('{"state":"not_verified","reason":"local_failure","automaticRetry":false}')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

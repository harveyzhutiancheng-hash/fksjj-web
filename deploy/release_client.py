#!/usr/bin/env python3
"""Signed release client; template origin must be reviewed before deployment.

Never builds, archives, activates an API, or retries a mutation. A failed or
ambiguous exchange leaves metadata for a separate, freshly signed status call.
The HMAC key is supplied only in FKSSJ_RELEASE_HMAC_KEY_HEX (32 bytes as hex).
"""
import argparse
import base64
import hashlib
import hmac
import http.client
import io
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import stat
import sys
import time
import zipfile

ORIGIN = 'https://fkssj.harvey-ai.xyz/_fkssj-release'
HOST = 'fkssj.harvey-ai.xyz'
BASE_PATH = '/_fkssj-release'
REPO = 'harveyzhutiancheng-hash/fksjj-web'
REF = 'refs/heads/main'
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
MAX_ZIP_BYTES = 20 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024
PREFIX = b'FKSSJ-RELEASE-V1\n'
FIELDS = frozenset('''schema operation repo ref commit requestId releaseId
artifactSha256 artifactBytes manifestSha256 expectedCurrent issuedAt expiresAt'''.split())
BINDINGS = FIELDS - {'schema', 'operation', 'requestId', 'issuedAt', 'expiresAt'}


class ClientError(Exception):
    pass


class UnknownOutcome(ClientError):
    pass


class ConfigurationError(ClientError):
    pass


def require(condition, message):
    if not condition:
        raise ClientError(message)


def hex_string(value, length):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{' + str(length) + '}', value) is not None


def canonical_envelope(envelope):
    require(isinstance(envelope, dict) and set(envelope) == FIELDS, 'invalid envelope fields')
    require(type(envelope['schema']) is int and envelope['schema'] == 1, 'invalid schema')
    require(envelope['operation'] in ('upload', 'status', 'activate'), 'invalid operation')
    require(envelope['repo'] == REPO and envelope['ref'] == REF, 'repo/ref must match fixed main repository')
    for name, length in (('commit', 40), ('requestId', 32), ('releaseId', 32),
                         ('artifactSha256', 64), ('manifestSha256', 64)):
        require(hex_string(envelope[name], length), 'invalid ' + name)
    require(type(envelope['artifactBytes']) is int and 0 < envelope['artifactBytes'] <= MAX_ARTIFACT_BYTES,
            'invalid artifactBytes')
    current = envelope['expectedCurrent']
    require(isinstance(current, str) and
            re.fullmatch(r'releases/[A-Za-z0-9][A-Za-z0-9._-]{0,95}', current) and '..' not in current,
            'expectedCurrent must be an explicitly verified relative release target')
    require(type(envelope['issuedAt']) is int and type(envelope['expiresAt']) is int and
            0 <= envelope['issuedAt'] < envelope['expiresAt'] <= envelope['issuedAt'] + 300,
            'invalid envelope time window')
    return json.dumps(envelope, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('utf-8')


def make_envelope(operation, commit, release_id, artifact_sha256, artifact_bytes,
                  manifest_sha256, expected_current, *, now=None, request_id=None):
    instant = int(time.time()) if now is None else now
    envelope = dict(schema=1, operation=operation, repo=REPO, ref=REF, commit=commit,
                    requestId=request_id or secrets.token_hex(16), releaseId=release_id,
                    artifactSha256=artifact_sha256, artifactBytes=artifact_bytes,
                    manifestSha256=manifest_sha256, expectedCurrent=expected_current,
                    issuedAt=instant, expiresAt=instant + 300)
    canonical_envelope(envelope)
    return envelope


def sign_envelope(envelope, key):
    require(isinstance(key, bytes) and len(key) == 32, 'HMAC key must be exactly 32 bytes')
    canonical = canonical_envelope(envelope)
    return {'X-FKSSJ-Envelope': base64.b64encode(canonical).decode('ascii'),
            'X-FKSSJ-Signature': hmac.new(key, PREFIX + canonical, hashlib.sha256).hexdigest()}


def environment_key():
    value = os.environ.get('FKSSJ_RELEASE_HMAC_KEY_HEX', '')
    require(hex_string(value, 64), 'FKSSJ_RELEASE_HMAC_KEY_HEX must contain 64 lowercase hex characters')
    return bytes.fromhex(value)


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ClientError('invalid JSON constant')))
    except (ValueError, UnicodeError) as exc:
        raise ClientError('invalid JSON') from exc


def read_regular(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'input must be a single-link regular file')
        require(before.st_size <= maximum, 'input exceeds size limit')
        chunks, total = [], 0
        while True:
            chunk = os.read(fd, min(1024 * 1024, maximum + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            require(total <= maximum, 'input grew beyond size limit')
            chunks.append(chunk)
        after = os.fstat(fd)
        require(all(getattr(before, field) == getattr(after, field)
                    for field in ('st_dev', 'st_ino', 'st_size', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns')),
                'input changed during read')
        return b''.join(chunks)
    finally:
        os.close(fd)


def write_exclusive(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            require(count > 0, 'short write')
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def extract_artifact(archive, output):
    """Extract one data file from a downloaded GitHub ZIP; never extract tar."""
    data = read_regular(archive, MAX_ZIP_BYTES)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zipped:
            entries = zipped.infolist()
            require(len(entries) == 1, 'artifact ZIP must contain only release.tar')
            entry = entries[0]
            kind = stat.S_IFMT(entry.external_attr >> 16)
            require(entry.filename == 'release.tar' and not entry.is_dir() and
                    kind in (0, stat.S_IFREG) and not (entry.external_attr & 0x10),
                    'artifact ZIP contains an unapproved path or file type')
            require(not entry.flag_bits & 1, 'encrypted ZIP is unsupported')
            require(0 < entry.file_size <= MAX_ARTIFACT_BYTES and entry.compress_size <= MAX_ZIP_BYTES,
                    'artifact ZIP member exceeds limit')
            with zipped.open(entry) as member:
                payload = member.read(MAX_ARTIFACT_BYTES + 1)
            require(len(payload) == entry.file_size and len(payload) <= MAX_ARTIFACT_BYTES,
                    'artifact ZIP member length mismatch')
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
        raise ClientError('invalid artifact ZIP') from exc
    write_exclusive(output, payload)
    return {'status': 'extracted-data-only', 'artifactBytes': len(payload),
            'artifactSha256': hashlib.sha256(payload).hexdigest()}


def https_transport(path, headers, body):
    # No arbitrary URL, redirect, cookie jar, custom CA, insecure TLS, proxy or
    # retry option. This exact existing site is a reviewed source binding.
    if ORIGIN != 'https://' + HOST + BASE_PATH or HOST.lower().endswith('.invalid'):
        raise ConfigurationError('receiver origin is PLACEHOLDER.invalid; deployment configuration is unfinished')
    connection = http.client.HTTPSConnection(HOST, 443, timeout=30, context=ssl.create_default_context())
    try:
        connection.request('POST', path, body=body,
                           headers=dict(headers, **{'Content-Type': 'application/octet-stream',
                                                    'Content-Length': str(len(body))}))
        response = connection.getresponse()
        data = response.read(MAX_RESPONSE_BYTES + 1)
        require(len(data) <= MAX_RESPONSE_BYTES, 'oversized receiver response')
        return response.status, data
    finally:
        connection.close()


class ReleaseClient:
    def __init__(self, key, *, transport=None):
        require(isinstance(key, bytes) and len(key) == 32, 'HMAC key must be exactly 32 bytes')
        self.key = key
        self.transport = transport or https_transport

    def send(self, envelope, artifact=None):
        headers = sign_envelope(envelope, self.key)
        body = artifact if envelope['operation'] == 'upload' else b''
        require(isinstance(body, bytes), 'upload requires captured artifact bytes')
        if envelope['operation'] == 'upload':
            require(len(body) == envelope['artifactBytes'] and
                    hashlib.sha256(body).hexdigest() == envelope['artifactSha256'], 'artifact binding mismatch')
        try:
            status, raw = self.transport(BASE_PATH + '/v1/' + envelope['operation'], headers, body)
            data = strict_json(raw)
            require(isinstance(data, dict) and data.get('releaseId') == envelope['releaseId'] and
                    isinstance(data.get('state'), str), 'receiver response lacks release binding/state')
            success_code = 200 if envelope['operation'] == 'status' else 202
            require(status == success_code, 'unexpected receiver HTTP status')
            if envelope['operation'] == 'upload':
                require(data['state'] == 'received', 'upload acknowledgement must mean received only')
            return data
        except ConfigurationError:
            raise
        except Exception as exc:
            # Deliberately no second request, including status. A separate CLI
            # invocation signs a fresh nonce and can only query this release ID.
            raise UnknownOutcome('exchange outcome unknown; do not repeat upload/activate; '
                                 'use a separate authenticated status request') from exc


def metadata_for(envelope):
    return {'schema': 1, 'type': 'fkssj-release-client-state',
            'bindings': {name: envelope[name] for name in sorted(BINDINGS)}}


def envelope_from_metadata(metadata, operation):
    require(isinstance(metadata, dict) and set(metadata) == {'schema', 'type', 'bindings'} and
            type(metadata['schema']) is int and metadata['schema'] == 1 and
            metadata['type'] == 'fkssj-release-client-state', 'invalid client metadata')
    values = metadata['bindings']
    require(isinstance(values, dict) and set(values) == BINDINGS and
            values['repo'] == REPO and values['ref'] == REF, 'invalid metadata binding fields')
    return make_envelope(operation, values['commit'], values['releaseId'], values['artifactSha256'],
                         values['artifactBytes'], values['manifestSha256'], values['expectedCurrent'])


def prepare_upload(artifact_path, commit, release_id, manifest_sha256, expected_current, metadata_path):
    artifact = read_regular(artifact_path, MAX_ARTIFACT_BYTES)
    envelope = make_envelope('upload', commit, release_id, hashlib.sha256(artifact).hexdigest(),
                             len(artifact), manifest_sha256, expected_current)
    metadata = metadata_for(envelope)
    write_exclusive(metadata_path, (json.dumps(metadata, sort_keys=True) + '\n').encode('utf-8'))
    return {'status': 'prepared-only', 'metadata': str(Path(metadata_path)), 'recovery': metadata}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='operation', required=True)
    extract = commands.add_parser('extract-artifact')
    extract.add_argument('--zip', required=True)
    extract.add_argument('--output', required=True)
    prepare = commands.add_parser('prepare-upload')
    prepare.add_argument('--artifact', required=True)
    prepare.add_argument('--commit', required=True)
    prepare.add_argument('--release-id', required=True)
    prepare.add_argument('--manifest-sha256', required=True)
    prepare.add_argument('--expected-current', required=True)
    prepare.add_argument('--metadata', required=True)
    upload = commands.add_parser('upload')
    upload.add_argument('--artifact', required=True)
    upload.add_argument('--metadata', required=True)
    for operation in ('status', 'activate'):
        query = commands.add_parser(operation)
        query.add_argument('--metadata', required=True)
    args = parser.parse_args(argv)
    try:
        if args.operation == 'extract-artifact':
            result = extract_artifact(args.zip, args.output)
        elif args.operation == 'prepare-upload':
            result = prepare_upload(args.artifact, args.commit, args.release_id,
                                     args.manifest_sha256, args.expected_current, args.metadata)
        else:
            client = ReleaseClient(environment_key())
            artifact = None
            metadata = strict_json(read_regular(args.metadata, 16 * 1024))
            envelope = envelope_from_metadata(metadata, args.operation)
            if args.operation == 'upload':
                artifact = read_regular(args.artifact, MAX_ARTIFACT_BYTES)
                require(len(artifact) == envelope['artifactBytes'] and
                        hashlib.sha256(artifact).hexdigest() == envelope['artifactSha256'], 'artifact binding mismatch')
            if args.operation in ('upload', 'activate'):
                # Persistent one-attempt marker is created BEFORE any request.
                # Never delete it automatically, including on local interruption.
                attempt = str(args.metadata) + '.' + args.operation + '-attempted'
                write_exclusive(attempt, (json.dumps(envelope, sort_keys=True) + '\n').encode('utf-8'))
            result = client.send(envelope, artifact)
            result = dict(result, metadata=str(Path(args.metadata)))
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ClientError, OSError, zipfile.LargeZipFile) as exc:
        # Do not print secret-bearing exception messages from a network stack.
        unknown = isinstance(exc, UnknownOutcome)
        result = {'status': 'unknown' if unknown else 'failed', 'operation': args.operation,
                  'error': str(exc) if isinstance(exc, ClientError) else 'local file operation failed'}
        if getattr(args, 'metadata', None):
            result['metadata'] = str(Path(args.metadata))
        print(json.dumps(result, sort_keys=True), file=sys.stderr)
        return 3 if unknown else 1


if __name__ == '__main__':
    sys.exit(main())

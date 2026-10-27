#!/usr/bin/env python3
"""Bounded release orchestration; defaults to stage, never creates API evidence.

Build/package commands live in the approval-gated manual workflow. This module can
capture a pre-existing verified static tree, wait using fresh signed status
requests, and perform one explicitly chosen activation. Unknown outcomes never
trigger a second mutation, automatic rollback, or a changed expected-current.
"""
import argparse
import base64
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
import tarfile
import time


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


client = load_module('orchestration_client', 'release_client.py')
release = load_module('orchestration_static', 'static-release.py')


class OrchestrationFailure(Exception):
    pass


class OrchestrationUnknown(OrchestrationFailure):
    pass


class OrchestrationTimeout(OrchestrationUnknown):
    pass


def require(condition, code):
    if not condition:
        raise OrchestrationFailure(code)


def metadata_value(metadata):
    # Reuse the existing strict metadata/binding validation; no receipt fields.
    client.envelope_from_metadata(metadata, 'status')
    return metadata['bindings']


def bounded_exchange(message, timeout):
    """Kill/reap one fixed helper on a hard deadline, including DNS/read stalls.

    Secret bytes travel only through a private stdin pipe, never argv or files.
    A killed activation may already have executed: callers must NOT retry it.
    """
    require(type(timeout) in (int, float) and 0 < timeout <= 30, 'invalid_exchange_limit')
    output_limit=512*1024
    if isinstance(message, dict) and message.get('kind') == 'resource':
        require(set(message) == {'kind','path','limit'}, 'invalid_public_resource_input')
        public_resource_input(message.get('path'),message.get('limit'))
        output_limit=4*((message['limit']+2)//3)+8192
    try:
        result = subprocess.run([sys.executable, '-I', '-B', str(Path(__file__).absolute()), '_http'],
                                input=json.dumps(message).encode(), stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=timeout,
                                env={'LC_ALL': 'C'}, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise client.UnknownOutcome('exchange_deadline_unknown_no_retry') from None
    if result.returncode != 0 or len(result.stdout) > output_limit:
        raise client.UnknownOutcome('exchange_child_unknown_no_retry')
    try:
        return client.strict_json(result.stdout)
    except client.ClientError:
        raise client.UnknownOutcome('exchange_child_response_unknown') from None


class BoundedClient:
    def __init__(self, key):
        client.require(isinstance(key, bytes) and len(key) == 32, 'invalid HMAC key')
        self.key = key

    def send(self, envelope, timeout=30):
        client.canonical_envelope(envelope)
        require(envelope['operation'] in ('status', 'activate'), 'bounded_client_operation')
        return bounded_exchange({'kind': 'signed', 'key': self.key.hex(), 'envelope': envelope}, timeout)


def send_with_limit(instance, envelope, timeout):
    # Injected fixture clients have cooperative clocks/transports; production
    # CLI uses the killable fixed subprocess, not an uninterruptible thread.
    return (instance.send(envelope, timeout=timeout) if isinstance(instance, BoundedClient)
            else instance.send(envelope))


def bundle(source, output, info_path=None):
    """Capture only the fixed static allowlist; never invokes a game build."""
    source, output = Path(source), Path(output)
    require(source.is_absolute() and output.is_absolute(), 'absolute_bundle_paths_required')
    raw = release.read_absolute(source / 'release.json', 256 * 1024)
    manifest_hash = hashlib.sha256(raw).hexdigest()
    with release.directory(source) as fd:
        manifest, captured = release.snapshot_fd(fd, manifest_hash)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, data in sorted(captured.items()):
            member = tarfile.TarInfo(name)
            member.size, member.mode, member.mtime = len(data), 0o644, 0
            member.uid = member.gid = 0
            archive.addfile(member, io.BytesIO(data))
    payload = buffer.getvalue()
    require(0 < len(payload) <= client.MAX_ARTIFACT_BYTES, 'artifact_limit')
    info = {'version': manifest['version'], 'manifestSha256': manifest_hash,
            'artifactSha256': hashlib.sha256(payload).hexdigest(),
            'artifactBytes': len(payload), 'artifact': str(output)}
    client.write_exclusive(output, payload)
    if info_path is not None:
        client.write_exclusive(info_path, (json.dumps(info, sort_keys=True) + '\n').encode())
    return info


def wait_for_release(client_instance, metadata, target='staged', timeout=180,
                     interval=5, clock=time.monotonic, sleep=time.sleep,
                     request_id=None):
    bindings = metadata_value(metadata)
    require(target in ('staged', 'activated'), 'invalid_wait_target')
    require(type(timeout) in (int, float) and 0 < timeout <= 300 and
            type(interval) in (int, float) and 1 <= interval <= 30, 'invalid_poll_limits')
    if target == 'activated':
        require(client.hex_string(request_id, 32), 'activation_request_id_required')
    deadline = clock() + timeout
    # Also bound iteration count independently of a stalled/injected clock.
    maximum = min(301, int(timeout / interval) + 2)
    for attempt in range(1, maximum + 1):
        if clock() >= deadline:
            raise OrchestrationTimeout('status_deadline_stop_no_mutation_retry')
        envelope = client.envelope_from_metadata(metadata, 'status')
        remaining = deadline - clock()
        if remaining <= 0:
            raise OrchestrationTimeout('status_deadline_stop_no_mutation_retry')
        try:
            status = send_with_limit(client_instance, envelope, min(30, remaining))
        except (client.ClientError, OSError):
            raise OrchestrationUnknown('status_exchange_unknown_stop') from None
        if clock() >= deadline:
            raise OrchestrationTimeout('status_deadline_stop_no_mutation_retry')
        if not isinstance(status, dict) or status.get('releaseId') != bindings['releaseId']:
            raise OrchestrationUnknown('status_release_binding_mismatch')
        state, last = status.get('state'), status.get('lastOperation')
        if not isinstance(last, dict):
            raise OrchestrationUnknown('status_operation_missing')
        if state == 'uncertain' or last.get('state') == 'uncertain':
            raise OrchestrationUnknown('server_uncertain_manual_review')
        if state == 'rejected' or last.get('state') == 'rejected':
            # Never print arbitrary server error text or treat this as retryable.
            code = 'api_gate' if last.get('error') == 'api_gate' else 'release_operation_rejected'
            raise OrchestrationFailure(code)
        if target == 'activated' and (last.get('operation') != 'activate'
                                    or last.get('requestId') != request_id):
            raise OrchestrationUnknown('activation_operation_binding_mismatch')
        if state == target:
            expected_operation = 'activate' if target == 'activated' else 'upload'
            if last.get('operation') != expected_operation or last.get('state') != 'completed':
                raise OrchestrationUnknown('completed_state_operation_mismatch')
            return dict(status, polls=attempt)
        allowed = ('receiving', 'received') if target == 'staged' else ('staged',)
        if state not in allowed or last.get('state') not in ('receiving', 'queued', 'processing', 'completed'):
            raise OrchestrationUnknown('unexpected_release_state')
        sleep(min(interval, max(0, deadline - clock())))
    raise OrchestrationTimeout('poll_limit_stop_no_mutation_retry')


def https_manifest(path):
    if (client.ORIGIN != 'https://' + client.HOST + client.BASE_PATH
            or client.HOST.lower().endswith('.invalid')):
        raise OrchestrationFailure('public_site_placeholder_not_configured')
    require(re.fullmatch(r'/release\.json\?fkssj_release=[0-9a-f]{32}', path), 'invalid_public_manifest_path')
    connection = http.client.HTTPSConnection(client.HOST, 443, timeout=30,
                                            context=ssl.create_default_context())
    try:
        connection.request('GET', path, headers={'Cache-Control': 'no-cache', 'Pragma': 'no-cache'})
        response = connection.getresponse()
        raw = response.read(256 * 1024 + 1)
        require(len(raw) <= 256 * 1024, 'public_manifest_limit')
        return response.status, raw
    finally:
        connection.close()


def bounded_manifest(path,timeout=30):
    value = bounded_exchange({'kind': 'manifest', 'path': path}, timeout)
    require(isinstance(value, dict) and set(value) == {'httpStatus', 'body'}, 'public_child_response')
    try:
        raw = base64.b64decode(value['body'], validate=True)
    except (ValueError, TypeError):
        raise OrchestrationUnknown('public_child_response_invalid') from None
    return value['httpStatus'], raw


MISSING_RESOURCE = '/__fkssj_missing_module_probe__.js'
PUBLIC_RESOURCE_PATHS = frozenset('/'+name for name in release.FILES) | {'/release.json',MISSING_RESOURCE}
MAX_PUBLIC_FILE_BYTES = min(release.MAX_FILE,client.MAX_ARTIFACT_BYTES)
PUBLIC_HEADERS = ('content-type','cache-control','x-content-type-options')


def public_resource_input(path,limit):
    require(isinstance(path,str) and path in PUBLIC_RESOURCE_PATHS,'invalid_public_resource_path')
    maximum = 65536 if path == MISSING_RESOURCE else 256*1024 if path == '/release.json' else MAX_PUBLIC_FILE_BYTES
    require(type(limit) is int and 0 <= limit <= maximum,'invalid_public_resource_limit')


def https_resource(path,limit):
    """One fixed-origin GET; no redirect following, URL input or API route."""
    public_resource_input(path,limit)
    if (client.ORIGIN != 'https://' + client.HOST + client.BASE_PATH
            or client.HOST.lower().endswith('.invalid')):
        raise OrchestrationFailure('public_site_placeholder_not_configured')
    connection = http.client.HTTPSConnection(client.HOST,443,timeout=30,
                                            context=ssl.create_default_context())
    try:
        connection.request('GET',path,headers={'Cache-Control':'no-cache','Pragma':'no-cache','Accept-Encoding':'identity'})
        response = connection.getresponse()
        raw = response.read(limit+1)
        require(len(raw) <= limit,'public_resource_limit_no_rollback')
        headers = {name:[] for name in PUBLIC_HEADERS}
        for name,value in response.getheaders():
            key=name.lower()
            if key in headers:
                require(isinstance(value,str) and len(value)<=1024 and len(headers[key])<4,'public_resource_headers_no_rollback')
                headers[key].append(value)
        return response.status,headers,raw
    finally:
        connection.close()


def bounded_resource(path,limit,timeout=30):
    public_resource_input(path,limit)
    value=bounded_exchange({'kind':'resource','path':path,'limit':limit},timeout)
    require(isinstance(value,dict) and set(value)=={'httpStatus','headers','body'},'public_resource_child_response')
    headers=value['headers']
    require(type(value['httpStatus']) is int and isinstance(headers,dict) and set(headers)==set(PUBLIC_HEADERS),
            'public_resource_child_response')
    require(all(isinstance(values,list) and len(values)<=4
                and all(isinstance(v,str) and len(v)<=1024 for v in values) for values in headers.values()),
            'public_resource_child_response')
    try:
        raw=base64.b64decode(value['body'],validate=True)
    except (ValueError,TypeError):
        raise OrchestrationUnknown('public_resource_child_response_invalid') from None
    require(len(raw)<=limit,'public_resource_limit_no_rollback')
    return value['httpStatus'],headers,raw


def public_manifest_rows(manifest):
    require(isinstance(manifest,dict) and set(manifest)=={'version','createdAt','fileCount','totalBytes','files'},
            'public_resource_manifest_invalid_no_rollback')
    require(type(manifest['fileCount']) is int and manifest['fileCount']==len(release.FILES)
            and type(manifest['totalBytes']) is int and 0 <= manifest['totalBytes'] <= client.MAX_ARTIFACT_BYTES
            and isinstance(manifest['files'],list) and len(manifest['files'])==len(release.FILES),
            'public_resource_manifest_invalid_no_rollback')
    try:release.timestamp(manifest['createdAt'])
    except release.ReleaseError:raise OrchestrationFailure('public_resource_manifest_invalid_no_rollback') from None
    rows={}
    for row in manifest['files']:
        require(isinstance(row,dict) and set(row)=={'path','bytes','sha256'}
                and isinstance(row['path'],str) and row['path'] in release.FILES and row['path'] not in rows
                and type(row['bytes']) is int and 0 <= row['bytes'] <= MAX_PUBLIC_FILE_BYTES
                and client.hex_string(row['sha256'],64),'public_resource_manifest_invalid_no_rollback')
        rows[row['path']]=row
    require(set(rows)==release.FILES and sum(row['bytes'] for row in rows.values())==manifest['totalBytes'],
            'public_resource_manifest_invalid_no_rollback')
    return rows


def public_mime(path):
    return {'.js':{'application/javascript','text/javascript'},'.css':{'text/css'},'.html':{'text/html'},
            '.json':{'application/json'},'.svg':{'image/svg+xml'}}.get(Path(path).suffix,{'application/octet-stream'})


def resource_headers(headers,path):
    require(isinstance(headers,dict) and set(headers)==set(PUBLIC_HEADERS),'public_resource_headers_no_rollback')
    require(all(isinstance(v,list) and len(v)==1 and isinstance(v[0],str) for v in headers.values()),
            'public_resource_headers_no_rollback')
    require(headers['x-content-type-options']==['nosniff']
            and 'no-cache' in {item.strip().lower() for item in headers['cache-control'][0].split(',')}
            and headers['content-type'][0].split(';',1)[0].strip().lower() in public_mime(path),
            'public_resource_headers_no_rollback')


def verify_live(metadata, expected_version, fetch=None, *, verify_files=False,
                fetch_resource=None,clock=time.monotonic,timeout=180):
    bindings = metadata_value(metadata)
    require(type(verify_files) is bool,'invalid_public_verification_mode')
    require(isinstance(expected_version, str) and
            re.fullmatch(r'\d+\.\d+\.\d+', expected_version), 'invalid_expected_version')
    if verify_files:
        require(type(timeout) in (int,float) and 0 < timeout <= 300,'invalid_public_verification_limit')
        deadline=clock()+timeout
    try:
        path='/release.json?fkssj_release='+bindings['releaseId']
        if verify_files and fetch is None:
            remaining=deadline-clock()
            if remaining<=0:raise OrchestrationTimeout('public_resources_deadline_no_rollback')
            status,raw=bounded_manifest(path,min(30,remaining))
        else:
            status,raw=(fetch or bounded_manifest)(path)
    except (OSError, http.client.HTTPException, client.UnknownOutcome):
        raise OrchestrationUnknown('public_verification_exchange_unknown_no_rollback') from None
    if verify_files and clock()>=deadline:raise OrchestrationTimeout('public_resources_deadline_no_rollback')
    require(status == 200 and isinstance(raw, bytes) and len(raw) <= 256 * 1024, 'public_manifest_unavailable_no_rollback')
    require(hashlib.sha256(raw).hexdigest() == bindings['manifestSha256'], 'public_manifest_hash_mismatch_no_rollback')
    try:
        manifest = client.strict_json(raw)
    except client.ClientError:
        raise OrchestrationFailure('public_manifest_invalid_no_rollback') from None
    require(isinstance(manifest, dict) and manifest.get('version') == expected_version,
            'public_version_mismatch_no_rollback')
    result = {'releaseId': bindings['releaseId'], 'version': expected_version,
              'manifestSha256': bindings['manifestSha256'],
              'verification': 'authenticated activation operation plus exact public manifest bytes'}
    if not verify_files:return result
    rows=public_manifest_rows(manifest)
    rows['release.json']={'path':'release.json','bytes':len(raw),'sha256':bindings['manifestSha256']}
    for name,row in sorted(rows.items()):
        remaining=deadline-clock()
        if remaining <= 0:raise OrchestrationTimeout('public_resources_deadline_no_rollback')
        try:
            code,headers,body=(fetch_resource or bounded_resource)('/'+name,row['bytes'],min(30,remaining))
        except (OSError,http.client.HTTPException,client.UnknownOutcome):
            raise OrchestrationUnknown('public_resource_exchange_unknown_no_rollback') from None
        if clock() >= deadline:raise OrchestrationTimeout('public_resources_deadline_no_rollback')
        require(code==200 and isinstance(body,bytes) and len(body)==row['bytes']
                and hashlib.sha256(body).hexdigest()==row['sha256'],'public_resource_mismatch_no_rollback')
        resource_headers(headers,'/'+name)
    remaining=deadline-clock()
    if remaining <= 0:raise OrchestrationTimeout('public_resources_deadline_no_rollback')
    try:
        code,headers,body=(fetch_resource or bounded_resource)(MISSING_RESOURCE,65536,min(30,remaining))
    except (OSError,http.client.HTTPException,client.UnknownOutcome):
        raise OrchestrationUnknown('public_resource_exchange_unknown_no_rollback') from None
    if clock() >= deadline:raise OrchestrationTimeout('public_resources_deadline_no_rollback')
    require(code==404 and isinstance(body,bytes) and len(body)<=65536,'public_missing_module_not_404_no_rollback')
    return dict(result,verification='authenticated activation plus exact public manifest, 34 static resources and response headers',
                publicFilesVerified=len(release.FILES),publicManifestHeadersVerified=True,missingModule404Verified=True)


def orchestrate(client_instance, metadata, metadata_path, mode='stage',
                expected_version='0.14.0', timeout=180, interval=5,
                clock=time.monotonic, sleep=time.sleep, fetch=None, *,
                verify_files=False,fetch_resource=None):
    require(type(verify_files) is bool,'invalid_public_verification_mode')
    require(mode in ('stage', 'activate'), 'explicit_stage_or_activate_required')
    require(mode != 'activate' or expected_version == release.VERSION,
            'unsupported_expected_version_before_activation')
    staged = wait_for_release(client_instance, metadata, 'staged', timeout,
                              interval, clock, sleep)
    if mode == 'stage':
        return dict(staged, status='staged_only', activated=False)
    envelope = client.envelope_from_metadata(metadata, 'activate')
    try:
        # Identical persistent marker to the existing activate CLI. No receipt,
        # key or signature is written, and no automatic cleanup/retry exists.
        marker = Path(os.path.abspath(metadata_path))
        with release.directory(marker.parent) as parent:
            fd = os.open(marker.name + '.activate-attempted',
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=parent)
            with os.fdopen(fd, 'wb') as output:
                output.write((json.dumps(envelope, sort_keys=True) + '\n').encode())
                output.flush()
                os.fsync(output.fileno())
            os.fsync(parent)
    except OSError:
        raise OrchestrationUnknown('activation_marker_unavailable_or_preexisting_stop') from None
    try:
        acknowledgement = send_with_limit(client_instance, envelope, 30)
    except (client.ClientError, OSError):
        raise OrchestrationUnknown('activation_exchange_unknown_no_retry') from None
    if (not isinstance(acknowledgement, dict)
            or acknowledgement.get('releaseId') != metadata['bindings']['releaseId']
            or acknowledgement.get('requestId') != envelope['requestId']
            or acknowledgement.get('state') != 'activation_queued'):
        raise OrchestrationUnknown('activation_ack_binding_mismatch_no_retry')
    completed = wait_for_release(client_instance, metadata, 'activated', timeout,
                                 interval, clock, sleep, request_id=envelope['requestId'])
    verification = verify_live(metadata, expected_version, fetch,verify_files=verify_files,
                               fetch_resource=fetch_resource,clock=clock,timeout=timeout)
    return dict(verification, status='verified', state=completed['state'], activated=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='operation', required=True)
    pack = commands.add_parser('bundle')
    pack.add_argument('--source', required=True)
    pack.add_argument('--output', required=True)
    pack.add_argument('--info', required=True)
    wait = commands.add_parser('wait')
    wait.add_argument('--target', choices=['staged'], required=True)
    activate = commands.add_parser('activate')
    activate.add_argument('--expected-version', required=True)
    activate.add_argument('--verify-files',action='store_true',help='Also verify the 34 fixed public resources, headers and missing-module 404')
    for command in (wait, activate):
        command.add_argument('--metadata', required=True)
        command.add_argument('--timeout', type=int, default=180)
        command.add_argument('--interval', type=int, default=5)
    args = parser.parse_args(argv)
    try:
        if args.operation == 'bundle':
            result = bundle(args.source, args.output, args.info)
        else:
            metadata = client.strict_json(client.read_regular(args.metadata, 16384))
            instance = BoundedClient(client.environment_key())
            result = orchestrate(instance, metadata, args.metadata,
                                 mode='stage' if args.operation == 'wait' else 'activate',
                                 expected_version=getattr(args, 'expected_version', '0.14.0'),
                                 timeout=args.timeout, interval=args.interval,
                                 verify_files=getattr(args,'verify_files',False))
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OrchestrationFailure, client.ClientError, release.ReleaseError, OSError) as exc:
        outcome = ('timeout' if isinstance(exc, OrchestrationTimeout) else
                   'unknown' if isinstance(exc, OrchestrationUnknown) else 'failed')
        code = str(exc) if isinstance(exc, OrchestrationFailure) else 'local_input_or_storage_error'
        print(json.dumps({'status': outcome, 'operation': args.operation, 'error': code,
                          'activationMayHaveCompleted': args.operation == 'activate',
                          'mutationRetry': False, 'automaticRollback': False}), file=sys.stderr)
        return 3 if outcome in ('unknown', 'timeout') else 1


if __name__ == '__main__':
    if sys.argv[1:] == ['_http']:
        # Internal one-exchange child; all destinations/operations stay fixed.
        # Clear inherited credentials; signed requests receive a key via stdin.
        try:
            message = client.strict_json(sys.stdin.buffer.read(8193))
            if message.get('kind') == 'signed':
                require(set(message) == {'kind', 'key', 'envelope'}
                        and message['envelope']['operation'] in ('status', 'activate'), 'invalid_child_input')
                result = client.ReleaseClient(bytes.fromhex(message['key'])).send(message['envelope'])
            elif message.get('kind') == 'manifest':
                require(set(message) == {'kind','path'},'invalid_child_input')
                status,raw=https_manifest(message['path'])
                result={'httpStatus':status,'body':base64.b64encode(raw).decode('ascii')}
            else:
                require(set(message)=={'kind','path','limit'} and message.get('kind')=='resource','invalid_child_input')
                status,headers,raw=https_resource(message['path'],message['limit'])
                result={'httpStatus':status,'headers':headers,'body':base64.b64encode(raw).decode('ascii')}
            print(json.dumps(result, sort_keys=True))
        except Exception:
            print('{"error":"exchange_unknown"}')
            sys.exit(3)
    else:
        sys.exit(main())

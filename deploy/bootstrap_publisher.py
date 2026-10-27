#!/usr/bin/env python3
"""Pinned GitHub source bootstrap. No server changes before all bytes verify.

Only the reviewed helper commit and preflight/apply choice are parameters. All
source bytes stay in memory. This never retries a request or an uncertain
installation and never reads credentials or player data.
"""
import hashlib
import http.client
import json
import os
import re
import ssl
import sys
import types

HOST = 'raw.githubusercontent.com'
REPO = 'harveyzhutiancheng-hash/fksjj-web'
SOURCE_COMMIT = '754a6a522e17538c5b9769afd112844dc7ed02c7'
BINDINGS_PATH = 'deploy/publisher-install-bindings.json'
BINDINGS_BYTES = 2000
BINDINGS_SHA256 = '214904cf206c86587a0dfaf338dbf48ee8756183e0d968dcc818487d4987e1ab'
CORE_PATH = 'deploy/install_publisher.py'
# Finalized after the independently reviewed core has stopped changing.
CORE_BYTES = 32171
CORE_SHA256 = 'de679fd5647b9ab2d90ae3c78f5ae709ffe6bf12540306a180a9bbd975e88ddb'
SOURCES = {
    'release_channel.py': 'deploy/release_channel.py',
    'static-release.py': 'deploy/static-release.py',
    'publisher_pipeline.py': 'deploy/publisher_pipeline.py',
    'manual_api_acceptance.py': 'deploy/manual_api_acceptance.py',
    'manual_static_switch.py': 'deploy/manual_static_switch.py',
    'receipt-v0.13.0-2026-10-20.json': 'deploy/receipt-v0.13.0-2026-10-20.json',
    'fkssj-release.service': 'deploy/templates/fkssj-release.service',
    'fkssj-publisher.service': 'deploy/templates/fkssj-publisher.service',
    'fkssj-publisher.timer': 'deploy/templates/fkssj-publisher.timer',
    'policy': 'deploy/templates/publisher-config.example.json',
    'nginx': 'deploy/templates/nginx-release.conf',
    'candidate': 'deploy/approved-v014-release.json',
}

class Stopped(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)

def need(condition, reason):
    if not condition:
        raise Stopped(reason)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def parse(raw):
    def pairs(rows):
        answer = {}
        for key, value in rows:
            need(key not in answer, 'bindings')
            answer[key] = value
        return answer
    try:
        return json.loads(raw, object_pairs_hook=pairs)
    except Stopped:
        raise
    except Exception:
        raise Stopped('bindings') from None

def fetch(commit, path, expected_size, expected_digest, connection=None):
    need(re.fullmatch('[0-9a-f]{40}', commit or '') is not None, 'arguments')
    need(path in {CORE_PATH, BINDINGS_PATH, *SOURCES.values()}, 'path')
    need(type(expected_size) is int and 0 < expected_size <= 256 * 1024
         and re.fullmatch('[0-9a-f]{64}', expected_digest or '') is not None, 'pin')
    try:
        connection = connection or http.client.HTTPSConnection(
            HOST, timeout=20, context=ssl.create_default_context())
        connection.request('GET', '/' + REPO + '/' + commit + '/' + path,
                           headers={'Accept-Encoding': 'identity', 'User-Agent': 'fkssj-reviewed-bootstrap/1'})
        response = connection.getresponse()
        need(response.status == 200 and response.getheader('Content-Encoding', 'identity') == 'identity', 'download')
        declared = response.getheader('Content-Length')
        need(declared is None or declared == str(expected_size), 'size')
        raw = response.read(expected_size + 1)
        need(len(raw) == expected_size, 'size')
        need(digest(raw) == expected_digest, 'digest')
        return raw
    except Stopped:
        raise
    except Exception:
        raise Stopped('download') from None
    finally:
        if connection is not None:
            connection.close()

def bundle(helper_commit, downloader=fetch):
    need(re.fullmatch('[0-9a-f]{40}', helper_commit or '') is not None, 'arguments')
    raw_bindings = downloader(helper_commit, BINDINGS_PATH, BINDINGS_BYTES, BINDINGS_SHA256)
    bindings = parse(raw_bindings)
    need(isinstance(bindings, dict) and set(bindings) == {'schema', 'repo', 'sourceCommit', 'files'}
         and type(bindings['schema']) is int and bindings['schema'] == 1
         and bindings['repo'] == REPO and bindings['sourceCommit'] == SOURCE_COMMIT
         and isinstance(bindings['files'], dict) and set(bindings['files']) == set(SOURCES), 'bindings')
    core = downloader(helper_commit, CORE_PATH, CORE_BYTES, CORE_SHA256)
    payload = {}
    total = len(raw_bindings) + len(core)
    for name, path in SOURCES.items():
        row = bindings['files'][name]
        need(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256'}
             and row['path'] == path and type(row['bytes']) is int
             and 0 < row['bytes'] <= 256 * 1024
             and re.fullmatch('[0-9a-f]{64}', row['sha256'] or '') is not None, 'bindings')
        total += row['bytes']
        need(total <= 2 * 1024 * 1024, 'size')
        payload[name] = downloader(SOURCE_COMMIT, path, row['bytes'], row['sha256'])
    # Defense in depth if a test/injected transport is used.
    need(len(raw_bindings) == BINDINGS_BYTES and digest(raw_bindings) == BINDINGS_SHA256
         and len(core) == CORE_BYTES and digest(core) == CORE_SHA256, 'digest')
    for name, raw in payload.items():
        row = bindings['files'][name]
        need(isinstance(raw, bytes) and len(raw) == row['bytes'] and digest(raw) == row['sha256'], 'digest')
    return raw_bindings, bindings, core, payload

def run(helper_commit, mode):
    need(os.geteuid() == 0, 'root')
    need(mode in ('preflight', 'apply'), 'arguments')
    raw_bindings, bindings, core, payload = bundle(helper_commit)
    module = types.ModuleType('reviewed_publisher_install')
    module.__file__ = '<reviewed-install_publisher.py>'
    exec(compile(core, module.__file__, 'exec'), module.__dict__)
    engine = module.Engine(module.Host(), payload, bindings)
    if mode == 'preflight':
        try:
            result = engine.preflight()
        except module.Failure as error:
            # Core's Failure constructor already restricts code to fixed enums.
            result = {'state': 'preflight_stopped_no_changes', 'reason': error.code,
                      'mutations': False, 'accountsCreated': 0}
    else:
        # The reviewed bindings file is canonical JSON; core also validates it.
        result = engine.apply(engine.digest)
    return dict(result, downloadedSourceCommit=SOURCE_COMMIT, helperCommit=helper_commit,
                downloadedSourceStored=False)

def main():
    try:
        need(len(sys.argv) == 3, 'arguments')
        result = run(sys.argv[1], sys.argv[2])
    except BaseException as error:
        result = {'state': 'bootstrap_stopped_no_installation_retry',
                  'reason': error.reason if isinstance(error, Stopped) else 'unexpected',
                  'downloadedSourceStored': False}
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))
    return 0 if result.get('state') in ('preflight_ready', 'installed_verified') else 1

if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""One reviewed partial-install continuation, using fixed, verified GitHub bytes.

All downloaded source remains in memory. This loads the old bootstrap as a
module and calls bundle(), never its run()/main() or the old Engine.apply().
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
BASE_COMMIT = 'f91f1b4f8005f94fac618170b67e9bfee99775dc'
BASE_PATH = 'deploy/bootstrap_publisher.py'
BASE_BYTES = 7046
BASE_SHA256 = 'b803e52ed54ea7e59671b6ade017493ece7e8a2a6c2b5b53bc4091691ef6f6b3'
SOURCE_COMMIT = '754a6a522e17538c5b9769afd112844dc7ed02c7'
RESUME_PATH = 'deploy/resume_publisher.py'
# Finalize only after the reviewed continuation code stops changing.
RESUME_BYTES = 9289
RESUME_SHA256 = 'cede2e46492838348e54977ac52cbb74d20f11b22de15ec9ba36c0f9e65f5aa1'

class Stopped(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)

def need(condition, reason):
    if not condition:
        raise Stopped(reason)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def fetch(commit, path, size, sha256, connection=None):
    need(isinstance(commit, str) and re.fullmatch('[0-9a-f]{40}', commit) is not None, 'arguments')
    need(path in (BASE_PATH, RESUME_PATH) and (path != BASE_PATH or commit == BASE_COMMIT), 'path')
    need(type(size) is int and 0 < size <= 256 * 1024 and isinstance(sha256, str)
         and re.fullmatch('[0-9a-f]{64}', sha256) is not None, 'pin')
    try:
        connection = connection or http.client.HTTPSConnection(HOST, timeout=20, context=ssl.create_default_context())
        connection.request('GET', '/' + REPO + '/' + commit + '/' + path,
                           headers={'Accept-Encoding': 'identity', 'User-Agent': 'fkssj-reviewed-resume/1'})
        response = connection.getresponse()
        need(response.status == 200 and response.getheader('Content-Encoding', 'identity') == 'identity', 'download')
        length = response.getheader('Content-Length')
        need(length is None or length == str(size), 'size')
        raw = response.read(size + 1)
        need(len(raw) == size, 'size')
        need(digest(raw) == sha256, 'digest')
        return raw
    except Stopped:
        raise
    except Exception:
        raise Stopped('download') from None
    finally:
        if connection is not None:
            connection.close()

def module(raw, name):
    loaded = types.ModuleType(name)
    loaded.__file__ = '<hash-verified-' + name + '>'
    exec(compile(raw, loaded.__file__, 'exec'), loaded.__dict__)
    return loaded

def sources(helper_commit, downloader=fetch):
    need(isinstance(helper_commit, str) and re.fullmatch('[0-9a-f]{40}', helper_commit) is not None, 'arguments')
    base_raw = downloader(BASE_COMMIT, BASE_PATH, BASE_BYTES, BASE_SHA256)
    need(isinstance(base_raw, bytes) and len(base_raw) == BASE_BYTES and digest(base_raw) == BASE_SHA256, 'digest')
    base = module(base_raw, 'reviewed_publisher_base')
    need(base.SOURCE_COMMIT == SOURCE_COMMIT, 'source')
    # bundle() checks the old core, bindings and all twelve original payloads.
    # Its downloader, helper commit and all main source pins are already fixed.
    try:
        raw_bindings, bindings, core_raw, payload = base.bundle(BASE_COMMIT)
    except base.Stopped as error:
        codes = {'arguments', 'path', 'pin', 'download', 'size', 'digest', 'bindings'}
        raise Stopped(error.reason if error.reason in codes else 'unexpected') from None
    resume_raw = downloader(helper_commit, RESUME_PATH, RESUME_BYTES, RESUME_SHA256)
    need(isinstance(resume_raw, bytes) and len(resume_raw) == RESUME_BYTES
         and digest(resume_raw) == RESUME_SHA256, 'digest')
    return core_raw, resume_raw, payload, bindings

def run(helper_commit, mode):
    need(os.geteuid() == 0, 'root')
    need(mode in ('preflight', 'apply'), 'arguments')
    core_raw, resume_raw, payload, bindings = sources(helper_commit)
    core = module(core_raw, 'reviewed_publisher_core')
    resume = module(resume_raw, 'reviewed_publisher_resume')
    if mode == 'preflight':
        try:
            continuation = resume.Resume(core, core.Host(), payload, bindings)
            result = continuation.preflight()
        except core.Failure as error:
            code = error.code if error.code in core.REASONS else 'unexpected'
            result = {'state': 'preflight_stopped_no_changes', 'reason': code,
                      'mutations': False, 'accountsCreated': 0}
    else:
        continuation = resume.Resume(core, core.Host(), payload, bindings)
        result = continuation.apply()
    return dict(result, downloadedSourceCommit=SOURCE_COMMIT, baseInstallerCommit=BASE_COMMIT,
                helperCommit=helper_commit, downloadedSourceStored=False)

def main():
    try:
        need(len(sys.argv) == 3, 'arguments')
        result = run(sys.argv[1], sys.argv[2])
    except BaseException as error:
        result = {'state': 'resume_bootstrap_stopped_no_retry',
                  'reason': error.reason if isinstance(error, Stopped) else 'unexpected',
                  'downloadedSourceStored': False}
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))
    return 0 if result.get('state') in ('resume_preflight_ready', 'installed_verified') else 1

if __name__ == '__main__':
    sys.exit(main())

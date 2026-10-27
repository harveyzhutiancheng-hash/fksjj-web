"""Static public-resource verification fixtures; no external HTTP or game build."""
import base64
import hashlib
import json
from pathlib import Path
import ssl
import subprocess
import unittest
from unittest import mock

from deploy import release_orchestrator as o


class Clock:
    def __init__(self):self.value=0.0
    def __call__(self):return self.value


def headers(path):
    return {'content-type':[sorted(o.public_mime(path))[0]],
            'cache-control':['no-cache'],'x-content-type-options':['nosniff']}


class PublicResourceVerificationTests(unittest.TestCase):
    def setUp(self):
        self.files={name:('PUBLIC INERT FIXTURE '+name).encode() for name in o.release.FILES}
        rows=[{'path':name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()} for name,raw in sorted(self.files.items())]
        self.manifest={'version':'0.14.0','createdAt':'2026-10-27T00:00:00Z','fileCount':34,
                       'totalBytes':sum(r['bytes'] for r in rows),'files':rows}
        self.raw=json.dumps(self.manifest,separators=(',',':')).encode()
        self.bind(self.raw)
        self.calls=[];self.clock=Clock()

    def bind(self,raw):
        value=o.client.make_envelope('upload','a'*40,'b'*32,'c'*64,100,hashlib.sha256(raw).hexdigest(),'releases/fixture-old')
        self.metadata=o.client.metadata_for(value)

    def fetch(self,path,limit,timeout):
        self.calls.append((path,limit,timeout))
        if path==o.MISSING_RESOURCE:return 404,headers('/index.html'),b'INERT not found'
        data=self.raw if path=='/release.json' else self.files[path[1:]]
        self.assertEqual(limit,len(data))
        self.assertGreater(timeout,0);self.assertLessEqual(timeout,30)
        return 200,headers(path),data

    def verify(self,**kwargs):
        return o.verify_live(self.metadata,'0.14.0',fetch=lambda path:(200,self.raw),
            verify_files=True,fetch_resource=kwargs.pop('fetch_resource',self.fetch),clock=self.clock,**kwargs)

    def test_all_34_payloads_manifest_headers_and_missing404_are_checked(self):
        result=self.verify()
        self.assertEqual(len(self.calls),36)
        self.assertEqual({path for path,_,_ in self.calls},o.PUBLIC_RESOURCE_PATHS)
        self.assertEqual(result['publicFilesVerified'],34)
        self.assertTrue(result['publicManifestHeadersVerified']);self.assertTrue(result['missingModule404Verified'])

    def test_default_manifest_only_does_not_fetch_resources_or_need_extended_schema(self):
        raw=b'{"version":"0.14.0","inert":"legacy contract"}';self.bind(raw)
        fetch_resource=mock.Mock(side_effect=AssertionError('not requested'))
        result=o.verify_live(self.metadata,'0.14.0',fetch=lambda path:(200,raw),fetch_resource=fetch_resource)
        fetch_resource.assert_not_called();self.assertNotIn('publicFilesVerified',result)

    def test_tamper_redirect_wrong_MIME_cache_or_duplicate_security_header_stops(self):
        for kind in ('body','redirect','mime','cache','duplicate','nosniff'):
            self.calls=[]
            def bad(path,limit,timeout):
                code,h,raw=self.fetch(path,limit,timeout)
                if kind=='body':raw+=b'x'
                elif kind=='redirect':code=302
                elif kind=='mime':h['content-type']=['text/plain']
                elif kind=='cache':h['cache-control']=['public, max-age=3600']
                elif kind=='duplicate':h['x-content-type-options']=['nosniff','nosniff']
                else:h['x-content-type-options']=[]
                return code,h,raw
            with self.subTest(kind=kind),self.assertRaises(o.OrchestrationFailure):self.verify(fetch_resource=bad)
            self.assertEqual(len(self.calls),1)

    def test_missing_probe_must_be404(self):
        def unexpected(path,limit,timeout):
            reply=self.fetch(path,limit,timeout)
            return (200,reply[1],reply[2]) if path==o.MISSING_RESOURCE else reply
        with self.assertRaisesRegex(o.OrchestrationFailure,'missing_module_not_404'):self.verify(fetch_resource=unexpected)
        self.assertEqual(len(self.calls),36)

    def test_manifest_extra_missing_duplicate_and_size_drift_stop_before_resource_GET(self):
        for kind in ('extra','missing','duplicate','size','total','timestamp'):
            value=json.loads(json.dumps(self.manifest))
            if kind=='extra':value['files'][0]['path']='api/app.py'
            elif kind=='missing':value['files'].pop()
            elif kind=='duplicate':value['files'][-1]=value['files'][0]
            elif kind=='size':value['files'][0]['bytes']=True
            elif kind=='timestamp':value['createdAt']='not UTC'
            else:value['totalBytes']+=1
            self.raw=json.dumps(value).encode();self.bind(self.raw);self.calls=[]
            with self.subTest(kind=kind),self.assertRaises(o.OrchestrationFailure):self.verify()
            self.assertEqual(self.calls,[])

    def test_public_deadline_is_shared_and_no_resource_is_retried(self):
        def slow(path,limit,timeout):
            result=self.fetch(path,limit,timeout);self.clock.value+=0.6;return result
        with self.assertRaisesRegex(o.OrchestrationTimeout,'resources_deadline'):self.verify(timeout=1,fetch_resource=slow)
        self.assertEqual(len(self.calls),2);self.assertAlmostEqual(self.calls[1][2],0.4)
        self.assertEqual(len({path for path,_,_ in self.calls}),2)

    def test_initial_manifest_uses_remaining_hard_deadline_not_unbounded_default(self):
        calls=[]
        def exchange(message,timeout):
            calls.append((message,timeout));self.clock.value+=0.2
            if message['kind']=='manifest':return {'httpStatus':200,'body':base64.b64encode(self.raw).decode()}
            path=message['path'];raw=self.raw if path=='/release.json' else self.files[path[1:]]
            return {'httpStatus':200,'headers':headers(path),'body':base64.b64encode(raw).decode()}
        with mock.patch.object(o,'bounded_exchange',side_effect=exchange),self.assertRaises(o.OrchestrationTimeout):
            o.verify_live(self.metadata,'0.14.0',verify_files=True,clock=self.clock,timeout=0.3)
        self.assertEqual(calls[0][0]['kind'],'manifest');self.assertEqual(calls[0][1],0.3)
        self.assertAlmostEqual(calls[1][1],0.1)

    def test_unknown_exchange_is_not_retried_or_reflected(self):
        bad=mock.Mock(side_effect=o.client.UnknownOutcome('INERT UNKNOWN RAW SECRET'))
        with self.assertRaisesRegex(o.OrchestrationUnknown,'resource_exchange_unknown') as ended:self.verify(fetch_resource=bad)
        self.assertNotIn('RAW SECRET',str(ended.exception));bad.assert_called_once()

    def test_new_resource_paths_are_exact_whitelist_and_old_manifest_path_stays_strict(self):
        for path in ('https://evil.invalid/index.html','//elsewhere/index.html','/api/health','/../index.html',
                     '/%69ndex.html','/index.html?x=1','/release.json?fkssj_release='+'b'*32):
            with self.subTest(path=path),mock.patch.object(o.http.client,'HTTPSConnection') as connection:
                with self.assertRaises(o.OrchestrationFailure):o.https_resource(path,100)
                connection.assert_not_called()
        with mock.patch.object(o.http.client,'HTTPSConnection') as connection:
            with self.assertRaises(o.OrchestrationFailure):o.https_manifest('/index.html')
            connection.assert_not_called()
        for limit in (-1,True,o.MAX_PUBLIC_FILE_BYTES+1):
            with self.assertRaises(o.OrchestrationFailure):o.public_resource_input('/index.html',limit)

    def test_resource_transport_uses_verified_TLS_identity_encoding_no_redirect_follow(self):
        connection=mock.Mock();response=connection.getresponse.return_value
        response.status=302;response.read.return_value=b''
        response.getheaders.return_value=[('Content-Type','text/html'),('Cache-Control','no-cache'),('X-Content-Type-Options','nosniff')]
        with mock.patch.object(o.http.client,'HTTPSConnection',return_value=connection) as constructor:
            reply=o.https_resource('/index.html',100)
        self.assertEqual(reply[0],302)
        self.assertEqual(constructor.call_args.args,(o.client.HOST,443))
        context=constructor.call_args.kwargs['context'];self.assertEqual(context.verify_mode,ssl.CERT_REQUIRED);self.assertTrue(context.check_hostname)
        self.assertEqual(connection.request.call_args.args,('GET','/index.html'))
        self.assertEqual(connection.request.call_args.kwargs['headers']['Accept-Encoding'],'identity')
        response.read.assert_called_once_with(101)
        connection.request.assert_called_once();connection.close.assert_called_once()

    def test_CLI_files_flag_is_explicit_and_passed_to_orchestrator(self):
        with mock.patch.object(o.client,'read_regular',return_value=json.dumps(self.metadata).encode()), \
             mock.patch.object(o.client,'environment_key',return_value=b'0'*32), \
             mock.patch.object(o,'orchestrate',return_value={'status':'verified'}) as operation, \
             mock.patch('builtins.print'):
            status=o.main(['activate','--metadata','INERT-FIXTURE.json','--expected-version','0.14.0','--verify-files'])
        self.assertEqual(status,0);self.assertIs(operation.call_args.kwargs['verify_files'],True)

    def test_child_resource_limit_can_exceed_legacy_status_limit_but_is_still_bounded(self):
        raw=b'x'*(600*1024)
        body={'httpStatus':200,'headers':headers('/index.html'),'body':base64.b64encode(raw).decode()}
        result=subprocess.CompletedProcess([],0,json.dumps(body).encode())
        with mock.patch.object(o.subprocess,'run',return_value=result) as run:
            code,h,data=o.bounded_resource('/index.html',len(raw),timeout=2.5)
        self.assertEqual(data,raw);self.assertEqual(code,200)
        self.assertEqual(run.call_args.kwargs['timeout'],2.5)
        self.assertEqual(json.loads(run.call_args.kwargs['input']),{'kind':'resource','path':'/index.html','limit':len(raw)})
        oversized={**body,'body':base64.b64encode(raw+b'x').decode()}
        with mock.patch.object(o,'bounded_exchange',return_value=oversized),self.assertRaises(o.OrchestrationFailure):
            o.bounded_resource('/index.html',len(raw),timeout=2)
        with mock.patch.object(o.subprocess,'run') as run,self.assertRaises(o.OrchestrationFailure):
            o.bounded_exchange({'kind':'resource','path':'/api/health','limit':1},1)
        run.assert_not_called()

if __name__=='__main__':unittest.main()

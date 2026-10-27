import hashlib
import importlib.util
from pathlib import Path
import unittest

from deploy import manual_api_nginx as subject
from deploy import test_nginx_status_only as fixtures
from deploy import nginx_log_audit_routing as routing
from deploy import test_nginx_log_audit_routing as routing_fixtures


def legacy():
    path=Path(__file__).with_name('nginx_status_only.py')
    spec=importlib.util.spec_from_file_location('_manual_nginx_fixture',path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    return m


class NginxTests(unittest.TestCase):
    def setUp(self):
        self.fx=fixtures.NginxStatusOnlyTests(methodName='runTest');self.fx.setUp();self.addCleanup(self.fx.doCleanups)
        self.old=legacy();self.fx.target.write_bytes(self.old.CANDIDATE)
        self.audit_ok=True
        def audit(sha):
            return dict(status='safe' if self.audit_ok else 'unknown',reasons=[] if self.audit_ok else ['fixture_unknown'],targetSha256=sha,
                summaries=[dict(diskAuditComplete=True,snapshotStable=True,isolationVerified=True,structureVerified=True,loggingAnalysisComplete=True,defaultPhaseLogsChecked=True)])
        self.engine=subject.Engine(self.old,routing,self.fx.host,audit)

    def test_plan_no_writes_and_apply_only_api_preserves_status(self):
        before=self.fx.snapshot();self.assertEqual(self.engine.plan()['state'],'preflight_ok_await_authorization');self.assertEqual(self.fx.snapshot(),before)
        result=self.engine.apply();self.assertEqual(result['state'],'applied_reload_acknowledged',result)
        actual=self.fx.target.read_bytes();self.assertEqual(actual,self.engine.candidate)
        self.assertEqual(actual.replace(subject.LOCATION,b'',1),self.engine.baseline)
        self.assertIn(b'proxy_pass http://127.0.0.1:8787;',actual)
        self.assertNotIn(b'/v1/upload;',actual);self.assertNotIn(b'/v1/activate;',actual)
        # API and preview already send these fields. Hide upstream values,
        # then provide exactly one authoritative value for the HTTPS response.
        for header in (b'Cache-Control',b'X-Content-Type-Options',b'Referrer-Policy'):
            self.assertEqual(subject.LOCATION.count(b'proxy_hide_header '+header+b';'),1)
            self.assertEqual(subject.LOCATION.count(b'add_header '+header+b' '),1)
        self.assertEqual(self.fx.host.commands.count('reload'),1)

    def test_unknown_audit_no_writes(self):
        self.audit_ok=False;before=self.fx.snapshot()
        self.assertEqual(self.engine.apply()['state'],'stopped_no_changes')
        self.assertEqual(self.fx.snapshot(),before)

    def test_candidate_audit_failure_restores_exact_owned_original_without_reload(self):
        self.engine.audit=lambda sha: dict(status='unknown',reasons=['fixture']) if sha==self.engine.sha else dict(status='safe',reasons=[],targetSha256=sha,summaries=[dict(diskAuditComplete=True,snapshotStable=True,isolationVerified=True,structureVerified=True,loggingAnalysisComplete=True,defaultPhaseLogsChecked=True)])
        result=self.engine.apply();self.assertEqual(result['state'],'stopped_original_restored',result)
        self.assertEqual(self.fx.target.read_bytes(),self.engine.baseline)
        self.assertNotIn('reload',self.fx.host.commands)

    def test_unknown_reload_is_not_called_a_second_time_as_new_apply(self):
        self.fx.host.outcomes['reload']=[fixtures.receipt(None,'unknown')]
        result=self.engine.apply();self.assertEqual(result['state'],'uncertain',result)
        self.assertEqual(self.fx.target.read_bytes(),self.engine.baseline)
        with self.assertRaises(Exception):self.engine.apply()

    def test_real_bounded_routing_accepts_fixed_candidate(self):
        fx=routing_fixtures.RoutingAuditTests(methodName='runTest');fx.setUp()
        try:
            fx.fx.path('/etc/nginx/conf.d/fkssj-domain.conf').write_bytes(self.engine.candidate)
            core=routing._modules();core[-1].TARGET_SHA256=self.engine.sha
            report=routing.audit(root=fx.fx.root,metadata=fx.fx.metadata,_core=core)
            self.assertTrue(subject.safe(report,self.engine.sha),report)
            self.assertNotIn(b'access_log',subject.LOCATION);self.assertNotIn(b'error_log',subject.LOCATION)
        finally:fx.doCleanups()


if __name__=='__main__':unittest.main()

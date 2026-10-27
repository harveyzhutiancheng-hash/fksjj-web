"""Orchestration fixtures only; no real server, secrets, services or accounts."""
import datetime as dt
import hashlib
import json
from pathlib import Path
import types
import unittest
from unittest import mock

from api.preview import FILES
from deploy import manual_release_driver as driver
from deploy import manual_api_acceptance as acceptance

CHECKS = frozenset('basic_ui two_tabs independent_context guest_migration identity_freeze conflict_choices late_response storage_failure'.split())
INJECTIONS = ['guest_migration','identity_freeze','conflict_choices','late_response','storage_failure']
PRIVATE_BAIT = 'FIXTURE_PASSWORD_SESSION_NEVER_EXPORT'
OLD = 'releases/fkssj-0.13.0-20261020T071030Z'


def encode(value):
    return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()


class MemoryHost:
    def __init__(self, fx):
        self.fx,self.records,self.events=fx,{},[]
        self.fail_api=False;self.fail_acceptance=False;self.fail_health=False
        self.fail_path=None;self.attempts=0;self.target=OLD

    def exists(self,path):return str(path) in self.records
    def read_private(self,path):return self.records[str(path)]
    def write_new(self,path,data,mode=0o600):
        key=str(path)
        if key in self.records:raise FileExistsError(PRIVATE_BAIT)
        self.events.append(('write',key))
        self.records[key]=bytes(data)
    def install_source(self,files):
        self.events.append(('source',len(files)))
        self.source=dict(files)
    def verify_api(self,bindings):
        self.events.append(('verify_api',))
        if self.fail_api:raise RuntimeError(PRIVATE_BAIT)
    def run_acceptance(self,bindings):
        self.events.append(('acceptance',))
        self.attempts+=1
        self.fx.case.assertTrue(self.exists(driver.ATTEMPT), 'durable guard must precede even the first account attempt')
        if self.fail_acceptance:raise RuntimeError(PRIVATE_BAIT)
        return {'receipt':b'{"receipt":"only-fixture-no-credentials"}',
                'summary':{'state':'passed_fixture','browserChecks':'not_performed','createdAccounts':2}}
    def health(self):
        self.events.append(('health',))
        if self.fail_health:raise RuntimeError(PRIVATE_BAIT)
        return True
    def current(self):return self.target
    def now(self):return dt.datetime(2026,10,26,2,0,tzinfo=dt.timezone.utc)
    def public_get(self,path,limit):
        self.events.append(('public_get',path))
        name=path.lstrip('/')
        if name not in self.fx.files:return 404,{'content-type':'application/javascript'},b''
        value=self.fx.files[name]
        if self.fail_path==path:value+=b'TAMPER'
        kind=('application/json' if name=='release.json' else 'text/html' if name.endswith('.html')
              else 'application/javascript' if name.endswith('.js') else 'text/css' if name.endswith('.css')
              else 'image/svg+xml' if name.endswith('.svg') else 'application/octet-stream')
        return 200,{'content-type':kind,'cache-control':'no-cache','x-content-type-options':'nosniff'},value


class Fixture:
    def __init__(self,case):
        self.case=case
        self.files={name:('fixture:'+name).encode() for name in FILES}
        rows=[{'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()} for name,data in sorted(self.files.items())]
        self.files['release.json']=encode({'version':'0.14.0','createdAt':'2026-10-26T01:00:00Z',
            'fileCount':len(rows),'totalBytes':sum(r['bytes'] for r in rows),'files':rows})
        manifest=hashlib.sha256(self.files['release.json']).hexdigest()
        static={'releaseId':'fixture-v014','manifestSha256':manifest,'sourceSha256':'b'*64,
                'apiAppSha256':'c'*64,'apiInitSha256':'d'*64,'legacyFiles':[]}
        unit=b'FIXTURE API UNIT'
        api_install={'apiVersionId':'fkssj-api-fixture','previewManifestSha256':manifest,
            'files':{'api/app.py':{'sha256':'c'*64,'bytes':1},
                     'api/__init__.py':{'sha256':'d'*64,'bytes':1},
                     'api/preview.py':{'sha256':'e'*64,'bytes':1}}}
        api_acceptance={'manifestSha256':manifest,'apiAppSha256':'c'*64,'apiInitSha256':'d'*64,
            'apiPreviewSha256':'e'*64,'backendTarget':'api-releases/fkssj-api-fixture',
            'apiUnitSha256':hashlib.sha256(unit).hexdigest(),'nginxConfigSha256':'f'*64}
        self.bindings={'apiInstall':api_install,'apiAcceptance':api_acceptance,'static':static}
        self.host=MemoryHost(self)
        self.api=types.SimpleNamespace(manifest_sha256='a'*64,bindings=self.bindings['apiInstall'],unit_bytes=unit,install=self.install)
        self.nginx=types.SimpleNamespace(apply=self.nginx_apply,plan=self.nginx_plan,sha='f'*64)
        self.static=types.SimpleNamespace(b=static,new='releases/fixture-v014',binding_sha='f'*64,
            s=types.SimpleNamespace(FILES=FILES,strict_json=json.loads,ORIGIN='https://fkssj.harvey-ai.xyz'),
            private=lambda name:Path('/var/backups/fkssj-manual-v014')/name,
            stage=self.stage,browser=self.browser,activate=self.activate,rollback=self.rollback)
        self.api_result='api_installed_started_not_publicly_accepted'
        self.nginx_result='applied_reload_acknowledged';self.stage_result='staged_verified'
        self.nginx_plan_result='preflight_ok_await_authorization'
        self.activate_result='activated_verified';self.rollback_result='rolled_back_verified'
        self.subject=driver.Driver(self.api,self.nginx,self.static,types.SimpleNamespace(),self.bindings,self.files,self.host)

    def install(self,pin):
        self.case.assertEqual(pin,self.api.manifest_sha256)
        self.host.events.append(('api_install',))
        return {'state':self.api_result}
    def stage(self):
        self.host.events.append(('stage',));return {'state':self.stage_result}
    def nginx_apply(self):
        self.host.events.append(('nginx',));return {'state':self.nginx_result}
    def nginx_plan(self):
        self.host.events.append(('nginx_plan',));return {'state':self.nginx_plan_result}
    def browser(self,pin):
        raw=self.host.read_private(self.static.private('browser-acceptance.json'))
        self.case.assertEqual(hashlib.sha256(raw).hexdigest(),pin)
        record=json.loads(raw)
        if set(record.get('checks',{}))!=CHECKS or not all(v is True for v in record['checks'].values()):
            raise RuntimeError(PRIVATE_BAIT)
        self.host.events.append(('browser',));return record
    def activate(self,receipt,browser):
        self.host.events.append(('activate',))
        self.case.assertEqual(hashlib.sha256(self.host.read_private(driver.RECEIPT)).hexdigest(),receipt)
        if self.activate_result=='activated_verified':self.host.target=self.static.new
        return {'state':self.activate_result}
    def rollback(self):
        self.host.events.append(('rollback',));self.host.target=OLD
        return {'state':self.rollback_result}
    def browser_input(self):return {'manifestSha256':self.static.b['manifestSha256'],'checks':{name:True for name in CHECKS},'injections':list(INJECTIONS)}
    def ready(self):
        self.case.assertEqual(self.subject.install()['state'],'preview_ready_not_activated')
        self.case.assertEqual(self.subject.browser_record(self.browser_input())['state'],'browser_recorded_operator_attestation')


class DriverTests(unittest.TestCase):
    def setUp(self):self.fx=Fixture(self)
    def no_secrets(self,result):self.assertNotIn(PRIVATE_BAIT,json.dumps(result))

    def test_install_order_and_current_stays_old(self):
        result=self.fx.subject.install()
        self.assertEqual(result['state'],'preview_ready_not_activated',result)
        names=[row[0] for row in self.fx.host.events]
        self.assertLess(names.index('nginx_plan'),names.index('api_install'))
        self.assertLess(names.index('api_install'),names.index('source'))
        self.assertLess(names.index('source'),names.index('stage'))
        self.assertLess(names.index('stage'),names.index('nginx'))
        self.assertEqual(self.fx.host.target,OLD)
        self.assertEqual(self.fx.host.attempts,0)

    def test_api_failure_does_not_install_static_or_nginx(self):
        self.fx.nginx_plan_result='stopped_no_changes'
        result=self.fx.subject.install();self.no_secrets(result)
        self.assertNotIn(('api_install',),self.fx.host.events)
        self.fx.nginx_plan_result='preflight_ok_await_authorization'
        self.fx.api_result='partial_inspect'
        result=self.fx.subject.install();self.no_secrets(result)
        self.assertNotEqual(result['state'],'preview_ready_not_activated')
        self.assertNotIn(('nginx',),self.fx.host.events);self.assertNotIn(('stage',),self.fx.host.events)

    def test_unknown_nginx_never_activates(self):
        self.fx.nginx_result='uncertain'
        result=self.fx.subject.install();self.no_secrets(result)
        self.assertNotEqual(result['state'],'preview_ready_not_activated')
        self.assertNotIn(('activate',),self.fx.host.events)

    def test_browser_input_all_true_is_explicit_and_injections_retained(self):
        self.fx.subject.install()
        incomplete=self.fx.browser_input();incomplete['checks']['independent_context']=False
        self.assertNotEqual(self.fx.subject.browser_record(incomplete)['state'],'browser_recorded_operator_attestation')
        self.assertFalse(self.fx.host.exists(self.fx.static.private('browser-acceptance.json')))
        missing=self.fx.browser_input();missing['injections']=[]
        self.assertNotEqual(self.fx.subject.browser_record(missing)['state'],'browser_recorded_operator_attestation')
        result=self.fx.subject.browser_record(self.fx.browser_input())
        self.assertEqual(result['state'],'browser_recorded_operator_attestation',result)
        self.assertTrue(self.fx.host.exists(self.fx.static.private('browser-injections.json')))
        self.assertEqual(self.fx.host.attempts,0)

    def test_no_browser_means_no_accounts_or_attempt_marker(self):
        self.fx.subject.install();result=self.fx.subject.accept_activate();self.no_secrets(result)
        self.assertEqual(self.fx.host.attempts,0)
        self.assertFalse(self.fx.host.exists(driver.ATTEMPT))

    def test_attempt_durable_before_accounts_and_only_one_acceptance_run(self):
        self.fx.ready();result=self.fx.subject.accept_activate()
        self.assertEqual(result['state'],'activated_needs_public_verify',result)
        self.assertEqual(self.fx.host.attempts,1)
        self.assertTrue(self.fx.host.exists('/opt/fkssj-api/preview.closed'))
        result=self.fx.subject.accept_activate();self.no_secrets(result)
        self.assertEqual(self.fx.host.attempts,1)

    def test_acceptance_unknown_permanently_blocks_second_account_attempt(self):
        self.fx.ready();self.fx.host.fail_acceptance=True
        result=self.fx.subject.accept_activate();self.no_secrets(result)
        self.assertNotEqual(result['state'],'activated_needs_public_verify')
        self.assertEqual(self.fx.host.attempts,1);self.assertTrue(self.fx.host.exists(driver.ATTEMPT))
        self.fx.host.fail_acceptance=False
        self.fx.subject.accept_activate();self.assertEqual(self.fx.host.attempts,1)
        self.assertNotIn(('activate',),self.fx.host.events)

    def test_api_precheck_failure_does_not_consume_account_budget(self):
        self.fx.ready();self.fx.host.fail_api=True
        result=self.fx.subject.accept_activate();self.no_secrets(result)
        self.assertEqual(self.fx.host.attempts,0)
        self.assertFalse(self.fx.host.exists(driver.ATTEMPT))

    def test_activation_unknown_does_not_auto_retry_or_auto_rollback(self):
        self.fx.ready();self.fx.activate_result='uncertain_after_activation_attempt'
        result=self.fx.subject.accept_activate();self.no_secrets(result)
        self.assertNotEqual(result['state'],'activated_needs_public_verify')
        self.assertEqual([row[0] for row in self.fx.host.events].count('activate'),1)
        self.assertNotIn(('rollback',),self.fx.host.events)
        self.assertFalse(self.fx.host.exists('/opt/fkssj-api/preview.closed'))

    def test_verify_is_readonly_and_creates_no_accounts(self):
        self.fx.ready();self.fx.subject.accept_activate()
        before=dict(self.fx.host.records);count=self.fx.host.attempts
        result=self.fx.subject.verify()
        self.assertEqual(result['state'],'public_version_and_api_verified',result)
        self.assertEqual(self.fx.host.records,before);self.assertEqual(self.fx.host.attempts,count)
        self.assertEqual(sum(row[0]=='public_get' for row in self.fx.host.events),len(self.fx.files)+1)

    def test_public_tamper_or_health_failure_is_not_success(self):
        self.fx.ready();self.fx.subject.accept_activate();self.fx.host.fail_path='/app.js'
        result=self.fx.subject.verify();self.no_secrets(result)
        self.assertNotEqual(result['state'],'public_version_and_api_verified')

    def test_rollback_only_delegates_static_and_does_not_reopen_preview(self):
        self.fx.ready();self.fx.subject.accept_activate()
        before=dict(self.fx.host.records);self.fx.host.events.clear();count=self.fx.host.attempts
        result=self.fx.subject.rollback()
        self.assertEqual(result['state'],'rolled_back_verified',result)
        self.assertEqual(self.fx.host.records,before);self.assertEqual(self.fx.host.attempts,count)
        self.assertEqual(self.fx.host.events,[('rollback',)])

    def test_stale_preview_or_nonboolean_checks_or_extra_static_path_are_rejected(self):
        self.fx.subject.install()
        for kind in ('manifest','boolean'):
            value=self.fx.browser_input()
            if kind=='manifest':value['manifestSha256']='0'*64
            else:value['checks']['basic_ui']=1
            result=self.fx.subject.browser_record(value)
            self.assertNotEqual(result['state'],'browser_recorded_operator_attestation')
            self.assertFalse(self.fx.host.exists(self.fx.static.private('browser-acceptance.json')))
        with self.assertRaises(driver.Failure):
            driver.Driver(self.fx.api,self.fx.nginx,self.fx.static,types.SimpleNamespace(),
                          self.fx.bindings,self.fx.files|{'../escape':b'never write'},self.fx.host)
        bindings=json.loads(json.dumps(self.fx.bindings));bindings['apiAcceptance']['manifestSha256']='0'*64
        with self.assertRaises(driver.Failure):
            driver.Driver(self.fx.api,self.fx.nginx,self.fx.static,types.SimpleNamespace(),
                          bindings,self.fx.files,self.fx.host)
        self.assertEqual(self.fx.host.attempts,0)

    def test_tampered_durable_bindings_block_mutating_followups(self):
        self.fx.ready();self.fx.host.records[driver.MAP]=b'{"changed":"fixture"}'
        self.fx.host.events.clear()
        for call in (lambda:self.fx.subject.browser_record(self.fx.browser_input()),
                     self.fx.subject.accept_activate,self.fx.subject.rollback):
            self.no_secrets(call())
        self.assertEqual(self.fx.host.events,[])
        self.assertEqual(self.fx.host.attempts,0)

    def test_production_exists_handles_missing_first_install_parent_only(self):
        api=types.SimpleNamespace(h=types.SimpleNamespace(metadata=mock.Mock(side_effect=FileNotFoundError('missing parent'))))
        acceptance=types.SimpleNamespace(Host=lambda:None,HTTPSTransport=lambda:None)
        host=driver.Host(api,types.SimpleNamespace(),acceptance)
        self.assertFalse(host.exists(driver.MAP))
        api.h.metadata.side_effect=PermissionError('do not hide unsafe parent')
        with self.assertRaises(PermissionError):host.exists(driver.MAP)

    def test_install_platform_failure_retains_only_fixed_diagnostics(self):
        self.fx.api.install=lambda pin:{'state':'stopped_no_changes','reason':'platform_unknown',
            'startAttempted':False,'stderr':PRIVATE_BAIT,'command':PRIVATE_BAIT}
        result=self.fx.subject.install()
        self.assertEqual(result['phase'],'api_install')
        self.assertEqual(result['componentState'],'stopped_no_changes')
        self.assertEqual(result['componentReason'],'platform_unknown')
        self.assertIs(result['startAttempted'],False);self.no_secrets(result)
        self.assertFalse(any(row[0]=='source' for row in self.fx.host.events))
        self.assertEqual(driver.Driver.component_info({'state':PRIVATE_BAIT,'reason':PRIVATE_BAIT}),{})

    def test_http_failure_keeps_safe_summary_and_never_retries_accounts(self):
        self.fx.ready();self.fx.subject.a=acceptance
        def fail(bindings):
            self.fx.host.attempts+=1
            self.assertTrue(self.fx.host.exists(driver.ATTEMPT))
            error=acceptance.AcceptanceError('https_request_failed');error.args=(PRIVATE_BAIT,)
            error.summary={'accountCreationRequests':2,'accountsConfirmed':1,'restartAttempted':False,
                'requestOutcomeMayBeUncertain':True,'password':PRIVATE_BAIT,'phase':PRIVATE_BAIT}
            raise error
        self.fx.host.run_acceptance=fail
        result=self.fx.subject.accept_activate();self.no_secrets(result)
        self.assertEqual(result['reason'],'https_request_failed')
        self.assertEqual(result['phase'],'api_acceptance')
        self.assertEqual(result['accountSummary'],{'accountCreationRequests':2,'accountsConfirmed':1,
            'restartAttempted':False,'requestOutcomeMayBeUncertain':True})
        self.assertTrue(result['automaticAccountCreationMayHaveOccurred'])
        self.assertTrue(result['failureSummaryPersisted'])
        saved=self.fx.host.read_private(driver.SUMMARY);self.assertNotIn(PRIVATE_BAIT.encode(),saved)
        self.fx.subject.accept_activate();self.assertEqual(self.fx.host.attempts,1)
        self.assertEqual(self.fx.host.read_private(driver.SUMMARY),saved)

    def test_failure_summary_write_error_does_not_replace_original_error_or_leak(self):
        self.fx.ready();self.fx.subject.a=acceptance
        def fail(bindings):
            self.fx.host.attempts+=1
            error=acceptance.AcceptanceError('restart_not_confirmed');error.args=(PRIVATE_BAIT,)
            error.summary={'accountCreationRequests':2,'accountsConfirmed':2,
                'restartAttempted':True,'requestOutcomeMayBeUncertain':False}
            raise error
        self.fx.host.run_acceptance=fail
        write=self.fx.host.write_new
        def fail_summary(path,data,mode=0o600):
            if str(path)==driver.SUMMARY:raise PermissionError(PRIVATE_BAIT)
            return write(path,data,mode)
        self.fx.host.write_new=fail_summary
        result=self.fx.subject.accept_activate();self.no_secrets(result)
        self.assertEqual(result['reason'],'restart_not_confirmed')
        self.assertFalse(result['failureSummaryPersisted'])
        self.assertTrue(self.fx.host.exists(driver.ATTEMPT))
        self.fx.subject.accept_activate();self.assertEqual(self.fx.host.attempts,1)


if __name__=='__main__':unittest.main()

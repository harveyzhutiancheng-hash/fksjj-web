"""Fixed manual-release choreography; no default browser pass or QA replay.

Only a separately pinned, fully verified in-memory bundle constructs Driver.
No CLI path, secret, arbitrary endpoint, shell or automatic retry is exposed.
"""
import datetime as dt
import hashlib
import json
from pathlib import Path
import ssl
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPSHandler, HTTPRedirectHandler

ORIGIN = 'https://fkssj.harvey-ai.xyz'
MAP = '/var/backups/fkssj-api/manual-bindings.json'
ATTEMPT = '/var/backups/fkssj-api/acceptance-attempt.json'
SUMMARY = '/var/backups/fkssj-api/acceptance-summary.json'
RECEIPT = '/etc/fkssj-release/api-acceptance.json'
CLOSED = '/opt/fkssj-api/preview.closed'
SOURCE = '/opt/fkssj-api/manual-static'
MISSING = '/__fkssj_missing_module_probe__.js'
CHECKS = frozenset('basic_ui two_tabs independent_context guest_migration identity_freeze conflict_choices late_response storage_failure'.split())
INJECTIONS = frozenset('guest_migration identity_freeze conflict_choices late_response storage_failure'.split())
CODES = frozenset('''binding_mismatch source_invalid existing_attempt install_unconfirmed
stage_unconfirmed route_unconfirmed browser_incomplete browser_record_invalid
api_health_failed activation_unconfirmed public_verification_failed
component_failed_or_interrupted'''.split())
COMPONENT_STATES = frozenset('''preflight_ok_await_authorization stopped_no_changes
partial_retained_inspect_no_retry api_installed_started_not_publicly_accepted
staged_verified partial_or_uncertain_inspect applied_reload_acknowledged
stopped_original_retained stopped_original_restored uncertain'''.split())
COMPONENT_REASONS = frozenset('''payload_invalid approval_mismatch root_required unsafe_parent
unsafe_file changed_file existing_target account_conflict platform_unknown
unit_conflict port_occupied insufficient_space command_failed command_unknown
account_create_unconfirmed unit_not_ready current_changed unexpected_failure
bindings_unknown unsafe_directory file_changed wrong_current legacy_manifest_unknown
legacy_tree_changed existing_attempt lock_metadata lock_busy source_mismatch
browser_gate_missing browser_gate_invalid api_receipt_invalid static_stage_failed
static_activate_failed static_rollback_failed staged_record_missing activated_record_missing
pending_unknown nginx_disk_log_audit_not_safe baseline_nginx_test_failed
candidate_nginx_test_failed reload_not_confirmed original_restored_validation_not_confirmed
original_restored_reload_outcome_requires_review target_not_owned_candidate_no_restore
recovery_incomplete_retain_all_files interrupted_or_io_failure'''.split())


class Failure(Exception):
    def __init__(self, code):
        super().__init__(code if code in CODES else 'component_failed_or_interrupted')


def need(value, code):
    if not value:
        raise Failure(code)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)+'\n').encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):return None


class Host:
    def __init__(self, api_engine, static_engine, acceptance_module):
        self.api, self.static, self.a = api_engine, static_engine, acceptance_module
        self.acceptance_host, self.transport = acceptance_module.Host(), acceptance_module.HTTPSTransport()

    def exists(self, path):
        try:return self.api.h.metadata(str(path)) is not None
        except FileNotFoundError:return False
    def read_private(self, path):return self.static.h.read_private(Path(path))
    def write_new(self, path, data, mode=0o600):return self.api.file(str(path), data, mode=mode)
    def now(self):return dt.datetime.now(dt.timezone.utc)
    def current(self):
        with self.static.h.directory(self.static.h.root) as fd:
            return self.static.s.current(fd)

    def install_source(self, files):
        self.api.mkdir(SOURCE)
        made = {''}
        for name, data in sorted(files.items()):
            path = Path(name)
            parts = path.parts[:-1]
            for end in range(1,len(parts)+1):
                directory='/'.join(parts[:end])
                if directory not in made:
                    self.api.mkdir(SOURCE+'/'+directory);made.add(directory)
            self.write_new(SOURCE+'/'+name,data,mode=0o644)

    def verify_api(self, bindings):return self.acceptance_host.verify(bindings)
    def run_acceptance(self, bindings):
        return self.a.run_acceptance(self.transport,self.acceptance_host,bindings)

    def health(self):
        reply=self.transport.request('GET','/api/health',self.a.Session())
        need(reply.status==200 and reply.data=={'ok':True}
             and reply.values('Cache-Control')==['no-store']
             and reply.values('X-Content-Type-Options')==['nosniff'],'api_health_failed')

    def public_get(self, path, limit):
        allowed={'/'+name for name in self.static.s.FILES}|{'/release.json',MISSING}
        need(path in allowed and 0 < limit <= 32*1024*1024+1,'public_verification_failed')
        opener=build_opener(NoRedirect(),HTTPSHandler(context=ssl.create_default_context()))
        try:
            try:reply=opener.open(Request(ORIGIN+path,method='GET'),timeout=10)
            except HTTPError as error:reply=error
            with reply:
                body=reply.read(limit+1)
                need(len(body)<=limit,'public_verification_failed')
                return reply.status,dict(reply.headers.items()),body
        except Failure:raise
        except BaseException:raise Failure('public_verification_failed') from None


class Driver:
    def __init__(self, api_engine, nginx_engine, static_engine, acceptance_module,
                 bindings, static_files, host=None):
        need(isinstance(bindings,dict) and set(bindings)=={'apiInstall','apiAcceptance','static'},'binding_mismatch')
        need(bindings['apiInstall']==api_engine.bindings and bindings['static']==static_engine.b,'binding_mismatch')
        self.api,self.nginx,self.static,self.a=api_engine,nginx_engine,static_engine,acceptance_module
        self.b=json.loads(json.dumps(bindings));self.files=dict(static_files)
        self.host=host or Host(api_engine,static_engine,acceptance_module)
        self.binding_sha=sha(canonical(self.b))
        self.browser_path=str(static_engine.private('browser-acceptance.json'))
        self.injections_path=str(static_engine.private('browser-injections.json'))
        a,s,i=self.b['apiAcceptance'],self.b['static'],self.b['apiInstall']
        need(all(a[key]==s[key] for key in ('manifestSha256','apiAppSha256','apiInitSha256'))
             and a['nginxConfigSha256']==nginx_engine.sha and a['apiUnitSha256']==sha(api_engine.unit_bytes)
             and a['backendTarget']=='api-releases/'+i['apiVersionId']
             and i['previewManifestSha256']==s['manifestSha256']
             and all(i['files'][name]['sha256']==a[key] for name,key in (
                 ('api/app.py','apiAppSha256'),('api/__init__.py','apiInitSha256'),('api/preview.py','apiPreviewSha256'))),
             'binding_mismatch')
        self.validate_source()

    def validate_source(self):
        need(set(self.files)==set(self.static.s.FILES)|{'release.json'}
             and all(isinstance(data,bytes) for data in self.files.values()),'source_invalid')
        need(sha(self.files['release.json'])==self.b['static']['manifestSha256'],'source_invalid')
        value=self.static.s.strict_json(self.files['release.json'])
        rows=value.get('files',[])
        need(value.get('version')=='0.14.0' and value.get('fileCount')==len(self.static.s.FILES)
             and len(rows)==len(self.static.s.FILES) and {r['path'] for r in rows}==set(self.static.s.FILES),'source_invalid')
        for row in rows:
            need(set(row)=={'path','bytes','sha256'} and type(row['bytes']) is int
                 and len(self.files[row['path']])==row['bytes'] and sha(self.files[row['path']])==row['sha256'],'source_invalid')
        need(sum(row['bytes'] for row in rows)==value.get('totalBytes'),'source_invalid')

    def saved(self):
        raw=self.host.read_private(MAP)
        need(raw==canonical({'bindingSha256':self.binding_sha,'bindings':self.b}),'binding_mismatch')

    @staticmethod
    def error(error, state):
        return {'state':state,'reason':str(error) if isinstance(error,Failure) else 'component_failed_or_interrupted'}

    @staticmethod
    def component_info(reply):
        if not isinstance(reply,dict):return {}
        result={}
        if type(reply.get('state')) is str and reply['state'] in COMPONENT_STATES:result['componentState']=reply['state']
        if type(reply.get('reason')) is str and reply['reason'] in COMPONENT_REASONS:result['componentReason']=reply['reason']
        for key in ('daemonReloadAttempted','enableAttempted','startAttempted','publicApiVerified'):
            if type(reply.get(key)) is bool:result[key]=reply[key]
        return result

    @staticmethod
    def account_summary(value):
        if not isinstance(value,dict):return {}
        result={}
        for key in ('accountCreationRequests','accountsConfirmed'):
            if type(value.get(key)) is int and 0 <= value[key] <= 10000:result[key]=value[key]
        for key in ('restartAttempted','requestOutcomeMayBeUncertain'):
            if type(value.get(key)) is bool:result[key]=value[key]
        return result

    def install(self):
        phase,component='preflight',{}
        try:
            need(not self.host.exists(MAP) and not self.host.exists(ATTEMPT)
                 and not self.host.exists(RECEIPT),'existing_attempt')
            phase='nginx_preflight';component=self.nginx.plan()
            need(component.get('state')=='preflight_ok_await_authorization','route_unconfirmed')
            phase='api_install';component={}
            reply=self.api.install(self.api.manifest_sha256)
            component=reply
            need(reply.get('state')=='api_installed_started_not_publicly_accepted','install_unconfirmed')
            phase='save_bindings';component={}
            self.host.write_new(MAP,canonical({'bindingSha256':self.binding_sha,'bindings':self.b}))
            phase='static_source'
            self.host.install_source(self.files)
            phase='static_stage';component=self.static.stage()
            need(component.get('state')=='staged_verified','stage_unconfirmed')
            phase='nginx_apply';component=self.nginx.apply()
            need(component.get('state')=='applied_reload_acknowledged','route_unconfirmed')
            phase='api_verify';component={}
            self.host.verify_api(self.b['apiAcceptance'])
            return {'state':'preview_ready_not_activated','currentChangedByDriver':False,
                    'previewUrl':ORIGIN+'/api/preview/'+self.b['static']['manifestSha256']+'/',
                    'checksUrl':ORIGIN+'/api/preview/'+self.b['static']['manifestSha256']+'/__checks.html',
                    'automaticAccountsCreated':0,'bindingSha256':self.binding_sha}
        except BaseException as error:
            return dict(self.error(error,'stopped_or_partial_install_inspect_no_retry'),phase=phase,
                        **self.component_info(component))

    def browser_record(self, results):
        try:
            self.saved()
            need(not self.host.exists(ATTEMPT) and not self.host.exists(self.browser_path)
                 and not self.host.exists(self.injections_path)
                 and not self.host.exists(str(self.static.private('manual-qa-waiver.json'))),'existing_attempt')
            need(isinstance(results,dict) and set(results)=={'manifestSha256','checks','injections'}
                 and results['manifestSha256']==self.b['static']['manifestSha256']
                 and isinstance(results['checks'],dict) and set(results['checks'])==CHECKS
                 and all(value is True for value in results['checks'].values())
                 and isinstance(results['injections'],list) and len(results['injections'])==len(INJECTIONS)
                 and set(results['injections'])==INJECTIONS,'browser_incomplete')
            need(self.host.current()=='releases/fkssj-0.13.0-20261020T071030Z','browser_record_invalid')
            record={'schema':1,'type':'fkssj-browser-acceptance',
                    'basis':'operator_attestation_after_real_browser_checks','origin':ORIGIN,
                    'manifestSha256':self.b['static']['manifestSha256'],
                    'sourceSha256':self.b['static']['sourceSha256'],
                    'checkedAt':self.host.now().astimezone(dt.timezone.utc).isoformat().replace('+00:00','Z'),
                    'checks':results['checks']}
            self.host.write_new(self.injections_path,canonical({'bindingSha256':self.binding_sha,'input':results,'injections':sorted(INJECTIONS),
                'classification':'five fault injections; three operator checks; not proof of real offline/quota/independent-account-restore'}))
            data=canonical(record);self.host.write_new(self.browser_path,data)
            self.static.browser(sha(data))
            return {'state':'browser_recorded_operator_attestation','browserSha256':sha(data),
                    'faultInjectionChecks':sorted(INJECTIONS),'actualIndependentAccountRestoreProven':False}
        except BaseException as error:return self.error(error,'browser_not_recorded_or_partial_inspect')

    def record_qa_waiver(self):
        """Only this fixed candidate's explicit user decision; never browser success."""
        try:
            self.saved()
            path=str(self.static.private('manual-qa-waiver.json'))
            need(not any(self.host.exists(name) for name in
                 (path,self.browser_path,self.injections_path,ATTEMPT,RECEIPT,SUMMARY,CLOSED)), 'existing_attempt')
            need(self.host.current()=='releases/fkssj-0.13.0-20261020T071030Z','browser_record_invalid')
            stage=self.static.record('staged.json')
            need(stage.get('state')=='staged','stage_unconfirmed')
            record=self.static.qa_waiver_record()
            raw=canonical(record)
            self.host.write_new(path,raw)
            self.static.qa_waiver(sha(raw))
            return {'state':'explicit_manual_qa_waiver_recorded','qaDecisionSha256':sha(raw),
                    'manualChecks':record['manualChecks'],'browserChecksPerformed':False,
                    'injectionEvidenceRunner':record['injectionEvidence']['runner']}
        except BaseException as error:
            return self.error(error,'qa_waiver_not_recorded_or_partial_inspect')

    def accept_activate(self, *, qa_waiver_sha256=None):
        phase,summary='preflight',{}
        qa_basis='explicit_user_manual_qa_waiver' if qa_waiver_sha256 is not None else 'separate_operator_record'
        try:
            self.saved()
            need(not self.host.exists(ATTEMPT) and not self.host.exists(RECEIPT)
                 and not self.host.exists(SUMMARY),'existing_attempt')
            if qa_waiver_sha256 is None:
                phase='browser_gate'
                need(not self.host.exists(str(self.static.private('manual-qa-waiver.json'))),'browser_record_invalid')
                browser=self.host.read_private(self.browser_path);browser_sha=sha(browser)
                browser_record=self.static.browser(browser_sha)
                injected=self.static.s.strict_json(self.host.read_private(self.injections_path))
                need(injected.get('bindingSha256')==self.binding_sha and injected.get('injections')==sorted(INJECTIONS)
                     and injected.get('input',{}).get('manifestSha256')==self.b['static']['manifestSha256']
                     and injected.get('input',{}).get('checks')==browser_record.get('checks'),'browser_record_invalid')
            else:
                phase='explicit_manual_qa_waiver_gate'
                need(not self.host.exists(self.browser_path) and not self.host.exists(self.injections_path),'browser_record_invalid')
                self.static.qa_waiver(qa_waiver_sha256)
            phase='api_precheck';self.host.verify_api(self.b['apiAcceptance'])
            # O_EXCL durable marker precedes the first possible registration.
            # Failure, timeout or lost output is never permission to run again.
            phase='record_acceptance_attempt'
            self.host.write_new(ATTEMPT,canonical({'bindingSha256':self.binding_sha,'state':'started','maximumAutomaticAccounts':2}))
            phase='api_acceptance'
            reply=self.host.run_acceptance(self.b['apiAcceptance'])
            summary=self.account_summary(reply.get('summary'))
            receipt=reply['receipt'];need(isinstance(receipt,bytes),'activation_unconfirmed')
            phase='save_api_receipt'
            self.host.write_new(RECEIPT,receipt)
            phase='save_acceptance_summary'
            self.host.write_new(SUMMARY,canonical({'bindingSha256':self.binding_sha,'summary':summary,'browserChecks':qa_basis}))
            phase='api_recheck';self.host.verify_api(self.b['apiAcceptance'])
            phase='api_health_before_switch';self.host.health()
            phase='static_activate'
            activated=(self.static.activate(sha(receipt),browser_sha) if qa_waiver_sha256 is None
                       else self.static.activate(sha(receipt),qa_waiver_sha256=qa_waiver_sha256))
            need(activated.get('state')=='activated_verified','activation_unconfirmed')
            phase='close_preview'
            self.host.write_new(CLOSED,b'closed after confirmed manual activation\n',mode=0o644)
            return {'state':'activated_needs_public_verify','current':self.static.new,'oldVersionPreserved':True,
                    'automaticAccountsMaximum':2,'previewClosed':True,'apiReceiptSha256':sha(receipt)}
        except BaseException as error:
            result=dict(self.error(error,'acceptance_or_switch_failed_inspect_no_retry'),phase=phase)
            error_type=getattr(self.a,'AcceptanceError',None)
            if isinstance(error_type,type) and isinstance(error,error_type):
                if type(error.code) is str and error.code in getattr(self.a,'CODES',()):result['reason']=error.code
                if isinstance(getattr(error,'summary',None),dict):
                    summary=self.account_summary(error.summary)
            if summary:
                result['accountSummary']=summary
                result['automaticAccountCreationMayHaveOccurred']=(summary.get('accountCreationRequests',1)>0
                    or summary.get('requestOutcomeMayBeUncertain',False))
                try:
                    if not self.host.exists(SUMMARY):
                        self.host.write_new(SUMMARY,canonical({'bindingSha256':self.binding_sha,
                            'phase':phase,'reason':result['reason'],'summary':summary,'browserChecks':qa_basis}))
                        result['failureSummaryPersisted']=True
                    else:result['failureSummaryPersisted']=False
                except BaseException:result['failureSummaryPersisted']=False
            elif phase in ('api_acceptance','save_api_receipt','save_acceptance_summary','api_recheck','api_health_before_switch','static_activate','close_preview'):
                result['automaticAccountCreationMayHaveOccurred']=True
            return result

    def verify(self):
        try:
            self.saved();need(self.host.current()==self.static.new,'public_verification_failed')
            self.host.verify_api(self.b['apiAcceptance']);self.host.health()
            for name,data in sorted(self.files.items()):
                status,headers,raw=self.host.public_get('/'+name,len(data))
                h={key.lower():value for key,value in headers.items()}
                need(status==200 and sha(raw)==sha(data) and h.get('x-content-type-options')=='nosniff'
                     and 'no-cache' in h.get('cache-control',''),'public_verification_failed')
                expected={'.js':'javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml'}.get(Path(name).suffix)
                need(expected is None or expected in h.get('content-type',''),'public_verification_failed')
            status,headers,body=self.host.public_get(MISSING,65536)
            need(status==404,'public_verification_failed')
            need(self.host.current()==self.static.new,'public_verification_failed')
            self.host.verify_api(self.b['apiAcceptance'])
            return {'state':'public_version_and_api_verified','version':'0.14.0','fileCount':len(self.files)-1,
                    'current':self.static.new,'playerDataReadOrWritten':False}
        except BaseException as error:return self.error(error,'public_verification_failed_no_automatic_switch')

    def rollback(self):
        try:
            self.saved()
            return self.static.rollback()
        except BaseException as error:return self.error(error,'rollback_not_attempted')


if __name__=='__main__':
    print('{"state":"stopped","reason":"pinned_manual_bootstrap_required"}')
    raise SystemExit(1)

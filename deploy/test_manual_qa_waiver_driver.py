"""One-candidate manual-QA decision: orchestration fixtures, no live accounts.

The static policy's record validation is tested separately. These tests extend
only the existing memory fixture and never replace API isolation acceptance.
"""
import copy
import hashlib
import json
import unittest

from deploy import manual_api_acceptance as acceptance
from deploy import manual_release_driver as driver
from deploy import test_manual_release_driver as fixture

MANUAL = dict.fromkeys(('basic_ui','two_tabs','independent_context'),'waived_not_run')


def digest(value): return hashlib.sha256(value).hexdigest()


class WaiverDriverTests(unittest.TestCase):
    def build(self):
        fx=fixture.Fixture(self)
        self.assertEqual(fx.subject.install()['state'],'preview_ready_not_activated')
        path=str(fx.static.private('manual-qa-waiver.json'))
        record={'schema':1,'type':'fkssj-explicit-manual-qa-waiver',
            'manualChecks':dict(MANUAL),'manifestSha256':fx.static.b['manifestSha256'],
            'injectionEvidence':{'runner':'cloud_node_fixture','checks':dict.fromkeys(driver.INJECTIONS,True)},
            'knownGaps':['real_browser','real_offline','real_quota','independent_account_restore']}
        def staged(name):
            self.assertEqual(name,'staged.json')
            return {'state':'staged'}
        def waiver_record():
            fx.host.events.append(('waiver_record',))
            return copy.deepcopy(record)
        def waiver(pin):
            raw=fx.host.read_private(path)
            if digest(raw)!=pin or json.loads(raw)!=record:
                raise driver.Failure('browser_record_invalid')
            fx.host.events.append(('waiver',))
            return copy.deepcopy(record)
        def activate(receipt,browser=None,*,qa_waiver_sha256=None):
            self.assertIsNone(browser)
            self.assertIsNotNone(qa_waiver_sha256)
            self.assertEqual(digest(fx.host.read_private(driver.RECEIPT)),receipt)
            waiver(qa_waiver_sha256)
            fx.host.events.append(('activate_waiver',))
            if fx.activate_result=='activated_verified':fx.host.target=fx.static.new
            return {'state':fx.activate_result}
        fx.static.record=staged
        fx.static.qa_waiver_record=waiver_record
        fx.static.qa_waiver=waiver
        fx.static.activate=activate
        return fx,path,record

    def decide(self,fx):
        result=fx.subject.record_qa_waiver()
        self.assertEqual(result['state'],'explicit_manual_qa_waiver_recorded',result)
        return result['qaDecisionSha256']

    def no_private(self,result):self.assertNotIn(fixture.PRIVATE_BAIT,json.dumps(result))

    def test_record_is_waived_not_run_and_creates_no_browser_or_API_evidence(self):
        fx,path,record=self.build();before=fx.host.attempts
        pin=self.decide(fx)
        saved=json.loads(fx.host.read_private(path))
        self.assertEqual(saved['manualChecks'],MANUAL)
        self.assertTrue(all(value=='waived_not_run' for value in saved['manualChecks'].values()))
        self.assertEqual(digest(fx.host.read_private(path)),pin)
        self.assertEqual(saved['injectionEvidence']['runner'],'cloud_node_fixture')
        self.assertFalse(fx.host.exists(fx.subject.browser_path))
        self.assertFalse(fx.host.exists(fx.subject.injections_path))
        self.assertFalse(fx.host.exists(driver.ATTEMPT));self.assertFalse(fx.host.exists(driver.RECEIPT))
        self.assertEqual(fx.host.attempts,before)
        self.assertEqual(fx.host.target,fixture.OLD)

    def test_any_existing_evidence_or_attempt_blocks_new_waiver_and_original_browser_record(self):
        for blocked in ('waiver','browser','injections',driver.ATTEMPT,driver.RECEIPT,driver.SUMMARY,driver.CLOSED):
            fx,path,record=self.build()
            target={'waiver':path,'browser':fx.subject.browser_path,'injections':fx.subject.injections_path}.get(blocked,blocked)
            fx.host.records[str(target)]=b'FIXTURE PREEXISTING DO NOT OVERWRITE'
            before=dict(fx.host.records)
            result=fx.subject.record_qa_waiver();self.no_private(result)
            self.assertEqual(result['reason'],'existing_attempt',result)
            self.assertEqual(fx.host.records,before);self.assertEqual(fx.host.attempts,0)
        fx,path,record=self.build();self.decide(fx)
        result=fx.subject.browser_record(fx.browser_input())
        self.assertEqual(result['reason'],'existing_attempt')
        self.assertFalse(fx.host.exists(fx.subject.browser_path))

    def test_default_browser_path_keeps_eight_true_checks_and_does_not_consume_waiver(self):
        fx=fixture.Fixture(self)
        self.assertEqual(fx.subject.install()['state'],'preview_ready_not_activated')
        for name in ('basic_ui','two_tabs','independent_context','identity_freeze'):
            data=fx.browser_input();data['checks'][name]=False
            self.assertEqual(fx.subject.browser_record(data)['reason'],'browser_incomplete')
        self.assertEqual(fx.subject.browser_record(fx.browser_input())['state'],'browser_recorded_operator_attestation')
        self.assertEqual(fx.subject.accept_activate()['state'],'activated_needs_public_verify')
        fx,path,record=self.build();self.decide(fx)
        result=fx.subject.accept_activate()
        self.assertEqual(result['reason'],'browser_record_invalid')
        self.assertEqual(fx.host.attempts,0);self.assertFalse(fx.host.exists(driver.ATTEMPT))

    def test_waiver_success_keeps_API_gates_marker_order_and_two_account_limit(self):
        fx,path,record=self.build();pin=self.decide(fx)
        original=fx.host.run_acceptance
        def run(bindings):
            self.assertEqual(bindings,fx.bindings['apiAcceptance'])
            reply=original(bindings)
            reply['summary']={'accountCreationRequests':2,'accountsConfirmed':2,
                              'restartAttempted':True,'requestOutcomeMayBeUncertain':False}
            return reply
        fx.host.run_acceptance=run
        fx.host.events.clear()
        result=fx.subject.accept_activate(qa_waiver_sha256=pin)
        self.assertEqual(result['state'],'activated_needs_public_verify',result)
        events=fx.host.events
        names=[event[0] for event in events]
        self.assertLess(names.index('waiver'),names.index('verify_api'))
        self.assertLess(names.index('verify_api'),events.index(('write',driver.ATTEMPT)))
        self.assertLess(events.index(('write',driver.ATTEMPT)),names.index('acceptance'))
        self.assertLess(names.index('acceptance'),names.index('health'))
        self.assertLess(names.index('health'),names.index('activate_waiver'))
        self.assertEqual(names.count('verify_api'),2)
        self.assertEqual(names.count('acceptance'),1)
        self.assertNotIn('browser',names)
        self.assertEqual(json.loads(fx.host.read_private(driver.ATTEMPT))['maximumAutomaticAccounts'],2)
        summary=json.loads(fx.host.read_private(driver.SUMMARY))
        self.assertEqual(summary['browserChecks'],'explicit_user_manual_qa_waiver')
        self.assertEqual(summary['summary']['accountCreationRequests'],2)
        self.assertEqual(result['automaticAccountsMaximum'],2)
        self.assertEqual(fx.host.attempts,1)
        self.assertFalse(fx.host.exists(fx.subject.browser_path))
        self.assertTrue(fx.host.exists(driver.CLOSED))

    def test_invalid_waiver_or_API_precheck_failure_creates_no_QA_attempt(self):
        for kind in ('bad_pin','changed_record','api_failure','browser_collision','injections_collision'):
            fx,path,record=self.build();pin=self.decide(fx)
            if kind=='bad_pin':pin='0'*64
            elif kind=='changed_record':fx.host.records[path]=b'{"tampered":true}'
            elif kind=='api_failure':fx.host.fail_api=True
            elif kind=='browser_collision':fx.host.records[fx.subject.browser_path]=b'EXISTING'
            else:fx.host.records[fx.subject.injections_path]=b'EXISTING'
            result=fx.subject.accept_activate(qa_waiver_sha256=pin);self.no_private(result)
            self.assertNotEqual(result['state'],'activated_needs_public_verify',result)
            self.assertEqual(fx.host.attempts,0)
            self.assertFalse(fx.host.exists(driver.ATTEMPT))
            self.assertFalse(any(event[0]=='activate_waiver' for event in fx.host.events))

    def test_unknown_HTTP_persists_honest_classification_and_permanently_blocks_replay(self):
        fx,path,record=self.build();pin=self.decide(fx);fx.subject.a=acceptance
        def fail(bindings):
            self.assertTrue(fx.host.exists(driver.ATTEMPT))
            fx.host.attempts+=1
            error=acceptance.AcceptanceError('https_request_failed')
            error.args=(fixture.PRIVATE_BAIT,)
            error.summary={'accountCreationRequests':2,'accountsConfirmed':1,
                'restartAttempted':False,'requestOutcomeMayBeUncertain':True,
                'secret':fixture.PRIVATE_BAIT}
            raise error
        fx.host.run_acceptance=fail
        result=fx.subject.accept_activate(qa_waiver_sha256=pin);self.no_private(result)
        self.assertTrue(result['automaticAccountCreationMayHaveOccurred'])
        self.assertTrue(result['failureSummaryPersisted'])
        summary=json.loads(fx.host.read_private(driver.SUMMARY))
        self.assertEqual(summary['browserChecks'],'explicit_user_manual_qa_waiver')
        self.assertNotIn(fixture.PRIVATE_BAIT,json.dumps(summary))
        self.assertEqual(fx.host.target,fixture.OLD)
        fx.subject.accept_activate(qa_waiver_sha256=pin)
        self.assertEqual(fx.host.attempts,1)
        self.assertFalse(any(event[0]=='activate_waiver' for event in fx.host.events))

    def test_unknown_activation_does_not_retry_or_rollback_and_existing_attempts_rejected(self):
        fx,path,record=self.build();pin=self.decide(fx);fx.activate_result='uncertain_after_activation_attempt'
        result=fx.subject.accept_activate(qa_waiver_sha256=pin);self.no_private(result)
        self.assertNotEqual(result['state'],'activated_needs_public_verify')
        self.assertEqual(sum(e[0]=='activate_waiver' for e in fx.host.events),1)
        fx.subject.accept_activate(qa_waiver_sha256=pin)
        self.assertEqual(fx.host.attempts,1)
        self.assertEqual(sum(e[0]=='activate_waiver' for e in fx.host.events),1)
        self.assertFalse(any(e[0]=='rollback' for e in fx.host.events))
        for target in (driver.ATTEMPT,driver.RECEIPT,driver.SUMMARY):
            fx,path,record=self.build();pin=self.decide(fx);fx.host.records[target]=b'EXISTING'
            result=fx.subject.accept_activate(qa_waiver_sha256=pin)
            self.assertEqual(result['reason'],'existing_attempt')
            self.assertEqual(fx.host.attempts,0)


if __name__=='__main__':unittest.main()

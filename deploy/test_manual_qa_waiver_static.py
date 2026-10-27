"""Explicit QA decision fixtures; no server, actual users, or live publication.

Positive filesystem tests replace only the three candidate constants with the
existing synthetic static fixture's bindings. Production constants are asserted
separately and cannot be set by an operator input or uploaded record.
"""
from contextlib import contextmanager
import copy
import datetime as dt
import json
import os
import unittest
from unittest import mock

from deploy import manual_static_switch as m
from deploy import test_manual_static_switch as manual_fixture
from deploy import test_static_release as base

BAIT = 'NEVER_EXPORT_FIXTURE_PRIVATE_ERROR'


class ExplicitQaWaiverStaticTests(unittest.TestCase):
    def setUp(self):
        self.fx = manual_fixture.ManualSwitchTests(methodName='runTest');self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.engine = self.fx.engine

    @contextmanager
    def scope(self):
        with mock.patch.multiple(m, QA_WAIVER_MANIFEST=self.fx.bindings['manifestSha256'],
                QA_WAIVER_SOURCE=self.fx.bindings['sourceSha256'],
                QA_WAIVER_RELEASE=self.fx.bindings['releaseId']):
            yield

    def stage(self):self.fx.stage()

    def record(self, mutate=None):
        record = self.engine.qa_waiver_record()
        if mutate:mutate(record)
        path = self.fx.h.backup/m.QA_WAIVER_FILE
        path.write_bytes(m.encode(record));path.chmod(0o600)
        return m.sha(path.read_bytes()), record

    def test_production_scope_is_exact_and_other_candidates_are_rejected(self):
        self.assertEqual(m.QA_WAIVER_MANIFEST,'b20e11a258007f39129a47601be7a291391c9275ad5ea6b51ab0e9e7f21aa272')
        self.assertEqual(m.QA_WAIVER_SOURCE,'6c9a645f0a4af86d484bc4a735a83fe2fbfd0cebd4fe6a2915719e9b90e566d0')
        self.assertEqual(m.QA_WAIVER_RELEASE,'fkssj-0.14.0-b20e11a258007f39')
        with self.assertRaisesRegex(m.Failure,'qa_waiver_invalid'):self.engine.qa_waiver_record()
        with self.scope():
            for key in ('manifestSha256','sourceSha256','releaseId'):
                saved=self.engine.b[key];self.engine.b[key]='0'*64
                with self.assertRaisesRegex(m.Failure,'qa_waiver_invalid'):self.engine.qa_waiver_record()
                self.engine.b[key]=saved

    def test_record_is_new_type_not_browser_pass_and_never_relabels_injections(self):
        self.stage()
        with self.scope():
            pin,record=self.record()
            self.assertEqual(self.engine.qa_waiver(pin),record)
            self.assertEqual(record['type'],'fkssj-explicit-manual-qa-waiver')
            self.assertEqual(record['manualChecks'],dict.fromkeys(('basic_ui','two_tabs','independent_context'),'waived_not_run'))
            self.assertEqual(record['injectionEvidence']['runner'],'cloud_node_fixture')
            self.assertTrue(all(v is True for v in record['injectionEvidence']['checks'].values()))
            self.assertFalse((self.fx.h.backup/m.BROWSER).exists())
            self.assertEqual(record['decisionText'],
            'Explicit user approval to release this candidate with three manual QA checks not run.')
            # One returned dictionary cannot mutate shared policy constants.
            record['injectionEvidence']['checks']['identity_freeze']=False
            self.assertIs(self.engine.qa_waiver_record()['injectionEvidence']['checks']['identity_freeze'],True)

    def test_malformed_decision_scope_fields_false_true_and_injections_are_rejected(self):
        self.stage()
        changes = [
            lambda r:r.update(schema=True), lambda r:r.update(type='fkssj-browser-acceptance'),
            lambda r:r.update(basis='operator_attestation_after_real_browser_checks'),
            lambda r:r.update(origin='http://fkssj.harvey-ai.xyz'),lambda r:r.update(manifestSha256='0'*64),
            lambda r:r.update(sourceSha256='0'*64),lambda r:r.update(decisionMessageId='other-message'),
            lambda r:r.update(decisionText='not authorized'),lambda r:r.update(extra='unapproved'),
            lambda r:r['manualChecks'].update(basic_ui=True),lambda r:r['manualChecks'].update(two_tabs=False),
            lambda r:r['manualChecks'].pop('independent_context'),lambda r:r['knownGaps'].pop(),
            lambda r:r['injectionEvidence'].update(runner='real_browser'),
            lambda r:r['injectionEvidence'].update(testsPassed=10.0),
            lambda r:r['injectionEvidence']['checks'].update(identity_freeze=False),
            lambda r:r['injectionEvidence']['checks'].update(identity_freeze=1),
            lambda r:r['injectionEvidence'].update(reportSha256='0'*64),
            lambda r:r['injectionEvidence'].update(accountManagerSha256='0'*64),
            lambda r:r['injectionEvidence'].update(apiPreviewSha256='0'*64),
        ]
        with self.scope():
            for change in changes:
                with self.subTest(change=change):
                    pin,record=self.record(change)
                    with self.assertRaisesRegex(m.Failure,'qa_waiver_invalid'):self.engine.qa_waiver(pin)
            pin,record=self.record()
            with self.assertRaisesRegex(m.Failure,'qa_waiver_invalid'):self.engine.qa_waiver('0'*64)
            with self.assertRaisesRegex(m.Failure,'qa_waiver_invalid'):self.engine.qa_waiver('bad')

    def test_future_stale_missing_and_unsafe_record_are_rejected(self):
        self.stage()
        with self.scope():
            with self.assertRaisesRegex(m.Failure,'qa_waiver_missing'):self.engine.qa_waiver('0'*64)
            for delta in (dt.timedelta(seconds=1),-dt.timedelta(hours=2,seconds=1)):
                pin,_=self.record(lambda r:r.update(recordedAt=(self.fx.h.now()+delta).isoformat().replace('+00:00','Z')))
                with self.assertRaisesRegex(m.Failure,'qa_waiver_invalid'):self.engine.qa_waiver(pin)
            pin,_=self.record();path=self.fx.h.backup/m.QA_WAIVER_FILE
            path.chmod(0o640)
            with self.assertRaisesRegex(m.Failure,'unsafe_file'):self.engine.qa_waiver(pin)
            path.chmod(0o600);os.link(path,self.fx.fx.base/'alias')
            with self.assertRaisesRegex(m.Failure,'unsafe_file'):self.engine.qa_waiver(pin)

    def test_both_or_neither_evidence_policy_stops_before_api_or_switch(self):
        self.stage()
        with self.scope():
            pin,_=self.record()
            for browser,waiver in ((None,None),('1'*64,pin)):
                result=self.engine.activate(self.fx.fx.receipt_hash,browser,qa_waiver_sha256=waiver)
                self.assertEqual(result['state'],'stopped_no_switch_attempt',result)
                self.assertEqual(result['reason'],'qa_policy_invalid')
                self.assertEqual(os.readlink(self.fx.fx.root/'current'),m.OLD)
                self.assertFalse((self.fx.h.backup/'activate-attempt.json').exists())

    def test_actual_atomic_waiver_activation_journal_truth_and_static_only_rollback(self):
        self.stage()
        with self.scope():
            pin,_=self.record()
            result=self.engine.activate(self.fx.fx.receipt_hash,qa_waiver_sha256=pin)
            self.assertEqual(result['state'],'activated_verified',result)
            self.assertEqual(result['qaPolicy'],'explicit_user_manual_qa_waiver')
            self.assertEqual(result['qaDecisionSha256'],pin)
            self.assertIn('waived_not_run',result['browserEvidence'])
            self.assertNotIn('real-browser',result['browserEvidence'])
            self.assertFalse((self.fx.h.backup/m.BROWSER).exists())
            for name in ('activate-attempt.json','activated.json'):
                value=json.loads((self.fx.h.backup/name).read_bytes())
                self.assertEqual(value['qaDecisionSha256'],pin)
                self.assertEqual(value['qaPolicy'],'explicit_user_manual_qa_waiver')
                self.assertNotIn('browserRecordSha256',value)
            self.fx.unchanged_data()
            self.assertEqual(self.engine.rollback()['state'],'rolled_back_verified')
            self.assertEqual(os.readlink(self.fx.fx.root/'current'),m.OLD)
            self.fx.unchanged_data()

    def test_api_receipt_remains_mandatory_and_expiry_checks_fail_closed(self):
        self.stage()
        with self.scope():
            pin,_=self.record()
            result=self.engine.activate('0'*64,qa_waiver_sha256=pin)
            self.assertEqual(result['reason'],'api_receipt_invalid')
            for mutate in (
                lambda r:r['checks'].update(health=False),
                lambda r:r.update(expiresAt='2026-10-21T08:00:00Z'),
                lambda r:r.update(origin='http://fkssj.harvey-ai.xyz'),
                lambda r:r.update(apiAppSha256='0'*64),
            ):
                original=copy.deepcopy(self.fx.fx.receipt)
                mutate(self.fx.fx.receipt);self.fx.fx.save_receipt();self.fx.fx.receipt_path.chmod(0o600)
                result=self.engine.activate(self.fx.fx.receipt_hash,qa_waiver_sha256=pin)
                self.assertEqual(result['state'],'stopped_no_switch_attempt',result)
                self.assertEqual(os.readlink(self.fx.fx.root/'current'),m.OLD)
                self.assertFalse((self.fx.h.backup/'activate-attempt.json').exists())
                self.fx.fx.receipt=original;self.fx.fx.save_receipt();self.fx.fx.receipt_path.chmod(0o600)

    def test_old_tree_drift_blocks_waiver_switch(self):
        self.stage()
        with self.scope():
            pin,_=self.record()
            path=self.fx.old/'app.js';original=path.read_bytes();path.write_bytes(b'UNAPPROVED')
            result=self.engine.activate(self.fx.fx.receipt_hash,qa_waiver_sha256=pin)
            self.assertEqual(result['reason'],'legacy_tree_changed')
            self.assertEqual(os.readlink(self.fx.fx.root/'current'),m.OLD)
            self.assertFalse((self.fx.h.backup/'activate-attempt.json').exists())

    def test_staged_payload_drift_blocks_waiver_switch(self):
        self.stage()
        with self.scope():
            pin,_=self.record()
            (self.fx.fx.root/self.engine.new/'index.html').write_bytes(b'UNAPPROVED STAGED FIXTURE')
            result=self.engine.activate(self.fx.fx.receipt_hash,qa_waiver_sha256=pin)
            self.assertEqual(result['state'],'stopped_no_switch_attempt',result)
            self.assertEqual(os.readlink(self.fx.fx.root/'current'),m.OLD)
            self.assertFalse((self.fx.h.backup/'activate-attempt.json').exists())
            self.fx.unchanged_data()

    def test_uncertain_activation_keeps_attempt_blocks_retry_and_never_auto_rolls_back(self):
        self.stage()
        with self.scope():
            pin,_=self.record()
            with mock.patch.object(base.release,'activate',side_effect=base.release.Uncertain(BAIT)):
                result=self.engine.activate(self.fx.fx.receipt_hash,qa_waiver_sha256=pin)
            self.assertEqual(result['state'],'uncertain_after_activation_attempt')
            self.assertNotIn(BAIT,json.dumps(result))
            self.assertTrue((self.fx.h.backup/'activate-attempt.json').exists())
            result=self.engine.activate(self.fx.fx.receipt_hash,qa_waiver_sha256=pin)
            self.assertEqual(result['reason'],'existing_attempt')
            self.assertEqual(self.engine.rollback()['reason'],'activated_record_missing')

    def test_old_browser_branch_still_rejects_not_run_or_false_evidence(self):
        self.stage()
        for value in (False,'waived_not_run'):
            pin=self.fx.browser(checks=dict.fromkeys(m.BROWSER_CHECKS,value))
            result=self.engine.activate(self.fx.fx.receipt_hash,pin)
            self.assertEqual(result['reason'],'browser_gate_invalid')
            self.assertEqual(os.readlink(self.fx.fx.root/'current'),m.OLD)


if __name__=='__main__':unittest.main(verbosity=2)

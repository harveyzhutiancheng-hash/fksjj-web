"""Run the exact browser fixture JS in Node; not a real browser attestation."""
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

from api.preview import BROWSER_CHECK_HTML
from api import test_preview as preview_fixture


class BrowserFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        html = BROWSER_CHECK_HTML
        self.script = re.search(r'<script type="module" id="checks-module">(.*?)</script>', html, re.S)[1]
        self.script = self.script.replace("import * as candidate from './account-manager.js';", '')
        self.manager = Path(__file__).resolve().parents[1].joinpath('account-manager.js').read_text()

    def node(self, test, *, namespaced=True):
        source = self.manager.replace('fkssj-', 'fkssj-preview-fixture-') if namespaced else self.manager
        account = self.root / 'account-manager.mjs'
        account.write_text(source)
        script = ("import nodeAssert from 'node:assert/strict';\nimport * as candidate from "
                  + json.dumps(account.as_uri()) + ";\n"
                  + "globalThis.fetch=()=>{throw Error('forbidden network');};\n"
                  + "Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('forbidden global storage');}});\n"
                  + self.script + '\n' + re.sub(r'\bassert\b', 'nodeAssert', test))
        path = self.root / 'check.mjs';path.write_text(script)
        result = subprocess.run(['node', str(path)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        return result.stdout.strip()

    def test_current_candidate_passes_all_five_without_network_global_storage_or_dom(self):
        text = self.node("const result=await runInjected(candidate);assert.deepEqual(Object.values(result),[true,true,true,true,true]);console.log('passed');")
        self.assertEqual(text, 'passed')

    def test_key_derivation_supports_both_live_and_preview_namespace_modules(self):
        self.assertEqual(self.node("assert(Object.values(await runInjected(candidate)).every(Boolean));console.log('passed');", namespaced=False), 'passed')

    def test_broken_migration_cannot_report_pass(self):
        self.node("class Broken extends candidate.AccountManager{async register(){}}const r=await runInjected({...candidate,AccountManager:Broken});assert.equal(r.guest_migration,false);")

    def test_broken_freeze_and_late_guard_cannot_report_pass(self):
        self.node("class Broken extends candidate.AccountManager{freezeIdentity(){}}const r=await runInjected({...candidate,AccountManager:Broken});assert.equal(r.identity_freeze,false);assert.equal(r.late_response,false);")

    def test_broken_conflict_choices_cannot_report_pass(self):
        self.node("class Broken extends candidate.AccountManager{async resolveConflict(){}}const r=await runInjected({...candidate,AccountManager:Broken});assert.equal(r.conflict_choices,false);")

    def test_missing_post_auth_storage_protection_cannot_report_pass(self):
        self.node("class Broken extends candidate.AccountManager{async login(){}}const r=await runInjected({...candidate,AccountManager:Broken});assert.equal(r.storage_failure,false);")

    def test_manual_checks_default_false_and_cannot_override_failed_injection(self):
        self.node("const r=await runInjected(candidate);let summary=collectChecks(r,{},'a'.repeat(64));assert.deepEqual(Object.values(summary.checks).slice(0,3),[false,false,false]);summary=collectChecks({...r,storage_failure:false},{basic_ui:true,two_tabs:true,independent_context:true,storage_failure:true},'a'.repeat(64));assert.equal(summary.checks.storage_failure,false);assert.equal(Object.keys(summary.checks).length,8);assert.equal(summary.injections.length,5);assert.equal(summary.manifestSha256,'a'.repeat(64));")
        self.assertNotRegex(BROWSER_CHECK_HTML, r'<input[^>]*\bchecked\b')
        self.assertIn('普通新标签不等于独立上下文', BROWSER_CHECK_HTML)
        self.assertIn('不等于实际断网或耗尽配额', BROWSER_CHECK_HTML)
        self.assertLessEqual(len(BROWSER_CHECK_HTML.encode()), 10240)

    def test_failure_output_is_boolean_only(self):
        result = self.node("class Broken{constructor(){throw Error('PRIVATE-BAIT-NOT-OUTPUT');}}console.log(JSON.stringify(collectChecks(await runInjected({...candidate,AccountManager:Broken}),{},'a'.repeat(64))));")
        decoded=json.loads(result)
        self.assertTrue(all(value is False for value in decoded['checks'].values()))
        self.assertNotIn('PRIVATE', result)

    def test_manifest_binding_requires_exact_path_hash_not_query_or_bad_value(self):
        self.node("for(const value of [undefined,null,7,'','../','A'.repeat(64),'a'.repeat(64)+'?fake=1'])assert.throws(()=>collectChecks({}, {},value));assert.equal(collectChecks({}, {},'b'.repeat(64)).manifestSha256,'b'.repeat(64));")
        self.assertIn("location.pathname.split('/')[3]", BROWSER_CHECK_HTML)
        self.assertNotIn('location.search', BROWSER_CHECK_HTML)

    def test_virtual_page_still_requires_bound_manifest_and_open_preview(self):
        fixture = preview_fixture.PreviewTests(methodName='runTest')
        fixture.setUp()
        try:
            result=fixture.request(fixture.prefix+'__checks.html')
            self.assertEqual(result['code'],'200 OK')
            self.assertEqual(result['body'],BROWSER_CHECK_HTML.encode())
            self.assertIn('text/html',result['headers']['Content-Type'])
            self.assertEqual(result['headers']['Cache-Control'],'no-store')
            self.assertEqual(fixture.request(fixture.prefix+'__checks.js')['code'],'404 Not Found')
            fixture.closed.write_text('closed')
            self.assertEqual(fixture.request(fixture.prefix+'__checks.html')['code'],'404 Not Found')
            fixture.closed.unlink();(fixture.root/'release.json').write_text('tampered')
            self.assertEqual(fixture.request(fixture.prefix+'__checks.html')['code'],'404 Not Found')
        finally:
            fixture.doCleanups()


if __name__ == '__main__':unittest.main()

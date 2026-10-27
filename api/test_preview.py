import hashlib
import json
import os
from pathlib import Path
import base64
import subprocess
import tempfile
import types
import unittest
from unittest import mock

from api import preview


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)/'static';self.root.mkdir()
        self.closed = Path(self.temp.name)/'closed'
        self.rows=[]
        self.data={}
        project=Path(__file__).resolve().parents[1]
        for name in sorted(preview.FILES):
            value=(project/name).read_bytes()
            self.data[name]=value
            p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(value);p.chmod(0o644)
            self.rows.append(dict(path=name,bytes=len(value),sha256=hashlib.sha256(value).hexdigest()))
        raw=json.dumps(dict(version='0.14.0',createdAt='fixture',fileCount=len(self.rows),totalBytes=sum(x['bytes'] for x in self.rows),files=self.rows)).encode()
        (self.root/'release.json').write_bytes(raw)
        self.sha=hashlib.sha256(raw).hexdigest();self.prefix='/api/preview/'+self.sha+'/'
        def metadata(info):
            values={k:getattr(info,k) for k in dir(info) if k.startswith('st_')};values['st_uid']=0
            # Production lives below /opt; /tmp is a fixture-only ancestor.
            if info.st_ino == os.stat('/tmp').st_ino and info.st_dev == os.stat('/tmp').st_dev:
                values['st_mode'] &= ~0o022
            return types.SimpleNamespace(**values)
        self.api=mock.Mock(return_value=[b'original-api'])
        self.app=preview.Preview(self.api,self.sha,self.root,self.closed,metadata)

    def request(self,path,method='GET'):
        result={}
        def response(code,headers):result.update(code=code,headers=dict(headers))
        result['body']=b''.join(self.app({'PATH_INFO':path,'REQUEST_METHOD':method},response))
        return result

    def test_manifest_bound_index_and_relative_assets(self):
        result=self.request(self.prefix)
        self.assertEqual(result['code'],'200 OK');self.assertIn('候选预览'.encode(),result['body'])
        self.assertIn(b'./bootstrap.js',result['body'])
        for name in ('scene.js','node_modules/three/build/three.module.js','account-ui.css'):
            self.assertEqual(self.request(self.prefix+name)['body'],self.data[name])
        self.assertIn('javascript',self.request(self.prefix+'scene.js')['headers']['Content-Type'])

    def test_preview_only_storage_and_writer_locks_are_namespaced(self):
        for name in preview.NAMESPACED:
            original=self.data[name];changed=self.request(self.prefix+name)['body']
            self.assertEqual(changed,original.replace(b'fkssj-',('fkssj-preview-'+self.sha[:16]+'-').encode()))
            self.assertEqual((self.root/name).read_bytes(),original)
            for key in (b"'fkssj-save-v1'",b"'fkssj-sound'",b"'fkssj-game-writer'",b"'fkssj-active-account-v1'"):
                self.assertNotIn(key,changed)
        # Absolute account API calls remain same-origin under the real /api.
        original=self.data['account-manager.js'];changed=self.request(self.prefix+'account-manager.js')['body']
        self.assertEqual(original.count(b'/api/'),changed.count(b'/api/'))

    def test_traversal_code_database_unknown_manifest_and_writes_fail(self):
        bait=Path(self.temp.name)/'hmac.key';bait.write_text('PRIVATE-BAIT')
        for suffix in ('../hmac.key','%2e%2e/hmac.key','/etc/passwd','api/app.py','fkssj.sqlite3','unknown.js','assets/../../hmac.key'):
            result=self.request(self.prefix+suffix)
            self.assertEqual(result['code'],'404 Not Found',suffix)
            self.assertNotIn(b'PRIVATE',result['body'])
        self.assertEqual(self.request(self.prefix,method='POST')['code'],'404 Not Found')
        self.assertEqual(self.request('/api/preview/'+'0'*64+'/')['code'],'404 Not Found')

    def test_symlink_hardlink_changed_content_and_permissions_fail(self):
        path=self.root/'scene.js';path.unlink();path.symlink_to(Path(self.temp.name)/'secret')
        self.assertEqual(self.request(self.prefix+'scene.js')['code'],'404 Not Found')
        path.unlink();path.write_bytes(self.data['scene.js']);os.link(path,self.root/'duplicate')
        self.assertEqual(self.request(self.prefix+'scene.js')['code'],'404 Not Found')
        (self.root/'duplicate').unlink();path.chmod(0o666)
        self.assertEqual(self.request(self.prefix+'scene.js')['code'],'404 Not Found')
        path.chmod(0o644);path.write_bytes(b'tampered')
        self.assertEqual(self.request(self.prefix+'scene.js')['code'],'404 Not Found')

    def test_closed_preview_is_404_but_original_api_is_untouched(self):
        self.closed.write_text('closed')
        self.assertEqual(self.request(self.prefix)['code'],'404 Not Found')
        result=self.request('/api/health');self.assertEqual(result['body'],b'original-api')
        self.api.assert_called_once()

    def test_missing_tree_or_invalid_manifest_does_not_break_api(self):
        (self.root/'release.json').write_text('untrusted')
        self.assertEqual(self.request(self.prefix)['code'],'404 Not Found')
        self.assertEqual(self.request('/api/auth/me')['body'],b'original-api')

    def test_no_store_nosniff_and_head(self):
        get=self.request(self.prefix+'style.css');head=self.request(self.prefix+'style.css','HEAD')
        self.assertEqual(head['body'],b'');self.assertEqual(get['headers'],head['headers'])
        self.assertEqual(get['headers']['Cache-Control'],'no-store')
        self.assertEqual(get['headers']['X-Content-Type-Options'],'nosniff')

    def test_real_javascript_storage_and_lock_calls_never_use_live_keys(self):
        modules={name:base64.b64encode(self.request(self.prefix+name)['body']).decode()
                 for name in ('account-manager.js','page-lock.js')}
        code='''import assert from 'node:assert/strict';
const modules=MODULES;
const original = new Map([['fkssj-save-v1','REAL_PLAYER_SENTINEL'],['fkssj-active-account-v1','UNCHANGED']]);
const touched=[];globalThis.localStorage={getItem:k=>original.get(k)??null,setItem:(k,v)=>{touched.push(k);original.set(k,String(v));},removeItem:k=>{touched.push(k);original.delete(k);}};
const account=await import('data:text/javascript;base64,'+modules['account-manager.js']);
const manager=new account.AccountManager({autoSync:false});
manager.write(account.GUEST_SAVE_KEY,{version:1});manager.backup(7,JSON.stringify({version:1}));
assert.equal(original.get('fkssj-save-v1'),'REAL_PLAYER_SENTINEL');assert.equal(original.get('fkssj-active-account-v1'),'UNCHANGED');
assert(touched.length>0&&touched.every(k=>k.startsWith('PREFIX')));
let lockName;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request(name,options,callback){lockName=name;callback({});return new Promise(()=>{});}}}});
globalThis.window={addEventListener(){}};
const lock=await import('data:text/javascript;base64,'+modules['page-lock.js']);const owns=await lock.acquireGamePage();
assert(owns());assert(lockName.startsWith('PREFIX'));assert.notEqual(lockName,'fkssj-game-writer');
console.log('preview_namespace_real_js_pass');
'''.replace('MODULES',json.dumps(modules)).replace('PREFIX','fkssj-preview-'+self.sha[:16]+'-')
        script=Path(self.temp.name)/'namespace-probe.mjs';script.write_text(code)
        result=subprocess.run(['node',str(script)],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),'preview_namespace_real_js_pass')


if __name__ == '__main__':unittest.main()

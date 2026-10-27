"""Temporary, read-only fixed-candidate preview beneath the approved /api proxy.

The account API is unchanged. This module never serves API code, data, logs,
arbitrary paths or file references. Preview-only storage/lock names differ from
the live game. Cookies still use the origin, so an independent browser context
is required for account testing. Root closes the preview after activation.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from .app import create_app as account_app

ROOT = Path('/opt/fkssj-api/manual-static')
CLOSED = Path('/opt/fkssj-api/preview.closed')
FILES = frozenset('''index.html bootstrap.js app.js account-manager.js
account-ui.js account-ui.css page-lock.js storm-view.js scene.js game-state.js
progress-state.js progress-ui.js progress-ui.css battle-view.js campaign-view.js
scavenging-state.js scavenging-view.js scavenging-ui.js scavenging-ui.css
production-state.js production-ui.js production-ui.css story-state.js
diving-state.js diving-view.js diving-ui.js diving-ui.css battle-view.css icons.js
style.css assets/favicon.svg node_modules/three/build/three.module.js
node_modules/three/build/three.core.js node_modules/three/LICENSE'''.split())
NAMESPACED = frozenset(('app.js', 'account-manager.js', 'game-state.js', 'page-lock.js'))
MIME = {'.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
        '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.json':'application/json'}


class Preview:
    def __init__(self, application, manifest_sha256, root=ROOT, closed=CLOSED, metadata=None):
        self.application, self.expected = application, manifest_sha256
        self.root, self.closed = Path(root), Path(closed)
        self.metadata = metadata or (lambda info: info)

    def read(self, relative, maximum):
        parts = Path(relative).parts
        if not parts or relative.startswith('/') or any(x in ('', '.', '..') for x in parts):
            raise ValueError()
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            for part in self.root.parts[1:] + parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                os.close(fd);fd = child
                info = self.metadata(os.fstat(fd))
                if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
                    raise ValueError()
            source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
            try:
                before = self.metadata(os.fstat(source))
                if not (stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == 0
                        and not stat.S_IMODE(before.st_mode) & 0o022 and 0 < before.st_size <= maximum):
                    raise ValueError()
                data = bytearray()
                while len(data) <= maximum:
                    part = os.read(source, min(65536, maximum+1-len(data)))
                    if not part: break
                    data.extend(part)
                after = self.metadata(os.fstat(source))
                fields = ('st_dev','st_ino','st_mode','st_uid','st_gid','st_size','st_mtime_ns','st_ctime_ns','st_nlink')
                if len(data) != before.st_size or any(getattr(before,k) != getattr(after,k) for k in fields):
                    raise ValueError()
                return bytes(data)
            finally:
                os.close(source)
        finally:
            os.close(fd)

    def resource(self, path):
        if (not isinstance(self.expected, str) or not re.fullmatch('[0-9a-f]{64}',self.expected)
                or os.path.lexists(self.closed)):
            raise ValueError()
        prefix = '/api/preview/' + self.expected + '/'
        if not path.startswith(prefix):
            raise ValueError()
        name = path[len(prefix):] or 'index.html'
        if name not in FILES | {'release.json', '__checks.html'}:
            raise ValueError()
        manifest_raw = self.read('release.json', 32768)
        if hashlib.sha256(manifest_raw).hexdigest() != self.expected:
            raise ValueError()
        manifest = json.loads(manifest_raw)
        rows = manifest['files']
        if (set(manifest) != {'version','createdAt','fileCount','totalBytes','files'} or manifest['version'] != '0.14.0'
                or manifest['fileCount'] != len(FILES) or len(rows) != len(FILES)
                or {row['path'] for row in rows} != FILES):
            raise ValueError()
        if name == 'release.json':
            return manifest_raw
        if name == '__checks.html':
            # A single trusted, virtual test page; never a disk/path lookup.
            return BROWSER_CHECK_HTML.encode('utf-8')
        row = next(row for row in rows if row['path'] == name)
        if set(row) != {'path','bytes','sha256'} or type(row['bytes']) is not int or not 0 < row['bytes'] <= 32*1024*1024:
            raise ValueError()
        data = self.read(name, row['bytes'])
        if len(data) != row['bytes'] or hashlib.sha256(data).hexdigest() != row['sha256']:
            raise ValueError()
        if name in NAMESPACED:
            # Only the four reviewed namespace-bearing modules are changed in
            # preview responses. Stored/package bytes and absolute /api paths
            # remain unchanged. Storage events and navigator.locks use the same
            # preview prefix, so live local saves and the live writer lock stay
            # untouched even if someone opens the wrong browser profile.
            data = data.replace(b'fkssj-', ('fkssj-preview-'+self.expected[:16]+'-').encode())
        if name == 'index.html':
            banner = ('<aside role="status" style="position:fixed;top:0;left:0;right:0;z-index:99999;'
                      'background:#432;color:white;padding:4px;text-align:center;font-size:12px">'
                      '候选预览 · 尚未上线 · 请使用独立浏览器上下文；本地档已隔离</aside>').encode()
            if data.count(b'<body>') != 1:
                raise ValueError()
            data = data.replace(b'<body>', b'<body>'+banner, 1)
        return data

    def __call__(self, environ, start_response):
        path = environ.get('PATH_INFO', '')
        if not path.startswith('/api/preview'):
            return self.application(environ, start_response)
        method = environ.get('REQUEST_METHOD', 'GET')
        try:
            if method not in ('GET','HEAD'):
                raise ValueError()
            data = self.resource(path)
            name = path.rsplit('/',1)[-1] or 'index.html'
            kind = MIME.get(Path(name).suffix, 'text/plain; charset=utf-8')
            code = '200 OK'
        except BaseException:
            data, kind, code = b'{"code":"preview_unavailable"}', 'application/json', '404 Not Found'
        start_response(code, [('Content-Type',kind), ('Content-Length',str(len(data))),
                             ('Cache-Control','no-store'),('X-Content-Type-Options','nosniff'),
                             ('Referrer-Policy','same-origin')])
        return [] if method == 'HEAD' else [data]


def create_app():
    return Preview(account_app(), os.environ.get('FKSSJ_PREVIEW_MANIFEST_SHA256', ''))


BROWSER_CHECK_HTML = r'''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>候选浏览器验收</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:800px;margin:24px auto;padding:0 16px;color:#182a36}button{font:inherit;padding:10px 18px}label{display:block;margin:14px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef3f7;padding:12px}a{color:#0968a0}</style>
<h1>候选浏览器验收（尚未上线）</h1>
<p>先用真正独立的浏览器配置或获准的隐私窗口打开本页，不要使用现有玩家账号。普通新标签不等于独立上下文；功能被组织禁用时停止，不绕过。</p>
<p>下面按钮只执行当前候选 AccountManager 的内存夹具：网络响应、冲突、迟到响应和存储写失败均为注入。不会注册账号、请求真实账号 API、读取 Cookie 或写浏览器本地档；不等于实际断网或耗尽配额。</p>
<button id="run">运行五类注入检查</button><p id="status" role="status">尚未运行</p>
<p>以下三项必须另行真实操作，完成后才勾选。没有通过就保留未选；不能用注入结果替代。</p>
<label><input id="basic_ui" type="checkbox"> 我已打开<a href="./" target="_blank" rel="noopener">候选游戏</a>，实际确认游戏与账号界面可用、手机布局可操作。</label>
<label><input id="two_tabs" type="checkbox"> 我已在同一上下文打开两个候选游戏标签，确认第二页阻止并行写档；关闭占用页再重载可继续，原档未变。</label>
<label><input id="independent_context" type="checkbox"> 我另开了真正独立的 Cookie/Storage 上下文，确认没有继承第一上下文的本地进度与身份；未用普通新标签冒充。</label>
<p>只有八项全为 true 才可提交。复制下方 JSON 给既定的服务器 browser-record 命令；它只记录你的实际签收，不是服务端运行态证明。自动 HTTP 验收另有门禁。</p>
<pre id="output">尚无可提交结果</pre>
<script type="module" id="checks-module">
import * as candidate from './account-manager.js';
const INJECTIONS=Object.freeze(['guest_migration','identity_freeze','conflict_choices','late_response','storage_failure']);
const MANUAL=Object.freeze(['basic_ui','two_tabs','independent_context']);
const response=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value});
const assert=value=>{if(!value)throw Error('check_failed');};
const equal=(a,b)=>assert(JSON.stringify(a)===JSON.stringify(b));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const seed=wood=>({version:1,resources:{wood}});
const clone=value=>JSON.parse(JSON.stringify(value));
async function rejected(work,code){let error;try{await work;}catch(value){error=value;}assert(error&&(!code||error.code===code));}
function throws(work,code){let error;try{work();}catch(value){error=value;}assert(error&&error.code===code);}
function fixture(module,{logged=true,cloud=null,revision=0}={}){
  const {AccountManager,GUEST_SAVE_KEY,ACTIVE_ACCOUNT_KEY,accountSaveKey}=module;
  const prefix=GUEST_SAVE_KEY.slice(0,-'save-v1'.length), meta=id=>prefix+'account-meta-v1:'+id;
  const data=new Map(),calls=[],user={id:1,username:'fixture_a'};
  let account=logged?user:null,remote=clone(cloud),rev=revision,reloads=0;
  const storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};
  const fetcher=async(path,options)=>{
    calls.push({path,method:options.method});let value,status=200;const body=options.body&&JSON.parse(options.body);
    if(path.endsWith('/auth/me'))value={user:account,csrfToken:account?'fixture-csrf':undefined};
    else if(path.endsWith('/auth/register')||path.endsWith('/auth/login')){account=user;value={user,csrfToken:'fixture-csrf'};}
    else if(path.endsWith('/save')&&options.method==='PUT'){
      if(body.expectedRevision!==rev){status=409;value={code:'save_conflict'};}
      else{remote=clone(body.save);rev++;value={revision:rev,updatedAt:5000};}
    }else if(path.endsWith('/save'))value={revision:rev,save:remote,updatedAt:remote?5000:null};
    else throw Error('unexpected_fixture_route');
    return response(value,status);
  };
  const manager=new AccountManager({storage,fetcher,autoSync:false,reload:()=>reloads++,validate:save=>assert(save?.version===1&&typeof save.resources?.wood==='number')});
  return{manager,storage,data,calls,user,meta,GUEST_SAVE_KEY,ACTIVE_ACCOUNT_KEY,accountSaveKey,
    cache:()=>[storage.getItem(accountSaveKey(1)),storage.getItem(meta(1))],
    cloud:()=>clone(remote),reloads:()=>reloads};
}
export async function runInjected(module){
  const tests={
    guest_migration:async()=>{
      const t=fixture(module,{logged:false});await t.manager.prepare();const bound=t.manager.createStorage();
      bound.setItem('',JSON.stringify(seed(73)));await t.manager.register('fixture_a','fixture-only-password');
      assert(JSON.parse(t.storage.getItem(t.accountSaveKey(1))).resources.wood===73);
      assert(JSON.parse(t.storage.getItem(t.GUEST_SAVE_KEY)).resources.wood===73);
      throws(()=>bound.setItem('',JSON.stringify(seed(999))),'account_frozen');assert(t.reloads()===1);
    },
    identity_freeze:async()=>{
      const t=fixture(module);await t.manager.prepare();const bound=t.manager.createStorage();bound.setItem('',JSON.stringify(seed(31)));
      const before=t.cache();let calls=0;t.manager.fetcher=async()=>{calls++;return response({code:'user_mismatch'},403);};
      t.manager.needsRemote=true;await rejected(t.manager.syncNow(),'user_mismatch');
      assert(t.manager.canPlay===false&&t.manager.snapshot().identityFrozen===true);
      throws(()=>bound.setItem('',JSON.stringify(seed(999))),'account_frozen');equal(t.cache(),before);
      const previous=calls;await rejected(t.manager.syncNow());assert(calls===previous);
    },
    conflict_choices:async()=>{
      for(const choice of ['cloud','local']){
        const t=fixture(module,{cloud:seed(90),revision:3});
        t.storage.setItem(t.accountSaveKey(1),JSON.stringify(seed(31)));
        t.storage.setItem(t.meta(1),JSON.stringify({revision:2,dirty:true,serial:1}));
        await t.manager.prepare();assert(t.manager.phase==='conflict');
        let saves=0;t.manager.beforeTransition=()=>saves++;
        await t.manager.resolveConflict(choice);const expected=choice==='cloud'?90:31;
        assert(saves===0&&t.cloud().resources.wood===expected);
        assert(JSON.parse(t.storage.getItem(t.accountSaveKey(1))).resources.wood===expected);
        const prefix=t.GUEST_SAVE_KEY.slice(0,-'save-v1'.length);
        assert(JSON.parse(t.storage.getItem(prefix+'account-backup-v1:1')).save.resources.wood===31);
      }
    },
    late_response:async()=>{
      const t=fixture(module);await t.manager.prepare();const bound=t.manager.createStorage();bound.setItem('',JSON.stringify(seed(31)));
      const before=t.cache(),entered=deferred(),finished=deferred();
      t.manager.needsRemote=true;t.manager.fetcher=()=>{entered.resolve();return finished.promise;};
      const work=t.manager.syncNow();await entered.promise;t.manager.freezeIdentity();const phase=t.manager.phase;
      finished.resolve(response({revision:9,save:seed(999),updatedAt:9000}));await work;
      equal(t.cache(),before);assert(t.manager.phase===phase&&t.manager.canPlay===false&&t.manager.csrfToken===null);
    },
    storage_failure:async()=>{
      const t=fixture(module,{cloud:seed(10),revision:1});await t.manager.prepare();
      const bound=t.manager.createStorage(),before=t.cache(),set=t.storage.setItem;
      t.storage.setItem=(key,value)=>{if(key===t.ACTIVE_ACCOUNT_KEY)throw Object.assign(Error('fixture quota'),{name:'QuotaExceededError'});set(key,value);};
      t.manager.fetcher=async path=>response(path.endsWith('/auth/login')?{user:{id:2,username:'fixture_b'},csrfToken:'fixture-b'}:{revision:0,save:null,updatedAt:null});
      await rejected(t.manager.login('fixture_b','fixture-only-password'),'storage_unavailable');
      assert(t.manager.user.id===2&&t.manager.phase==='error'&&t.manager.canPlay===false&&t.reloads()===0);
      throws(()=>bound.setItem('',JSON.stringify(seed(999))),'account_frozen');equal(t.cache(),before);
    }
  };
  const results={};
  for(const name of INJECTIONS){let timer;try{await Promise.race([tests[name](),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),5000);})]);results[name]=true;}catch{results[name]=false;}finally{clearTimeout(timer);}}
  return results;
}
export function collectChecks(injected,manual,manifestSha256){
  assert(typeof manifestSha256==='string'&&/^[0-9a-f]{64}$/.test(manifestSha256));
  return{manifestSha256,checks:Object.fromEntries([...MANUAL,...INJECTIONS].map(name=>[name,(MANUAL.includes(name)?manual[name]:injected[name])===true])),injections:[...INJECTIONS]};
}
if(typeof document!=='undefined'){
  const manifestSha256=location.pathname.split('/')[3];
  let injected={};const run=document.getElementById('run'),status=document.getElementById('status'),output=document.getElementById('output');
  const update=()=>{const manual=Object.fromEntries(MANUAL.map(name=>[name,document.getElementById(name).checked]));output.textContent=JSON.stringify(collectChecks(injected,manual,manifestSha256),null,2);};
  for(const name of MANUAL)document.getElementById(name).addEventListener('change',update);
  run.addEventListener('click',async()=>{run.disabled=true;injected={};for(const name of MANUAL)document.getElementById(name).checked=false;status.textContent='正在执行内存注入检查…';update();
    injected=await runInjected(candidate);status.textContent=INJECTIONS.every(name=>injected[name])?'五类注入检查通过；仍需完成三项真实操作。':'存在失败：不得签收或上线。';run.disabled=false;update();});
  update();
}
</script></html>'''

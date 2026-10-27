import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { files, helpText, localReferences, prepareRelease, validateDependencyClosure, VERSION } from './package-static.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const entry = (path, data) => ({ path, data:Buffer.from(data) });

// Every assembly below uses deliberately fake TEST FIXTURE game and Three
// files under a disposable temporary tree. No actual project release is made.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fkssj-static-TEST-FIXTURE-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const sourceRoot = join(directory, 'TEST-FIXTURE-source'), output = join(directory, 'TEST-FIXTURE-output');
  await mkdir(sourceRoot);
  for (const path of files) {
    const target = join(sourceRoot, path);
    await mkdir(dirname(target), { recursive:true });
    const data = path.endsWith('.js') ? '// TEST FIXTURE ONLY: not game or Three code.\n' : 'TEST FIXTURE ONLY\n';
    await writeFile(target, data);
  }
  await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ version:VERSION, dependencies:{ three:'0.180.0' } }));
  await writeFile(join(sourceRoot, 'node_modules/three/package.json'), JSON.stringify({ version:'0.180.0', description:'TEST FIXTURE ONLY; not Three.js' }));
  await writeFile(join(sourceRoot, 'index.html'), '<!-- TEST FIXTURE ONLY --><link rel="stylesheet" href="./account-ui.css"><script type="module" src="./bootstrap.js"></script>');
  await writeFile(join(sourceRoot, 'bootstrap.js'), "// TEST FIXTURE ONLY\nimport('./app.js');\n");
  await writeFile(join(sourceRoot, 'app.js'), "// TEST FIXTURE ONLY\nimport './account-manager.js';\nimport './account-ui.js';\nimport './page-lock.js';\nimport './storm-view.js';\nimport './node_modules/three/build/three.module.js';\n");
  await writeFile(join(sourceRoot, 'node_modules/three/build/three.module.js'), "// TEST FIXTURE ONLY; not Three.js\nexport * from './three.core.js';\n");
  return { sourceRoot, output };
}

test('allowlist covers current client modules, HTML styles, account files and the storm view', async () => {
  const clientFiles = (await readdir(projectRoot)).filter(path => /\.(?:js|css|html)$/.test(path));
  for (const path of clientFiles) assert.ok(files.includes(path), `Client file missing from explicit allowlist: ${path}`);
  for (const path of ['account-manager.js', 'account-ui.js', 'account-ui.css', 'page-lock.js', 'storm-view.js']) assert.ok(files.includes(path));
  const entries = await Promise.all(clientFiles.map(async path => ({ path, data:await readFile(join(projectRoot, path)) })));
  // This verifies the supported static forms in current project references
  // against the allowlist, not arbitrary runtime/template interpolation. Absent
  // installed Three bytes are not fabricated or treated as validated.
  validateDependencyClosure(entries, files);
  assert.ok(localReferences('battle-view.js', (await readFile(join(projectRoot, 'battle-view.js'))).toString()).includes('battle-view.css'));
  const metadata = JSON.parse(await readFile(join(projectRoot, 'package.json')));
  const lock = JSON.parse(await readFile(join(projectRoot, 'package-lock.json')));
  assert.equal(metadata.version, VERSION);
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages[''].version, VERSION);
  assert.ok(helpText().includes(`${files.length} 个静态白名单文件`));
});

test('static reference checking handles module syntax, new URL, CSS imports and URLs', () => {
  const code = `
    // import './comment.js';
    const text = "import('./ordinary-string.js')";
    const pattern = /['"]/;
    import {
      named
    } from './module.js';
    import './side-effect.js';
    export * from './exports.js';
    import('./lazy.js');
    new URL('./overlay.css', import.meta.url);
  `;
  assert.deepEqual(localReferences('ui/main.js', code).sort(), ['ui/module.js', 'ui/side-effect.js', 'ui/exports.js', 'ui/lazy.js', 'ui/overlay.css'].sort());
  assert.deepEqual(localReferences('ui/style.css', '@import "./extra.css"; .x { background:url(../assets/icon.svg?rev=2); mask:url("data:image/svg+xml,fixture"); }').sort(), ['ui/extra.css', 'assets/icon.svg'].sort());
  assert.throws(() => localReferences('main.js', "import('./' + name)"), /无法静态校验动态模块引用/);
  assert.throws(() => localReferences('main.js', "import 'unmapped-bare-module'"), /裸模块引用/);
  assert.throws(() => localReferences('main.js', "import '../outside.js'"), /超出发布根目录/);
});

test('dependency closure rejects omitted JavaScript, CSS and CSS asset dependencies', () => {
  assert.throws(() => validateDependencyClosure([entry('app.js', "import './account-manager.js';")]), /account-manager\.js/);
  assert.throws(() => validateDependencyClosure([entry('index.html', '<link rel="stylesheet" href="./account-ui.css">')]), /account-ui\.css/);
  assert.throws(() => validateDependencyClosure([entry('style.css', 'body { background:url(./assets/missing.svg); }')]), /missing\.svg/);
  assert.doesNotThrow(() => validateDependencyClosure([
    entry('app.js', "import './feature.js'; new URL('./feature.css', import.meta.url);"),
    entry('feature.js', 'export const testFixture = true;'),
    entry('feature.css', '/* TEST FIXTURE ONLY */')
  ]));
});

test('TEST FIXTURE assembly hashes exact allowlisted bytes and excludes unrelated files', async t => {
  const { sourceRoot, output } = await fixture(t);
  await writeFile(join(sourceRoot, '.env'), 'TEST FIXTURE ONLY: should not be copied');
  await writeFile(join(sourceRoot, 'private-save.json'), 'TEST FIXTURE ONLY: should not be copied');
  const result = await prepareRelease(output, { sourceRoot });
  const manifest = JSON.parse(await readFile(join(output, 'release.json')));
  assert.equal(result.version, VERSION);
  assert.equal(manifest.fileCount, files.length);
  assert.deepEqual(manifest.files.map(item => item.path).sort(), [...files].sort());
  let total = 0;
  for (const item of manifest.files) {
    const expected = await readFile(join(sourceRoot, item.path)), actual = await readFile(join(output, item.path));
    assert.deepEqual(actual, expected);
    assert.equal(item.bytes, actual.length);
    assert.equal(item.sha256, createHash('sha256').update(actual).digest('hex'));
    total += actual.length;
  }
  assert.equal(manifest.totalBytes, total);
  await assert.rejects(lstat(join(output, '.env')), { code:'ENOENT' });
  await assert.rejects(lstat(join(output, 'private-save.json')), { code:'ENOENT' });
});

test('missing Three TEST FIXTURE fails before creating any output directory', async t => {
  const { sourceRoot, output } = await fixture(t);
  await rm(join(sourceRoot, 'node_modules/three'), { recursive:true });
  await assert.rejects(prepareRelease(output, { sourceRoot }), { code:'ENOENT' });
  await assert.rejects(lstat(output), { code:'ENOENT' });
});

test('incomplete Three TEST FIXTURE and an omitted local dependency leave no partial output', async t => {
  const incomplete = await fixture(t);
  await rm(join(incomplete.sourceRoot, 'node_modules/three/build/three.core.js'));
  await assert.rejects(prepareRelease(incomplete.output, { sourceRoot:incomplete.sourceRoot }), { code:'ENOENT' });
  await assert.rejects(lstat(incomplete.output), { code:'ENOENT' });
  const missingDependency = await fixture(t);
  await writeFile(join(missingDependency.sourceRoot, 'storm-view.js'), "// TEST FIXTURE ONLY\nimport './unlisted-storm-helper.js';\n");
  await assert.rejects(prepareRelease(missingDependency.output, { sourceRoot:missingDependency.sourceRoot }), /unlisted-storm-helper/);
  await assert.rejects(lstat(missingDependency.output), { code:'ENOENT' });
});

test('TEST FIXTURE version mismatch and existing outputs fail without replacing data', async t => {
  const mismatched = await fixture(t);
  await writeFile(join(mismatched.sourceRoot, 'package.json'), JSON.stringify({ version:'0.13.0', dependencies:{ three:'0.180.0' } }));
  await assert.rejects(prepareRelease(mismatched.output, { sourceRoot:mismatched.sourceRoot }), /版本与 package\.json 不一致/);
  await assert.rejects(lstat(mismatched.output), { code:'ENOENT' });
  const existing = await fixture(t);
  await mkdir(existing.output);
  await writeFile(join(existing.output, 'keep.txt'), 'TEST FIXTURE existing data');
  await assert.rejects(prepareRelease(existing.output, { sourceRoot:existing.sourceRoot }), /输出目录已经存在/);
  assert.equal(await readFile(join(existing.output, 'keep.txt'), 'utf8'), 'TEST FIXTURE existing data');
});

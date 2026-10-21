#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.13.0';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const files = Object.freeze([
  'index.html',
  'bootstrap.js',
  'app.js',
  'scene.js',
  'game-state.js',
  'progress-state.js',
  'progress-ui.js',
  'progress-ui.css',
  'battle-view.js',
  'campaign-view.js',
  'scavenging-state.js',
  'scavenging-view.js',
  'scavenging-ui.js',
  'scavenging-ui.css',
  'production-state.js',
  'production-ui.js',
  'production-ui.css',
  'story-state.js',
  'diving-state.js',
  'diving-view.js',
  'diving-ui.js',
  'diving-ui.css',
  'battle-view.css',
  'icons.js',
  'style.css',
  'assets/favicon.svg',
  'node_modules/three/build/three.module.js',
  'node_modules/three/build/three.core.js',
  'node_modules/three/LICENSE',
]);

function parseArguments(args) {
  let output;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    let value;
    if (arg === '--output' || arg === '-o') {
      value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--output 后需要一个尚不存在的输出目录。');
    } else if (arg.startsWith('--output=')) {
      value = arg.slice('--output='.length);
      if (!value) throw new Error('--output 后需要一个尚不存在的输出目录。');
    } else if (arg.startsWith('-')) {
      throw new Error(`不支持的参数：${arg}`);
    } else {
      value = arg;
    }
    if (output !== undefined) throw new Error('只能指定一个输出目录。');
    output = value;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return { outputDirectory: resolve(output || `/tmp/fkssj-release-${timestamp}`) };
}

async function prepareRelease(outputDirectory) {
  try {
    await lstat(outputDirectory);
    throw new Error(`输出目录已经存在，未写入任何内容：${outputDirectory}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // Read only the explicit allowlist. Hash the exact bytes that will be written.
  const entries = await Promise.all(files.map(async (path) => {
    const source = join(projectRoot, path);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`发布源文件必须是普通文件：${path}`);
    const data = await readFile(source);
    return { path, data, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') };
  }));

  const manifest = {
    version: VERSION,
    createdAt: new Date().toISOString(),
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    files: entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  };

  // Non-recursive creation refuses existing outputs, including racing writers.
  await mkdir(outputDirectory, { mode: 0o755 });
  try {
    for (const { path, data } of entries) {
      const target = join(outputDirectory, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, data, { flag: 'wx', mode: 0o644 });
    }
    await writeFile(join(outputDirectory, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    // This directory was created by this run; never remove a pre-existing path.
    try { await rm(outputDirectory, { recursive: true, force: true }); } catch { /* Preserve the original failure. */ }
    throw error;
  }

  return { outputDirectory, version: VERSION, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, manifest: join(outputDirectory, 'release.json') };
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('用法：node deploy/package-static.mjs [输出目录]\n      node deploy/package-static.mjs --output <输出目录>\n默认：/tmp/fkssj-release-<timestamp>\n输出目录必须不存在，且其父目录必须已存在。仅复制 29 个静态白名单文件并生成 release.json，不构建、不归档、不部署。\nrelease.json 的 totalBytes 是 29 个发布文件之和，不含清单自身。');
  } else {
    console.log(JSON.stringify(await prepareRelease(options.outputDirectory), null, 2));
  }
} catch (error) {
  console.error(`静态发布目录准备失败：${error.message}`);
  process.exitCode = 1;
}

#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.14.0';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const files = Object.freeze([
  'index.html',
  'bootstrap.js',
  'app.js',
  'account-manager.js',
  'account-ui.js',
  'account-ui.css',
  'page-lock.js',
  'storm-view.js',
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

// A limited check of this project's static string references, not a complete
// JavaScript parser/evaluator. Comments, ordinary strings and template bodies
// are not treated as imports; runtime/template interpolation is not evaluated.
// Recognized computed import forms fail rather than silently guessing a path.
function jsTokens(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const char = source[index], next = source[index + 1];
    if (/\s/.test(char)) { index++; continue; }
    if (char === '/' && next === '/') {
      index = source.indexOf('\n', index + 2);
      if (index < 0) break;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new Error('JavaScript 注释没有结束。');
      index = end + 2; continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const start = ++index;
      while (index < source.length && source[index] !== char) index += source[index] === '\\' ? 2 : 1;
      if (index >= source.length) throw new Error('JavaScript 字符串没有结束。');
      tokens.push({ kind:char === '`' ? 'template' : 'string', value:source.slice(start, index++) });
      continue;
    }
    const previous = tokens.at(-1);
    if (char === '/' && (!previous || /^(?:[([{=,:;!?]|return|throw|case|yield)$/.test(previous.value))) {
      // Skip a regular-expression literal, including quoted characters in it.
      index++; let bracket = false;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index] === '[') bracket = true;
        else if (source[index] === ']') bracket = false;
        else if (source[index] === '/' && !bracket) { index++; break; }
        index++;
      }
      while (/[a-z]/i.test(source[index] || '') && index < source.length) index++;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(index));
    if (word) { tokens.push({ kind:'word', value:word[0] }); index += word[0].length; }
    else { tokens.push({ kind:'punctuation', value:char }); index++; }
  }
  return tokens;
}

export function localReferences(path, source) {
  const references = [];
  const add = (reference, module = false) => {
    if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) return;
    if (reference.includes('\\')) throw new Error(`无法静态校验转义资源路径：${path} -> ${reference}`);
    if (module && !reference.startsWith('.') && !reference.startsWith('/')) {
      throw new Error(`无法静态校验裸模块引用：${path} -> ${reference}`);
    }
    let resource;
    try { resource = decodeURIComponent(reference.split(/[?#]/, 1)[0]); }
    catch { throw new Error(`资源路径编码无效：${path} -> ${reference}`); }
    if (!resource) return;
    const target = posix.normalize(resource.startsWith('/') ? resource.slice(1) : posix.join(posix.dirname(path), resource));
    if (target === '..' || target.startsWith('../')) throw new Error(`资源引用超出发布根目录：${path} -> ${reference}`);
    references.push(target);
  };
  if (/\.(?:m?js)$/.test(path)) {
    const tokens = jsTokens(source);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index], next = tokens[index + 1];
      if (token.kind !== 'word') continue;
      if (token.value === 'import' && tokens[index - 1]?.value !== '.') {
        if (next?.kind === 'string') add(next.value, true);
        else if (next?.value === '(') {
          const value = tokens[index + 2], end = tokens[index + 3];
          if (value?.kind !== 'string' || ![')', ','].includes(end?.value)) throw new Error(`无法静态校验动态模块引用：${path}`);
          add(value.value, true);
        }
      }
      if ((token.value === 'import' && next?.value !== '(' && next?.value !== '.') || (token.value === 'export' && ['{', '*'].includes(next?.value))) {
        for (let cursor = index + 1; cursor < tokens.length && tokens[cursor].value !== ';'; cursor++) {
          if (tokens[cursor].value === 'from' && tokens[cursor + 1]?.kind === 'string') { add(tokens[cursor + 1].value, true); break; }
        }
      }
      if (token.value === 'new' && next?.value === 'URL' && tokens[index + 2]?.value === '(') {
        const value = tokens[index + 3];
        const tail = tokens.slice(index + 4, index + 11).map(item => item.value).join('');
        if (tail === ',import.meta.url)') {
          if (value?.kind !== 'string') throw new Error(`无法静态校验 URL 资源引用：${path}`);
          add(value.value);
        }
      }
    }
  } else if (path.endsWith('.css')) {
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi)) add((match[2] ?? match[3]).trim());
    for (const match of css.matchAll(/@import\s+(["'])(.*?)\1/gi)) add(match[2]);
  } else if (path.endsWith('.html')) {
    const html = source.replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of html.matchAll(/<(?:script|link|img|source|audio|video)\b[^>]*>/gi)) {
      for (const match of tag[0].matchAll(/\b(?:src|href|poster)\s*=\s*(["'])(.*?)\1/gi)) add(match[2]);
    }
  }
  return [...new Set(references)];
}

export function validateDependencyClosure(entries, allowedPaths = entries.map(entry => entry.path)) {
  const allowed = new Set(allowedPaths);
  for (const { path, data } of entries) {
    for (const dependency of localReferences(path, data.toString('utf8'))) {
      if (!allowed.has(dependency)) throw new Error(`静态白名单缺少依赖：${path} -> ${dependency}`);
    }
  }
}

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

export async function prepareRelease(outputDirectory, { sourceRoot = projectRoot } = {}) {
  try {
    await lstat(outputDirectory);
    throw new Error(`输出目录已经存在，未写入任何内容：${outputDirectory}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const metadata = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  if (metadata.version !== VERSION) throw new Error(`发布版本与 package.json 不一致：${VERSION} / ${metadata.version}`);
  const three = JSON.parse(await readFile(join(sourceRoot, 'node_modules/three/package.json'), 'utf8'));
  if (three.version !== metadata.dependencies?.three) throw new Error('Three.js 本地版本与 package.json 固定依赖不一致。');

  // Read only the explicit allowlist. Hash the exact bytes that will be written.
  const entries = await Promise.all(files.map(async (path) => {
    const source = join(sourceRoot, path);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`发布源文件必须是普通文件：${path}`);
    const data = await readFile(source);
    return { path, data, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') };
  }));
  validateDependencyClosure(entries);

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

export const helpText = () => `用法：node deploy/package-static.mjs [输出目录]\n      node deploy/package-static.mjs --output <输出目录>\n默认：/tmp/fkssj-release-<timestamp>\n输出目录必须不存在，且其父目录必须已存在。仅复制 ${files.length} 个静态白名单文件并生成 release.json，不构建、不归档、不部署。\nrelease.json 的 totalBytes 是白名单发布文件之和，不含清单自身。`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
  } else {
    console.log(JSON.stringify(await prepareRelease(options.outputDirectory), null, 2));
  }
} catch (error) {
  console.error(`静态发布目录准备失败：${error.message}`);
  process.exitCode = 1;
}

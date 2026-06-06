#!/usr/bin/env node
/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */

const fs = require('fs');
const path = require('path');

const NOTICE = '此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码';
const NOTICE_MARKER = '此代码为刻度航宇编写';
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(process.env.PROTECTED_OUT || path.join(ROOT, 'protected', 'OZON_HD'));
const args = new Set(process.argv.slice(2));
const stampSource = !args.has('--no-stamp-source');
const buildRelease = !args.has('--stamp-only');

let JavaScriptObfuscator = null;
if (buildRelease) {
  try {
    JavaScriptObfuscator = require('javascript-obfuscator');
  } catch (error) {
    console.error('Missing dependency: javascript-obfuscator. Run npm install first.');
    process.exit(1);
  }
}

const TEXT_CODE_EXTENSIONS = new Set([
  '.js',
  '.html',
  '.ps1',
  '.yml',
  '.yaml',
  '.conf',
]);

const COPY_EXCLUDE_ROOTS = new Set([
  '.git',
  'node_modules',
  'protected',
  'cache',
  'output',
  'images',
  'screenshots',
]);

const COPY_EXCLUDE_PATHS = new Set([
  'server/cache',
  'server/data',
  'server/images',
]);

const COPY_EXCLUDE_FILES = new Set([
  'server/server.log',
  'server/server.err.log',
]);

function toRel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function shouldSkip(relPath) {
  if (!relPath) return false;
  const parts = relPath.split('/');
  const fileName = parts[parts.length - 1];
  if (parts.includes('.git') || parts.includes('node_modules') || parts.includes('protected')) {
    return true;
  }
  if (fileName === '.env' || fileName.startsWith('.env.')) return true;
  if (fileName === 'ozon.txt') return true;
  if (fileName.startsWith('ozon-product-') && fileName.endsWith('.json')) return true;
  if (COPY_EXCLUDE_ROOTS.has(parts[0])) return true;
  if (COPY_EXCLUDE_PATHS.has(relPath)) return true;
  if ([...COPY_EXCLUDE_PATHS].some((skip) => relPath.startsWith(`${skip}/`))) return true;
  if (COPY_EXCLUDE_FILES.has(relPath)) return true;
  if (relPath.endsWith('.log')) return true;
  return false;
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relPath = toRel(fullPath);
    if (shouldSkip(relPath)) continue;

    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function isDockerfile(filePath) {
  return path.basename(filePath).toLowerCase() === 'dockerfile';
}

function isTextCodeFile(filePath) {
  return TEXT_CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || isDockerfile(filePath);
}

function noticeBlock(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return `<!-- ${NOTICE} -->`;
  if (ext === '.js') return `/*\n * ${NOTICE}\n */`;
  return `# ${NOTICE}`;
}

function addNotice(content, filePath) {
  if (content.includes(NOTICE_MARKER)) return content;

  const block = noticeBlock(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.js' && content.startsWith('#!')) {
    const newline = content.indexOf('\n');
    if (newline !== -1) {
      return `${content.slice(0, newline + 1)}${block}\n${content.slice(newline + 1)}`;
    }
  }

  if (ext === '.html') {
    const doctypeMatch = content.match(/^<!doctype[^>]*>\s*/i);
    if (doctypeMatch) {
      return `${doctypeMatch[0]}${block}\n${content.slice(doctypeMatch[0].length)}`;
    }
  }

  return `${block}\n${content}`;
}

function stampFiles(files) {
  let stamped = 0;
  for (const filePath of files) {
    if (!isTextCodeFile(filePath)) continue;
    const original = fs.readFileSync(filePath, 'utf8');
    const next = addNotice(original, filePath);
    if (next !== original) {
      fs.writeFileSync(filePath, next, 'utf8');
      stamped += 1;
    }
  }
  return stamped;
}

function ensureSafeOutputPath() {
  const protectedRoot = path.join(ROOT, 'protected');
  const rel = path.relative(protectedRoot, OUT_DIR);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside ${protectedRoot}: ${OUT_DIR}`);
  }
}

function obfuscatorOptions(relPath) {
  const isBrowserFile = relPath.startsWith('extension/') || relPath.startsWith('website/');
  return {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.3,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.08,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    ignoreImports: true,
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.5,
    stringArrayEncoding: [],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.75,
    target: isBrowserFile ? 'browser' : 'node',
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
  };
}

function normalizeInvalidSurrogates(content) {
  let result = '';
  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = content.charCodeAt(i + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        result += content[i] + content[i + 1];
        i += 1;
      } else {
        result += '?';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += '?';
    } else {
      result += content[i];
    }
  }
  return result;
}

function protectJs(content, relPath) {
  let shebang = '';
  let body = content;
  if (body.startsWith('#!')) {
    const newline = body.indexOf('\n');
    if (newline !== -1) {
      shebang = body.slice(0, newline + 1);
      body = body.slice(newline + 1);
    }
  }

  let obfuscated;
  try {
    obfuscated = JavaScriptObfuscator
      .obfuscate(normalizeInvalidSurrogates(body), obfuscatorOptions(relPath))
      .getObfuscatedCode();
  } catch (error) {
    throw new Error(`Failed to obfuscate ${relPath}: ${error.message}`);
  }

  return `${shebang}${noticeBlock(relPath)}\n${obfuscated}\n`;
}

function buildProtectedCopy(files) {
  ensureSafeOutputPath();
  fs.rmSync(OUT_DIR, { recursive: true, force: true });

  let copied = 0;
  let obfuscated = 0;
  for (const sourcePath of files) {
    const relPath = toRel(sourcePath);
    const targetPath = path.join(OUT_DIR, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    if (path.extname(sourcePath).toLowerCase() === '.js') {
      const content = fs.readFileSync(sourcePath, 'utf8');
      fs.writeFileSync(targetPath, protectJs(content, relPath), 'utf8');
      obfuscated += 1;
    } else if (isTextCodeFile(sourcePath)) {
      const content = fs.readFileSync(sourcePath, 'utf8');
      fs.writeFileSync(targetPath, addNotice(content, sourcePath), 'utf8');
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
    copied += 1;
  }

  return { copied, obfuscated };
}

function main() {
  const files = walk(ROOT);
  const stamped = stampSource ? stampFiles(files) : 0;
  let release = null;

  if (buildRelease) {
    release = buildProtectedCopy(files);
  }

  console.log(JSON.stringify({
    sourceFilesScanned: files.length,
    sourceFilesStamped: stamped,
    outputDir: buildRelease ? OUT_DIR : null,
    releaseFilesCopied: release ? release.copied : 0,
    releaseJsObfuscated: release ? release.obfuscated : 0,
  }, null, 2));
}

main();

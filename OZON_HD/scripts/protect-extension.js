#!/usr/bin/env node
/*
 * 此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码
 */

const fs = require('fs');
const path = require('path');

let JavaScriptObfuscator = null;
try {
  JavaScriptObfuscator = require('javascript-obfuscator');
} catch (_error) {
  console.error('Missing dependency: javascript-obfuscator. Run npm install first.');
  process.exit(1);
}

const NOTICE = '此代码为刻度航宇编写，复制与逆向属于违法行为。不允许解析我的代码';
const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'extension');
const OUT_DIR = path.resolve(
  process.env.PROTECTED_EXTENSION_OUT || path.join(ROOT, 'protected', 'extension')
);

function ensureSafeOutputPath() {
  const protectedRoot = path.join(ROOT, 'protected');
  const rel = path.relative(protectedRoot, OUT_DIR);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside ${protectedRoot}: ${OUT_DIR}`);
  }
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function toRel(filePath) {
  return path.relative(SOURCE_DIR, filePath).replace(/\\/g, '/');
}

function noticeBlock(filePath) {
  return path.extname(filePath).toLowerCase() === '.html'
    ? `<!-- ${NOTICE} -->`
    : `/*\n * ${NOTICE}\n */`;
}

function addNotice(content, filePath) {
  if (content.includes('此代码为刻度航宇编写')) return content;

  if (path.extname(filePath).toLowerCase() === '.html') {
    const doctypeMatch = content.match(/^<!doctype[^>]*>\s*/i);
    if (doctypeMatch) {
      return `${doctypeMatch[0]}${noticeBlock(filePath)}\n${content.slice(doctypeMatch[0].length)}`;
    }
  }

  return `${noticeBlock(filePath)}\n${content}`;
}

function obfuscatorOptions() {
  return {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.55,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.12,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    ignoreImports: true,
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 6,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.65,
    stringArrayEncoding: ['rc4'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 1,
    target: 'browser',
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
  };
}

function protectJs(content, relPath) {
  try {
    const obfuscated = JavaScriptObfuscator
      .obfuscate(content, obfuscatorOptions())
      .getObfuscatedCode();
    return `${noticeBlock(relPath)}\n${obfuscated}\n`;
  } catch (error) {
    throw new Error(`Failed to protect ${relPath}: ${error.message}`);
  }
}

function buildProtectedExtension() {
  ensureSafeOutputPath();
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = walk(SOURCE_DIR);
  let copied = 0;
  let protectedJs = 0;

  for (const sourcePath of files) {
    const relPath = toRel(sourcePath);
    const targetPath = path.join(OUT_DIR, relPath);
    const ext = path.extname(sourcePath).toLowerCase();
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    if (ext === '.js') {
      const content = fs.readFileSync(sourcePath, 'utf8');
      fs.writeFileSync(targetPath, protectJs(content, relPath), 'utf8');
      protectedJs += 1;
    } else if (ext === '.html') {
      const content = fs.readFileSync(sourcePath, 'utf8');
      fs.writeFileSync(targetPath, addNotice(content, sourcePath), 'utf8');
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }

    copied += 1;
  }

  return { files: copied, jsProtected: protectedJs };
}

const result = buildProtectedExtension();
console.log(JSON.stringify({
  sourceDir: SOURCE_DIR,
  outputDir: OUT_DIR,
  filesCopied: result.files,
  jsProtected: result.jsProtected,
}, null, 2));

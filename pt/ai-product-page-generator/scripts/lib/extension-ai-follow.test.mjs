import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(
  currentDirectory,
  "../../lib/listing-workflow/extension-ai-follow-images.ts",
);
const source = await fs.readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const module = { exports: {} };
new Function("module", "exports", compiled)(module, module.exports);

const {
  EXTENSION_AI_FOLLOW_SOURCE_IMAGE_LIMIT,
  extensionAiFollowSourceImages,
  mergeGeneratedWithOriginalAuxiliary,
} = module.exports;

test("Ozon 图片按主图、商品附图、详情图顺序去重", () => {
  const images = extensionAiFollowSourceImages({
    imageUrl: "https://cdn.example/main.jpg",
    gallery: {
      coverImage: "https://cdn.example/main.jpg",
      images: [
        { src: "https://cdn.example/aux-1.jpg" },
        { src: "//cdn.example/aux-2.jpg" },
      ],
    },
    images: ["https://cdn.example/aux-1.jpg", "https://cdn.example/aux-3.jpg"],
    description: {
      images: [{ url: "https://cdn.example/detail-1.jpg" }],
    },
  });

  assert.deepEqual(images, [
    "https://cdn.example/main.jpg",
    "https://cdn.example/aux-1.jpg",
    "https://cdn.example/aux-2.jpg",
    "https://cdn.example/aux-3.jpg",
    "https://cdn.example/detail-1.jpg",
  ]);
});

test("源图片数量为四张生成图预留最终图集空间", () => {
  const images = extensionAiFollowSourceImages({
    gallery: {
      images: Array.from({ length: 50 }, (_, index) => ({
        src: `https://cdn.example/source-${index}.jpg`,
      })),
    },
  });
  assert.equal(images.length, EXTENSION_AI_FOLLOW_SOURCE_IMAGE_LIMIT);
  assert.equal(EXTENSION_AI_FOLLOW_SOURCE_IMAGE_LIMIT, 27);
});

test("最终图集用生成主图替换原主图并保留三张生成附图和原附图", () => {
  const generated = ["AI-main", "AI-aux-1", "AI-aux-2", "AI-aux-3"];
  const originals = ["original-main", "original-aux-1", "original-aux-2"];
  const merged = mergeGeneratedWithOriginalAuxiliary(generated, originals);

  assert.deepEqual(merged, [
    "AI-main",
    "AI-aux-1",
    "AI-aux-2",
    "AI-aux-3",
    "original-aux-1",
    "original-aux-2",
  ]);
  assert.equal(merged.includes("original-main"), false);
});

test("最终图集遵守 30 张上货图片上限", () => {
  const generated = ["AI-main", "AI-aux-1", "AI-aux-2", "AI-aux-3"];
  const originals = Array.from({ length: 27 }, (_, index) => `original-${index}`);
  const merged = mergeGeneratedWithOriginalAuxiliary(generated, originals);
  assert.equal(merged.length, 30);
  assert.deepEqual(merged.slice(0, 4), generated);
  assert.equal(merged[4], "original-1");
});

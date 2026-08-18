import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = await fs.readFile(
  path.resolve(
    currentDirectory,
    "../../lib/listing-workflow/collected-product-title.ts",
  ),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const module = { exports: {} };
new Function("module", "exports", compiled)(module, module.exports);

const { resolveCollectedProductTitle } = module.exports;

test("卖家名被详情标题误摘时使用变体基础标题", () => {
  const title = resolveCollectedProductTitle({
    cardTitle: "深圳市蓝琴电子商务有限公司",
    detailTitle: "深圳市蓝琴电子商务有限公司",
    sellerName: "深圳市蓝琴电子商务有限公司",
    variants: [
      {
        title:
          "一亿像素双摄ccd数码照相机校园学生入门可上传复古便携式卡片机 P1银色官方标配",
        specText: "P1银色官方标配",
      },
    ],
    fallback: "1688 商品 954548909140",
  });

  assert.equal(
    title,
    "一亿像素双摄ccd数码照相机校园学生入门可上传复古便携式卡片机",
  );
});

test("有效商品卡片标题优先于变体和详情标题", () => {
  assert.equal(
    resolveCollectedProductTitle({
      cardTitle: "商品卡片标题",
      detailTitle: "详情标题",
      variants: [{ title: "变体基础标题 红色", specText: "红色" }],
      fallback: "默认标题",
    }),
    "商品卡片标题",
  );
});

/**
 * 语言探测 + 文案占位符测试（不依赖 Obsidian 运行时）。
 * 运行：node test/i18n.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadWithLanguage(value) {
  // 每次重新 require，绕过缓存，模拟不同界面语言
  delete require.cache[require.resolve("./i18n.cjs")];
  globalThis.window = {
    localStorage: {
      getItem: () => value,
    },
  };
  return require("./i18n.cjs");
}

// 1) 英文环境
const en = loadWithLanguage("en");
assert.equal(en.lang(), "en");
assert.equal(en.t("menu.mountFolder"), "Mount as virtual folder…");
assert.equal(en.t("err.sourceMissing", { path: "A/B" }), "Source not found: A/B");
assert.equal(en.t("notice.mounted", { target: "Inbox" }), "Mounted to Inbox");
assert.equal(en.t("more.items", { count: 5 }), "… 5 more not shown (click to open the real folder)");
assert.equal(en.t("label.root"), "vault root");

// 2) 中文环境（含 zh-CN / zh-TW）
for (const code of ["zh", "zh-CN", "zh-TW"]) {
  const zh = loadWithLanguage(code);
  assert.equal(zh.lang(), "zh", `${code} 应识别为中文`);
  assert.equal(zh.t("menu.mountFolder"), "虚拟挂载到…");
  assert.equal(zh.t("err.underNotFolder", { path: "X" }), "挂载点不是文件夹：X");
  assert.equal(zh.t("notice.mounted", { target: "01-进行中" }), "已挂载到 01-进行中");
  assert.equal(zh.t("label.root"), "仓库根目录");
}

// 3) 其他语言回落到英文
const fr = loadWithLanguage("fr");
assert.equal(fr.lang(), "en");
assert.equal(fr.t("btn.cancel"), "Cancel");

// 4) localStorage 不可用时不能抛错
delete require.cache[require.resolve("./i18n.cjs")];
globalThis.window = {
  localStorage: {
    getItem() {
      throw new Error("blocked");
    },
  },
};
Object.defineProperty(globalThis, "navigator", {
  value: { language: "zh-CN" },
  configurable: true,
});
const fallback = require("./i18n.cjs");
assert.equal(fallback.lang(), "zh");

console.log("\n✅ i18n 用例全部通过");

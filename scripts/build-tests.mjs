// 把测试需要的模块打成 CJS（tests 用 require 加载，并 stub 掉 obsidian 模块）
import esbuild from "esbuild";

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  logLevel: "warning",
};

esbuild.buildSync({
  ...common,
  entryPoints: ["src/tree.ts"],
  external: ["obsidian"],
  outfile: "test/tree.cjs",
});

esbuild.buildSync({
  ...common,
  entryPoints: ["src/i18n.ts"],
  outfile: "test/i18n.cjs",
});

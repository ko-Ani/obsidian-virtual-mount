/**
 * 挂载索引 / 路径找回用例。
 *
 * 覆盖「插件没运行时文件夹被改名或搬走」的场景：rename 事件收不到，只能靠索引里
 * 的内容指纹把挂载重新绑到新路径上。
 *
 * 运行：node test/recover.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/* ------------------------------------------------------------ obsidian 桩 */

class TAbstractFile {
  constructor(path) {
    this.path = path;
    this.name = path.slice(path.lastIndexOf("/") + 1) || path;
  }
}
class TFile extends TAbstractFile {
  constructor(path) {
    super(path);
    const dot = this.name.lastIndexOf(".");
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
  }
}
class TFolder extends TAbstractFile {
  constructor(path) {
    super(path);
    this.children = [];
  }
}

const obsidianStub = {
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath: (p) => p,
};

const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};

const indexMod = require("./mount-index.cjs");

/* ------------------------------------------------------------------ 假仓库 */

function makeVault() {
  const all = [];
  const root = new TFolder("/");
  root.children = [];

  const parentOf = (path) => {
    const at = path.lastIndexOf("/");
    if (at <= 0) return root;
    return all.find((f) => f.path === path.slice(0, at)) ?? root;
  };

  const addFolder = (path) => {
    const folder = new TFolder(path);
    all.push(folder);
    parentOf(path).children.push(folder);
    return folder;
  };
  const addFile = (path) => {
    const file = new TFile(path);
    all.push(file);
    parentOf(path).children.push(file);
    return file;
  };

  const adapterFiles = new Map();
  const adapter = {
    files: adapterFiles,
    async exists(path) {
      return adapterFiles.has(path);
    },
    async read(path) {
      if (!adapterFiles.has(path)) throw new Error("ENOENT");
      return adapterFiles.get(path);
    },
    async write(path, data) {
      adapterFiles.set(path, data);
    },
    async mkdir() {},
  };

  const app = {
    vault: {
      adapter,
      getRoot: () => root,
      getAbstractFileByPath: (path) =>
        path === "/" ? root : all.find((f) => f.path === path) ?? null,
      getAllLoadedFiles: () => [root, ...all],
    },
  };

  return { app, root, all, addFolder, addFile, adapterFiles, adapter };
}

const snapshotOf = (overrides) => ({
  id: "m",
  kind: "folder",
  source: "",
  under: "",
  name: "",
  nameMode: "auto",
  enabled: true,
  collapsed: true,
  sourceSignature: "",
  underSignature: "",
  ...overrides,
});

/* -------------------------------------------------------------- 路径找回 */

// 1) 文件夹被改名（路径变了、内容没变）：按指纹找回
{
  const vault = makeVault();
  vault.addFolder("03-资料");
  const folder = vault.addFolder("03-资料/项目A");
  vault.addFile("03-资料/项目A/alpha.md");
  vault.addFile("03-资料/项目A/beta.md");

  const signature = indexMod.signatureOf(folder);
  assert.match(signature, /^d\|/, "文件夹指纹应以 d| 开头");
  assert.match(signature, /f:alpha\.md/, "指纹应包含直接子项名字");

  // 模拟「插件没运行时」改名：同一个对象，路径换了，children 没变
  folder.path = "03-资料/项目B";
  folder.name = "项目B";

  const mount = { id: "m1", kind: "folder", source: "03-资料/项目A", under: "", name: "项目A" };
  assert.equal(
    indexMod.findMovedSource(vault.app, mount, snapshotOf({ sourceSignature: signature, name: "项目A" })),
    "03-资料/项目B",
    "应把挂载重新绑到改名后的文件夹"
  );
}

// 2) 两个候选指纹、名字都一样 → 放弃，避免绑错
{
  const vault = makeVault();
  vault.addFolder("A");
  vault.addFolder("A/同名");
  vault.addFile("A/同名/note.md");
  vault.addFolder("B");
  vault.addFolder("B/同名");
  vault.addFile("B/同名/note.md");

  const signature = indexMod.signatureOf(vault.all.find((f) => f.path === "A/同名"));
  const mount = { id: "m2", kind: "folder", source: "C/同名", under: "", name: "同名" };
  assert.equal(
    indexMod.findMovedSource(vault.app, mount, snapshotOf({ sourceSignature: signature, name: "同名" })),
    null,
    "两个候选完全一样时应放弃"
  );
}

// 3) 候选指纹相同但名字能区分 → 选名字对得上的那个
{
  const vault = makeVault();
  vault.addFolder("A");
  vault.addFolder("A/同名");
  vault.addFile("A/同名/note.md");
  vault.addFolder("B");
  vault.addFolder("B/副本");
  vault.addFile("B/副本/note.md");

  const signature = indexMod.signatureOf(vault.all.find((f) => f.path === "A/同名"));
  const mount = { id: "m3", kind: "folder", source: "C/同名", under: "", name: "同名" };
  assert.equal(
    indexMod.findMovedSource(vault.app, mount, snapshotOf({ sourceSignature: signature, name: "同名" })),
    "A/同名",
    "同名候选里应选中名字匹配的那个"
  );
}

// 4) 单文件挂载：父目录被搬走时按文件名找回
{
  const vault = makeVault();
  vault.addFolder("B");
  vault.addFile("B/note.md");

  const mount = { id: "m4", kind: "file", source: "A/note.md", under: "", name: "note" };
  assert.equal(
    indexMod.findMovedSource(vault.app, mount, undefined),
    "B/note.md",
    "单文件挂载应能跟到搬走后的同名文件"
  );
}

// 5) 挂载点（目标文件夹）改名后同样能找回
{
  const vault = makeVault();
  const under = vault.addFolder("01-进行中/目标");
  vault.addFile("01-进行中/目标/x.md");
  const source = vault.addFolder("03-资料/项目A");
  vault.addFile("03-资料/项目A/alpha.md");

  const underSignature = indexMod.signatureOf(under);
  under.path = "01-进行中/新目标";
  under.name = "新目标";

  const mount = {
    id: "m5",
    kind: "folder",
    source: "03-资料/项目A",
    under: "01-进行中/目标",
    name: "项目A",
  };
  assert.equal(
    indexMod.findMovedUnder(
      vault.app,
      mount,
      snapshotOf({
        under: "01-进行中/目标",
        sourceSignature: indexMod.signatureOf(source),
        underSignature,
      })
    ),
    "01-进行中/新目标",
    "挂载点改名后应跟着走"
  );
}

// 6) 不能把挂载点找回到自己的源目录里面去
{
  const vault = makeVault();
  const source = vault.addFolder("03-资料/项目A");
  vault.addFile("03-资料/项目A/alpha.md");
  const inner = vault.addFolder("03-资料/项目A/目标");
  vault.addFile("03-资料/项目A/目标/x.md");

  const mount = {
    id: "m6",
    kind: "folder",
    source: "03-资料/项目A",
    under: "02-不存在/目标",
    name: "项目A",
  };
  assert.equal(
    indexMod.findMovedUnder(
      vault.app,
      mount,
      snapshotOf({
        under: "02-不存在/目标",
        sourceSignature: indexMod.signatureOf(source),
        underSignature: indexMod.signatureOf(inner),
      })
    ),
    null,
    "挂载点不能被挪进自己的源目录内部"
  );
}

/* ---------------------------------------------------------- 索引文件读写 */

// 7) 写出来的索引包含指纹，读回来结构一致
{
  const vault = makeVault();
  vault.addFolder("03-资料");
  vault.addFolder("03-资料/项目A");
  vault.addFile("03-资料/项目A/alpha.md");

  const mounts = [
    {
      id: "vm-1",
      kind: "folder",
      source: "03-资料/项目A",
      under: "",
      name: "项目A",
      nameMode: "auto",
      enabled: true,
      collapsed: true,
    },
  ];

  const written = await indexMod.writeMountIndex(
    vault.app,
    ".obsidian/plugins/virtual-mount",
    "virtual-mount",
    mounts
  );
  assert.ok(written, "应能写出索引");
  assert.equal(vault.adapterFiles.size, 1, "索引应写成一个文件");

  const [path, text] = [...vault.adapterFiles.entries()][0];
  assert.equal(path, ".obsidian/plugins/virtual-mount/mounts.index.json");
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, indexMod.INDEX_VERSION);
  assert.equal(parsed.mounts.length, 1);
  assert.ok(parsed.mounts[0].sourceSignature.startsWith("d|"), "索引应记录内容指纹");
  assert.equal(parsed.mounts[0].id, "vm-1");

  const read = await indexMod.readMountIndex(
    vault.app,
    ".obsidian/plugins/virtual-mount",
    "virtual-mount"
  );
  assert.ok(read, "应能读回索引");
  assert.deepEqual(read.mounts, parsed.mounts);
}

// 8) 目录不存在时补建；坏文件 / 版本不符时安全失败
{
  const vault = makeVault();
  let mkdirCalled = false;
  let failFirstWrite = true;
  vault.adapter.write = async (path, data) => {
    if (failFirstWrite) {
      failFirstWrite = false;
      throw new Error("no such directory");
    }
    vault.adapterFiles.set(path, data);
  };
  vault.adapter.mkdir = async () => {
    mkdirCalled = true;
  };

  const written = await indexMod.writeMountIndex(
    vault.app,
    ".obsidian/plugins/virtual-mount",
    "virtual-mount",
    []
  );
  assert.ok(written, "首次写入失败后补 mkdir 应能成功");
  assert.ok(mkdirCalled, "写入失败时应尝试补建目录");

  const indexPath = ".obsidian/plugins/virtual-mount/mounts.index.json";
  vault.adapterFiles.set(indexPath, "{ 坏掉的 JSON");
  assert.equal(
    await indexMod.readMountIndex(vault.app, ".obsidian/plugins/virtual-mount", "virtual-mount"),
    null,
    "坏索引不能让插件启动失败"
  );

  vault.adapterFiles.set(indexPath, JSON.stringify({ version: 999, mounts: [] }));
  assert.equal(
    await indexMod.readMountIndex(vault.app, ".obsidian/plugins/virtual-mount", "virtual-mount"),
    null,
    "版本不符的索引应被忽略"
  );
}

console.log("\n✅ 索引 / 路径找回用例全部通过");

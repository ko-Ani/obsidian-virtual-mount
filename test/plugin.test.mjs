/**
 * 插件入口冒烟测试：用假的 Obsidian 运行时跑一遍 onload / 设置加载 / 命令注册 / onunload，
 * 确保 main.js 在真实环境里不会一启用就抛异常。
 *
 * 运行：node test/plugin.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
  pretendToBeVisual: true,
  url: "https://example.com/",
});
const { window } = dom;
// 强制中文，断言的文案就是用户看到的中文
window.localStorage.setItem("language", "zh");
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.MutationObserver = window.MutationObserver;

const proto = window.Element.prototype;
proto.createEl = function (tag, o) {
  const el = window.document.createElement(tag);
  if (typeof o === "string") el.className = o;
  else if (o) {
    if (o.cls) el.className = o.cls;
    if (o.text !== undefined) el.textContent = String(o.text);
  }
  this.appendChild(el);
  return el;
};
proto.createDiv = function (o) {
  return this.createEl("div", o);
};
proto.createSpan = function (o) {
  return this.createEl("span", o);
};
proto.setText = function (t) {
  this.textContent = String(t);
};
proto.setAttr = function (k, v) {
  this.setAttribute(k, String(v));
};
proto.addClass = function (...c) {
  this.classList.add(...c.flat());
};
proto.toggleClass = function (c, v) {
  const list = Array.isArray(c) ? c : [c];
  for (const x of list) this.classList.toggle(x, v === undefined ? undefined : Boolean(v));
};
proto.hasClass = function (c) {
  return this.classList.contains(c);
};
proto.empty = function () {
  this.replaceChildren();
};
proto.detach = function () {
  this.remove();
};
globalThis.createDiv = (o) => window.document.createElement("div");
globalThis.createSpan = (o) => window.document.createElement("span");

class TAbstractFile {
  constructor(path) {
    this.path = path;
    this.name = path.split("/").pop() || path;
  }
}
class TFile extends TAbstractFile {
  constructor(path) {
    super(path);
    this.basename = this.name.replace(/\.[^.]+$/, "");
    this.extension = "md";
    this.stat = { mtime: 0, ctime: 0, size: 0 };
  }
}
class TFolder extends TAbstractFile {
  constructor(path) {
    super(path);
    this.children = [];
  }
}

class FakePlugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.commands = [];
    this.ribbonIcons = [];
    this.settingTabs = [];
    this.events = [];
    this.registered = [];
  }
  async loadData() {
    return this._data ?? null;
  }
  async saveData(data) {
    this._data = JSON.parse(JSON.stringify(data));
  }
  addCommand(cmd) {
    this.commands.push(cmd);
    return cmd;
  }
  addRibbonIcon() {
    this.ribbonIcons.push(arguments);
  }
  addSettingTab(tab) {
    this.settingTabs.push(tab);
  }
  registerEvent(evt) {
    this.events.push(evt);
  }
  register(fn) {
    this.registered.push(fn);
  }
  onload() {}
  onunload() {}
}

const made = { notices: [] };

const obsidianStub = {
  Plugin: FakePlugin,
  PluginSettingTab: class {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
    }
    display() {}
  },
  Setting: class {
    constructor() {
      this.settingEl = window.document.createElement("div");
    }
    setName() {
      return this;
    }
    setDesc() {
      return this;
    }
    addText() {
      return this;
    }
    addToggle() {
      return this;
    }
    addButton() {
      return this;
    }
    addExtraButton() {
      return this;
    }
    addDropdown() {
      return this;
    }
  },
  Modal: class {
    constructor(app) {
      this.app = app;
      this.contentEl = window.document.createElement("div");
      this.titleEl = window.document.createElement("div");
    }
    open() {}
    close() {}
  },
  FuzzySuggestModal: class {
    constructor(app) {
      this.app = app;
    }
    setPlaceholder() {}
    open() {}
  },
  Notice: class {
    constructor(message) {
      made.notices.push(message);
    }
  },
  Menu: class {
    constructor() {
      this.items = [];
    }
    addItem(cb) {
      const item = {
        title: "",
        icon: "",
        section: "",
        click: null,
        setTitle(t) {
          this.title = t;
          return this;
        },
        setIcon(i) {
          this.icon = i;
          return this;
        },
        setSection(s) {
          this.section = s;
          return this;
        },
        setIsLabel() {
          return this;
        },
        onClick(fn) {
          this.click = fn;
          return this;
        },
      };
      cb(item);
      this.items.push(item);
      return this;
    }
    addSeparator() {
      return this;
    }
    showAtMouseEvent() {}
  },
  setIcon() {},
  normalizePath: (p) => p,
  TAbstractFile,
  TFile,
  TFolder,
};

const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};

/* ---------------------------------------------------------------- 假 app */

const root = new TFolder("/");
root.name = "MyVault";
const folders = new Map([["/", root]]);
for (const p of ["01-进行中", "03-资料", "03-资料/项目A"]) folders.set(p, new TFolder(p));
const file = new TFile("03-资料/项目A/alpha.md");

const handlers = {};

const app = {
  vault: {
    getRoot: () => root,
    getAbstractFileByPath: (p) => folders.get(p) ?? (p === file.path ? file : null),
    on: () => ({ unsubscribe() {} }),
    getAllLoadedFiles: () => [...folders.values(), file],
  },
  workspace: {
    onLayoutReady: (cb) => cb(),
    on: (name, cb) => {
      handlers[name] = cb;
      return { unsubscribe() {} };
    },
    getActiveFile: () => null,
    getLeaf: () => ({ openFile: async () => {} }),
  },
};

const PluginClass = require("../main.js").default;

const plugin = new PluginClass(app, { id: "virtual-mount", version: "0.1.0" });
plugin._data = {
  mounts: [
    { kind: "folder", source: "03-资料/项目A", under: "01-进行中" },
    { kind: "file", source: "03-资料/项目A/alpha.md", under: "", name: "alpha 镜像" },
  ],
  maxChildren: 120,
};

await plugin.onload();

// 1) 设置被规范化：缺失的 id/name 补上
assert.equal(plugin.settings.mounts.length, 2);
for (const m of plugin.settings.mounts) {
  assert.ok(m.id && m.id.length > 4, "挂载应有自动生成的 id");
  assert.equal(m.enabled, true);
}
assert.equal(plugin.settings.mounts[0].name, "项目A", "name 缺省应取源路径最后一段");
assert.equal(plugin.settings.mounts[1].name, "alpha 镜像");
assert.equal(plugin.settings.maxChildren, 120);
assert.equal(plugin.settings.mounts[0].collapsed, true, "旧配置缺少 collapsed 时默认折叠");

// 2) 命令 / 功能区 / 设置页注册齐全
const ids = plugin.commands.map((c) => c.id).sort();
assert.deepEqual(ids, ["add-mount", "mount-active-file", "mount-active-folder", "refresh-mounts"]);
assert.equal(plugin.settingTabs.length, 1);
assert.equal(plugin.ribbonIcons.length, 1);

// 3) 仓库事件监听注册（create/delete/rename/file-open/layout-change/file-menu）
assert.equal(plugin.events.length, 6);
assert.equal(typeof handlers["file-menu"], "function");

// 3.1) 右键文件夹 -> 菜单里出现「虚拟挂载到…」
const menu = new obsidianStub.Menu();
handlers["file-menu"](menu, folders.get("03-资料/项目A"), "file-explorer-context-menu");
assert.equal(menu.items.length, 1, "文件夹右键应加一项");
assert.equal(menu.items[0].title, "虚拟挂载到…");
assert.equal(menu.items[0].icon, "folder-symlink");
assert.equal(menu.items[0].section, "action");
assert.equal(typeof menu.items[0].click, "function");
menu.items[0].click(); // 打开弹窗不应抛异常

// 只针对文件浏览器；标签页等其他来源不插
const tabMenu = new obsidianStub.Menu();
handlers["file-menu"](tabMenu, folders.get("03-资料/项目A"), "tab-header");
assert.equal(tabMenu.items.length, 0);

// 仓库根目录不插
const rootMenu = new obsidianStub.Menu();
handlers["file-menu"](rootMenu, root, "file-explorer-context-menu");
assert.equal(rootMenu.items.length, 0);

// 单文件使用不同标题
const fileMenu = new obsidianStub.Menu();
handlers["file-menu"](fileMenu, file, "file-explorer-context-menu");
assert.equal(fileMenu.items[0].title, "虚拟挂载到…（单文件）");

// 3.2) addMount 的校验 / 去重
const added = await plugin.addMount("folder", "03-资料/项目A", "", "项目A 镜像");
assert.equal(added.ok, true);
assert.equal(added.mount.name, "项目A 镜像");
assert.equal(added.mount.under, "");
assert.equal(added.mount.collapsed, true, "新建挂载点应默认折叠");
assert.equal(plugin.settings.mounts.length, 3);

const duplicated = await plugin.addMount("folder", "03-资料/项目A", "01-进行中", "重复");
assert.equal(duplicated.ok, false);
assert.match(duplicated.error, /已经挂载/);

const badUnder = await plugin.addMount("folder", "03-资料/项目A", "不存在的目录", "x");
assert.equal(badUnder.ok, false);
assert.match(badUnder.error, /挂载点不是文件夹/);

const noSource = await plugin.addMount("folder", "不存在的目录/xx", "", "x");
assert.equal(noSource.ok, false);
assert.match(noSource.error, /源路径不存在/);

// 4) 路径跟随重命名
plugin.settings.mounts[0].source = "03-资料/项目A";
await plugin.remapPaths("03-资料/项目A", "03-资料/项目B");
assert.equal(plugin.settings.mounts[0].source, "03-资料/项目B", "源路径应跟随重命名");
assert.equal(
  plugin.settings.mounts[1].source,
  "03-资料/项目B/alpha.md",
  "源文件夹里的单文件挂载也应跟随重命名"
);

// 5) 删除挂载
const before = plugin.settings.mounts.length;
plugin.removeMount(plugin.settings.mounts[0].id);
await new Promise((r) => setTimeout(r, 10));
assert.equal(plugin.settings.mounts.length, before - 1);

// 6) 卸载不抛异常
plugin.onunload();

console.log("\n✅ 插件入口用例全部通过");

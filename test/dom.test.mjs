/**
 * 用 jsdom 复刻 Obsidian 1.8.x / 1.14.x 真实文件树 DOM，验证注入逻辑。
 * DOM 模板是从 Obsidian `obsidian.asar` 里挖出来的（tree-item / tree-item-self / nav-folder-children）。
 *
 * 运行：node test/dom.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ jsdom + 垫片 */

const dom = new JSDOM(
  `<!doctype html><html><body>
     <div class="workspace-leaf-content" data-type="file-explorer">
       <div class="nav-files-container"></div>
     </div>
   </body></html>`,
  { pretendToBeVisual: true, url: "https://example.com/" }
);
const { window } = dom;
const { document } = window;

// 强制中文，测试断言的文案就是用户看到的中文
window.localStorage.setItem("language", "zh");

globalThis.window = window;
globalThis.document = document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.MutationObserver = window.MutationObserver;

function applyInfo(el, o) {
  if (!o) return el;
  if (typeof o === "string") {
    el.className = o;
    return el;
  }
  if (o.cls) el.className = o.cls;
  if (o.text !== undefined) el.textContent = String(o.text);
  if (o.attr) {
    for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
  }
  return el;
}

function createEl(tag, o) {
  return applyInfo(document.createElement(tag), o);
}

const proto = window.Element.prototype;
proto.createEl = function (tag, o) {
  const el = createEl(tag, o);
  this.appendChild(el);
  return el;
};
proto.createDiv = function (o) {
  return this.createEl("div", o);
};
proto.createSpan = function (o) {
  return this.createEl("span", o);
};
proto.setText = function (text) {
  this.textContent = String(text);
};
proto.setAttr = function (name, value) {
  this.setAttribute(name, String(value));
};
proto.addClass = function (...classes) {
  this.classList.add(...classes.flat());
};
proto.removeClass = function (...classes) {
  this.classList.remove(...classes.flat());
};
proto.toggleClass = function (classes, value) {
  const list = Array.isArray(classes) ? classes : [classes];
  for (const c of list) {
    if (value === undefined) this.classList.toggle(c);
    else this.classList.toggle(c, Boolean(value));
  }
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

globalThis.createDiv = (o) => createEl("div", o);
globalThis.createSpan = (o) => createEl("span", o);

/* -------------------------------------------------------------- obsidian 模块桩 */

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
    this.extension = (this.name.split(".").pop() || "").toLowerCase();
    this.stat = { mtime: 0, ctime: 0, size: 0 };
  }
}
class TFolder extends TAbstractFile {
  constructor(path) {
    super(path);
    this.children = [];
    this.parent = null;
  }
}

const menus = [];
class FakeMenu {
  constructor() {
    this.items = [];
  }
  addItem(cb) {
    const item = {
      title: "",
      icon: "",
      section: "",
      click: null,
      setTitle(value) {
        this.title = value;
        return this;
      },
      setIcon(value) {
        this.icon = value;
        return this;
      },
      setSection(value) {
        this.section = value;
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
    this.items.push({ separator: true });
    return this;
  }
  setParentElement(el) {
    this.parentEl = el;
    return this;
  }
  showAtMouseEvent(evt) {
    menus.push({ menu: this, evt });
  }
}

/* 一个极简的 workspace 事件总线，模拟 Obsidian 的 on / offref / trigger。 */
const workspaceHandlers = new Map();
function onWorkspace(name, cb) {
  if (!workspaceHandlers.has(name)) workspaceHandlers.set(name, new Set());
  workspaceHandlers.get(name).add(cb);
  return { name, cb };
}
function offref(ref) {
  workspaceHandlers.get(ref.name)?.delete(ref.cb);
}
function triggerWorkspace(name, ...args) {
  for (const cb of [...(workspaceHandlers.get(name) ?? [])]) cb(...args);
}

const obsidianStub = {
  App: class {},
  TAbstractFile,
  TFile,
  TFolder,
  setIcon(el, name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-icon", name);
    el.appendChild(svg);
  },
  normalizePath: (p) => p,
  Menu: FakeMenu,
};

const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};

/* -------------------------------------------------------------- 构造仓库与 DOM */

function makeVault() {
  const root = new TFolder("/");
  root.name = "MyVault";
  const folders = new Map([["/", root]]);
  const files = new Map();

  const addFolder = (path) => {
    const parent = folders.get(path.split("/").slice(0, -1).join("/") || "/");
    const folder = new TFolder(path);
    folder.parent = parent;
    parent.children.push(folder);
    folders.set(path, folder);
    return folder;
  };
  const addFile = (path) => {
    const parent = folders.get(path.split("/").slice(0, -1).join("/") || "/");
    const file = new TFile(path);
    file.parent = parent;
    parent.children.push(file);
    files.set(path, file);
    return file;
  };

  addFolder("01-进行中");
  // 目标文件夹里已有的真实条目，按原生顺序（文件夹优先、名称升序）排列，
  // 用来验证挂载行会插进它们中间，而不是永远排在最前面。
  addFolder("01-进行中/Alpha");
  addFolder("01-进行中/Charlie");
  addFile("01-进行中/00-真实笔记.md");
  addFile("01-进行中/zzz-真实笔记.md");
  addFolder("03-资料");
  const src = addFolder("03-资料/项目A");
  addFile("03-资料/项目A/alpha.md");
  addFile("03-资料/项目A/beta.md");
  addFolder("03-资料/项目A/子目录");
  addFile("03-资料/项目A/子目录/gamma.md");
  addFolder("03-资料/项目A/子目录/深一层");
  addFile("03-资料/项目A/子目录/深一层/delta.md");

  const opened = [];
  const menuCalls = [];
  // 模拟 Obsidian 1.14 的核心文件浏览器视图：核心在 onFileContextMenu 里直接
  // 添加原生菜单项，触发 file-menu，然后（如果 fileItems 里还有这个条目）
  // 把菜单挂到真实条目的 DOM 上，最后 showAtMouseEvent。
  const explorerView = {
    containerEl: document.querySelector(".workspace-leaf-content"),
    fileItems: {
      "03-资料/项目A": { selfEl: document.createElement("div") },
      "03-资料/项目A/alpha.md": { selfEl: document.createElement("div") },
    },
    onFileContextMenu(evt, file) {
      menuCalls.push(file);
      const menu = new FakeMenu();
      menu.addItem((item) => item.setTitle("原生：重命名").setIcon("lucide-edit-3"));
      triggerWorkspace("file-menu", menu, file, "file-explorer-context-menu", null);
      const item = this.fileItems?.[file.path];
      if (item) menu.setParentElement(item.selfEl);
      menu.showAtMouseEvent(evt);
    },
  };
  const app = {
    vault: {
      getRoot: () => root,
      getAbstractFileByPath: (p) => folders.get(p) ?? files.get(p) ?? null,
    },
    workspace: {
      getActiveFile: () => null,
      getLeaf: () => ({
        openFile: async (file) => {
          opened.push(file.path);
        },
      }),
      getLeavesOfType: (type) => (type === "file-explorer" ? [{ view: explorerView }] : []),
      on: onWorkspace,
      offref,
      trigger: triggerWorkspace,
    },
  };
  return { app, folders, files, root, src, opened, menuCalls, explorerView };
}

/** 按原生结构渲染一层条目（文件夹带空的 children 容器，文件是 nav-file）。 */
function renderRows(childrenEl, children) {
  for (const child of children) {
    if (child instanceof TFolder) {
      const folderEl = document.createElement("div");
      folderEl.className = "tree-item nav-folder";
      folderEl.innerHTML = `
        <div class="tree-item-self nav-folder-title is-clickable mod-collapsible" data-path="${child.path}">
          <div class="tree-item-icon collapse-icon"></div>
          <div class="tree-item-inner nav-folder-title-content">${child.name}</div>
        </div>
        <div class="tree-item-children nav-folder-children"></div>`;
      childrenEl.appendChild(folderEl);
    } else {
      const fileEl = document.createElement("div");
      fileEl.className = "tree-item nav-file";
      fileEl.innerHTML = `
        <div class="tree-item-self nav-file-title is-clickable" data-path="${child.path}">
          <div class="tree-item-inner nav-file-title-content">${child.basename}</div>
        </div>`;
      childrenEl.appendChild(fileEl);
    }
  }
  return childrenEl;
}

function buildTreeDom(rootFolder, folderIndex) {
  const container = document.querySelector(".nav-files-container");
  container.replaceChildren();
  const rootEl = document.createElement("div");
  rootEl.className = "tree-item nav-folder";
  rootEl.innerHTML = `
    <div class="tree-item-self nav-folder-title is-clickable mod-collapsible" data-path="/">
      <div class="tree-item-icon collapse-icon"></div>
      <div class="tree-item-inner nav-folder-title-content">MyVault</div>
    </div>
    <div class="tree-item-children nav-folder-children"></div>`;
  container.appendChild(rootEl);

  const rootChildren = rootEl.querySelector(":scope > .nav-folder-children");
  renderRows(rootChildren, rootFolder.children);

  // 模拟用户已经把「01-进行中」展开：核心会渲染它的真实子条目。
  const target = rootChildren
    .querySelector('.nav-folder-title[data-path="01-进行中"]')
    .closest(".nav-folder");
  renderRows(
    target.querySelector(":scope > .nav-folder-children"),
    folderIndex.get("01-进行中").children
  );
  return container;
}

/** 模拟核心重绘：按真实数据重新生成目标文件夹的那一层条目。 */
function nativeTargetRows(folderIndex) {
  const wrap = document.createElement("div");
  renderRows(wrap, folderIndex.get("01-进行中").children);
  return Array.from(wrap.children);
}

/** 列表里每个条目的排序名（虚拟节点用显示名称，真实节点用路径最后一段）。 */
function itemNames(parent) {
  return Array.from(parent.children)
    .filter((el) => el.classList.contains("tree-item"))
    .map((el) => {
      if (el.dataset.vmName !== undefined) return el.dataset.vmName;
      const path = el.querySelector("[data-path]")?.getAttribute("data-path") ?? "";
      return path.slice(path.lastIndexOf("/") + 1);
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------------- 用例 */

const { app, folders, root, opened, menuCalls, explorerView } = makeVault();
const container = buildTreeDom(root, folders);
const hostSettings = {
  mounts: [],
  foldersFirst: true,
  showBadge: true,
  revealOnOpen: false,
  maxChildren: 500,
};

const { VirtualTree } = require("./tree.cjs");
const tree = new VirtualTree(app, {
  settings: hostSettings,
  saveSettings: async () => {},
  removeMount: (id) => {
    hostSettings.mounts = hostSettings.mounts.filter((m) => m.id !== id);
  },
});

// 显示名用 ASCII，保证和真实条目 Alpha / Charlie 的排序结果不依赖 ICU 的中文排序。
const mountId = "m1";
hostSettings.mounts = [
  { id: mountId, kind: "folder", source: "03-资料/项目A", under: "01-进行中", name: "Bravo", enabled: true, collapsed: false },
];

tree.syncNow(true);

const targetFolderEl = container
  .querySelector('.nav-folder-title[data-path="01-进行中"]')
  .closest(".nav-folder");
const coreChildren = targetFolderEl.querySelector(":scope > .nav-folder-children");

// 1) 挂载行直接插进核心的 children 列表，不再是独立的容器
const mounted = coreChildren.querySelector(':scope > .nav-folder[data-vm-id="m1"]');
assert.ok(mounted, "挂载根节点应是核心 children 的直接子元素");
assert.equal(mounted.parentElement, coreChildren, "挂载行应和真实条目在同一份列表里");
assert.equal(targetFolderEl.querySelectorAll(".vm-children").length, 0, "不应再创建独立挂载容器");

// 1.1) 按名称插到真实条目中间（文件夹优先），而不是固定在第一个
assert.deepEqual(
  itemNames(coreChildren),
  ["Alpha", "Bravo", "Charlie", "00-真实笔记.md", "zzz-真实笔记.md"],
  "挂载行应按名称排在真实同级条目中间"
);
assert.equal(
  coreChildren.firstElementChild.dataset.vmId,
  undefined,
  "挂载行不应再固定出现在目标文件夹第一个"
);

// 2) 镜像出正确的节点
const mountRoot = () =>
  coreChildren.querySelector(':scope > [data-vm-role="root"][data-vm-id="m1"]');
assert.equal(mountRoot().dataset.vmId, mountId);
const names = Array.from(mountRoot().querySelectorAll(".nav-file-title-content")).map(
  (el) => el.textContent
);
// Obsidian 原生只显示 basename（不带扩展名），这里保持一致
assert.deepEqual(names, ["alpha", "beta"], "镜像子文件应与源目录一致");
const folderNames = Array.from(
  mountRoot().querySelectorAll(
    ":scope > .nav-folder-children > .nav-folder .nav-folder-title-content"
  )
).map((el) => el.textContent);
assert.deepEqual(folderNames, ["子目录"], "镜像子文件夹应存在");

// 2.1) 子目录默认折叠，且不会把整棵子树递归展开（与原生目录一致）
const nestedFolderEl = mountRoot().querySelector(
  ":scope > .nav-folder-children > .nav-folder"
);
assert.ok(nestedFolderEl.classList.contains("is-collapsed"), "子目录默认应折叠");
assert.equal(
  nestedFolderEl.querySelectorAll(".vm-file").length,
  0,
  "折叠的子目录不应提前渲染子文件"
);

// 3) 模拟核心虚拟滚动 / 重绘：整体替换 children，挂载行被清掉后必须自动补回来
coreChildren.replaceChildren(...nativeTargetRows(folders));
assert.equal(
  coreChildren.querySelector('[data-vm-id="m1"]'),
  null,
  "核心重绘会连同挂载行一起清掉（此时确实不在了）"
);
await sleep(150);
assert.ok(mountRoot(), "核心重绘后挂载行应自动补注入");
assert.deepEqual(
  itemNames(coreChildren),
  ["Alpha", "Bravo", "Charlie", "00-真实笔记.md", "zzz-真实笔记.md"],
  "补注入后仍应保持在正确的位置"
);
assert.equal(mountRoot().querySelectorAll(".vm-file").length, 2, "镜像行数应恢复");

// 4) 点击虚拟文件 -> 打开真实文件
const alphaTitle = mountRoot().querySelector(
  '.nav-file-title[data-vm-src="03-资料/项目A/alpha.md"]'
);
assert.ok(alphaTitle, "能找到 alpha.md 的虚拟行");
alphaTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
await sleep(10);
assert.deepEqual(opened, ["03-资料/项目A/alpha.md"], "点击虚拟行应打开真实文件");

// 5) 点击不应冒泡到核心（否则核心会尝试按 path 找 fileItems）
let bubbled = false;
container.addEventListener("click", () => {
  bubbled = true;
});
alphaTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
await sleep(10);
assert.equal(bubbled, false, "虚拟节点的点击必须 stopPropagation");

// 6) 文件夹节点的折叠
const folderTitle = mountRoot().querySelector(":scope > .nav-folder-title");
const icon = folderTitle.querySelector(".collapse-icon");
folderTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert.ok(mountRoot().classList.contains("is-collapsed"), "点击应折叠");
assert.ok(icon.classList.contains("is-collapsed"), "折叠图标也要同步状态");
folderTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert.ok(!mountRoot().classList.contains("is-collapsed"), "再次点击应展开");

// 6.1) 子目录按需展开：点开后才渲染内容，更深一层仍默认折叠
const nestedTitle = nestedFolderEl.querySelector(":scope > .nav-folder-title");
nestedTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert.ok(!nestedFolderEl.classList.contains("is-collapsed"), "点击子目录应展开");
assert.equal(nestedFolderEl.querySelectorAll(".vm-file").length, 1, "展开后才渲染子文件");
const deepFolderEl = nestedFolderEl.querySelector(
  ":scope > .nav-folder-children > .nav-folder"
);
assert.ok(deepFolderEl.classList.contains("is-collapsed"), "更深一层的子目录也应默认折叠");
assert.equal(deepFolderEl.querySelectorAll(".vm-file").length, 0, "深层内容不应提前渲染");

// 6.2) 关闭父目录再打开，子目录仍保持展开（与原生文件浏览器的记忆行为一致）
folderTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
folderTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert.ok(!nestedFolderEl.classList.contains("is-collapsed"), "父目录重新展开后子目录仍应展开");
assert.equal(nestedFolderEl.querySelectorAll(".vm-file").length, 1, "子目录内容应保留");

// 6.3) 强制重建（相当于核心重绘）后，展开状态仍然保留
tree.syncNow(true);
const nestedAfterRebuild = mountRoot().querySelector(
  ":scope > .nav-folder-children > .nav-folder"
);
assert.ok(nestedAfterRebuild, "重建后应重新渲染子目录");
assert.ok(
  !nestedAfterRebuild.classList.contains("is-collapsed"),
  "重建后子目录仍应保持展开"
);
assert.equal(nestedAfterRebuild.querySelectorAll(".vm-file").length, 1, "重建后子目录内容应恢复");
const deepAfterRebuild = nestedAfterRebuild.querySelector(
  ":scope > .nav-folder-children > .nav-folder"
);
assert.ok(deepAfterRebuild.classList.contains("is-collapsed"), "重建后深层目录仍默认折叠");

// 7) 整个文件夹节点被核心重建后，能重新注入
const fresh = document.createElement("div");
fresh.className = "tree-item nav-folder";
fresh.innerHTML = `
  <div class="tree-item-self nav-folder-title is-clickable mod-collapsible" data-path="01-进行中">
    <div class="tree-item-icon collapse-icon"></div>
    <div class="tree-item-inner nav-folder-title-content">01-进行中</div>
  </div>
  <div class="tree-item-children nav-folder-children"></div>`;
fresh
  .querySelector(":scope > .nav-folder-children")
  .append(...nativeTargetRows(folders));
targetFolderEl.replaceWith(fresh);
tree.syncNow(false);
const coreFresh = fresh.querySelector(":scope > .nav-folder-children");
const freshMount = () =>
  coreFresh.querySelector(':scope > [data-vm-role="root"][data-vm-id="m1"]');
assert.ok(freshMount(), "重建后应重新注入挂载行");
assert.deepEqual(
  itemNames(coreFresh),
  ["Alpha", "Bravo", "Charlie", "00-真实笔记.md", "zzz-真实笔记.md"],
  "重建后仍应排在正确位置"
);
const directFiles = freshMount().querySelectorAll(
  ":scope > .nav-folder-children > .nav-file"
);
assert.equal(directFiles.length, 2, "重建后镜像内容应恢复");
const nestedInFresh = freshMount().querySelector(
  ":scope > .nav-folder-children > .nav-folder"
);
assert.ok(
  !nestedInFresh.classList.contains("is-collapsed"),
  "重建后子目录的展开状态也应恢复"
);

// 7.1) 目标文件夹折叠时核心会摘掉 childrenEl：挂载行随之消失，展开后重新插回原位
coreFresh.remove();
fresh.classList.add("is-collapsed");
tree.syncNow(true);
assert.equal(
  fresh.querySelectorAll('[data-vm-id="m1"]').length,
  0,
  "目标文件夹折叠时不应残留挂载行"
);
fresh.classList.remove("is-collapsed");
const reopened = document.createElement("div");
reopened.className = "tree-item-children nav-folder-children";
reopened.append(...nativeTargetRows(folders));
fresh.appendChild(reopened);
tree.syncNow(false);
assert.ok(
  reopened.querySelector(':scope > [data-vm-role="root"][data-vm-id="m1"]'),
  "重新展开后挂载行应重新注入"
);
assert.deepEqual(
  itemNames(reopened),
  ["Alpha", "Bravo", "Charlie", "00-真实笔记.md", "zzz-真实笔记.md"],
  "重新展开后仍应排在正确位置"
);

// 8) 单文件挂载
hostSettings.mounts.push({
  id: "m2",
  kind: "file",
  source: "03-资料/项目A/beta.md",
  under: "01-进行中",
  name: "单独的 beta",
  enabled: true,
  collapsed: false,
});
tree.syncNow(true);
const fileRoot = reopened.querySelector(
  ':scope > [data-vm-role="root"][data-vm-id="m2"]'
);
assert.ok(fileRoot, "单文件挂载应出现");
assert.equal(
  fileRoot.closest(".nav-file").querySelector(".nav-file-title-content").textContent,
  "单独的 beta"
);
assert.deepEqual(
  itemNames(reopened),
  ["Alpha", "Bravo", "Charlie", "00-真实笔记.md", "单独的 beta", "zzz-真实笔记.md"],
  "单文件挂载也应按名称插进真实文件中间"
);

// 9) 删除挂载后清理
hostSettings.mounts = hostSettings.mounts.filter((m) => m.id !== "m2");
tree.syncNow(true);
assert.equal(reopened.querySelectorAll('[data-vm-id="m2"]').length, 0, "删除后节点应被清理");

// 9.1) 两个同名挂载：连续同步不应互相换位（排序必须稳定，否则会反复触发 observer）
hostSettings.mounts = [
  {
    id: "t1",
    kind: "folder",
    source: "03-资料/项目A",
    under: "01-进行中",
    name: "Twin",
    enabled: true,
    collapsed: true,
  },
  {
    id: "t2",
    kind: "folder",
    source: "03-资料/项目A/子目录",
    under: "01-进行中",
    name: "Twin",
    enabled: true,
    collapsed: true,
  },
];
tree.syncNow(true);
const twinOrder = itemNames(reopened);
assert.equal(twinOrder.filter((name) => name === "Twin").length, 2, "两个同名挂载都应出现");
for (let i = 0; i < 3; i++) {
  tree.syncNow(false);
  assert.deepEqual(itemNames(reopened), twinOrder, "连续同步不应改变同名挂载的相对顺序");
}

// 10) 没有任何挂载时，虚拟节点应全部清空
hostSettings.mounts = [];
tree.syncNow(true);
assert.equal(
  document.querySelectorAll('[data-vm-role="root"]').length,
  0,
  "没有挂载时不应残留虚拟节点"
);
assert.equal(document.querySelectorAll(".vm-children").length, 0, "不应再创建独立挂载容器");

// 11) 长按/右键虚拟挂载根目录 -> 弹出源目录的原生菜单
hostSettings.mounts = [
  {
    id: "m3",
    kind: "folder",
    source: "03-资料/项目A",
    under: "01-进行中",
    name: "项目A",
    enabled: true,
    collapsed: false,
  },
];
tree.syncNow(true);
const holder4 = reopened;
const rootFolderTitle = holder4.querySelector('.vm-folder-title[data-vm-role="root"]');
assert.ok(rootFolderTitle, "应有虚拟挂载根目录");

rootFolderTitle.dispatchEvent(
  new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })
);
assert.equal(
  menuCalls.at(-1),
  folders.get("03-资料/项目A"),
  "菜单必须把真实源文件夹交给核心（操作作用于源目录）"
);
const rootMenu = menus.at(-1).menu;
const rootTitles = rootMenu.items.filter((item) => !item.separator).map((item) => item.title);
assert.equal(
  rootMenu.parentEl,
  undefined,
  "不能把菜单挂到不可见的真实条目上，否则核心会在 500ms 后自动关闭它"
);
assert.ok(explorerView.fileItems["03-资料/项目A"], "调用结束后应还原 fileItems");
assert.ok(rootTitles.includes("原生：重命名"), "核心原生菜单项应保留");
assert.ok(rootTitles.includes("在文件浏览器中定位真实文件夹"), "应保留定位真实文件夹");
assert.ok(rootTitles.includes("复制真实路径"), "应保留复制真实路径");
assert.ok(rootTitles.includes("取消此挂载"), "挂载根目录应有取消挂载");

// 12) 嵌套虚拟文件 -> 同样打开真实文件的原生菜单，但没有取消挂载
const nestedFileTitle = holder4.querySelector(
  '.vm-file-title[data-vm-src="03-资料/项目A/alpha.md"]'
);
assert.ok(nestedFileTitle, "应有嵌套虚拟文件");
nestedFileTitle.dispatchEvent(
  new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 12 })
);
assert.equal(menuCalls.at(-1).path, "03-资料/项目A/alpha.md", "嵌套虚拟行也应交给真实文件");
const nestedMenu = menus.at(-1).menu;
assert.equal(nestedMenu.parentEl, undefined, "嵌套虚拟行也不能挂到真实条目上");
assert.ok(explorerView.fileItems["03-资料/项目A/alpha.md"], "嵌套调用后应还原 fileItems");
const nestedTitles = nestedMenu.items.filter((item) => !item.separator).map((item) => item.title);
assert.ok(nestedTitles.includes("在文件浏览器中定位真实文件"));
assert.ok(nestedTitles.includes("复制真实路径"));
assert.ok(!nestedTitles.includes("取消此挂载"), "非挂载点不应出现取消挂载");

// 13) 点击原生菜单里的「取消此挂载」-> 移除的是这个挂载配置
const unmountItem = rootMenu.items.find((item) => item.title === "取消此挂载");
assert.ok(unmountItem && typeof unmountItem.click === "function");
unmountItem.click();
assert.equal(hostSettings.mounts.length, 0, "取消挂载应删除配置");
tree.syncNow(true);
assert.equal(fresh.querySelectorAll(".vm-folder").length, 0, "取消后虚拟节点应被清理");

// 14) 核心视图不可用时退回插件自己的精简菜单
hostSettings.mounts = [
  {
    id: "m4",
    kind: "folder",
    source: "03-资料/项目A",
    under: "01-进行中",
    name: "项目A",
    enabled: true,
    collapsed: false,
  },
];
tree.syncNow(true);
const holder5 = reopened;
const savedContextMenu = explorerView.onFileContextMenu;
delete explorerView.onFileContextMenu;
holder5
  .querySelector('.vm-folder-title[data-vm-role="root"]')
  .dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
const fallbackTitles = menus
  .at(-1)
  .menu.items.filter((item) => !item.separator)
  .map((item) => item.title);
assert.deepEqual(
  fallbackTitles,
  ["在文件浏览器中定位真实文件夹", "复制真实路径", "取消此挂载"],
  "核心视图不可用时应显示插件自己的菜单"
);
explorerView.onFileContextMenu = savedContextMenu;
assert.equal(
  workspaceHandlers.get("file-menu")?.size ?? 0,
  0,
  "一次性的 file-menu 监听应在菜单显示后被移除"
);

tree.stop();
console.log("\n✅ 全部 DOM 用例通过");

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
  addFolder("03-资料");
  const src = addFolder("03-资料/项目A");
  addFile("03-资料/项目A/alpha.md");
  addFile("03-资料/项目A/beta.md");
  addFolder("03-资料/项目A/子目录");

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

function buildTreeDom(rootFolder) {
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

  const rootChildren = rootEl.querySelector(".nav-folder-children");
  for (const child of rootFolder.children) {
    if (child instanceof TFolder) {
      const folderEl = document.createElement("div");
      folderEl.className = "tree-item nav-folder";
      folderEl.innerHTML = `
        <div class="tree-item-self nav-folder-title is-clickable mod-collapsible" data-path="${child.path}">
          <div class="tree-item-icon collapse-icon"></div>
          <div class="tree-item-inner nav-folder-title-content">${child.name}</div>
        </div>
        <div class="tree-item-children nav-folder-children"></div>`;
      rootChildren.appendChild(folderEl);
    } else {
      const fileEl = document.createElement("div");
      fileEl.className = "tree-item nav-file";
      fileEl.innerHTML = `
        <div class="tree-item-self nav-file-title is-clickable" data-path="${child.path}">
          <div class="tree-item-inner nav-file-title-content">${child.basename}</div>
        </div>`;
      rootChildren.appendChild(fileEl);
    }
  }
  return container;
}

/* ---------------------------------------------------------------------- 用例 */

const { app, folders, root, opened, menuCalls, explorerView } = makeVault();
const container = buildTreeDom(root);
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

const mountId = "m1";
hostSettings.mounts = [
  { id: mountId, kind: "folder", source: "03-资料/项目A", under: "01-进行中", name: "项目A", enabled: true, collapsed: false },
];

tree.syncNow(true);

const targetFolderEl = container
  .querySelector('.nav-folder-title[data-path="01-进行中"]')
  .closest(".nav-folder");

// 1) 挂载容器挂在了文件夹外层，而不是核心的 .nav-folder-children 里
const holder = Array.from(targetFolderEl.children).find((el) => el.classList.contains("vm-children"));
assert.ok(holder, "应该存在 .vm-children 容器");
assert.equal(holder.parentElement, targetFolderEl, "挂载容器应是 .nav-folder 的直接子元素");

// 2) 镜像出正确的节点
const virtualFolder = holder.querySelector('.vm-folder [data-vm-role="root"]')?.closest(".nav-folder");
assert.ok(virtualFolder, "应该有虚拟文件夹节点");
assert.equal(virtualFolder.dataset.vmId, mountId);
const names = Array.from(virtualFolder.querySelectorAll(".nav-file-title-content")).map((el) => el.textContent);
// Obsidian 原生只显示 basename（不带扩展名），这里保持一致
assert.deepEqual(names, ["alpha", "beta"], "镜像子文件应与源目录一致");
const folderNames = Array.from(virtualFolder.querySelectorAll(":scope > .nav-folder-children > .nav-folder .nav-folder-title-content")).map((el) => el.textContent);
assert.deepEqual(folderNames, ["子目录"], "镜像子文件夹应存在");

// 3) 模拟核心虚拟滚动：清空核心 children，我们的节点必须存活
const coreChildren = targetFolderEl.lastElementChild;
assert.ok(coreChildren.classList.contains("nav-folder-children"), "核心 children 应是最后一个子元素");
coreChildren.replaceChildren(...[0, 1, 2].map(() => {
  const el = document.createElement("div");
  el.className = "tree-item nav-file";
  return el;
}));
assert.ok(holder.isConnected, "核心重绘后挂载容器仍然存在");
assert.equal(holder.querySelectorAll(".vm-file").length, 2, "镜像行数不应变化");

// 4) 点击虚拟文件 -> 打开真实文件
const alphaTitle = holder.querySelector('.nav-file-title[data-vm-src="03-资料/项目A/alpha.md"]');
assert.ok(alphaTitle, "能找到 alpha.md 的虚拟行");
alphaTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
await new Promise((r) => setTimeout(r, 10));
assert.deepEqual(opened, ["03-资料/项目A/alpha.md"], "点击虚拟行应打开真实文件");

// 5) 点击不应冒泡到核心（否则核心会尝试按 path 找 fileItems）
let bubbled = false;
container.addEventListener("click", () => {
  bubbled = true;
});
alphaTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
await new Promise((r) => setTimeout(r, 10));
assert.equal(bubbled, false, "虚拟节点的点击必须 stopPropagation");

// 6) 文件夹节点的折叠
const folderTitle = holder.querySelector(".nav-folder-title");
const icon = folderTitle.querySelector(".collapse-icon");
folderTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert.ok(holder.querySelector(".nav-folder").classList.contains("is-collapsed"), "点击应折叠");
assert.ok(icon.classList.contains("is-collapsed"), "折叠图标也要同步状态");
folderTitle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert.ok(!holder.querySelector(".nav-folder").classList.contains("is-collapsed"), "再次点击应展开");

// 7) 整个文件夹节点被核心重建后，能重新注入
const fresh = document.createElement("div");
fresh.className = "tree-item nav-folder";
fresh.innerHTML = `
  <div class="tree-item-self nav-folder-title is-clickable mod-collapsible" data-path="01-进行中">
    <div class="tree-item-icon collapse-icon"></div>
    <div class="tree-item-inner nav-folder-title-content">01-进行中</div>
  </div>
  <div class="tree-item-children nav-folder-children"></div>`;
targetFolderEl.replaceWith(fresh);
tree.syncNow(false);
const holder2 = Array.from(fresh.children).find((el) => el.classList.contains("vm-children"));
assert.ok(holder2, "重建后应重新注入挂载容器");
assert.equal(holder2.querySelectorAll(".vm-file").length, 2, "重建后镜像内容应恢复");

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
const holder3 = Array.from(fresh.children).find((el) => el.classList.contains("vm-children"));
const fileRoot = holder3.querySelector('[data-vm-role="root"][data-vm-id="m2"]');
assert.ok(fileRoot, "单文件挂载应出现");
assert.equal(fileRoot.closest(".nav-file").querySelector(".nav-file-title-content").textContent, "单独的 beta");

// 9) 删除挂载后清理
hostSettings.mounts = hostSettings.mounts.filter((m) => m.id !== "m2");
tree.syncNow(true);
assert.equal(holder3.querySelectorAll('[data-vm-id="m2"]').length, 0, "删除后节点应被清理");

// 10) 容器为空时也移除
hostSettings.mounts = [];
tree.syncNow(true);
assert.equal(document.querySelectorAll(".vm-children").length, 0, "空容器应被移除");

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
const holder4 = Array.from(fresh.children).find((el) => el.classList.contains("vm-children"));
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
const holder5 = Array.from(fresh.children).find((el) => el.classList.contains("vm-children"));
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

import { App, Menu, Notice, TAbstractFile, TFile, TFolder, setIcon } from "obsidian";
import type { MenuItem } from "obsidian";
import { t } from "./i18n";
import { cleanPath } from "./types";
import type { Mount, Settings } from "./types";

export interface TreeHost {
  settings: Settings;
  saveSettings(): Promise<void>;
  removeMount(id: string): void;
}

/** 标记“这是我们画的节点”，用于区分核心渲染的节点、并避免自触发。 */
const ATTR_ROLE = "data-vm-role";
const ATTR_ID = "data-vm-id";
const ATTR_SRC = "data-vm-src";
const ATTR_CONTAINER = "data-vm-container";
const ROLE_ROOT = "root";

/** 我们自己的挂载容器（核心的虚拟滚动只会动它自己的 childrenEl，不会动这里）。 */
const HOLDER_CLASS = "vm-children";

/** 核心文件浏览器视图的类型。 */
const EXPLORER_VIEW_TYPE = "file-explorer";

/**
 * 核心文件浏览器视图上我们用到的那部分私有 API。
 *
 * 核心的右键菜单（新建笔记 / 新建文件夹 / 重命名 / 删除 / 移动 / 复制……）
 * 不是通过 `file-menu` 事件添加的，而是 `onFileContextMenu()` 里直接构造的。
 * 想“等效于长按真实目录”，只能把真实的 TAbstractFile 交回给核心的这个方法，
 * 让核心自己按它平时的逻辑生成菜单。方法不存在时再退回插件自己的精简菜单。
 */
interface FileExplorerView {
  containerEl?: HTMLElement;
  /** 核心为每个真实条目保存的渲染对象；新版本菜单会把它当成菜单的“父元素”。 */
  fileItems?: Record<string, unknown>;
  onFileContextMenu?: (evt: MouseEvent, file: TAbstractFile) => void;
}

/**
 * 把虚拟挂载点注入原生文件浏览器的 DOM。
 *
 * 背景（Obsidian 1.8.x / 1.14.x 实测结构）：
 *   div.tree-item.nav-folder
 *     div.tree-item-self.nav-folder-title[data-path] > div.tree-item-inner
 *     div.tree-item-children.nav-folder-children   ← 由虚拟滚动 setChildrenInPlace 独占管理
 *
 * 所以绝不能把节点塞进 .nav-folder-children：滚动时会被整体替换掉。
 * 这里在 .nav-folder 下另挂一个同胞容器 .vm-children（同样带 tree-item-children 类，
 * 缩进和引导线保持一致），只由我们管理，核心不会碰。
 */
export class VirtualTree {
  private observers = new Map<HTMLElement, MutationObserver>();
  private dirty = new Set<string>();
  private timer: number | null = null;
  private stopped = false;

  /**
   * 虚拟子目录的展开状态，按「挂载 id + 源路径」记忆。
   *
   * 原生文件浏览器只展开用户点开的目录，并记住每个目录的开合状态；
   * 这里用同样的规则：没见过的目录默认折叠，展开过的目录在父目录折叠/展开、
   * 甚至核心重建 DOM 之后仍保持展开。挂载根节点自己的状态存在 mount.collapsed 里。
   */
  private expanded = new Map<string, boolean>();

  constructor(private app: App, private host: TreeHost) {}

  private get settings(): Settings {
    return this.host.settings;
  }

  /* ---------------------------------------------------------------- 生命周期 */

  start(): void {
    this.stopped = false;
    this.syncNow(true);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    for (const obs of this.observers.values()) obs.disconnect();
    this.observers.clear();
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>(`[${ATTR_ROLE}="${ROLE_ROOT}"]`)
    )) {
      el.remove();
    }
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>(`.${HOLDER_CLASS}`)
    )) {
      el.remove();
    }
    this.expanded.clear();
  }

  /** 仓库结构变化时调用：只把受影响的挂载标记为需要重建。 */
  markAffected(path: string): void {
    if (!path) return;
    for (const m of this.settings.mounts) {
      if (!m.source) continue;
      if (m.kind === "file") {
        if (path === m.source) this.dirty.add(m.id);
      } else if (path === m.source || path.startsWith(m.source + "/")) {
        this.dirty.add(m.id);
      }
    }
    this.schedule();
  }

  schedule(delay = 90): void {
    if (this.stopped) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.syncNow(false);
    }, delay);
  }

  /* ------------------------------------------------------------------ 主同步 */

  syncNow(force = false): void {
    if (this.stopped) return;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }

    this.pruneExpanded();
    const containers = this.containers();
    if (containers.length === 0) return;

    const rebuild = force
      ? new Set(this.settings.mounts.map((m) => m.id))
      : new Set(this.dirty);

    const handled = new Set<string>();
    for (const container of containers) {
      this.observe(container);
      this.inject(container, rebuild, handled);
    }

    // 没能注入的（目标文件夹当前没有渲染出来）留到下次，避免出现陈旧节点
    const pending = new Set<string>();
    for (const id of rebuild) if (!handled.has(id)) pending.add(id);
    this.dirty = pending;

    this.highlightActive();
  }

  private containers(): HTMLElement[] {
    const scoped = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.workspace-leaf-content[data-type="file-explorer"] .nav-files-container'
      )
    );
    const all = scoped.length
      ? scoped
      : Array.from(document.querySelectorAll<HTMLElement>(".nav-files-container"));
    return all.filter((el) => el.isConnected);
  }

  /**
   * 核心每次重绘都会重建部分 DOM，我们跟着重新注入。
   * 只监听“非虚拟节点”的增删，避免自己插入时反复触发。
   */
  private observe(container: HTMLElement): void {
    if (this.observers.has(container)) return;
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const nodes = [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)];
        for (const n of nodes) {
          const el = n as HTMLElement;
          if (!el || el.nodeType !== 1) continue;
          if (el.hasAttribute?.(ATTR_ROLE)) continue;
          if (el.hasAttribute?.(ATTR_CONTAINER)) continue;
          if (el.closest?.(`[${ATTR_ROLE}]`)) continue;
          if (el.closest?.(`[${ATTR_CONTAINER}]`)) continue;
          this.schedule(60);
          return;
        }
      }
    });
    obs.observe(container, { childList: true, subtree: true });
    this.observers.set(container, obs);
  }

  /* -------------------------------------------------------------- 注入单个窗格 */

  private inject(container: HTMLElement, rebuild: Set<string>, handled: Set<string>): void {
    const mounts = this.settings.mounts.filter((m) => m.enabled && m.source);
    if (mounts.length === 0) {
      this.clearContainer(container);
      return;
    }

    const anchors = this.buildAnchorMap(container);
    const live = new Set<string>();

    for (const mount of mounts) {
      const src = this.resolve(mount.source);
      if (!src) continue;
      if (mount.kind === "folder" && !(src instanceof TFolder)) continue;
      if (mount.kind === "file" && !(src instanceof TFile)) continue;

      const folderEl = anchors.get(cleanPath(mount.under) || "/") ?? null;
      if (!folderEl) continue;

      live.add(mount.id);
      handled.add(mount.id);
      const holder = this.holderOf(folderEl);

      const existing = holder.querySelector<HTMLElement>(
        `[${ATTR_ROLE}="${ROLE_ROOT}"][${ATTR_ID}="${mount.id}"]`
      );
      if (existing && existing.parentElement === holder && !rebuild.has(mount.id)) continue;

      existing?.remove();
      let node: HTMLElement | null = null;
      if (src instanceof TFolder) node = this.buildFolder(mount, src, true, mount.id);
      else if (src instanceof TFile) node = this.buildFile(mount, src, true);
      if (!node) continue;

      holder.appendChild(node);
      this.orderHolder(holder);
    }

    // 清理失效挂载点与空容器
    for (const el of Array.from(
      container.querySelectorAll<HTMLElement>(`[${ATTR_ROLE}="${ROLE_ROOT}"]`)
    )) {
      if (!live.has(el.dataset.vmId ?? "")) el.remove();
    }
    for (const el of Array.from(container.querySelectorAll<HTMLElement>(`.${HOLDER_CLASS}`))) {
      if (el.childElementCount === 0) el.remove();
    }
  }

  private clearContainer(container: HTMLElement): void {
    for (const el of Array.from(
      container.querySelectorAll<HTMLElement>(`[${ATTR_ROLE}="${ROLE_ROOT}"]`)
    )) {
      el.remove();
    }
    for (const el of Array.from(container.querySelectorAll<HTMLElement>(`.${HOLDER_CLASS}`))) {
      el.remove();
    }
  }

  /** 一次遍历建好 path -> .nav-folder 映射，避免每个挂载都全树扫描。 */
  private buildAnchorMap(container: HTMLElement): Map<string, HTMLElement> {
    const map = new Map<string, HTMLElement>();
    const titles = container.querySelectorAll<HTMLElement>(".nav-folder-title[data-path]");
    for (const title of Array.from(titles)) {
      if (title.hasAttribute(ATTR_ROLE)) continue;
      const path = title.getAttribute("data-path");
      if (!path) continue;
      const folderEl = title.closest<HTMLElement>(".nav-folder");
      if (folderEl) map.set(path, folderEl);
    }
    // 兼容旧版把 data-path 放在 .nav-folder 自身上的结构
    for (const folderEl of Array.from(
      container.querySelectorAll<HTMLElement>(".nav-folder[data-path]")
    )) {
      if (folderEl.hasAttribute(ATTR_ROLE)) continue;
      const path = folderEl.getAttribute("data-path");
      if (path && !map.has(path)) map.set(path, folderEl);
    }
    if (!map.has("/")) {
      const root = container.querySelector<HTMLElement>(".nav-folder");
      if (root && !root.hasAttribute(ATTR_ROLE)) map.set("/", root);
    }
    return map;
  }

  /**
   * 取得/创建我们自己的子容器（核心的虚拟滚动不会碰它）。
   *
   * 位置固定在标题之后、核心 children 之前：
   * 核心展开文件夹时执行的是 `folderEl.appendChild(childrenEl)`，
   * 放在前面才能保证「先挂载块、后真实内容」的相对顺序永远不变。
   */
  private holderOf(folderEl: HTMLElement): HTMLElement {
    for (const child of Array.from(folderEl.children)) {
      if (child instanceof HTMLElement && child.classList.contains(HOLDER_CLASS)) return child;
    }
    // 只用 tree-item-children 拿缩进与引导线；刻意不加 nav-folder-children，
    // 避免核心或第三方插件用该选择器查询时误拿到我们的容器。
    const holder = createDiv({ cls: `tree-item-children ${HOLDER_CLASS}` });
    holder.setAttribute(ATTR_CONTAINER, "1");
    const anchor = folderEl.children[1] ?? null;
    folderEl.insertBefore(holder, anchor);
    return holder;
  }

  /** 同一文件夹下的多个挂载点内部排序。 */
  private orderHolder(holder: HTMLElement): void {
    const nodes = Array.from(holder.children) as HTMLElement[];
    if (nodes.length < 2) return;
    const foldersFirst = this.settings.foldersFirst;
    nodes.sort((a, b) => {
      if (foldersFirst) {
        const fa = a.classList.contains("nav-folder") ? 0 : 1;
        const fb = b.classList.contains("nav-folder") ? 0 : 1;
        if (fa !== fb) return fa - fb;
      }
      const na = a.dataset.vmName ?? "";
      const nb = b.dataset.vmName ?? "";
      return na.localeCompare(nb, undefined, { numeric: true, sensitivity: "base" });
    });
    for (const node of nodes) holder.appendChild(node);
  }

  /* ------------------------------------------------------------------ 构造节点 */

  private buildFolder(
    mount: Mount | null,
    folder: TFolder,
    isRoot: boolean,
    ownerId: string
  ): HTMLElement {
    // 挂载根节点沿用配置里持久化的开合状态；子目录只有在本次会话里被展开过才展开，
    // 否则一律折叠——和原生文件浏览器一样，不会把整棵树一次性摊开。
    const collapsed = isRoot && mount ? mount.collapsed : !this.isExpanded(ownerId, folder.path);

    const el = createDiv({ cls: "tree-item nav-folder vm-folder" });
    if (isRoot && mount) {
      el.setAttribute(ATTR_ROLE, ROLE_ROOT);
      el.setAttribute(ATTR_ID, mount.id);
      el.dataset.vmName = mount.name;
    }
    if (collapsed) el.addClass("is-collapsed");

    const title = el.createDiv({
      cls: "tree-item-self nav-folder-title is-clickable mod-collapsible vm-folder-title",
    });
    if (isRoot && mount) {
      title.setAttribute(ATTR_ROLE, ROLE_ROOT);
      title.setAttribute(ATTR_ID, mount.id);
    }
    title.setAttribute(ATTR_SRC, folder.path);

    const icon = title.createDiv({ cls: "tree-item-icon collapse-icon" });
    setIcon(icon, "right-triangle");
    if (collapsed) icon.addClass("is-collapsed");

    title
      .createDiv({ cls: "tree-item-inner nav-folder-title-content" })
      .setText(mount ? mount.name : folder.name);

    if (this.settings.showBadge) {
      this.addBadge(title, t("badge.tooltip", { path: folder.path }));
    }

    const childrenEl = el.createDiv({
      cls: "tree-item-children nav-folder-children vm-children-inner",
    });

    const toggle = (evt: MouseEvent) => {
      evt.preventDefault();
      evt.stopPropagation();
      const nowCollapsed = !el.hasClass("is-collapsed");
      el.toggleClass("is-collapsed", nowCollapsed);
      icon.toggleClass("is-collapsed", nowCollapsed);
      if (mount && isRoot) {
        mount.collapsed = nowCollapsed;
        void this.host.saveSettings();
      } else {
        // 记住子目录的开合状态：父目录折叠后再展开，这里仍然保持原样。
        this.setExpanded(ownerId, folder.path, !nowCollapsed);
      }
      if (!nowCollapsed && childrenEl.childElementCount === 0) {
        this.fill(childrenEl, folder, ownerId);
      }
    };
    title.addEventListener("click", toggle);

    title.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      // 把真实文件夹交给核心：菜单里的新建 / 重命名 / 删除等操作都作用于源目录。
      this.showSourceMenu(evt, folder, isRoot ? mount : null);
    });

    if (!collapsed) this.fill(childrenEl, folder, ownerId);
    return el;
  }

  /**
   * 渲染某一层子节点。子目录只会画出一个折叠的标题，内容等用户点开时才再调用
   * `fill()`，所以大目录不会在打开挂载的一瞬间被递归展开。
   */
  private fill(childrenEl: HTMLElement, folder: TFolder, ownerId: string): void {
    childrenEl.empty();
    const max = Math.max(20, this.settings.maxChildren);
    const items = this.sortItems(folder.children);
    const shown = items.slice(0, max);

    for (const child of shown) {
      if (child instanceof TFolder) {
        childrenEl.appendChild(this.buildFolder(null, child, false, ownerId));
      } else if (child instanceof TFile) {
        childrenEl.appendChild(this.buildFile(null, child, false));
      }
    }

    if (items.length > shown.length) {
      const more = childrenEl.createDiv({ cls: "vm-more" });
      more.setText(t("more.items", { count: items.length - shown.length }));
      more.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.reveal(folder);
      });
    }
  }

  private buildFile(mount: Mount | null, file: TFile, isRoot: boolean): HTMLElement {
    const el = createDiv({ cls: "tree-item nav-file vm-file" });
    if (isRoot && mount) {
      el.setAttribute(ATTR_ROLE, ROLE_ROOT);
      el.setAttribute(ATTR_ID, mount.id);
      el.dataset.vmName = mount.name;
    }

    const title = el.createDiv({
      cls: "tree-item-self nav-file-title tappable is-clickable vm-file-title",
    });
    if (isRoot && mount) {
      title.setAttribute(ATTR_ROLE, ROLE_ROOT);
      title.setAttribute(ATTR_ID, mount.id);
    }
    title.setAttribute(ATTR_SRC, file.path);

    title
      .createDiv({ cls: "tree-item-inner nav-file-title-content" })
      .setText(mount ? mount.name : file.basename);

    if (this.settings.showBadge) {
      this.addBadge(title, t("badge.tooltip", { path: file.path }));
    }

    const open = (evt: MouseEvent) => {
      evt.preventDefault();
      evt.stopPropagation();
      const newLeaf = evt.button === 1 || evt.ctrlKey || evt.metaKey;
      void this.openFile(file, newLeaf);
    };
    title.addEventListener("click", (evt) => {
      if (evt.button !== 0) return;
      open(evt);
    });
    title.addEventListener("auxclick", (evt) => {
      if (evt.button === 1) open(evt);
    });
    title.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      // 单文件挂载的根节点也要把真实文件交回核心，菜单操作同样作用于源文件。
      this.showSourceMenu(evt, file, isRoot ? mount : null);
    });

    return el;
  }

  private addBadge(title: HTMLElement, tooltip: string): void {
    const outer = title.createDiv({ cls: "tree-item-flair-outer" });
    const badge = outer.createDiv({ cls: "tree-item-flair vm-badge" });
    badge.setText("↪");
    badge.setAttr("title", tooltip);
    badge.setAttr("aria-label", tooltip);
  }

  /* -------------------------------------------------------------------- 交互 */

  private async openFile(file: TFile, newLeaf: boolean): Promise<void> {
    const leaf = this.app.workspace.getLeaf(newLeaf ? "tab" : false);
    await leaf.openFile(file);
    if (this.settings.revealOnOpen) {
      window.setTimeout(() => this.reveal(file), 40);
    }
    this.highlightActive();
  }

  /** 尽量调用核心的“在文件浏览器中定位”，失败就退化成命令。 */
  private reveal(file: TAbstractFile): void {
    const app = this.app as unknown as {
      internalPlugins?: {
        getEnabledPluginById?: (id: string) => { revealInFolder?: (f: TAbstractFile) => void } | null;
        getPluginById?: (id: string) => {
          instance?: { revealInFolder?: (f: TAbstractFile) => void };
        };
      };
      commands?: { executeCommandById?: (id: string) => boolean };
    };
    try {
      const view =
        app.internalPlugins?.getEnabledPluginById?.("file-explorer") ??
        app.internalPlugins?.getPluginById?.("file-explorer")?.instance;
      if (typeof view?.revealInFolder === "function") {
        view.revealInFolder(file);
        return;
      }
    } catch {
      /* 内部 API 变动时忽略 */
    }
    try {
      app.commands?.executeCommandById?.("file-explorer:reveal-active-file");
    } catch {
      /* ignore */
    }
  }

  highlightActive(): void {
    const active = this.app.workspace.getActiveFile();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".vm-file-title"))) {
      el.toggleClass("is-active", !!active && el.getAttribute(ATTR_SRC) === active.path);
    }
  }

  /**
   * 在虚拟节点上长按/右键时，弹出与「长按真实目录/文件」等效的原生菜单。
   *
   * 核心的菜单项（新建笔记 / 新建文件夹 / 重命名 / 移动 / 删除……）不是在
   * `file-menu` 事件里加的，而是文件浏览器视图的 `onFileContextMenu()`
   * 内部直接构造的。所以这里把真实的 TAbstractFile 交回核心，让核心用
   * 它平时的逻辑生成菜单；同时用一次性的 `file-menu` 监听补上插件自己的
   * 「定位 / 复制真实路径 / 取消挂载」。
   */
  private showSourceMenu(evt: MouseEvent, target: TAbstractFile, mount: Mount | null): void {
    const view = this.explorerView(evt);
    if (!view?.onFileContextMenu) {
      this.showFallbackMenu(evt, target, mount);
      return;
    }

    const ref = this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
      if (file !== target) return;
      this.addVirtualMenuItems(menu, target, mount);
    });

    /*
     * Obsidian 1.14 起，核心的 onFileContextMenu 会把菜单“挂”到真实条目的 DOM 上：
     *   i.setParentElement(f.selfEl)
     * 菜单会在 500ms 后检查这个父元素是否还可见，不可见就自动关闭。
     * 虚拟挂载的源目录通常折叠在别处、并不在屏幕上，菜单就会刚出现就消失。
     *
     * 这里在调用核心生成菜单期间临时把这个条目的渲染对象藏起来，核心就不会
     * 设置 parentEl（也不会滚动/聚焦到真实位置），调用结束后立刻还原。
     */
    const items = view.fileItems;
    const hidden = !!items && Object.prototype.hasOwnProperty.call(items, target.path);
    const item = hidden ? items![target.path] : undefined;
    if (hidden) delete items![target.path];

    try {
      view.onFileContextMenu(evt, target);
    } catch {
      // 核心私有 API 变动时不要吞掉右键菜单，退回插件自己的版本。
      this.showFallbackMenu(evt, target, mount);
    } finally {
      if (hidden) items![target.path] = item;
      this.app.workspace.offref(ref);
    }
  }

  /** 找到当前正在显示这个虚拟节点的文件浏览器视图（多窗口/多窗格时取所属的那个）。 */
  private explorerView(evt: MouseEvent): FileExplorerView | null {
    let views: FileExplorerView[] = [];
    try {
      views = this.app.workspace
        .getLeavesOfType(EXPLORER_VIEW_TYPE)
        .map((leaf) => leaf.view as unknown as FileExplorerView)
        .filter((view) => typeof view?.onFileContextMenu === "function");
    } catch {
      return null;
    }
    const target = (evt.target as Node | null) ?? null;
    if (target) {
      const owner = views.find((view) => view.containerEl?.contains(target));
      if (owner) return owner;
    }
    return views[0] ?? null;
  }

  /** 在核心生成的原生菜单里追加插件自己的项目。 */
  private addVirtualMenuItems(menu: Menu, target: TAbstractFile, mount: Mount | null): void {
    const isFolder = target instanceof TFolder;
    menu.addItem((i) => {
      i.setTitle(t(isFolder ? "menu.revealFolder" : "menu.revealFile"))
        .setIcon("folder-open")
        .onClick(() => this.reveal(target));
      this.setMenuSection(i, "view");
    });
    menu.addItem((i) => {
      i.setTitle(t("menu.copyPath"))
        .setIcon("clipboard")
        .onClick(() => this.copyPath(target.path));
      this.setMenuSection(i, "action");
    });
    if (mount) {
      menu.addItem((i) => {
        i.setTitle(t("menu.unmount"))
          .setIcon("unlink")
          .onClick(() => this.host.removeMount(mount.id));
        // 放在 system 区而不是 danger 区：它只移除虚拟挂载，不删除源文件。
        this.setMenuSection(i, "system");
      });
    }
  }

  /** 核心视图不可用时（或未来改掉私有方法）至少保留插件原本的菜单。 */
  private showFallbackMenu(evt: MouseEvent, target: TAbstractFile, mount: Mount | null): void {
    const menu = new Menu();
    const isFolder = target instanceof TFolder;
    menu.addItem((i) =>
      i
        .setTitle(t(isFolder ? "menu.revealFolder" : "menu.revealFile"))
        .setIcon("folder-open")
        .onClick(() => this.reveal(target))
    );
    menu.addItem((i) =>
      i.setTitle(t("menu.copyPath")).setIcon("clipboard").onClick(() => this.copyPath(target.path))
    );
    if (mount) {
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle(t("menu.unmount"))
          .setIcon("unlink")
          .onClick(() => this.host.removeMount(mount.id))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  private setMenuSection(item: MenuItem, section: string): void {
    try {
      item.setSection?.(section);
    } catch {
      /* 老版本没有 setSection，忽略 */
    }
  }

  /**
   * 复制到剪贴板。移动端 WebView 里 navigator.clipboard 可能不可用或被拒绝，
   * 这里退回到 textarea + execCommand，保证手机长按菜单里的「复制真实路径」也能用。
   */
  private copyPath(path: string): void {
    const fallback = () => {
      try {
        const area = document.createElement("textarea");
        area.value = path;
        area.className = "vm-clip-helper";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        if (!ok) new Notice(t("notice.copyFailed"));
      } catch {
        new Notice(t("notice.copyFailed"));
      }
    };

    try {
      const clipboard = navigator.clipboard;
      if (clipboard?.writeText) {
        clipboard.writeText(path).catch(fallback);
        return;
      }
    } catch {
      /* 忽略，走 fallback */
    }
    fallback();
  }

  /* ------------------------------------------------------------------ 工具函数 */

  private stateKey(ownerId: string, path: string): string {
    return `${ownerId}\u0000${path}`;
  }

  private isExpanded(ownerId: string, path: string): boolean {
    return this.expanded.get(this.stateKey(ownerId, path)) === true;
  }

  private setExpanded(ownerId: string, path: string, expanded: boolean): void {
    this.expanded.set(this.stateKey(ownerId, path), expanded);
  }

  /** 挂载被删掉后清掉它的展开状态，避免缓存无限增长。 */
  private pruneExpanded(): void {
    if (this.expanded.size === 0) return;
    const ids = new Set(this.settings.mounts.map((m) => m.id));
    for (const key of Array.from(this.expanded.keys())) {
      if (!ids.has(key.slice(0, key.indexOf("\u0000")))) this.expanded.delete(key);
    }
  }

  private resolve(path: string): TAbstractFile | null {
    const p = cleanPath(path);
    if (!p) return this.app.vault.getRoot();
    return this.app.vault.getAbstractFileByPath(p) ?? null;
  }

  private sortItems(children: TAbstractFile[]): TAbstractFile[] {
    const foldersFirst = this.settings.foldersFirst;
    return [...children].sort((a, b) => {
      if (foldersFirst) {
        const fa = a instanceof TFolder ? 0 : 1;
        const fb = b instanceof TFolder ? 0 : 1;
        if (fa !== fb) return fa - fb;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  }
}

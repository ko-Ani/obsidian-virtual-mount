import { App, Menu, Notice, TAbstractFile, TFile, TFolder, setIcon } from "obsidian";
import { t } from "./i18n";
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

/**
 * 把虚拟挂载点注入原生文件浏览器的 DOM。
 *
 * 背景（Obsidian 1.8.x 实测结构）：
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

      const folderEl = anchors.get(this.normalize(mount.under) || "/") ?? null;
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
      if (src instanceof TFolder) node = this.buildFolder(mount, src, true, mount.collapsed);
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
    collapsed: boolean
  ): HTMLElement {
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
      }
      if (!nowCollapsed && childrenEl.childElementCount === 0) {
        this.fill(childrenEl, folder);
      }
    };
    title.addEventListener("click", toggle);

    title.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (mount && isRoot) this.showFolderMenu(evt, mount, folder);
    });

    if (!collapsed) this.fill(childrenEl, folder);
    return el;
  }

  private fill(childrenEl: HTMLElement, folder: TFolder): void {
    childrenEl.empty();
    const max = Math.max(20, this.settings.maxChildren);
    const items = this.sortItems(folder.children);
    const shown = items.slice(0, max);

    for (const child of shown) {
      if (child instanceof TFolder) {
        childrenEl.appendChild(this.buildFolder(null, child, false, false));
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
      this.showFileMenu(evt, mount, file);
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

  private showFolderMenu(evt: MouseEvent, mount: Mount, folder: TFolder): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle(t("menu.revealFolder"))
        .setIcon("folder-open")
        .onClick(() => this.reveal(folder))
    );
    menu.addItem((i) =>
      i
        .setTitle(t("menu.copyPath"))
        .setIcon("clipboard")
        .onClick(() => this.copyPath(folder.path))
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle(t("menu.unmount")).setIcon("trash").onClick(() => this.host.removeMount(mount.id))
    );
    menu.showAtMouseEvent(evt);
  }

  private showFileMenu(evt: MouseEvent, mount: Mount | null, file: TFile): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle(t("menu.revealFile"))
        .setIcon("folder-open")
        .onClick(() => this.reveal(file))
    );
    menu.addItem((i) =>
      i
        .setTitle(t("menu.copyPath"))
        .setIcon("clipboard")
        .onClick(() => this.copyPath(file.path))
    );
    if (mount) {
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle(t("menu.unmount"))
          .setIcon("trash")
          .onClick(() => this.host.removeMount(mount.id))
      );
    }
    menu.showAtMouseEvent(evt);
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
        area.style.position = "fixed";
        area.style.opacity = "0";
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

  private normalize(path: string): string {
    return (path ?? "").trim().replace(/^\/+|\/+$/g, "");
  }

  private resolve(path: string): TAbstractFile | null {
    const p = this.normalize(path);
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

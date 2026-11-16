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
/** 节点内容签名：挂载配置或源路径一变就重建，否则复用（避免整层重建带来的闪烁）。 */
const ATTR_SIG = "data-vm-sig";
const ROLE_ROOT = "root";

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
 *     div.tree-item-children.nav-folder-children   ← 由虚拟滚动 setChildrenInPlace 管理
 *
 * 挂载行必须和真实条目排在同一份列表里（否则只能固定在顶部），所以直接插进
 * .nav-folder-children，并按名称插到正确位置。
 *
 * 代价是：核心重绘（滚动、展开、排序变化）会整层替换这个容器，把挂载行一起清掉。
 * 为了不闪，做了三件事：
 *   1. 在 MutationObserver 回调里**同步**补注入 —— 回调是微任务，浏览器还没绘制，
 *      用户看不到“消失了一下”的中间态；绝不能丢给 setTimeout（那会等到下一帧之后）；
 *   2. 被清掉的节点先缓存起来，补注入时原样放回（展开状态、子节点都不用重建）；
 *   3. 只有内容签名变化时才重建节点，普通的同步 / 排序调整只移动位置。
 */
export class VirtualTree {
  private observers = new Map<HTMLElement, MutationObserver>();
  private dirty = new Set<string>();
  private timer: number | null = null;
  private frame: number | null = null;
  private stopped = false;

  /**
   * 被核心整层重绘清掉的挂载节点，按窗格缓存。
   * 补注入时直接放回同一个节点，既不会闪，也不会丢掉已展开的子目录。
   */
  private detached = new Map<HTMLElement, Map<string, HTMLElement>>();

  /** 我们自己从 DOM 上摘下来的节点，observer 不该把这种移除当成“核心清掉了”。 */
  private selfRemoved = new WeakSet<Node>();

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
    this.cancelPending();
    for (const obs of this.observers.values()) obs.disconnect();
    this.observers.clear();
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>(`[${ATTR_ROLE}="${ROLE_ROOT}"]`)
    )) {
      this.selfRemoved.add(el);
      el.remove();
    }
    this.detached.clear();
    this.dirty.clear();
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

  /** 单个挂载的配置变了（改名、改挂载点、换源）：下次同步时重建它。 */
  invalidate(id: string): void {
    this.dirty.add(id);
    this.schedule(0);
  }

  schedule(delay = 90): void {
    if (this.stopped) return;
    this.cancelPending();
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.syncNow(false);
    }, delay);
  }

  /**
   * 下一帧绘制前补一次同步。
   *
   * 用 rAF 而不是 setTimeout：浏览器执行完 rAF 回调才绘制，所以这次补注入和
   * 核心的重绘在同一帧内完成，用户看不到列表闪一下。
   */
  private scheduleFrame(): void {
    if (this.stopped || this.frame !== null) return;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const run = (): void => {
      this.frame = null;
      this.syncNow(false);
    };
    if (typeof window.requestAnimationFrame === "function") {
      this.frame = window.requestAnimationFrame(run);
    } else {
      this.timer = window.setTimeout(run, 16);
    }
  }

  private cancelPending(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.frame !== null) {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(this.frame);
      }
      this.frame = null;
    }
  }

  /* ------------------------------------------------------------------ 主同步 */

  syncNow(force = false): void {
    if (this.stopped) return;
    this.cancelPending();

    this.pruneExpanded();
    const containers = this.containers();
    if (containers.length === 0) {
      this.detached.clear();
      return;
    }

    const rebuild = force
      ? new Set(this.settings.mounts.map((m) => m.id))
      : new Set(this.dirty);

    const handled = new Set<string>();
    for (const container of containers) {
      this.observe(container);
      this.inject(container, rebuild, handled);
    }

    // 没缓存的窗格节点没有意义了，顺手清掉，避免缓存越积越多
    for (const key of Array.from(this.detached.keys())) {
      if (!key.isConnected) this.detached.delete(key);
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
   *
   * - 我们画的挂载行被移出（核心整层替换 children、或整个文件夹节点被重建）：
   *   **立刻**同步补注入。回调是微任务，浏览器此时还没绘制，所以不会闪。
   * - 真实条目的增删（新建 / 删除 / 展开）：下一帧绘制前补一次就够了。
   * - 我们自己移动 / 替换的节点不算“变化”，否则会自触发。
   */
  private observe(container: HTMLElement): void {
    if (this.observers.has(container)) return;
    const obs = new MutationObserver((mutations) => this.onMutations(container, mutations));
    obs.observe(container, { childList: true, subtree: true });
    this.observers.set(container, obs);
  }

  private onMutations(container: HTMLElement, mutations: MutationRecord[]): void {
    if (this.stopped || !container.isConnected) return;

    const lost: HTMLElement[] = [];
    let structural = false;

    for (const m of mutations) {
      for (const n of Array.from(m.removedNodes)) {
        if (this.selfRemoved.has(n)) continue;
        /*
         * 判据是「回调执行时它还连在文档上吗」，而不是「同一批里有没有被重新加回来」。
         * 我们自己 place() 挪动节点是「先移除再插入」，回调时它仍然连着，跳过；
         * 而核心整层替换时，挂载行会真的掉出文档，就一定要补回去。
         */
        if ((n as Element).isConnected) continue;
        const roots = this.mountRootsIn(n);
        if (roots.length) {
          lost.push(...roots);
          continue;
        }
        if (n.nodeType === 1) structural = true;
      }
    }

    if (lost.length) {
      // 先把被清掉的节点收好，补注入时原样放回（展开状态也跟着保留）。
      const cache = this.cacheFor(container);
      for (const el of lost) {
        const id = el.dataset.vmId;
        if (id) cache.set(id, el);
      }
      // 同步补注入：不留出任何一帧让用户看到挂载行消失。
      this.syncNow(false);
      return;
    }

    if (structural) this.scheduleFrame();
  }

  /* -------------------------------------------------------------- 注入单个窗格 */

  private inject(container: HTMLElement, rebuild: Set<string>, handled: Set<string>): void {
    const mounts = this.settings.mounts.filter((m) => m.enabled && m.source);
    const cache = this.cacheFor(container);
    if (mounts.length === 0) {
      this.clearContainer(container);
      cache.clear();
      return;
    }

    const anchors = this.buildAnchorMap(container);
    const live = new Set<string>();
    const placed = new Map<string, HTMLElement>();

    for (const mount of mounts) {
      const src = this.resolve(mount.source);
      if (!src) continue;
      if (mount.kind === "folder" && !(src instanceof TFolder)) continue;
      if (mount.kind === "file" && !(src instanceof TFile)) continue;

      const folderEl = anchors.get(cleanPath(mount.under) || "/") ?? null;
      if (!folderEl) continue;

      // 目标文件夹折叠时核心可能根本不渲染 childrenEl；留到下次（展开会触发 observer）。
      const childrenEl = this.coreChildrenOf(folderEl);
      if (!childrenEl) continue;

      live.add(mount.id);
      const sig = this.signatureOf(mount, src);

      let node = childrenEl.querySelector<HTMLElement>(
        `:scope > [${ATTR_ROLE}="${ROLE_ROOT}"][${ATTR_ID}="${mount.id}"]`
      );
      if (node && (rebuild.has(mount.id) || node.getAttribute(ATTR_SIG) !== sig)) {
        this.discard(node, cache, mount.id);
        node = null;
      }

      // 被核心清掉的旧节点可以直接复用：内容和签名都对得上时不再重建。
      if (!node) {
        const cached = cache.get(mount.id);
        if (cached && !cached.isConnected && cached.getAttribute(ATTR_SIG) === sig) {
          node = cached;
        }
      }
      if (!node) node = this.buildRoot(mount, src);
      if (!node) continue;

      node.setAttribute(ATTR_SIG, sig);
      cache.set(mount.id, node);
      placed.set(mount.id, node);
      // 只在位置不对时移动；正常同步不动 DOM，避免触发多余的 mutation。
      this.place(node, childrenEl);
      handled.add(mount.id);
    }

    // 清理失效挂载点（已删除 / 已停用 / 源文件不存在 / 挂在旧位置上的重复节点）
    for (const el of Array.from(
      container.querySelectorAll<HTMLElement>(`[${ATTR_ROLE}="${ROLE_ROOT}"]`)
    )) {
      // 只有真正的行容器（.tree-item）才是挂载根节点；标题元素也带同一个标记，
      // 但它们必须留在行里面，不能当成“重复节点”删掉。
      if (!el.classList.contains("tree-item")) continue;
      const id = el.dataset.vmId ?? "";
      const current = placed.get(id);
      if (!live.has(id) || (current && current !== el)) {
        this.selfRemoved.add(el);
        el.remove();
      }
    }
    // 只丢掉“配置里已经没有这个挂载”的缓存；目标文件夹暂时折叠时留着，
    // 重新展开时可以直接放回同一个节点（展开状态不会丢）。
    const known = new Set(this.settings.mounts.map((m) => m.id));
    for (const id of Array.from(cache.keys())) {
      if (!known.has(id)) cache.delete(id);
    }
  }

  private buildRoot(mount: Mount, src: TAbstractFile): HTMLElement | null {
    if (src instanceof TFolder) return this.buildFolder(mount, src, true, mount.id);
    if (src instanceof TFile) return this.buildFile(mount, src, true);
    return null;
  }

  /** 节点内容签名：源路径、显示名、角标开关任一变化都需要重建。 */
  private signatureOf(mount: Mount, src: TAbstractFile): string {
    return [mount.kind, src.path, mount.name, this.settings.showBadge ? "b" : "-"].join("\u0000");
  }

  private cacheFor(container: HTMLElement): Map<string, HTMLElement> {
    let cache = this.detached.get(container);
    if (!cache) {
      cache = new Map();
      this.detached.set(container, cache);
    }
    return cache;
  }

  private discard(node: HTMLElement, cache: Map<string, HTMLElement>, id: string): void {
    this.selfRemoved.add(node);
    node.remove();
    if (cache.get(id) === node) cache.delete(id);
  }

  private clearContainer(container: HTMLElement): void {
    for (const el of Array.from(
      container.querySelectorAll<HTMLElement>(`[${ATTR_ROLE}="${ROLE_ROOT}"]`)
    )) {
      if (!el.classList.contains("tree-item")) continue;
      this.selfRemoved.add(el);
      el.remove();
    }
  }

  /** 一个被移除的节点里包含哪些挂载根节点（核心可能一次摘掉整棵子树）。 */
  private mountRootsIn(node: Node): HTMLElement[] {
    const el = node as HTMLElement;
    if (!el || el.nodeType !== 1) return [];
    if (typeof el.getAttribute !== "function") return [];
    if (el.getAttribute(ATTR_ROLE) === ROLE_ROOT && el.classList.contains("tree-item")) {
      return [el];
    }
    if (typeof el.querySelectorAll !== "function") return [];
    return Array.from(el.querySelectorAll<HTMLElement>(`[${ATTR_ROLE}="${ROLE_ROOT}"]`));
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
   * 核心真正管理的那层 children。
   *
   * 只有 `.nav-folder` 的直接子元素才可能是核心的 childrenEl；虚拟文件夹内部
   * 也有 `nav-folder-children`，但它们在更深的层级，不会被这里误取。
   * 目标文件夹没展开时核心不会渲染它，返回 null。
   */
  private coreChildrenOf(folderEl: HTMLElement): HTMLElement | null {
    for (const child of Array.from(folderEl.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.classList.contains("nav-folder-children")) return child;
    }
    return null;
  }

  /** 排序用的名字：虚拟节点用显示名称，真实节点用路径最后一段（带扩展名，和核心一致）。 */
  private sortNameOf(el: HTMLElement): string {
    const vmName = el.dataset.vmName;
    if (vmName !== undefined) return vmName;
    const pathEl = el.hasAttribute("data-path")
      ? el
      : el.querySelector<HTMLElement>("[data-path]");
    const path = pathEl?.getAttribute("data-path") ?? "";
    const at = path.lastIndexOf("/");
    return at >= 0 ? path.slice(at + 1) : path;
  }

  private isFolderItem(el: HTMLElement): boolean {
    return el.classList.contains("nav-folder");
  }

  /** 与原生文件浏览器一致：文件夹排在文件前面，再按名称做数字感知比较。 */
  private compareItems(a: HTMLElement, b: HTMLElement): number {
    const fa = this.isFolderItem(a) ? 0 : 1;
    const fb = this.isFolderItem(b) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return this.sortNameOf(a).localeCompare(this.sortNameOf(b), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  /**
   * 把挂载行放到真实同级条目中按名称该在的位置。
   *
   * 只做一次 `insertBefore`（而不是「先 append 再移动」），并且位置已经正确时
   * 完全不碰 DOM：这样核心的虚拟滚动 / 重绘不会因为我们自己的调整再被触发。
   * 同名的挂载之间比较结果为 0，会稳定地排在已有同名项之后，不会互相换位。
   */
  private place(node: HTMLElement, parent: HTMLElement): void {
    const items = Array.from(parent.children).filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child !== node && child.classList.contains("tree-item")
    );
    const next = items.find((item) => this.compareItems(node, item) < 0) ?? null;

    let current = node.nextElementSibling;
    while (current && !(current instanceof HTMLElement && current.classList.contains("tree-item"))) {
      current = current.nextElementSibling;
    }
    if (node.parentElement === parent && current === next) return;

    parent.insertBefore(node, next);
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

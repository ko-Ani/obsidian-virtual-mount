import { Menu, Notice, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import {
  DEFAULT_SETTINGS,
  Mount,
  MountKind,
  newId,
  normalizeMount,
  Settings,
  cleanPath,
  defaultMountName,
} from "./types";
import { TreeHost, VirtualTree } from "./tree";
import { VirtualMountSettingTab } from "./settings-tab";
import { t } from "./i18n";
import {
  findMovedSource,
  findMovedUnder,
  readMountIndex,
  StoredIndex,
  writeMountIndex,
} from "./mount-index";
import { MountEditorModal, MountTargetModal, PathSuggestModal, folderEntries } from "./ui";

/** 核心文件浏览器右键菜单触发 file-menu 时传的 source。 */
const EXPLORER_MENU_SOURCE = "file-explorer-context-menu";

export default class VirtualMountPlugin extends Plugin {
  settings!: Settings;
  tree!: VirtualTree;
  /** 上一次落盘的索引快照，用于路径失效时找回。 */
  private index: StoredIndex | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    const plugin = this;
    const host: TreeHost = {
      get settings() {
        return plugin.settings;
      },
      saveSettings: () => plugin.saveSettings(),
      removeMount: (id: string) => plugin.removeMount(id),
    };
    this.tree = new VirtualTree(this.app, host);

    this.addSettingTab(new VirtualMountSettingTab(this.app, this));

    this.addRibbonIcon("folder-symlink", t("ribbon.refresh"), () => this.tree.syncNow(true));

    this.addCommand({
      id: "add-mount",
      name: t("cmd.addMount"),
      callback: () => new MountEditorModal(this.app, this).open(),
    });

    this.addCommand({
      id: "mount-active-file",
      name: t("cmd.mountFile"),
      callback: () => this.mountActiveFile(),
    });

    this.addCommand({
      id: "mount-active-folder",
      name: t("cmd.mountFolder"),
      callback: () => this.mountActiveFolder(),
    });

    this.addCommand({
      id: "refresh-mounts",
      name: t("cmd.refresh"),
      callback: () => this.tree.syncNow(true),
    });

    this.registerEvent(this.app.vault.on("create", (file) => this.tree.markAffected(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.tree.markAffected(file.path)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.tree.markAffected(oldPath);
        this.tree.markAffected(file.path);
        void this.remapPaths(oldPath, file.path);
      })
    );
    this.registerEvent(this.app.workspace.on("file-open", () => this.tree.highlightActive()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.tree.schedule(150)));
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, source) => {
        if (source !== EXPLORER_MENU_SOURCE) return;
        this.addExplorerMenuItem(menu, file);
      })
    );

    this.app.workspace.onLayoutReady(() => {
      // 先把「上次没跟上」的路径修好，再开始往 DOM 里注入。
      void this.reconcileMounts().finally(() => this.tree.start());
    });
  }

  onunload(): void {
    this.tree?.stop();
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as
      | (Partial<Settings> & { mounts?: Partial<Mount>[] })
      | null;
    const data = stored ?? {};
    let mounts = Array.isArray(data.mounts) ? data.mounts.map((m) => normalizeMount(m)) : [];

    this.index = await readMountIndex(this.app, this.manifest.dir, this.manifest.id);

    // data.json 丢了（重装插件 / 换设备）但索引还在：用索引把挂载恢复回来。
    if (!stored && mounts.length === 0 && this.index?.mounts?.length) {
      mounts = this.index.mounts.map((m) => normalizeMount(m));
    }

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      mounts,
      maxChildren: Number.isFinite(data.maxChildren)
        ? (data.maxChildren as number)
        : DEFAULT_SETTINGS.maxChildren,
    } as Settings;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    const written = await writeMountIndex(
      this.app,
      this.manifest.dir,
      this.manifest.id,
      this.settings.mounts
    );
    if (written) this.index = written;
  }

  async removeMount(id: string): Promise<void> {
    const before = this.settings.mounts.length;
    this.settings.mounts = this.settings.mounts.filter((m) => m.id !== id);
    if (this.settings.mounts.length === before) return;
    await this.saveSettings();
    this.tree.syncNow(true);
    new Notice(t("notice.unmounted"));
  }

  /** 重新扫一遍真实路径，刷新「改名/移动后找回」用的索引。 */
  async rebuildIndex(): Promise<void> {
    const written = await writeMountIndex(
      this.app,
      this.manifest.dir,
      this.manifest.id,
      this.settings.mounts
    );
    if (written) this.index = written;
    new Notice(t("notice.reindexed"));
  }

  /* -------------------------------------------------------------- 快捷挂载 */

  private mountActiveFile(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice(t("notice.openFileFirst"));
      return;
    }
    this.pickTarget({ kind: "file", source: file.path, name: file.basename });
  }

  private mountActiveFolder(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file || !file.parent) {
      new Notice(t("notice.openFolderFirst"));
      return;
    }
    const folder = file.parent;
    if (folder.path === "/") {
      new Notice(t("notice.cannotMountRoot"));
      return;
    }
    this.pickTarget({ kind: "folder", source: folder.path, name: folder.name });
  }

  private pickTarget(base: { kind: MountKind; source: string; name: string }): void {
    new PathSuggestModal(this.app, folderEntries(this.app, true), (path) => {
      void this.mountTo(base, path);
    }).open();
  }

  private async mountTo(
    base: { kind: MountKind; source: string; name: string },
    path: string
  ): Promise<void> {
    const result = await this.addMount(base.kind, base.source, path, base.name);
    new Notice(result.ok ? t("notice.mounted", { target: path || t("label.root") }) : result.error);
  }

  /* ---------------------------------------------------------- 右键菜单入口 */

  /**
   * 往核心文件浏览器的右键菜单里加一项。
   *
   * 核心是在 onFileContextMenu 末尾触发 `workspace.trigger("file-menu", menu, file, source, leaf)`，
   * 所以监听这个事件就是官方推荐的做法；source 用来区分是文件树还是标签页/图谱。
   */
  private addExplorerMenuItem(menu: Menu, file: TAbstractFile): void {
    const isFolder = file instanceof TFolder;
    const isFile = file instanceof TFile;
    if (!isFolder && !isFile) return;
    // 仓库根目录本身没有意义
    if (isFolder && (file as TFolder).path === "/") return;

    menu.addItem((item) => {
      item.setTitle(t(isFolder ? "menu.mountFolder" : "menu.mountFile"));
      item.setIcon("folder-symlink");
      try {
        // 放进 action 分组，和“重命名 / 删除”排在一起
        item.setSection?.("action");
      } catch {
        /* 老版本没有 setSection，忽略 */
      }
      item.onClick(() => this.openMountTarget(file));
    });
  }

  private openMountTarget(file: TAbstractFile): void {
    const kind: MountKind = file instanceof TFolder ? "folder" : "file";
    const name = file instanceof TFolder ? file.name : (file as TFile).basename;
    new MountTargetModal(this.app, this, { kind, source: file.path, name }).open();
  }

  /**
   * 统一的“新增挂载”入口：校验 + 去重 + 落盘 + 刷新。
   * 设置页、命令、右键菜单都走这里，保证行为一致。
   */
  async addMount(
    kind: MountKind,
    source: string,
    under: string,
    displayName: string
  ): Promise<{ ok: true; mount: Mount } | { ok: false; error: string }> {
    const srcPath = cleanPath(source);
    const underPath = cleanPath(under);

    const src = this.app.vault.getAbstractFileByPath(srcPath);
    if (!src) return { ok: false, error: t("err.sourceMissing", { path: srcPath }) };
    if (kind === "folder" && !(src instanceof TFolder)) {
      return { ok: false, error: t("err.sourceNotFolder") };
    }
    if (kind === "file" && !(src instanceof TFile)) {
      return { ok: false, error: t("err.sourceNotFile") };
    }
    if (underPath) {
      const underFolder = this.app.vault.getAbstractFileByPath(underPath);
      if (!(underFolder instanceof TFolder)) {
        return { ok: false, error: t("err.underNotFolder", { path: underPath }) };
      }
    }

    const duplicated = this.settings.mounts.some(
      (m) => m.source === srcPath && m.under === underPath
    );
    if (duplicated) {
      return {
        ok: false,
        error: t("err.duplicate", { kind: t(kind === "folder" ? "kind.folder" : "kind.file") }),
      };
    }

    const mount = normalizeMount({
      id: newId(),
      kind,
      source: srcPath,
      under: underPath,
      name: displayName,
    });
    mount.kind = kind;
    this.settings.mounts.push(mount);
    await this.saveSettings();
    this.tree.syncNow(true);
    return { ok: true, mount };
  }

  /* ------------------------------------------------------------ 路径自动跟随 */

  /**
   * 源目录/挂载点被重命名时，自动改写配置里的路径，避免挂载失效。
   * （这是普通 Obsidian 插件做不到的体验：配置里存的是路径字符串。）
   *
   * 自动名称的挂载还要跟着改名——否则路径对了、虚拟目录却还挂着旧名字，
   * 排序位置也停在旧位置，看起来就像「没跟着变」。
   */
  private async remapPaths(oldPath: string, newPath: string): Promise<void> {
    let changed = false;
    const remap = (value: string): string => {
      if (value === oldPath) return newPath;
      if (value.startsWith(oldPath + "/")) return newPath + value.slice(oldPath.length);
      return value;
    };
    for (const mount of this.settings.mounts) {
      const before = `${mount.source}\u0000${mount.under}\u0000${mount.name}`;

      mount.source = remap(mount.source);
      mount.under = remap(mount.under);

      if (mount.nameMode !== "custom") {
        const nextName = defaultMountName(mount.source, mount.kind);
        if (nextName) mount.name = nextName;
      }

      if (before !== `${mount.source}\u0000${mount.under}\u0000${mount.name}`) {
        changed = true;
        // 名字 / 路径变了：这个节点要重建，排序位置也会跟着变。
        this.tree.invalidate(mount.id);
      }
    }
    if (changed) {
      await this.saveSettings();
      this.tree.syncNow(true);
    }
  }

  /**
   * 启动时把「路径已经失效」的挂载重新找回来。
   *
   * 覆盖 rename 事件收不到的情况：插件没运行时改名、在别的设备上移动、
   * 从系统文件管理器里拖走。索引里存着每个挂载最后一次的内容指纹，
   * 用它去找唯一匹配的条目；不唯一就放弃（宁可不绑，也不能绑错）。
   */
  private async reconcileMounts(): Promise<void> {
    if (this.settings.mounts.length === 0) return;

    let changed = false;
    const rebound: string[] = [];

    for (const mount of this.settings.mounts) {
      const snapshot = this.index?.mounts.find((m) => m.id === mount.id);

      if (mount.source && !this.app.vault.getAbstractFileByPath(mount.source)) {
        const next = findMovedSource(this.app, mount, snapshot);
        if (next) {
          mount.source = next;
          if (mount.nameMode !== "custom") {
            mount.name = defaultMountName(next, mount.kind) || mount.name;
          }
          rebound.push(mount.name);
          changed = true;
        }
      }

      if (mount.under && !(this.app.vault.getAbstractFileByPath(mount.under) instanceof TFolder)) {
        const next = findMovedUnder(this.app, mount, snapshot);
        if (next) {
          mount.under = next;
          changed = true;
        }
      }
    }

    if (!changed) return;
    await this.saveSettings();
    if (rebound.length > 0) {
      new Notice(t("notice.rebound", { names: rebound.join(", ") }));
    }
  }
}

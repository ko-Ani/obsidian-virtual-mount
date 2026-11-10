import { Menu, Notice, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, Mount, MountKind, newId, normalizeMount, Settings, cleanPath } from "./types";
import { TreeHost, VirtualTree } from "./tree";
import { VirtualMountSettingTab } from "./settings-tab";
import { t } from "./i18n";
import { MountEditorModal, MountTargetModal, PathSuggestModal, folderEntries } from "./ui";

/** 核心文件浏览器右键菜单触发 file-menu 时传的 source。 */
const EXPLORER_MENU_SOURCE = "file-explorer-context-menu";

export default class VirtualMountPlugin extends Plugin {
  settings!: Settings;
  tree!: VirtualTree;

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

    this.app.workspace.onLayoutReady(() => this.tree.start());
  }

  onunload(): void {
    this.tree?.stop();
  }

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<Settings> & { mounts?: Partial<Mount>[] };
    const mounts = Array.isArray(data.mounts) ? data.mounts.map((m) => normalizeMount(m)) : [];
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
  }

  async removeMount(id: string): Promise<void> {
    const before = this.settings.mounts.length;
    this.settings.mounts = this.settings.mounts.filter((m) => m.id !== id);
    if (this.settings.mounts.length === before) return;
    await this.saveSettings();
    this.tree.syncNow(true);
    new Notice(t("notice.unmounted"));
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
   */
  private async remapPaths(oldPath: string, newPath: string): Promise<void> {
    let changed = false;
    const remap = (value: string): string => {
      if (value === oldPath) return newPath;
      if (value.startsWith(oldPath + "/")) return newPath + value.slice(oldPath.length);
      return value;
    };
    for (const mount of this.settings.mounts) {
      const source = remap(mount.source);
      const under = remap(mount.under);
      if (source !== mount.source) {
        mount.source = source;
        changed = true;
      }
      if (under !== mount.under) {
        mount.under = under;
        changed = true;
      }
    }
    if (changed) {
      await this.saveSettings();
      this.tree.syncNow(true);
    }
  }
}

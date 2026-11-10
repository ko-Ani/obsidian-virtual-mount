import {
  App,
  FuzzySuggestModal,
  Modal,
  Notice,
  Setting,
  TFile,
  TFolder,
} from "obsidian";
import type VirtualMountPlugin from "./main";
import { t } from "./i18n";
import { Mount, MountKind, cleanPath, newId, normalizeMount } from "./types";

export interface PathEntry {
  path: string;
  isFolder: boolean;
}

function comparePath(a: PathEntry, b: PathEntry): number {
  return a.path.localeCompare(b.path, undefined, { numeric: true });
}

export function folderEntries(app: App, includeRoot: boolean): PathEntry[] {
  const items: PathEntry[] = includeRoot ? [{ path: "", isFolder: true }] : [];
  for (const f of app.vault.getAllLoadedFiles()) {
    if (f instanceof TFolder && f.path !== "/") items.push({ path: f.path, isFolder: true });
  }
  return items.sort(comparePath);
}

export function fileEntries(app: App): PathEntry[] {
  const items: PathEntry[] = [];
  for (const f of app.vault.getAllLoadedFiles()) {
    if (f instanceof TFile) items.push({ path: f.path, isFolder: false });
  }
  return items.sort(comparePath);
}

/** 一个通用的路径选择器（复用 Obsidian 的模糊搜索弹窗）。 */
export class PathSuggestModal extends FuzzySuggestModal<PathEntry> {
  constructor(
    app: App,
    private entries: PathEntry[],
    private onChoose: (path: string) => void
  ) {
    super(app);
    this.setPlaceholder(t("path.placeholder"));
    this.limit = 200;
  }

  getItems(): PathEntry[] {
    return this.entries;
  }

  getItemText(entry: PathEntry): string {
    return entry.path === "" ? t("path.root") : entry.path;
  }

  onChooseItem(entry: PathEntry): void {
    this.onChoose(entry.path);
  }
}

export class MountEditorModal extends Modal {
  private draft: Mount;
  private readonly isNew: boolean;

  constructor(
    app: App,
    private plugin: VirtualMountPlugin,
    existing?: Mount
  ) {
    super(app);
    this.isNew = !existing;
    this.draft = existing
      ? { ...existing }
      : normalizeMount({ id: newId(), kind: "folder", source: "", under: "", name: "" });
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl, titleEl } = this;
    contentEl.empty();
    titleEl.setText(t(this.isNew ? "editor.title.new" : "editor.title.edit"));

    contentEl.createEl("p", { cls: "vm-hint", text: t("editor.intro") });

    new Setting(contentEl)
      .setName(t("editor.type"))
      .setDesc(t("editor.typeDesc"))
      .addDropdown((d) =>
        d
          .addOption("folder", t("editor.type.folder"))
          .addOption("file", t("editor.type.file"))
          .setValue(this.draft.kind)
          .onChange((value) => {
            this.draft.kind = value as MountKind;
            this.draft.source = "";
            this.render();
          })
      );

    new Setting(contentEl)
      .setName(t("editor.source"))
      .setDesc(t("editor.sourceDesc"))
      .addText((text) =>
        text
          .setPlaceholder(t("editor.sourcePlaceholder"))
          .setValue(this.draft.source)
          .onChange((value) => {
            this.draft.source = value.trim();
          })
      )
      .addButton((b) =>
        b.setButtonText(t("btn.choose")).onClick(() => {
          const entries =
            this.draft.kind === "file" ? fileEntries(this.app) : folderEntries(this.app, false);
          new PathSuggestModal(this.app, entries, (path) => {
            this.draft.source = path;
            if (!this.draft.name) this.draft.name = path.split("/").pop() ?? "";
            this.render();
          }).open();
        })
      );

    new Setting(contentEl)
      .setName(t("editor.target"))
      .setDesc(t("editor.targetDesc"))
      .addText((text) =>
        text
          .setPlaceholder(t("editor.targetPlaceholder"))
          .setValue(this.draft.under)
          .onChange((value) => {
            this.draft.under = value.trim();
          })
      )
      .addButton((b) =>
        b.setButtonText(t("btn.choose")).onClick(() => {
          new PathSuggestModal(this.app, folderEntries(this.app, true), (path) => {
            this.draft.under = path;
            this.render();
          }).open();
        })
      );

    new Setting(contentEl)
      .setName(t("editor.name"))
      .setDesc(t("editor.nameDesc"))
      .addText((text) =>
        text
          .setPlaceholder(this.draft.source.split("/").pop() ?? "")
          .setValue(this.draft.name)
          .onChange((value) => {
            this.draft.name = value.trim();
          })
      );

    const footer = contentEl.createDiv({ cls: "vm-modal-footer" });
    footer
      .createEl("button", {
        text: t(this.isNew ? "btn.add" : "btn.save"),
        cls: "mod-cta",
      })
      .addEventListener("click", () => void this.submit());
    footer
      .createEl("button", { text: t("btn.cancel") })
      .addEventListener("click", () => this.close());
    if (!this.isNew) {
      footer
        .createEl("button", { text: t("btn.delete"), cls: "mod-warning" })
        .addEventListener("click", () => {
          this.plugin.removeMount(this.draft.id);
          this.close();
        });
    }
  }

  private async submit(): Promise<void> {
    const draft = this.draft;
    const source = cleanPath(draft.source);
    const underPath = cleanPath(draft.under);

    if (!source) {
      new Notice(t("notice.sourceEmpty"));
      return;
    }
    const src = this.app.vault.getAbstractFileByPath(source);
    if (!src) {
      new Notice(t("err.sourceMissing", { path: source }));
      return;
    }
    if (draft.kind === "folder" && !(src instanceof TFolder)) {
      new Notice(t("err.sourceNotFolder"));
      return;
    }
    if (draft.kind === "file" && !(src instanceof TFile)) {
      new Notice(t("err.sourceNotFile"));
      return;
    }
    if (underPath) {
      const under = this.app.vault.getAbstractFileByPath(underPath);
      if (!(under instanceof TFolder)) {
        new Notice(t("err.underNotFolder", { path: underPath }));
        return;
      }
    }
    const name = draft.name.trim() || source.split("/").pop() || "untitled";
    const mount = normalizeMount({
      ...draft,
      source,
      under: underPath,
      name,
    });
    mount.kind = draft.kind;

    const existing = this.plugin.settings.mounts.find((m) => m.id === mount.id);
    if (existing) Object.assign(existing, mount);
    else this.plugin.settings.mounts.push(mount);

    await this.plugin.saveSettings();
    this.plugin.tree.syncNow(true);
    this.close();
  }
}

export interface MountPreset {
  kind: MountKind;
  source: string;
  name: string;
}

/**
 * 右键「虚拟挂载到…」之后的精简弹窗：
 * 源固定为刚才右键的对象，只需要选挂载点 + 改显示名称。
 */
export class MountTargetModal extends Modal {
  private under: string;
  private name: string;

  constructor(
    app: App,
    private plugin: VirtualMountPlugin,
    private preset: MountPreset
  ) {
    super(app);
    this.name = preset.name;
    this.under = this.defaultUnder();
  }

  /** 默认挂到当前文件所在目录；如果那正好在源目录内部，就退回根目录。 */
  private defaultUnder(): string {
    const active = this.app.workspace.getActiveFile();
    const parent = active?.parent;
    if (!parent || parent.path === "/") return "";
    if (parent.path === this.preset.source) return "";
    if (parent.path.startsWith(this.preset.source + "/")) return "";
    return parent.path;
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl, titleEl } = this;
    contentEl.empty();
    titleEl.setText(
      t(this.preset.kind === "folder" ? "target.title.folder" : "target.title.file")
    );

    new Setting(contentEl)
      .setName(t("target.source"))
      .setDesc(
        this.preset.source +
          (this.preset.kind === "folder" ? t("target.sourceFolderDesc") : "")
      );

    new Setting(contentEl)
      .setName(t("target.target"))
      .setDesc(t("target.targetDesc"))
      .addText((text) =>
        text
          .setPlaceholder(t("path.root"))
          .setValue(this.under)
          .onChange((value) => {
            this.under = value.trim();
          })
      )
      .addButton((b) =>
        b.setButtonText(t("btn.choose")).onClick(() => {
          new PathSuggestModal(this.app, folderEntries(this.app, true), (path) => {
            this.under = path;
            this.render();
          }).open();
        })
      );

    new Setting(contentEl)
      .setName(t("target.name"))
      .setDesc(t("target.nameDesc"))
      .addText((text) =>
        text.setValue(this.name).onChange((value) => {
          this.name = value;
        })
      );

    const footer = contentEl.createDiv({ cls: "vm-modal-footer" });
    footer
      .createEl("button", { text: t("btn.mount"), cls: "mod-cta" })
      .addEventListener("click", () => void this.submit());
    footer
      .createEl("button", { text: t("btn.cancel") })
      .addEventListener("click", () => this.close());

    // 回车提交（避开中文输入法的组词回车）
    contentEl.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" && !evt.isComposing) {
        evt.preventDefault();
        void this.submit();
      }
    });
  }

  private async submit(): Promise<void> {
    const result = await this.plugin.addMount(
      this.preset.kind,
      this.preset.source,
      this.under,
      this.name
    );
    if (!result.ok) {
      new Notice(result.error);
      return;
    }
    new Notice(t("notice.mounted", { target: this.under || t("label.root") }));
    this.close();
  }
}

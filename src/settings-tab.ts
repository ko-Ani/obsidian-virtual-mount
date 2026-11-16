import { App, PluginSettingTab, Setting } from "obsidian";
import type VirtualMountPlugin from "./main";
import { t } from "./i18n";
import { MountEditorModal } from "./ui";

export class VirtualMountSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VirtualMountPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", { cls: "vm-hint", text: t("settings.intro") });

    new Setting(containerEl)
      .setName(t("settings.add"))
      .setDesc(t("settings.addDesc"))
      .addButton((b) =>
        b
          .setButtonText(t("btn.add"))
          .setCta()
          .onClick(() => new MountEditorModal(this.app, this.plugin).open())
      );

    if (this.plugin.settings.mounts.length === 0) {
      containerEl.createEl("p", { cls: "vm-empty", text: t("settings.empty") });
    }

    for (const mount of [...this.plugin.settings.mounts]) {
      const under = mount.under || t("label.root");
      const missing = !this.app.vault.getAbstractFileByPath(mount.source);
      new Setting(containerEl)
        .setName(mount.name)
        .setDesc(
          `${t(mount.kind === "folder" ? "settings.row.folder" : "settings.row.file")} · ${
            mount.source
          } → ${under}${missing ? ` · ${t("settings.row.broken")}` : ""}`
        )
        .addToggle((toggle) =>
          toggle.setValue(mount.enabled).onChange(async (value) => {
            mount.enabled = value;
            await this.save();
          })
        )
        .addExtraButton((b) =>
          b
            .setIcon("pencil")
            .setTooltip(t("btn.edit"))
            .onClick(() => new MountEditorModal(this.app, this.plugin, mount).open())
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip(t("btn.delete"))
            .onClick(() => this.plugin.removeMount(mount.id))
        );
    }

    new Setting(containerEl).setName(t("settings.options")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.foldersFirst"))
      .setDesc(t("settings.foldersFirstDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.foldersFirst).onChange(async (value) => {
          this.plugin.settings.foldersFirst = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.badge"))
      .setDesc(t("settings.badgeDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showBadge).onChange(async (value) => {
          this.plugin.settings.showBadge = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.reveal"))
      .setDesc(t("settings.revealDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.revealOnOpen).onChange(async (value) => {
          this.plugin.settings.revealOnOpen = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.max"))
      .setDesc(t("settings.maxDesc"))
      .addText((text) =>
        text
          .setPlaceholder("500")
          .setValue(String(this.plugin.settings.maxChildren))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 20) {
              this.plugin.settings.maxChildren = parsed;
              await this.save();
            }
          })
      );

    new Setting(containerEl)
      .setName(t("settings.index"))
      .setDesc(t("settings.indexDesc"))
      .addButton((b) =>
        b
          .setButtonText(t("btn.reindex"))
          .onClick(() => void this.plugin.rebuildIndex())
      );
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
    this.plugin.tree.syncNow(true);
  }
}

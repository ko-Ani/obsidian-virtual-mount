/**
 * 极简 i18n：跟随 Obsidian 的界面语言（localStorage.language），中文环境用中文，其余用英文。
 * 不引入任何依赖，也不做运行时切换——Obsidian 改语言需要重启，插件跟着重启即可。
 */

const STRINGS = {
  /* ------------------------------------------------------------------ 命令 */
  "cmd.addMount": { en: "Add virtual mount…", zh: "添加虚拟挂载…" },
  "cmd.mountFile": { en: "Mount the current note to…", zh: "把当前文件挂载到…" },
  "cmd.mountFolder": {
    en: "Mount the current note's folder to…",
    zh: "把当前文件所在的文件夹挂载到…",
  },
  "cmd.refresh": { en: "Refresh virtual mounts", zh: "刷新虚拟挂载" },
  "ribbon.refresh": { en: "Refresh virtual mounts", zh: "刷新虚拟挂载" },

  /* ------------------------------------------------------------------ 菜单 */
  "menu.mountFolder": { en: "Mount as virtual folder…", zh: "虚拟挂载到…" },
  "menu.mountFile": { en: "Mount as virtual note…", zh: "虚拟挂载到…（单文件）" },
  "menu.revealFolder": {
    en: "Reveal real folder in file explorer",
    zh: "在文件浏览器中定位真实文件夹",
  },
  "menu.revealFile": {
    en: "Reveal real note in file explorer",
    zh: "在文件浏览器中定位真实文件",
  },
  "menu.copyPath": { en: "Copy real path", zh: "复制真实路径" },
  "menu.unmount": { en: "Remove this mount", zh: "取消此挂载" },

  /* ------------------------------------------------------------------ 提示 */
  "notice.mounted": { en: "Mounted to {target}", zh: "已挂载到 {target}" },
  "notice.unmounted": { en: "Mount removed", zh: "已取消挂载" },
  "notice.openFileFirst": { en: "Open a note first", zh: "请先打开一个文件" },
  "notice.openFolderFirst": {
    en: "Open any note inside that folder first",
    zh: "请先打开该文件夹里的任意一个文件",
  },
  "notice.cannotMountRoot": { en: "The vault root can't be mounted", zh: "不能挂载仓库根目录本身" },
  "notice.sourceEmpty": { en: "Source path is required", zh: "请填写源路径" },
  "notice.copyFailed": { en: "Copy failed", zh: "复制失败" },
  "label.root": { en: "vault root", zh: "仓库根目录" },

  /* ------------------------------------------------------------------ 错误 */
  "err.sourceMissing": { en: "Source not found: {path}", zh: "源路径不存在：{path}" },
  "err.sourceNotFolder": { en: "Source is not a folder", zh: "源路径不是文件夹" },
  "err.sourceNotFile": { en: "Source is not a note", zh: "源路径不是文件" },
  "err.underNotFolder": { en: "Target is not a folder: {path}", zh: "挂载点不是文件夹：{path}" },
  "err.duplicate": {
    en: "This {kind} is already mounted there",
    zh: "这个{kind}已经挂载到该位置了",
  },
  "kind.folder": { en: "folder", zh: "文件夹" },
  "kind.file": { en: "note", zh: "文件" },

  /* ------------------------------------------------------------ 树上的节点 */
  "badge.tooltip": { en: "Virtual mount · real path: {path}", zh: "虚拟挂载 · 真实位置：{path}" },
  "more.items": {
    en: "… {count} more not shown (click to open the real folder)",
    zh: "… 还有 {count} 项未显示（点击查看真实目录）",
  },

  /* -------------------------------------------------------------- 挂载弹窗 */
  "target.title.folder": { en: "Mount folder", zh: "虚拟挂载文件夹" },
  "target.title.file": { en: "Mount note", zh: "虚拟挂载单文件" },
  "target.source": { en: "Source", zh: "源" },
  "target.sourceFolderDesc": { en: "(the whole folder is mirrored)", zh: "（整个文件夹镜像）" },
  "target.target": { en: "Mount to", zh: "挂载到" },
  "target.targetDesc": {
    en: "Which folder should it appear under? Leave empty for the vault root.",
    zh: "虚拟位置要显示在哪个文件夹下；留空表示仓库根目录。",
  },
  "target.name": { en: "Display name", zh: "显示名称" },
  "target.nameDesc": {
    en: "Name shown in the tree. You can change it later in settings.",
    zh: "虚拟位置的显示名字，之后还能在设置里改。",
  },

  /* -------------------------------------------------------------- 完整编辑器 */
  "editor.title.new": { en: "Add virtual mount", zh: "添加虚拟挂载" },
  "editor.title.edit": { en: "Edit virtual mount", zh: "编辑虚拟挂载" },
  "editor.intro": {
    en: "Files stay in the source folder. The virtual location is drawn into the file explorer only — nothing is created on disk.",
    zh: "文件只保留在「源路径」里；虚拟位置仅在文件浏览器中显示，不会在磁盘上创建任何目录。",
  },
  "editor.type": { en: "Type", zh: "类型" },
  "editor.typeDesc": {
    en: "Folder mirror follows the source folder; single note mounts one note.",
    zh: "文件夹镜像会随源目录增删自动更新；单文件只挂一篇笔记。",
  },
  "editor.type.folder": { en: "Folder mirror", zh: "文件夹镜像" },
  "editor.type.file": { en: "Single note", zh: "单文件" },
  "editor.source": { en: "Source path", zh: "源路径" },
  "editor.sourceDesc": {
    en: "Real location; must already exist.",
    zh: "真实位置，必须是已存在的文件或文件夹。",
  },
  "editor.sourcePlaceholder": { en: "e.g. Projects/Website", zh: "如：03-资料/项目A" },
  "editor.target": { en: "Mount to", zh: "挂载到" },
  "editor.targetDesc": {
    en: "Parent folder of the virtual entry; leave empty for the vault root.",
    zh: "虚拟位置所在的文件夹；留空表示挂在仓库最外层。",
  },
  "editor.targetPlaceholder": { en: "e.g. Inbox", zh: "如：01-进行中" },
  "editor.name": { en: "Display name", zh: "显示名称" },
  "editor.nameDesc": {
    en: "Leave empty to use the last path segment.",
    zh: "留空则使用源路径的最后一段。",
  },

  /* ------------------------------------------------------------------ 设置 */
  "settings.title": { en: "Virtual Mount", zh: "虚拟挂载" },
  "settings.intro": {
    en: "Files exist once (in the source path). Virtual entries are drawn into the native file explorer; no folder is created on disk. This patches the core file explorer DOM, so a major Obsidian update may need an adaptation.",
    zh: "文件只存在一份（源路径），虚拟位置是在原生文件浏览器里额外画出来的节点，不会在磁盘上创建目录。因为是直接改核心文件浏览器的 DOM，Obsidian 大版本升级后可能需要重新适配。",
  },
  "settings.add": { en: "Add a mount", zh: "新增挂载" },  "settings.addDesc": {
    en: "Mirror a real folder (or a single note) under another folder.",
    zh: "把一个真实文件夹（或单篇笔记）镜像显示到另一个目录下。",
  },
  "settings.empty": { en: "No mounts yet.", zh: "还没有任何挂载。" },
  "settings.options": { en: "Display options", zh: "显示选项" },
  "settings.row.folder": { en: "Mirror", zh: "镜像" },
  "settings.row.file": { en: "Single note", zh: "单文件" },
  "settings.foldersFirst": { en: "Folders before notes", zh: "文件夹排在文件前面" },
  "settings.foldersFirstDesc": {
    en: "Sorting inside a mount block only — blocks always sit at the top of the target folder.",
    zh: "只影响同一个挂载块内部的排序。挂载块总是显示在目标文件夹内容的顶部。",
  },
  "settings.badge": { en: "Show the ↪ badge", zh: "显示 ↪ 角标" },
  "settings.badgeDesc": {
    en: "Marks virtual entries so they're easy to tell apart from real ones.",
    zh: "在虚拟节点上标一个角标，方便和真实节点区分。",
  },
  "settings.reveal": { en: "Reveal real location on open", zh: "打开后定位到真实位置" },
  "settings.revealDesc": {
    en: "After opening a file from a virtual entry, scroll the native explorer to its real path.",
    zh: "打开虚拟位置的文件后，让原生文件浏览器滚动并展开到它的真实路径。",
  },
  "settings.max": { en: "Max items per virtual folder", zh: "单个文件夹最多显示多少项" },
  "settings.maxDesc": {
    en: "Larger folders are truncated with a “N more” hint.",
    zh: "超过上限会显示「还有 N 项未显示」，避免超大目录卡顿。",
  },

  /* -------------------------------------------------------------- 通用按钮 */
  "btn.add": { en: "Add", zh: "添加" },
  "btn.save": { en: "Save", zh: "保存" },
  "btn.delete": { en: "Delete", zh: "删除" },
  "btn.cancel": { en: "Cancel", zh: "取消" },
  "btn.choose": { en: "Choose", zh: "选择" },
  "btn.mount": { en: "Mount", zh: "挂载" },
  "btn.edit": { en: "Edit", zh: "编辑" },
  "path.placeholder": { en: "Filter paths…", zh: "输入路径筛选…" },
  "path.root": { en: "(vault root)", zh: "（仓库根目录）" },
} as const;

export type MessageKey = keyof typeof STRINGS;
export type Lang = "en" | "zh";

/** 读取 Obsidian 的界面语言；桌面端和移动端都存在 window.localStorage.language。 */
export function detectLang(): Lang {
  try {
    const raw = window.localStorage.getItem("language");
    if (raw) return raw.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    /* 某些沙箱环境访问 localStorage 会抛错 */
  }
  try {
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "en";
  }
}

let cached: Lang | null = null;

export function lang(): Lang {
  if (cached === null) cached = detectLang();
  return cached;
}

/** 仅用于测试：清掉语言缓存后重新探测。 */
export function resetLangCache(): void {
  cached = null;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const entry = STRINGS[key];
  let text: string = entry ? entry[lang()] : key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

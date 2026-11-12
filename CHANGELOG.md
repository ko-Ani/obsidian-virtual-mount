# Changelog · 更新日志

> 中文在前，English follows. / Chinese first, then English.

## 0.2.1

### 中文

- 虚拟子目录现在和原生文件夹一致：默认折叠、点开时才渲染，打开一个挂载不会再一次性展开整棵嵌套目录。
- 子目录的开合状态会在本次会话内记住：折叠再展开父目录、或核心重建文件树之后，之前展开的子目录仍然保持展开。新建的挂载同样默认折叠。

### English

- Virtual subfolders now behave like native folders: they start collapsed and are rendered lazily, instead of expanding the whole nested tree as soon as a mount is opened.
- The open/closed state of virtual subfolders is remembered for the session, so collapsing and reopening a parent folder — or a core tree rebuild — keeps previously opened subfolders open. New mounts also start collapsed.

## 0.2.0

### 中文

- 右键 / 长按虚拟节点，现在会弹出其真实源文件夹或笔记的原生菜单。`新建笔记`、`新建文件夹`、`重命名`、`移动`、`创建副本`、`删除` 都作用于源位置，而不是虚拟行。
- 插件自己的菜单项（定位真实位置、复制真实路径、取消挂载）追加在这个原生菜单里；如果核心视图方法不可用，则退回内置菜单。
- 修复：在 Obsidian 1.14+ 上，菜单可能因为核心把它关联到（通常不在可视区的）真实树行而在约 500 ms 后自动关闭。插件现在会在构建菜单期间临时隐藏该行关联，构建完立即还原。

### English

- Right-click / long-press a virtual entry now opens the native context menu of its real source folder or note. `New note`, `New folder`, `Rename`, `Move`, `Make a copy` and `Delete` operate on the source, not on the virtual row.
- The plugin's own menu items (reveal, copy real path, remove mount) are appended to that native menu; a built-in fallback menu is used if the core view method is unavailable.
- Fix: on Obsidian 1.14+, the menu could close itself after ~500 ms because core attaches it to the real (often off-screen) tree row. The plugin now hides that row association while the menu is being built and restores it immediately afterwards.

## 0.1.0

### 中文

- 首个版本。
- 在原生文件浏览器里，把真实文件夹镜像到任意其他文件夹下。
- 单篇笔记可以挂载到多个位置。
- 右键 / 长按菜单项 `虚拟挂载到…`，带目标选择器和可编辑的显示名称。
- 设置页含完整编辑器、逐条启用开关和显示选项。
- 新建 / 删除 / 重命名实时更新；源文件夹改名后自动改写路径。
- 双语界面（English / 中文），跟随 Obsidian 界面语言。
- 桌面端与移动端（`isDesktopOnly: false`），移动端 WebView 有剪贴板降级方案。

### English

- First release.
- Mirror a real folder under any other folder in the native file explorer.
- Mount a single note in multiple places.
- Right-click / long-press menu entry: `Mount as virtual folder…` with target picker and editable display name.
- Settings tab with the full editor, per-mount enable toggle and display options.
- Live updates on create / delete / rename, and automatic path remapping when the source folder is renamed.
- Bilingual UI (English / Chinese) following the Obsidian UI language.
- Desktop and mobile (`isDesktopOnly: false`), with clipboard fallback for mobile webviews.

<div align="center">

# 虚拟挂载 · Virtual Mount

**把任意真实文件夹（或单篇笔记）挂到文件浏览器的任意位置 —— 不移动、不复制、不用符号链接。**

[![Release](https://img.shields.io/github/v/release/ko-Ani/obsidian-virtual-mount?style=flat-square&label=release&color=7c3aed)](https://github.com/ko-Ani/obsidian-virtual-mount/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/ko-Ani/obsidian-virtual-mount/total?style=flat-square&label=downloads&color=4c8bf5)](https://github.com/ko-Ani/obsidian-virtual-mount/releases)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.6.0%2B-7c3aed?style=flat-square&logo=obsidian&logoColor=white)](https://obsidian.md)
[![Platform](https://img.shields.io/badge/%E6%A1%8C%E9%9D%A2%E7%AB%AF%20%2F%20%E7%A7%BB%E5%8A%A8%E7%AB%AF-22c55e?style=flat-square)](#兼容性)
[![License](https://img.shields.io/github/license/ko-Ani/obsidian-virtual-mount?style=flat-square&color=f59e0b)](LICENSE)

[安装](#安装) · [使用](#使用) · [实现原理](#实现原理) · [兼容性](#兼容性) · [已知限制](#已知限制) · [English](README.en.md)

</div>

---

## 它长什么样

```text
磁盘（唯一真实数据）                Obsidian 文件浏览器
03-资料/项目A/                      01-进行中/
├── alpha.md            ──▶         ├── 会议记录.md
├── beta.md                         └── 项目A ↪          ← 虚拟挂载
└── 子目录/                             ├── alpha
                                        ├── beta
                                        └── 子目录
```

虚拟节点和原生文件夹几乎一模一样：点开就是真实文件，两边同步编辑，源目录里增删文件镜像立刻跟着变。
**磁盘上不会创建任何目录**，映射关系只存在插件自己的 `data.json` 里。

> 一句话：文件永远只有一份，虚拟位置只是文件浏览器里多画出来的一个节点。
> 重命名、新建、删除……所有操作直接作用于真实文件。

## 能力一览

| | 能力 | 说明 |
| :--: | :--- | :--- |
| 📁 | **文件夹镜像** | 把整个文件夹挂到任意目录下，源目录的增 / 删 / 改名实时同步。 |
| 📝 | **单文件挂载** | 同一篇笔记可以同时出现在多个位置，各处都指向同一个真实文件。 |
| 🖱️ | **右键即挂** | 右键（移动端长按）任意文件夹 → `虚拟挂载到…`，选挂载点、改显示名称。 |
| 🧩 | **源目录原生菜单** | 右键虚拟节点，弹出与真实文件夹 / 笔记完全相同的菜单：新建、重命名、移动、复制、删除……全部作用于源位置。 |
| 🎨 | **原生外观** | 沿用核心 `tree-item` / `tree-item-self` / `tree-item-flair` 类名，主题、悬停、折叠效果都是原生的。 |
| 🔄 | **跟随重命名** | 源文件夹改名或移动，挂载路径自动改写，配置不会失效。 |
| 🪶 | **零磁盘痕迹** | 不建目录、不写 symlink / junction、不产生重复文件。 |
| 📱 | **桌面端 + 移动端** | 同一份代码；长按菜单、剪贴板降级方案都做了适配。 |

## 什么时候值得用

- **PARA / 卡片盒**：`03-资料/项目A` 只存一份，但「01-进行中」和「04-归档」两个入口都要能看到它。
- **一份素材，多处引用**：模板、附件、素材库同时出现在每个项目目录下，磁盘上仍然只有一份。
- **不想为了分类搬文件**：旧目录结构原样保留，另外挂几个「视图」出来。
- **单篇笔记复用**：同一张清单同时出现在「本周」和「项目」里，改哪边都是同一份。

## 安装

**方式一：社区插件商店（推荐）**

设置 → 第三方插件 → 浏览 → 搜索 **Virtual Mount** → 安装并启用。

**方式二：BRAT**

在 BRAT 里添加 `ko-Ani/obsidian-virtual-mount` 作为 beta 插件，之后可以直接在 Obsidian 里更新。

**方式三：手动安装**

1. 到 [Releases](https://github.com/ko-Ani/obsidian-virtual-mount/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`；
2. 放进 `<你的仓库>/.obsidian/plugins/virtual-mount/`；
3. 重启 Obsidian → 设置 → 第三方插件 → 启用 **Virtual Mount**。

## 使用

**挂载一个文件夹**

1. 右键（移动端长按）文件夹 → `虚拟挂载到…`；
2. 「挂载到」选择虚拟位置所在的文件夹，留空表示仓库根目录；
3. 「显示名称」可以改，点 **挂载** 完成。

右键单篇笔记则显示 `虚拟挂载到…（单文件）`。

**设置页**里有完整编辑器（类型 / 源路径 / 挂载点 / 名称）、挂载列表（可逐条启用停用）和显示选项：

| 显示选项 | 作用 |
| :--- | :--- |
| 文件夹排在文件前面 | 只影响同一个挂载块内部的排序；挂载块总是位于目标文件夹顶部。 |
| 显示 ↪ 角标 | 在虚拟节点上标出角标，方便和真实节点区分。 |
| 打开后定位到真实位置 | 从虚拟节点打开文件后，原生文件浏览器滚动并展开到它的真实路径。 |
| 单个文件夹最多显示多少项 | 超出上限显示「还有 N 项未显示」，避免超大目录卡顿。 |

**命令面板**（`Ctrl/Cmd+P`）：

- `添加虚拟挂载…`
- `把当前文件挂载到…`
- `把当前文件所在的文件夹挂载到…`
- `刷新虚拟挂载`

**交互一览**

| 操作 | 结果 |
| :--- | :--- |
| 单击虚拟笔记 | 打开真实文件（`Ctrl/Cmd+单击` 或中键 → 新标签）。 |
| 点击虚拟文件夹 | 折叠 / 展开。子目录默认折叠、点开时才加载；展开状态会记住（父目录关掉再打开也不会丢），和原生目录一致。 |
| 右键 / 长按虚拟节点 | 弹出真实源目录 / 源文件的**原生菜单**：新建笔记、新建文件夹、重命名、移动、创建副本、删除…… 另有「定位真实位置」「复制真实路径」。 |
| 右键 / 长按挂载根节点 | 再加上「取消此挂载」。 |

## 实现原理

Obsidian 的索引来自磁盘扫描：`TFile.path` 就是真实路径，**没有任何 API 能往索引里加虚拟路径**；
而且官方明确会忽略「仓库内一个文件夹指向另一个」的 symlink，因为同一文件出现两份会让 `[[双链]]` 产生歧义（[帮助文档](https://obsidian.md/help/symlinks)）。

所以本插件是一个**视图层**：读真实的 `TFolder` 数据，在原生文件浏览器里画出等价节点。
虚拟路径只是视觉上的，文件始终保留真实路径 —— 这正是两边能同步的原因。

Obsidian 1.6+ 的文件树是虚拟化列表：滚动时 `setChildrenInPlace()` 会整体替换 `.nav-folder-children` 的子节点，塞进去的第三方节点会被清掉。因此插件：

1. 通过标题上的 `data-path` 找到真实文件夹元素；
2. 在 `.nav-folder` 下另建一个平级容器 `.vm-children`（沿用 `tree-item-children` 的缩进样式，但只由插件管理）；
3. 仅在源数据变化时重建，核心重绘后由 `MutationObserver` 补注入；
4. 在 `click` / `auxclick` / `contextmenu` 上 `stopPropagation`，核心的委托事件永远不会碰到虚拟行。

右键菜单项通过 `workspace` 的 `file-menu` 事件添加，并按 `file-explorer-context-menu` 过滤来源。虚拟节点上右键 / 长按时，插件把真实的 `TAbstractFile` 交回文件浏览器视图自己的 `onFileContextMenu()`，让核心按源目录生成菜单；插件项则通过一次性的 `file-menu` 监听追加。较新的 Obsidian 会把菜单挂到真实树节点上，并在节点不可见时自动关闭，所以插件在生成菜单期间临时隐藏这个挂载关系，生成完立刻还原。若该内部方法不可用，会退回插件自带的精简菜单（定位 / 复制路径 / 取消挂载）。

## 移动端

手机端跑的是同一份 bundle、同一套文件树 DOM，所以挂载显示完全一致。
长按触发同一个右键菜单；「复制真实路径」在 `navigator.clipboard` 不可用时自动退回 `execCommand`。

`isDesktopOnly` 为 `false`。

## 兼容性

| 项目 | 说明 |
| :--- | :--- |
| 最低版本 | Obsidian **1.6.0+** |
| 平台 | 桌面端（Windows / macOS / Linux）与移动端（iOS / Android） |
| 实测版本 | **1.14.5**，以及较早的 **1.8.x** |
| 验证方式 | 文件树 DOM 与菜单行为直接从发布包的 `obsidian.asar` 反查确认 |

## 已知限制

- **不支持拖拽**：需要在真实位置拖拽。重命名 / 删除 / 新建笔记 / 新建文件夹等可以通过虚拟节点的「源目录原生菜单」操作，作用于真实文件。
- **虚拟路径不可被链接解析**：`[[01-进行中/项目A/alpha]]` 找不到；链接永远指向真实路径。
- **不进搜索 / 快速切换 / 图谱**：这些走后端索引，只认识真实路径。
- **挂载块固定在目标文件夹顶部**：核心的虚拟列表管理着其余子节点，无法按字母序插进中间。
- **升级风险**：依赖核心 DOM 结构，Obsidian 大版本升级后可能需要适配。

## 开发

```bash
pnpm install
pnpm dev      # 监听构建
pnpm build    # 类型检查 + 生产构建 → main.js
pnpm test     # jsdom 测试：DOM 注入 / 插件入口 / i18n
```

DOM 测试复刻了 1.8.x 的真实树结构（从 `app.js` 提取），包括虚拟滚动的整体替换行为。

## 许可证

[MIT](LICENSE)

---

<div align="center">

如果它帮你少搬了几次文件，点个 ⭐ 就是最好的支持。

<sub>更新日志见 [CHANGELOG.md](CHANGELOG.md) · English docs: [README.en.md](README.en.md)</sub>

</div>

<div align="center">

# Virtual Mount

**Show a real folder (or a single note) as a virtual subfolder anywhere in the file explorer — nothing is moved, copied, or symlinked.**

[![Release](https://img.shields.io/github/v/release/ko-Ani/obsidian-virtual-mount?style=flat-square&label=release&color=7c3aed)](https://github.com/ko-Ani/obsidian-virtual-mount/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/ko-Ani/obsidian-virtual-mount/total?style=flat-square&label=downloads&color=4c8bf5)](https://github.com/ko-Ani/obsidian-virtual-mount/releases)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.6.0%2B-7c3aed?style=flat-square&logo=obsidian&logoColor=white)](https://obsidian.md)
[![Platform](https://img.shields.io/badge/Desktop%20%7C%20Mobile-22c55e?style=flat-square)](#compatibility)
[![License](https://img.shields.io/github/license/ko-Ani/obsidian-virtual-mount?style=flat-square&color=f59e0b)](LICENSE)

[Install](#installation) · [Usage](#usage) · [How it works](#how-it-works) · [Compatibility](#compatibility) · [Limitations](#limitations) · [中文主页](README.md)

</div>

---

## What it looks like

```text
Disk (the only real copy)          Obsidian file explorer
03 References/Project A/           01 In progress/
├── alpha.md            ──────▶    ├── meeting-notes.md
├── beta.md                        └── Project A ↪     ← virtual mount
└── subfolder/                         ├── alpha
                                       ├── beta
                                       └── subfolder
```

The virtual entry looks and behaves like a native folder: click a note and the real file opens, edits show up in both places instantly, and adding or deleting files in the source folder is reflected in the mirror.
**No folder is created on disk** — the mapping lives in the plugin's own `data.json`.

> In one sentence: the file exists once; the virtual location is just an extra node drawn into the file explorer.
> Rename, create and delete act directly on the real file.

## Features

| | Feature | Details |
| :--: | :--- | :--- |
| 📁 | **Folder mirror** | Mount a whole folder under any other folder; the tree follows the source live (create / delete / rename). |
| 📝 | **Single-note mounts** | Put one note in several places at once — every occurrence points to the same real file. |
| 🖱️ | **Mount from the context menu** | Right-click (long-press on mobile) any folder → `Mount as virtual folder…`, pick the target and edit the display name. |
| 🧩 | **Native source menu** | Right-click a virtual entry and get the same menu as the real folder or note: new note, new folder, rename, move, copy, delete. Every action operates on the source. |
| 🎨 | **Native look** | Reuses the core tree classes (`tree-item`, `tree-item-self`, `tree-item-flair`…), so themes and hover states apply. |
| 🔄 | **Rename tracking** | If you rename or move the source folder, the mount follows automatically. |
| 🪶 | **Zero disk footprint** | No directories, no symlinks, no junctions, no duplicated files. |
| 📱 | **Desktop and mobile** | Same code path; the long-press menu and clipboard fallback work in the mobile app. |

## When it's useful

- **PARA / Zettelkasten**: a reference folder lives in one place but has to show up under both “In progress” and “Archive”.
- **One asset, many entry points**: templates, attachments and media libraries appear in every project folder while the files stay in one place.
- **No re-organising**: keep the existing folder structure and mount a few views on top of it.
- **Reused notes**: the same checklist appears under “This week” and a project — edit either one and it is the same note.

## Installation

**Option 1 — manual**

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/ko-Ani/obsidian-virtual-mount/releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/virtual-mount/`.
3. Reload Obsidian and enable **Virtual Mount** in Settings → Community plugins.

**Option 2 — BRAT**

Add `ko-Ani/obsidian-virtual-mount` as a beta plugin; updates can then be installed from inside Obsidian.

**Option 3 — community plugins**

After review: Settings → Community plugins → Browse → search “Virtual Mount”.

## Usage

**Mount a folder**

1. Right-click (long-press on mobile) a folder → `Mount as virtual folder…`.
2. **Mount to** picks the parent folder of the virtual entry; leave it empty for the vault root.
3. **Display name** can be changed now or later; press **Mount**.

Right-clicking a note shows `Mount as virtual note…` instead.

The **settings tab** has the full editor (type, source, target, name), a list of mounts with per-mount enable toggles, and display options:

| Option | Effect |
| :--- | :--- |
| Folders before notes | Sorting inside a mount block only — blocks always sit at the top of the target folder. |
| Show the ↪ badge | Marks virtual entries so they're easy to tell apart from real ones. |
| Reveal real location on open | After opening a file from a virtual entry, scroll the native explorer to its real path. |
| Max items per virtual folder | Larger folders are truncated with a “N more” hint. |

**Commands** (`Ctrl/Cmd+P`):

- `Add virtual mount…`
- `Mount the current note to…`
- `Mount the current note's folder to…`
- `Refresh virtual mounts`

**Interactions**

| Action | Result |
| :--- | :--- |
| Click a virtual note | Opens the real file (`Ctrl/Cmd+click` or middle-click for a new tab). |
| Click a virtual folder | Collapse / expand. Subfolders start collapsed and load only when opened; expanded state is remembered, just like native folders. |
| Right-click / long-press a virtual entry | The **native menu of its source** folder or note: new note, new folder, rename, move, make a copy, delete… |
| Right-click / long-press a mount root | The same menu plus `Reveal real location`, `Copy real path` and `Remove this mount`. |

## How it works

Obsidian's file index is built by scanning the vault: `TFile.path` *is* the real path, and no API can add a virtual path to that index. Obsidian also explicitly ignores intra-vault symlinks, because two copies of the same file would make `[[wikilinks]]` ambiguous ([help](https://obsidian.md/help/symlinks)).

So this plugin is a **view layer**: it reads real `TFolder` data and injects equivalent nodes into the native file explorer. The virtual path is visual only — the file always keeps its real path, which is exactly why edits stay in sync.

Obsidian 1.6+ renders the file explorer with a virtualized tree: `setChildrenInPlace()` replaces the children of `.nav-folder-children` on scroll, so anything appended there is wiped. This plugin therefore:

1. finds the real folder element via `data-path` on its title,
2. creates a sibling container `.vm-children` (same `tree-item-children` styling, but owned by the plugin),
3. rebuilds only when the source changed, and re-injects after the core re-renders (`MutationObserver`),
4. stops propagation on `click` / `auxclick` / `contextmenu` so the core's delegated handlers never see virtual rows.

The `file-menu` workspace event is used to add the right-click item, filtered to the `file-explorer-context-menu` source. For a virtual entry, the plugin hands the real `TAbstractFile` back to the file explorer view's own `onFileContextMenu()`, so the menu is generated by core with the exact source as its target; plugin items are appended through a one-shot `file-menu` listener. On recent Obsidian versions core anchors a menu to the real tree row and auto-closes it when that row is not visible, so the plugin temporarily hides that row association while the menu is built and restores it immediately afterwards. If that internal method is ever unavailable, a small built-in menu (reveal / copy path / remove mount) is used instead.

## Mobile

The mobile app runs the same bundle and the same tree DOM, so mounts render identically. Long-press opens the same context menu, and “Copy real path” falls back to `execCommand` where `navigator.clipboard` is unavailable.

`isDesktopOnly` is `false`.

## Compatibility

| Item | Details |
| :--- | :--- |
| Minimum | Obsidian **1.6.0+** |
| Platforms | Desktop (Windows / macOS / Linux) and mobile (iOS / Android) |
| Tested | **1.14.5**, plus earlier **1.8.x** |
| Verification | Tree DOM and menu behaviour checked against the shipped `obsidian.asar` |

## Limitations

- **Drag-and-drop is not supported.** Drag the real entry instead. Rename / delete / new note / new folder are available from the virtual entry's native source menu and act on the real file.
- **Virtual paths are not linkable.** `[[01 In progress/Project A/alpha]]` will not resolve; links always use the real path.
- **Not in search, Quick Switcher or Graph** — those read the index, which only knows real paths.
- **Mount blocks always sit at the top of the target folder**, because the core's virtual list owns the rest of the children.
- **Upgrade risk.** This depends on core DOM structure; a major Obsidian update may need an adaptation.

## Development

```bash
pnpm install
pnpm dev      # watch build
pnpm build    # typecheck + production bundle -> main.js
pnpm test     # jsdom tests: DOM injection, plugin entry, i18n
```

The DOM tests replicate the real 1.8.x tree structure extracted from `app.js`, including the virtualized-children behaviour.

## License

[MIT](LICENSE)

---

<div align="center">

If it saved you a few file moves, a ⭐ is the best way to say thanks.

<sub>Changelog: [CHANGELOG.md](CHANGELOG.md) · 中文说明: [README.md](README.md)</sub>

</div>

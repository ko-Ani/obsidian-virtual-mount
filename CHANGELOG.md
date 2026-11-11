# Changelog

## 0.2.0

- Right-click / long-press a virtual entry now opens the native context menu of its real source folder or note. `New note`, `New folder`, `Rename`, `Move`, `Make a copy` and `Delete` operate on the source, not on the virtual row.
- The plugin's own menu items (reveal, copy real path, remove mount) are appended to that native menu; a built-in fallback menu is used if the core view method is unavailable.
- Fix: on Obsidian 1.14+, the menu could close itself after ~500 ms because core attaches it to the real (often off-screen) tree row. The plugin now hides that row association while the menu is being built and restores it immediately afterwards.

## 0.1.0

First release.

- Mirror a real folder under any other folder in the native file explorer.
- Mount a single note in multiple places.
- Right-click / long-press menu entry: `Mount as virtual folder…` with target picker and editable display name.
- Settings tab with the full editor, per-mount enable toggle and display options.
- Live updates on create / delete / rename, and automatic path remapping when the source folder is renamed.
- Bilingual UI (English / Chinese) following the Obsidian UI language.
- Desktop and mobile (`isDesktopOnly: false`), with clipboard fallback for mobile webviews.

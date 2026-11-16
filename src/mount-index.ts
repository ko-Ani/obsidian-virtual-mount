/**
 * 挂载索引（mounts.index.json）
 *
 * 为什么需要它：挂载配置里存的是「路径字符串」，而 Obsidian 的文件没有稳定 id。
 * 只要重命名 / 移动发生在插件没运行的时候（关闭 Obsidian、在别的设备上改名、
 * 从系统文件管理器里拖走），rename 事件就收不到，路径会永久失效。
 *
 * 所以这里额外落一份索引：记录每个挂载最后一次「看得到」的真实路径，以及那个
 * 条目的内容指纹（文件夹取直接子项名字，文件取扩展名）。路径失效时，用指纹在
 * 仓库里找唯一匹配的条目，把挂载重新绑过去。
 *
 * 索引是 data.json 的镜像 + 指纹，不是第二份配置：以 data.json 为准，索引只负责
 * 「找回」和「data.json 丢失时的恢复」。
 */

import { App, TAbstractFile, TFile, TFolder } from "obsidian";
import { Mount, MountKind, NameMode } from "./types";

export const INDEX_VERSION = 1;
export const INDEX_FILE = "mounts.index.json";

/** 指纹里最多记录多少个直接子项，避免超大目录写出巨长的索引。 */
const MAX_SIGNATURE_ENTRIES = 24;

export interface MountSnapshot {
  id: string;
  kind: MountKind;
  source: string;
  under: string;
  name: string;
  nameMode: NameMode;
  enabled: boolean;
  collapsed: boolean;
  /** 源条目的内容指纹，形如 `d|f:a.md|d:sub` 或 `f|md`。 */
  sourceSignature: string;
  /** 挂载点（目标文件夹）的指纹。 */
  underSignature: string;
}

export interface StoredIndex {
  version: number;
  updatedAt: number;
  mounts: MountSnapshot[];
}

/**
 * 条目指纹。
 *
 * 文件夹只看「直接子项的名字和类型」：改名、移动都不会改变它，所以能用来找回
 * 被改名/搬走的文件夹；只有内容被大量增删时才会不匹配，这时宁可放弃也不乱绑。
 */
export function signatureOf(file: TAbstractFile | null | undefined): string {
  if (!file) return "";
  if (file instanceof TFolder) {
    const parts = file.children.map(
      (child) => `${child instanceof TFolder ? "d" : "f"}:${child.name}`
    );
    parts.sort();
    return `d|${parts.slice(0, MAX_SIGNATURE_ENTRIES).join("|")}`;
  }
  if (file instanceof TFile) return `f|${file.extension}`;
  return "";
}

export function pathSignature(app: App, path: string): string {
  if (!path) {
    // 仓库根目录不参与指纹匹配
    return "";
  }
  return signatureOf(app.vault.getAbstractFileByPath(path));
}

export function snapshotMounts(app: App, mounts: Mount[]): MountSnapshot[] {
  return mounts.map((mount) => ({
    id: mount.id,
    kind: mount.kind,
    source: mount.source,
    under: mount.under,
    name: mount.name,
    nameMode: mount.nameMode,
    enabled: mount.enabled,
    collapsed: mount.collapsed,
    sourceSignature: pathSignature(app, mount.source),
    underSignature: pathSignature(app, mount.under),
  }));
}

export function indexFilePath(dir: string | undefined, pluginId: string): string {
  const base = (dir && dir.trim()) || `.obsidian/plugins/${pluginId}`;
  return `${base.replace(/\/+$/, "")}/${INDEX_FILE}`;
}

export async function readMountIndex(
  app: App,
  dir: string | undefined,
  pluginId: string
): Promise<StoredIndex | null> {
  const adapter = app.vault?.adapter;
  if (!adapter?.read) return null;
  const path = indexFilePath(dir, pluginId);
  try {
    let exists = true;
    if (typeof adapter.exists === "function") {
      try {
        exists = await adapter.exists(path);
      } catch {
        exists = false;
      }
    }
    if (!exists) return null;
    const raw = await adapter.read(path);
    const data = JSON.parse(raw) as StoredIndex;
    if (!data || data.version !== INDEX_VERSION || !Array.isArray(data.mounts)) return null;
    return data;
  } catch {
    return null;
  }
}

/** 写索引；任何写入失败都只是「这次找回能力变弱」，绝不能影响挂载本身。 */
export async function writeMountIndex(
  app: App,
  dir: string | undefined,
  pluginId: string,
  mounts: Mount[]
): Promise<StoredIndex | null> {
  const adapter = app.vault?.adapter;
  if (!adapter?.write) return null;
  const payload: StoredIndex = {
    version: INDEX_VERSION,
    updatedAt: Date.now(),
    mounts: snapshotMounts(app, mounts),
  };
  const path = indexFilePath(dir, pluginId);
  const text = JSON.stringify(payload, null, 2);
  try {
    await adapter.write(path, text);
    return payload;
  } catch {
    // 插件目录还没建出来时补一次 mkdir 再写。
    try {
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent && typeof adapter.mkdir === "function") await adapter.mkdir(parent);
      await adapter.write(path, text);
      return payload;
    } catch {
      return null;
    }
  }
}

/* -------------------------------------------------------------- 失效路径找回 */

function allFolders(app: App): TFolder[] {
  const out: TFolder[] = [];
  for (const file of app.vault.getAllLoadedFiles()) {
    if (file instanceof TFolder && file.path !== "/") out.push(file);
  }
  return out;
}

function allFiles(app: App): TFile[] {
  const out: TFile[] = [];
  for (const file of app.vault.getAllLoadedFiles()) {
    if (file instanceof TFile) out.push(file);
  }
  return out;
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * 在仓库里找一个「原路径失效、但内容对得上」的文件夹。
 *
 * 必须唯一：同名的项目副本很可能指纹完全一样，绑错比不绑更糟，所以宁可返回 null。
 */
function findMovedFolder(
  app: App,
  oldPath: string,
  oldName: string,
  signature: string
): string | null {
  if (!signature) return null;
  const candidates = allFolders(app).filter(
    (folder) => folder.path !== oldPath && signatureOf(folder) === signature
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].path;

  // 多个候选时，用原来的名字再筛一次；仍然不唯一就放弃。
  const sameName = candidates.filter((folder) => folder.name === oldName);
  return sameName.length === 1 ? sameName[0].path : null;
}

/** 挂载源被改名/移动后，按索引指纹找回它现在的位置。 */
export function findMovedSource(
  app: App,
  mount: Mount,
  snapshot: MountSnapshot | undefined
): string | null {
  const oldPath = mount.source;
  const oldName = lastSegment(oldPath);
  if (!oldPath) return null;

  if (mount.kind === "file") {
    // 文件没有可靠的内容指纹（改一个字就变），只能靠「文件名唯一」来找，
    // 覆盖「整个父目录被搬走」的情况；文件自己被改名只能靠实时 rename 事件。
    const candidates = allFiles(app).filter(
      (file) => file.name === oldName && file.path !== oldPath
    );
    return candidates.length === 1 ? candidates[0].path : null;
  }

  const signature = snapshot?.sourceSignature || signatureOf(app.vault.getAbstractFileByPath(oldPath));
  return findMovedFolder(app, oldPath, oldName, signature);
}

/**
 * 挂载点（目标文件夹）被改名/移动后，按索引指纹找回。
 * 找不到就返回 null，绝不擅自把挂载挪到别的目录。
 */
export function findMovedUnder(
  app: App,
  mount: Mount,
  snapshot: MountSnapshot | undefined
): string | null {
  if (!mount.under) return null;
  const oldPath = mount.under;
  const signature =
    snapshot?.underSignature || signatureOf(app.vault.getAbstractFileByPath(oldPath));
  const found = findMovedFolder(app, oldPath, lastSegment(oldPath), signature);
  if (!found) return null;
  // 不能把挂载点挪进它自己的源目录里，否则会出现「挂载包含自己」的怪结构。
  if (mount.kind === "folder" && (found === mount.source || found.startsWith(mount.source + "/"))) {
    return null;
  }
  return found;
}

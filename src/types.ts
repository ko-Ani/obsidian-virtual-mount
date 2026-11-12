import { normalizePath } from "obsidian";

/** 挂载类型：整个文件夹镜像，还是单篇文件。 */
export type MountKind = "folder" | "file";

export interface Mount {
  id: string;
  kind: MountKind;
  /** 真实路径（仓库内的相对路径），文件只会存在这里。 */
  source: string;
  /** 虚拟挂载点：要在哪个文件夹下“显示”它。根目录用空串。 */
  under: string;
  /** 显示名称，留空则用源路径最后一段。 */
  name: string;
  enabled: boolean;
  collapsed: boolean;
}

export interface Settings {
  mounts: Mount[];
  /** 排序时文件夹排在文件前面。 */
  foldersFirst: boolean;
  /** 在虚拟行上显示一个小角标。 */
  showBadge: boolean;
  /** 打开虚拟位置的文件后，自动在原生文件浏览器里定位到真实位置。 */
  revealOnOpen: boolean;
  /** 单个虚拟文件夹最多渲染多少项，防止巨大目录卡死。 */
  maxChildren: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mounts: [],
  foldersFirst: true,
  showBadge: true,
  revealOnOpen: false,
  maxChildren: 500,
};

export const DEFAULT_MOUNT: Omit<Mount, "id" | "source"> = {
  kind: "folder",
  under: "",
  name: "",
  enabled: true,
  // 和原生文件夹一致：新建的挂载点默认折叠，点开后才展开。
  collapsed: true,
};

let counter = 0;

export function newId(): string {
  counter += 1;
  return `vm-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 把用户输入/配置里的路径清洗成仓库内的相对路径；根目录统一用空串表示。
 * 走 Obsidian 的 normalizePath，保证跨平台斜杠、首尾斜杠、NBSP 都被处理。
 */
export function cleanPath(path: string): string {
  const raw = (path ?? "").trim();
  if (!raw || raw === "/" || raw === "\\") return "";
  const normalized = normalizePath(raw);
  return normalized === "/" ? "" : normalized;
}

/** 把挂载配置规范化，兼容旧版本/手写 data.json。 */
export function normalizeMount(raw: Partial<Mount>): Mount {
  const kind: MountKind = raw.kind === "file" ? "file" : "folder";
  const source = cleanPath(raw.source ?? "");
  const under = cleanPath(raw.under ?? "");
  const name = (raw.name ?? "").trim() || source.split("/").pop() || "未命名";
  return {
    id: raw.id || newId(),
    kind,
    source,
    under,
    name,
    enabled: raw.enabled !== false,
    // 只有显式记录过“展开”的挂载才保持展开；新挂载 / 旧配置缺字段时默认折叠。
    collapsed: raw.collapsed !== false,
  };
}

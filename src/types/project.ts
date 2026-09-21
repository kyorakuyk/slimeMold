/** Project-scoped persisted metadata contracts. */

/** 资产（写文件节点产出的文件/预览）元数据 */
export interface AssetMeta {
  id: string;
  /** 显示名（通常带扩展名），如 hello_world.py */
  name: string;
  /** 落盘的绝对路径；若为 null 表示仅存入工作流内部、随工作流销毁（未真正写盘） */
  path: string | null;
  /** 文件类型提示，如 'python' / 'text' / 'image' / 'json' */
  kind: string;
  /** 文本内容（用于预览与导出；二进制资产可为空） */
  content: string;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
  /** 产出该资产的节点 id */
  nodeId?: string;
  /** 是否为工作区文件（true=落到用户指定文件夹；false=工作流内部临时目录） */
  inWorkspace: boolean;
}

/** 最近项目记录（持久化在 localStorage，不随项目文件本身） */
export interface RecentProject {
  path: string;
  name: string;
  openedAt: string;
}

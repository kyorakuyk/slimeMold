import type { CapabilityLevel } from './capability';
import type { ParamDef, PortDef } from './graph';

/**
 * 步骤 13（人类-职业-个人抽象）· 自定义职业声明。
 * 允许 custom node 包定义「一类节点」（新职业），而非只能定义单个具体节点。
 */
export interface PluginOccupation {
  /** 职业类名（在 index.js 中 export，节点 extends 引用此名） */
  name: string;
  /** 继承的框架职业类名 */
  extends: string;
  description?: string;
}

export interface PluginNodeMeta {
  typeId: string;
  name: string;
  category?: string;
  description?: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params?: ParamDef[];
  /** 插件节点显式声明的最小能力等级；省略时 loader 默认按 'io' 受限边界注入。 */
  minCapability?: CapabilityLevel;
  /** 节点继承的职业类名；loader 将其解析为最终能力等级。 */
  extends?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** 入口脚本文件名，如 index.js */
  entry: string;
  nodes: PluginNodeMeta[];
  /** 本包自定义的职业类清单。 */
  occupations?: PluginOccupation[];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  // 'dir' = AppData 正式插件；'files' = 浏览器/手动导入；'custom' = custom_nodes/ 用户节点
  source: 'dir' | 'files' | 'custom';
  path?: string;
  // custom 来源的生效范围：'program' = 程序安装目录；'project' = 当前项目目录
  scope?: 'program' | 'project';
}

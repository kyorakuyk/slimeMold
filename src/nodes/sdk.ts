/**
 * 步骤 13（节点三层抽象 · 人类-职业-个人）· 阶段 A 抽象骨架。
 *
 * 设计目标（对齐用户 2026-08-05 拍板的模型）：
 *  - 第一层「人类」= `Node`：所有节点的元抽象，定义"什么是节点"。
 *  - 第二层「职业」= `ComputeNode`/`IoNode`/`SandboxWriteNode`/`CoordinatorNode`/`SystemNode`/`GitNode`：
 *    一类节点的模板，预置该等级能调用的原生方法（按 ExecContext 字段映射），方法逐级累积（继承链）。
 *  - 第三层「个人」= 具体节点：继承某个职业类，实现 `execute`（或重载其他方法）。
 *
 * 权限边界对齐原则：
 *  - 基类**只在类型层收敛 ctx 能力视图**（让继承者写代码时即知自己权限），不自己实现能力；
 *    真实能力仍由引擎 `applyCapability`（executor.ts:124）在运行时按 minCapability 注入/裁剪。
 *  - 高权限职业类的"受限方法"（commitAll / commitLanes / runGit）在基类里是「拒绝型占位」，
 *    与 applyCapability 的 deny 模式一致：未达等级调用即抛错，绝不静默放行。
 *  - 用户自定义节点要提权，必须 `import` 并继承对应职业父类（门槛 = 懂 SDK 继承结构 + 主动 import 受限类），
 *    而非改 manifest 字段——这是取代"配置文件后门"的 basemod 式模型。
 *
 * 兼容性：本文件是「类式声明」的并行入口，不破坏现有 `executors` 函数式路径；
 * `createNodeDef` 与 `loader.ts` 的适配（类式 → NodeDefinition）留待阶段 B 实现。
 */

import type { ExecContext, NodeRole } from '../types';

/* ============ 第一层：人类（所有节点的元抽象） ============ */

/**
 * 人类基座：定义"什么是节点"。所有职业类都继承它。
 * 暴露最基础的、compute 级（L0）即始终可用的原生方法视图。
 * 注意：类型层只收窄字段可见性；compute 级下 llm/storage/sandbox 等会被引擎替换为拒绝型实现，
 * 因此这里的方法签名与 ExecContext 对齐，但继承 ComputeNode 时这些字段在类型上即不可见。
 */
export abstract class Node {
  /** 节点类型标识（由子类在 manifest 中声明，这里仅作契约锚点） */
  abstract readonly typeId: string;

  /** 人类基座始终可用的基础能力（L0 compute 即可见） */
  protected ctx!: ExecContextBase;

  /** 第三层「个人」必须实现的执行入口 */
  abstract execute(
    inputs: Record<string, unknown>,
    params: Record<string, unknown>,
    ctx: ExecContextBase,
  ): Promise<Record<string, unknown>>;

  /** 角色分类（用于面板筛选，子类可覆写） */
  role?: NodeRole;
}

/** 人类基座可见的 ctx 视图：logger/vars/signal/costLog/reportCost/setPartial/setBranches? */
export type ExecContextBase = Pick<
  ExecContext,
  | 'logger'
  | 'vars'
  | 'signal'
  | 'costLog'
  | 'reportCost'
  | 'setPartial'
  | 'setBranches'
>;

/* ============ 第二层：职业（分工抽象，继承链，方法逐级累积） ============ */

/** L0 compute：纯计算只读，无新增方法（仅人类基座视图） */
export abstract class ComputeNode extends Node {
  protected declare ctx: ExecContextCompute;
  abstract execute(
    inputs: Record<string, unknown>,
    params: Record<string, unknown>,
    ctx: ExecContextCompute,
  ): Promise<Record<string, unknown>>;
}

/** compute 级可见 ctx：人类基座 + 无额外字段（llm/storage/sandbox 在类型上不可见） */
export type ExecContextCompute = ExecContextBase;

/** L1 io：受限 I/O，+ llm / storage / addAsset / assets / writeOutEdgeScope? */
export abstract class IoNode extends ComputeNode {
  protected declare ctx: ExecContextIo;
  abstract execute(
    inputs: Record<string, unknown>,
    params: Record<string, unknown>,
    ctx: ExecContextIo,
  ): Promise<Record<string, unknown>>;
}

export type ExecContextIo = ExecContextBase &
  Pick<ExecContext, 'llm' | 'storage' | 'addAsset' | 'assets' | 'writeOutEdgeScope'>;

/** L2 sandbox_write：隔离写，+ sandbox 句柄（但 commitAll/commitLanes 为拒绝型，落地权在 CoordinatorNode） */
export abstract class SandboxWriteNode extends IoNode {
  protected declare ctx: ExecContextSandboxWrite;
  abstract execute(
    inputs: Record<string, unknown>,
    params: Record<string, unknown>,
    ctx: ExecContextSandboxWrite,
  ): Promise<Record<string, unknown>>;
}

export type ExecContextSandboxWrite = ExecContextIo & Pick<ExecContext, 'sandbox'>;

/** L3 coordinator：协调者，+ 真实 commitAll/commitLanes 落地权（唯一能落地主工作区的职业） */
export abstract class CoordinatorNode extends SandboxWriteNode {
  protected declare ctx: ExecContextCoordinator;
  abstract execute(
    inputs: Record<string, unknown>,
    params: Record<string, unknown>,
    ctx: ExecContextCoordinator,
  ): Promise<Record<string, unknown>>;
}

/** coordinator 级 ctx：sandbox 句柄在引擎侧为完整实现（含真 commitAll/commitLanes） */
export type ExecContextCoordinator = ExecContextSandboxWrite & Pick<ExecContext, 'sandboxLanes'>;

/** L4 system：系统级，继承协调者全部能力 + 受限系统封装（非任意 shell） */
export abstract class SystemNode extends CoordinatorNode {
  protected declare ctx: ExecContextSystem;
  abstract execute(
    inputs: Record<string, unknown>,
    params: Record<string, unknown>,
    ctx: ExecContextSystem,
  ): Promise<Record<string, unknown>>;

  /**
   * 受限系统封装：默认「拒绝型占位」。引擎在 system 级会注入真实现。
   * 子类不应直接依赖此默认实现（会抛错），仅作为类型契约与方法存在的锚点。
   */
  protected async systemCommand(_cmd: string, _args: string[]): Promise<string> {
    throw new Error('权限不足：SystemNode.systemCommand 为拒绝型占位，需引擎在 system 级注入');
  }
}

export type ExecContextSystem = ExecContextCoordinator;

/**
 * L4 细分：GitNode —— 仅暴露受限 git 命令封装，不暴露任意 shell / exec。
 * 用户可继承此类获得 git 操作能力（如 worktree 管理），但无法借机执行任意系统命令。
 * runGit 默认拒绝型占位，引擎在 system 级注入真实现（经 Rust command 受控调用 git）。
 */
export abstract class GitNode extends SystemNode {
  protected declare ctx: ExecContextSystem;

  /** 受限 git 调用：args 为 git 子命令与参数，如 ['worktree', 'add', <path>]。默认拒绝型占位。 */
  protected async runGit(_args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    throw new Error('权限不足：GitNode.runGit 为拒绝型占位，需引擎在 system 级注入');
  }
}

/**
 * 职业 → 能力等级映射（供阶段 B 的 loader 把"继承的职业类"翻译成 minCapability）。
 * 用户自定义职业类继承某框架职业后，能力上限 = 该职业对应的等级。
 */
export const OCCUPATION_CAPABILITY: Record<string, import('../types').CapabilityLevel> = {
  ComputeNode: 'compute',
  IoNode: 'io',
  SandboxWriteNode: 'sandbox_write',
  CoordinatorNode: 'coordinator',
  SystemNode: 'system',
  GitNode: 'system',
};

/** 取一个类所继承的职业等级（沿原型链向上找，命中 OCCUPATION_CAPABILITY 即返回） */
export function capabilityOfClass(ctor: unknown): import('../types').CapabilityLevel | undefined {
  let proto = (ctor as { prototype?: unknown })?.prototype as { constructor?: unknown } | undefined;
  const seen = new Set<unknown>();
  while (proto && !seen.has(proto)) {
    seen.add(proto);
    const name = (proto.constructor as { name?: string })?.name;
    if (name && OCCUPATION_CAPABILITY[name]) return OCCUPATION_CAPABILITY[name];
    proto = Object.getPrototypeOf(proto) as { constructor?: unknown } | undefined;
  }
  return undefined;
}

/**
 * 步骤 11 阶段 D：节点权限能力分级（capability model）。
 * 执行引擎在 executeNode 时按节点声明的 minCapability（或按 typeId 推断的默认等级）
 * 裁剪注入的 ExecContext：越权字段被替换为「拒绝型」实现，而非缺失（保持类型完整、运行时受控）。
 *
 * - `compute`       L0 纯计算只读：仅 logger/vars/signal/costLog。禁止任何 I/O。
 * - `io`            L1 受限 I/O：可使用受限 storage/addAsset/llm/assets。
 * - `sandbox_write` L2 隔离写：可使用 sandbox，但剥离 commitAll/commitLanes。
 * - `coordinator`   L3 协调者：可汇总沙箱产物，但仍受宿主策略约束。
 * - `system`        L4 系统级：可经宿主 command 使用系统能力。
 *
 * 等级单调递增：未显式声明 minCapability 时，引擎按 typeId 前缀推断默认等级。
 */
export type CapabilityLevel = 'compute' | 'io' | 'sandbox_write' | 'coordinator' | 'system';
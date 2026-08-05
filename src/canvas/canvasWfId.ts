import { createContext } from 'react';

/**
 * 画布所属工作流 id 上下文（拆分视图专用）。
 * - 主画布（无拆分）：provider 不包，或值为 undefined → 节点运行类操作回退到 activeWfId。
 * - 拆分视图右栏：WorkflowEditorInner 用该 wfId 包裹 ReactFlow，使内部节点
 *   （BaseNode/GroupProxyNode）能拿到正确工作流，从而「运行该节点」「重跑」等操作
 *   作用于右栏工作流而非错误的主工作流。
 */
export const CanvasWfIdContext = createContext<string | undefined>(undefined);

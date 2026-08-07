import type { NodeDefinition } from '../../types';
import { createNodeDef } from '../../types';
import { useWorkflowStore } from '../../store/workflowStore';
import { findRole, resolveRoleSystem } from '../../agents/agentManager';

const agentChat: NodeDefinition = {
  typeId: 'agent.chat',
  name: '智能体',
  category: 'AI',
  role: 'worker',
  whenToUse: '需要调用 LLM 生成文本/做推理时使用；配合角色库快速获得职业提示词，支持节点级模型覆写。',
  description:
    '调用绑定的智能体（多协议 LLM）处理输入文本。可绑定角色库中的角色快速获得职业提示词，并支持节点级模型覆写与上下文隔离。',
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text' },
    { id: 'image', label: '图片', type: 'image' },
  ],
  outputs: [
    { id: 'text', label: '回复', type: 'text' },
    { id: 'filename', label: '推断文件名', type: 'text' },
  ],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    {
      key: 'modelOverride',
      label: '节点级模型（留空用智能体默认）',
      type: 'text',
      default: '',
      placeholder: '如 gpt-4o / claude-3-opus',
    },
    { key: 'system', label: '系统提示词（覆盖默认）', type: 'textarea', default: '' },
  ],
  async execute(inputs, params, ctx) {
    const agentId = String(params.agentId ?? '').trim();
    if (!agentId) throw new Error('未绑定智能体，请在右侧面板选择');
    const roleId = String(params.roleId ?? '').trim();
    const roles = useWorkflowStore.getState().roles;
    const role = findRole(roles, roleId || undefined);
    const system =
      resolveRoleSystem(role, String(params.system ?? '')) ||
      undefined;
    const prompt = String(inputs.prompt ?? '');
    const image = inputs.image != null ? String(inputs.image) : undefined;
    const messages: Array<{ role: 'system' | 'user'; content: string; image?: string }> = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt, ...(image ? { image } : {}) });
    const modelOverride = String(params.modelOverride ?? '').trim() || undefined;
    let acc = '';
    const text = await ctx.llm(
      agentId,
      messages as any,
      (d) => {
        acc += d;
        ctx.setPartial('text', acc);
      },
      modelOverride,
    );
    return { text: acc || text, filename: '' };
  },
};

export const aiNodes: NodeDefinition[] = [agentChat].map(createNodeDef);

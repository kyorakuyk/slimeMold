import type { Edge, Node } from '@xyflow/react';
import type { FlowNode, FlowEdge } from '../types';

export interface StarterTemplate {
  id: string;
  name: string;
  emoji: string;
  desc: string;
  /** 生成模板的节点与边；id 为模板内局部 id，载入时会映射到画布 */
  build: () => { nodes: FlowNode[]; edges: FlowEdge[] };
}

/** 构造一个基础节点（无状态、idle） */
function node(
  id: string,
  typeId: string,
  label: string,
  params: Record<string, unknown>,
  x: number,
  y: number,
): FlowNode {
  return {
    id,
    type: 'base',
    position: { x, y },
    data: { typeId, label, params, status: 'idle' },
  } as FlowNode;
}

function edge(source: string, sourceHandle: string, target: string, targetHandle: string): FlowEdge {
  return {
    id: `e-${source}-${sourceHandle}-${target}-${targetHandle}`,
    source,
    target,
    sourceHandle,
    targetHandle,
    animated: false,
  } as FlowEdge;
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: 'polish-email',
    name: '把一句话变成正式邮件',
    emoji: '✉️',
    desc: '输入一句想法，AI 帮你扩写、润色成得体的正式邮件。开箱即用，无需配置模型。',
    build: () => ({
      nodes: [
        node('in', 'input.text', '文本输入', {
          text: '提醒客户项目要延期两天',
        }, 40, 200),
        node('chat', 'agent.chat', '智能体', {
          agentId: '',
          roleId: '',
          modelOverride: '',
          system: '你是一名专业的商务助理，擅长把口语化的简短需求改写为礼貌、清晰、正式的邮件正文。',
          simulate: 'on',
        }, 340, 180),
        node('out', 'output.preview', '结果预览', {}, 660, 200),
      ],
      edges: [
        edge('in', 'text', 'chat', 'prompt'),
        edge('chat', 'text', 'out', 'value'),
      ],
    }),
  },
  {
    id: 'batch-translate',
    name: '批量翻译清单',
    emoji: '🌐',
    desc: '把一列短句逐条交给 AI 翻译，最后合并成一段结果。适合处理名单、标签、短语。',
    build: () => ({
      nodes: [
        node('list', 'flow.list', '构造列表', {
          text: '你好\n谢谢\n再见\n早上好',
          split: 'newline',
          sep: ',',
        }, 40, 160),
        node('map', 'flow.map', '循环批处理', {
          mode: 'agent',
          template: '{{item}}',
          agentId: '',
          prompt: '请把下面这句话翻译成英文，只输出译文：\n{{item}}',
        }, 320, 160),
        node('join', 'flow.join', '合并文本', { sep: '\n' }, 620, 180),
        node('out', 'output.preview', '结果预览', {}, 900, 200),
      ],
      edges: [
        edge('list', 'items', 'map', 'items'),
        edge('map', 'results', 'join', 'items'),
        edge('join', 'text', 'out', 'value'),
      ],
    }),
  },
  {
    id: 'condition-route',
    name: '按条件分流',
    emoji: '🔀',
    desc: '判断输入是否包含某个关键词，命中走一条分支、否则走另一条。演示条件分支怎么用。',
    build: () => ({
      nodes: [
        node('in', 'input.text', '文本输入', { text: '紧急：服务器挂了' }, 40, 220),
        node('if', 'flow.if', '条件分支', {
          expression: 'a.includes("紧急")',
        }, 340, 200),
        node('high', 'output.preview', '结果预览', {}, 680, 80),
        node('low', 'output.preview', '结果预览', {}, 680, 320),
      ],
      edges: [
        edge('in', 'text', 'if', 'cond'),
        edge('if', 'true', 'high', 'value'),
        edge('if', 'false', 'low', 'value'),
      ],
    }),
  },
];

export function getTemplateById(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((t) => t.id === id);
}

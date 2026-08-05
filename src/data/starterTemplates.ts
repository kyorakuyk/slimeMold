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
  {
    id: 'article-outline',
    name: '文章大纲生成',
    emoji: '📝',
    desc: '给一个主题，AI 先列出大纲，再据此扩写成开篇段落。适合写公众号、周报、文档。',
    build: () => ({
      nodes: [
        node('topic', 'input.text', '文本输入', { text: '如何在家高效远程办公' }, 40, 160),
        node('outline', 'agent.chat', '智能体', {
          agentId: '', roleId: '', modelOverride: '', system: '',
          prompt: '请为主题《{{a}}》列出一份 5 个小节的文章大纲，每节一句话。',
          simulate: 'on',
        }, 340, 140),
        node('draft', 'agent.chat', '智能体', {
          agentId: '', roleId: '', modelOverride: '', system: '',
          prompt: '根据下面的大纲，写一段吸引人的开篇（约 120 字）：\n{{a}}',
          simulate: 'on',
        }, 640, 160),
        node('out', 'output.preview', '结果预览', {}, 940, 180),
      ],
      edges: [
        edge('topic', 'text', 'outline', 'prompt'),
        edge('outline', 'text', 'draft', 'prompt'),
        edge('draft', 'text', 'out', 'value'),
      ],
    }),
  },
  {
    id: 'extract-json',
    name: '从文本提取结构化信息',
    emoji: '🧾',
    desc: '把一段杂乱的文字交给 AI，按你给的字段整理成结构化内容，便于后续处理。',
    build: () => ({
      nodes: [
        node('raw', 'input.text', '文本输入', {
          text: '订单号 A1024，客户张三，金额 ¥299，状态已发货，城市杭州。',
        }, 40, 200),
        node('extract', 'agent.chat', '智能体', {
          agentId: '', roleId: '', modelOverride: '', system: '',
          prompt:
            '从下面文本中提取字段：订单号、客户、金额、状态、城市。只输出这五项，用换行分隔，格式「字段: 值」。\n{{a}}',
          simulate: 'on',
        }, 340, 180),
        node('out', 'output.preview', '结果预览', {}, 660, 200),
      ],
      edges: [edge('raw', 'text', 'extract', 'prompt'), edge('extract', 'text', 'out', 'value')],
    }),
  },
  {
    id: 'summarize',
    name: '长文一键摘要',
    emoji: '✂️',
    desc: '贴入一段长文，AI 帮你压缩成 3 条要点，快速抓住重点。',
    build: () => ({
      nodes: [
        node('long', 'input.text', '文本输入', {
          text: '（把这里替换成一段长文章……）',
        }, 40, 200),
        node('sum', 'agent.chat', '智能体', {
          agentId: '', roleId: '', modelOverride: '', system: '',
          prompt: '请把下面内容总结成不超过 3 条要点，每条一句话：\n{{a}}',
          simulate: 'on',
        }, 340, 180),
        node('out', 'output.preview', '结果预览', {}, 660, 200),
      ],
      edges: [edge('long', 'text', 'sum', 'prompt'), edge('sum', 'text', 'out', 'value')],
    }),
  },
  {
    id: 'sentiment-route',
    name: '情绪分类分流',
    emoji: '😊',
    desc: '判断一条评论是正面还是负面，分别送到不同结果里。演示「条件 + 分流」组合用法。',
    build: () => ({
      nodes: [
        node('in', 'input.text', '文本输入', { text: '这个产品太好用了，强烈推荐！' }, 40, 200),
        node('judge', 'agent.chat', '智能体', {
          agentId: '', roleId: '', modelOverride: '', system: '',
          prompt: '判断下面评论的情绪，只回复“正面”或“负面”两个字：\n{{a}}',
          simulate: 'on',
        }, 340, 180),
        node('if', 'flow.if', '条件分支', { expression: 'a.includes("正面")' }, 640, 180),
        node('pos', 'output.preview', '结果预览', {}, 940, 80),
        node('neg', 'output.preview', '结果预览', {}, 940, 320),
      ],
      edges: [
        edge('in', 'text', 'judge', 'prompt'),
        edge('judge', 'text', 'if', 'cond'),
        edge('if', 'true', 'pos', 'value'),
        edge('if', 'false', 'neg', 'value'),
      ],
    }),
  },
  {
    id: 'multilingual-titles',
    name: '多语言标题生成',
    emoji: '🌍',
    desc: '给一个主题，AI 同时生成中文、英文、日文三个标题，循环批处理一次搞定。',
    build: () => ({
      nodes: [
        node('topic', 'input.text', '文本输入', { text: '一款极简笔记软件' }, 40, 160),
        node('langs', 'flow.list', '构造列表', {
          text: '中文\n英文\n日文', split: 'newline', sep: ',',
        }, 320, 160),
        node('gen', 'flow.map', '循环批处理', {
          mode: 'agent', template: '{{item}}', agentId: '',
          prompt: '为主题《极简笔记软件》生成一条{{item}}标题，只输出标题本身。',
        }, 600, 160),
        node('join', 'flow.join', '合并文本', { sep: '\n' }, 900, 180),
        node('out', 'output.preview', '结果预览', {}, 1180, 200),
      ],
      edges: [
        edge('topic', 'text', 'gen', 'prompt'),
        edge('langs', 'items', 'gen', 'items'),
        edge('gen', 'results', 'join', 'items'),
        edge('join', 'text', 'out', 'value'),
      ],
    }),
  },
];

export function getTemplateById(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((t) => t.id === id);
}

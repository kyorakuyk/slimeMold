import { createNodeDef, type NodeDefinition } from '../../types';

const textInput: NodeDefinition = {
  typeId: 'input.text',
  name: '文本输入',
  category: '输入',
  role: 'io',
  whenToUse: '作为工作流的起点，提供固定文本或提示词；需要动态文本时用「模板拼接」。',
  description: '提供固定文本，作为工作流的起点数据源',
  inputs: [],
  outputs: [{ id: 'text', label: '文本', type: 'text' }],
  params: [
    {
      key: 'text',
      label: '内容',
      type: 'textarea',
      default: '',
      placeholder: '输入要传递给下游节点的文本…',
    },
  ],
  async execute(_inputs, params) {
    return { text: String(params.text ?? '') };
  },
};

const imageLoad: NodeDefinition = {
  typeId: 'image.load',
  name: '图片',
  category: '输入',
  description: '加载一张图片（URL 或 data URL），输出 image 端口，可接入多模态智能体节点',
  params: [],
  inputs: [{ id: 'url', label: '图片 URL', type: 'text' }],
  outputs: [{ id: 'image', label: '图片', type: 'image' }],
  execute: async (_ctx, inputs) => {
    const url = inputs.url != null ? String(inputs.url).trim() : '';
    if (!url) throw new Error('请填写图片 URL 或 data URL');
    return { image: url };
  },
};

const imageImport: NodeDefinition = {
  typeId: 'image.import',
  name: '图片导入',
  category: '输入',
  description: '从资产库选择已上传的图片，或点气泡从本机文件资源管理器选图，输出 image 端口',
  params: [{ key: 'asset', label: '选择图片', type: 'asset' }],
  inputs: [],
  outputs: [{ id: 'image', label: '图片', type: 'image' }],
  execute: async (_inputs, params, ctx) => {
    const raw = (params.asset != null ? String(params.asset) : '') as string;
    // 桌面端从文件资源管理器选的本地系统路径
    if (raw.startsWith('path:')) {
      const p = raw.slice(5).trim();
      if (!p) throw new Error('未选择图片文件');
      return { image: p };
    }
    // 浏览器预览环境选的本地文件，已读为 data URL
    if (raw.startsWith('file:')) {
      const dataUrl = raw.slice(5);
      if (!dataUrl) throw new Error('未选择图片文件');
      return { image: dataUrl };
    }
    if (!raw) throw new Error('请在右侧下拉选择图片资产，或点 📂 从本机选图');
    const asset = ctx.assets.find((a) => a.id === raw);
    if (!asset) throw new Error('找不到对应图片资产（可能已被删除）');
    if (!asset.content) throw new Error('该资产无图片内容（请确认是图片资产）');
    return { image: asset.content }; // data URL
  },
};

export const inputNodes: NodeDefinition[] = [textInput, imageLoad, imageImport].map(createNodeDef);

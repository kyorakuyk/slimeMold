import { createNodeDef, type NodeDefinition, type AssetMeta } from '../../types';

const imagePreview: NodeDefinition = {
  typeId: 'image.preview',
  name: '图片预览',
  category: '预览',
  description: '预览上游传来的图片（image 端口），在节点卡片上显示缩略图',
  params: [],
  inputs: [{ id: 'image', label: '图片', type: 'image' }],
  outputs: [{ id: 'image', label: '图片', type: 'image' }],
  execute: async (inputs) => {
    const img = inputs.image != null ? String(inputs.image) : '';
    if (!img) throw new Error('未接入图片');
    return { image: img };
  },
};

/** 图片保存：把上游 image 端口的图片写入资产库，供「资产」面板查看与导出。 */
const imageSave: NodeDefinition = {
  typeId: 'image.save',
  name: '图片保存',
  category: '资产',
  description: '把上游传来的图片（image 端口）保存到当前工作流资产库',
  params: [{ key: 'name', label: '资产名', type: 'text', default: 'image', placeholder: '如 cat.png' }],
  inputs: [{ id: 'image', label: '图片', type: 'image' }],
  outputs: [{ id: 'image', label: '图片', type: 'image' }],
  execute: async (inputs, params, ctx) => {
    const img = inputs.image != null ? String(inputs.image) : '';
    if (!img) throw new Error('未接入图片');
    const name = (params.name ? String(params.name) : 'image') || 'image';
    const ext = img.startsWith('data:')
      ? img.slice(5, img.indexOf(';')).split('/')[1] || 'png'
      : name.includes('.') ? '' : 'png';
    const finalName = ext && !name.includes('.') ? `${name}.${ext}` : name;
    ctx.addAsset({
      id: `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      name: finalName,
      path: null,
      kind: 'image',
      content: img,
      createdAt: new Date().toISOString(),
      nodeId: '',
      inWorkspace: false,
    } as AssetMeta);
    return { image: img };
  },
};

export const mediaNodes: NodeDefinition[] = [imagePreview, imageSave].map(createNodeDef);

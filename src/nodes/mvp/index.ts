import type { ExecContext, NodeDefinition } from '../../types';
import { createNodeDef } from '../../types';
import { createTypeScriptMvpScaffold } from '../../domain/model/artifact';

function textValue(inputs: Record<string, unknown>, params: Record<string, unknown>, key: string): string {
  return String(inputs[key] ?? params[key] ?? '').trim();
}

const projectScaffold: NodeDefinition = {
  typeId: 'project.scaffold',
  name: '生成项目骨架',
  category: '项目 MVP',
  role: 'architect',
  minCapability: 'compute',
  whenToUse: '第一次 MVP：生成带 src/tests/package.json/tsconfig 的完整 TypeScript 项目候选。',
  description: '只生成结构化项目骨架与 FilePatchSet 候选，不写入文件；后续必须由宿主 worktree apply 和用户批准交付。',
  inputs: [{ id: 'projectName', label: '项目名称', type: 'text' }],
  outputs: [
    { id: 'projectSpec', label: '项目规格', type: 'json' },
    { id: 'manifest', label: '目录清单', type: 'json' },
    { id: 'patchSet', label: '文件补丁候选', type: 'json' },
    { id: 'summary', label: '摘要', type: 'text' },
  ],
  params: [{ key: 'projectName', label: '项目名称（兜底）', type: 'text', default: '' }],
  async execute(inputs, params, _ctx: ExecContext) {
    const projectName = textValue(inputs, params, 'projectName');
    if (!projectName) throw new Error('项目名称不能为空');
    const scaffold = createTypeScriptMvpScaffold(projectName);
    return {
      projectSpec: scaffold.projectSpec,
      manifest: scaffold.manifest,
      patchSet: scaffold.patchSet,
      summary: scaffold.patchSet.summary,
    };
  },
};

export const mvpNodes: NodeDefinition[] = [projectScaffold].map(createNodeDef);

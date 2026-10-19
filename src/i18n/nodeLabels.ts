import type { NodeRole } from '../types/node';

type Translate = (key: string) => unknown;

/** Map persisted node taxonomy values to localized UI copy without changing catalog data. */
export function localizeNodeCategory(category: string, t: Translate): string {
  switch (category) {
    case '输入':
      return String(t('canvas.node.category.input'));
    case '输出':
      return String(t('canvas.node.category.output'));
    case '流程':
      return String(t('canvas.node.category.flow'));
    case '工具':
      return String(t('canvas.node.category.tool'));
    case '文本':
      return String(t('canvas.node.category.text'));
    case '协调':
      return String(t('canvas.node.category.coordination'));
    case '派发':
      return String(t('canvas.node.category.dispatch'));
    case '审计':
      return String(t('canvas.node.category.audit'));
    case '预览':
      return String(t('canvas.node.category.preview'));
    case '资产':
      return String(t('canvas.node.category.assets'));
    case '项目 MVP':
      return String(t('canvas.node.category.projectMvp'));
    case '自定义':
      return String(t('canvas.node.category.custom'));
    case 'AI':
      return String(t('canvas.node.category.ai'));
    default:
      return category;
  }
}

export function localizedNodeRole(role: NodeRole, t: Translate): { label: string; hint: string } {
  switch (role) {
    case 'orchestrator':
      return { label: String(t('node.role.orchestrator')), hint: String(t('node.roleHint.orchestrator')) };
    case 'architect':
      return { label: String(t('node.role.architect')), hint: String(t('node.roleHint.architect')) };
    case 'explorer':
      return { label: String(t('node.role.explorer')), hint: String(t('node.roleHint.explorer')) };
    case 'worker':
      return { label: String(t('node.role.worker')), hint: String(t('node.roleHint.worker')) };
    case 'verifier':
      return { label: String(t('node.role.verifier')), hint: String(t('node.roleHint.verifier')) };
    case 'observer':
      return { label: String(t('node.role.observer')), hint: String(t('node.roleHint.observer')) };
    case 'io':
      return { label: String(t('node.role.io')), hint: String(t('node.roleHint.io')) };
  }
}

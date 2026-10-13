import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TARGET_FILES = [
  'src/agents/agentManager.ts',
  'src/canvas/WorkflowEditor.tsx',
  'src/canvas/CanvasWelcomeSurface.tsx',
  'src/canvas/CanvasPanelControls.tsx',
  'src/canvas/useCanvasContextMenu.tsx',
  'src/canvas/useCanvasNodePicker.tsx',
  'src/components/LeftSidebar.tsx',
  'src/App.tsx',
  'src/components/OrchestratorPanel.tsx',
  'src/components/OrchestratorPanelDetailView.tsx',
  'src/components/OrchestratorPanelListView.tsx',
  'src/components/OrchestratorPanelTaskGraphSection.tsx',
  'src/components/OrchestratorPanelViewConfig.ts',
  'src/components/OrchestratorPanelWorkerRunsView.tsx',
  'src/components/Inspector.tsx',
  'src/components/TopBar.tsx',
  'src/components/StatusBar.tsx',
  'src/components/RunHistoryPanel.tsx',
  'src/components/RouteTableEditor.tsx',
  'src/components/TokenUsagePanel.tsx',
  'src/components/SettingsCenter.tsx',
  'src/components/agentPanel/AgentCatalogList.tsx',
  'src/components/agentPanel/AgentEditorForm.tsx',
  'src/components/agentPanel/AgentConnectionFields.tsx',
  'src/components/agentPanel/AgentModelFields.tsx',
  'src/components/topBar/topBarMenus.tsx',
  'src/components/topBar/WorkflowTabStrip.tsx',
  'src/components/topBar/TopBarActionButtons.tsx',
  'src/components/OrchestratorStageCard.tsx',
  'src/components/orchestratorPanelTaskGraph.ts',
  'src/canvas/useCanvasReconnect.ts',
  'src/canvas/useRightBoxSelection.ts',
  'src/canvas/useSplitWorkflowGraph.ts',
  'src/canvas/useCanvasDrop.ts',
  'src/canvas/connectValidation.ts',
  'src/plugins/pluginManager.ts',
  'src/engine/executor.ts',
  'src/engine/runWorkflowPhases.ts',
  'src/engine/executorNodePhases.ts',
] as const;

const NAMESPACE_CANDIDATES: Record<(typeof TARGET_FILES)[number], string[]> = {
  'src/agents/agentManager.ts': ['agents'],
  'src/canvas/WorkflowEditor.tsx': ['ui'],
  'src/canvas/CanvasWelcomeSurface.tsx': ['ui'],
  'src/canvas/CanvasPanelControls.tsx': ['ui'],
  'src/canvas/useCanvasContextMenu.tsx': ['ui'],
  'src/canvas/useCanvasNodePicker.tsx': ['ui'],
  'src/components/LeftSidebar.tsx': ['panels'],
  'src/App.tsx': ['ui'],
  'src/components/OrchestratorPanel.tsx': ['panels'],
  'src/components/OrchestratorPanelDetailView.tsx': ['panels'],
  'src/components/OrchestratorPanelListView.tsx': ['panels'],
  'src/components/OrchestratorPanelTaskGraphSection.tsx': ['panels'],
  'src/components/OrchestratorPanelViewConfig.ts': [],
  'src/components/OrchestratorPanelWorkerRunsView.tsx': ['panels'],
  'src/components/Inspector.tsx': ['ui', 'inspector'],
  'src/components/TopBar.tsx': ['ui'],
  'src/components/StatusBar.tsx': ['ui', 'statusbar'],
  'src/components/RunHistoryPanel.tsx': ['panels'],
  'src/components/RouteTableEditor.tsx': ['panels'],
  'src/components/TokenUsagePanel.tsx': ['panels'],
  'src/components/SettingsCenter.tsx': ['settings', 'agents'],
  'src/components/agentPanel/AgentCatalogList.tsx': ['agents'],
  'src/components/agentPanel/AgentEditorForm.tsx': ['agents'],
  'src/components/agentPanel/AgentConnectionFields.tsx': ['agents'],
  'src/components/agentPanel/AgentModelFields.tsx': ['agents'],
  'src/components/topBar/topBarMenus.tsx': ['ui'],
  'src/components/topBar/WorkflowTabStrip.tsx': ['ui'],
  'src/components/topBar/TopBarActionButtons.tsx': ['ui'],
  'src/components/OrchestratorStageCard.tsx': ['panels'],
  'src/components/orchestratorPanelTaskGraph.ts': [],
  'src/canvas/useCanvasReconnect.ts': ['ui'],
  'src/canvas/useRightBoxSelection.ts': [],
  'src/canvas/useSplitWorkflowGraph.ts': [],
  'src/canvas/useCanvasDrop.ts': [],
  'src/canvas/connectValidation.ts': [],
  'src/plugins/pluginManager.ts': ['ui'],
  'src/engine/executor.ts': ['ui'],
  'src/engine/runWorkflowPhases.ts': ['ui'],
  'src/engine/executorNodePhases.ts': ['ui'],
};

const EXCEPTIONS = [
  ...['输入', '智能体', '文本', '工具', '输出', '流程'].map((token) => ({
    path: 'src/canvas/CanvasPanelControls.tsx',
    fragment: `${token}:`,
    reason: 'Node category identifiers are stored workflow data used by the minimap color map, not display labels.',
  })),
  {
    path: 'src/App.tsx',
    fragment: '。！？',
    reason: 'Sentence punctuation is part of the goal-splitting regular expression, not UI text.',
  },
  {
    path: 'src/components/OrchestratorPanel.tsx',
    fragment: '用户在专业编排中选择',
    reason: 'This is a persisted recovery audit reason; changing it by locale would alter stored provenance.',
  },
  {
    path: 'src/components/Inspector.tsx',
    fragment: 'revealItemInDir 失败',
    reason: 'Developer-console diagnostic only; it is not rendered to the user.',
  },
  {
    path: 'src/components/Inspector.tsx',
    fragment: 'openPath 失败',
    reason: 'Developer-console diagnostic only; it is not rendered to the user.',
  },
  {
    path: 'src/engine/executor.ts',
    fragment: '包含 dev.* 节点的工作流必须先打开已保存项目',
    reason: 'Kept as durable RunResult.error; src/orchestrator/run.ts persists it in stageLogs, not ordinary run history. The visible addLog text uses log.devSessionNeedsProject.',
  },
  {
    path: 'src/engine/executor.ts',
    fragment: 'Tauri DevSession 未就绪，开发节点未执行',
    reason: 'Kept as durable RunResult.error; src/orchestrator/run.ts persists it in stageLogs, not ordinary run history. The visible addLog text uses log.devSessionNotReady.',
  },
  {
    path: 'src/engine/executor.ts',
    fragment: '节点不存在',
    reason: 'Thrown before node state changes; BaseNode calls void retryNode, so main.tsx surfaces it through the unhandled-rejection fatal overlay. Preserve and report this behavior; do not fix in this slice.',
  },
  {
    path: 'src/engine/executor.ts',
    fragment: '快照落盘失败（已节流跳过，不影响运行）',
    reason: 'Developer-console diagnostic only; it is not rendered to the user.',
  },
  {
    path: 'src/engine/runWorkflowPhases.ts',
    fragment: '上一次运行仍在有效进行中，已忽略重复启动',
    reason: 'Kept as durable RunResult.error; orchestration stageLogs may persist it. The visible addLog message is separately localized.',
  },
  {
    path: 'src/engine/runWorkflowPhases.ts',
    fragment: '还没放任何节点',
    reason: 'Kept as durable RunResult.error; orchestration stageLogs may persist it. The visible addLog message uses log.emptyGraph.',
  },
  {
    path: 'src/engine/runWorkflowPhases.ts',
    fragment: '这几个节点连成了死循环，请拆掉其中一条连线',
    reason: 'Persisted as node error text in the project file; localizing would alter stored provenance.',
  },
  {
    path: 'src/engine/runWorkflowPhases.ts',
    fragment: '节点连成了死循环（${persistedLabels}）',
    reason: 'Kept as durable RunResult.error; only the transient log uses the locale-specific separator, preserving stored error text.',
  },
  {
    path: 'src/engine/executorNodePhases.ts',
    fragment: '上游节点失败，已跳过',
    reason: 'Persisted as node error text in the project file; localizing would alter stored provenance.',
  },
  {
    path: 'src/engine/executorNodePhases.ts',
    fragment: '节点类型 ${policy.typeId} 缺失（可能来自未加载的插件）',
    reason: 'Persisted as node error text in the project file; localizing would alter stored provenance.',
  },
  {
    path: 'src/engine/executorNodePhases.ts',
    fragment: '节点上下文尚未就绪：getTools 在 ctx 组装完成前被调用',
    reason: 'Internal invariant error thrown to the run loop; it is not rendered to the user.',
  },
  ...[
    "name: '产品经理'",
    "description: '梳理需求、拆解任务、定义验收标准'",
    '你是一名严谨的产品经理。请用清晰的结构梳理需求，拆解为可执行的任务，并明确验收标准。输出简洁、可执行，避免空话。',
    "name: '开发工程师'",
    "description: '根据需求编写与解释代码'",
    '你是一名资深开发工程师。请针对给定任务给出正确、可读、遵循最佳实践的代码或技术方案，必要时说明取舍。',
    "name: '代码审查员'",
    "description: '审查代码质量、风险与改进建议'",
    '你是一名严格的代码审查员。请指出代码中的缺陷、安全隐患、可维护性问题，并给出具体修改建议，按严重程度分级。',
    "name: '技术作家'",
    "description: '撰写文档、说明与总结'",
    '你是一名技术作家。请将技术内容转化为准确、条理清晰、面向目标读者的文档或说明，语言专业且易懂。',
  ].map((fragment) => ({
    path: 'src/agents/agentManager.ts',
    fragment,
    reason: 'Built-in RoleTemplate defaults are cloned into store/project data and include system prompts supplied to agents; preserve these persisted role values rather than changing them as UI chrome.',
  })),
  {
    path: 'src/agents/agentManager.ts',
    fragment: 'Antigravity CLI 仅作为 TaskGraph Worker Runtime 使用，请从项目 Worker Run 选择 Antigravity。',
    reason: 'Runtime exception text can be returned through durable RunResult.error; preserve the stable error contract.',
  },
  {
    path: 'src/agents/agentManager.ts',
    fragment: '未知协议: ${agent.protocol}',
    reason: 'Runtime exception text can be returned through durable RunResult.error; preserve the stable error contract.',
  },
  ...[
    "label: 'OpenAI 兼容'",
    "label: 'Ollama 本地'",
    "label: 'OpenAI Codex（ChatGPT 订阅）'",
    "label: 'Antigravity CLI（交互式）'",
    "name: 'OpenAI 官方'",
    "name: 'DeepSeek 官方'",
    "name: '硅基流动 SiliconFlow'",
    "name: 'OpenRouter 聚合'",
    "name: '自定义中转'",
    "name: 'OpenAI Codex（ChatGPT 订阅）'",
    "name: 'Antigravity CLI（交互式）'",
    "note: '~2GB 显存 · 6GB 显卡首选，流畅'",
    "note: '~4.5GB 显存 · 质量更好，6GB 偏吃紧'",
    "note: '~5GB 显存 · 8GB+ 显卡推荐'",
    "note: '~4.5GB 显存 · 推理强，6GB 偏吃紧'",
    "note: '~0.5GB 显存 · 极轻量'",
    'name: preset ? `${preset.name}智能体` : `${d.label}智能体`',
  ].map((fragment) => ({
    path: 'src/agents/agentManager.ts',
    fragment,
    reason: 'Stored provider/protocol creation values or static recommendation metadata; display surfaces use separate locale keys (labelKey/noteKey), while IDs and serialized defaults remain unchanged.',
  })),
] as const;

function commentFreeSource(filePath: string, text: string): string {
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const ranges = new Map<string, { pos: number; end: number }>();
  const collect = (node: ts.Node): void => {
    if (ts.isJsxExpression(node) && !node.expression && /^\{\s*\/\*[\s\S]*\*\/\s*\}$/.test(node.getText(source))) {
      const range = { pos: node.getStart(source), end: node.end };
      ranges.set(`${range.pos}:${range.end}`, range);
    }
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
      ranges.set(`${range.pos}:${range.end}`, range);
    }
    for (const range of ts.getTrailingCommentRanges(text, node.end) ?? []) {
      ranges.set(`${range.pos}:${range.end}`, range);
    }
    if (ts.isBlock(node) && node.statements.length === 0) {
      const emptyBlockComments = [
        ...(ts.getLeadingCommentRanges(text, node.statements.pos) ?? []),
        ...(ts.getTrailingCommentRanges(text, node.statements.pos) ?? []),
      ];
      for (const range of emptyBlockComments) {
        ranges.set(`${range.pos}:${range.end}`, range);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const chars = text.split('');
  for (const { pos, end } of ranges.values()) {
    for (let index = pos; index < end; index += 1) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
    }
  }
  return chars.join('');
}

function maskException(text: string, fragment: string): { text: string; count: number } {
  const first = text.indexOf(fragment);
  if (first < 0) return { text, count: 0 };
  const second = text.indexOf(fragment, first + fragment.length);
  if (second >= 0) return { text, count: 2 };
  return {
    text: `${text.slice(0, first)}${' '.repeat(fragment.length)}${text.slice(first + fragment.length)}`,
    count: 1,
  };
}

function staticTranslationKeys(filePath: string): Set<string> {
  const text = readFileSync(resolve(process.cwd(), filePath), 'utf8');
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const keys = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === 'labelKey' || node.name.text === 'noteKey') &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      keys.add(node.initializer.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 't' &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      keys.add(node.arguments[0].text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'i18n' &&
      node.expression.name.text === 't' &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      keys.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
}

function resourceKeys(language: string, namespace: string): Set<string> {
  const path = resolve(process.cwd(), `src/i18n/locales/${language}/${namespace}.xml`);
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(
    readFileSync(path, 'utf8'),
  );
  const strings = parsed?.resources?.string;
  const list = Array.isArray(strings) ? strings : strings == null ? [] : [strings];
  return new Set(
    list
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => item['@_name'])
      .filter((key): key is string => typeof key === 'string'),
  );
}

describe('target UI files use localized Chinese literals', () => {
  it('ignores comments but still scans code and JSX text', () => {
    const source = 'const label = "可见"; // 注释文本\nconst regex = /[。！？]/; try {} catch { /* 空块注释 */ }\nconst view = <div>页面文本{/* JSX 注释 */}</div>;';
    const stripped = commentFreeSource('sample.tsx', source);

    expect(stripped).toContain('可见');
    expect(stripped).toContain('。！？');
    expect(stripped).toContain('页面文本');
    expect(stripped).not.toContain('注释文本');
    expect(stripped).not.toContain('空块注释');
    expect(stripped).not.toContain('JSX 注释');
  });

  it('has no undocumented Han text outside comments', () => {
    const unexpected: string[] = [];
    const staleExceptions: string[] = [];
    const reasonsMissing = EXCEPTIONS.filter((item) => !item.reason.trim());

    for (const filePath of TARGET_FILES) {
      let source = commentFreeSource(filePath, readFileSync(resolve(process.cwd(), filePath), 'utf8'));
      for (const exception of EXCEPTIONS.filter((item) => item.path === filePath)) {
        const masked = maskException(source, exception.fragment);
        if (masked.count !== 1) staleExceptions.push(`${filePath}: expected one ${exception.fragment} exception`);
        source = masked.text;
      }
      for (const match of source.matchAll(/[\u4e00-\u9fff]+/g)) {
        const line = source.slice(0, match.index).split('\n').length;
        unexpected.push(`${filePath}:${line}: ${match[0]}`);
      }
    }

    expect(reasonsMissing).toEqual([]);
    expect(staleExceptions).toEqual([]);
    expect(unexpected).toEqual([]);
  });

  it('resolves static UI translation keys in the corresponding locale resources', () => {
    const missing: string[] = [];
    for (const language of ['zh-CN', 'en-US']) {
      for (const filePath of TARGET_FILES) {
        const available = new Set(
          NAMESPACE_CANDIDATES[filePath].flatMap((namespace) => [...resourceKeys(language, namespace)]),
        );
        for (const key of staticTranslationKeys(filePath)) {
          if (!available.has(key)) missing.push(`${language}:${filePath}:${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TARGET_FILES = [
  'src/canvas/WorkflowEditor.tsx',
  'src/canvas/CanvasWelcomeSurface.tsx',
  'src/canvas/CanvasPanelControls.tsx',
  'src/canvas/useCanvasContextMenu.tsx',
  'src/canvas/useCanvasNodePicker.tsx',
  'src/components/LeftSidebar.tsx',
  'src/App.tsx',
  'src/components/OrchestratorPanel.tsx',
  'src/components/Inspector.tsx',
  'src/components/TopBar.tsx',
  'src/components/StatusBar.tsx',
] as const;

const NAMESPACE_CANDIDATES: Record<(typeof TARGET_FILES)[number], string[]> = {
  'src/canvas/WorkflowEditor.tsx': ['ui'],
  'src/canvas/CanvasWelcomeSurface.tsx': ['ui'],
  'src/canvas/CanvasPanelControls.tsx': ['ui'],
  'src/canvas/useCanvasContextMenu.tsx': ['ui'],
  'src/canvas/useCanvasNodePicker.tsx': ['ui'],
  'src/components/LeftSidebar.tsx': ['panels'],
  'src/App.tsx': ['ui'],
  'src/components/OrchestratorPanel.tsx': ['panels'],
  'src/components/Inspector.tsx': ['ui', 'inspector'],
  'src/components/TopBar.tsx': ['ui'],
  'src/components/StatusBar.tsx': ['ui', 'statusbar'],
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
      node.name.text === 'labelKey' &&
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

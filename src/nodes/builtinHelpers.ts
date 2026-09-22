/**
 * builtinHelpers.ts — `builtin.ts` 内的「纯函数」子模块。
 *
 * 背景：builtin.ts 是执行引擎的「上帝模块」之一（2700+ 行），其中混入了大量
 * 与具体节点定义无关、且不依赖 store / registry 的纯函数（模板渲染、文件名推断、
 * 真值判断、JSON Schema 校验、架构/计划文本解析等）。把它们抽到本文件，使
 * builtin.ts 聚焦于节点定义本身，同时这些纯函数可独立单测、零回归。
 *
 * 本文件不 import `useWorkflowStore` / `useRegistryStore`，也不触碰任何运行态，
 * 仅依赖 `../types` 的基础类型，便于在 node 测试环境下直接 import。
 */
import type { ModuleItem, TaskItem } from '../types/dispatch';

/** 根据文件名推断资产类型，用于左侧「资产」面板的预览 */
export function inferAssetKind(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (['py', 'js', 'ts', 'jsx', 'tsx', 'java', 'go', 'rs', 'cpp', 'c', 'sh'].includes(ext))
    return 'code';
  if (ext === 'json') return 'json';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['md', 'txt', 'log'].includes(ext)) return 'text';
  return 'text';
}

/**
 * 自动推断文件名：让上游全能 worker 自行决定文件叫什么。
 * 1) 从 hint（上游任务文本，如「帮我生成一个 helloworld.py 文件」）提取显式文件名；
 * 2) 从内容首行/代码块语言推断扩展名；
 * 3) 兜底 output.txt。
 */
export function inferFilename(opts: { hint: string; content: string }): string {
  const { hint, content } = opts;

  // 1) 从命名提示中提取 *.ext 形态的文件名（支持带路径、带引号）
  if (hint) {
    const m = hint.match(/[`'"\s]([A-Za-z0-9_\-./]+\.[A-Za-z0-9]{1,10})[`'"\s]/)
      ?? hint.match(/([A-Za-z0-9_\-./]+\.[A-Za-z0-9]{1,10})/);
    if (m) {
      const name = m[1].split(/[\\/]/).pop()!; // 去掉可能的目录前缀
      if (name.includes('.')) return name;
    }
  }

  // 2) 从内容推断扩展名：先看首行 ```lang 围栏
  const fenceLang = content.match(/^\s*```([A-Za-z0-9+#-]+)/);
  let ext = fenceLang ? langToExt(fenceLang[1]) : '';
  if (!ext) {
    const head = content.slice(0, 400).toLowerCase();
    if (/^\s*(<!doctype html|<\?xml|<html)/.test(content)) ext = 'html';
    else if (/def\s+\w+\s*\(|import\s+(os|sys|re|json)|print\(/.test(head)) ext = 'py';
    else if (/function\s+\w+|const\s+\w+\s*=|<script/.test(head)) ext = 'js';
    else if (/interface\s+\w+|:\s*string\s*=|export\s+type/.test(head)) ext = 'ts';
    else if (/{[\s\S]*}|^\[[\s\S]*\]$/.test(content.trim())) ext = 'json';
    else if (/select\s+[\w*]+\s+from|insert\s+into|create\s+table/i.test(head)) ext = 'sql';
    else if (/^#\s|^\*\s|-\s/.test(content)) ext = 'md';
    else if (/:\s*\w+\s*;|@media|background:|color:/.test(head)) ext = 'css';
  }

  // 3) 尝试从内容首行拿到有意义的命名
  const firstLine = content.split('\n')[0].replace(/^[#/*\s-]+/, '').trim();
  let stem = 'output';
  if (firstLine && firstLine.length <= 40 && /[A-Za-z0-9_\-]/.test(firstLine)) {
    stem = firstLine
      .toLowerCase()
      .replace(/[^a-z0-9_\-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || 'output';
  }
  return `${stem}${ext ? '.' + ext : '.txt'}`;
}

/** 把代码语言标记映射到扩展名 */
export function langToExt(lang: string): string {
  const map: Record<string, string> = {
    python: 'py', py: 'py', javascript: 'js', js: 'js', jsx: 'jsx',
    typescript: 'ts', ts: 'ts', tsx: 'tsx', java: 'java', go: 'go',
    rust: 'rs', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs',
    html: 'html', xml: 'xml', css: 'css', scss: 'scss', json: 'json',
    markdown: 'md', md: 'md', sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh',
    yaml: 'yaml', yml: 'yml', toml: 'toml', php: 'php', ruby: 'rb', r: 'r',
    swift: 'swift', kotlin: 'kt', dart: 'dart', lua: 'lua',
  };
  return map[lang.toLowerCase()] ?? '';
}

/** 将模板中的 {{key}} 替换为 scope 中的值（对象会 JSON 序列化） */
export function renderTemplate(template: string, scope: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    const v = scope[key];
    return v === undefined || v === null
      ? ''
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);
  });
}

/** 真值判断：非空、非零、非空字符串/数组/对象 */
export function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.trim() !== '' && v !== 'false' && v !== '0';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return Boolean(v);
}

/** 从模块原始对象中规整出合法 ModuleCategory（非约定值降级为 'data'，但保留任意字符串以允许自定义类别）。 */
export function normalizeCategory(raw: unknown): ModuleItem['category'] {
  const c = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!c) return 'data';
  return c; // 保留任意字符串（路由表键可自定义），仅做小写规整
}

/** 从模型架构设计文本中提取模块清单；解析失败降级为「整个目标作为一个模块」。 */
export function extractModulesFromDesign(text: string, fallbackGoal: string): ModuleItem[] {
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const m = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((t, i) => {
          const name = typeof t?.name === 'string' && t.name.trim() ? t.name : `模块${i + 1}`;
          const responsibility =
            typeof t?.responsibility === 'string' && t.responsibility.trim()
              ? t.responsibility
              : name;
          const scope = Array.isArray(t?.scope) ? t.scope.filter((s: unknown) => typeof s === 'string') : undefined;
          const dependsOn = Array.isArray(t?.dependsOn)
            ? t.dependsOn.filter((s: unknown) => typeof s === 'string')
            : undefined;
          return {
            name,
            responsibility,
            category: normalizeCategory(t?.category),
            scope: scope && scope.length > 0 ? scope : undefined,
            dependsOn: dependsOn && dependsOn.length > 0 ? dependsOn : undefined,
            payload: t?.payload,
            index: i,
          };
        });
      }
    } catch {
      /* 落入降级分支 */
    }
  }
  return [{ name: fallbackGoal, responsibility: fallbackGoal, category: 'data', payload: fallbackGoal, index: 0 }];
}

/** 从模型计划文本中提取任务清单；解析失败降级为「整个目标作为一个任务」。 */
export function extractTasksFromPlan(text: string, fallbackGoal: string): TaskItem[] {
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const m = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((t, i) => {
          const label = typeof t?.label === 'string' && t.label.trim() ? t.label : `任务${i + 1}`;
          const scope = Array.isArray(t?.scope) ? t.scope.filter((s: unknown) => typeof s === 'string') : undefined;
          return { label, scope: scope && scope.length > 0 ? scope : undefined, payload: t?.payload, index: i };
        });
      }
    } catch {
      /* 落入降级分支 */
    }
  }
  return [{ label: fallbackGoal, payload: fallbackGoal, index: 0 }];
}

/** 极简 JSON Schema 校验（仅支持 type/required/properties 的子集，够用且零依赖） */
export function checkJsonSchema(value: unknown, schema: Record<string, any>): string[] {
  const errs: string[] = [];
  const type = schema.type;
  if (type) {
    if (type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value)))
      errs.push(`期望 object，实际 ${Array.isArray(value) ? 'array' : typeof value}`);
    else if (type === 'array' && !Array.isArray(value))
      errs.push(`期望 array，实际 ${typeof value}`);
    else if (
      ['string', 'number', 'boolean'].includes(type) &&
      typeof value !== type
    )
      errs.push(`期望 ${type}，实际 ${typeof value}`);
  }
  if (schema.required && Array.isArray(value) === false && value && typeof value === 'object') {
    for (const k of schema.required as string[]) {
      if (!(k in (value as Record<string, any>)))
        errs.push(`缺少必填字段 "${k}"`);
    }
  }
  return errs;
}

import { createNodeDef, type NodeDefinition } from '../../types/node';
import type { AssetMeta } from '../../types/project';
import { httpFetch, isTauri } from '../../platform/env';
import { evalExpr } from '../../engine/expr';
import { inferFilename } from '../builtinHelpers';

const httpRequest: NodeDefinition = {
  typeId: 'tool.http',
  name: 'HTTP 请求',
  category: '工具',
  description: '发送一个 HTTP 请求并取回响应文本，支持 GET/POST 与自定义请求头',
  inputs: [{ id: 'body', label: '请求体(可选)', type: 'any' }],
  outputs: [{ id: 'response', label: '响应', type: 'text' }],
  params: [
    { key: 'url', label: 'URL', type: 'text', default: '', placeholder: 'https://api.example.com' },
    {
      key: 'method',
      label: '方法',
      type: 'select',
      default: 'GET',
      options: [
        { label: 'GET', value: 'GET' },
        { label: 'POST', value: 'POST' },
        { label: 'PUT', value: 'PUT' },
        { label: 'DELETE', value: 'DELETE' },
      ],
    },
    { key: 'headers', label: '请求头(JSON)', type: 'textarea', default: '{}' },
    { key: 'timeout', label: '超时(ms)', type: 'number', default: 10000 },
  ],
  async execute(inputs, params, ctx) {
    const url = String(params.url ?? '').trim();
    if (!url) throw new Error('缺少 URL 参数');
    const method = String(params.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    try {
      const raw = String(params.headers ?? '{}').trim();
      if (raw) Object.assign(headers, JSON.parse(raw));
    } catch {
      throw new Error('请求头不是合法 JSON');
    }
    const hasBody = method === 'POST' || method === 'PUT';
    const bodyVal = inputs.body != null ? inputs.body : params.body;
    const body = hasBody && bodyVal != null ? String(bodyVal) : undefined;

    ctx.logger.info(`HTTP ${method} ${url}`);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const resp = await httpFetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      } as any);
      const text = await (resp as any).text?.();
      return { response: text ?? '' };
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  },
};

export const nodeWriteFile: NodeDefinition = {
  typeId: 'tool.writeFile',
  name: '写文件',
  category: '工具',
  role: 'worker',
  whenToUse: '把上游文本/代码写入工作区文件；配合「沙箱」能力做隔离施工，或导出产物。',
  description:
    '将上游文本或代码写入工作区文件。支持相对路径（写入当前项目目录）或绝对路径；桌面端可写任意位置，浏览器端限制在沙箱。写操作默认经沙箱能力隔离，失败不影响主流程。',
  inputs: [
    { id: 'content', label: '内容', type: 'any' },
    { id: 'path', label: '路径(可选覆盖)', type: 'text' },
  ],
  outputs: [{ id: 'path', label: '实际路径', type: 'text' }],
  params: [
    { key: 'path', label: '文件路径', type: 'text', default: 'output.txt', placeholder: '如 src/app.ts 或 /abs/path/out.txt' },
    {
      key: 'mode',
      label: '写入模式',
      type: 'select',
      default: 'overwrite',
      options: [
        { label: '覆盖', value: 'overwrite' },
        { label: '追加', value: 'append' },
      ],
    },
    { key: 'encoding', label: '编码', type: 'text', default: 'utf-8' },
  ],
  async execute(inputs, params, ctx) {
    const content = inputs.content != null ? String(inputs.content) : '';
    const path = String(inputs.path ?? params.path ?? '').trim();
    if (!path) throw new Error('写文件缺少路径（path 参数或输入端口）');
    const mode = String(params.mode ?? 'overwrite');
    const encoding = String(params.encoding ?? 'utf-8');
    try {
      let finalContent = content;
      if (mode === 'append' && typeof (globalThis as any).fs?.readFile === 'function') {
        const prev = await (globalThis as any).fs.readFile(path, encoding);
        finalContent = prev + content;
      }
      if ((ctx as any).sandbox?.writeFile) {
        const written = await (ctx as any).sandbox.writeFile(path, finalContent);
        ctx.logger.info(`[沙箱] 写入 ${path} (${finalContent.length} 字节)`);
        return { path: written ?? path };
      }
      // 退化：无沙箱能力时，浏览器/桌面经受限 fs 直写（仅在允许范围）
      if (isTauri && (globalThis as any).fs?.writeTextFile) {
        await (globalThis as any).fs.writeTextFile(path, finalContent);
        ctx.logger.info(`写入 ${path}`);
        return { path };
      }
      // 浏览器 / 无能力：降级为资产导出，避免静默丢数据
      const name = inferFilename({ hint: path, content: finalContent });
      ctx.addAsset({
        id: `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        name,
        path: null,
        kind: 'file',
        content: finalContent,
        createdAt: new Date().toISOString(),
        nodeId: '',
        inWorkspace: false,
      } as AssetMeta);
      ctx.logger.warn(`当前环境不支持直接写文件，已导出为资产 ${name}`);
      return { path: name };
    } catch (e) {
      ctx.logger.error(`写文件失败 ${path}: ${(e as Error).message}`);
      throw e;
    }
  },
};

const exprNode: NodeDefinition = {
  typeId: 'tool.expr',
  name: '表达式',
  category: '工具',
  description:
    '计算一个安全表达式，可引用输入端口 a/b、全局变量，输出 result。支持 + - * / % 比较 逻辑 三元 及 len/upper/lower/split/join/contains 等函数',
  inputs: [{ id: 'a', label: 'a', type: 'any' }, { id: 'b', label: 'b', type: 'any' }],
  outputs: [{ id: 'result', label: '结果', type: 'any' }],
  params: [
    {
      key: 'expression',
      label: '表达式',
      type: 'textarea',
      default: '',
      placeholder: '例如：a + b * 2，或 len(a)',
    },
  ],
  async execute(inputs, params, ctx) {
    const expr = String(params.expression ?? '').trim();
    if (!expr) return { result: undefined };
    const scope = { ...ctx.vars, ...inputs };
    const result = evalExpr(expr, scope);
    return { result };
  },
};

export const toolNodes: NodeDefinition[] = [httpRequest, nodeWriteFile, exprNode].map(createNodeDef);

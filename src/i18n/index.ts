import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { XMLParser } from 'fast-xml-parser';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 按语言分文件夹加载 XML 资源：
 *   src/i18n/locales/<lang>/<ns>.xml
 * 解析为 i18next 需要的 { [key]: value } 结构。
 */
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/** raw XML 文本：path → content。Vite 下走 import.meta.glob（构建期静态扫描）；tsx/Node 下
 *  fs 兜底（headless / 单测 / CI 环境），同样保证跨环境可用。 */
function loadXmlModules(): Record<string, string> {
  // Vite 环境：import.meta.glob 编译期替换为静态映射
  // （必须保留字面量 glob 调用，否则 Vite 不会批量收集 XML）。
  // 注意：编译后 glob 是**模块/对象**而非函数——不能用 typeof === 'function' 检测，
  // 用 try/catch 探测：Vite 环境调用成功，tsx/Node 环境抛 ReferenceError。
  try {
    // @ts-expect-error Vite 编译期类型擦除；运行时存在 import.meta.glob
    return (import.meta as { glob: unknown }).glob('./locales/*/*.xml', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
  } catch {
    // tsx / Node 环境：兜底扫描 locales 目录读取 XML
    const here = dirname(fileURLToPath(import.meta.url));
    const localesDir = resolve(here, './locales');
    const out: Record<string, string> = {};
    for (const lang of readdirSync(localesDir)) {
      const langDir = join(localesDir, lang);
      for (const file of readdirSync(langDir)) {
        if (!file.endsWith('.xml')) continue;
        const path = join(langDir, file);
        // 与 Vite glob 路径形态对齐（便于 buildResources 路径正则匹配）
        out[`./locales/${lang}/${file}`] = readFileSync(path, 'utf8');
      }
    }
    return out;
  }
}

const xmlModules = loadXmlModules();

function buildResources(): Record<string, Record<string, Record<string, string>>> {
  const resources: Record<string, Record<string, Record<string, string>>> = {};
  for (const [path, raw] of Object.entries(xmlModules)) {
    // path 形如 './locales/zh-CN/ui.xml'
    const m = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.xml$/);
    if (!m) continue;
    const [, lang, ns] = m;
    const parsed = xmlParser.parse(raw);
    const strings = parsed?.resources?.string ?? [];
    const entries: Record<string, string> = {};
    const list = Array.isArray(strings) ? strings : [strings];
    for (const node of list) {
      // fast-xml-parser returns plain text nodes as strings unless the node
      // has attributes/structured content. XML resources use both forms
      // across locales, so accept either representation.
      const name = typeof node === 'object' && node !== null ? node['@_name'] : undefined;
      const value = typeof node === 'string' ? node : node?.['#text'];
      if (typeof name === 'string' && typeof value === 'string') {
        entries[name] = value;
      }
    }
    resources[lang] = resources[lang] ?? {};
    resources[lang][ns] = entries;
  }
  return resources;
}

const resources = buildResources();
const fallbackLng = 'zh-CN';

// 自动从已加载的 locale 目录推导支持的语言（新增语言只需在 src/i18n/locales/<lang>/ 下放 XML，无需改此文件）
export const SUPPORTED_LANGS: string[] = Object.keys(resources).sort((a, b) => {
  if (a === fallbackLng) return -1;
  if (b === fallbackLng) return 1;
  return a.localeCompare(b);
});

// 语言下拉的显示名（优先此处，未知语言回退到语言代码本身，保证新增语言立即可选）
const LANG_LABELS: Record<string, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
  'zh-TW': '繁體中文',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'fr-FR': 'Français',
  'de-DE': 'Deutsch',
  'es-ES': 'Español',
  'ru-RU': 'Русский',
};
export function langLabel(lang: string): string {
  return LANG_LABELS[lang] ?? lang;
}

i18n.use(initReactI18next).init({
  resources,
  fallbackLng,
  defaultNS: 'ui',
  // 基础组件使用默认 ui namespace，但状态栏/检查器等 key 位于各自 XML namespace。
  fallbackNS: ['statusbar', 'inspector', 'panels', 'modals', 'agents', 'settings'],
  // 初始语言：持久化的 locale（viewStore 会调用 changeLanguage）；无则从浏览器取，再回退到 fallbackLng
  lng: fallbackLng,
  // XML 中的 key 使用 `topbar.file` 这种扁平命名；不要让 i18next 把 `.` 当作嵌套对象路径。
  keySeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
});

if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (globalThis as typeof globalThis & {
    __slimeMoldI18n?: typeof i18n;
  }).__slimeMoldI18n = i18n;
}

export default i18n;

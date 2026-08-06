import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { XMLParser } from 'fast-xml-parser';

/**
 * 按语言分文件夹加载 XML 资源：
 *   src/i18n/locales/<lang>/<ns>.xml
 * 解析为 i18next 需要的 { [key]: value } 结构。
 */
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// Vite 构建期批量收集所有语言的 XML 文件（含 namespace 目录结构）。
// 在非 Vite 环境（如 headless CLI / tsx 单文件运行）下 import.meta.glob 不存在，
// 安全降级为空对象——i18n 资源留空，不影响引擎/节点执行逻辑。
const globFn = (import.meta as unknown as { glob?: (pattern: string, opts: Record<string, unknown>) => Record<string, unknown> }).glob;
const xmlModules = (globFn
  ? globFn('./locales/*/*.xml', { query: '?raw', import: 'default', eager: true })
  : {}) as Record<string, string>;

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
      if (node && typeof node['#text'] === 'string' && typeof node['@_name'] === 'string') {
        entries[node['@_name']] = node['#text'];
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
  // 初始语言：持久化的 locale（viewStore 会调用 changeLanguage）；无则从浏览器取，再回退到 fallbackLng
  lng: fallbackLng,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;

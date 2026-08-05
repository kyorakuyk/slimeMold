import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { XMLParser } from 'fast-xml-parser';

/**
 * 按语言分文件夹加载 XML 资源：
 *   src/i18n/locales/<lang>/<ns>.xml
 * 解析为 i18next 需要的 { [key]: value } 结构。
 */
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// Vite 构建期批量收集所有语言的 XML 文件（含 namespace 目录结构）
const xmlModules = import.meta.glob('./locales/*/*.xml', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

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

i18n.use(initReactI18next).init({
  resources,
  fallbackLng,
  // 初始语言：持久化的 locale（viewStore 会调用 changeLanguage）；无则从浏览器取
  lng: (typeof navigator !== 'undefined' && navigator.language?.startsWith('en') ? 'en-US' : fallbackLng),
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;

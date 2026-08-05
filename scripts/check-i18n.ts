/**
 * check-i18n.ts —— 校验各语言 i18n key 对齐
 *
 * 以 zh-CN 为基准，扫描 src/i18n/locales/<lang>/*.xml，
 * 报告每个语言相对基准缺失 / 多余的 key。
 *
 * 用法：
 *   npm run i18n:check
 *   npx tsx scripts/check-i18n.ts
 *
 * 退出码：
 *   0 = 全部对齐
 *   1 = 存在缺失/多余 key（或解析错误 / 缺少基准语言）
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', 'src', 'i18n', 'locales');
const BASE_LANG = 'zh-CN';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/** 递归收集一个 XML 对象里所有 <string name="..."> 的 name 值（嵌套亦兼容）。 */
function collectStringNames(node: unknown, out: Set<string>): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectStringNames(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if ('string' in obj && obj.string != null) {
    const strings = Array.isArray(obj.string) ? obj.string : [obj.string];
    for (const s of strings) {
      if (s && typeof s === 'object') {
        const name = (s as Record<string, unknown>)['@_name'];
        if (typeof name === 'string') out.add(name);
      }
    }
  }
  for (const key of Object.keys(obj)) {
    if (key === 'string') continue;
    collectStringNames(obj[key], out);
  }
}

/** 读取一个语言目录，返回该语言所有 key 的扁平集合。 */
function loadLangKeys(langDir: string): Set<string> {
  const keys = new Set<string>();
  const files = readdirSync(langDir).filter((f) => f.endsWith('.xml'));
  for (const f of files) {
    const raw = readFileSync(join(langDir, f), 'utf-8');
    const parsed = parser.parse(raw);
    collectStringNames(parsed, keys);
  }
  return keys;
}

function main(): number {
  if (!existsSync(LOCALES_DIR) || !statSync(LOCALES_DIR).isDirectory()) {
    console.error(`[check-i18n] 未找到 locales 目录: ${LOCALES_DIR}`);
    return 1;
  }

  const langs = readdirSync(LOCALES_DIR).filter((l) =>
    statSync(join(LOCALES_DIR, l)).isDirectory(),
  );

  if (!langs.includes(BASE_LANG)) {
    console.error(`[check-i18n] 缺少基准语言目录: ${BASE_LANG}`);
    return 1;
  }

  const baseKeys = loadLangKeys(join(LOCALES_DIR, BASE_LANG));
  console.log(`[check-i18n] 基准语言 ${BASE_LANG} 共 ${baseKeys.size} 个 key`);
  console.log(`[check-i18n] 检测到语言: ${langs.join(', ')}\n`);

  let hasError = false;

  for (const lang of langs) {
    if (lang === BASE_LANG) continue;
    const keys = loadLangKeys(join(LOCALES_DIR, lang));
    const missing = [...baseKeys].filter((k) => !keys.has(k)).sort();
    const extra = [...keys].filter((k) => !baseKeys.has(k)).sort();

    if (missing.length === 0 && extra.length === 0) {
      console.log(`✓ ${lang}  对齐 (${keys.size} keys)`);
      continue;
    }

    hasError = true;
    console.log(`✗ ${lang}  (有 ${keys.size} / 基准 ${baseKeys.size})`);
    if (missing.length > 0) {
      console.log(`  缺失 ${missing.length} 个:`);
      for (const k of missing) console.log(`    - ${k}`);
    }
    if (extra.length > 0) {
      console.log(`  多余 ${extra.length} 个:`);
      for (const k of extra) console.log(`    + ${k}`);
    }
    console.log('');
  }

  if (hasError) {
    console.log('[check-i18n] 存在未对齐的语言，请补全缺失 key（多余 key 一般无需处理）。');
    return 1;
  }

  console.log('[check-i18n] 所有语言均与基准对齐 ✓');
  return 0;
}

process.exit(main());

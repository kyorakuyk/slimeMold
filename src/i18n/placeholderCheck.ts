export interface PlaceholderTranslation {
  language: string;
  key: string;
  value: string;
}

export type PlaceholderIssue =
  | {
      code: 'single-brace-placeholder';
      language: string;
      key: string;
      placeholders: string[];
    }
  | {
      code: 'placeholder-set-mismatch';
      key: string;
      baseLanguage: 'zh-CN';
      basePlaceholders: string[];
      comparedLanguage: 'en-US';
      comparedPlaceholders: string[];
    };

const SINGLE_BRACE_PLACEHOLDER = /(?<!\{)\{([^{}\s]+)\}(?!\})/g;
const DOUBLE_BRACE_PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

function placeholders(value: string, pattern: RegExp): string[] {
  return [...new Set([...value.matchAll(pattern)].map((match) => match[1]?.trim()).filter(Boolean) as string[])].sort();
}

export function checkPlaceholderConsistency(
  translations: readonly PlaceholderTranslation[],
): PlaceholderIssue[] {
  const issues: PlaceholderIssue[] = [];
  for (const translation of translations) {
    const found = placeholders(translation.value, SINGLE_BRACE_PLACEHOLDER);
    if (found.length > 0) {
      issues.push({
        code: 'single-brace-placeholder',
        language: translation.language,
        key: translation.key,
        placeholders: found,
      });
    }
  }

  const baseEntries = translations.filter((entry) => entry.language === 'zh-CN');
  const englishByKey = new Map(
    translations.filter((entry) => entry.language === 'en-US').map((entry) => [entry.key, entry.value]),
  );
  for (const base of baseEntries) {
    const comparedValue = englishByKey.get(base.key);
    if (comparedValue === undefined) continue;
    const basePlaceholders = placeholders(base.value, DOUBLE_BRACE_PLACEHOLDER);
    const comparedPlaceholders = placeholders(comparedValue, DOUBLE_BRACE_PLACEHOLDER);
    if (basePlaceholders.join('\0') === comparedPlaceholders.join('\0')) continue;
    issues.push({
      code: 'placeholder-set-mismatch',
      key: base.key,
      baseLanguage: 'zh-CN',
      basePlaceholders,
      comparedLanguage: 'en-US',
      comparedPlaceholders,
    });
  }

  return issues.sort((left, right) =>
    left.key.localeCompare(right.key) || left.code.localeCompare(right.code) ||
    ('language' in left ? left.language : '').localeCompare('language' in right ? right.language : ''),
  );
}

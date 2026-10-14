import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES } from '../data/starterTemplates';
import i18n from './index';

describe('starter-template display translations', () => {
  it.each(STARTER_TEMPLATES)('$id has English display copy and preserves its Chinese workspace defaults', (template) => {
    const nameKey = `starterTemplate.${template.id}.name`;
    const descriptionKey = `starterTemplate.${template.id}.description`;
    const englishName = i18n.t(nameKey, { ns: 'beginner', lng: 'en-US' });
    const englishDescription = i18n.t(descriptionKey, { ns: 'beginner', lng: 'en-US' });

    expect(englishName).not.toBe(nameKey);
    expect(englishDescription).not.toBe(descriptionKey);
    expect(englishName).not.toMatch(/[\u4e00-\u9fff]/);
    expect(englishDescription).not.toMatch(/[\u4e00-\u9fff]/);
    expect(i18n.t(nameKey, { ns: 'beginner', lng: 'zh-CN' })).toBe(template.name);
    expect(i18n.t(descriptionKey, { ns: 'beginner', lng: 'zh-CN' })).toBe(template.desc);
  });
});

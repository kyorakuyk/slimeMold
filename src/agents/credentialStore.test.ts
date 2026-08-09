import { describe, it, expect } from 'vitest';
import { inferVendor, labelFromBaseUrl, genVaultId, normalizeVaultBaseUrl } from './credentialStore';
import { baseUrlListWithV1 } from './agentManager';

describe('inferVendor 自动分组', () => {
  it('deepseek 域名 → deepseek', () => {
    expect(inferVendor('https://api.deepseek.com/v1')).toBe('deepseek');
  });
  it('anthropic 域名 → claude', () => {
    expect(inferVendor('https://api.anthropic.com')).toBe('claude');
  });
  it('anthropic 域名 + anthropic 协议 → anthropic', () => {
    expect(inferVendor('https://api.anthropic.com', 'anthropic')).toBe('anthropic');
  });
  it('openai 域名 → openai', () => {
    expect(inferVendor('https://api.openai.com/v1')).toBe('openai');
  });
  it('siliconflow 域名 → siliconflow', () => {
    expect(inferVendor('https://api.siliconflow.cn/v1')).toBe('siliconflow');
  });
  it('openrouter 域名 → openrouter', () => {
    expect(inferVendor('https://openrouter.ai/api/v1')).toBe('openrouter');
  });
  it('未知中转域名 → transit', () => {
    expect(inferVendor('https://apinebula.ai/v1')).toBe('transit');
  });
});

describe('labelFromBaseUrl 自动命名', () => {
  it('取 host 域名', () => {
    expect(labelFromBaseUrl('https://api.deepseek.com/v1')).toBe('api.deepseek.com');
  });
  it('去掉 www 前缀', () => {
    expect(labelFromBaseUrl('https://www.openai.com/v1')).toBe('openai.com');
  });
  it('非法 URL 兜底截取', () => {
    expect(labelFromBaseUrl('https://x.example.com/path')).toBe('x.example.com');
  });
});

describe('genVaultId 自动建 id', () => {
  it('生成 vault- 前缀且唯一', () => {
    const a = genVaultId();
    const b = genVaultId();
    expect(a).toMatch(/^vault-/);
    expect(b).toMatch(/^vault-/);
    expect(a).not.toBe(b);
  });
});

describe('normalizeVaultBaseUrl 自动补 /v1', () => {
  it('deepseek 官方原样保存（官方 base_url 不带 /v1）', () => {
    expect(normalizeVaultBaseUrl('https://api.deepseek.com', 'deepseek')).toBe('https://api.deepseek.com');
  });
  it('deepseek 已带 /v1 也保留原样', () => {
    expect(normalizeVaultBaseUrl('https://api.deepseek.com/v1', 'deepseek')).toBe('https://api.deepseek.com/v1');
  });
  it('openai 官方缺 /v1 时补全', () => {
    expect(normalizeVaultBaseUrl('https://api.openai.com', 'openai')).toBe('https://api.openai.com/v1');
  });
  it('transit 中转站不擅自加路径', () => {
    expect(normalizeVaultBaseUrl('https://apinebula.ai', 'transit')).toBe('https://apinebula.ai');
  });
  it('claude 不补 /v1（Anthropic 协议路径不同）', () => {
    expect(normalizeVaultBaseUrl('https://api.anthropic.com', 'claude')).toBe('https://api.anthropic.com');
  });
  it('空 baseUrl 返回空串', () => {
    expect(normalizeVaultBaseUrl('  ', 'transit')).toBe('');
  });
});

describe('baseUrlListWithV1 候选列表', () => {
  it('原路径优先，缺 /v1 时补 /v1 作为兜底候选', () => {
    expect(baseUrlListWithV1('https://api.deepseek.com')).toEqual([
      'https://api.deepseek.com',
      'https://api.deepseek.com/v1',
    ]);
  });
  it('已带 /v1 时仅一个候选', () => {
    expect(baseUrlListWithV1('https://api.deepseek.com/v1')).toEqual(['https://api.deepseek.com/v1']);
  });
});

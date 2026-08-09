import { describe, it, expect } from 'vitest';
import { inferVendor, labelFromBaseUrl, genVaultId } from './credentialStore';

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

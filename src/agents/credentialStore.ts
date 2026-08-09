import { isTauri } from '../platform/env';
import type { ApiEndpoint, ApiVault, Protocol, Vendor } from '../types';

/**
 * API 接入点存储封装（路线 A）。
 *
 * 接入点整条（name / protocol / baseUrl / apiKey）落盘在 AppData 的
 * endpoints.json 文件；其中 apiKey 字段由 Rust 侧以 AES-GCM 加密存储
 * （主密钥存于 OS 密钥库），读取时解密，磁盘上不出现明文 key。
 *
 * 凭据库（keyring）现仅用于存放 AES 主密钥（单条），不再逐条登记 apiKey；
 * 智能体运行时按 name 经 loadEndpointKey 从 endpoints.json 解密取回 key。
 *
 * 历史方案（ep:: 前缀 / __ep_index__ 元键 / 独立 endpoints service）已废弃，
 * 因 Windows 凭据管理器对下划线元键读写不一致；详见 lib.rs 注释。
 */

export type CredentialKey = string;

/** Tauri 命令返回 Option<String> 在前端表现为 string | null。 */
type OptionString = string | null;

/** 内部：接入点整条（含明文 key，落盘时由 Rust 加密，读取时解密）。 */
type StoredEndpoint = ApiEndpoint & { apiKey: string };

async function invokeRaw<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** 保存一条凭据到系统密钥库（覆盖写）。非 Tauri 环境不可用。 */
export async function saveCredential(key: CredentialKey, value: string): Promise<void> {
  if (!isTauri) {
    throw new Error('当前环境不支持系统密钥库（请使用桌面版）。');
  }
  await invokeRaw('set_credential', { key, value });
}

/** 读取一条凭据；不存在返回 null。 */
export async function loadCredential(key: CredentialKey): Promise<string | null> {
  if (!isTauri) return null;
  return (await invokeRaw<OptionString>('get_credential', { key })) ?? null;
}

/** 删除一条凭据。 */
export async function removeCredential(key: CredentialKey): Promise<void> {
  if (!isTauri) return;
  await invokeRaw('delete_credential', { key });
}

/** 枚举已登记的凭据键（来自系统密钥库）；非 Tauri 环境返回空数组。 */
export async function listCredentials(): Promise<CredentialKey[]> {
  if (!isTauri) return [];
  return (await invokeRaw<string[]>('list_credentials', {})) ?? [];
}

/* ---------------- API 接入点（独立 endpoints service，Rust 端枚举） ---------------- */

/**
 * 保存一个 API 接入点（网址 + 密钥）。
 * 路线 A 下：整条条目（含明文 key）经 Rust `save_endpoint` 写入 AppData 的
 * endpoints.json，其中 apiKey 字段由 Rust 侧以 AES-GCM 加密落盘（主密钥在 keyring）。
 * 不再把 key 单独登记到 credential service——智能体按接入点 name 引用，
 * 运行时经 loadEndpointKey 从 endpoints.json 解密取回。
 */
export async function saveEndpoint(ep: ApiEndpoint, apiKey: string): Promise<void> {
  if (!isTauri) {
    throw new Error('当前环境不支持系统密钥库（请使用桌面版）。');
  }
  const name = ep.name.trim();
  if (!name) throw new Error('接入点名称不能为空。');
  if (name === 'ep::' || name.startsWith('ep::')) throw new Error('该名称被系统保留。');

  const stored: StoredEndpoint = { ...ep, name, apiKey };
  await invokeRaw('save_endpoint', { key: name, value: JSON.stringify(stored) });
}

/** 读取一个 API 接入点的明文 key（校验/拉模型用）。 */
export async function loadEndpointKey(name: string): Promise<string | null> {
  if (!isTauri) return null;
  const raw = (await invokeRaw<OptionString>('load_endpoint', { key: name })) ?? null;
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as StoredEndpoint).apiKey ?? null;
  } catch {
    return null;
  }
}

/**
 * 删除一个 API 接入点。
 * 路线 A 下接入点仅存于 endpoints.json（apiKey 已加密），无独立的 credential 条目，
 * 故只需删除 endpoints.json 中的对应键即可。
 */
export async function removeEndpoint(name: string): Promise<void> {
  if (!isTauri) return;
  await invokeRaw('delete_endpoint', { key: name });
}

/** 枚举全部 API 接入点（来自 endpoints service，Rust 端直接枚举）。 */
export async function listEndpoints(): Promise<ApiEndpoint[]> {
  if (!isTauri) return [];
  const raws = (await invokeRaw<string[]>('list_endpoints_raw', {})) ?? [];
  const out: ApiEndpoint[] = [];
  for (const r of raws) {
    try {
      const o = JSON.parse(r) as StoredEndpoint;
      if (typeof o?.name === 'string' && typeof o?.baseUrl === 'string') {
        const { apiKey: _omit, ...rest } = o;
        out.push(rest);
      }
    } catch {
      /* 跳过损坏条目 */
    }
  }
  return out;
}

/**
 * 凭据键命名约定：按协议固定前缀，便于 UI 列出与管理。
 * 例如 openai / anthropic / deepseek 各自一条；Ollama 本地无需凭据。
 */
export function defaultCredentialKey(protocol: string): CredentialKey {
  return protocol; // 'openai' | 'anthropic' | 'ollama' ...
}

/* ---------------- Vault（自动分组密钥库，2026-08-09） ---------------- */

/** 存储的 vault 整条（含明文 key，落盘时 Rust 加密）。 */
type StoredVault = ApiVault & { apiKey: string };

/** 生成一个唯一的 vault id（不靠用户打标）。 */
export function genVaultId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `vault-${crypto.randomUUID()}`;
  }
  return `vault-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 默认展示名：取 baseUrl 的 host 域名（去掉协议与路径、www）。 */
export function labelFromBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return (u.hostname || baseUrl).replace(/^www\./, '');
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').split('/')[0] || 'transit';
  }
}

/** 按 baseUrl 域名推断厂商分组（自动打标，不靠用户手填）。 */
export function inferVendor(baseUrl: string, protocol: Protocol = 'openai'): Vendor {
  const host = (() => {
    try {
      return new URL(baseUrl).hostname.toLowerCase();
    } catch {
      return (baseUrl || '').toLowerCase();
    }
  })();
  const all = host + ' ' + (baseUrl || '').toLowerCase();
  if (all.includes('deepseek')) return 'deepseek';
  if (all.includes('anthropic')) return protocol === 'anthropic' ? 'anthropic' : 'claude';
  if (all.includes('siliconflow')) return 'siliconflow';
  if (all.includes('openrouter')) return 'openrouter';
  if (all.includes('openai')) return 'openai';
  return 'transit';
}

/** 保存一个 Vault（apiKey 明文仅传此函数，Rust 侧加密落盘）。id 自动生成或传入。 */
export async function saveVault(
  input: { label?: string; baseUrl: string; protocol?: Protocol; vendor?: Vendor; id?: string },
  apiKey: string,
): Promise<ApiVault> {
  if (!isTauri) throw new Error('当前环境不支持系统密钥库（请使用桌面版）。');
  const protocol = input.protocol ?? 'openai';
  const vendor = input.vendor ?? inferVendor(input.baseUrl, protocol);
  // 仅对「必须带 /v1」的官方 vendor 补全；deepseek 官方 base_url 不带 /v1（兼容两者），保持原样
  const baseUrl = normalizeVaultBaseUrl(input.baseUrl, vendor);
  if (!baseUrl) throw new Error('Base URL 不能为空。');
  const id = input.id?.trim() || genVaultId();
  const label = input.label?.trim() || labelFromBaseUrl(baseUrl);
  const vault: ApiVault = { id, label, vendor, protocol, baseUrl };
  const stored: StoredVault = { ...vault, apiKey };
  await invokeRaw('save_vault', { key: id, value: JSON.stringify(stored) });
  return vault;
}

/**
 * 补全 /v1 路径（仅对「官方 OpenAI 兼容且要求 /v1」的 vendor）。
 * 特例：deepseek 官方 base_url 为 `https://api.deepseek.com`（不带 /v1，且兼容 /v1），
 * 一律原样保存、不擅自加路径；transit 中转站、claude/anthropic 同样不加。
 */
export function normalizeVaultBaseUrl(baseUrl: string, vendor: Vendor): string {
  const b = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (vendor === 'deepseek' || vendor === 'transit' || vendor === 'claude' || vendor === 'anthropic') return b;
  if (/\/v\d+$/.test(b)) return b;
  return `${b}/v1`;
}

/** 枚举全部 Vault 元数据（不含明文 key）。 */
export async function listVaults(): Promise<ApiVault[]> {
  if (!isTauri) return [];
  const raws = (await invokeRaw<string[]>('list_vaults', {})) ?? [];
  const out: ApiVault[] = [];
  for (const r of raws) {
    try {
      const o = JSON.parse(r) as StoredVault;
      if (typeof o?.id === 'string' && typeof o?.baseUrl === 'string') {
        const { apiKey: _omit, ...rest } = o;
        out.push(rest);
      }
    } catch {
      /* 跳过损坏条目 */
    }
  }
  return out;
}

/** 按 vaultId 读取单个 Vault 的明文 key（含元数据）。 */
export async function loadVaultKey(id: string): Promise<{ apiKey: string; vault: ApiVault } | null> {
  if (!isTauri) return null;
  const raw = (await invokeRaw<OptionString>('load_vault_key', { key: id })) ?? null;
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as StoredVault;
    if (typeof o?.apiKey === 'string') {
      const { apiKey, ...vault } = o;
      return { apiKey, vault };
    }
    return null;
  } catch {
    return null;
  }
}

/** 删除一个 Vault。 */
export async function removeVault(id: string): Promise<void> {
  if (!isTauri) return;
  await invokeRaw('delete_vault', { key: id });
}

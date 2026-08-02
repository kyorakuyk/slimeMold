import { isTauri } from '../platform/env';
import type { ApiEndpoint } from '../types';

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
  return (await invokeRaw<string[]>('list_credentials')) ?? [];
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
  const raws = (await invokeRaw<string[]>('list_endpoints_raw')) ?? [];
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

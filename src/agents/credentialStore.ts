import { isTauri } from '../platform/env';
import type { ApiEndpoint } from '../types';

/**
 * 系统密钥库封装（Step 0.5）。
 *
 * 凭据以 (service, key) 维度存于 OS 密钥库：
 *   - Windows → Credential Manager
 *   - macOS   → Keychain
 *   - Linux   → secret-service (gnome-keyring / kwallet)
 *
 * 明文 key 永不以文件形式落盘，也不进入工作流 JSON。前端只持有「凭据键」
 * （credentialKey），运行时由 Rust 侧按此键从密钥库取回真实 key 并发起请求。
 *
 * 两类条目共存于同一服务下：
 *   - 纯密钥：`key = name`，value = 明文 key。智能体「单独配置」时按 name 引用。
 *   - API 接入点：`key = ep::<name>`，value = JSON 整条（含明文 key）。
 *     索引键 `__ep_index__` 记录所有 endpoint 的 name，供 listEndpoints 枚举。
 *   内部索引键均以下划线开头（___cred_index___ / __ep_index__），
 *   不会泄漏进纯密钥或 endpoint 列表（Rust 端已过滤）。
 */

export type CredentialKey = string;

/** Tauri 命令返回 Option<String> 在前端表现为 string | null。 */
type OptionString = string | null;

/** 内部：接入点整条（含明文 key，仅存于密钥库）。 */
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
 * - 完整条目（含明文 key）写入独立 endpoints service（Rust save_endpoint）。
 * - 同时把明文 key 以 `name` 登记为纯密钥（credential service），
 *   使智能体「单独配置 / 从库导入」按 credentialKey = name 引用同一把 key。
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
  // 纯密钥（智能体按 name 引用）由 Rust save_endpoint 一并登记到凭据 service
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

/** 删除一个 API 接入点（endpoints service + 纯密钥）。 */
export async function removeEndpoint(name: string): Promise<void> {
  if (!isTauri) return;
  await invokeRaw('delete_endpoint', { key: name });
  await removeCredential(name);
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

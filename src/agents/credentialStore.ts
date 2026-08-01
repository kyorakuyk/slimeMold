import { isTauri } from '../platform/env';

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
 */

export type CredentialKey = string;

/** 保存一条凭据到系统密钥库（覆盖写）。非 Tauri 环境不可用。 */
export async function saveCredential(key: CredentialKey, value: string): Promise<void> {
  if (!isTauri) {
    throw new Error('当前环境不支持系统密钥库（请使用桌面版）。');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_credential', { key, value });
}

/** 读取一条凭据；不存在返回 null。 */
export async function loadCredential(key: CredentialKey): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return (await invoke<OptionString>('get_credential', { key })) ?? null;
}

/** 删除一条凭据。 */
export async function removeCredential(key: CredentialKey): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('delete_credential', { key });
}

/** Tauri 命令返回 Option<String> 在前端表现为 string | null。 */
type OptionString = string | null;

/**
 * 凭据键命名约定：按协议固定前缀，便于 UI 列出与管理。
 * 例如 openai / anthropic / deepseek 各自一条；Ollama 本地无需凭据。
 */
export function defaultCredentialKey(protocol: string): CredentialKey {
  return protocol; // 'openai' | 'anthropic' | 'ollama' ...
}

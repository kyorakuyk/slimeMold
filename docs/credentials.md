# 凭据分层模型（Credentials Layering）

> 对应安全评审发现的 S6：明确「桌面端 / headless / 工作流文件」三处凭据的处理边界，
> 避免明文密钥落入磁盘或版本库。

## 核心原则

**工作流文件（`.workflow.json`）永不持久化明文 API Key。** 它只保存一个「凭据键」（`credentialKey`，
形如 `cred:openai:main`），运行时凭此键从系统密钥库 / 加密接入点文件取回真实密钥。

## 三层模型

### 1. 桌面端（生产链路，推荐）
- **API Key 明文存储位置**：系统密钥库
  - Windows：Credential Manager
  - macOS：Keychain
  - Linux：secret-service
  - 由 Rust 侧 `ep::<name>` 能力读写（见 `src-tauri/src/lib.rs`）。
- **接入点（ApiEndpoint = Base URL + apiKey）整条**落 `AppData/com.slimemold/endpoints.json`：
  - 因为 Windows keyring 存在 `(service, user)` 读写不一致问题，接入点列表改为文件存储；
  - 其中 `apiKey` 字段由 Rust 侧以 **AES-GCM** 加密成密文，主密钥存于密钥库单条 `___sm_master_key___`；
  - 磁盘上**无明文**。
- **工作流文件**只存 `credentialKey`，UI 不编辑 `apiKey` 字段（`src/types.ts` 中 `apiKey` 标注为
  「仅 headless / 本地 Ollama 使用」，UI 链路不写入）。
- 导出剥离逻辑见 `src/io/workflowIO.ts`：序列化时 `agents.map(({ apiKey: _drop, ...rest }) => rest)`，
  即便某 agent 残留 `apiKey`，导出文件也不持久化明文。

### 2. Headless / CLI（调试与 CI）
- 场景：无 UI、无系统密钥库（如容器、GitHub Actions）。
- 凭据来源（按优先级）：
  1. 命令行 / 环境变量传入的 `apiKey`（明文），见 `src/engine/headless.ts` 的 `agents` 形参；
  2. 或经 `examples/*.workflow.json` 中显式 `apiKey`（仅限本地/测试 workflow，不入库生产）。
- 这是**与桌面密钥库链路隔离**的明文通道，仅用于无头执行与调试；不写入工作流文件持久层。

### 3. 工作流文件（`.workflow.json`）
- **导出**：剥离明文 `apiKey`，仅保留 `credentialKey`（见上文 `workflowIO.ts`）。
- **导入**：不依赖文件内明文 `apiKey`；运行时按 `credentialKey` 从桌面密钥库（或 headless 环境变量）取回。
- **约束**：不要把含明文 `apiKey` 的 workflow 文件提交进 git——它只应出现在本地/测试语境。
  （导入未注册 custom node 时会提示去插件面板扫描；同理，缺失 `credentialKey` 的 agent 运行时会标红失败。）

## 信任边界

| 来源 | 明文密钥落点 | 是否进 git | 取回方式 |
|---|---|---|---|
| 桌面端接入点 | `endpoints.json`（AES-GCM 加密） | 否（AppData） | 运行时 AES 解密 |
| 系统密钥库 | OS keychain | 否 | `ep::<name>` |
| Headless 环境变量 | 进程内存 / 临时 env | 否（不持久） | `headless.ts` 传入 |
| 工作流文件 | 仅 `credentialKey` 引用 | 可（无明文） | 凭 key 取回 |

## 危险操作告警

- ❌ 在 `agents[].apiKey` 里硬编码密钥并 `git add` 工作流文件 → 明文泄露。
- ✅ 正确做法：桌面端走「APIKEYS」面板保存接入点（自动加密）；工作流只引用 `credentialKey`。
- ⚠️ Headless 明文 `apiKey` 仅用于本地调试 / CI secrets，不要出现在可共享的 workflow 文件里。

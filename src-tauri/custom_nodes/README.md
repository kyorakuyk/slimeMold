# custom_nodes —— 自定义节点

自定义节点有两处目录，生效范围不同：

- **程序目录 `custom_nodes/`（本目录）**：位于程序安装根（开发态 `src-tauri/custom_nodes`，打包后 `SlimeMold/custom_nodes`）。**全局生效**，跨所有项目可用。随程序安装，不经 git 走。
- **项目目录 `<你的项目>/custom_nodes/`**：放在你打开的项目根下。**仅当前项目内生效**；切换/关闭项目时自动卸载，不会污染其它项目。随项目 git 走，方便做整合包分享。

两处目录结构一致：每个子目录 = 一个节点包，含 `manifest.json`（声明）+ `index.js`（实现）。
在「插件管理」面板点「扫描自定义节点」会同时扫这两处（程序级 + 当前项目级）；打开项目时也会自动扫描。

## 三层抽象（人类 · 职业 · 个人）

节点系统按"人类—职业—个人"分层，能力边界与抽象层级对齐：

- **第一层 人类（Node）**：所有节点的元抽象。定义"什么是节点"（输入/输出/参数/执行）。
- **第二层 职业（分工）**：一类节点的模板，预置某套能力与默认行为。框架职业（能力单调递增）：
  `ComputeNode`(compute) → `IoNode`(io) → `SandboxWriteNode`(sandbox_write) → `CoordinatorNode`(coordinator) → `SystemNode`(system) → `GitNode`(system，仅受限 git)。
- **第三层 个人（具体节点）**：继承某个职业类，实现 `execute`（或重载其方法）。

**提权 = 写代码继承框架的高权限职业类**（basemod 式），而不是改配置文件。
普通 `executors` 函数式节点永远封顶 `io`；只有声明 `extends` 继承了更高职业类的节点，才获得对应能力。

## 写法一：简单节点（函数式，封顶 io）

```json
{ "typeId": "custom.greeter", "name": "问候", "inputs": [{"id":"text","type":"text"}],
  "outputs": [{"id":"out","type":"text"}], "params": [{"id":"prefix","type":"text","default":"你好，"}] }
```
```js
export default { executors: { 'custom.greeter': async (inputs, params, ctx) => {
  return { out: `${(params.prefix||'你好，')}${inputs.text ?? ''}` };
} } };
```
不写 `extends` → 能力封顶 `io`（可 `llm`/`storage`，不可碰工作区文件）。

## 写法二：继承式提权（类式 + extends 声明）

`manifest.json` 节点加 `"extends": "SandboxWriteNode"`（或其它框架职业），即可拿到该级能力：

```json
{ "typeId": "custom.textWriter", "name": "文本写入", "extends": "SandboxWriteNode",
  "inputs": [{"id":"path","type":"text"},{"id":"content","type":"text"}],
  "outputs": [{"id":"ok","type":"text"}] }
```
```js
import { SandboxWriteNode } from 'slime-mold-sdk';
export class TextWriter extends SandboxWriteNode {
  typeId = 'custom.textWriter';
  async execute({ path, content }, params, ctx) {
    await ctx.sandbox.writeFile(path, String(content ?? '')); // sandbox_write 级注入真实实现
    return { ok: `已写入 ${path}` };
  }
}
```
> 注意：loader 用 Blob URL 动态 import，无法共享 sdk 的同一类实例；**运行时能力等级以 manifest 的 `extends` 声明为准**，类式写法的价值在于代码可读性与类型提示。

## 写法三：自定义职业（创造"新职业"，阶段 E）

在 `manifest.json` 用 `occupations` 定义新职业，节点 `extends` 指向它：

```json
{ "occupations": [{ "name": "FileWorker", "extends": "SandboxWriteNode" }],
  "nodes": [{ "typeId": "custom.textWriter", "name": "文本写入", "extends": "FileWorker", ... }] }
```
`FileWorker` 继承 `SandboxWriteNode`，其下所有节点自动获得 `sandbox_write` 能力。
同包内可自由派生；跨包继承须显式导出职业类（见下文）。

## 硬规则（阶段 C 安全边界）

- 提权**只能通过 `extends` 继承职业类**；仅靠 `minCapability` 字段声明越权等级会被拒绝加载。
- `custom` 来源下，未写 `extends` 的节点强制封顶 `io`（杜绝"配置文件后门"）。
- `extends` 只可引用框架职业（`ComputeNode`/`IoNode`/`SandboxWriteNode`/`CoordinatorNode`/`SystemNode`/`GitNode`）或本包 `occupations` 登记的职业。
- `SystemNode` 已细分 `GitNode`，**不暴露任意 shell**，仅限受限 git 命令（如 worktree）。

## 能力对照表

| 职业类 | 能力等级 | 可用 ctx 能力 |
|---|---|---|
| ComputeNode | compute | logger/vars/signal/costLog/reportCost/setPartial |
| IoNode | io | + llm/storage/addAsset/assets/writeOutEdgeScope |
| SandboxWriteNode | sandbox_write | + sandbox.writeFile/readFrom/list（commit 为拒绝型） |
| CoordinatorNode | coordinator | + sandbox.commitAll/commitLanes（真落地权） |
| SystemNode / GitNode | system | + 受限系统封装（GitNode: runGit） |

插件面板会对 `minCapability > io` 的节点显示红色「已提权」徽标，透明可见、随时可卸载收回。

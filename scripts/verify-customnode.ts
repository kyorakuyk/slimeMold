/**
 * 步骤13 逻辑验收（临时）：纯 node 下验证 B/C/E 解析 + 阶段 D 徽标判定。
 * 不依赖 React/Tauri，可在 CI 跑。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateManifest, resolveExtendsCapability } from '../src/plugins/loader';
import { getEscalatedDefs } from '../src/components/PluginPanel';
import type { NodeDefinition } from '../src/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// ---- 阶段 E：真实样例 example-fileworker（程序级目录 src-tauri/custom_nodes）----
const fwManifest = readFileSync(join(root, 'src-tauri/custom_nodes/example-fileworker/manifest.json'), 'utf8');
const fw = validateManifest(JSON.parse(fwManifest), 'custom');
const occ = fw.occupations ?? [];
assert(occ.length === 1 && occ[0].name === 'FileWorker' && occ[0].extends === 'SandboxWriteNode', 'occupations: FileWorker extends SandboxWriteNode');
assert(resolveExtendsCapability('FileWorker', occ, 'custom') === 'sandbox_write', 'extends:FileWorker → sandbox_write');

// ---- 阶段 B：框架职业 ----
assert(resolveExtendsCapability('CoordinatorNode', [], 'custom') === 'coordinator', 'extends:CoordinatorNode → coordinator');
assert(resolveExtendsCapability('IoNode', [], 'custom') === 'io', 'extends:IoNode → io');

// ---- 阶段 C：安全边界（custom 来源）----
assert(resolveExtendsCapability(undefined, [], 'custom') === 'io', '无 extends → 封顶 io');
assert(resolveExtendsCapability(undefined, [], 'custom', 'sandbox_write') === 'io', '仅靠 minCapability 越权 → 回落 io');
assert(resolveExtendsCapability(undefined, [], 'custom', 'compute') === 'compute', 'minCapability:compute 尊重');

// 阶段 C 硬校验：非法 extends 拒绝
let r1 = false; try { validateManifest({ id: 'x', name: 'x', entry: 'i.js', nodes: [{ typeId: 'n', name: 'n', inputs: [], outputs: [], extends: 'Nope' }] }, 'custom'); } catch { r1 = true; }
assert(r1, 'extends 指向不存在职业 → 拒绝');

// 阶段 C 硬校验：仅 minCapability 越权缺 extends 拒绝
let r2 = false; try { validateManifest({ id: 'x', name: 'x', entry: 'i.js', nodes: [{ typeId: 'n', name: 'n', inputs: [], outputs: [], minCapability: 'coordinator' }] }, 'custom'); } catch { r2 = true; }
assert(r2, '声明 minCapability 越权但缺 extends → 拒绝（杜绝配置文件后门）');

// 阶段 C 硬校验：occupations.extends 非框架职业拒绝
let r3 = false; try { validateManifest({ id: 'x', name: 'x', entry: 'i.js', occupations: [{ name: 'Bad', extends: 'Random' }], nodes: [{ typeId: 'n', name: 'n', inputs: [], outputs: [] }] }, 'custom'); } catch { r3 = true; }
assert(r3, 'occupations.extends 非框架职业 → 拒绝');

// ---- 阶段 D：徽标判定纯函数 ----
const mkDef = (typeId: string, minCapability?: NodeDefinition['minCapability']): NodeDefinition => ({
  typeId, name: typeId, category: '', inputs: [], outputs: [], params: [], pluginId: 'p', execute: async () => ({}), ...(minCapability ? { minCapability } : {}),
});
const defs = [mkDef('a', 'io'), mkDef('b', 'compute'), mkDef('c', 'sandbox_write'), mkDef('d', 'coordinator'), mkDef('e', 'system')];
const esc = getEscalatedDefs(defs);
assert(esc.length === 3, `阶段D：3 个提权节点被识别（实际 ${esc.length}）`);
assert(esc.every((d) => d.minCapability !== 'io' && d.minCapability !== 'compute'), '阶段D：提权节点均不含 io/compute');
assert(getEscalatedDefs([mkDef('x', 'io')]).length === 0, '阶段D：io 节点不标提权');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

import { createNodeDef, type NodeDefinition } from '../../types/node';
import { evalExpr } from '../../engine/expr';
import { SUBGRAPH_REF_TYPE } from '../../engine/subgraph';
import { isTruthy, checkJsonSchema } from '../builtinHelpers';

const ifNode: NodeDefinition = {
  typeId: 'flow.if',
  name: '条件分支',
  category: '流程',
  role: 'orchestrator',
  whenToUse: '根据条件表达式只走 true/false 一条分支；未激活分支的下游会被跳过（不执行）。',
  description:
    '根据条件表达式求值结果，只走 true / false 其中一条分支。下游若只连到未激活的分支则被跳过（不执行）。表达式可引用输入端口与全局变量，结果按「真值」判断（非空、非零、非空字符串、非空数组）。',
  inputs: [{ id: 'cond', label: '条件', type: 'any' }],
  outputs: [
    { id: 'true', label: '真', type: 'any' },
    { id: 'false', label: '假', type: 'any' },
  ],
  params: [
    {
      key: 'expression',
      label: '条件表达式（可选，留空则直接用输入端口「条件」）',
      type: 'textarea',
      default: '',
      placeholder: '例如：cond > 3，或 len(a) > 0',
    },
  ],
  async execute(inputs, params, ctx) {
    const expr = String(params.expression ?? '').trim();
    let value: unknown;
    if (expr) {
      const result = evalExpr(expr, { ...ctx.vars, ...inputs });
      value = result;
    } else {
      value = inputs.cond;
    }
    const truthy = isTruthy(value);
    // 声明激活分支：仅 true 或仅 false 端口生效，另一分支的下游被剪枝
    ctx.setBranches?.(truthy ? ['true'] : ['false']);
    return { result: truthy, taken: truthy ? 'true' : 'false' };
  },
};

const mergeNode: NodeDefinition = {
  typeId: 'flow.merge',
  name: '聚合',
  category: '流程',
  description:
    '将多路上游输入汇聚为一个数组输出，用于把并行或分支的结果重新汇合。未接入的端口忽略；另输出 first（第一个非空输入）便于直接取用单值。',
  inputs: [
    { id: 'a', label: '输入 A', type: 'any' },
    { id: 'b', label: '输入 B', type: 'any' },
    { id: 'c', label: '输入 C', type: 'any' },
  ],
  outputs: [
    { id: 'items', label: '数组', type: 'list' },
    { id: 'first', label: '首个', type: 'any' },
  ],
  params: [],
  async execute(inputs) {
    const present = [inputs.a, inputs.b, inputs.c].filter(
      (v) => v !== undefined && v !== null && v !== '',
    );
    return { items: present, first: present[0] ?? null };
  },
};

const delayNode: NodeDefinition = {
  typeId: 'flow.delay',
  name: '延迟',
  category: '流程',
  description:
    '等待指定毫秒后透传输入值，用于限速、节流或在分支流程中插入人工观察窗口。受全局中止信号控制，运行中可手动停止。',
  inputs: [{ id: 'value', label: '数据', type: 'any' }],
  outputs: [{ id: 'value', label: '数据', type: 'any' }],
  params: [
    {
      key: 'ms',
      label: '延迟（毫秒）',
      type: 'number',
      default: 1000,
      placeholder: '如 1000 表示等待 1 秒',
    },
  ],
  async execute(inputs, params, ctx) {
    const ms = Math.max(0, Number(params.ms ?? 0) || 0);
    if (ms > 0) {
      ctx.logger.info(`延迟 ${ms}ms`);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new Error('已中止'));
          },
          { once: true },
        );
      });
    }
    return { value: inputs.value };
  },
};

const switchNode: NodeDefinition = {
  typeId: 'flow.switch',
  name: '多路路由',
  category: '流程',
  description:
    '根据「匹配键」将流程路由到 c1~c4 中第一个匹配的分支，无匹配时走 _default 分支。未命中的分支下游被剪枝（不执行）。匹配键可由表达式计算（引用输入与全局变量），或留空直接用输入端口「键」。',
  inputs: [
    { id: 'key', label: '键(可选)', type: 'any' },
  ],
  outputs: [
    { id: 'c1', label: '分支1', type: 'any' },
    { id: 'c2', label: '分支2', type: 'any' },
    { id: 'c3', label: '分支3', type: 'any' },
    { id: 'c4', label: '分支4', type: 'any' },
    { id: '_default', label: '默认', type: 'any' },
  ],
  params: [
    {
      key: 'expression',
      label: '匹配键表达式（可选，留空则用输入端口「键」）',
      type: 'textarea',
      default: '',
      placeholder: '例如：key，或 input.category',
    },
    { key: 'm1', label: '分支1 匹配值', type: 'text', default: '' },
    { key: 'm2', label: '分支2 匹配值', type: 'text', default: '' },
    { key: 'm3', label: '分支3 匹配值', type: 'text', default: '' },
    { key: 'm4', label: '分支4 匹配值', type: 'text', default: '' },
  ],
  async execute(inputs, params, ctx) {
    const expr = String(params.expression ?? '').trim();
    const keyVal = expr
      ? String(evalExpr(expr, { ...ctx.vars, ...inputs }))
      : String(inputs.key ?? '');
    const matches: Array<[string, string]> = [
      ['c1', String(params.m1 ?? '')],
      ['c2', String(params.m2 ?? '')],
      ['c3', String(params.m3 ?? '')],
      ['c4', String(params.m4 ?? '')],
    ];
    let taken = '_default';
    for (const [handle, want] of matches) {
      if (want !== '' && keyVal === want) {
        taken = handle;
        break;
      }
    }
    ctx.logger.info(`路由：键=${keyVal} → ${taken}`);
    ctx.setBranches?.([taken]);
    return {
      c1: inputs.key,
      c2: inputs.key,
      c3: inputs.key,
      c4: inputs.key,
      _default: inputs.key,
    };
  },
};

/**
 * 子图引用：把一组打包好的节点当作一个整体放到画布上。
 *
 * 它的端口是动态的——由所引用子图的 inputs/outputs 决定（见 engine/subgraph.ts 的 resolvePorts），
 * 所以这里 inputs/outputs 留空。运行前 executor 会调 flattenSubgraphs() 把它替换成内部节点，
 * 因此 execute 正常情况下不会被调用；保留实现只是为了兜底报错。
 */
const subgraphRef: NodeDefinition = {
  typeId: SUBGRAPH_REF_TYPE,
  name: '子图',
  category: '流程',
  description: '引用一个打包好的节点组合，可在多处复用；双击可进入编辑',
  params: [],
  inputs: [],
  outputs: [],
  execute: async () => {
    throw new Error('子图节点应在运行前被展开，请检查该子图的定义是否存在');
  },
};

/**
 * 条件/循环断点（Loop Gate / Condition Break）：
 * 输出端口声明 `flow: 'control'`，作为 stage 边界——执行引擎在拓扑排序时
 * 把 control 边指向的下游强制推入更高 stage，从而「条件节点 → 循环体 → 回指条件节点」
 * 这类伪环不被误判成环，又能保证每一轮 gate 的顺序。
 *
 * 迭代循环（Step 6）：执行引擎识别到由 control 边构成的回环后，会重复跑整个 stage 序列。
 * 每一轮 gate 走 `pass` 分支 ⇒ 循环继续；走 `stop` 分支 ⇒ 循环体被剪枝、本轮结束即退出循环。
 * 每轮执行前会把当前轮次（从 0 开始）写入 `ctx.vars[loopVar]`，供循环体内部条件判断使用。
 */
const nodeLoopGate: NodeDefinition = {
  typeId: 'flow.loopGate',
  name: '循环/条件断点',
  category: '流程',
  role: 'orchestrator',
  whenToUse: '构成循环或条件重试：循环体尾部以 control（紫色）边回指本节点，执行引擎会做多轮迭代。',
  description:
    '条件判断节点，其「通过」端口为控制流（control，紫色）语义。用于构成循环：循环体尾部以 control 边回指本节点。拓扑排序时 control 边视作 stage 断点，不破坏环检测。条件为假时下游被剪枝。执行引擎会对 control 回环做真正的多轮迭代（Step 6）。',
  inputs: [{ id: 'cond', label: '条件', type: 'any' }],
  outputs: [
    { id: 'pass', label: '通过', type: 'any', flow: 'control' },
    { id: 'stop', label: '终止', type: 'any' },
  ],
  params: [
    {
      key: 'expression',
      label: '条件表达式（可选，留空则直接用输入端口「条件」）',
      type: 'textarea',
      default: '',
      placeholder: '例如：i < 5，或 status == "running"（i 为循环变量）',
    },
    {
      key: 'maxLoops',
      label: '最大循环轮数（防止死循环）',
      type: 'number',
      default: 20,
    },
    {
      key: 'loopVar',
      label: '循环变量名（每轮写入 ctx.vars，供表达式引用）',
      type: 'text',
      default: 'i',
    },
  ],
  async execute(inputs, params, ctx) {
    const expr = String(params.expression ?? '').trim();
    // 每轮由执行引擎写入当前轮次到 ctx.vars[loopVar]
    const loopVar = String(params.loopVar ?? 'i');
    const loopIndex = (ctx.vars[loopVar] as number) ?? 0;
    let value: unknown;
    if (expr) {
      const result = evalExpr(expr, { ...ctx.vars, ...inputs });
      value = result;
    } else {
      value = inputs.cond;
    }
    const truthy = isTruthy(value);
    // 仅激活「通过」或仅「终止」分支；另一分支下游被剪枝
    ctx.setBranches?.(truthy ? ['pass'] : ['stop']);
    return {
      taken: truthy ? 'pass' : 'stop',
      // 告诉执行引擎当前循环轮次，用于多轮迭代调度
      __loopIndex: loopIndex,
    };
  },
};

/* ============================================================================
 * 验证 / 断言节点（verify.assert）
 * - 流程质量 gate：对上游值做断言（条件 / JSON Schema / 相等 / 非空）。
 * - 通过走 data 边（pass），失败走 control 边（fail，紫色），下游被剪枝 ⇒
 *   仅下游为 fail 分支时中止，不影响 pass 分支下游（gate 语义）。
 * - failFast 开启时直接抛错 ⇒ 该节点 error，下游按既有 failed 集合被跳过/传染。
 * ==========================================================================*/

const nodeAssert: NodeDefinition = {
  typeId: 'verify.assert',
  name: '验证 / 断言',
  category: '流程',
  role: 'verifier',
  whenToUse: '作为流程质量闸门：在关键步骤后校验输出（真值/表达式/Schema/相等/非空），失败可剪枝下游或抛错中止。',
  description:
    '流程质量闸门。对上游输入 value 做断言：条件表达式为真、或匹配 JSON Schema、或等于期望值、或不为空。通过走 data 边「通过」，失败走 control 边「失败」（下游被剪枝）。开启「失败时中止」则直接抛错使下游按失败集合跳过。',
  inputs: [{ id: 'value', label: '待验证值', type: 'any' }],
  outputs: [
    { id: 'pass', label: '通过', type: 'any' },
    { id: 'fail', label: '失败', type: 'any', flow: 'control' },
  ],
  params: [
    {
      key: 'mode',
      label: '断言模式',
      type: 'select',
      options: [
        { value: 'truthy', label: '真值（非空/非假）' },
        { value: 'expression', label: '表达式为真（用 value 与 ctx.vars）' },
        { value: 'equals', label: '等于期望值' },
        { value: 'schema', label: '匹配 JSON Schema' },
        { value: 'nonEmpty', label: '非空（字符串/数组/对象）' },
      ],
      default: 'truthy',
    },
    {
      key: 'expression',
      label: '表达式（mode=expression 时生效）',
      type: 'textarea',
      default: '',
      placeholder: '例如：value.length > 0 或 status == "ok"',
    },
    {
      key: 'expected',
      label: '期望值（mode=equals 时生效）',
      type: 'text',
      default: '',
    },
    {
      key: 'schema',
      label: 'JSON Schema（mode=schema 时生效）',
      type: 'textarea',
      default: '',
      placeholder: '{ "type": "object", "required": ["id"] }',
    },
    {
      key: 'failFast',
      label: '失败时中止（抛错，下游按失败集合跳过）',
      type: 'boolean',
      default: false,
    },
    {
      key: 'message',
      label: '断言说明（可选，用于失败日志）',
      type: 'text',
      default: '',
    },
  ],
  async execute(inputs, params, ctx) {
    const value = inputs.value;
    const mode = String(params.mode ?? 'truthy');
    const note = String(params.message ?? '');
    let ok = false;
    const reasons: string[] = [];

    switch (mode) {
      case 'truthy':
        ok = isTruthy(value);
        if (!ok) reasons.push('值为 falsy');
        break;
      case 'expression': {
        const expr = String(params.expression ?? '').trim();
        if (!expr) {
          ok = true; // 空表达式视为通过
        } else {
          const r = evalExpr(expr, { ...ctx.vars, value });
          ok = isTruthy(r);
          if (!ok) reasons.push(`表达式 "${expr}" 为假`);
        }
        break;
      }
      case 'equals': {
        const expected = params.expected;
        ok = JSON.stringify(value) === JSON.stringify(expected);
        if (!ok) reasons.push(`期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(value)}`);
        break;
      }
      case 'schema': {
        const raw = String(params.schema ?? '').trim();
        if (!raw) {
          ok = true;
        } else {
          let schema: Record<string, any>;
          try {
            schema = JSON.parse(raw);
          } catch (e) {
            reasons.push('Schema 不是合法 JSON');
            ok = false;
            break;
          }
          const errs = checkJsonSchema(value, schema);
          ok = errs.length === 0;
          if (!ok) reasons.push(...errs);
        }
        break;
      }
      case 'nonEmpty': {
        if (typeof value === 'string') ok = value.trim().length > 0;
        else if (Array.isArray(value)) ok = value.length > 0;
        else if (value && typeof value === 'object') ok = Object.keys(value).length > 0;
        else ok = false;
        if (!ok) reasons.push('值为空');
        break;
      }
      default:
        ok = true;
    }

    if (ok) {
      ctx.setBranches?.(['pass']);
      ctx.logger.info(note ? `断言通过：${note}` : '断言通过');
      return { pass: true, fail: false, ok: true };
    }

    // 失败
    const detail = `${note ? note + ' — ' : ''}${reasons.join('；') || '断言失败'}`;
    if (String(params.failFast ?? false) === 'true') {
      throw new Error(`[验证/断言] ${detail}`);
    }
    ctx.setBranches?.(['fail']);
    ctx.logger.error(`断言失败：${detail}`);
    return { pass: false, fail: true, ok: false, reason: detail };
  },
};

export const flowNodes: NodeDefinition[] = [
  ifNode,
  mergeNode,
  delayNode,
  switchNode,
  subgraphRef,
  nodeLoopGate,
  nodeAssert,
].map(createNodeDef);

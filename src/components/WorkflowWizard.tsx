import { useState } from 'react';
import { X, Sparkles, ArrowRight, ArrowLeft, Check } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { getNodeDef } from '../store/registryStore';
import type { FlowNode, FlowEdge } from '../types';

type GoalKind = 'chat' | 'translate' | 'summarize' | 'fetch' | 'image' | 'batch';
type DataSource = 'manual' | 'http' | 'none';
type OutKind = 'preview' | 'file' | 'text';

const GOALS: { id: GoalKind; label: string; desc: string }[] = [
  { id: 'chat', label: '单次问答 / 润色', desc: '把一句输入交给智能体处理' },
  { id: 'translate', label: '翻译', desc: '把文本译为目标语言' },
  { id: 'summarize', label: '总结 / 摘要', desc: '长文本压缩为要点' },
  { id: 'fetch', label: '抓取网页', desc: 'HTTP 请求并交给智能体解析' },
  { id: 'image', label: '图像生成 / 处理', desc: '文生图或图片预览' },
  { id: 'batch', label: '批量处理清单', desc: '对列表逐项执行（map）' },
];

const SOURCES: { id: DataSource; label: string; desc: string }[] = [
  { id: 'manual', label: '手动输入', desc: '我直接在节点里写内容' },
  { id: 'http', label: '从网址抓取', desc: '运行时请求一个 URL' },
  { id: 'none', label: '暂不需要输入', desc: '工作流自行产生数据' },
];

const OUTPUTS: { id: OutKind; label: string; desc: string }[] = [
  { id: 'preview', label: '画布内预览', desc: '结果直接显示在结果预览节点' },
  { id: 'file', label: '写入文件', desc: '把结果保存到工作区文件' },
  { id: 'text', label: '纯文本输出', desc: '作为文本输出节点' },
];

function mk(
  id: string,
  typeId: string,
  label: string,
  params: Record<string, unknown>,
  x: number,
  y: number,
): FlowNode {
  return {
    id,
    type: 'base',
    position: { x, y },
    data: { typeId, label, params, status: 'idle' },
  } as FlowNode;
}

function mkEdge(s: string, sh: string, t: string, th: string): FlowEdge {
  return {
    id: `e-${s}-${sh}-${t}-${th}`,
    source: s,
    target: t,
    sourceHandle: sh,
    targetHandle: th,
  } as FlowEdge;
}

/** 根据问答结果组装一份工作流草稿 */
function buildDraft(goal: GoalKind, src: DataSource, out: OutKind): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let x = 40;

  // 1) 输入节点
  let inputId: string | null = null;
  if (src === 'manual') {
    inputId = 'in';
    nodes.push(mk('in', 'input.text', '文本输入', { text: '在这里写你的内容…' }, x, 220));
    x += 300;
  } else if (src === 'http') {
    inputId = 'fetch';
    nodes.push(mk('fetch', 'tool.http', '网页抓取', { method: 'GET', url: '', headers: '', body: '' }, x, 220));
    x += 300;
  }

  // 2) 智能体 / 处理节点（依目标不同）
  const agentId = 'agent';
  const agentParams: Record<string, unknown> = {
    agentId: '',
    roleId: '',
    modelOverride: '',
    simulate: 'on',
  };
  let agentInHandle = 'prompt';
  switch (goal) {
    case 'translate':
      agentParams.system = '你是一名专业译者，把用户提供的文本准确翻译为指定语言，保持语气与格式。';
      break;
    case 'summarize':
      agentParams.system = '你擅长提炼要点，把长文本压缩为简洁清晰的中文摘要。';
      break;
    case 'fetch':
      agentParams.system = '你负责解析抓取的网页内容，提取关键信息并以结构化文本呈现。';
      break;
    case 'image':
      // 图像类改用 image.generate（若未注册则退化为 agent.chat）
      agentParams.system = '你根据描述生成或处理图像。';
      break;
    default:
      agentParams.system = '你是乐于助人的智能体，按用户意图完成文本处理任务。';
  }
  const agentTypeId = goal === 'image' && getNodeDef('image.generate') ? 'image.generate' : 'agent.chat';
  if (goal === 'image') agentInHandle = 'prompt';
  nodes.push(mk(agentId, agentTypeId, '智能体', agentParams, x, 200));
  x += 320;

  // 3) 批量：在输入与智能体之间插入 flow.map（若来源是清单）
  if (goal === 'batch') {
    // 用列表输入 + map 包裹智能体
    nodes.unshift(mk('list', 'flow.list', '清单输入', { items: ['项1', '项2', '项3'] }, 40, 420));
    nodes.push(mk('map', 'flow.map', '逐项处理', {}, 360, 420));
    // 重新规划智能体位置（放到 map 之后）
    nodes[nodes.findIndex((n) => n.id === agentId)].position = { x: 680, y: 220 };
    // 连线：list -> map.items, map.results -> agent
    edges.push(mkEdge('list', 'items', 'map', 'items'));
    if (inputId) edges.push(mkEdge(inputId, inputId === 'fetch' ? 'body' : 'text', 'agent', agentInHandle));
    edges.push(mkEdge('map', 'results', 'agent', agentInHandle));
    x = 1000;
  } else if (inputId) {
    const srcHandle = inputId === 'fetch' ? 'body' : 'text';
    edges.push(mkEdge(inputId, srcHandle, agentId, agentInHandle));
  }

  // 4) 输出节点
  let outHandle = 'text';
  const outTypeId = out === 'file' ? 'tool.writeFile' : out === 'text' ? 'output.text' : 'output.preview';
  if (out === 'file') {
    nodes.push(mk('save', outTypeId, '写入文件', { content: '', filename: '', hint: '', workspace: 'workflow' }, x, 220));
    edges.push(mkEdge(agentId, outHandle, 'save', 'content'));
  } else {
    nodes.push(mk(out === 'text' ? 'out' : 'out', outTypeId, out === 'text' ? '文本输出' : '结果预览', {}, x, 220));
    edges.push(mkEdge(agentId, outHandle, 'out', out === 'text' ? 'text' : 'value'));
  }

  return { nodes, edges };
}

const STEPS = ['目标', '输入', '输出'] as const;

export default function WorkflowWizard({ onClose }: { onClose: () => void }) {
  const loadGraph = useWorkflowStore((s) => s.loadGraph);
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState<GoalKind>('chat');
  const [src, setSrc] = useState<DataSource>('manual');
  const [out, setOut] = useState<OutKind>('preview');

  const lists = [GOALS, SOURCES, OUTPUTS];
  const sel = [goal, src, out];
  const setSel = [setGoal, setSrc, setOut] as const;

  const finish = () => {
    const { nodes, edges } = buildDraft(goal, src, out);
    const goalLabel = GOALS.find((g) => g.id === goal)?.label ?? '工作流';
    loadGraph(`向导：${goalLabel}`, nodes, edges, []);
    onClose();
  };

  return (
    <div className="sm-modal-mask" onMouseDown={onClose}>
      <div className="sm-wizard" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sm-wizard__head">
          <span className="sm-wizard__title">
            <Sparkles size={15} /> 工作流向导
          </span>
          <button className="sm-icon-btn" onClick={onClose} title="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="sm-wizard__steps">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={`sm-wizard__step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
            >
              {i < step ? <Check size={12} /> : i + 1}
              <span>{s}</span>
            </div>
          ))}
        </div>

        <div className="sm-wizard__body">
          <p className="sm-wizard__q">第 {step + 1} 步 · 你想做什么？</p>
          <div className="sm-wizard__opts">
            {lists[step].map((opt: any) => (
              <button
                key={opt.id}
                className={`sm-wizard__opt ${sel[step] === opt.id ? 'selected' : ''}`}
                onClick={() => setSel[step](opt.id)}
              >
                <div className="sm-wizard__opt-label">{opt.label}</div>
                <div className="sm-wizard__opt-desc">{opt.desc}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="sm-wizard__foot">
          <button
            className="sm-btn"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            <ArrowLeft size={14} /> 上一步
          </button>
          {step < STEPS.length - 1 ? (
            <button className="sm-btn sm-btn-primary" onClick={() => setStep((s) => s + 1)}>
              下一步 <ArrowRight size={14} />
            </button>
          ) : (
            <button className="sm-btn sm-btn-primary" onClick={finish}>
              <Sparkles size={14} /> 生成工作流
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

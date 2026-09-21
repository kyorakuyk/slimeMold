import { useState } from 'react';
import { X, Sparkles, ArrowRight, ArrowLeft, Check } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { getNodeDef } from '../store/registryStore';
import { useT } from '../i18n/useT';
import type { FlowNode, FlowEdge } from '../types/graph';

type GoalKind = 'chat' | 'translate' | 'summarize' | 'fetch' | 'image' | 'batch';
type DataSource = 'manual' | 'http' | 'none';
type OutKind = 'preview' | 'file' | 'text';

const GOAL_IDS: GoalKind[] = ['chat', 'translate', 'summarize', 'fetch', 'image', 'batch'];

const SOURCE_IDS: DataSource[] = ['manual', 'http', 'none'];

const OUTPUT_IDS: OutKind[] = ['preview', 'file', 'text'];

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
function buildDraft(
  goal: GoalKind,
  src: DataSource,
  out: OutKind,
  t: (k: string, o?: Record<string, unknown>) => string,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let x = 40;

  // 1) 输入节点
  let inputId: string | null = null;
  if (src === 'manual') {
    inputId = 'in';
    nodes.push(mk('in', 'input.text', t('wizard.node.textInput'), { text: '在这里写你的内容…' }, x, 220));
    x += 300;
  } else if (src === 'http') {
    inputId = 'fetch';
    nodes.push(mk('fetch', 'tool.http', t('wizard.node.fetch'), { method: 'GET', url: '', headers: '', body: '' }, x, 220));
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
  nodes.push(mk(agentId, agentTypeId, t('wizard.node.agent'), agentParams, x, 200));
  x += 320;

  // 3) 批量：在输入与智能体之间插入 flow.map（若来源是清单）
  if (goal === 'batch') {
    // 用列表输入 + map 包裹智能体
    nodes.unshift(mk('list', 'flow.list', t('wizard.node.list'), { items: ['项1', '项2', '项3'] }, 40, 420));
    nodes.push(mk('map', 'flow.map', t('wizard.node.map'), {}, 360, 420));
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
    nodes.push(mk('save', outTypeId, t('wizard.node.writeFile'), { content: '', filename: '', hint: '', workspace: 'workflow' }, x, 220));
    edges.push(mkEdge(agentId, outHandle, 'save', 'content'));
  } else {
    nodes.push(mk(out === 'text' ? 'out' : 'out', outTypeId, out === 'text' ? t('wizard.node.textOutput') : t('wizard.node.resultPreview'), {}, x, 220));
    edges.push(mkEdge(agentId, outHandle, 'out', out === 'text' ? 'text' : 'value'));
  }

  return { nodes, edges };
}

const STEP_IDS = ['goal', 'input', 'output'] as const;

export default function WorkflowWizard({ onClose }: { onClose: () => void }) {
  const t = useT('panels');
  const loadGraph = useWorkflowStore((s) => s.loadGraph);
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState<GoalKind>('chat');
  const [src, setSrc] = useState<DataSource>('manual');
  const [out, setOut] = useState<OutKind>('preview');

  const lists = [GOAL_IDS, SOURCE_IDS, OUTPUT_IDS];
  const sel = [goal, src, out];
  const setSel = [setGoal, setSrc, setOut] as const;

  const finish = () => {
    const { nodes, edges } = buildDraft(goal, src, out, t);
    const goalLabel = t(`wizard.goal.${goal}`);
    loadGraph(`${t('wizard.prefix')}${goalLabel}`, nodes, edges, []);
    onClose();
  };

  return (
    <div className="sm-modal-mask" onMouseDown={onClose}>
      <div className="sm-wizard" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sm-wizard__head">
          <span className="sm-wizard__title">
            <Sparkles size={15} /> {t('wizard.title')}
          </span>
          <button className="sm-icon-btn" onClick={onClose} title={t('wizard.close')}>
            <X size={15} />
          </button>
        </div>

        <div className="sm-wizard__steps">
          {STEP_IDS.map((s, i) => (
            <div
              key={s}
              className={`sm-wizard__step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
            >
              {i < step ? <Check size={12} /> : i + 1}
              <span>{t(`wizard.step.${s}`)}</span>
            </div>
          ))}
        </div>

        <div className="sm-wizard__body">
          <p className="sm-wizard__q">{t('wizard.question', { step: step + 1 })}</p>
          <div className="sm-wizard__opts">
            {lists[step].map((id) => (
              <button
                key={id}
                className={`sm-wizard__opt ${sel[step] === id ? 'selected' : ''}`}
                onClick={() => (setSel[step] as (v: never) => void)(id as never)}
              >
                <div className="sm-wizard__opt-label">{t(`wizard.${['goal', 'src', 'out'][step]}.${id}`)}</div>
                <div className="sm-wizard__opt-desc">{t(`wizard.${['goal', 'src', 'out'][step]}.${id}Desc`)}</div>
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
            <ArrowLeft size={14} /> {t('wizard.prev')}
          </button>
          {step < STEP_IDS.length - 1 ? (
            <button className="sm-btn sm-btn-primary" onClick={() => setStep((s) => s + 1)}>
              {t('wizard.next')} <ArrowRight size={14} />
            </button>
          ) : (
            <button className="sm-btn sm-btn-primary" onClick={finish}>
              <Sparkles size={14} /> {t('wizard.generate')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 子图编辑视图里的「虚拟代理端点节点」。
 * - proxyIn：贴在画布左侧，内部多个 target 端口（可接入内部节点拉来的线）。
 * - proxyOut：贴在画布右侧，内部多个 source 端口（可向外拉线到内部节点）。
 * Handle 必须挂在节点内才有连线上下文，因此用真实节点承载，而不是浮层里的游离 Handle。
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

const PORT_COLOR: Record<string, string> = {
  exec: '#ffd43b',
  text: '#4dabf7',
  image: '#69db7c',
  img: '#69db7c',
  number: '#ffa94d',
  boolean: '#da77f2',
  bool: '#da77f2',
  audio: '#ff6b6b',
  list: '#4dd4ff',
  json: '#f783ac',
  any: '#9aa0a6',
};

export type ProxyPortData = {
  side: 'in' | 'out';
  ports: Array<{ id: string; type: string; label: string }>;
};

function ProxyPortNodeImpl({ data }: NodeProps) {
  const { side, ports } = data as ProxyPortData;
  const isIn = side === 'in';
  const n = ports.length;

  // 每个端口占一行，Handle 用 React Flow 原生定位（保留默认 transform），
  // 仅用 top 百分比把它放到对应行；文字标签单独绝对定位，避免遮挡 Handle 命中区。
  const rowTop = (i: number) => `${((i + 1) / (n + 1)) * 100}%`;

  return (
    <div
      className="relative flex flex-col gap-3 rounded-lg border border-line/40 bg-transparent px-3 py-2"
      style={{ minWidth: 120 }}
    >
      <div className="px-1 text-[11px] font-semibold text-ink-soft">
        {isIn ? '输入代理' : '输出代理'}
      </div>
      {ports.map((p, i) => {
        const color = PORT_COLOR[p.type] ?? PORT_COLOR.any;
        // 代理端口同时提供 source / target 两种 Handle（叠在同一位置），
        // 这样既能「节点 → 代理」（接收），也能「代理 → 节点」（拉出），
        // 在 ConnectionMode.Loose 下两端可互连。
        const handleStyle = {
          top: rowTop(i),
          background: color,
          width: 12,
          height: 12,
          border: '2px solid #fff',
          pointerEvents: 'all' as const,
          zIndex: 10,
        };
        return (
          <div key={p.id} className="relative" style={{ height: 18 }}>
            {/* React Flow 默认 transform 必须保留，否则连接锚点错位导致连不上 */}
            <Handle
              id={`${p.id}__in`}
              type="target"
              position={isIn ? Position.Right : Position.Left}
              style={handleStyle}
            />
            <Handle
              id={`${p.id}__out`}
              type="source"
              position={isIn ? Position.Right : Position.Left}
              style={handleStyle}
            />
            <span
              className="pointer-events-none absolute top-1/2 -translate-y-1/2 rounded px-1 text-[11px] font-medium leading-none"
              style={{
                color,
                background: 'transparent',
                [isIn ? 'left' : 'right']: 14,
              }}
            >
              {p.label}
            </span>
          </div>
        );
      })}
      {ports.length === 0 && (
        <span className="px-1 text-[11px] text-ink-faint">无</span>
      )}
    </div>
  );
}

export default memo(ProxyPortNodeImpl);

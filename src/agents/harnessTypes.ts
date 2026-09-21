/** Shared observable callbacks for the agent harness loop and trajectory sinks. */
export interface HarnessEvents {
  /** 模型开始思考（拿到第一轮响应前/时触发） */
  onThinking?: (info: { round: number; model: string }) => void;
  /** 工具调用发生（含入参与执行结果） */
  onToolCall?: (info: {
    round: number;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    error?: string;
  }) => void;
  /** 最终文本输出（流式逐段或整段） */
  onOutput?: (text: string, done: boolean) => void;
  /** 日志（供 StatusBar / 文件日志） */
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** nudge：连续多轮未产生沉淀时提示复盘 */
  onNudge?: (info: { rounds: number; reason: string }) => void;
}

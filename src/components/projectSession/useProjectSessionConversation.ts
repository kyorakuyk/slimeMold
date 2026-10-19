import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { DomainEvent } from '../../domain/contracts';
import { applyMasterTurnCommand } from '../../projectControl/commands';
import { resolveMasterAgent, runMasterTurn, type MasterResponse } from '../../projectControl/master';
import type {
  ProjectArchitecture,
  ProjectBrief,
  ProjectControlSnapshot,
  ProjectSession,
} from '../../projectControl/types';
import { useWorkflowStore } from '../../store/workflowStore';
import { useT } from '../../i18n/useT';

type UseProjectSessionConversationOptions = {
  sessionId: string;
  session: ProjectSession | null;
  currentBrief: ProjectBrief | null;
  currentArchitecture: ProjectArchitecture | null;
  globalMasterAgentId: string | null;
  t: ReturnType<typeof useT>;
  createId: (prefix: string) => string;
  findSession: (snapshot: ProjectControlSnapshot, sessionId: string) => ProjectSession | null;
  persistControlMutation: (
    projectId: string,
    snapshot: ProjectControlSnapshot,
    events: readonly DomainEvent[],
  ) => Promise<void>;
  responseQuestions: (
    session: ProjectSession,
    response: MasterResponse | null,
  ) => Array<{ id: string; prompt: string; status: 'open' | 'answered' | 'deferred'; answer?: string }>;
};

export default function useProjectSessionConversation({
  sessionId,
  session,
  currentBrief,
  currentArchitecture,
  globalMasterAgentId,
  t,
  createId,
  findSession,
  persistControlMutation,
  responseQuestions,
}: UseProjectSessionConversationOptions) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [localResponse, setLocalResponse] = useState<MasterResponse | null>(null);
  const initialTurnStarted = useRef(false);

  const visibleQuestions = useMemo(
    () => (session ? responseQuestions(session, localResponse) : []),
    [session, localResponse],
  );
  const localReplyVisible = !!localResponse &&
    !!session && !session.messages.some((message) => message.content === localResponse.reply);

  const runTurn = async (userMessage: string, recordUserMessage: boolean) => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    if (!currentSession) {
      setError(t('session.error.noSession'));
      return;
    }

    setBusy(true);
    setError(null);
    setStreamingText('');
    try {
      const agent = resolveMasterAgent({
        agents: state.agents,
        globalAgents: state.globalAgents,
        requestedAgentId: state.projectControl.masterAgentId,
        globalMasterAgentId,
        defaultAgentId: state.defaultAgentId,
      });
      const brief = currentSession.briefId
        ? snapshot.briefs.find((item) => item.id === currentSession.briefId) ?? null
        : null;
      const result = await runMasterTurn({
        agent,
        session: currentSession,
        userMessage,
        currentBrief: brief,
        decisions: snapshot.decisions,
        onToken: (text) => setStreamingText((current) => current + text),
      });
      const latestSnapshot = useWorkflowStore.getState().projectControl;
      const next = applyMasterTurnCommand({
        snapshot: latestSnapshot,
        sessionId,
        userMessage: recordUserMessage ? userMessage : undefined,
        response: result.response,
        now: new Date().toISOString(),
        createId,
      });
      await persistControlMutation(currentSession.projectId, next.snapshot, next.events);
      setLocalResponse(result.response);
      if (recordUserMessage) setInput('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setStreamingText('');
    }
  };

  useEffect(() => {
    if (!session || initialTurnStarted.current) return;
    if (session.messages.some((message) => message.role === 'assistant') || session.briefId) return;
    initialTurnStarted.current = true;
    void runTurn('请开始需求澄清，先提出最关键的问题。', false);
    // 只在这个会话第一次挂载时触发，后续状态更新不能重复发起主控调用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session?.id]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    void runTurn(message, true);
  };

  const handleGenerateArchitecture = () => {
    if (!currentBrief || currentBrief.approval !== 'approved' || currentArchitecture || busy) return;
    void runTurn('请基于已批准的 Brief 生成架构、模块、接口、施工任务和风险。', false);
  };

  return {
    input,
    setInput,
    busy,
    error,
    setError,
    streamingText,
    localResponse,
    setLocalResponse,
    visibleQuestions,
    localReplyVisible,
    handleSubmit,
    handleGenerateArchitecture,
  };
}

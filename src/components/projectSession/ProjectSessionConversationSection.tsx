import { CheckCircle2, CircleDashed, Loader2, Send } from 'lucide-react';
import type {
  ProjectSessionPanelViewProps,
  ProjectSessionViewTranslator,
} from './ProjectSessionPanelView.types';
import { WORKER_RUNTIME_ERROR_MESSAGES } from '../../app/workerRuntimeErrorMessages';

type ProjectSessionConversationSectionProps = Pick<
  ProjectSessionPanelViewProps,
  | 'session'
  | 'busy'
  | 'streamingText'
  | 'localResponse'
  | 'localReplyVisible'
  | 'visibleQuestions'
  | 'input'
  | 'onInputChange'
  | 'onSubmit'
  | 'error'
> & { t: ProjectSessionViewTranslator };

export default function ProjectSessionConversationSection({
  session,
  busy,
  streamingText,
  localResponse,
  localReplyVisible,
  visibleQuestions,
  input,
  onInputChange,
  onSubmit,
  error,
  t,
}: ProjectSessionConversationSectionProps) {
  const displayedError = error === WORKER_RUNTIME_ERROR_MESSAGES.projectNotSaved
    ? t('session.error.workerProjectNotSaved')
    : error === WORKER_RUNTIME_ERROR_MESSAGES.projectContextChanged
      ? t('session.error.workerProjectChanged')
      : error === WORKER_RUNTIME_ERROR_MESSAGES.workerStateDrifted
        ? t('session.error.workerStateDrifted')
        : error;

  return (
    <section className="sm-beginner-session-conversation" aria-label={t('session.conversation')}>
      <div className="sm-beginner-session-card-heading">
        <div>
          <p className="sm-beginner-eyebrow">{t('session.conversationEyebrow')}</p>
          <h2>{t('session.conversation')}</h2>
        </div>
        {busy && <Loader2 size={17} className="sm-beginner-spin" />}
      </div>

      <div className="sm-beginner-session-messages">
        {session.messages.map((message) => (
          <div key={message.id} className={`sm-beginner-session-message is-${message.role}`}>
            <span className="sm-beginner-session-message-role">
              {message.role === 'user' ? t('session.you') : t('session.master')}
            </span>
            <p>{message.content}</p>
          </div>
        ))}
        {localReplyVisible && localResponse && (
          <div className="sm-beginner-session-message is-assistant">
            <span className="sm-beginner-session-message-role">{t('session.master')}</span>
            <p>{localResponse.reply}</p>
          </div>
        )}
        {busy && streamingText && (
          <div className="sm-beginner-session-live-output" aria-live="polite">
            {streamingText}
          </div>
        )}
      </div>

      {visibleQuestions.length > 0 && (
        <div className="sm-beginner-session-question-list">
          <div className="sm-beginner-session-subheading">
            <CircleDashed size={15} /> {t('session.openQuestions')}
          </div>
          {visibleQuestions.map((question) => (
            <div key={question.id} className={`sm-beginner-session-question is-${question.status}`}>
              <span>{question.status === 'answered' ? <CheckCircle2 size={15} /> : <CircleDashed size={15} />}</span>
              <div>
                <strong>{question.prompt}</strong>
                {question.answer && <p>{question.answer}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      <form className="sm-beginner-session-composer" onSubmit={onSubmit}>
        <label htmlFor="project-session-input">{t('session.replyLabel')}</label>
        <textarea
          id="project-session-input"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder={busy ? t('session.thinking') : t('session.placeholder')}
          disabled={busy}
          rows={4}
        />
        <div className="sm-beginner-session-composer-footer">
          <span>{t('session.safetyNote')}</span>
          <button
            type="submit"
            data-testid="beginner-session-submit"
            className="sm-beginner-primary-button"
            disabled={busy || !input.trim()}
          >
            {busy ? <Loader2 size={16} className="sm-beginner-spin" /> : <Send size={16} />}
            {busy ? t('session.thinking') : t('session.send')}
          </button>
        </div>
      </form>
      {displayedError && <p className="sm-beginner-inline-error" role="alert">{displayedError}</p>}
    </section>
  );
}

import { ArrowLeft, ArrowUpRight, LayoutDashboard } from 'lucide-react';
import { useT } from '../../i18n/useT';
import slimeMoldIcon from '../../assets/slimemold-dense-ic-state.svg';

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SimpleHeader({
  onOpenAdvanced,
  onBackHome,
}: {
  onOpenAdvanced?: () => void;
  onBackHome?: () => void;
}) {
  const t = useT('beginner');
  return (
    <header className="sm-beginner-nav">
      <div className="sm-beginner-nav-inner">
        <button
          type="button"
          className="sm-beginner-brand"
          onClick={onBackHome}
          disabled={!onBackHome}
          aria-label={t('project.back')}
        >
          {onBackHome && <ArrowLeft size={15} aria-hidden="true" />}
          <img
            className="sm-beginner-logo"
            src={slimeMoldIcon}
            alt=""
            aria-hidden="true"
          />
          <span className="sm-beginner-brand-name">{t('brand')}</span>
          <span className="sm-beginner-mode">{t('mode')}</span>
        </button>

        <div className="sm-beginner-nav-actions">
          <span className="sm-beginner-local-pill">
            <span className="sm-beginner-local-dot" aria-hidden="true" />
            {t('local')}
          </span>
          {onOpenAdvanced && (
            <button type="button" className="sm-beginner-nav-link" onClick={onOpenAdvanced}>
              <LayoutDashboard size={15} aria-hidden="true" />
              {t('advanced')}
              <ArrowUpRight size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

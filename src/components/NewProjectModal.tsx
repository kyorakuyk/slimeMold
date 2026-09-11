import { useState } from 'react';
import { FolderPlus, MapPin, X, Check, Sparkles } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { STARTER_TEMPLATES } from '../data/starterTemplates';
import { isTauri, showSaveDirDialog } from '../platform/env';
import { useT } from '../i18n/useT';

export default function NewProjectModal({ onClose }: { onClose: () => void }) {
  const t = useT('modals');
  const createProject = useWorkflowStore((s) => s.createProject);
  const addLog = useWorkflowStore((s) => s.addLog);

  const [name, setName] = useState('未命名项目');
  const [templateId, setTemplateId] = useState<string>(''); // '' = 空白画布
  const [location, setLocation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = name.trim().length > 0;
  const tpl = templateId ? STARTER_TEMPLATES.find((t) => t.id === templateId) : undefined;
  const preview = tpl?.build();
  const agentCount = preview ? preview.nodes.filter((n) => n.data.typeId.startsWith('agent.')).length : 0;

  const chooseLocation = async () => {
    if (!isTauri) return;
    const picked = await showSaveDirDialog(name.trim() || t('newProject.untitled'));
    if (picked) setLocation(picked);
  };

  const confirm = async () => {
    if (!nameValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const tplName = tpl?.name;
      await createProject({ name: name.trim(), templateId: templateId || undefined, location: location ?? undefined });
      addLog('info', t('newProject.created', { name: name.trim(), tpl: tplName ? t('newProject.createdTpl', { name: tplName }) : t('newProject.createdBlank') }));
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(t('newProject.failed', { msg }));
      addLog('error', t('newProject.failed', { msg }));
      setBusy(false);
    }
  };

  return (
    <div className="sm-beginner-modal-overlay">
      <div
        className="sm-beginner-modal"
      >
        <button
          className="sm-beginner-modal-close"
          title={t('common.close')}
          onClick={onClose}
        >
          <X size={17} />
        </button>

        <div className="sm-beginner-modal-title">
          <span className="sm-beginner-modal-title-icon"><FolderPlus size={18} /></span>
          <div>
            <h2>{t('newProject.title')}</h2>
          </div>
        </div>

        {/* 1. 项目名 */}
        <label className="sm-beginner-modal-label">
          {t('newProject.nameLabel')}
        </label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && confirm()}
          placeholder={t('newProject.namePlaceholder')}
          className="sm-beginner-modal-input"
        />

        {/* 2. 起始模板 */}
        <div className="sm-beginner-modal-section-label">
          <Sparkles size={13} />
          <span>
            {t('newProject.tplLabel')}
          </span>
          <small>
            {t('newProject.tplOptional')}
          </small>
        </div>
        <div className="sm-beginner-template-grid">
          <TemplateCard
            active={templateId === ''}
            title={t('newProject.blank')}
            desc={t('newProject.blankDesc')}
            nodeCount={0}
            onClick={() => setTemplateId('')}
          />
          {STARTER_TEMPLATES.map((t) => (
            <TemplateCard
              key={t.id}
              active={templateId === t.id}
              title={`${t.emoji} ${t.name}`}
              desc={t.desc}
              nodeCount={t.build().nodes.length}
              onClick={() => setTemplateId(t.id)}
            />
          ))}
        </div>

        {/* 2.5 模板详情预览 */}
        {tpl && preview && (
          <div className="sm-beginner-template-preview">
            <div className="sm-beginner-template-preview-title">
              <span>
                {tpl.emoji} {tpl.name}
              </span>
              <small>
                {t('newProject.nodesEdges', { nodes: preview.nodes.length, edges: preview.edges.length })}
              </small>
            </div>
            <p>
              {tpl.desc}
            </p>
            <div className="sm-beginner-template-tags">
              {preview.nodes.map((n) => (
                <span
                  key={n.id}
                  className="sm-beginner-template-tag"
                  title={n.data.typeId}
                >
                  {n.data.label}
                </span>
              ))}
            </div>
            {agentCount > 0 && (
              <p className="sm-beginner-template-note">
                {t('newProject.agentNote', { count: agentCount })}
              </p>
            )}
          </div>
        )}

        {/* 3. 保存位置（桌面端） */}
        {isTauri && (
          <div className="sm-beginner-modal-location">
            <label className="sm-beginner-modal-label">
              {t('newProject.locationLabel')}
            </label>
            <div className="sm-beginner-modal-location-row">
              <button
                onClick={chooseLocation}
                className="sm-beginner-secondary-button"
              >
                <MapPin size={14} style={{ color: 'var(--sm-accent)' }} />
                {location ? t('newProject.changeLocation') : t('newProject.chooseLocation')}
              </button>
              <span className="sm-beginner-modal-location-value" data-has-value={!!location}>
                {location ? location : t('newProject.locationDefault')}
              </span>
            </div>
          </div>
        )}

        {error && (
          <p className="sm-beginner-modal-error">
            {error}
          </p>
        )}

        {/* 底部操作 */}
        <div className="sm-beginner-modal-footer">
          {tpl && preview && (
            <span className="sm-beginner-modal-footer-note">
              {t('newProject.willLoad', { name: tpl.name, nodes: preview.nodes.length, edges: preview.edges.length })}
            </span>
          )}
          <button
            onClick={onClose}
            className="sm-beginner-secondary-button"
          >
            {t('namePrompt.cancel')}
          </button>
          <button
            onClick={confirm}
            disabled={!nameValid || busy}
            className="sm-beginner-primary-button"
          >
            {busy ? t('newProject.creating') : location ? t('newProject.createDisk') : t('newProject.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateCard({
  active,
  title,
  desc,
  nodeCount,
  onClick,
}: {
  active: boolean;
  title: string;
  desc: string;
  nodeCount: number;
  onClick: () => void;
}) {
  const t = useT('modals');
  return (
    <button
      onClick={onClick}
      className="sm-beginner-template-card"
      style={{
        borderColor: active ? 'var(--sm-beginner-blue)' : undefined,
        background: active ? 'var(--sm-beginner-blue-soft)' : undefined,
      }}
    >
      {active && (
        <span
          className="sm-beginner-template-check"
        >
          <Check size={11} />
        </span>
      )}
      <span className="sm-beginner-template-title">
        {title}
      </span>
      <span className="sm-beginner-template-desc">
        {desc}
      </span>
      <span className="sm-beginner-template-count">
        {nodeCount > 0 ? t('newProject.nodeCount', { count: nodeCount }) : t('newProject.blankWorkflow')}
      </span>
    </button>
  );
}

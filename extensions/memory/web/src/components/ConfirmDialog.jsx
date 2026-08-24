import { useT } from '../lib/i18n';

export default function ConfirmDialog({ open, title, message, onConfirm, onCancel, confirmLabel, cancelLabel, danger }) {
  const { t } = useT();
  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(0,0,0,0.3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        style={{
          background: 'var(--bg)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--elev-deep)',
          padding: 28,
          width: 380,
          maxWidth: '90vw',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700 }}>{title}</h3>
        <p style={{ color: 'var(--muted)', fontSize: 14, margin: '0 0 20px', whiteSpace: 'pre-wrap' }}>
          {message}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel}>{cancelLabel || t('confirm.cancel')}</button>
          <button
            className={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
          >
            {confirmLabel || t('confirm.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}

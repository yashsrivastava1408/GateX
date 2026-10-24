import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { Icon } from './Icons';

/** Asks before something is deleted for good, and says what will go. */
export function ConfirmDelete({
  title,
  children,
  onConfirm,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete it.');
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} className="dialog dialog-narrow" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <div className="dialog-body">
        <h2>{title}</h2>
        <p className="muted">{children}</p>
        {error && <p className="field-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={confirm} disabled={busy}>
            {busy ? <span className="spinner spinner-sm" /> : <Icon name="trash" />} Delete
          </button>
        </div>
      </div>
    </dialog>
  );
}

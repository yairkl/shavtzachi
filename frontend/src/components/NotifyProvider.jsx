import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmContext, bus } from '@/lib/notify';

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info };
const STYLES = {
  success: 'border-green-500/30 bg-green-500/10 text-green-300',
  error: 'border-red-500/30 bg-red-500/10 text-red-300',
  info: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
};

export function NotifyProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  useEffect(() => {
    const handler = (e) => {
      const id = ++idRef.current;
      setToasts((t) => [...t.slice(-3), { id, ...e.detail }]);
      setTimeout(() => dismiss(id), e.detail.type === 'error' ? 7000 : 4000);
    };
    bus.addEventListener('toast', handler);
    return () => bus.removeEventListener('toast', handler);
  }, [dismiss]);

  const confirm = useCallback((opts = {}) => new Promise((resolve) => {
    setDialog({ ...opts, resolve });
  }), []);

  const close = (result) => {
    dialog?.resolve(result);
    setDialog(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}

      <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[100] flex flex-col gap-2 sm:w-96" aria-live="polite">
        {toasts.map((t) => {
          const Icon = ICONS[t.type] || Info;
          return (
            <div key={t.id} role={t.type === 'error' ? 'alert' : 'status'}
                 className={`flex items-start gap-3 rounded-lg border p-3 text-sm shadow-xl backdrop-blur-xl animate-in slide-in-from-bottom-2 ${STYLES[t.type] || STYLES.info}`}>
              <Icon className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="flex-1 break-words">{t.message}</span>
              <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>

      {dialog && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
             onClick={() => close(false)}>
          <div role="alertdialog" aria-modal="true"
               className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl space-y-4"
               onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">{dialog.title || 'Are you sure?'}</h2>
            {dialog.description && <p className="text-sm text-muted-foreground">{dialog.description}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => close(false)}>{dialog.cancelText || 'Cancel'}</Button>
              <Button variant={dialog.destructive ? 'destructive' : 'default'} autoFocus onClick={() => close(true)}>
                {dialog.confirmText || 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

import { createContext, useContext } from 'react';

// Module-level bus so non-React code (services) can raise toasts too.
export const bus = new EventTarget();
const emitToast = (type, message) => bus.dispatchEvent(new CustomEvent('toast', { detail: { type, message } }));

export const notify = {
  success: (m) => emitToast('success', m),
  error: (m) => emitToast('error', m),
  info: (m) => emitToast('info', m),
};

export const ConfirmContext = createContext(() => Promise.resolve(false));

/** const confirm = useConfirm(); if (await confirm({ title, description, confirmText, destructive })) ... */
export const useConfirm = () => useContext(ConfirmContext);

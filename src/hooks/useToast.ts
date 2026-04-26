import { useCallback, useRef, useState } from "react";
import type { ToastMessage } from "../components/Toast";

export function useToast() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastDedupRef = useRef<Map<string, number>>(new Map());

  const addToast = useCallback(
    (type: ToastMessage["type"], message: string, duration?: number, dedupeKey?: string): string => {
      if (dedupeKey) {
        const now = Date.now();
        const last = toastDedupRef.current.get(dedupeKey);
        if (last && now - last < 800) {
          return "";
        }
        toastDedupRef.current.set(dedupeKey, now);
      }
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setToasts((prev) => [...prev, { id, type, message, duration }]);
      return id;
    },
    []
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, removeToast };
}

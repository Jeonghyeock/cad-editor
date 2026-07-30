import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useRef } from "react";

import Icon from "src/components/Icon";

import { removeToastAtom, toastListAtom } from "src/shared/stores/Toast.store";

const TOAST_DURATION = 3000;

const ToastItem = memo(
  ({ id, type, message, persistent }: { id: string; type: string; message: string; persistent?: boolean }) => {
    const removeToast = useSetAtom(removeToastAtom);
    const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

    useEffect(() => {
      // persistent toast 는 자동 제거 안 함 — caller 가 명시적으로 removeToast 또는 사용자가 X 버튼.
      if (persistent) return;
      timerRef.current = setTimeout(() => {
        removeToast(id);
      }, TOAST_DURATION);

      return () => clearTimeout(timerRef.current);
    }, [id, removeToast, persistent]);

    const handleClose = useCallback(() => {
      clearTimeout(timerRef.current);
      removeToast(id);
    }, [id, removeToast]);

    return (
      <div className="toast" data-type={type}>
        <span className="toast__icon">
          {type === "error" && <Icon.Warning width={16} height={16} />}
          {type === "success" && <Icon.Complete width={16} height={16} />}
          {type === "info" && <Icon.Info width={16} height={16} />}
        </span>
        <span className="toast__message">{message}</span>
        <button className="toast__close" onClick={handleClose}>
          <Icon.Close width={14} height={14} />
        </button>
      </div>
    );
  },
);

ToastItem.displayName = "ToastItem";

const Toast = () => {
  const toastList = useAtomValue(toastListAtom);

  if (toastList.length === 0) return null;

  return (
    <div className="toast-container">
      {toastList.map((toast) => (
        <ToastItem
          key={toast.id}
          id={toast.id}
          type={toast.type}
          message={toast.message}
          persistent={toast.persistent}
        />
      ))}
    </div>
  );
};

export default memo(Toast);

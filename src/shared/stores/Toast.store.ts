import { atom } from "jotai";

export type Toast = {
  id: string;
  type: "error" | "success" | "info";
  message: string;
  /**
   * true 면 자동 제거 안 함. 진행 중 상태 표시 (API 호출 중 등) 처럼 응답 도착까지 유지하고
   * caller 가 명시적으로 removeToast 호출. 사용자가 X 버튼으로 닫을 수도 있음.
   */
  persistent?: boolean;
};

export const toastListAtom = atom<Toast[]>([]);

export const addToastAtom = atom(
  null,
  (get, set, toast: Omit<Toast, "id">) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const list = get(toastListAtom);
    set(toastListAtom, [...list.slice(-2), { ...toast, id }]);
    return id;
  },
);

export const removeToastAtom = atom(null, (get, set, id: string) => {
  set(
    toastListAtom,
    get(toastListAtom).filter((t) => t.id !== id),
  );
});

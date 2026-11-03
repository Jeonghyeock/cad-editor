// History-aware atom mutation hook — atom 변경을 globalHistory 의 GlobalCommand 로 wrapping.
// ctrl+z 시 prev 로 복원, ctrl+y 시 next 재적용.

import { type Getter, type WritableAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback } from "react";

import { setupGlobalHistoryAtom } from "../Setup.store";

type Updater<T> = T | ((prev: T) => T);

/**
 * 기존 jotai atom 을 history-aware setter 로 감싸는 hook.
 * 사용 예: timeline scene CRUD, motionTolerance 등 user 의도 변경을 history 에 push.
 *
 * value 는 일반 useAtomValue 와 동일. setter 는 호출 시 GlobalCommand 를 manager 에
 * push — execute / undo / redo 가 atom 의 raw setter 호출.
 *
 * @param atom history-aware 로 만들 atom (writable, updater 지원)
 * @param label history entry 의 표시 라벨 (예: "timelineScenes")
 * @param canApply 있으면 그 값으로 바꿔 놓아도 되는지 — 처음 바꿀 때 false 면 바꾸지 않고(setter 가 false 를 돌려줌),
 *   undo/redo 때 false 면 히스토리가 그 엔트리 앞에서 멈춘다
 *   (예: 참조 평면을 쓰는 스케치·연산이 있으면 그 평면을 지우지도, 생성을 undo 하지도 않는다)
 */
export function useHistoricalAtom<T>(
  atom: WritableAtom<T, [Updater<T>], void>,
  label: string,
  canApply?: (value: T, get: Getter) => boolean,
): [T, (updater: Updater<T>) => boolean] {
  const value = useAtomValue(atom);
  const setRaw = useSetAtom(atom);
  const store = useStore();
  const manager = useAtomValue(setupGlobalHistoryAtom);

  // 반환: 바꿨거나 바꿀 것이 없으면 true, canApply 가 막았으면 false (호출한 쪽이 이유를 알린다)
  const setHistory = useCallback(
    (updater: Updater<T>): boolean => {
      const prev = store.get(atom);
      const next: T =
        typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater;
      if (Object.is(prev, next)) return true;
      const get: Getter = (a) => store.get(a);
      // undo 뒤 redo 와 같은 판정 — 처음 바꿀 때만 통과하면 redo 는 막히는데 첫 변경은 되는 불일치가 생긴다
      if (canApply && !canApply(next, get)) return false;
      manager.executeCommand({
        label,
        execute: () => setRaw(next),
        undo: () => setRaw(prev),
        ...(canApply
          ? { canUndo: () => canApply(prev, get), canRedo: () => canApply(next, get) }
          : {}),
      });
      return true;
    },
    [atom, label, manager, setRaw, store, canApply],
  );

  return [value, setHistory];
}

// History-aware atom mutation hook — atom 변경을 globalHistory 의 GlobalCommand 로 wrapping.
// ctrl+z 시 prev 로 복원, ctrl+y 시 next 재적용.

import { type WritableAtom, useAtomValue, useSetAtom, useStore } from "jotai";
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
 */
export function useHistoricalAtom<T>(
  atom: WritableAtom<T, [Updater<T>], void>,
  label: string,
): [T, (updater: Updater<T>) => void] {
  const value = useAtomValue(atom);
  const setRaw = useSetAtom(atom);
  const store = useStore();
  const manager = useAtomValue(setupGlobalHistoryAtom);

  const setHistory = useCallback(
    (updater: Updater<T>) => {
      const prev = store.get(atom);
      const next: T =
        typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater;
      if (Object.is(prev, next)) return;
      manager.executeCommand({
        label,
        execute: () => setRaw(next),
        undo: () => setRaw(prev),
      });
    },
    [atom, label, manager, setRaw, store],
  );

  return [value, setHistory];
}

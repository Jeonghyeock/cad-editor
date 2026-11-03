// GlobalHistoryManager 인스턴스 라이프사이클 + atom 동기화 훅

import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import type { GlobalCommand } from "../core/GlobalCommand";
import { setupGlobalCanRedoAtom, setupGlobalCanUndoAtom, setupGlobalHistoryAtom, setupUndoFlashIdsAtom } from "../Setup.store";

const FLASH_DURATION = 500; // ms

/**
 * @param onHistoryChange history 변경 시 호출되는 콜백 (push / undo / redo / clear).
 *   imperative sketch 변경을 globalData 로 flush 하는 데 사용 — 매 렌더가 아니라 사용자 의도
 *   단위 (command) 마다 동기화 → isModified 가 라이브 sketch 변경에도 정확히 반응.
 */
export const useGlobalHistory = (onHistoryChange?: () => void) => {
  // file 별 격리 instance — setupAtom storage 의 globalHistory derived. 파일 이동 시 새
  // manager 로 swap 되며 아래 effect 의 deps `[manager, ...]` 가 listener 자동 reattach.
  const manager = useAtomValue(setupGlobalHistoryAtom);

  const setCanUndo = useSetAtom(setupGlobalCanUndoAtom);
  const setCanRedo = useSetAtom(setupGlobalCanRedoAtom);
  const setFlashIds = useSetAtom(setupUndoFlashIdsAtom);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ref 로 보관 — 매 렌더 새 함수로 listener 재등록 방지
  const onChangeRef = useRef(onHistoryChange);
  onChangeRef.current = onHistoryChange;

  // atom 동기화 + history 변경 콜백
  useEffect(() => {
    const unsubscribe = manager.addRenderListener((event) => {
      setCanUndo(manager.canUndo);
      setCanRedo(manager.canRedo);
      // "clear" 는 시스템 reset (파일 전환 시 history.clear() 등) — 사용자 의도가 아니므로
      // flushInputSync (onChange) 트리거 skip. 트리거하면 baked sketch 아직 hydrate 안 된
      // 시점에 빈 sketches 가 globalData 에 적혀 originData 와 불일치 → isModified 오탐.
      // "sketch" (스케치 진입·종료) 도 스택이 바뀐 게 아니라 버튼 상태만 맞추면 되므로 skip.
      if (event === "clear" || event === "sketch") return;
      onChangeRef.current?.();
    });
    return unsubscribe;
  }, [manager, setCanUndo, setCanRedo]);

  // undo/redo 후 기하 플래시 트리거
  const triggerFlash = useCallback((source: "engine" | "geometry" | "model" | null) => {
    if (source !== "geometry") return;
    // 기하 변경 후 모든 기하를 잠시 플래시 (개별 ID 추적 불필요)
    setFlashIds(["__all__"]);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      setFlashIds([]);
      flashTimerRef.current = null;
    }, FLASH_DURATION);
  }, [setFlashIds]);

  const undo = useCallback(() => {
    const source = manager.undo();
    triggerFlash(source);
  }, [manager, triggerFlash]);

  const redo = useCallback(() => {
    const source = manager.redo();
    triggerFlash(source);
  }, [manager, triggerFlash]);

  const executeCommand = useCallback(
    (command: GlobalCommand) => {
      manager.executeCommand(command);
    },
    [manager],
  );

  // 클린업
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  return { manager, undo, redo, executeCommand };
};

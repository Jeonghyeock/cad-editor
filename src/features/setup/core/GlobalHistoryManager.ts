// 글로벌 히스토리 매니저 (CATIA 스타일 통합 Undo/Redo)
// 기하 + 3D 모델 작업을 하나의 히스토리 스택으로 관리
// 기하 커맨드는 직접 보관 — SketchGeometryStore는 히스토리를 갖지 않음

import type { GeometryCommand } from "../sketch/commands/GeometryCommand";
import type { SketchGeometryStore } from "../sketch/SketchGeometryStore";

import type { GlobalCommand } from "./GlobalCommand";

type GlobalEntry =
  | { source: "geometry"; command: GeometryCommand }
  | { source: "model"; command: GlobalCommand };

/**
 * Listener event 종류. caller 는 종류별로 다른 처리 가능 — 예) "clear" 는 시스템 reset
 * (파일 전환 등) 이지 사용자 의도가 아니므로 flushInputSync 같은 sync 트리거는 skip.
 */
export type HistoryEvent = "push" | "undo" | "redo" | "clear";

export class GlobalHistoryManager {
  private _stack: GlobalEntry[] = [];
  private _index = -1;
  private _renderListeners = new Set<(event: HistoryEvent) => void>();

  private _geometryStore: SketchGeometryStore | null = null;

  // --- 서브시스템 등록 ---

  setGeometryStore(store: SketchGeometryStore | null): void {
    this._geometryStore = store;
  }

  // --- 기하 커맨드 직접 실행 (execute 호출 포함) ---

  executeGeometryCommand(command: GeometryCommand, store: SketchGeometryStore): void {
    if (command.isEmpty?.()) return;
    this._truncateFuture();
    command.execute(store);
    store.solveConstraints();
    store.recomputeFaces();
    store.markGeometryChanged();
    store.requestRender();
    this._stack.push({ source: "geometry", command });
    this._index++;
    this._notifyListeners("push");
  }

  // --- 기하 스냅샷 push (execute 호출 안 함 — 드래그 완료 시 현재 상태가 이미 최종) ---

  pushGeometrySnapshot(command: GeometryCommand, store: SketchGeometryStore): void {
    if (command.isEmpty?.()) return;
    this._truncateFuture();
    store.recomputeFaces();
    store.markGeometryChanged();
    store.requestRender();
    this._stack.push({ source: "geometry", command });
    this._index++;
    this._notifyListeners("push");
  }

  // --- 3D 모델 작업용 직접 커맨드 실행 ---

  executeCommand(command: GlobalCommand): void {
    this._truncateFuture();
    command.execute();
    this._stack.push({ source: "model", command });
    this._index++;
    this._notifyListeners("push");
  }

  /**
   * execute 호출 없이 command 를 history 에 push. drag end 등 이미 적용된 상태의
   * snapshot 만 등록해 undo/redo 가능하게 할 때 사용 (pushGeometrySnapshot 의 GlobalCommand
   * 대응). redo 시는 정상 execute 호출.
   */
  pushModelSnapshot(command: GlobalCommand): void {
    this._truncateFuture();
    this._stack.push({ source: "model", command });
    this._index++;
    this._notifyListeners("push");
  }

  // --- Undo / Redo ---

  /** Undo — 엔트리 소스 반환 ("geometry" | "model", 빈 스택이면 null) */
  undo(): "geometry" | "model" | null {
    if (this._index < 0) return null;
    const entry = this._stack[this._index];
    try {
      if (entry.source === "geometry") {
        const store = this._geometryStore;
        if (store) {
          entry.command.undo(store);
          store.solveConstraints();
          // 방어적 고아 구속 정리: undo 후 삭제된 기하를 참조하는 구속 제거
          // 주의: 이 정리는 히스토리에 기록되지 않으므로 redo 시 복원 불가.
          // RemoveGeometryCommand가 관련 구속을 함께 삭제하면 실제로 orphan이 발생하지 않음.
          store.cleanOrphanConstraints();
          store.recomputeFaces();
          store.markGeometryChanged();
          store.requestRender();
        }
      } else {
        entry.command.undo();
      }
    } finally {
      this._index--;
      this._notifyListeners("undo");
    }
    return entry.source;
  }

  /** Redo — 엔트리 소스 반환 */
  redo(): "geometry" | "model" | null {
    if (this._index >= this._stack.length - 1) return null;
    const entry = this._stack[this._index + 1];
    try {
      if (entry.source === "geometry") {
        const store = this._geometryStore;
        if (store) {
          entry.command.execute(store);
          store.solveConstraints();
          store.recomputeFaces();
          store.markGeometryChanged();
          store.requestRender();
        }
      } else {
        entry.command.execute();
      }
    } finally {
      this._index++;
      this._notifyListeners("redo");
    }
    return entry.source;
  }

  get canUndo(): boolean {
    return this._index >= 0;
  }

  get canRedo(): boolean {
    return this._index < this._stack.length - 1;
  }

  // --- 렌더 리스너 (atom 동기화용) ---

  addRenderListener(callback: (event: HistoryEvent) => void): () => void {
    this._renderListeners.add(callback);
    return () => {
      this._renderListeners.delete(callback);
    };
  }

  // --- 서브시스템 연결 해제 ---

  clearSubSystems(): void {
    this._geometryStore = null;
  }

  // --- 히스토리 초기화 ---

  clear(): void {
    this._stack = [];
    this._index = -1;
    this._notifyListeners("clear");
  }

  // --- 내부 ---

  private _truncateFuture(): void {
    if (this._index < this._stack.length - 1) {
      this._stack = this._stack.slice(0, this._index + 1);
    }
  }

  private _notifyListeners(event: HistoryEvent): void {
    for (const cb of this._renderListeners) cb(event);
  }
}

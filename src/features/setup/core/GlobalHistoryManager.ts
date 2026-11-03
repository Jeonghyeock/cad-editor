// 글로벌 히스토리 매니저 (CATIA 스타일 통합 Undo/Redo)
// 기하 + 3D 모델 작업을 하나의 히스토리 스택으로 관리
// 기하 커맨드는 직접 보관 — SketchGeometryStore는 히스토리를 갖지 않음

import type { SerializedGeometry } from "../Setup.type";
import type { GeometryCommand } from "../sketch/commands/GeometryCommand";
import type { SketchGeometryStore } from "../sketch/SketchGeometryStore";

import type { GlobalCommand } from "./GlobalCommand";

type GeometrySnapshot = Map<string, SerializedGeometry>;

type GlobalEntry =
  | {
      source: "geometry";
      command: GeometryCommand;
      /** 실행 직전 좌표 — undo 때 되돌린다. 드래그처럼 이미 바뀐 뒤 push 한 엔트리는 없다(명령이 직접 들고 있다). */
      before?: GeometrySnapshot;
      /** 실행·솔브 직후 좌표 — redo 때 되돌린다. */
      after: GeometrySnapshot;
    }
  | { source: "model"; command: GlobalCommand };

// 솔버는 기하 객체의 좌표를 제자리에서 고친다. 구속 명령의 undo/redo 는 구속만 넣고 빼므로, 좌표를 따로 남겨 두지
// 않으면 솔버가 옮긴 좌표가 undo 뒤에도 그대로 남고, 명령이 들고 있던 객체까지 고쳐져 redo 결과가 달라진다.
// 그래서 저장할 때도 되돌릴 때도 복제본을 쓴다(되돌린 객체를 다음 솔브가 고쳐도 스냅샷은 그대로).
function snapshotGeometries(store: SketchGeometryStore): GeometrySnapshot {
  const snapshot: GeometrySnapshot = new Map();
  for (const [id, geom] of store.geometries) snapshot.set(id, structuredClone(geom));
  return snapshot;
}

// 좌표만 스냅샷 시점으로 되돌린다. 기하를 넣고 빼는 일은 명령의 undo/execute 가 맡으므로, 지금 store 에 있는 기하만 바꾼다.
function restoreGeometries(store: SketchGeometryStore, snapshot: GeometrySnapshot): void {
  for (const id of store.geometries.keys()) {
    const geom = snapshot.get(id);
    if (geom) store.geometries.set(id, structuredClone(geom));
  }
}

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
    this.tryExecuteGeometryCommand(command, store, () => true);
  }

  /**
   * 명령을 실행·솔브해 본 뒤 accept 가 받아들일 때만 히스토리에 넣는다. 거부하면 명령을 되돌리고 좌표도 실행
   * 전으로 돌리며 스택은 건드리지 않는다 — 실행 후 undo 하는 방식은 redo 이력을 잘라 버리고, 거부된 명령을
   * redo 자리에 남겨 Ctrl+Y 로 검증 없이 들어가게 했다. 반환: 받아들였는지 여부.
   */
  tryExecuteGeometryCommand(
    command: GeometryCommand,
    store: SketchGeometryStore,
    accept: (store: SketchGeometryStore) => boolean,
  ): boolean {
    if (command.isEmpty?.()) return true;
    const before = snapshotGeometries(store);
    command.execute(store);
    store.solveConstraints();
    if (!accept(store)) {
      command.undo(store);
      restoreGeometries(store, before);
      store.solveConstraints();
      store.recomputeFaces();
      store.markGeometryChanged();
      store.requestRender();
      return false;
    }
    this._truncateFuture();
    const after = snapshotGeometries(store);
    store.recomputeFaces();
    store.markGeometryChanged();
    store.requestRender();
    this._stack.push({ source: "geometry", command, before, after });
    this._index++;
    this._notifyListeners("push");
    return true;
  }

  // --- 기하 스냅샷 push (execute 호출 안 함 — 드래그 완료 시 현재 상태가 이미 최종) ---

  pushGeometrySnapshot(command: GeometryCommand, store: SketchGeometryStore): void {
    if (command.isEmpty?.()) return;
    this._truncateFuture();
    // 실행 전 좌표는 이미 지나갔다(명령이 직접 들고 있음). redo 때 쓸 지금 좌표만 남긴다.
    const after = snapshotGeometries(store);
    store.recomputeFaces();
    store.markGeometryChanged();
    store.requestRender();
    this._stack.push({ source: "geometry", command, after });
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
          if (entry.before) restoreGeometries(store, entry.before);
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
          restoreGeometries(store, entry.after);
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

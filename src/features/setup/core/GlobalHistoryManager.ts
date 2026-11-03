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
      /** 명령을 실행한 스케치 (`planeKey#세대`). 이 스케치가 열려 있을 때만 undo/redo 한다 (열린 스케치가 없으면 기록하지 않음). */
      sketchKey: string;
      /** 실행 직전 좌표 — undo 때 되돌린다. 드래그처럼 이미 바뀐 뒤 push 한 엔트리는 없다(명령이 직접 들고 있다). */
      before?: GeometrySnapshot;
      /** 실행·솔브 직후 좌표 — redo 때 되돌린다. 스냅샷을 직접 들고 있는 커맨드(ownsSnapshot)는 없다. */
      after?: GeometrySnapshot;
    }
  | {
      source: "model";
      command: GlobalCommand;
      /** sketchScoped 커맨드만 — 실행한 스케치. 기하 엔트리처럼 이 스케치가 열려 있을 때만 undo/redo 한다. */
      sketchKey?: string;
    };

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
 * 기하 명령을 실행·솔브하고 accept 로 받아들일지 정한다 (히스토리 기록은 하지 않음). 거부하면 명령을 되돌리고 좌표도
 * 실행 전으로 돌린다. 반환: 받아들였으면 실행 전·후 좌표 스냅샷, 거부했으면 null.
 */
export function applyGeometryCommand(
  command: GeometryCommand,
  store: SketchGeometryStore,
  accept: (store: SketchGeometryStore) => boolean,
): { before?: GeometrySnapshot; after?: GeometrySnapshot } | null {
  // 스냅샷을 직접 들고 있는 커맨드(ownsSnapshot)는 undo 가 store 를 통째로 되돌리므로 따로 만들지 않는다
  const own = command.ownsSnapshot === true;
  const before = own ? undefined : snapshotGeometries(store);
  command.execute(store);
  store.solveConstraints();
  if (!accept(store)) {
    command.undo(store);
    if (before) restoreGeometries(store, before);
    store.solveConstraints();
    store.recomputeFaces();
    store.markGeometryChanged();
    store.requestRender();
    return null;
  }
  const after = own ? undefined : snapshotGeometries(store);
  store.recomputeFaces();
  store.markGeometryChanged();
  store.requestRender();
  return { before, after };
}

/**
 * Listener event 종류. caller 는 종류별로 다른 처리 가능 — 예) "clear" 는 시스템 reset
 * (파일 전환 등) 이지 사용자 의도가 아니므로 flushInputSync 같은 sync 트리거는 skip.
 * "sketch" 는 스케치 진입·종료 — 스택은 그대로지만 canUndo/canRedo 가 바뀔 수 있다 (역시 sync 트리거는 skip).
 */
export type HistoryEvent = "push" | "undo" | "redo" | "clear" | "sketch";

export class GlobalHistoryManager {
  private _stack: GlobalEntry[] = [];
  private _index = -1;
  private _renderListeners = new Set<(event: HistoryEvent) => void>();

  private _geometryStore: SketchGeometryStore | null = null;
  // 지금 열린 스케치 (`planeKey#세대`, 3D 모드면 null). 기하 store 는 열린 스케치 하나의 기하만 담는다.
  private _activeSketchKey: string | null = null;
  // 평면마다 스케치를 지운 횟수 — planeKey 만으로는 같은 평면에서 지우고 새로 만든 스케치를 같은 스케치로 본다(지운
  // 스케치의 드래그 엔트리가 새 스케치를 지웠다). 스케치 키를 `planeKey#세대` 로 써서 둘을 가른다. 세대는 메모리에만
  // 둔다 — 파일을 다시 열면 히스토리도 새로 시작한다.
  private _sketchGenerations = new Map<string, number>();

  // --- 서브시스템 등록 ---

  setGeometryStore(store: SketchGeometryStore | null): void {
    this._geometryStore = store;
  }

  /**
   * 스케치 진입·종료 때 부른다 (enterSketchModeAtom / exitSketchModeAtom). 빈 키는 열린 스케치가 없는 것으로 본다.
   * 열린 스케치는 진입할 때의 세대로 정한다 — 열어 둔 채 그 스케치를 지워도 지금 store 의 엔트리는 그대로 이어진다.
   */
  setActiveSketch(planeKey: string | null): void {
    this._activeSketchKey = planeKey ? `${planeKey}#${this._sketchGenerations.get(planeKey) ?? 0}` : null;
    // 스택은 그대로지만 막힌 엔트리가 바뀌어 canUndo/canRedo 가 달라질 수 있다
    this._notifyListeners("sketch");
  }

  /** 스케치를 지울 때 (DeleteSketchCommand.execute) — 이 평면에 새로 여는 스케치는 다른 스케치로 본다. */
  retireSketch(planeKey: string): void {
    this._sketchGenerations.set(planeKey, (this._sketchGenerations.get(planeKey) ?? 0) + 1);
  }

  /** 스케치 삭제를 undo 할 때 (DeleteSketchCommand.undo) — 지웠던 스케치가 돌아오므로, 다시 열면 그 엔트리를 적용한다. */
  reviveSketch(planeKey: string): void {
    this._sketchGenerations.set(planeKey, Math.max(0, (this._sketchGenerations.get(planeKey) ?? 0) - 1));
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
    const applied = applyGeometryCommand(command, store, accept);
    if (!applied) return false;
    // 열린 스케치가 없으면(3D 모드 등) 기록하지 않는다 — 그 엔트리를 적용할 스케치가 없어, 기록하면 그 자리에서
    // 이력이 영영 막히거나 엉뚱한 상태에 적용된다.
    if (!this._activeSketchKey) return true;
    this._truncateFuture();
    this._stack.push({ source: "geometry", command, sketchKey: this._activeSketchKey, ...applied });
    this._index++;
    this._notifyListeners("push");
    return true;
  }

  // --- 기하 스냅샷 push (execute 호출 안 함 — 드래그 완료 시 현재 상태가 이미 최종) ---

  pushGeometrySnapshot(command: GeometryCommand, store: SketchGeometryStore): void {
    if (command.isEmpty?.()) return;
    // 실행 전 좌표는 이미 지나갔다(명령이 직접 들고 있음). redo 때 쓸 지금 좌표만 남긴다 — 전·후를 모두 들고 있는
    // 커맨드(ownsSnapshot)면 그것도 만들지 않는다.
    const after = command.ownsSnapshot ? undefined : snapshotGeometries(store);
    store.recomputeFaces();
    store.markGeometryChanged();
    store.requestRender();
    if (!this._activeSketchKey) return; // 열린 스케치가 없으면 기록하지 않음 (tryExecuteGeometryCommand 와 같은 이유)
    this._truncateFuture();
    this._stack.push({ source: "geometry", command, sketchKey: this._activeSketchKey, after });
    this._index++;
    this._notifyListeners("push");
  }

  // --- 3D 모델 작업용 직접 커맨드 실행 ---

  executeCommand(command: GlobalCommand): void {
    // 스케치 store 를 직접 바꾸는 커맨드(sketchScoped)는 기하 엔트리처럼 열린 스케치에 묶고, 열린 스케치가 없으면
    // 기록하지 않는다 (tryExecuteGeometryCommand 와 같은 이유).
    if (command.sketchScoped && !this._activeSketchKey) {
      command.execute();
      return;
    }
    this._truncateFuture();
    command.execute();
    this._stack.push(
      command.sketchScoped && this._activeSketchKey
        ? { source: "model", command, sketchKey: this._activeSketchKey }
        : { source: "model", command },
    );
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
  //
  // 스케치 경계 정책: 기하 엔트리는 그 명령을 실행한 스케치에만 적용한다. 지금 열린 스케치가 다르면(다른 스케치나
  // 3D 모드) 그 엔트리 앞에서 undo/redo 를 멈추고 null 을 돌려준다 — 인덱스도 상태도 바꾸지 않는다.
  // - 그대로 적용하면 다른 평면의 기하가 지금 스케치에 들어가 저장되고, DragSnapshotCommand 는 지금 스케치를 통째로 지운다.
  // - 건너뛰면 인덱스 아래에 적용된 엔트리와 되돌린 엔트리가 섞여, 나중에 그 스케치에서 redo 할 때 순서가 어긋난다.
  // 그 스케치를 다시 열면 멈춘 자리부터 이어서 undo/redo 한다(자동으로 스케치를 다시 열지는 않는다).
  // 열린 스케치가 없을 때(키 null·"") 실행한 기하 명령은 기록하지 않는다 — 적용할 스케치가 없는 엔트리를 만들지 않는다.
  // 막힌 동안 canUndo/canRedo 는 false 이고, 스케치를 열고 닫을 때 "sketch" 이벤트로 툴바 상태를 다시 맞춘다.

  /** 기하 엔트리가 지금 열린 스케치의 것이 아니면 true */
  private _isOtherSketch(entry: GlobalEntry): boolean {
    // 스케치에 묶인 엔트리 = 기하 엔트리 + 스케치 store 를 직접 바꾸는 모델 커맨드(sketchScoped)
    const scoped = entry.source === "geometry" || entry.command.sketchScoped === true;
    // 키가 비어 있는 엔트리는 어떤 상태와도 같은 스케치로 보지 않는다 (3D 모드의 null 과도 맞추지 않음).
    return scoped && (!entry.sketchKey || entry.sketchKey !== this._activeSketchKey);
  }

  /** 이 엔트리 앞에서 멈춰야 하면 true — 다른 스케치의 기하 엔트리, 또는 지금은 안 된다고 하는 모델 커맨드 */
  private _isBlocked(entry: GlobalEntry, direction: "undo" | "redo"): boolean {
    if (this._isOtherSketch(entry)) return true;
    if (entry.source !== "model") return false;
    const allowed = direction === "undo" ? entry.command.canUndo?.() : entry.command.canRedo?.();
    return allowed === false;
  }

  /** Undo — 엔트리 소스 반환 ("geometry" | "model", 빈 스택이거나 막힌 엔트리(_isBlocked)에서 멈추면 null) */
  undo(): "geometry" | "model" | null {
    if (this._index < 0) return null;
    const entry = this._stack[this._index];
    if (this._isBlocked(entry, "undo")) return null;
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

  /** Redo — 엔트리 소스 반환 (막힌 엔트리에서 멈추면 null) */
  redo(): "geometry" | "model" | null {
    if (this._index >= this._stack.length - 1) return null;
    const entry = this._stack[this._index + 1];
    if (this._isBlocked(entry, "redo")) return null;
    try {
      if (entry.source === "geometry") {
        const store = this._geometryStore;
        if (store) {
          entry.command.execute(store);
          if (entry.after) restoreGeometries(store, entry.after);
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

  // 막힌 엔트리 앞이면 false — 툴바 버튼이 켜진 채 눌러도 아무 일이 없지 않게.
  get canUndo(): boolean {
    return this._index >= 0 && !this._isBlocked(this._stack[this._index], "undo");
  }

  get canRedo(): boolean {
    return this._index < this._stack.length - 1 && !this._isBlocked(this._stack[this._index + 1], "redo");
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

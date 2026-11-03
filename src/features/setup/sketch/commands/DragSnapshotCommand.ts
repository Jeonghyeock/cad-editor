// 드래그 스냅샷 커맨드 — 드래그 전/후 전체 기하 좌표를 저장하여 정확한 undo/redo
// Map 전체를 교체하여 누락/잔여 기하 문제 방지

import type { SerializedGeometry } from "../../Setup.type";

import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

/**
 * drag 와 함께 발생하는 외부 side effect (예: EE drag → timelineScenes targetMotion 갱신).
 * sideEffect.undo/redo 는 SketchGeometryStore 외부 atom 등에 대한 prev/next 복원 호출.
 * geometry 변경과 atomic 하게 묶여 ctrl+z 한 번에 함께 되돌아감.
 */
export type DragSideEffect = {
  undo: () => void;
  redo: () => void;
};

export class DragSnapshotCommand implements GeometryCommand {
  // 전·후 스냅샷을 직접 들고 있으므로 히스토리 쪽 좌표 스냅샷은 필요 없다
  readonly ownsSnapshot = true;

  constructor(
    private _before: Map<string, SerializedGeometry>,
    private _after: Map<string, SerializedGeometry>,
    private _sideEffect?: DragSideEffect,
  ) {}

  // store 에는 사본을 넣는다 — 솔버는 기하 좌표를 제자리에서 고치므로, 스냅샷 객체를 그대로 넣으면 이어지는
  // 솔브가 스냅샷까지 바꿔 다음 undo/redo 결과가 달라진다.
  execute(store: SketchGeometryStore): void {
    store.geometries.clear();
    for (const [id, geom] of this._after) {
      store.geometries.set(id, structuredClone(geom));
    }
    this._sideEffect?.redo();
  }

  undo(store: SketchGeometryStore): void {
    store.geometries.clear();
    for (const [id, geom] of this._before) {
      store.geometries.set(id, structuredClone(geom));
    }
    this._sideEffect?.undo();
  }
}

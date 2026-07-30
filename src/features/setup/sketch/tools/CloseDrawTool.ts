// Close (닫기) 도구: 호(arc) 선택 → 닫힌 원(circle)으로 변환
// 클릭 즉시 실행 — CompoundSketchCommand로 arc 제거 + circle 추가 + 구속 재매핑

import type { SketchDrawToolType } from "../../Setup.type";

import { CompoundSketchCommand } from "../commands/CompoundSketchCommand";
import type { GeomRemap, VertexRemap } from "../commands/CompoundSketchCommand";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import { DrawTool } from "./DrawTool";

export class CloseDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "close";


  selectionOnly = true;
  onPointerDown(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    const hitRadius = this.inferenceRadius || 5;
    const hitId = store.hitTest(rawPos, hitRadius);
    if (!hitId) return;

    const geom = store.geometries.get(hitId);
    if (!geom) return;
    if (geom.type !== "arc") return;
    if (geom.isReference) return;

    // arc → circle 변환
    const circleId = this._generateId();
    const newCircle = {
      type: "circle" as const,
      id: circleId,
      cx: geom.cx,
      cy: geom.cy,
      r: geom.r,
      isConstruction: geom.isConstruction,
    };

    // vertex 재매핑: arc vertex 0 (center) → circle vertex 0 (center)
    // arc vertex 1 (start), 2 (end)는 circle에 매핑 불가 → cascade 삭제
    const vertexRemaps: VertexRemap[] = [
      { oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: circleId, newVertexIndex: 0 },
    ];

    const geomRemaps: GeomRemap[] = [
      { oldGeomId: geom.id, newGeomId: circleId },
    ];

    store.execute(new CompoundSketchCommand(
      [geom], [newCircle], [], [], vertexRemaps, geomRemaps,
    ));
    store.requestRender();
  }

  onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    // 호버 시 닫힌 원 프리뷰
    const hitRadius = this.inferenceRadius || 5;
    const hitId = store.hitTest(rawPos, hitRadius);

    if (!hitId) {
      this.preview = null;
      store.requestRender();
      return;
    }

    const geom = store.geometries.get(hitId);
    if (!geom || geom.type !== "arc" || geom.isReference) {
      this.preview = null;
      store.requestRender();
      return;
    }

    // 원 프리뷰
    this.preview = {
      type: "circle",
      id: "__close_preview__",
      cx: geom.cx,
      cy: geom.cy,
      r: geom.r,
    };
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // pointerDown에서 처리
  }

  hasPendingWork(): boolean {
    return false;
  }

  cancel(): void {
    super.cancel();
  }
}

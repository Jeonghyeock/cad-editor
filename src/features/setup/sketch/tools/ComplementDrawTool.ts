// Complement (보각) 도구: 호(arc) 선택 → 반대쪽 호로 변환
// startAngle ↔ endAngle 교환으로 보각 호 생성
// 클릭 즉시 실행 — CompoundSketchCommand로 원본 arc 교체

import type { SketchDrawToolType } from "../../Setup.type";

import { CompoundSketchCommand } from "../commands/CompoundSketchCommand";
import type { GeomRemap, VertexRemap } from "../commands/CompoundSketchCommand";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import { DrawTool } from "./DrawTool";

export class ComplementDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "complement";


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

    // 보각 호: startAngle ↔ endAngle 교환
    const complementId = this._generateId();
    const newArc = {
      type: "arc" as const,
      id: complementId,
      cx: geom.cx,
      cy: geom.cy,
      r: geom.r,
      startAngle: geom.endAngle,
      endAngle: geom.startAngle,
      isConstruction: geom.isConstruction,
    };

    // vertex 재매핑: center(0) 유지, start(1)↔end(2) 교환
    const vertexRemaps: VertexRemap[] = [
      { oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: complementId, newVertexIndex: 0 },
      { oldGeomId: geom.id, oldVertexIndex: 1, newGeomId: complementId, newVertexIndex: 2 },
      { oldGeomId: geom.id, oldVertexIndex: 2, newGeomId: complementId, newVertexIndex: 1 },
    ];

    const geomRemaps: GeomRemap[] = [
      { oldGeomId: geom.id, newGeomId: complementId },
    ];

    store.execute(new CompoundSketchCommand(
      [geom], [newArc], [], [], vertexRemaps, geomRemaps,
    ));
    store.requestRender();
  }

  onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    // 호버 시 보각 호 프리뷰
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

    // 보각 호 프리뷰
    this.preview = {
      type: "arc",
      id: "__complement_preview__",
      cx: geom.cx,
      cy: geom.cy,
      r: geom.r,
      startAngle: geom.endAngle,
      endAngle: geom.startAngle,
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

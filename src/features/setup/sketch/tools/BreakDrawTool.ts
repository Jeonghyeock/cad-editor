// Break (분할) 도구: 기하를 클릭 위치에서 2조각으로 분할
// Trim과 유사하지만 삭제가 아닌 분할 — CompoundSketchCommand로 원본 제거 + 2조각 추가 + 구속 재매핑

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";
import { generateConstraintId } from "../../utils/idGenerator";
import { normalizeAngle } from "../../utils/mathUtils";

import { CompoundSketchCommand } from "../commands/CompoundSketchCommand";
import type { GeomRemap, VertexRemap } from "../commands/CompoundSketchCommand";
import type { SketchConstraint } from "../constraints/SketchConstraint.type";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import { DrawTool } from "./DrawTool";

export class BreakDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "break";


  selectionOnly = true;
  // 분할 프리뷰: 분할점 위치 표시
  breakPreview: SerializedGeometry | null = null;

  private _hoveredGeomId: string | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    if (!this._hoveredGeomId) return;

    const geom = store.geometries.get(this._hoveredGeomId);
    if (!geom) return;
    if ("isReference" in geom && geom.isReference) return;
    if ("isConstruction" in geom && geom.isConstruction) return;

    if (geom.type === "line") {
      this._breakLine(store, geom, rawPos);
    } else if (geom.type === "arc") {
      this._breakArc(store, geom, rawPos);
    } else if (geom.type === "circle") {
      this._breakCircle(store, geom, rawPos);
    }

    this.breakPreview = null;
    this._hoveredGeomId = null;
    store.hoveredItem = null;
    store.requestRender();
  }

  onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    const hitRadius = this.inferenceRadius || 5;
    const hitId = store.hitTest(rawPos, hitRadius);

    this.breakPreview = null;
    this._hoveredGeomId = null;
    store.hoveredItem = null;

    if (!hitId) {
      store.requestRender();
      return;
    }

    const geom = store.geometries.get(hitId);
    if (!geom) { store.requestRender(); return; }
    if ("isReference" in geom && geom.isReference) { store.requestRender(); return; }
    if ("isConstruction" in geom && geom.isConstruction) { store.requestRender(); return; }

    // line, arc, circle만 분할 가능
    if (geom.type !== "line" && geom.type !== "arc" && geom.type !== "circle") {
      store.requestRender();
      return;
    }

    this._hoveredGeomId = hitId;
    store.hoveredItem = { kind: "geometry", geomId: hitId };

    // 분할점 프리뷰 (point 표시)
    if (geom.type === "line") {
      const t = this._projectPointToLine(rawPos, geom);
      const px = geom.x1 + t * (geom.x2 - geom.x1);
      const py = geom.y1 + t * (geom.y2 - geom.y1);
      this.breakPreview = { type: "point", id: "__break_preview__", x: px, y: py };
    } else if (geom.type === "arc" || geom.type === "circle") {
      const cx = geom.cx, cy = geom.cy, r = geom.r;
      const angle = Math.atan2(rawPos.y - cy, rawPos.x - cx);
      this.breakPreview = {
        type: "point",
        id: "__break_preview__",
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
      };
    }

    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // break는 pointerDown에서 처리
  }

  cancel(): void {
    super.cancel();
    this.breakPreview = null;
    this._hoveredGeomId = null;
  }

  // --- Line 분할 ---

  private _breakLine(
    store: SketchGeometryStore,
    geom: SerializedGeometry & { type: "line" },
    rawPos: { x: number; y: number },
  ): void {
    const t = this._projectPointToLine(rawPos, geom);
    // 끝점에 너무 가까우면 무시
    if (t < 0.01 || t > 0.99) return;

    const dx = geom.x2 - geom.x1, dy = geom.y2 - geom.y1;
    const midX = geom.x1 + t * dx;
    const midY = geom.y1 + t * dy;

    const id1 = this._generateId();
    const id2 = this._generateId();

    const newGeoms: SerializedGeometry[] = [
      { type: "line", id: id1, x1: geom.x1, y1: geom.y1, x2: midX, y2: midY },
      { type: "line", id: id2, x1: midX, y1: midY, x2: geom.x2, y2: geom.y2 },
    ];

    const vertexRemaps: VertexRemap[] = [
      // 원본 시작점 → 첫 번째 line 시작점
      { oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: id1, newVertexIndex: 0 },
      // 원본 끝점 → 두 번째 line 끝점
      { oldGeomId: geom.id, oldVertexIndex: 1, newGeomId: id2, newVertexIndex: 1 },
    ];

    const geomRemaps: GeomRemap[] = [
      { oldGeomId: geom.id, newGeomId: id1 },
    ];

    // 분할점에 coincident 구속 (두 조각이 연결되었음을 보장)
    const addedConstraints: SketchConstraint[] = [{
      type: "coincident",
      id: generateConstraintId("auto-cst-break"),
      pointA: { geomId: id1, vertexIndex: 1 },
      pointB: { geomId: id2, vertexIndex: 0 },
    }];

    store.execute(new CompoundSketchCommand([geom], newGeoms, [], addedConstraints, vertexRemaps, geomRemaps));
  }

  // --- Arc 분할 ---

  private _breakArc(
    store: SketchGeometryStore,
    geom: SerializedGeometry & { type: "arc" },
    rawPos: { x: number; y: number },
  ): void {
    const clickAngle = Math.atan2(rawPos.y - geom.cy, rawPos.x - geom.cx);
    const t = this._arcParameterize(clickAngle, geom.startAngle, geom.endAngle);
    if (t < 0.01 || t > 0.99) return;

    const midAngle = this._arcAngleAt(t, geom.startAngle, geom.endAngle);

    const id1 = this._generateId();
    const id2 = this._generateId();

    const newGeoms: SerializedGeometry[] = [
      { type: "arc", id: id1, cx: geom.cx, cy: geom.cy, r: geom.r, startAngle: geom.startAngle, endAngle: midAngle },
      { type: "arc", id: id2, cx: geom.cx, cy: geom.cy, r: geom.r, startAngle: midAngle, endAngle: geom.endAngle },
    ];

    const vertexRemaps: VertexRemap[] = [
      // arc vertex: 0=center, 1=start, 2=end
      { oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: id1, newVertexIndex: 0 },
      { oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: id2, newVertexIndex: 0 }, // arc2 center도 매핑
      { oldGeomId: geom.id, oldVertexIndex: 1, newGeomId: id1, newVertexIndex: 1 },
      { oldGeomId: geom.id, oldVertexIndex: 2, newGeomId: id2, newVertexIndex: 2 },
    ];

    const geomRemaps: GeomRemap[] = [
      { oldGeomId: geom.id, newGeomId: id1 },
    ];

    const arcCst: SketchConstraint[] = [{
      type: "coincident",
      id: generateConstraintId("auto-cst-break"),
      pointA: { geomId: id1, vertexIndex: 2 },
      pointB: { geomId: id2, vertexIndex: 1 },
    }];

    store.execute(new CompoundSketchCommand([geom], newGeoms, [], arcCst, vertexRemaps, geomRemaps));
  }

  // --- Circle 분할 ---

  private _breakCircle(
    store: SketchGeometryStore,
    geom: SerializedGeometry & { type: "circle" },
    rawPos: { x: number; y: number },
  ): void {
    const clickAngle = normalizeAngle(Math.atan2(rawPos.y - geom.cy, rawPos.x - geom.cx));
    // 클릭 위치에서 분할 → 정반대편과 합쳐 2개 arc 생성
    const oppositeAngle = normalizeAngle(clickAngle + Math.PI);

    const id1 = this._generateId();
    const id2 = this._generateId();

    const newGeoms: SerializedGeometry[] = [
      { type: "arc", id: id1, cx: geom.cx, cy: geom.cy, r: geom.r, startAngle: clickAngle, endAngle: oppositeAngle },
      { type: "arc", id: id2, cx: geom.cx, cy: geom.cy, r: geom.r, startAngle: oppositeAngle, endAngle: clickAngle },
    ];

    const vertexRemaps: VertexRemap[] = [
      // circle vertex 0 (center) → arc1 vertex 0 (center)
      { oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: id1, newVertexIndex: 0 },
    ];

    const geomRemaps: GeomRemap[] = [
      { oldGeomId: geom.id, newGeomId: id1 },
    ];

    // 분할점에 coincident 구속 (2개: 클릭점, 정반대편)
    const circleCst: SketchConstraint[] = [
      { type: "coincident", id: generateConstraintId("auto-cst-break"),
        pointA: { geomId: id1, vertexIndex: 2 }, pointB: { geomId: id2, vertexIndex: 1 } },
      { type: "coincident", id: generateConstraintId("auto-cst-break"),
        pointA: { geomId: id2, vertexIndex: 2 }, pointB: { geomId: id1, vertexIndex: 1 } },
    ];

    store.execute(new CompoundSketchCommand([geom], newGeoms, [], circleCst, vertexRemaps, geomRemaps));
  }

  // --- 유틸리티 ---

  private _projectPointToLine(
    p: { x: number; y: number },
    line: { x1: number; y1: number; x2: number; y2: number },
  ): number {
    const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-12) return 0;
    return Math.max(0, Math.min(1, ((p.x - line.x1) * dx + (p.y - line.y1) * dy) / lenSq));
  }

  private _arcAngleAt(t: number, startAngle: number, endAngle: number): number {
    const s = normalizeAngle(startAngle);
    const e = normalizeAngle(endAngle);
    const span = s <= e ? e - s : (Math.PI * 2 - s + e);
    return normalizeAngle(s + t * span);
  }

  private _arcParameterize(angle: number, startAngle: number, endAngle: number): number {
    const s = normalizeAngle(startAngle);
    const e = normalizeAngle(endAngle);
    const a = normalizeAngle(angle);
    const span = s <= e ? e - s : (Math.PI * 2 - s + e);
    let delta = a - s;
    if (delta < 0) delta += Math.PI * 2;
    return span > 1e-9 ? delta / span : 0;
  }
}

// 등간격 점 생성 도구: 기하 선택 → N개 등간격 점 생성
// 기하를 클릭하면 기본 5개 등간격 점을 생성 (N은 pointCount로 설정 가능)
// line, arc, circle 지원

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";
import { generateConstraintId } from "../../utils/idGenerator";
import { normalizeAngle } from "../../utils/mathUtils";

import { AddRectangleCommand } from "../commands/AddRectangleCommand";
import type { SketchConstraint } from "../constraints/SketchConstraint.type";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import { DrawTool } from "./DrawTool";

export class EquidistantPointsDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "equidistant-points";


  selectionOnly = true;
  // 생성할 점 개수 (외부에서 설정 가능)
  pointCount = 5;

  // 호버 프리뷰용
  private _hoveredGeomId: string | null = null;

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
    if (geom.isReference) return;

    const points = this._computeEquidistantPoints(geom, this.pointCount, false);
    if (points.length === 0) return;

    const geometries: SerializedGeometry[] = this.constructionMode
      ? points.map((p) => ({ ...p, isConstruction: true }))
      : points;
    // 각 점에 대해 기하 위 구속 생성
    const constraints = this._buildPointOnGeomConstraints(geom, points);
    store.execute(new AddRectangleCommand(geometries, constraints));
    store.requestRender();
  }

  onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    const hitRadius = this.inferenceRadius || 5;
    const hitId = store.hitTest(rawPos, hitRadius);

    if (!hitId) {
      if (this._hoveredGeomId) {
        this._hoveredGeomId = null;
        store.hoveredItem = null;
        this.previews = [];
        store.requestRender();
      }
      return;
    }

    if (hitId === this._hoveredGeomId) return; // 동일 기하 호버 중

    this._hoveredGeomId = hitId;
    store.hoveredItem = { kind: "geometry", geomId: hitId };
    const geom = store.geometries.get(hitId);
    if (!geom || geom.isReference) {
      this.previews = [];
      store.requestRender();
      return;
    }

    this.previews = this._computeEquidistantPoints(geom, this.pointCount, true);
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
    this._hoveredGeomId = null;
  }

  // --- 내부 ---

  private _computeEquidistantPoints(
    geom: SerializedGeometry,
    count: number,
    isPreview: boolean,
  ): SerializedGeometry[] {
    if (count < 1) return [];
    const points: SerializedGeometry[] = [];

    if (geom.type === "line") {
      for (let i = 0; i < count; i++) {
        const t = (i + 1) / (count + 1); // 끝점 제외, 내부 등간격
        const x = geom.x1 + t * (geom.x2 - geom.x1);
        const y = geom.y1 + t * (geom.y2 - geom.y1);
        const id = isPreview ? `__eqpt_${i}__` : this._generateId();
        points.push({ type: "point", id, x, y });
      }
    } else if (geom.type === "circle") {
      for (let i = 0; i < count; i++) {
        const angle = (2 * Math.PI * i) / count;
        const x = geom.cx + geom.r * Math.cos(angle);
        const y = geom.cy + geom.r * Math.sin(angle);
        const id = isPreview ? `__eqpt_${i}__` : this._generateId();
        points.push({ type: "point", id, x, y });
      }
    } else if (geom.type === "arc") {
      const startA = normalizeAngle(geom.startAngle);
      const endA = normalizeAngle(geom.endAngle);
      const span = startA <= endA ? endA - startA : (Math.PI * 2 - startA + endA);
      for (let i = 0; i < count; i++) {
        const t = (i + 1) / (count + 1);
        const angle = startA + t * span;
        const x = geom.cx + geom.r * Math.cos(angle);
        const y = geom.cy + geom.r * Math.sin(angle);
        const id = isPreview ? `__eqpt_${i}__` : this._generateId();
        points.push({ type: "point", id, x, y });
      }
    }

    return points;
  }

  // 점이 올려진 기하 타입에 따라 point_on_line / point_on_circle 구속 생성
  private _buildPointOnGeomConstraints(
    geom: SerializedGeometry,
    points: SerializedGeometry[],
  ): SketchConstraint[] {
    const cid = () => generateConstraintId("eqpt");

    if (geom.type === "line") {
      return points.map((pt) => ({
        type: "point_on_line" as const,
        id: cid(),
        point: { geomId: pt.id, vertexIndex: 0 },
        line: { geomId: geom.id },
      }));
    }

    if (geom.type === "circle" || geom.type === "arc") {
      return points.map((pt) => ({
        type: "point_on_circle" as const,
        id: cid(),
        point: { geomId: pt.id, vertexIndex: 0 },
        circle: { geomId: geom.id },
      }));
    }

    return [];
  }

}

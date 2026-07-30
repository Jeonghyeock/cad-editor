// 교차점 생성 도구: 2개 기하를 순차 클릭 → 교차점에 점 자동 생성
// line-line, line-circle, line-arc, circle-circle 등 지원

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";
import { isAngleBetween, normalizeAngle } from "../../utils/mathUtils";

import { AddRectangleCommand } from "../commands/AddRectangleCommand";
import type { SketchConstraint } from "../constraints/SketchConstraint.type";
import { lineArcIntersection, lineCircleIntersection, lineLineIntersection } from "../GeometryIntersection";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import { DrawTool } from "./DrawTool";

export class IntersectionPointDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "intersection-point";


  selectionOnly = true;
  private _firstGeomId: string | null = null;

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

    if (!this._firstGeomId) {
      // 첫 번째 기하 선택
      this._firstGeomId = hitId;
      store.selectedIds = [hitId];
      store.requestRender();
      return;
    }

    if (hitId === this._firstGeomId) return; // 같은 기하 클릭 무시

    // 두 번째 기하 선택 → 교차점 생성
    const geom1 = store.geometries.get(this._firstGeomId);
    if (!geom1) {
      this._reset();
      return;
    }

    const points = this._computeIntersections(geom1, geom);
    if (points.length > 0) {
      const geometries: SerializedGeometry[] = points.map((pt) => ({
        type: "point" as const,
        id: this._generateId(),
        x: pt.x,
        y: pt.y,
      }));
      // 각 교차점에 양쪽 기하에 대한 구속 추가
      const finalGeometries = this.constructionMode
        ? geometries.map((g) => ({ ...g, isConstruction: true }))
        : geometries;
      const constraints = this._buildIntersectionConstraints(geom1, geom, finalGeometries);
      store.execute(new AddRectangleCommand(finalGeometries, constraints));
    }

    this._reset();
    store.requestRender();
  }

  onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    if (!this._firstGeomId) {
      this.previews = [];
      store.requestRender();
      return;
    }

    const hitRadius = this.inferenceRadius || 5;
    const hitId = store.hitTest(rawPos, hitRadius);
    if (!hitId || hitId === this._firstGeomId) {
      this.previews = [];
      store.requestRender();
      return;
    }

    const geom1 = store.geometries.get(this._firstGeomId);
    const geom2 = store.geometries.get(hitId);
    if (!geom1 || !geom2) {
      this.previews = [];
      store.requestRender();
      return;
    }

    // 교차점 프리뷰
    const points = this._computeIntersections(geom1, geom2);
    this.previews = points.map((pt, i) => ({
      type: "point" as const,
      id: `__intpt_${i}__`,
      x: pt.x,
      y: pt.y,
    }));
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // pointerDown에서 처리
  }

  hasPendingWork(): boolean {
    return this._firstGeomId !== null;
  }

  cancel(): void {
    super.cancel();
    this._reset();
  }

  // --- 내부 ---

  private _computeIntersections(
    a: SerializedGeometry,
    b: SerializedGeometry,
  ): { x: number; y: number }[] {
    // line-line
    if (a.type === "line" && b.type === "line") {
      const hit = lineLineIntersection(
        a.x1, a.y1, a.x2, a.y2,
        b.x1, b.y1, b.x2, b.y2,
      );
      if (!hit) return [];
      const EPS = -1e-6;
      if (hit.t1 >= EPS && hit.t1 <= 1 + 1e-6 && hit.t2 >= EPS && hit.t2 <= 1 + 1e-6) {
        return [{ x: hit.x, y: hit.y }];
      }
      return [];
    }

    // line-circle
    if (a.type === "line" && b.type === "circle") {
      return lineCircleIntersection(a.x1, a.y1, a.x2, a.y2, b.cx, b.cy, b.r, true);
    }
    if (a.type === "circle" && b.type === "line") {
      return lineCircleIntersection(b.x1, b.y1, b.x2, b.y2, a.cx, a.cy, a.r, true);
    }

    // line-arc
    if (a.type === "line" && b.type === "arc") {
      return lineArcIntersection(a.x1, a.y1, a.x2, a.y2, b.cx, b.cy, b.r, b.startAngle, b.endAngle);
    }
    if (a.type === "arc" && b.type === "line") {
      return lineArcIntersection(b.x1, b.y1, b.x2, b.y2, a.cx, a.cy, a.r, a.startAngle, a.endAngle);
    }

    // circle-circle
    if (a.type === "circle" && b.type === "circle") {
      return this._circleCircleIntersection(a.cx, a.cy, a.r, b.cx, b.cy, b.r);
    }

    // circle-arc
    if (a.type === "circle" && b.type === "arc") {
      const pts = this._circleCircleIntersection(a.cx, a.cy, a.r, b.cx, b.cy, b.r);
      return pts.filter((pt) => {
        const angle = normalizeAngle(Math.atan2(pt.y - b.cy, pt.x - b.cx));
        return isAngleBetween(angle, normalizeAngle(b.startAngle), normalizeAngle(b.endAngle));
      });
    }
    if (a.type === "arc" && b.type === "circle") {
      const pts = this._circleCircleIntersection(a.cx, a.cy, a.r, b.cx, b.cy, b.r);
      return pts.filter((pt) => {
        const angle = normalizeAngle(Math.atan2(pt.y - a.cy, pt.x - a.cx));
        return isAngleBetween(angle, normalizeAngle(a.startAngle), normalizeAngle(a.endAngle));
      });
    }

    // arc-arc
    if (a.type === "arc" && b.type === "arc") {
      const pts = this._circleCircleIntersection(a.cx, a.cy, a.r, b.cx, b.cy, b.r);
      return pts.filter((pt) => {
        const angleA = normalizeAngle(Math.atan2(pt.y - a.cy, pt.x - a.cx));
        const angleB = normalizeAngle(Math.atan2(pt.y - b.cy, pt.x - b.cx));
        return isAngleBetween(angleA, normalizeAngle(a.startAngle), normalizeAngle(a.endAngle)) &&
               isAngleBetween(angleB, normalizeAngle(b.startAngle), normalizeAngle(b.endAngle));
      });
    }

    return [];
  }

  private _circleCircleIntersection(
    cx1: number, cy1: number, r1: number,
    cx2: number, cy2: number, r2: number,
  ): { x: number; y: number }[] {
    const dx = cx2 - cx1, dy = cy2 - cy1;
    const d = Math.hypot(dx, dy);
    if (d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9 || d < 1e-9) return [];

    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const hSq = r1 * r1 - a * a;
    if (hSq < -1e-9) return [];
    const h = Math.sqrt(Math.max(0, hSq));

    const mx = cx1 + a * dx / d;
    const my = cy1 + a * dy / d;

    if (h < 1e-9) return [{ x: mx, y: my }];

    const px = -dy / d * h;
    const py = dx / d * h;
    return [
      { x: mx + px, y: my + py },
      { x: mx - px, y: my - py },
    ];
  }


  // 기하 타입에 따라 point_on_line 또는 point_on_circle 구속 생성
  private _pointOnGeomConstraint(
    pointId: string,
    geom: SerializedGeometry,
    constraintId: string,
  ): SketchConstraint | null {
    if (geom.type === "line") {
      return { type: "point_on_line", id: constraintId, point: { geomId: pointId, vertexIndex: 0 }, line: { geomId: geom.id } };
    }
    if (geom.type === "circle" || geom.type === "arc") {
      return { type: "point_on_circle", id: constraintId, point: { geomId: pointId, vertexIndex: 0 }, circle: { geomId: geom.id } };
    }
    return null;
  }

  // 교차점에 양쪽 기하에 대한 구속 생성
  private _buildIntersectionConstraints(
    geom1: SerializedGeometry,
    geom2: SerializedGeometry,
    pointGeoms: SerializedGeometry[],
  ): SketchConstraint[] {
    let cIdx = 0;
    const cid = () => `cst_intpt_${pointGeoms[0]?.id ?? ""}_${cIdx++}`;
    const constraints: SketchConstraint[] = [];

    for (const pt of pointGeoms) {
      const c1 = this._pointOnGeomConstraint(pt.id, geom1, cid());
      if (c1) constraints.push(c1);
      const c2 = this._pointOnGeomConstraint(pt.id, geom2, cid());
      if (c2) constraints.push(c2);
    }

    return constraints;
  }

  private _reset(): void {
    this._firstGeomId = null;
    this.previews = [];
  }
}

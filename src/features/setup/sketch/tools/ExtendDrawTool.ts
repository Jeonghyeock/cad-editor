// Extend 도구 (CATIA Relimit 스타일)
// 선분/호의 endpoint를 클릭 → 연장 방향으로 가장 가까운 교차 기하까지 확장
// 교차 대상이 없으면 아무 동작 없음

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";
import { generateConstraintId } from "../../utils/idGenerator";
import { isAngleBetween, normalizeAngle } from "../../utils/mathUtils";

import { AddConstraintCommand } from "../commands/AddConstraintCommand";
import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { MoveVertexCommand } from "../commands/MoveVertexCommand";
import { lineCircleIntersection, lineLineIntersectionUnbounded } from "../GeometryIntersection";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import { DrawTool } from "./DrawTool";

export class ExtendDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "extend";


  selectionOnly = true;
  // 프리뷰: 연장 결과를 표시할 기하
  extendPreview: SerializedGeometry | null = null;

  private _hoveredGeomId: string | null = null;
  private _hoveredVertexIndex: number | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    if (!this._hoveredGeomId || this._hoveredVertexIndex === null) return;

    const geom = store.geometries.get(this._hoveredGeomId);
    if (!geom) return;

    const result = this._computeExtension(store, geom, this._hoveredVertexIndex);
    if (!result) return;

    const cmds: GeometryCommand[] = [];

    if (geom.type === "line") {
      // MoveVertexCommand로 endpoint를 교차점으로 이동
      const vi = this._hoveredVertexIndex;
      const ex = vi === 0 ? geom.x1 : geom.x2;
      const ey = vi === 0 ? geom.y1 : geom.y2;
      cmds.push(new MoveVertexCommand(geom.id, vi, result.x - ex, result.y - ey));
    } else if (geom.type === "arc") {
      // arc endpoint: vertexIndex 1=start, 2=end
      const vi = this._hoveredVertexIndex;
      const angleKey = vi === 1 ? "startAngle" : "endAngle";
      const currentAngle = geom[angleKey];
      const endpointX = geom.cx + geom.r * Math.cos(currentAngle);
      const endpointY = geom.cy + geom.r * Math.sin(currentAngle);
      cmds.push(new MoveVertexCommand(geom.id, vi, result.x - endpointX, result.y - endpointY));
    }

    // 교차 대상과 coincident 구속 추가
    if (result.targetGeomId) {
      const targetGeom = store.geometries.get(result.targetGeomId);
      if (targetGeom) {
        const cstCmd = this._buildExtendConstraint(
          geom.id, this._hoveredVertexIndex,
          result, targetGeom,
        );
        if (cstCmd) cmds.push(cstCmd);
      }
    }

    if (cmds.length > 0) {
      store.execute(cmds.length === 1 ? cmds[0] : new BatchCommand(cmds));
    }

    // 상태 초기화
    this.extendPreview = null;
    this._hoveredGeomId = null;
    this._hoveredVertexIndex = null;
    store.hoveredItem = null;
    store.requestRender();
  }

  onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    const hitRadius = this.inferenceRadius || 5;
    this.extendPreview = null;
    this._hoveredGeomId = null;
    this._hoveredVertexIndex = null;
    store.hoveredItem = null;

    // endpoint에 가까운 기하 찾기
    const nearest = this._findNearestEndpoint(store, rawPos, hitRadius);
    if (!nearest) {
      store.requestRender();
      return;
    }

    const geom = store.geometries.get(nearest.geomId);
    if (!geom) { store.requestRender(); return; }
    if ("isReference" in geom && geom.isReference) { store.requestRender(); return; }
    if ("isConstruction" in geom && geom.isConstruction) { store.requestRender(); return; }

    // line과 arc만 extend 가능
    if (geom.type !== "line" && geom.type !== "arc") {
      store.requestRender();
      return;
    }

    this._hoveredGeomId = nearest.geomId;
    this._hoveredVertexIndex = nearest.vertexIndex;
    store.hoveredItem = { kind: "geometry", geomId: nearest.geomId };

    // 프리뷰 계산
    const result = this._computeExtension(store, geom, nearest.vertexIndex);
    if (result) {
      this.extendPreview = this._buildPreviewGeom(geom, nearest.vertexIndex, result);
    }

    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // extend는 pointerDown에서 처리
  }

  cancel(): void {
    super.cancel();
    this.extendPreview = null;
    this._hoveredGeomId = null;
    this._hoveredVertexIndex = null;
  }

  // --- endpoint 탐색 ---

  private _findNearestEndpoint(
    store: SketchGeometryStore,
    pos: { x: number; y: number },
    radius: number,
  ): { geomId: string; vertexIndex: number } | null {
    const r2 = radius * radius;
    let best: { geomId: string; vertexIndex: number; dist2: number } | null = null;

    for (const [id, geom] of store.geometries) {
      if ("isReference" in geom && geom.isReference) continue;
      if ("isConstruction" in geom && geom.isConstruction) continue;

      const endpoints = this._getExtendableEndpoints(geom);
      for (const ep of endpoints) {
        const dx = pos.x - ep.x;
        const dy = pos.y - ep.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2 && (!best || d2 < best.dist2)) {
          best = { geomId: id, vertexIndex: ep.vertexIndex, dist2: d2 };
        }
      }
    }

    return best;
  }

  // 확장 가능한 endpoint만 반환 (line: 0,1 / arc: 1,2)
  private _getExtendableEndpoints(geom: SerializedGeometry): { vertexIndex: number; x: number; y: number }[] {
    if (geom.type === "line") {
      return [
        { vertexIndex: 0, x: geom.x1, y: geom.y1 },
        { vertexIndex: 1, x: geom.x2, y: geom.y2 },
      ];
    }
    if (geom.type === "arc") {
      return [
        { vertexIndex: 1, x: geom.cx + geom.r * Math.cos(geom.startAngle), y: geom.cy + geom.r * Math.sin(geom.startAngle) },
        { vertexIndex: 2, x: geom.cx + geom.r * Math.cos(geom.endAngle), y: geom.cy + geom.r * Math.sin(geom.endAngle) },
      ];
    }
    return [];
  }

  // --- 연장 교차점 계산 ---

  private _computeExtension(
    store: SketchGeometryStore,
    geom: SerializedGeometry,
    vertexIndex: number,
  ): { x: number; y: number; targetGeomId: string; targetVertexIndex?: number } | null {
    if (geom.type === "line") {
      return this._extendLine(store, geom, vertexIndex);
    }
    if (geom.type === "arc") {
      return this._extendArc(store, geom, vertexIndex);
    }
    return null;
  }

  // Line 연장: endpoint에서 반대 방향으로 ray-cast
  private _extendLine(
    store: SketchGeometryStore,
    geom: SerializedGeometry & { type: "line" },
    vertexIndex: number,
  ): { x: number; y: number; targetGeomId: string; targetVertexIndex?: number } | null {
    // 연장 방향: 반대 endpoint → 클릭 endpoint 방향
    const epX = vertexIndex === 0 ? geom.x1 : geom.x2;
    const epY = vertexIndex === 0 ? geom.y1 : geom.y2;
    const otherX = vertexIndex === 0 ? geom.x2 : geom.x1;
    const otherY = vertexIndex === 0 ? geom.y2 : geom.y1;

    const dirX = epX - otherX;
    const dirY = epY - otherY;
    const dirLen = Math.hypot(dirX, dirY);
    if (dirLen < 1e-9) return null;

    // 매우 먼 점으로 ray 생성
    const FAR = 1e6;
    const farX = epX + (dirX / dirLen) * FAR;
    const farY = epY + (dirY / dirLen) * FAR;

    let best: { x: number; y: number; dist: number; targetGeomId: string; targetVertexIndex?: number } | null = null;

    for (const [id, other] of store.geometries) {
      if (id === geom.id) continue;
      if ("isReference" in other && other.isReference) continue;

      const hits = this._rayIntersectGeom(epX, epY, farX, farY, dirX, dirY, other);
      for (const hit of hits) {
        // endpoint 방향으로만 (양의 t만 허용)
        const dx = hit.x - epX;
        const dy = hit.y - epY;
        const dot = dx * dirX + dy * dirY;
        if (dot < 1e-6) continue; // 반대 방향은 무시

        const dist = Math.hypot(dx, dy);
        if (!best || dist < best.dist) {
          best = { x: hit.x, y: hit.y, dist, targetGeomId: id, targetVertexIndex: hit.vertexIndex };
        }
      }
    }

    return best;
  }

  // Arc 연장: endpoint에서 호를 연장하여 다른 기하와의 교차점 찾기
  private _extendArc(
    store: SketchGeometryStore,
    geom: SerializedGeometry & { type: "arc" },
    vertexIndex: number,
  ): { x: number; y: number; targetGeomId: string; targetVertexIndex?: number } | null {
    // arc의 전체 원과 다른 기하의 교차점을 구해, 연장 방향에 가장 가까운 것을 선택
    const extendFromStart = vertexIndex === 1; // start 방향으로 연장
    const refAngle = extendFromStart ? geom.startAngle : geom.endAngle;

    let best: { x: number; y: number; angleDist: number; targetGeomId: string } | null = null;

    for (const [id, other] of store.geometries) {
      if (id === geom.id) continue;
      if ("isReference" in other && other.isReference) continue;

      const hits = this._circleIntersectGeom(geom.cx, geom.cy, geom.r, other);
      for (const hit of hits) {
        const hitAngle = normalizeAngle(Math.atan2(hit.y - geom.cy, hit.x - geom.cx));

        // 연장 방향 판정: start를 연장하면 startAngle에서 반시계(감소) 방향
        // end를 연장하면 endAngle에서 시계(증가) 방향
        // 이미 호 범위 안에 있는 교차점은 무시
        if (isAngleBetween(hitAngle, geom.startAngle, geom.endAngle)) continue;

        // 연장 방향과의 각도 거리 계산
        let angleDist: number;
        if (extendFromStart) {
          // start에서 반시계 방향으로의 거리
          angleDist = normalizeAngle(normalizeAngle(refAngle) - hitAngle);
        } else {
          // end에서 시계 방향으로의 거리
          angleDist = normalizeAngle(hitAngle - normalizeAngle(refAngle));
        }

        if (angleDist < 1e-6 || angleDist > Math.PI * 2 - 1e-6) continue;

        if (!best || angleDist < best.angleDist) {
          best = { x: hit.x, y: hit.y, angleDist, targetGeomId: id };
        }
      }
    }

    return best;
  }

  // --- Ray-Geometry 교차 ---

  private _rayIntersectGeom(
    rayX1: number, rayY1: number, rayX2: number, rayY2: number,
    dirX: number, dirY: number,
    other: SerializedGeometry,
  ): { x: number; y: number; vertexIndex?: number }[] {
    const results: { x: number; y: number; vertexIndex?: number }[] = [];

    if (other.type === "line") {
      const hit = lineLineIntersectionUnbounded(
        rayX1, rayY1, rayX2, rayY2,
        other.x1, other.y1, other.x2, other.y2,
      );
      if (hit && hit.t2 >= -1e-9 && hit.t2 <= 1 + 1e-9) {
        results.push({ x: hit.x, y: hit.y });
      }
    } else if (other.type === "circle") {
      const pts = lineCircleIntersection(rayX1, rayY1, rayX2, rayY2, other.cx, other.cy, other.r);
      for (const pt of pts) {
        results.push({ x: pt.x, y: pt.y });
      }
    } else if (other.type === "arc") {
      // ray와 원의 교차 후 호 범위 필터
      const pts = lineCircleIntersection(rayX1, rayY1, rayX2, rayY2, other.cx, other.cy, other.r);
      for (const pt of pts) {
        const angle = normalizeAngle(Math.atan2(pt.y - other.cy, pt.x - other.cx));
        if (isAngleBetween(angle, other.startAngle, other.endAngle)) {
          results.push({ x: pt.x, y: pt.y });
        }
      }
    }

    return results;
  }

  // 원과 다른 기하의 교차점
  private _circleIntersectGeom(
    cx: number, cy: number, r: number,
    other: SerializedGeometry,
  ): { x: number; y: number }[] {
    if (other.type === "line") {
      // 선분이 아닌 무한 직선과의 교차 (연장 대상이므로)
      // 하지만 other는 유한 선분이어야 의미 있으므로 선분 범위 내만 반환
      return lineCircleIntersection(other.x1, other.y1, other.x2, other.y2, cx, cy, r, true);
    }
    if (other.type === "circle") {
      return this._circleCircleIntersect(cx, cy, r, other.cx, other.cy, other.r);
    }
    if (other.type === "arc") {
      const pts = this._circleCircleIntersect(cx, cy, r, other.cx, other.cy, other.r);
      return pts.filter((pt) => {
        const angle = normalizeAngle(Math.atan2(pt.y - other.cy, pt.x - other.cx));
        return isAngleBetween(angle, other.startAngle, other.endAngle);
      });
    }
    return [];
  }

  private _circleCircleIntersect(
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
    return [{ x: mx + px, y: my + py }, { x: mx - px, y: my - py }];
  }

  // --- 프리뷰 생성 ---

  private _buildPreviewGeom(
    geom: SerializedGeometry,
    vertexIndex: number,
    target: { x: number; y: number },
  ): SerializedGeometry | null {
    if (geom.type === "line") {
      // 연장된 선분 프리뷰 (원래 endpoint에서 교차점까지)
      const epX = vertexIndex === 0 ? geom.x1 : geom.x2;
      const epY = vertexIndex === 0 ? geom.y1 : geom.y2;
      return {
        type: "line",
        id: "__extend_preview__",
        x1: epX,
        y1: epY,
        x2: target.x,
        y2: target.y,
      };
    }
    if (geom.type === "arc") {
      // 연장된 호 프리뷰
      const newAngle = Math.atan2(target.y - geom.cy, target.x - geom.cx);
      if (vertexIndex === 1) {
        return {
          type: "arc",
          id: "__extend_preview__",
          cx: geom.cx, cy: geom.cy, r: geom.r,
          startAngle: newAngle,
          endAngle: geom.startAngle,
        };
      } else {
        return {
          type: "arc",
          id: "__extend_preview__",
          cx: geom.cx, cy: geom.cy, r: geom.r,
          startAngle: geom.endAngle,
          endAngle: newAngle,
        };
      }
    }
    return null;
  }

  // --- 구속 생성 ---

  private _buildExtendConstraint(
    geomId: string,
    vertexIndex: number,
    target: { x: number; y: number; targetGeomId: string; targetVertexIndex?: number },
    targetGeom: SerializedGeometry,
  ): GeometryCommand | null {
    // 교차 대상이 line이면 point_on_line, circle/arc이면 point_on_circle
    if (targetGeom.type === "line") {
      return new AddConstraintCommand({
        type: "point_on_line",
        id: generateConstraintId("auto-cst-extend"),
        point: { geomId, vertexIndex },
        line: { geomId: target.targetGeomId },
      });
    }
    if (targetGeom.type === "circle" || targetGeom.type === "arc") {
      return new AddConstraintCommand({
        type: "point_on_circle",
        id: generateConstraintId("auto-cst-extend"),
        point: { geomId, vertexIndex },
        circle: { geomId: target.targetGeomId },
      });
    }
    return null;
  }

  // --- 유틸리티 ---

}

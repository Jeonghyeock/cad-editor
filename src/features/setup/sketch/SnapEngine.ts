// 스냅 엔진: 그리드 스냅 + 기하 스냅 (원점, 끝점, 교차점, 중점, 중심, 접선, 연장선, 수선의 발, 최근점)

import type { SerializedGeometry } from "../Setup.type";
import { SpatialGrid } from "../utils/spatialIndex";

import type { SketchGeometryStore } from "./SketchGeometryStore";
import { REF_ORIGIN_ID } from "./SketchGeometryStore";

export type SnapType =
  | "origin"
  | "endpoint"
  | "intersection"
  | "midpoint"
  | "center"
  | "tangent"
  | "extension"
  | "perpendicular"
  | "nearest"
  | "grid";

export type SnapResult = {
  x: number;
  y: number;
  type: SnapType;
  extent?: number; // center 스냅 시 도형 외접 반지름 (추론선 길이용)
  sourceGeomType?: SerializedGeometry["type"]; // 스냅 대상 기하 타입
  sourceGeomId?: string; // 스냅 대상 기하 ID
  sourceVertexIndex?: number; // 스냅 대상 꼭짓점 인덱스
  // 두 번째 entity 추적 — intersection snap 이 두 기하의 교차점일 때 양쪽 ID/type 보관.
  // CAD 표준 (Onshape/Fusion/CATIA) — intersection 클릭 시 두 entity 모두에 point_on_X 자동 부여.
  sourceGeomId2?: string;
  sourceGeomType2?: SerializedGeometry["type"];
} | null;

// 스냅 우선순위 (낮을수록 우선)
const SNAP_PRIORITY: Record<SnapType, number> = {
  origin: 0,
  endpoint: 0,
  intersection: 0,
  midpoint: 1,
  center: 2,
  tangent: 3,
  extension: 3,
  perpendicular: 3,
  nearest: 3,
  grid: 4,
};

// 공간 그리드에 기하 하나를 넣을 때 몸통·둘레 위에 찍는 표본 수의 상한. 크게 확대해 기하 하나가 이보다 많은 칸에
// 걸치면 그리드에 넣지 않고 따로 두었다가, 질의 때 커서까지의 거리로 거른다 (드래그 중에는 프레임마다 그리드를
// 다시 짓기 때문).
const MAX_GRID_SAMPLES = 512;

export class SnapEngine {
  // 그리드 스냅 활성화 여부 (기본 true)
  gridSnapEnabled = true;
  // 기하 스냅 활성화 여부 (기본 true)
  geometrySnapEnabled = true;
  // 기하 스냅 탐색 반경 (월드 단위)
  snapRadius = 0;

  // SpatialGrid 캐시 — 기하 변경 시에만 재빌드 (pointerMove 성능 최적화)
  private _cachedGrid: SpatialGrid<number> | null = null;
  // 그리드에 넣기엔 너무 큰 기하 인덱스 — 질의 때 커서 근처인 것만 후보에 더한다
  private _cachedWideIndices: number[] = [];
  private _cachedGeometries: SerializedGeometry[] = [];
  private _cachedGeomVersion = -1;
  private _cachedSearchRadius = 0;

  // 좌표를 스냅. 기하 스냅 우선, 없으면 그리드 스냅
  // allowedTypes: 허용할 스냅 타입 집합 (null이면 모든 스냅 허용)
  snap(
    pos: { x: number; y: number },
    gridSpacing: number,
    store: SketchGeometryStore | null,
    screenSnapRadius: number,
    scale: number,
    externalGeometries?: SerializedGeometry[],
    suppressSnap?: boolean,
    allowedTypes?: Set<SnapType> | null,
  ): SnapResult {
    // 스냅 억제 시 즉시 null 반환
    if (suppressSnap) return null;

    this.snapRadius = screenSnapRadius / scale;

    // 1) 기하 스냅 (정밀 우선)
    if (this.geometrySnapEnabled && store) {
      const geoSnap = this._snapToGeometry(pos, store, externalGeometries, allowedTypes);
      if (geoSnap) return geoSnap;
    }

    // 2) 그리드 스냅
    if (this.gridSnapEnabled && gridSpacing > 0) {
      if (!allowedTypes || allowedTypes.has("grid")) {
        return this._snapToGrid(pos, gridSpacing);
      }
    }

    return null;
  }

  private _snapToGrid(pos: { x: number; y: number }, spacing: number): SnapResult {
    const snappedX = Math.round(pos.x / spacing) * spacing;
    const snappedY = Math.round(pos.y / spacing) * spacing;

    // 스냅 반경 내에 있을 때만 그리드 스냅 적용
    const dx = pos.x - snappedX;
    const dy = pos.y - snappedY;
    if (dx * dx + dy * dy > this.snapRadius * this.snapRadius) {
      return null;
    }

    return { x: snappedX, y: snappedY, type: "grid" };
  }

  private _snapToGeometry(
    pos: { x: number; y: number },
    store: SketchGeometryStore,
    externalGeometries?: SerializedGeometry[],
    allowedTypes?: Set<SnapType> | null,
  ): SnapResult {
    const r2 = this.snapRadius * this.snapRadius;
    let best: SnapResult = null;
    let bestDist2 = r2;
    let bestPriority = Infinity;

    const evaluate = (candidate: NonNullable<SnapResult>) => {
      // 스냅 타입 필터 적용
      if (allowedTypes && !allowedTypes.has(candidate.type)) return;
      const dx = pos.x - candidate.x;
      const dy = pos.y - candidate.y;
      const d2 = dx * dx + dy * dy;
      const priority = SNAP_PRIORITY[candidate.type];
      if (d2 < r2 && (priority < bestPriority || (priority === bestPriority && d2 < bestDist2))) {
        bestDist2 = d2;
        bestPriority = priority;
        best = candidate;
      }
    };

    // 원점 스냅 (항상 후보) — REF_ORIGIN_ID 의 point geom 과 동일 entity 라 sourceGeomId/Index
    // 부여해 DrawTool 의 _buildAutoConstraint 가 coincident 생성하도록 함.
    evaluate({
      x: 0,
      y: 0,
      type: "origin",
      sourceGeomId: REF_ORIGIN_ID,
      sourceGeomType: "point",
      sourceVertexIndex: 0,
    });

    // 모든 기하 수집
    const allGeometries: SerializedGeometry[] = [...store.geometries.values()];
    if (externalGeometries) allGeometries.push(...externalGeometries);

    // SpatialGrid 캐시: 기하 변경 시에만 재빌드 (pointerMove 성능 최적화)
    const searchRadius = this.snapRadius * 3;
    const geomVersion = store.geometryVersion ?? 0;
    if (
      !this._cachedGrid ||
      geomVersion !== this._cachedGeomVersion ||
      allGeometries.length !== this._cachedGeometries.length ||
      Math.abs(searchRadius - this._cachedSearchRadius) > 1e-6
    ) {
      const cellSize = searchRadius * 2;
      const geomGrid = new SpatialGrid<number>(cellSize);
      const wideIndices: number[] = [];
      for (let i = 0; i < allGeometries.length; i++) {
        if (!this._insertIntoGrid(geomGrid, allGeometries[i], i, cellSize / 2)) wideIndices.push(i);
      }
      this._cachedGrid = geomGrid;
      this._cachedWideIndices = wideIndices;
      this._cachedGeometries = allGeometries;
      this._cachedGeomVersion = geomVersion;
      this._cachedSearchRadius = searchRadius;
    }

    // 근접 기하 인덱스 수집 (중복 제거)
    const nearbyIndices = new Set(this._cachedGrid.queryRadius(pos.x, pos.y, searchRadius));
    // 크게 확대해 이런 기하가 많아져도 매 포인터 이동의 후보·교차 계산은 커서 근처 것만 하도록 거리로 거른다
    for (const i of this._cachedWideIndices) {
      if (this._isNearWideGeometry(pos, allGeometries[i], searchRadius)) nearbyIndices.add(i);
    }
    // axis 는 무한선이라 grid cell 에 국한되지 않음 — 항상 candidate 에 포함.
    for (let i = 0; i < allGeometries.length; i++) {
      if (allGeometries[i].type === "axis") nearbyIndices.add(i);
    }

    for (const idx of nearbyIndices) {
      const geom = allGeometries[idx];
      // 이산 후보점 (endpoint, midpoint, center)
      const candidates = this._getSnapCandidates(geom, geom.id);
      for (const c of candidates) evaluate(c);

      // 연속 스냅 후보 (perpendicular, nearest)
      const continuous = this._getContinuousSnap(pos, geom);
      if (continuous) {
        // nearest / perpendicular snap 에 sourceGeomId 주입
        // (auto point_on_circle / point_on_line 자동 구속용)
        if (!continuous.sourceGeomId) {
          continuous.sourceGeomId = geom.id;
        }
        evaluate(continuous);
      }

      // 접선 스냅 (원/호)
      const tangent = this._snapToTangent(pos, geom);
      if (tangent) {
        // tangent snap 에 sourceGeomId 주입 (auto tangent 자동 구속용)
        if (!tangent.sourceGeomId) {
          tangent.sourceGeomId = geom.id;
        }
        evaluate(tangent);
      }

      // 연장선 스냅 (선분)
      const extension = this._snapToExtension(pos, geom);
      if (extension) evaluate(extension);
    }

    // 교차점 스냅 (근접 기하만 대상 — SpatialGrid 활용)
    const cachedGeoms = this._cachedGeometries;
    const nearbyGeometries = [...nearbyIndices].map((i) => cachedGeoms[i]);
    const intersections = this._snapToIntersection(pos, nearbyGeometries);
    for (const inter of intersections) evaluate(inter);

    return best;
  }

  // --- 교차점 스냅 ---

  private _snapToIntersection(
    pos: { x: number; y: number },
    allGeometries: SerializedGeometry[],
  ): NonNullable<SnapResult>[] {
    const results: NonNullable<SnapResult>[] = [];

    // 선분 목록 + 원/호 목록 추출 — entity id/type 도 함께 보관해 intersection snap 결과에
    // sourceGeomIdA/B 부여 (CAD 표준: intersection 클릭 시 양쪽 entity 와의 point_on_X 자동).
    type LineSeg = { x1: number; y1: number; x2: number; y2: number; id: string; type: "line" };
    type CircArc = { cx: number; cy: number; r: number; startAngle?: number; endAngle?: number; id: string; type: "circle" | "arc" };

    const lines: LineSeg[] = [];
    const circles: CircArc[] = [];

    for (const geom of allGeometries) {
      if (geom.type === "line") {
        lines.push({ x1: geom.x1, y1: geom.y1, x2: geom.x2, y2: geom.y2, id: geom.id, type: "line" });
      } else if (geom.type === "circle") {
        circles.push({ cx: geom.cx, cy: geom.cy, r: geom.r, id: geom.id, type: "circle" });
      } else if (geom.type === "arc") {
        circles.push({ cx: geom.cx, cy: geom.cy, r: geom.r, startAngle: geom.startAngle, endAngle: geom.endAngle, id: geom.id, type: "arc" });
      }
    }

    const r2 = this.snapRadius * this.snapRadius;
    const addIfNear = (
      x: number, y: number,
      idA: string, typeA: SerializedGeometry["type"],
      idB: string, typeB: SerializedGeometry["type"],
    ) => {
      const dx = pos.x - x;
      const dy = pos.y - y;
      if (dx * dx + dy * dy < r2) {
        results.push({
          x, y, type: "intersection",
          sourceGeomId: idA, sourceGeomType: typeA,
          sourceGeomId2: idB, sourceGeomType2: typeB,
        });
      }
    };

    // line-line 교차
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const pt = this._lineLineIntersection(lines[i], lines[j]);
        if (pt) addIfNear(pt.x, pt.y, lines[i].id, "line", lines[j].id, "line");
      }
    }

    // line-circle 교차
    for (const line of lines) {
      for (const circ of circles) {
        const pts = this._lineCircleIntersection(line, circ);
        for (const pt of pts) addIfNear(pt.x, pt.y, line.id, "line", circ.id, circ.type);
      }
    }

    // circle-circle 교차
    for (let i = 0; i < circles.length; i++) {
      for (let j = i + 1; j < circles.length; j++) {
        const pts = this._circleCircleIntersection(circles[i], circles[j]);
        for (const pt of pts) addIfNear(pt.x, pt.y, circles[i].id, circles[i].type, circles[j].id, circles[j].type);
      }
    }

    return results;
  }

  private _lineLineIntersection(
    a: { x1: number; y1: number; x2: number; y2: number },
    b: { x1: number; y1: number; x2: number; y2: number },
  ): { x: number; y: number } | null {
    const d1x = a.x2 - a.x1, d1y = a.y2 - a.y1;
    const d2x = b.x2 - b.x1, d2y = b.y2 - b.y1;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-10) return null; // 평행

    const t = ((b.x1 - a.x1) * d2y - (b.y1 - a.y1) * d2x) / denom;
    const u = ((b.x1 - a.x1) * d1y - (b.y1 - a.y1) * d1x) / denom;

    // 두 선분 모두 범위 내
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;

    return { x: a.x1 + t * d1x, y: a.y1 + t * d1y };
  }

  private _lineCircleIntersection(
    line: { x1: number; y1: number; x2: number; y2: number },
    circ: { cx: number; cy: number; r: number; startAngle?: number; endAngle?: number },
  ): { x: number; y: number }[] {
    const dx = line.x2 - line.x1;
    const dy = line.y2 - line.y1;
    const fx = line.x1 - circ.cx;
    const fy = line.y1 - circ.cy;

    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - circ.r * circ.r;
    const discriminant = b * b - 4 * a * c;

    if (discriminant < 0 || a < 1e-10) return [];

    const results: { x: number; y: number }[] = [];
    const sqrtD = Math.sqrt(discriminant);

    for (const sign of [-1, 1]) {
      const t = (-b + sign * sqrtD) / (2 * a);
      if (t < 0 || t > 1) continue;

      const px = line.x1 + t * dx;
      const py = line.y1 + t * dy;

      // 호인 경우 각도 범위 검사
      if (circ.startAngle !== undefined && circ.endAngle !== undefined) {
        const angle = Math.atan2(py - circ.cy, px - circ.cx);
        if (!this._isAngleInArc(angle, circ.startAngle, circ.endAngle)) continue;
      }

      results.push({ x: px, y: py });
    }

    return results;
  }

  private _circleCircleIntersection(
    a: { cx: number; cy: number; r: number; startAngle?: number; endAngle?: number },
    b: { cx: number; cy: number; r: number; startAngle?: number; endAngle?: number },
  ): { x: number; y: number }[] {
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    const d = Math.hypot(dx, dy);

    if (d < 1e-10 || d > a.r + b.r || d < Math.abs(a.r - b.r)) return [];

    const aa = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
    const h2 = a.r * a.r - aa * aa;
    if (h2 < 0) return [];

    const h = Math.sqrt(h2);
    const mx = a.cx + (dx * aa) / d;
    const my = a.cy + (dy * aa) / d;

    const results: { x: number; y: number }[] = [];

    if (h < 1e-10) {
      // 접하는 경우: 접점 1개
      if (this._checkArcRange(mx, my, a) && this._checkArcRange(mx, my, b)) {
        results.push({ x: mx, y: my });
      }
    } else {
      // 교차점 2개
      for (const sign of [1, -1]) {
        const px = mx + (sign * h * dy) / d;
        const py = my - (sign * h * dx) / d;
        if (this._checkArcRange(px, py, a) && this._checkArcRange(px, py, b)) {
          results.push({ x: px, y: py });
        }
      }
    }

    return results;
  }

  private _checkArcRange(
    px: number, py: number,
    circ: { cx: number; cy: number; startAngle?: number; endAngle?: number },
  ): boolean {
    if (circ.startAngle === undefined || circ.endAngle === undefined) return true;
    const angle = Math.atan2(py - circ.cy, px - circ.cx);
    return this._isAngleInArc(angle, circ.startAngle, circ.endAngle);
  }

  private _isAngleInArc(angle: number, startAngle: number, endAngle: number): boolean {
    let sweep = endAngle - startAngle;
    if (sweep <= 0) sweep += Math.PI * 2;
    const relAngle = ((angle - startAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    return relAngle <= sweep;
  }

  // --- 접선 스냅 ---

  private _snapToTangent(
    pos: { x: number; y: number },
    geom: SerializedGeometry,
  ): SnapResult {
    if (geom.type !== "circle" && geom.type !== "arc") return null;

    const cx = geom.cx, cy = geom.cy, r = geom.r;
    const d = Math.hypot(pos.x - cx, pos.y - cy);
    if (d <= r || d < 1e-10) return null; // 원 내부이면 접선 없음

    const tangentAngle = Math.acos(r / d);
    const baseAngle = Math.atan2(pos.y - cy, pos.x - cx);

    let bestResult: SnapResult = null;
    let bestDist2 = this.snapRadius * this.snapRadius;

    for (const sign of [-1, 1]) {
      const tAngle = baseAngle + sign * tangentAngle;
      const tx = cx + r * Math.cos(tAngle);
      const ty = cy + r * Math.sin(tAngle);

      // 호인 경우 각도 범위 검사
      if (geom.type === "arc") {
        if (!this._isAngleInArc(tAngle, geom.startAngle, geom.endAngle)) continue;
      }

      const dx = pos.x - tx;
      const dy = pos.y - ty;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        bestResult = { x: tx, y: ty, type: "tangent" };
      }
    }

    return bestResult;
  }

  // --- 연장선 스냅 ---

  private _snapToExtension(
    pos: { x: number; y: number },
    geom: SerializedGeometry,
  ): SnapResult {
    if (geom.type !== "line") return null;

    const dx = geom.x2 - geom.x1;
    const dy = geom.y2 - geom.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) return null;

    const t = ((pos.x - geom.x1) * dx + (pos.y - geom.y1) * dy) / lenSq;

    // 선분 내부(t∈[0,1])는 제외 — 연장선만
    if (t >= -0.02 && t <= 1.02) return null;

    const px = geom.x1 + t * dx;
    const py = geom.y1 + t * dy;

    const ex = pos.x - px;
    const ey = pos.y - py;
    if (ex * ex + ey * ey > this.snapRadius * this.snapRadius) return null;

    return { x: px, y: py, type: "extension" };
  }

  // 연속 스냅: 선분 위 수선의 발, 원/호 둘레 최근점
  private _getContinuousSnap(
    pos: { x: number; y: number },
    geom: SerializedGeometry,
  ): SnapResult {
    switch (geom.type) {
      case "line":
        return this._snapToLineSegment(pos, geom.x1, geom.y1, geom.x2, geom.y2);

      case "axis":
        // 무한선 — direction 방향 무한 perpendicular. snapRadius 안에서만 매칭됨.
        return geom.direction === "h"
          ? { x: pos.x, y: 0, type: "perpendicular" }
          : { x: 0, y: pos.y, type: "perpendicular" };

      case "circle":
        return this._snapToCircleEdge(pos, geom.cx, geom.cy, geom.r);

      case "arc":
        return this._snapToArcEdge(pos, geom.cx, geom.cy, geom.r, geom.startAngle, geom.endAngle);

      case "ellipse":
        return this._snapToEllipseEdge(pos, geom.cx, geom.cy, geom.rx, geom.ry, geom.rotation);

      default:
        return null;
    }
  }

  // 선분 위 수선의 발 (0 ≤ t ≤ 1 범위)
  private _snapToLineSegment(
    pos: { x: number; y: number },
    x1: number, y1: number, x2: number, y2: number,
  ): SnapResult {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) return null;

    const t = ((pos.x - x1) * dx + (pos.y - y1) * dy) / lenSq;
    // 끝점/중점 근처는 이산 스냅이 처리하므로 여기서는 내부만
    if (t <= 0.02 || t >= 0.98) return null;
    // 중점 근처도 제외 (midpoint 스냅이 처리)
    if (Math.abs(t - 0.5) < 0.02) return null;

    return {
      x: x1 + t * dx,
      y: y1 + t * dy,
      type: "perpendicular",
    };
  }

  // 원 둘레 위 최근점
  private _snapToCircleEdge(
    pos: { x: number; y: number },
    cx: number, cy: number, r: number,
  ): SnapResult {
    const dx = pos.x - cx;
    const dy = pos.y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-10) return null;

    // 사분점 근처는 이산 스냅이 처리하므로 제외
    const angle = Math.atan2(dy, dx);
    const normalizedAngle = ((angle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    if (normalizedAngle < 0.05 || normalizedAngle > Math.PI / 2 - 0.05) return null;

    return {
      x: cx + (dx / dist) * r,
      y: cy + (dy / dist) * r,
      type: "nearest",
      sourceGeomType: "circle",
    };
  }

  // 호 둘레 위 최근점
  private _snapToArcEdge(
    pos: { x: number; y: number },
    cx: number, cy: number, r: number,
    startAngle: number, endAngle: number,
  ): SnapResult {
    const dx = pos.x - cx;
    const dy = pos.y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-10) return null;

    const angle = Math.atan2(dy, dx);

    // 호 범위 내인지 확인
    let sweep = endAngle - startAngle;
    if (sweep <= 0) sweep += Math.PI * 2;

    // [0, 2π) 범위로 완전 정규화
    const relAngle = ((angle - startAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    if (relAngle > sweep) return null;

    // 시작/끝 근처는 이산 스냅이 처리
    if (relAngle < 0.05 || relAngle > sweep - 0.05) return null;

    return {
      x: cx + (dx / dist) * r,
      y: cy + (dy / dist) * r,
      type: "nearest",
      sourceGeomType: "arc",
    };
  }

  // 타원 둘레 위 최근점
  private _snapToEllipseEdge(
    pos: { x: number; y: number },
    cx: number, cy: number, rx: number, ry: number, rotation: number,
  ): SnapResult {
    // 점을 타원 로컬 좌표로 변환 (rotation 역회전)
    const dx = pos.x - cx;
    const dy = pos.y - cy;
    const cosR = Math.cos(-rotation);
    const sinR = Math.sin(-rotation);
    const lx = dx * cosR - dy * sinR;
    const ly = dx * sinR + dy * cosR;

    const dist = Math.hypot(lx, ly);
    if (dist < 1e-10) return null;

    // 가장 가까운 타원 위 점 근사 (각도 기반)
    const angle = Math.atan2(ly, lx);
    const ex = rx * Math.cos(angle);
    const ey = ry * Math.sin(angle);

    // 로컬 → 월드 변환 (rotation 적용)
    const cosRf = Math.cos(rotation);
    const sinRf = Math.sin(rotation);
    const wx = cx + ex * cosRf - ey * sinRf;
    const wy = cy + ex * sinRf + ey * cosRf;

    return {
      x: wx, y: wy,
      type: "nearest",
      sourceGeomType: "ellipse",
    };
  }

  // 기하를 그것이 지나는 SpatialGrid 칸마다 넣는다. 이산 후보점(끝점·중점·중심·사분점)을 넣고, 선·원·호·타원은
  // 몸통·둘레 위를 step 간격으로 찍어 넣는다. AABB 중심·모서리만 넣으면 긴 선의 몸통이나 큰 원의 둘레 근처에서
  // 기하가 후보에 오르지 않아 수선의 발·교차점·nearest·접선 스냅이 빠졌다.
  // step 을 칸 크기의 절반(= searchRadius) 으로 두면, 커서에서 snapRadius 안을 지나는 기하는 커서에서
  // snapRadius + step/2 (< searchRadius) 안에 표본이 있어 queryRadius 가 반드시 그 칸을 본다.
  // 표본이 MAX_GRID_SAMPLES 를 넘으면 넣지 않고 false — 호출측이 늘 후보로 둔다.
  private _insertIntoGrid(grid: SpatialGrid<number>, geom: SerializedGeometry, index: number, step: number): boolean {
    let length = 0;
    let at: ((t: number) => { x: number; y: number }) | null = null;
    switch (geom.type) {
      case "line":
        length = Math.hypot(geom.x2 - geom.x1, geom.y2 - geom.y1);
        at = (t) => ({ x: geom.x1 + (geom.x2 - geom.x1) * t, y: geom.y1 + (geom.y2 - geom.y1) * t });
        break;
      case "circle":
        length = 2 * Math.PI * geom.r;
        at = (t) => ({ x: geom.cx + geom.r * Math.cos(2 * Math.PI * t), y: geom.cy + geom.r * Math.sin(2 * Math.PI * t) });
        break;
      case "arc": {
        let sweep = geom.endAngle - geom.startAngle;
        if (sweep <= 0) sweep += Math.PI * 2;
        length = sweep * geom.r;
        at = (t) => {
          const a = geom.startAngle + sweep * t;
          return { x: geom.cx + geom.r * Math.cos(a), y: geom.cy + geom.r * Math.sin(a) };
        };
        break;
      }
      case "ellipse": {
        // 매개변수 간격 × 긴 반지름이 둘레 위 간격의 상한이라 긴 반지름 원의 둘레로 표본 수를 정한다
        length = 2 * Math.PI * Math.max(geom.rx, geom.ry);
        const cosR = Math.cos(geom.rotation);
        const sinR = Math.sin(geom.rotation);
        at = (t) => {
          const ex = geom.rx * Math.cos(2 * Math.PI * t);
          const ey = geom.ry * Math.sin(2 * Math.PI * t);
          return { x: geom.cx + ex * cosR - ey * sinR, y: geom.cy + ex * sinR + ey * cosR };
        };
        break;
      }
    }

    const n = at ? Math.ceil(length / step) : 0;
    if (n > MAX_GRID_SAMPLES) return false;

    for (const c of this._getSnapCandidates(geom, geom.id)) grid.insert(c.x, c.y, index);
    if (at) {
      for (let k = 0; k <= n; k++) {
        const p = at(n > 0 ? k / n : 0);
        grid.insert(p.x, p.y, index);
      }
    }
    return true;
  }

  // 그리드에 넣지 못한 큰 기하(선·원·호·타원)가 커서에서 radius 안에 있는지 — 몸통·둘레까지의 거리나
  // 중심까지의 거리로 본다. 연장선을 뺀 스냅 후보는 모두 몸통·둘레 위이거나 중심이라 빠지는 스냅이 없고,
  // 연장선은 그리드에 넣은 기하와 같게 끝점 근처에서만 잡힌다.
  // 호·타원은 넉넉히(원 전체·두 반지름 사이 고리) 보고, 그려지지 않은 쪽은 후보 평가에서 걸러진다.
  private _isNearWideGeometry(pos: { x: number; y: number }, geom: SerializedGeometry, radius: number): boolean {
    switch (geom.type) {
      case "line": {
        const dx = geom.x2 - geom.x1;
        const dy = geom.y2 - geom.y1;
        const lenSq = dx * dx + dy * dy;
        const t = lenSq > 0 ? Math.max(0, Math.min(1, ((pos.x - geom.x1) * dx + (pos.y - geom.y1) * dy) / lenSq)) : 0;
        return Math.hypot(pos.x - (geom.x1 + t * dx), pos.y - (geom.y1 + t * dy)) <= radius;
      }
      case "circle":
      case "arc": {
        const d = Math.hypot(pos.x - geom.cx, pos.y - geom.cy);
        return Math.abs(d - geom.r) <= radius || d <= radius;
      }
      case "ellipse": {
        const d = Math.hypot(pos.x - geom.cx, pos.y - geom.cy);
        const inRing = d >= Math.min(geom.rx, geom.ry) - radius && d <= Math.max(geom.rx, geom.ry) + radius;
        return inRing || d <= radius;
      }
      default:
        return true;
    }
  }

  private _getSnapCandidates(geom: SerializedGeometry, geomId: string): NonNullable<SnapResult>[] {
    const results: NonNullable<SnapResult>[] = [];

    switch (geom.type) {
      case "point":
        results.push({ x: geom.x, y: geom.y, type: "endpoint", sourceGeomId: geomId, sourceVertexIndex: 0 });
        break;

      case "line":
        // 끝점 2개 + 중점 1개
        results.push({ x: geom.x1, y: geom.y1, type: "endpoint", sourceGeomId: geomId, sourceVertexIndex: 0 });
        results.push({ x: geom.x2, y: geom.y2, type: "endpoint", sourceGeomId: geomId, sourceVertexIndex: 1 });
        results.push({
          x: (geom.x1 + geom.x2) / 2,
          y: (geom.y1 + geom.y2) / 2,
          type: "midpoint",
          sourceGeomId: geomId,
        });
        break;

      case "axis":
        // 무한선 — 가짜 endpoint/midpoint 없음. perpendicular 만 _getContinuousSnap 에서 처리.
        break;

      case "circle":
        // 중심 + 사분점
        results.push({ x: geom.cx, y: geom.cy, type: "center", extent: geom.r, sourceGeomType: "circle", sourceGeomId: geomId, sourceVertexIndex: 0 });
        // 사분점은 vertex entity 가 아닌 circle 둘레의 special point — sourceGeomId/Type 부여해
        // DrawTool 이 point_on_circle 자동 부여 (CAD 표준: quadrant snap = circle 위 점).
        // sourceVertexIndex 는 의도적으로 미지정 — coincident 가 아닌 point_on_X 라우팅 표시.
        results.push({ x: geom.cx + geom.r, y: geom.cy, type: "endpoint", sourceGeomId: geomId, sourceGeomType: "circle" });
        results.push({ x: geom.cx - geom.r, y: geom.cy, type: "endpoint", sourceGeomId: geomId, sourceGeomType: "circle" });
        results.push({ x: geom.cx, y: geom.cy + geom.r, type: "endpoint", sourceGeomId: geomId, sourceGeomType: "circle" });
        results.push({ x: geom.cx, y: geom.cy - geom.r, type: "endpoint", sourceGeomId: geomId, sourceGeomType: "circle" });
        break;

      case "arc":
        // 중심 + 시작/끝점
        results.push({ x: geom.cx, y: geom.cy, type: "center", extent: geom.r, sourceGeomType: "arc", sourceGeomId: geomId, sourceVertexIndex: 0 });
        results.push({
          x: geom.cx + geom.r * Math.cos(geom.startAngle),
          y: geom.cy + geom.r * Math.sin(geom.startAngle),
          type: "endpoint",
          sourceGeomId: geomId,
          sourceVertexIndex: 1,
        });
        results.push({
          x: geom.cx + geom.r * Math.cos(geom.endAngle),
          y: geom.cy + geom.r * Math.sin(geom.endAngle),
          type: "endpoint",
          sourceGeomId: geomId,
          sourceVertexIndex: 2,
        });
        break;

      case "curve": {
        const pts = geom.points;
        if (pts.length > 0) {
          // 시작점/끝점
          results.push({ x: pts[0].x, y: pts[0].y, type: "endpoint", sourceGeomId: geomId, sourceVertexIndex: 0 });
          if (pts.length > 1) {
            results.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, type: "endpoint", sourceGeomId: geomId, sourceVertexIndex: pts.length - 1 });
          }
        }
        break;
      }

      case "ellipse":
        // 중심 스냅 (endpoint처럼 취급)
        results.push({
          x: geom.cx, y: geom.cy, type: "center",
          extent: Math.max(geom.rx, geom.ry),
          sourceGeomType: "ellipse", sourceGeomId: geomId, sourceVertexIndex: 0,
        });
        break;
    }

    return results;
  }
}

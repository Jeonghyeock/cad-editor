// Chamfer 도구: 꼭짓점 클릭 / 두 선 순차 클릭 / 교차점 근처 클릭 → 거리 입력 → chamfer 선분 생성 + 원본 트림
// 3-상태 머신 + 비대칭 거리 지원

import type { ChamferParamInputMode, SerializedGeometry, SketchDrawToolType } from "../../Setup.type";
import { generateConstraintId } from "../../utils/idGenerator";

import { CompoundSketchCommand } from "../commands/CompoundSketchCommand";
import type { GeomRemap, VertexRemap } from "../commands/CompoundSketchCommand";
import type { SketchConstraint } from "../constraints/SketchConstraint.type";
import { lineLineIntersectionUnbounded } from "../GeometryIntersection";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapType } from "../SnapEngine";

import { DrawTool } from "./DrawTool";
import { determineCornerQuadrant, findCornerNearPoint, findLinesAtVertex, getKeepDirFromT, getKeepDirFromVertex, isRefOrConstruction } from "./editToolUtils";

// 교차점 탐색 허용 거리 (히트 반경의 배수)
const INTERSECTION_SEARCH_MULTIPLIER = 3;

export type ChamferPendingState = {
  line1: SerializedGeometry & { type: "line" };
  line2: SerializedGeometry & { type: "line" };
  intersection: { x: number; y: number; t1: number; t2: number };
  keepDir1: 1 | -1;
  keepDir2: 1 | -1;
};

type ChamferState = "idle" | "line1-selected" | "pending-input";

// Chamfer 트림 모드
export type ChamferTrimMode = "trim-all" | "trim-first" | "no-trim";

// ChamferParamInputMode는 Input.type.ts에서 import

export class ChamferDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "chamfer";


  selectionOnly = true;
  // 스냅 필터: endpoint, origin, nearest만 허용
  snapFilter: Set<SnapType> | null = new Set<SnapType>(["endpoint", "origin", "nearest"]);

  // Chamfer 대기 상태 (두 선 + 교차점 확정 후 거리 입력 대기)
  pendingChamfer: ChamferPendingState | null = null;

  // 거리 입력 요청 콜백
  onRequestDistanceInput: ((state: ChamferPendingState) => void) | null = null;

  // 트림 모드 (외부에서 설정, 기본 trim-all)
  trimMode: ChamferTrimMode = "trim-all";

  // 파라미터 모드 (Gap 7: two-distances / distance-angle / angle-hypotenuse)
  paramInputMode: ChamferParamInputMode = "two-distances";

  private _state: ChamferState = "idle";
  private _line1: (SerializedGeometry & { type: "line" }) | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    const hitRadius = this.inferenceRadius || 5;

    if (this._state === "pending-input") return;

    if (this._state === "idle") {
      this._handleIdleClick(store, rawPos, hitRadius);
    } else if (this._state === "line1-selected") {
      this._handleLine1SelectedClick(store, rawPos, hitRadius);
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    if (this._state === "pending-input") return;

    const hitRadius = this.inferenceRadius || 5;

    if (this._state === "idle") {
      this._handleIdleMove(store, rawPos, hitRadius);
    } else if (this._state === "line1-selected") {
      this._handleLine1SelectedMove(store, rawPos, hitRadius);
    }

    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // chamfer는 pointerDown에서 처리
  }

  onKeyDown(store: SketchGeometryStore, event: KeyboardEvent): void {
    if (event.key === "Escape") {
      if (this._state === "line1-selected") {
        this._state = "idle";
        this._line1 = null;
        this.preview = null;
        this.previews = [];
        this.inferenceLines = [];
        this.lockedInference = null;
        store.requestRender();
      } else {
        this.cancel();
        store.requestRender();
      }
    }
  }

  hasPendingWork(): boolean {
    return this.pendingChamfer !== null || this._state !== "idle";
  }

  cancel(): void {
    super.cancel();
    this.pendingChamfer = null;
    this._state = "idle";
    this._line1 = null;
  }

  // 파라미터 모드에 따라 D1, D2를 산출하는 헬퍼
  // distance-angle: D1 = distance, angle = distance2 (도), D2 = D1 * tan(angle)
  // angle-hypotenuse: angle = distance (도), hyp = distance2, D1 = hyp * cos(angle), D2 = hyp * sin(angle)
  resolveDistances(distance: number, distance2?: number): { d1: number; d2: number } {
    if (this.paramInputMode === "distance-angle") {
      const d1 = distance;
      const angleRad = ((distance2 ?? 45) * Math.PI) / 180;
      return { d1, d2: d1 * Math.tan(angleRad) };
    }
    if (this.paramInputMode === "angle-hypotenuse") {
      const angleRad = (distance * Math.PI) / 180;
      const hyp = distance2 ?? distance;
      return { d1: hyp * Math.cos(angleRad), d2: hyp * Math.sin(angleRad) };
    }
    // two-distances (기본)
    return { d1: distance, d2: distance2 ?? distance };
  }

  // 거리 확정 시 호출 (외부에서). distance2 있으면 line2에 distance2 적용
  applyChamfer(store: SketchGeometryStore, distance: number, distance2?: number): void {
    if (!this.pendingChamfer) return;

    const { line1, line2, intersection, keepDir1, keepDir2 } = this.pendingChamfer;
    const P = intersection;
    const { d1: resolvedD1, d2: resolvedD2 } = this.resolveDistances(distance, distance2);
    const d2 = resolvedD2;
    const d1 = resolvedD1;

    // 각 선분 위에서 교차점에서 distance만큼 떨어진 chamfer 점 계산
    const cp1 = this._getChamferPoint(line1, P, keepDir1, d1);
    const cp2 = this._getChamferPoint(line2, P, keepDir2, d2);

    if (!cp1 || !cp2) {
      this.cancel();
      return;
    }

    // chamfer 점이 원본 선분 범위 내인지 검증
    if (!this._isPointOnSegment(cp1, line1) || !this._isPointOnSegment(cp2, line2)) {
      this.cancel();
      return;
    }

    // 새 기하 생성 + 구속 재매핑
    const newGeoms: SerializedGeometry[] = [];
    const vertexRemaps: VertexRemap[] = [];
    const geomRemaps: GeomRemap[] = [];
    const removedGeoms: SerializedGeometry[] = [];

    // 트림 모드에 따라 제거/트림할 선 결정
    const trimLine1 = this.trimMode === "trim-all" || this.trimMode === "trim-first";
    const trimLine2 = this.trimMode === "trim-all";

    // 트림된 line1
    let result1: ReturnType<typeof this._trimLineToPoint> = null;
    if (trimLine1) {
      result1 = this._trimLineToPoint(line1, P, cp1, keepDir1);
      if (result1) {
        newGeoms.push(result1.geom);
        vertexRemaps.push(...result1.vertexRemaps);
        geomRemaps.push(result1.geomRemap);
      }
      removedGeoms.push(line1);
    }

    // 트림된 line2
    let result2: ReturnType<typeof this._trimLineToPoint> = null;
    if (trimLine2) {
      result2 = this._trimLineToPoint(line2, P, cp2, keepDir2);
      if (result2) {
        newGeoms.push(result2.geom);
        vertexRemaps.push(...result2.vertexRemaps);
        geomRemaps.push(result2.geomRemap);
      }
      removedGeoms.push(line2);
    }

    // Chamfer 선분
    const chamferId = this._generateId();
    newGeoms.push({
      type: "line",
      id: chamferId,
      x1: cp1.x,
      y1: cp1.y,
      x2: cp2.x,
      y2: cp2.y,
    });

    // 트림된 선 끝점과 chamfer 선 끝점 사이 coincident 구속 생성
    const addedConstraints: SketchConstraint[] = [];
    if (result1) {
      addedConstraints.push({
        type: "coincident",
        id: generateConstraintId("auto-cst-chamfer"),
        pointA: { geomId: result1.geom.id, vertexIndex: 1 },
        pointB: { geomId: chamferId, vertexIndex: 0 },
      });
    }
    if (result2) {
      addedConstraints.push({
        type: "coincident",
        id: generateConstraintId("auto-cst-chamfer"),
        pointA: { geomId: result2.geom.id, vertexIndex: 1 },
        pointB: { geomId: chamferId, vertexIndex: 1 },
      });
    }

    // no-trim / trim-first: 트림하지 않은 선에 coincident 구속
    if (!trimLine1) {
      addedConstraints.push({
        type: "coincident",
        id: generateConstraintId("auto-cst-chamfer-notrim"),
        pointA: { geomId: chamferId, vertexIndex: 0 },
        pointB: { geomId: line1.id, vertexIndex: keepDir1 > 0 ? 1 : 0 },
      });
    }
    if (!trimLine2) {
      addedConstraints.push({
        type: "coincident",
        id: generateConstraintId("auto-cst-chamfer-notrim"),
        pointA: { geomId: chamferId, vertexIndex: 1 },
        pointB: { geomId: line2.id, vertexIndex: keepDir2 > 0 ? 1 : 0 },
      });
    }

    // 주의: chamfer 의 auto-dimension 은 의도적으로 추가하지 않음.
    // CATIA 의 D1/D2 는 원본 corner 점 ↔ chamfer 점 거리지만 corner 는 trim 으로 사라지므로
    // flat constraint 모델에선 정확히 표현 불가. trimmed line 의 line_length 로 대체하면
    // (a) 원본 line 의 기존 line_length 와 cascade-remap 충돌
    // (b) 사용자 입력값(D1) 과 표시값(잔여 길이)이 달라 혼란.
    // → 필요 시 사용자가 수동으로 dimension 추가.

    store.execute(new CompoundSketchCommand(
      removedGeoms,
      newGeoms,
      [],
      addedConstraints,
      vertexRemaps,
      geomRemaps,
    ));

    this.pendingChamfer = null;
    this._state = "idle";
    this._line1 = null;
    this.preview = null;
    this.previews = [];
    this.inferenceLines = [];
    store.requestRender();
  }

  // 프리뷰 업데이트: 현재 거리 값으로 결과 미리보기 (비대칭 지원)
  computePreview(store: SketchGeometryStore, distance: number, distance2?: number): void {
    if (!this.pendingChamfer || distance <= 0) {
      this.previews = [];
      store.requestRender();
      return;
    }

    const { line1, line2, intersection, keepDir1, keepDir2 } = this.pendingChamfer;
    const P = intersection;
    const { d1: resolvedD1, d2: resolvedD2 } = this.resolveDistances(distance, distance2);

    const cp1 = this._getChamferPoint(line1, P, keepDir1, resolvedD1);
    const cp2 = this._getChamferPoint(line2, P, keepDir2, resolvedD2);

    if (!cp1 || !cp2 || !this._isPointOnSegment(cp1, line1) || !this._isPointOnSegment(cp2, line2)) {
      this.previews = [];
      store.requestRender();
      return;
    }

    const result: SerializedGeometry[] = [];

    // 트림 모드별 프리뷰
    const showTrim1 = this.trimMode === "trim-all" || this.trimMode === "trim-first";
    const showTrim2 = this.trimMode === "trim-all";

    if (showTrim1) {
      const trim1 = this._computeTrimmedLine(line1, cp1, keepDir1);
      if (trim1) result.push(trim1);
    }
    if (showTrim2) {
      const trim2 = this._computeTrimmedLine(line2, cp2, keepDir2);
      if (trim2) result.push(trim2);
    }

    // chamfer 선분
    result.push({
      type: "line",
      id: "__chamfer_result__",
      x1: cp1.x, y1: cp1.y,
      x2: cp2.x, y2: cp2.y,
    });

    this.previews = result;
    store.requestRender();
  }

  // --- idle 상태 클릭 처리 ---

  private _handleIdleClick(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    hitRadius: number,
  ): void {
    // 1. 꼭짓점 클릭
    const vertex = store.hitTestVertexAll(rawPos, hitRadius);
    if (vertex) {
      const twoLines = findLinesAtVertex(store, vertex);
      if (twoLines) {
        const [l1, l2] = twoLines;
        const hit = lineLineIntersectionUnbounded(
          l1.x1, l1.y1, l1.x2, l1.y2,
          l2.x1, l2.y1, l2.x2, l2.y2,
        );
        if (hit) {
          const keepDir1 = getKeepDirFromVertex(l1, vertex);
          const keepDir2 = getKeepDirFromVertex(l2, vertex);
          this._enterPendingInput(store, l1, l2, hit, keepDir1, keepDir2);
          return;
        }
      }
    }

    // 2. line body 클릭
    const hitId = store.hitTest(rawPos, hitRadius);
    if (hitId) {
      const geom = store.geometries.get(hitId);
      if (geom && geom.type === "line" && !isRefOrConstruction(geom)) {
        this._state = "line1-selected";
        this._line1 = geom;
        this.previews = [{ ...geom, id: `__chamfer_hl_${geom.id}__` }];
        store.requestRender();
        return;
      }
    }

    // 3. 기존 교차점 근처 클릭 폴백
    const searchRadius = hitRadius * INTERSECTION_SEARCH_MULTIPLIER;
    const cornerResult = findCornerNearPoint(store, rawPos, searchRadius);
    if (cornerResult) {
      const keepDir1 = getKeepDirFromT(cornerResult.intersection.t1);
      const keepDir2 = getKeepDirFromT(cornerResult.intersection.t2);
      this._enterPendingInput(store, cornerResult.line1, cornerResult.line2, cornerResult.intersection, keepDir1, keepDir2);
    }
  }

  // --- line1-selected 상태 클릭 처리 ---

  private _handleLine1SelectedClick(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    hitRadius: number,
  ): void {
    if (!this._line1) return;

    const hitId = store.hitTest(rawPos, hitRadius);
    if (!hitId) return;

    const geom = store.geometries.get(hitId);
    if (!geom || geom.type !== "line" || isRefOrConstruction(geom)) return;
    if (geom.id === this._line1.id) return;

    const line2 = geom;
    const hit = lineLineIntersectionUnbounded(
      this._line1.x1, this._line1.y1, this._line1.x2, this._line1.y2,
      line2.x1, line2.y1, line2.x2, line2.y2,
    );
    if (!hit) return;

    const { keepDir1, keepDir2 } = determineCornerQuadrant(
      this._line1, line2, hit, rawPos,
    );

    this._enterPendingInput(store, this._line1, line2, hit, keepDir1, keepDir2);
  }

  // --- idle 상태 마우스 이동 처리 ---

  private _handleIdleMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    hitRadius: number,
  ): void {
    // vertex 호버
    const vertex = store.hitTestVertexAll(rawPos, hitRadius);
    if (vertex) {
      const twoLines = findLinesAtVertex(store, vertex);
      if (twoLines) {
        store.hoveredItem = { kind: "vertex", geomId: vertex.geomId, vertexIndex: vertex.vertexIndex, x: vertex.x, y: vertex.y };
        this.preview = {
          type: "point",
          id: "__chamfer_hover__",
          x: vertex.x,
          y: vertex.y,
        };
        this.previews = [
          { ...twoLines[0], id: `__chamfer_hl_${twoLines[0].id}__` },
          { ...twoLines[1], id: `__chamfer_hl_${twoLines[1].id}__` },
        ];
        return;
      }
    }

    // line 호버
    const hitId = store.hitTest(rawPos, hitRadius);
    if (hitId) {
      const geom = store.geometries.get(hitId);
      if (geom && geom.type === "line" && !isRefOrConstruction(geom)) {
        store.hoveredItem = { kind: "geometry", geomId: hitId };
        this.preview = null;
        this.previews = [{ ...geom, id: `__chamfer_hl_${geom.id}__` }];
        return;
      }
    }

    // 교차점 근처 호버 (하위 호환)
    const searchRadius = hitRadius * INTERSECTION_SEARCH_MULTIPLIER;
    const cornerResult = findCornerNearPoint(store, rawPos, searchRadius);
    if (cornerResult) {
      store.hoveredItem = { kind: "geometry", geomId: cornerResult.line1.id };
      this.preview = {
        type: "point",
        id: "__chamfer_hover__",
        x: cornerResult.intersection.x,
        y: cornerResult.intersection.y,
      };
      this.previews = [
        { ...cornerResult.line1, id: `__chamfer_hl_${cornerResult.line1.id}__` },
        { ...cornerResult.line2, id: `__chamfer_hl_${cornerResult.line2.id}__` },
      ];
      return;
    }

    store.hoveredItem = null;
    this.preview = null;
    this.previews = [];
  }

  // --- line1-selected 상태 마우스 이동 처리 ---

  private _handleLine1SelectedMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    hitRadius: number,
  ): void {
    if (!this._line1) return;

    const line1Preview: SerializedGeometry = { ...this._line1, id: `__chamfer_hl_${this._line1.id}__` };

    const hitId = store.hitTest(rawPos, hitRadius);
    if (hitId && hitId !== this._line1.id) {
      const geom = store.geometries.get(hitId);
      if (geom && geom.type === "line" && !isRefOrConstruction(geom)) {
        const hit = lineLineIntersectionUnbounded(
          this._line1.x1, this._line1.y1, this._line1.x2, this._line1.y2,
          geom.x1, geom.y1, geom.x2, geom.y2,
        );
        if (hit) {
          this.preview = {
            type: "point",
            id: "__chamfer_hover__",
            x: hit.x,
            y: hit.y,
          };
          this.previews = [
            line1Preview,
            { ...geom, id: `__chamfer_hl_${geom.id}__` },
          ];
          return;
        }
      }
    }

    this.preview = null;
    this.previews = [line1Preview];
  }

  // --- pending-input 상태 전환 ---

  private _enterPendingInput(
    store: SketchGeometryStore,
    line1: SerializedGeometry & { type: "line" },
    line2: SerializedGeometry & { type: "line" },
    intersection: { x: number; y: number; t1: number; t2: number },
    keepDir1: 1 | -1,
    keepDir2: 1 | -1,
  ): void {
    this.pendingChamfer = { line1, line2, intersection, keepDir1, keepDir2 };
    this._state = "pending-input";
    this._line1 = null;

    this.preview = {
      type: "point",
      id: "__chamfer_preview__",
      x: intersection.x,
      y: intersection.y,
    };
    store.requestRender();

    this.onRequestDistanceInput?.(this.pendingChamfer);
  }

  // --- 내부 유틸리티 ---

  // 교차점에서 distance만큼 떨어진 선분 위의 점 (keepDir 기반)
  private _getChamferPoint(
    line: { x1: number; y1: number; x2: number; y2: number },
    P: { x: number; y: number },
    keepDir: 1 | -1,
    distance: number,
  ): { x: number; y: number } | null {
    const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;

    const ux = dx / len, uy = dy / len;
    return {
      x: P.x + keepDir * ux * distance,
      y: P.y + keepDir * uy * distance,
    };
  }

  // 프리뷰용 트림된 line 계산 (keepDir 기반)
  private _computeTrimmedLine(
    line: SerializedGeometry & { type: "line" },
    chamferPt: { x: number; y: number },
    keepDir: 1 | -1,
  ): SerializedGeometry | null {
    const farX = keepDir > 0 ? line.x2 : line.x1;
    const farY = keepDir > 0 ? line.y2 : line.y1;
    const trimLen = Math.hypot(farX - chamferPt.x, farY - chamferPt.y);
    if (trimLen < 1e-6) return null;
    return {
      type: "line",
      id: `__chamfer_trim_${line.id}__`,
      x1: farX, y1: farY,
      x2: chamferPt.x, y2: chamferPt.y,
    };
  }

  // 원본 선분을 chamfer 점까지 트림 + 구속 재매핑 (keepDir 기반)
  private _trimLineToPoint(
    line: SerializedGeometry & { type: "line" },
    _P: { x: number; y: number },
    chamferPt: { x: number; y: number },
    keepDir: 1 | -1,
  ): { geom: SerializedGeometry; vertexRemaps: VertexRemap[]; geomRemap: GeomRemap } | null {
    const farX = keepDir > 0 ? line.x2 : line.x1;
    const farY = keepDir > 0 ? line.y2 : line.y1;
    const farVertexIndex = keepDir > 0 ? 1 : 0;

    const trimLen = Math.hypot(farX - chamferPt.x, farY - chamferPt.y);
    if (trimLen < 1e-6) return null;

    const newId = this._generateId();
    const geom: SerializedGeometry = {
      type: "line",
      id: newId,
      x1: farX,
      y1: farY,
      x2: chamferPt.x,
      y2: chamferPt.y,
    };

    const vertexRemaps: VertexRemap[] = [
      { oldGeomId: line.id, oldVertexIndex: farVertexIndex, newGeomId: newId, newVertexIndex: 0 },
    ];
    const geomRemap: GeomRemap = { oldGeomId: line.id, newGeomId: newId };

    return { geom, vertexRemaps, geomRemap };
  }

  private _isPointOnSegment(
    p: { x: number; y: number },
    line: { x1: number; y1: number; x2: number; y2: number },
  ): boolean {
    const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-12) return false;
    const t = ((p.x - line.x1) * dx + (p.y - line.y1) * dy) / lenSq;
    return t >= -0.01 && t <= 1.01;
  }

}

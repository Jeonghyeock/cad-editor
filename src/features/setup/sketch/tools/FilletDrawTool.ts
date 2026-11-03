// Fillet 도구: 꼭짓점 클릭 / 두 선 순차 클릭 / 교차점 근처 클릭 → 반경 입력 → 접선 호 생성 + 원본 트림
// CATIA Corner 도구와 동일 동작 (3-상태 머신)

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";
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

export type FilletPendingState = {
  line1: SerializedGeometry & { type: "line" };
  line2: SerializedGeometry & { type: "line" };
  intersection: { x: number; y: number; t1: number; t2: number };
  keepDir1: 1 | -1;  // line1 보존 방향 (1 = x1→x2 방향, -1 = x2→x1 방향)
  keepDir2: 1 | -1;
};

type FilletState = "idle" | "line1-selected" | "pending-input";

// Fillet 트림 모드
export type FilletTrimMode = "trim-all" | "trim-first" | "no-trim";

export class FilletDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "fillet";


  selectionOnly = true;
  // 스냅 필터: endpoint, origin, nearest만 허용
  snapFilter: Set<SnapType> | null = new Set<SnapType>(["endpoint", "origin", "nearest"]);

  // Fillet 대기 상태 (두 선 + 교차점 확정 후 반경 입력 대기)
  pendingFillet: FilletPendingState | null = null;

  // 반경 입력 요청 콜백 (InputCanvas에서 설정)
  onRequestRadiusInput: ((state: FilletPendingState) => void) | null = null;

  // 트림 모드 (외부에서 설정, 기본 trim-all)
  trimMode: FilletTrimMode = "trim-all";

  private _state: FilletState = "idle";
  private _line1: (SerializedGeometry & { type: "line" }) | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    const hitRadius = this.inferenceRadius || 5;

    if (this._state === "pending-input") return; // 입력 대기 중 클릭 무시

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
    // fillet은 pointerDown에서 처리
  }

  onKeyDown(store: SketchGeometryStore, event: KeyboardEvent): void {
    if (event.key === "Escape") {
      if (this._state === "line1-selected") {
        // line1 선택 취소 → idle
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
    return this.pendingFillet !== null || this._state !== "idle";
  }

  cancel(): void {
    super.cancel();
    this.pendingFillet = null;
    this._state = "idle";
    this._line1 = null;
  }

  // 반경 확정 시 호출 (외부에서)
  applyFillet(store: SketchGeometryStore, radius: number): void {
    if (!this.pendingFillet) return;

    const { line1, line2, intersection, keepDir1, keepDir2 } = this.pendingFillet;
    const P = intersection;

    // 두 직선의 방향 벡터
    const d1 = { x: line1.x2 - line1.x1, y: line1.y2 - line1.y1 };
    const d2 = { x: line2.x2 - line2.x1, y: line2.y2 - line2.y1 };
    const len1 = Math.hypot(d1.x, d1.y);
    const len2 = Math.hypot(d2.x, d2.y);
    if (len1 < 1e-9 || len2 < 1e-9) { this.cancel(); return; }

    // keepDir 기반으로 보존 방향 단위벡터 결정
    const dir1 = { x: (d1.x / len1) * keepDir1, y: (d1.y / len1) * keepDir1 };
    const dir2 = { x: (d2.x / len2) * keepDir2, y: (d2.y / len2) * keepDir2 };

    // 두 선 사이 각도
    const cosTheta = dir1.x * dir2.x + dir1.y * dir2.y;
    if (cosTheta > 1 - 1e-9) { this.cancel(); return; } // 평행
    const sinHalf = Math.sqrt((1 - cosTheta) / 2);
    const cosHalf = Math.sqrt((1 + cosTheta) / 2);
    if (sinHalf < 1e-9) { this.cancel(); return; }

    // 접선점 거리: P에서 r * cos(θ/2) / sin(θ/2)
    const tangentDist = radius * cosHalf / sinHalf;

    // 접선점
    const tp1 = { x: P.x + dir1.x * tangentDist, y: P.y + dir1.y * tangentDist };
    const tp2 = { x: P.x + dir2.x * tangentDist, y: P.y + dir2.y * tangentDist };

    // 접선점이 원본 선분 범위 내인지 검증
    if (!this._isPointOnSegment(tp1, line1) || !this._isPointOnSegment(tp2, line2)) {
      this.cancel();
      return;
    }

    // 호 중심: 이등분선 방향으로 r/sin(θ/2)
    const bisector = { x: dir1.x + dir2.x, y: dir1.y + dir2.y };
    const bisLen = Math.hypot(bisector.x, bisector.y);
    if (bisLen < 1e-9) { this.cancel(); return; }
    const uBis = { x: bisector.x / bisLen, y: bisector.y / bisLen };
    const centerDist = radius / sinHalf;
    const cx = P.x + uBis.x * centerDist;
    const cy = P.y + uBis.y * centerDist;

    // 호 각도. 순서가 바뀌면(swapped) tp1 은 호의 끝점(vertex 2), tp2 는 시작점(vertex 1)에 놓인다
    const { startAngle, endAngle, swapped } = this._filletArcAngles(dir1, dir2, tp1, tp2, cx, cy);
    const arcVertexAtTp1 = swapped ? 2 : 1;
    const arcVertexAtTp2 = swapped ? 1 : 2;

    // 새 기하 생성 + 구속 재매핑
    const newGeoms: SerializedGeometry[] = [];
    const vertexRemaps: VertexRemap[] = [];
    const geomRemaps: GeomRemap[] = [];
    const removedGeoms: SerializedGeometry[] = [];

    // 트림 모드에 따라 제거/트림할 선 결정
    const trimLine1 = this.trimMode === "trim-all" || this.trimMode === "trim-first";
    const trimLine2 = this.trimMode === "trim-all";

    // 트림된 line1: 교차점에서 먼 쪽 끝점 ~ 접선점
    let result1: ReturnType<typeof this._trimLineToTangentPoint> = null;
    if (trimLine1) {
      result1 = this._trimLineToTangentPoint(line1, P, tp1, keepDir1);
      if (result1) {
        newGeoms.push(result1.geom);
        vertexRemaps.push(...result1.vertexRemaps);
        geomRemaps.push(result1.geomRemap);
      }
      removedGeoms.push(line1);
    }

    // 트림된 line2
    let result2: ReturnType<typeof this._trimLineToTangentPoint> = null;
    if (trimLine2) {
      result2 = this._trimLineToTangentPoint(line2, P, tp2, keepDir2);
      if (result2) {
        newGeoms.push(result2.geom);
        vertexRemaps.push(...result2.vertexRemaps);
        geomRemaps.push(result2.geomRemap);
      }
      removedGeoms.push(line2);
    }

    // no-trim: 원본 유지, 제거 없음
    if (this.trimMode === "no-trim") {
      // removedGeoms는 비어 있음
    } else if (this.trimMode === "trim-first" && !removedGeoms.includes(line2)) {
      // trim-first: line2는 제거하지 않음 (이미 처리됨)
    }

    // 호
    const arcId = this._generateId();
    newGeoms.push({
      type: "arc",
      id: arcId,
      cx, cy, r: radius,
      startAngle,
      endAngle,
    });

    // 트림된 선 끝점과 호 끝점 사이 coincident + tangent 구속 생성
    const addedConstraints: SketchConstraint[] = [];
    if (result1) {
      addedConstraints.push({
        type: "coincident",
        id: generateConstraintId("auto-cst-fillet"),
        pointA: { geomId: result1.geom.id, vertexIndex: 1 },
        pointB: { geomId: arcId, vertexIndex: arcVertexAtTp1 },
      });
      addedConstraints.push({
        type: "tangent",
        id: generateConstraintId("auto-cst-fillet-tan"),
        entityA: { geomId: result1.geom.id },
        entityB: { geomId: arcId },
      });
    }
    if (result2) {
      addedConstraints.push({
        type: "coincident",
        id: generateConstraintId("auto-cst-fillet"),
        pointA: { geomId: result2.geom.id, vertexIndex: 1 },
        pointB: { geomId: arcId, vertexIndex: arcVertexAtTp2 },
      });
      addedConstraints.push({
        type: "tangent",
        id: generateConstraintId("auto-cst-fillet-tan"),
        entityA: { geomId: result2.geom.id },
        entityB: { geomId: arcId },
      });
    }

    // no-trim / trim-first: 트림하지 않은 선의 가장 가까운 점에 coincident 구속
    if (!trimLine1) {
      addedConstraints.push({
        type: "coincident",
        id: generateConstraintId("auto-cst-fillet-notrim"),
        pointA: { geomId: arcId, vertexIndex: arcVertexAtTp1 },
        pointB: { geomId: line1.id, vertexIndex: keepDir1 > 0 ? 1 : 0 },
      });
    }
    if (!trimLine2) {
      addedConstraints.push({
        type: "coincident",
        id: generateConstraintId("auto-cst-fillet-notrim"),
        pointA: { geomId: arcId, vertexIndex: arcVertexAtTp2 },
        pointB: { geomId: line2.id, vertexIndex: keepDir2 > 0 ? 1 : 0 },
      });
    }

    // CATIA 식: fillet 의 radius 를 자동 dimension 으로 잠금
    addedConstraints.push({
      type: "radius",
      id: generateConstraintId("auto-cst-fillet-r"),
      circle: { geomId: arcId },
      value: radius,
    });

    store.execute(new CompoundSketchCommand(
      removedGeoms,
      newGeoms,
      [],
      addedConstraints,
      vertexRemaps,
      geomRemaps,
    ));

    this.pendingFillet = null;
    this._state = "idle";
    this._line1 = null;
    this.preview = null;
    this.previews = [];
    this.inferenceLines = [];
    store.requestRender();
  }

  // 프리뷰 업데이트: 현재 반경 값으로 결과 미리보기
  computePreview(store: SketchGeometryStore, radius: number): void {
    if (!this.pendingFillet || radius <= 0) {
      this.previews = [];
      store.requestRender();
      return;
    }

    const { line1, line2, intersection, keepDir1, keepDir2 } = this.pendingFillet;
    const P = intersection;

    const d1 = { x: line1.x2 - line1.x1, y: line1.y2 - line1.y1 };
    const d2 = { x: line2.x2 - line2.x1, y: line2.y2 - line2.y1 };
    const len1 = Math.hypot(d1.x, d1.y), len2 = Math.hypot(d2.x, d2.y);
    if (len1 < 1e-9 || len2 < 1e-9) { this.previews = []; store.requestRender(); return; }

    const dir1 = { x: (d1.x / len1) * keepDir1, y: (d1.y / len1) * keepDir1 };
    const dir2 = { x: (d2.x / len2) * keepDir2, y: (d2.y / len2) * keepDir2 };

    const cosTheta = dir1.x * dir2.x + dir1.y * dir2.y;
    if (cosTheta > 1 - 1e-9) { this.previews = []; store.requestRender(); return; }
    const sinHalf = Math.sqrt((1 - cosTheta) / 2);
    const cosHalf = Math.sqrt((1 + cosTheta) / 2);
    if (sinHalf < 1e-9) { this.previews = []; store.requestRender(); return; }

    const tangentDist = radius * cosHalf / sinHalf;
    const tp1 = { x: P.x + dir1.x * tangentDist, y: P.y + dir1.y * tangentDist };
    const tp2 = { x: P.x + dir2.x * tangentDist, y: P.y + dir2.y * tangentDist };

    if (!this._isPointOnSegment(tp1, line1) || !this._isPointOnSegment(tp2, line2)) {
      this.previews = [];
      store.requestRender();
      return;
    }

    const bisector = { x: dir1.x + dir2.x, y: dir1.y + dir2.y };
    const bisLen = Math.hypot(bisector.x, bisector.y);
    if (bisLen < 1e-9) { this.previews = []; store.requestRender(); return; }
    const uBis = { x: bisector.x / bisLen, y: bisector.y / bisLen };
    const centerDist = radius / sinHalf;
    const cx = P.x + uBis.x * centerDist;
    const cy = P.y + uBis.y * centerDist;

    const { startAngle, endAngle } = this._filletArcAngles(dir1, dir2, tp1, tp2, cx, cy);

    const result: SerializedGeometry[] = [];

    // 트림 모드별 프리뷰
    const showTrim1 = this.trimMode === "trim-all" || this.trimMode === "trim-first";
    const showTrim2 = this.trimMode === "trim-all";

    if (showTrim1) {
      const trim1 = this._computeTrimmedLine(line1, P, tp1, keepDir1);
      if (trim1) result.push(trim1);
    }
    if (showTrim2) {
      const trim2 = this._computeTrimmedLine(line2, P, tp2, keepDir2);
      if (trim2) result.push(trim2);
    }

    // fillet 호
    result.push({
      type: "arc",
      id: "__fillet_result__",
      cx, cy, r: radius,
      startAngle, endAngle,
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
    // 1. 꼭짓점 클릭 → 2선이 만나는 vertex 찾기
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
          // vertex 경로: vertex의 반대편이 보존 방향
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
        this.previews = [{ ...geom, id: `__fillet_hl_${geom.id}__` }];
        store.requestRender();
        return;
      }
    }

    // 3. 기존 교차점 근처 클릭 폴백
    const searchRadius = hitRadius * INTERSECTION_SEARCH_MULTIPLIER;
    const cornerResult = findCornerNearPoint(store, rawPos, searchRadius);
    if (cornerResult) {
      // 교차점 근처 클릭: t 기반 방향 (하위 호환)
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
    if (geom.id === this._line1.id) return; // 같은 선 무시

    const line2 = geom;
    const hit = lineLineIntersectionUnbounded(
      this._line1.x1, this._line1.y1, this._line1.x2, this._line1.y2,
      line2.x1, line2.y1, line2.x2, line2.y2,
    );
    if (!hit) return;

    // 커서 사분면 기반 방향 결정
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
    // vertex 호버: 2선 하이라이트
    const vertex = store.hitTestVertexAll(rawPos, hitRadius);
    if (vertex) {
      const twoLines = findLinesAtVertex(store, vertex);
      if (twoLines) {
        store.hoveredItem = { kind: "vertex", geomId: vertex.geomId, vertexIndex: vertex.vertexIndex, x: vertex.x, y: vertex.y };
        this.preview = {
          type: "point",
          id: "__fillet_hover__",
          x: vertex.x,
          y: vertex.y,
        };
        this.previews = [
          { ...twoLines[0], id: `__fillet_hl_${twoLines[0].id}__` },
          { ...twoLines[1], id: `__fillet_hl_${twoLines[1].id}__` },
        ];
        return;
      }
    }

    // line 호버: 해당 선만 하이라이트
    const hitId = store.hitTest(rawPos, hitRadius);
    if (hitId) {
      const geom = store.geometries.get(hitId);
      if (geom && geom.type === "line" && !isRefOrConstruction(geom)) {
        store.hoveredItem = { kind: "geometry", geomId: hitId };
        this.preview = null;
        this.previews = [{ ...geom, id: `__fillet_hl_${geom.id}__` }];
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
        id: "__fillet_hover__",
        x: cornerResult.intersection.x,
        y: cornerResult.intersection.y,
      };
      this.previews = [
        { ...cornerResult.line1, id: `__fillet_hl_${cornerResult.line1.id}__` },
        { ...cornerResult.line2, id: `__fillet_hl_${cornerResult.line2.id}__` },
      ];
      return;
    }

    // 아무것도 없으면 클리어
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

    // line1은 항상 하이라이트
    const line1Preview: SerializedGeometry = { ...this._line1, id: `__fillet_hl_${this._line1.id}__` };

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
            id: "__fillet_hover__",
            x: hit.x,
            y: hit.y,
          };
          this.previews = [
            line1Preview,
            { ...geom, id: `__fillet_hl_${geom.id}__` },
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
    this.pendingFillet = { line1, line2, intersection, keepDir1, keepDir2 };
    this._state = "pending-input";
    this._line1 = null;

    this.preview = {
      type: "point",
      id: "__fillet_preview__",
      x: intersection.x,
      y: intersection.y,
    };
    store.requestRender();

    this.onRequestRadiusInput?.(this.pendingFillet);
  }

  // --- 내부 유틸리티 ---

  // fillet 호의 start/end 각도. 호는 startAngle 에서 CCW 로 endAngle 까지 그려진다.
  // dir1 에서 dir2 로 CCW 로 도는 꼭짓점(cross(dir1, dir2) > 0)에서 tp1→tp2 순서로 두면 꼭짓점 바깥을 도는
  // 270° 호가 되므로, 그때는 tp2 를 시작점으로 둔다(swapped). 프리뷰와 확정이 같은 기준을 쓴다.
  private _filletArcAngles(
    dir1: { x: number; y: number },
    dir2: { x: number; y: number },
    tp1: { x: number; y: number },
    tp2: { x: number; y: number },
    cx: number,
    cy: number,
  ): { startAngle: number; endAngle: number; swapped: boolean } {
    const angle1 = Math.atan2(tp1.y - cy, tp1.x - cx);
    const angle2 = Math.atan2(tp2.y - cy, tp2.x - cx);
    const swapped = dir1.x * dir2.y - dir1.y * dir2.x > 0;
    return swapped
      ? { startAngle: angle2, endAngle: angle1, swapped }
      : { startAngle: angle1, endAngle: angle2, swapped };
  }

  // 프리뷰용 트림된 line 계산 (keepDir 기반)
  private _computeTrimmedLine(
    line: SerializedGeometry & { type: "line" },
    P: { x: number; y: number },
    trimPt: { x: number; y: number },
    keepDir: 1 | -1,
  ): SerializedGeometry | null {
    // keepDir > 0: x1→x2 방향 보존 → farEnd = x2 → (x2, trimPt)
    // keepDir < 0: x2→x1 방향 보존 → farEnd = x1 → (x1, trimPt)
    const farX = keepDir > 0 ? line.x2 : line.x1;
    const farY = keepDir > 0 ? line.y2 : line.y1;
    const trimLen = Math.hypot(farX - trimPt.x, farY - trimPt.y);
    if (trimLen < 1e-6) return null;
    return {
      type: "line",
      id: `__fillet_trim_${line.id}__`,
      x1: farX, y1: farY,
      x2: trimPt.x, y2: trimPt.y,
    };
  }

  // 교차점에서 먼 쪽 끝점까지 트림 + 구속 재매핑 (keepDir 기반)
  private _trimLineToTangentPoint(
    line: SerializedGeometry & { type: "line" },
    _P: { x: number; y: number },
    tangentPt: { x: number; y: number },
    keepDir: 1 | -1,
  ): { geom: SerializedGeometry; vertexRemaps: VertexRemap[]; geomRemap: GeomRemap } | null {
    // keepDir > 0: 보존 방향이 x1→x2 → farEnd = (x2,y2) = vertexIndex 1
    // keepDir < 0: 보존 방향이 x2→x1 → farEnd = (x1,y1) = vertexIndex 0
    const farX = keepDir > 0 ? line.x2 : line.x1;
    const farY = keepDir > 0 ? line.y2 : line.y1;
    const farVertexIndex = keepDir > 0 ? 1 : 0;

    const trimLen = Math.hypot(farX - tangentPt.x, farY - tangentPt.y);
    if (trimLen < 1e-6) return null;

    const newId = this._generateId();
    const geom: SerializedGeometry = {
      type: "line",
      id: newId,
      x1: farX,
      y1: farY,
      x2: tangentPt.x,
      y2: tangentPt.y,
    };

    // vertex 0 = (x1,y1) = farEnd, vertex 1 = (x2,y2) = tangentPt
    const vertexRemaps: VertexRemap[] = [
      { oldGeomId: line.id, oldVertexIndex: farVertexIndex, newGeomId: newId, newVertexIndex: 0 },
    ];
    const geomRemap: GeomRemap = { oldGeomId: line.id, newGeomId: newId };

    return { geom, vertexRemaps, geomRemap };
  }

  // 점이 선분 범위 내에 있는지 확인
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

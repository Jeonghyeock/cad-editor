// 그리기 도구 추상 클래스
// 각 구체 도구는 이 클래스를 상속하여 포인터 이벤트를 처리

import type { HoverItem, SerializedGeometry, SketchDrawToolType, VertexHandle } from "../../Setup.type";
import { hoverItemsEqual } from "../../utils/hoverItemsEqual";
import { generateConstraintId, generateGeometryId } from "../../utils/idGenerator";

import { AddConstraintCommand } from "../commands/AddConstraintCommand";
import { AddGeometryCommand } from "../commands/AddGeometryCommand";
import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import type { InferenceLine } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapResult, SnapType } from "../SnapEngine";

// Parallel / Perpendicular / Colinear 추론 임계값 (±5° — InferenceEngine 과 동일)
export const PARALLEL_PERP_THRESHOLD = Math.PI / 36;
// Colinear: 시작점이 기존 line 의 무한직선에서 이 거리 이내면 colinear, 아니면 parallel
export const COLINEAR_DIST_THRESHOLD = 0.5;

export type DirectionalInferenceResult = {
  pos: { x: number; y: number };
  sourceGeomId: string;
  relation: "parallel" | "perpendicular" | "colinear";
};

export type DirectionalInferenceOptions = {
  /** 자기 자신 line ids (Rectangle 의 4 edge 등 새로 만드는 line) 제외. */
  excludeGeomIds?: Set<string>;
  /** 매칭 허용 relation 종류. 기본은 셋 다 허용. Rectangle 류는 colinear-only. */
  relations?: ReadonlyArray<"parallel" | "perpendicular" | "colinear">;
};

// 클릭별 스냅→vertex 매핑 정의
export type SnapVertexMapping = {
  clickIndex: number;
  geomId: string;
  vertexIndex: number;
};

// Sketch Tools 동적 입력 필드 정의
export type SketchInputFieldType = "H" | "V" | "L" | "A" | "R" | "W" | "N";
export type SketchInputField = {
  type: SketchInputFieldType;
  label: string;     // 표시 라벨
  value?: number;    // 현재 값 (있으면 표시)
};

export abstract class DrawTool {
  abstract readonly type: SketchDrawToolType;

  // 현재 그리기 진행 중인 프리뷰 (null이면 없음)
  preview: SerializedGeometry | null = null;

  // 복수 프리뷰 (rectangle→4 line 등)
  previews: SerializedGeometry[] = [];

  // 추론선 (타입별 색상 렌더링 지원)
  inferenceLines: InferenceLine[] = [];

  // 추론선 탐색 반경 (월드 단위, 컨트롤러가 설정)
  inferenceRadius = 0;

  // Ctrl-Lock: 현재 잠긴 추론선 (Ctrl 키로 DOF 제한)
  lockedInference: InferenceLine | null = null;

  // 히트 테스트 반경 (월드 단위, 컨트롤러가 설정 — DimensionDrawTool 등에서 사용)
  hitRadius = 10;

  // [deprecated] 이전 호환용 — 도구는 이제 rawPos/snappedPos 두 좌표를 모두 받으므로 불필요
  // 선택 도구는 rawPos로 hitTest, 생성 도구는 snappedPos로 배치
  selectionOnly = false;

  // 도구별 스냅 필터 (null이면 모든 스냅 허용)
  snapFilter: Set<SnapType> | null = null;

  // 기하 구속 자동 적용 토글 (CATIA Sketch Tools 토글과 연동)
  autoGeoConstraints = true;

  // Construction 모드 (활성 시 새로 생성되는 기하에 isConstruction 플래그 설정)
  constructionMode = false;

  // 클릭별 스냅 결과 기록 (compound tool auto-constraint 생성용)
  protected _snapPerClick: SnapResult[] = [];

  // rawPos: 스냅 적용 전 원본 월드 좌표 (hitTest/선택에 사용)
  // snappedPos: 스냅 적용된 좌표 (기하 배치에 사용)
  abstract onPointerDown(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
    event: PointerEvent,
  ): void;

  abstract onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
    event: PointerEvent,
  ): void;

  abstract onPointerUp(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
    event: PointerEvent,
  ): void;

  // 포인터 캡처 취소 시 (캔버스 밖 이동 등) 드래그 상태 초기화
  onPointerCancel(_store: SketchGeometryStore): void {
    this.cancel();
  }

  // Escape 등 키보드 이벤트 처리
  onKeyDown(store: SketchGeometryStore, event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.cancel();
      store.requestRender();
    }
  }

  // Sketch Tools 패널에 표시할 입력 필드 (도구/단계별 동적 변경)
  // mousePos: 현재 마우스 월드 좌표 (값 계산용)
  getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
    ];
  }

  // Sketch Tools 패널에서 값 입력 확정 시 호출
  // 반환: true면 도구가 값을 처리함, false면 기본 좌표 클릭으로 폴백
  applyInputValues(
    _store: SketchGeometryStore,
    _values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    return false; // 기본: 도구별 처리 없음 → 좌표 클릭으로 폴백
  }

  // 진행 중인 작업이 있는지 (연속 그리기 체인 등)
  hasPendingWork(): boolean {
    return false;
  }

  // 진행 중인 그리기 취소
  cancel(): void {
    this.preview = null;
    this.previews = [];
    this.inferenceLines = [];
    this.lockedInference = null;
    this._snapPerClick = [];
  }

  // --- 통합 hover 헬퍼 (도구가 직접 store.hoveredItem을 관리할 때 사용) ---

  /**
   * vertex 우선 → 기하 순서로 hitTest 후 store.hoveredItem 업데이트.
   * 변경이 있으면 true 반환 (requestRender 필요 여부 판단용).
   * excludeIds: hitTest에서 제외할 기하 ID (이미 선택된 기하 등)
   */
  protected _updateHoveredItem(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    excludeIds?: Set<string>,
  ): boolean {
    const vertexHit = store.hitTestVertexAll(rawPos, this.hitRadius);
    const vertex = vertexHit && (!excludeIds || !excludeIds.has(vertexHit.geomId)) ? vertexHit : null;
    const geomId = vertex ? null : store.hitTest(rawPos, this.hitRadius);
    const hitId = geomId && (!excludeIds || !excludeIds.has(geomId)) ? geomId : null;
    return this._applyHoverItem(store, vertex, hitId);
  }

  /**
   * hitTest 결과를 store.hoveredItem에 반영. 변경 시 true 반환.
   */
  protected _applyHoverItem(
    store: SketchGeometryStore,
    vertex: VertexHandle | null,
    geomId: string | null,
  ): boolean {
    const prev = store.hoveredItem;
    const next: HoverItem | null = vertex
      ? { kind: "vertex", geomId: vertex.geomId, vertexIndex: vertex.vertexIndex, x: vertex.x, y: vertex.y }
      : geomId
        ? { kind: "geometry", geomId }
        : prev?.kind === "constraint" ? prev : null;
    if (hoverItemsEqual(prev, next)) return false;
    store.hoveredItem = next;
    return true;
  }

  // 고유 ID 생성
  protected _generateId(): string {
    return generateGeometryId();
  }

  // Construction 모드 적용: 기하에 isConstruction 플래그 설정
  protected _applyConstructionMode<T extends { isConstruction?: boolean }>(geom: T): T {
    if (this.constructionMode) {
      return { ...geom, isConstruction: true };
    }
    return geom;
  }

  // 현재 스냅 결과를 기록 (각 onPointerDown에서 호출)
  protected _recordSnap(store: SketchGeometryStore): void {
    this._snapPerClick.push(store.snapResult ?? null);
  }

  // 기록된 스냅 결과 초기화 (cancel/완료 시)
  protected _clearSnaps(): void {
    this._snapPerClick = [];
  }

  // 기록된 스냅 + vertex 매핑으로 auto-constraint 일괄 생성
  // mappings: 각 클릭의 스냅이 어떤 기하의 어떤 vertex에 대응하는지
  protected _buildSnapConstraints(
    store: SketchGeometryStore,
    mappings: SnapVertexMapping[],
  ): GeometryCommand[] {
    if (!this.autoGeoConstraints) return [];
    const cmds: GeometryCommand[] = [];
    for (const m of mappings) {
      const snap = this._snapPerClick[m.clickIndex];
      if (!snap) continue;
      const cst = this._buildAutoConstraint(store, m.geomId, m.vertexIndex, snap);
      if (cst) cmds.push(cst);
    }
    return cmds;
  }

  /**
   * Parallel / Perpendicular / Colinear 자동 추론 — CATIA SmartPick 표준.
   * 새 line (startPos → endPos) 방향이 기존 line/axis 와 평행/수직 임계값 (±5°) 안이면
   * 정확한 방향으로 보정 + 매칭된 source id + relation 반환.
   * 시작점이 기존 line 의 무한직선에 닿는 경우 parallel 대신 colinear.
   *
   * Rectangle 류 도구는 좌표 보정 결과 (pos) 는 무시하고 constraint 만 추가하기 위해
   * `options.relations: ["colinear"]` 로 호출.
   */
  protected _applyParallelPerpendicularSnap(
    store: SketchGeometryStore,
    startPos: { x: number; y: number },
    endPos: { x: number; y: number },
    options?: DirectionalInferenceOptions,
  ): DirectionalInferenceResult | null {
    const dx = endPos.x - startPos.x;
    const dy = endPos.y - startPos.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return null;
    const angle = Math.atan2(dy, dx);
    const allowedRelations = new Set(options?.relations ?? ["parallel", "perpendicular", "colinear"]);
    const exclude = options?.excludeGeomIds;

    let best: { sourceGeomId: string; relation: "parallel" | "perpendicular" | "colinear"; targetAngle: number; angleDiff: number } | null = null;
    for (const [id, geom] of store.geometries) {
      if (exclude?.has(id)) continue;
      if (geom.type !== "line" && geom.type !== "axis") continue;
      let gDx: number, gDy: number;
      if (geom.type === "axis") {
        gDx = geom.direction === "h" ? 1 : 0;
        gDy = geom.direction === "v" ? 1 : 0;
      } else {
        gDx = geom.x2 - geom.x1;
        gDy = geom.y2 - geom.y1;
      }
      const gLen = Math.hypot(gDx, gDy);
      if (gLen < 1e-10) continue;
      const gAngle = Math.atan2(gDy, gDx);

      let angleDiff = Math.abs(angle - gAngle) % Math.PI;
      if (angleDiff > Math.PI / 2) angleDiff = Math.PI - angleDiff;

      // 평행 후보
      if (angleDiff < PARALLEL_PERP_THRESHOLD) {
        let isColinear = false;
        if (geom.type === "line") {
          const perpDist = Math.abs(gDy * (startPos.x - geom.x1) - gDx * (startPos.y - geom.y1)) / gLen;
          isColinear = perpDist < COLINEAR_DIST_THRESHOLD;
        } else {
          const perpDist = Math.abs(gDy * startPos.x - gDx * startPos.y) / gLen;
          isColinear = perpDist < COLINEAR_DIST_THRESHOLD;
        }
        const candidateRel = isColinear ? "colinear" : "parallel";
        if (!allowedRelations.has(candidateRel)) continue;
        if (!best || angleDiff < best.angleDiff) {
          best = { sourceGeomId: id, relation: candidateRel, targetAngle: gAngle, angleDiff };
        }
        continue;
      }

      // 직각 후보
      const perpAngleDiff = Math.abs(angleDiff - Math.PI / 2);
      if (perpAngleDiff < PARALLEL_PERP_THRESHOLD) {
        if (!allowedRelations.has("perpendicular")) continue;
        if (!best || perpAngleDiff < best.angleDiff) {
          best = { sourceGeomId: id, relation: "perpendicular", targetAngle: gAngle + Math.PI / 2, angleDiff: perpAngleDiff };
        }
      }
    }

    if (!best) return null;
    // 기준 방향과 그 반대 방향 중 그은 방향에 가까운 쪽을 고른다. 각도 차는 atan2(sin, cos) 로 [-π, π] 에 넣어 비교한다
    // — JS % 는 음수를 그대로 돌려줘서, 차가 -π 보다 작으면 먼 쪽을 골라 확정 순간 끝점이 시작점 반대편으로 뒤집혔다.
    const angleGap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    let target = best.targetAngle;
    const targetOpp = target + Math.PI;
    if (angleGap(angle, targetOpp) < angleGap(angle, target)) target = targetOpp;
    const snappedX = startPos.x + dist * Math.cos(target);
    const snappedY = startPos.y + dist * Math.sin(target);
    return { pos: { x: snappedX, y: snappedY }, sourceGeomId: best.sourceGeomId, relation: best.relation };
  }

  // AddGeometryCommand 생성 (construction 모드 자동 적용)
  protected _addGeometry(geom: SerializedGeometry): AddGeometryCommand {
    // axis 는 isConstruction 개념 없음 — 그대로 전달. 사용자가 axis 를 도구로 그릴 일 없지만
    // type 안전성 위해.
    if (geom.type === "axis") return new AddGeometryCommand(geom);
    return new AddGeometryCommand(this._applyConstructionMode(geom));
  }

  // 선 endpoint가 circle/arc에 접선인지 감지 → tangent 자동 구속
  protected _buildAutoTangentConstraint(
    store: SketchGeometryStore,
    lineGeomId: string,
    lineStart: { x: number; y: number },
    lineEnd: { x: number; y: number },
    snap: SnapResult,
  ): GeometryCommand | null {
    if (!this.autoGeoConstraints) return null;
    if (!snap || !snap.sourceGeomId) return null;
    const targetGeom = store.geometries.get(snap.sourceGeomId);
    if (!targetGeom) return null;
    if (targetGeom.type !== "circle" && targetGeom.type !== "arc") return null;

    // 반지름 벡터 (중심 → 스냅점)
    const rx = snap.x - targetGeom.cx;
    const ry = snap.y - targetGeom.cy;
    const rLen = Math.hypot(rx, ry);
    if (rLen < 1e-9) return null;

    // 선 방향 벡터
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const dLen = Math.hypot(dx, dy);
    if (dLen < 1e-9) return null;

    // 반지름과 선 방향의 dot product → 0에 가까우면 접선
    const dot = Math.abs(rx * dx + ry * dy) / (rLen * dLen);
    const TANGENT_THRESHOLD = 0.087; // ~5도
    if (dot > TANGENT_THRESHOLD) return null;

    // 중복 체크
    const cStore = store.constraintStore;
    if (cStore) {
      for (const [, c] of cStore.constraints) {
        if (c.type !== "tangent") continue;
        const matchAB = (c.entityA.geomId === lineGeomId && c.entityB.geomId === snap.sourceGeomId);
        const matchBA = (c.entityB.geomId === lineGeomId && c.entityA.geomId === snap.sourceGeomId);
        if (matchAB || matchBA) return null;
      }
    }

    return new AddConstraintCommand({
      type: "tangent",
      id: generateConstraintId("auto-cst-tan"),
      entityA: { geomId: lineGeomId },
      entityB: { geomId: snap.sourceGeomId },
    });
  }

  // 스냅 타입별 자동 구속 매핑:
  //   endpoint/center → coincident
  //   midpoint        → midpoint (line 한정)
  //   nearest (원/호) → point_on_circle
  //   perpendicular   → point_on_line
  //   tangent         → tangent (line/circle 또는 line/arc 한정)
  protected _buildAutoConstraint(
    store: SketchGeometryStore,
    newGeomId: string,
    vertexIndex: number,
    snap: SnapResult,
  ): GeometryCommand | null {
    if (!this.autoGeoConstraints) return null;
    if (!snap || !snap.sourceGeomId) return null;
    if (snap.sourceGeomId === newGeomId) return null;
    const targetGeom = store.geometries.get(snap.sourceGeomId);
    if (!targetGeom) return null;
    const cStore = store.constraintStore;

    // midpoint snap → midpoint(point, line) 구속
    if (snap.type === "midpoint" && targetGeom.type === "line") {
      if (cStore) {
        for (const [, c] of cStore.constraints) {
          if (c.type !== "midpoint") continue;
          if (c.point.geomId === newGeomId && c.point.vertexIndex === vertexIndex &&
              c.line.geomId === snap.sourceGeomId) return null;
        }
      }
      return new AddConstraintCommand({
        type: "midpoint" as const,
        id: generateConstraintId("auto-cst"),
        point: { geomId: newGeomId, vertexIndex },
        line: { geomId: snap.sourceGeomId },
      });
    }

    // intersection snap → 두 entity 모두에 point_on_line/point_on_circle 자동 부여.
    // CAD 표준 (Onshape/Fusion/CATIA) — 교차점 클릭 시 양쪽 entity 와의 관계 모두 보존.
    if (snap.type === "intersection" && snap.sourceGeomId2 && snap.sourceGeomType2) {
      const cmds: GeometryCommand[] = [];
      const addOne = (geomId: string, gtype: SerializedGeometry["type"]) => {
        if (gtype === "line" || gtype === "axis") {
          // 중복 검사
          if (cStore) {
            for (const [, c] of cStore.constraints) {
              if (c.type !== "point_on_line") continue;
              if (c.point.geomId === newGeomId && c.point.vertexIndex === vertexIndex &&
                  c.line.geomId === geomId) return;
            }
          }
          cmds.push(new AddConstraintCommand({
            type: "point_on_line" as const,
            id: generateConstraintId("auto-cst"),
            point: { geomId: newGeomId, vertexIndex },
            line: { geomId },
          }));
        } else if (gtype === "circle" || gtype === "arc") {
          if (cStore) {
            for (const [, c] of cStore.constraints) {
              if (c.type !== "point_on_circle") continue;
              if (c.point.geomId === newGeomId && c.point.vertexIndex === vertexIndex &&
                  c.circle.geomId === geomId) return;
            }
          }
          cmds.push(new AddConstraintCommand({
            type: "point_on_circle" as const,
            id: generateConstraintId("auto-cst"),
            point: { geomId: newGeomId, vertexIndex },
            circle: { geomId },
          }));
        }
      };
      addOne(snap.sourceGeomId, snap.sourceGeomType ?? targetGeom.type);
      const targetGeom2 = store.geometries.get(snap.sourceGeomId2);
      if (targetGeom2) addOne(snap.sourceGeomId2, snap.sourceGeomType2);
      if (cmds.length === 0) return null;
      if (cmds.length === 1) return cmds[0];
      return new BatchCommand(cmds);
    }

    // perpendicular snap (line/axis 위 수선의 발) → point_on_line 구속.
    // axis 도 line 처럼 무한선 위 점 — solver 가 axis 를 line primitive 로 변환해 동일 처리.
    if (snap.type === "perpendicular" && (targetGeom.type === "line" || targetGeom.type === "axis")) {
      if (cStore) {
        for (const [, c] of cStore.constraints) {
          if (c.type !== "point_on_line") continue;
          if (c.point.geomId === newGeomId && c.point.vertexIndex === vertexIndex &&
              c.line.geomId === snap.sourceGeomId) return null;
        }
      }
      return new AddConstraintCommand({
        type: "point_on_line" as const,
        id: generateConstraintId("auto-cst"),
        point: { geomId: newGeomId, vertexIndex },
        line: { geomId: snap.sourceGeomId },
      });
    }

    // nearest snap → circle/arc/ellipse 둘레 위: point_on_circle auto-constraint.
    // solver 의 point_on_circle 분기가 ellipse 도 처리 (planegcs point_on_ellipse 자동 변환).
    if (snap.type === "nearest" &&
        (targetGeom.type === "circle" || targetGeom.type === "arc" || targetGeom.type === "ellipse")) {
      if (cStore) {
        for (const [, c] of cStore.constraints) {
          if (c.type !== "point_on_circle") continue;
          if (c.point.geomId === newGeomId && c.point.vertexIndex === vertexIndex &&
              c.circle.geomId === snap.sourceGeomId) return null;
        }
      }
      return new AddConstraintCommand({
        type: "point_on_circle" as const,
        id: generateConstraintId("auto-cst"),
        point: { geomId: newGeomId, vertexIndex },
        circle: { geomId: snap.sourceGeomId },
      });
    }

    // tangent snap → tangent constraint. 새 entity 와 target entity 사이.
    // 이전엔 _buildAutoTangentConstraint 가 line 도구에서만 직접 호출되어 rectangle 등 다른
    // 도구는 tangent snap 시 자동 미부여. _buildAutoConstraint 에서 통합 처리.
    if (snap.type === "tangent") {
      const newGeom = store.geometries.get(newGeomId);
      if (!newGeom) return null;
      // line / circle / arc 끼리 tangent 가능. 그 외는 미지원.
      const tangentEligible = (g: SerializedGeometry): boolean =>
        g.type === "line" || g.type === "circle" || g.type === "arc";
      if (!tangentEligible(newGeom) || !tangentEligible(targetGeom)) return null;
      if (newGeom.type === "line" && targetGeom.type === "line") return null; // 두 line 간 tangent 의미 없음
      // 중복 검사
      if (cStore) {
        for (const [, c] of cStore.constraints) {
          if (c.type !== "tangent") continue;
          const a = c.entityA.geomId, b = c.entityB.geomId;
          if ((a === newGeomId && b === snap.sourceGeomId) ||
              (b === newGeomId && a === snap.sourceGeomId)) return null;
        }
      }
      return new AddConstraintCommand({
        type: "tangent",
        id: generateConstraintId("auto-cst-tan"),
        entityA: { geomId: newGeomId },
        entityB: { geomId: snap.sourceGeomId },
      });
    }

    // center-to-center snap → concentric constraint (coincident 보다 의미 정확).
    // 새 entity 가 circle/arc/ellipse 이고 target 도 center vertex (vertexIndex=0) 인 경우.
    // CATIA SmartPick 표준 — 두 center 끼리는 concentric 자동 부여.
    if (snap.type === "center" && snap.sourceVertexIndex === 0) {
      const newGeom = store.geometries.get(newGeomId);
      if (newGeom && vertexIndex === 0 &&
          (newGeom.type === "circle" || newGeom.type === "arc" || newGeom.type === "ellipse") &&
          (targetGeom.type === "circle" || targetGeom.type === "arc" || targetGeom.type === "ellipse")) {
        if (cStore) {
          for (const [, c] of cStore.constraints) {
            if (c.type !== "concentric") continue;
            const a = c.circleA.geomId, b = c.circleB.geomId;
            if ((a === newGeomId && b === snap.sourceGeomId) ||
                (b === newGeomId && a === snap.sourceGeomId)) return null;
          }
        }
        return new AddConstraintCommand({
          type: "concentric",
          id: generateConstraintId("auto-cst"),
          circleA: { geomId: newGeomId },
          circleB: { geomId: snap.sourceGeomId },
        });
      }
    }

    // endpoint type 인데 sourceVertexIndex 없으면 circle quadrant 등 "vertex entity 가 아닌
    // 특수 점" — coincident 대신 point_on_circle/arc/ellipse 로 라우팅.
    if (snap.type === "endpoint" && snap.sourceVertexIndex === undefined &&
        (targetGeom.type === "circle" || targetGeom.type === "arc" || targetGeom.type === "ellipse")) {
      if (cStore) {
        for (const [, c] of cStore.constraints) {
          if (c.type !== "point_on_circle") continue;
          if (c.point.geomId === newGeomId && c.point.vertexIndex === vertexIndex &&
              c.circle.geomId === snap.sourceGeomId) return null;
        }
      }
      return new AddConstraintCommand({
        type: "point_on_circle" as const,
        id: generateConstraintId("auto-cst"),
        point: { geomId: newGeomId, vertexIndex },
        circle: { geomId: snap.sourceGeomId },
      });
    }

    // endpoint/center/origin 스냅에서만 auto-coincident 생성. origin 은 REF_ORIGIN_ID 의
    // point geom 과 같은 entity 라 coincident 가 자연스럽 (axis endpoint 와 달리 unit vector
    // 같은 가짜 좌표 끌림 없음).
    if (snap.type !== "endpoint" && snap.type !== "center" && snap.type !== "origin") return null;
    if (snap.sourceVertexIndex === undefined) return null;

    // 동일 vertex 쌍에 이미 coincident 구속이 있으면 중복 생성 방지
    if (cStore) {
      for (const [, c] of cStore.constraints) {
        if (c.type !== "coincident") continue;
        const matchAB =
          (c.pointA.geomId === newGeomId && c.pointA.vertexIndex === vertexIndex &&
           c.pointB.geomId === snap.sourceGeomId && c.pointB.vertexIndex === snap.sourceVertexIndex);
        const matchBA =
          (c.pointB.geomId === newGeomId && c.pointB.vertexIndex === vertexIndex &&
           c.pointA.geomId === snap.sourceGeomId && c.pointA.vertexIndex === snap.sourceVertexIndex);
        if (matchAB || matchBA) return null;
      }
    }

    return new AddConstraintCommand({
      type: "coincident" as const,
      id: generateConstraintId("auto-cst"),
      pointA: { geomId: newGeomId, vertexIndex },
      pointB: { geomId: snap.sourceGeomId, vertexIndex: snap.sourceVertexIndex },
    });
  }
}

// 기하 프리미티브 저장소 (커맨드 패턴 undo/redo)
// addRenderListener 로 렌더 구독자에게 변경 통지

import {
  HIT_BUFFER,
  VERTEX_HIT_RATIO,
} from "src/shared/constants/CanvasConstants";

import type { GlobalHistoryManager } from "../core/GlobalHistoryManager";
import { AXIS_SCREEN_PX } from "../rendering/overlayConstants";
import type {
  HitResult,
  HoverItem,
  SelectionItem,
  SerializedGeometry,
  VertexHandle,
} from "../Setup.type";
import {
  computeAABB,
  extractVertices,
  getConstraintGeomIds,
} from "../utils/geometryUtils";
import { isAngleBetween, pointToSegmentDist2 } from "../utils/mathUtils";

import { AddConstraintCommand } from "./commands/AddConstraintCommand";
import type { GeometryCommand } from "./commands/GeometryCommand";
import { RemoveConstraintCommand } from "./commands/RemoveConstraintCommand";
import { RemoveGeometryCommand } from "./commands/RemoveGeometryCommand";
import { ToggleConstructionCommand } from "./commands/ToggleConstructionCommand";
import type {
  ElementConstraintStatus,
  SketchConstraint,
  SolveStatus,
} from "./constraints/SketchConstraint.type";
import type {
  PointKey,
  SketchConstraintSolver,
} from "./constraints/SketchConstraintSolver";
import type { SketchConstraintStore } from "./constraints/SketchConstraintStore";
import { nurbsEvaluate } from "./curveUtils";
import { detectClosedShapes, getShapeVerticesFromGeometries, orderLineIdsByCoincidence } from "./shapeDetector";
import type { SketchShape } from "./shapeDetector";
import type { SnapResult } from "./SnapEngine";

// 원점/축선 참조 기하 ID 상수
export const REF_ORIGIN_ID = "__ref_origin__";
export const REF_X_AXIS_ID = "__ref_x_axis__";
export const REF_Y_AXIS_ID = "__ref_y_axis__";
// (deprecated) Axis 는 이제 type:"axis" 의 별도 entity — 좌표 stored 없음, direction 만 가짐.

/** 참조 기하(원점 + 축선) ID인지 판별 */
export function isReferenceId(id: string): boolean {
  return id === REF_ORIGIN_ID || id === REF_X_AXIS_ID || id === REF_Y_AXIS_ID;
}

/** 축선(X/Y axis) ID인지 판별 */
export function isAxisId(id: string): boolean {
  return id === REF_X_AXIS_ID || id === REF_Y_AXIS_ID;
}

/** 기하 삭제 커맨드가 undo 용으로 보관하는 shape 사본과 그 목록 위치 */
export type ShapeSnapshot = { index: number; shape: SketchShape };

export class SketchGeometryStore {
  geometries: Map<string, SerializedGeometry> = new Map();
  // 통합 hover 상태: 기하, vertex, 구속조건을 단일 필드로 관리
  hoveredItem: HoverItem | null = null;

  // CATIA식 통합 선택: 기하와 vertex가 한 배열에 공존
  private _selection: SelectionItem[] = [];
  private _selectedIdCache: Set<string> | null = null;

  get selection(): SelectionItem[] {
    return this._selection;
  }
  set selection(items: SelectionItem[]) {
    this._selection = items;
    this._selectedIdCache = null; // 캐시 무효화
  }

  // selectedIds의 Set 캐시 (hitTestVertexAll 등에서 O(1) lookup)
  private _getSelectedIdSet(): Set<string> {
    if (!this._selectedIdCache) {
      this._selectedIdCache = new Set(
        this._selection
          .filter((s) => s.kind === "geometry")
          .map((s) => s.geomId),
      );
    }
    return this._selectedIdCache;
  }

  // 호환 getter/setter — 기존 코드의 점진적 마이그레이션 지원
  get selectedIds(): string[] {
    return this._selection
      .filter(
        (s): s is SelectionItem & { kind: "geometry" } => s.kind === "geometry",
      )
      .map((s) => s.geomId);
  }
  set selectedIds(ids: string[]) {
    // 기존 vertex 선택은 유지하고 기하 선택만 교체
    const vertices = this.selection.filter((s) => s.kind === "vertex");
    this.selection = [
      ...ids.map((id) => ({ kind: "geometry" as const, geomId: id })),
      ...vertices,
    ];
  }
  get selectedVertices(): VertexHandle[] {
    return this.selection
      .filter(
        (s): s is SelectionItem & { kind: "vertex" } => s.kind === "vertex",
      )
      .map((s) => ({
        geomId: s.geomId,
        vertexIndex: s.vertexIndex,
        x: s.x,
        y: s.y,
      }));
  }
  set selectedVertices(verts: VertexHandle[]) {
    // 기존 기하 선택은 유지하고 vertex 선택만 교체
    const geoms = this.selection.filter((s) => s.kind === "geometry");
    this.selection = [
      ...geoms,
      ...verts.map((v) => ({
        kind: "vertex" as const,
        geomId: v.geomId,
        vertexIndex: v.vertexIndex,
        x: v.x,
        y: v.y,
      })),
    ];
  }

  // 클릭으로 선택된 구속조건 ID (Delete 키 삭제용)
  selectedConstraintId: string | null = null;

  // 스냅 시각화용 (렌더러가 읽음)
  snapResult: SnapResult = null;

  // coincident 기반 Shape 목록 (닫힌 루프 — 실시간 계산)
  shapes: SketchShape[] = [];

  // 현재 활성 씬 인덱스 (렌더러에서 씬별 shape 가시성 결정에 사용)
  currentScene = 0;

  // 다른 씬의 SO geometry ID (hitTest에서 제외)
  hiddenGeoIds: Set<string> = new Set();

  // 구속조건 시스템 (외부에서 주입)
  constraintStore: SketchConstraintStore | null = null;
  solver: SketchConstraintSolver | null = null;
  solveStatus: SolveStatus = "ok";
  dof = -1; // -1 = 미계산

  // 요소별 구속 상태 맵 (CATIA V5 스타일 개별 색상)
  elementConstraintStatus: Map<string, ElementConstraintStatus> = new Map();

  // 글로벌 히스토리 매니저 참조 (단일 진실 원천 — 기하 커맨드 히스토리 관리)
  globalHistory: GlobalHistoryManager | null = null;

  private _renderListeners: Set<() => void> = new Set();

  // --- 렌더 리스너 ---

  addRenderListener(callback: () => void): () => void {
    this._renderListeners.add(callback);
    return () => {
      this._renderListeners.delete(callback);
    };
  }

  // 기하 변경 버전: 기하 좌표/구속이 변경될 때만 증가 (hover/selection 변경 시 증가 안 함)
  geometryVersion = 0;
  // shape 변경 버전: shape 목록 변경 시 증가 (SpecTree 라벨 갱신용)
  shapeVersion = 0;

  /** 기하 변경 마킹 (드래그, 솔브, 커맨드 실행 시 호출) */
  markGeometryChanged(): void {
    this.geometryVersion++;
    for (const cb of this._mutationListeners) cb();
  }

  // --- Mutation listener (sketch 기하 변경 시 트리거) ---
  // markGeometryChanged 가 호출되면 트리거. requestRender (렌더 listener) 와 별도.
  private _mutationListeners: Set<() => void> = new Set();

  addMutationListener(callback: () => void): () => void {
    this._mutationListeners.add(callback);
    return () => {
      this._mutationListeners.delete(callback);
    };
  }

  /** shape 목록 변경 마킹 — mutation listener 도 호출해 UI 가 재계산 */
  markShapesChanged(): void {
    this.shapeVersion++;
    for (const cb of this._mutationListeners) cb();
  }

  requestRender(): void {
    for (const cb of this._renderListeners) cb();
  }

  // --- 커맨드 실행 (GlobalHistoryManager에 위임) ---

  // 커맨드를 실행하고 글로벌 히스토리에 기록
  execute(command: GeometryCommand): void {
    this.globalHistory?.executeGeometryCommand(command, this);
  }

  // 히스토리에만 push (execute 호출 안 함 — 드래그 완료 시 현재 상태가 이미 최종)
  pushSnapshot(command: GeometryCommand): void {
    this.globalHistory?.pushGeometrySnapshot(command, this);
  }

  // --- Construction 토글 ---

  toggleConstruction(): void {
    if (this.selectedIds.length === 0) return;
    // 참조 기하는 construction 토글 불가
    const ids = this.selectedIds.filter((id) => !isReferenceId(id));
    if (ids.length === 0) return;
    this.execute(new ToggleConstructionCommand(ids));
  }

  // --- 선택된 요소 삭제 ---

  deleteSelected(): void {
    if (this.selectedIds.length === 0) return;
    // 참조 기하는 삭제 불가
    const toRemove = this.selectedIds
      .map((id) => this.geometries.get(id))
      .filter(
        (g): g is SerializedGeometry =>
          !!g && !("isReference" in g && g.isReference),
      );
    if (toRemove.length === 0) return;
    this.execute(new RemoveGeometryCommand(toRemove));
  }

  // --- 참조 기하 (원점/축선) 주입/제거 ---

  injectReferenceGeometry(): void {
    this.geometries.set(REF_ORIGIN_ID, {
      type: "point",
      id: REF_ORIGIN_ID,
      x: 0,
      y: 0,
      isReference: true,
    });
    // CATIA H/V axis 식 — direction 만 가지는 무한선. (1,0)/(0,1) endpoint vertex 없음.
    this.geometries.set(REF_X_AXIS_ID, {
      type: "axis",
      id: REF_X_AXIS_ID,
      direction: "h",
      isReference: true,
    });
    this.geometries.set(REF_Y_AXIS_ID, {
      type: "axis",
      id: REF_Y_AXIS_ID,
      direction: "v",
      isReference: true,
    });
    this.requestRender();
  }

  removeReferenceGeometry(): void {
    this.geometries.delete(REF_ORIGIN_ID);
    this.geometries.delete(REF_X_AXIS_ID);
    this.geometries.delete(REF_Y_AXIS_ID);
  }

  // --- 구속조건 추가/삭제 ---

  applyConstraint(constraint: SketchConstraint): void {
    this.execute(new AddConstraintCommand(constraint));
  }

  // 상충 여부를 검사하며 구속 적용 — over-constrained 시 undo + 좌표 원복
  tryApplyConstraint(constraint: SketchConstraint): boolean {
    // 기하 좌표 스냅샷 (undo 후에도 솔버가 좌표를 변형할 수 있으므로 수동 원복)
    const snapshot = new Map<string, SerializedGeometry>();
    for (const [id, geom] of this.geometries) {
      snapshot.set(id, structuredClone(geom));
    }

    this.execute(new AddConstraintCommand(constraint));

    if (
      this.solveStatus === "over-constrained" ||
      this.solveStatus === "error"
    ) {
      // 글로벌 히스토리를 통해 원자적으로 undo
      this.globalHistory?.undo();
      // 좌표 원복
      for (const [id, geom] of snapshot) {
        this.geometries.set(id, geom);
      }
      this.solveConstraints();
      this.recomputeFaces();
      this.requestRender();
      return false;
    }
    return true;
  }

  removeConstraintById(id: string): void {
    const c = this.constraintStore?.constraints.get(id);
    if (!c) return;
    this.execute(new RemoveConstraintCommand(c));
  }

  // --- 히트 테스트 ---

  /**
   * DrawTool 전용 단순 hit (constraint / face / vertex tier 제외, 첫 geometry id 만 반환).
   *
   * - DrawTool (선/원/dimension 도구 등) 흐름은 도구의 두 번째 click 대상이 "어떤 geometry id 인가"
   *   만 필요해 vertex/constraint/face 후보가 의미 없음. 따라서 hitTestSplit 의 geometry kind hit
   *   첫 개만 반환.
   * - hover/select 흐름은 useSketchPointerHandler.collectAllHitCandidates 를 통해 4 tier (점/constraint/선/면)
   *   전체 후보를 받음.
   */
  hitTest(pos: { x: number; y: number }, radius: number): string | null {
    const candidates = this._collectHitCandidates(pos, radius, "all");
    for (const c of candidates) {
      if (c.kind === "geometry") return c.geomId;
    }
    return null;
  }

  // --- 꼭짓점 핸들 ---

  getVertexHandles(id: string): VertexHandle[] {
    const geom = this.geometries.get(id);
    if (!geom) return [];
    return extractVertices(geom);
  }

  hitTestVertex(
    pos: { x: number; y: number },
    radius: number,
  ): VertexHandle | null {
    const r2 = radius * radius;
    for (const id of this.selectedIds) {
      if (this.hiddenGeoIds.has(id)) continue;
      const handles = this.getVertexHandles(id);
      for (const h of handles) {
        const dx = pos.x - h.x;
        const dy = pos.y - h.y;
        if (dx * dx + dy * dy <= r2) return h;
      }
    }
    return null;
  }

  // 모든 기하의 꼭짓점 히트 테스트 (hover용 — 선택 여부 무관)
  hitTestVertexAll(
    pos: { x: number; y: number },
    radius: number,
  ): VertexHandle | null {
    const r2 = radius * radius;
    const selectedSet = this._getSelectedIdSet();
    // 축선 vertex는 스킵 (원점은 __ref_origin__ point가 담당).
    // point geometry 도 vertex hit 에서 제외 — entity 자체라 geometry hit 으로만 처리.
    const skipForVertex = (id: string): boolean => {
      if (isAxisId(id) || this.hiddenGeoIds.has(id)) return true;
      const g = this.geometries.get(id);
      if (g?.type === "point") return true;
      return false;
    };
    // 선택된 기하 우선 테스트
    for (const id of selectedSet) {
      if (skipForVertex(id)) continue;
      const handles = this.getVertexHandles(id);
      for (const h of handles) {
        const dx = pos.x - h.x;
        const dy = pos.y - h.y;
        if (dx * dx + dy * dy <= r2) return h;
      }
    }
    // 나머지 기하
    for (const [id] of this.geometries) {
      if (selectedSet.has(id) || skipForVertex(id)) continue;
      const handles = this.getVertexHandles(id);
      for (const h of handles) {
        const dx = pos.x - h.x;
        const dy = pos.y - h.y;
        if (dx * dx + dy * dy <= r2) return h;
      }
    }
    return null;
  }

  // 박스 선택 히트 테스트 (Window/Crossing 모드)
  // windowMode=true: AABB가 box에 완전히 포함된 기하만 선택
  // windowMode=false: AABB가 box와 교차하는 기하도 선택
  hitTestBox(
    box: { minX: number; minY: number; maxX: number; maxY: number },
    windowMode: boolean,
  ): { geometryIds: string[]; vertexHits: VertexHandle[] } {
    const geometryIds: string[] = [];
    const vertexHits: VertexHandle[] = [];
    for (const [id, geom] of this.geometries) {
      if (isReferenceId(id)) continue;
      if (this.hiddenGeoIds.has(id)) continue;

      const matched = windowMode
        ? this._geomInsideBox(geom, box)
        : this._geomCrossesBox(geom, box);
      if (matched) {
        geometryIds.push(id);
        continue;
      }
      // window mode: 기하 전체가 box 안에 있어야 selection — partial vertex 만 box 안인
      // 경우는 의미 없음. crossing mode 에서만 부분 vertex 선택 (CATIA 컨벤션).
      if (windowMode) continue;
      // point geom 은 자체가 entity 라 vertex 로 추가하지 않음 (geometry hit 으로만 다룸).
      if (geom.type === "point") continue;
      const verts = extractVertices(geom);
      for (const v of verts) {
        if (v.x >= box.minX && v.x <= box.maxX && v.y >= box.minY && v.y <= box.maxY) {
          vertexHits.push(v);
        }
      }
    }
    return { geometryIds, vertexHits };
  }

  // Window 모드: 기하 전체가 box 내부에 포함
  private _geomInsideBox(
    geom: SerializedGeometry,
    box: { minX: number; minY: number; maxX: number; maxY: number },
  ): boolean {
    // 원/원호는 bounding box로 판정 (key points만으로는 부족)
    if (geom.type === "circle") {
      return (
        geom.cx - geom.r >= box.minX &&
        geom.cx + geom.r <= box.maxX &&
        geom.cy - geom.r >= box.minY &&
        geom.cy + geom.r <= box.maxY
      );
    }
    if (geom.type === "arc" || geom.type === "ellipse") {
      const aabb = this._getGeomAABB(geom);
      if (!aabb) return false;
      return (
        aabb.minX >= box.minX &&
        aabb.maxX <= box.maxX &&
        aabb.minY >= box.minY &&
        aabb.maxY <= box.maxY
      );
    }
    const pts = this._getGeomKeyPoints(geom);
    return (
      pts.length > 0 &&
      pts.every(
        (p) =>
          p.x >= box.minX &&
          p.x <= box.maxX &&
          p.y >= box.minY &&
          p.y <= box.maxY,
      )
    );
  }

  // Crossing 모드: 기하가 box와 교차하거나 내부에 포함
  private _geomCrossesBox(
    geom: SerializedGeometry,
    box: { minX: number; minY: number; maxX: number; maxY: number },
  ): boolean {
    // 먼저 AABB 사전 필터
    const aabb = this._getGeomAABB(geom);
    if (!aabb) return false;
    if (
      aabb.minX > box.maxX ||
      aabb.maxX < box.minX ||
      aabb.minY > box.maxY ||
      aabb.maxY < box.minY
    )
      return false;

    switch (geom.type) {
      case "point":
        return (
          geom.x >= box.minX &&
          geom.x <= box.maxX &&
          geom.y >= box.minY &&
          geom.y <= box.maxY
        );
      case "line":
        return this._segmentIntersectsBox(
          geom.x1,
          geom.y1,
          geom.x2,
          geom.y2,
          box,
        );
      case "circle": {
        // 원의 둘레가 box와 교차하는지 검사
        // 1) 원 중심이 box 내부 → 교차
        if (
          geom.cx >= box.minX &&
          geom.cx <= box.maxX &&
          geom.cy >= box.minY &&
          geom.cy <= box.maxY
        )
          return true;
        // 2) box의 각 변이 원과 교차
        const edges = this._boxEdges(box);
        for (const [x1, y1, x2, y2] of edges) {
          if (
            this._segmentIntersectsCircle(
              x1,
              y1,
              x2,
              y2,
              geom.cx,
              geom.cy,
              geom.r,
            )
          )
            return true;
        }
        return false;
      }
      default: {
        // arc, curve, polygon: 꼭짓점 중 하나라도 box 내부이거나 AABB 교차이면 선택
        const pts = this._getGeomKeyPoints(geom);
        if (
          pts.some(
            (p) =>
              p.x >= box.minX &&
              p.x <= box.maxX &&
              p.y >= box.minY &&
              p.y <= box.maxY,
          )
        )
          return true;
        // 세그먼트 기반 교차 (curve/polygon의 인접 점 사이 선분)
        for (let i = 0; i < pts.length - 1; i++) {
          if (
            this._segmentIntersectsBox(
              pts[i].x,
              pts[i].y,
              pts[i + 1].x,
              pts[i + 1].y,
              box,
            )
          )
            return true;
        }
        return false;
      }
    }
  }

  // 기하의 주요 점 목록 (꼭짓점/제어점)
  private _getGeomKeyPoints(
    geom: SerializedGeometry,
  ): { x: number; y: number }[] {
    switch (geom.type) {
      case "point":
        return [{ x: geom.x, y: geom.y }];
      case "line":
        return [
          { x: geom.x1, y: geom.y1 },
          { x: geom.x2, y: geom.y2 },
        ];
      case "circle":
        return [{ x: geom.cx, y: geom.cy }];
      case "arc":
        return [
          { x: geom.cx, y: geom.cy },
          {
            x: geom.cx + geom.r * Math.cos(geom.startAngle),
            y: geom.cy + geom.r * Math.sin(geom.startAngle),
          },
          {
            x: geom.cx + geom.r * Math.cos(geom.endAngle),
            y: geom.cy + geom.r * Math.sin(geom.endAngle),
          },
        ];
      case "curve":
        return geom.points;
      case "ellipse":
        return [{ x: geom.cx, y: geom.cy }];
      case "polygon":
        return geom.vertices;
    }
  }

  // 선분이 box와 교차하는지 검사 (Cohen-Sutherland 알고리즘)
  private _segmentIntersectsBox(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    box: { minX: number; minY: number; maxX: number; maxY: number },
  ): boolean {
    // 끝점이 box 안에 있으면 교차
    if (x1 >= box.minX && x1 <= box.maxX && y1 >= box.minY && y1 <= box.maxY)
      return true;
    if (x2 >= box.minX && x2 <= box.maxX && y2 >= box.minY && y2 <= box.maxY)
      return true;
    // box의 4변과 선분 교차 검사
    const edges = this._boxEdges(box);
    for (const [ex1, ey1, ex2, ey2] of edges) {
      if (this._segmentsIntersect(x1, y1, x2, y2, ex1, ey1, ex2, ey2))
        return true;
    }
    return false;
  }

  // 두 선분이 교차하는지 검사
  private _segmentsIntersect(
    ax1: number,
    ay1: number,
    ax2: number,
    ay2: number,
    bx1: number,
    by1: number,
    bx2: number,
    by2: number,
  ): boolean {
    const d1 = (bx2 - bx1) * (ay1 - by1) - (by2 - by1) * (ax1 - bx1);
    const d2 = (bx2 - bx1) * (ay2 - by1) - (by2 - by1) * (ax2 - bx1);
    const d3 = (ax2 - ax1) * (by1 - ay1) - (ay2 - ay1) * (bx1 - ax1);
    const d4 = (ax2 - ax1) * (by2 - ay1) - (ay2 - ay1) * (bx2 - ax1);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    // 공선(collinear) 케이스 — 선분이 겹치는 경우
    if (Math.abs(d1) < 1e-10 && this._onSegment(bx1, by1, bx2, by2, ax1, ay1))
      return true;
    if (Math.abs(d2) < 1e-10 && this._onSegment(bx1, by1, bx2, by2, ax2, ay2))
      return true;
    if (Math.abs(d3) < 1e-10 && this._onSegment(ax1, ay1, ax2, ay2, bx1, by1))
      return true;
    if (Math.abs(d4) < 1e-10 && this._onSegment(ax1, ay1, ax2, ay2, bx2, by2))
      return true;
    return false;
  }

  private _onSegment(
    sx1: number,
    sy1: number,
    sx2: number,
    sy2: number,
    px: number,
    py: number,
  ): boolean {
    return (
      px >= Math.min(sx1, sx2) &&
      px <= Math.max(sx1, sx2) &&
      py >= Math.min(sy1, sy2) &&
      py <= Math.max(sy1, sy2)
    );
  }

  // 선분이 원과 교차하는지 검사
  private _segmentIntersectsCircle(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    cx: number,
    cy: number,
    r: number,
  ): boolean {
    const dx = x2 - x1,
      dy = y2 - y1;
    const fx = x1 - cx,
      fy = y1 - cy;
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - r * r;
    let disc = b * b - 4 * a * c;
    if (disc < 0) return false;
    disc = Math.sqrt(disc);
    const t1 = (-b - disc) / (2 * a);
    const t2 = (-b + disc) / (2 * a);
    return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1) || (t1 < 0 && t2 > 1);
  }

  private _boxEdges(box: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }): [number, number, number, number][] {
    return [
      [box.minX, box.minY, box.maxX, box.minY], // 하단
      [box.maxX, box.minY, box.maxX, box.maxY], // 우측
      [box.maxX, box.maxY, box.minX, box.maxY], // 상단
      [box.minX, box.maxY, box.minX, box.minY], // 좌측
    ];
  }

  private _getGeomAABB(
    geom: SerializedGeometry,
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    return computeAABB(geom);
  }

  // --- 직렬화 ---

  serialize(): SerializedGeometry[] {
    // 참조 기하는 직렬화에서 제외
    return [...this.geometries.values()].filter(
      (g) => !("isReference" in g && g.isReference),
    );
  }

  deserialize(data: SerializedGeometry[]): void {
    this.geometries.clear();
    const migrated = SketchGeometryStore._migrateGeometries(data);
    for (const geom of migrated) {
      this.geometries.set(geom.id, geom);
    }
    this.selectedIds = [];
    this.selectedVertices = [];
    this.selectedConstraintId = null;
    this.hoveredItem = null;
    this.recomputeFaces();
    this.requestRender();
  }

  // 레거시 rectangle → 4 line 마이그레이션 (v2.1 이전 .mth 파일 호환)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static _migrateGeometries(geoms: any[]): SerializedGeometry[] {
    const result: SerializedGeometry[] = [];
    for (const g of geoms) {
      if (g.type === "rectangle") {
        const { x, y, width: w, height: h, id, isConstruction } = g;
        const extra = isConstruction ? { isConstruction: true as const } : {};
        result.push(
          {
            type: "line",
            id: `${id}_e0`,
            x1: x,
            y1: y,
            x2: x + w,
            y2: y,
            ...extra,
          },
          {
            type: "line",
            id: `${id}_e1`,
            x1: x + w,
            y1: y,
            x2: x + w,
            y2: y + h,
            ...extra,
          },
          {
            type: "line",
            id: `${id}_e2`,
            x1: x + w,
            y1: y + h,
            x2: x,
            y2: y + h,
            ...extra,
          },
          {
            type: "line",
            id: `${id}_e3`,
            x1: x,
            y1: y + h,
            x2: x,
            y2: y,
            ...extra,
          },
        );
      } else {
        result.push(g as SerializedGeometry);
      }
    }
    return result;
  }

  clear(): void {
    this.geometries.clear();
    this.shapes = [];
    this.selectedIds = [];
    this.selectedVertices = [];
    this.selectedConstraintId = null;
    this.hoveredItem = null;
    this.requestRender();
  }

  // --- 고아 구속조건 정리 (undo 후 삭제된 기하를 참조하는 구속 제거) ---

  cleanOrphanConstraints(): void {
    if (!this.constraintStore) return;
    const toRemove: string[] = [];
    for (const [id, c] of this.constraintStore.constraints) {
      const refIds = this._getConstraintGeomIds(c);
      if (refIds.some((gid) => !this.geometries.has(gid))) {
        toRemove.push(id);
      }
    }
    if (toRemove.length > 0) {
      this.constraintStore.removeConstraints(toRemove);
    }
  }

  // 구속조건이 참조하는 모든 기하 ID 추출
  private _getConstraintGeomIds(c: SketchConstraint): string[] {
    return getConstraintGeomIds(c);
  }

  // --- 구속조건 솔버 실행 ---

  solveConstraints(fixedPointKeys?: Set<PointKey>): void {
    if (!this.solver?.isReady || !this.constraintStore) return;
    if (this.constraintStore.constraints.size === 0) {
      this.solveStatus = "ok";
      this.dof = -1;
      this.elementConstraintStatus.clear();
      return;
    }

    this._solveWithPlanegcs(fixedPointKeys);
  }

  // planegcs WASM solver path — sync.
  private _solveWithPlanegcs(fixedPointKeys?: Set<PointKey>): void {
    if (!this.solver?.isReady || !this.constraintStore) return;
    const result = this.solver.solve(
      this.geometries,
      this.constraintStore.constraints,
      fixedPointKeys,
    );
    this.solveStatus = result.status;
    this.dof = result.dof;
    this._computeElementConstraintStatus();
  }

  // 요소별 구속 상태 계산: 각 요소의 고유 DOF 대비 구속이 소비한 DOF 비교
  private _computeElementConstraintStatus(): void {
    this.elementConstraintStatus.clear();
    if (!this.constraintStore) return;

    // 요소 고유 DOF: point=2, line=4, circle=3, arc=5, ellipse=5, curve=N*2, polygon=N*2
    const getInherentDof = (geom: SerializedGeometry): number => {
      switch (geom.type) {
        case "point":
          return 2;
        case "line":
          return 4;
        case "circle":
          return 3;
        case "arc":
          return 5;
        case "ellipse":
          return 5;
        case "curve":
          return geom.points.length * 2;
        case "polygon":
          return geom.vertices.length * 2;
        default:
          return 0;
      }
    };

    // 구속 타입별 요소당 소비 DOF
    const getConsumedDofPerElement = (c: SketchConstraint): number => {
      switch (c.type) {
        case "fix":
          return 2;
        case "horizontal":
        case "vertical":
          return 1;
        case "coincident":
          return 1;
        case "distance":
        case "line_length":
        case "angle":
        case "line_angle":
        case "point_line_distance":
          return 1;
        case "radius":
        case "diameter":
          return 1;
        case "parallel":
        case "perpendicular":
        case "colinear":
          return 1;
        case "point_on_line":
        case "point_on_circle":
          return 1;
        case "tangent":
          return 1;
        case "equal":
        case "equal_radius":
          return 1;
        case "symmetric":
          return 1;
        case "midpoint":
          return 1;
        case "concentric":
          return 1;
        case "horizontal_distance":
        case "vertical_distance":
          return 1;
        case "equidistant":
          return 1;
        case "fix_together":
          return 2;
        default:
          return 0;
      }
    };

    // 요소별 소비 DOF 누적
    const consumedDof = new Map<string, number>();

    for (const c of this.constraintStore.constraints.values()) {
      // 참조 전용(driven) 구속은 솔버에서 무시하므로 상태 계산에서도 제외
      if ("isReference" in c && c.isReference) continue;

      const geomIds = getConstraintGeomIds(c);
      const perElem = getConsumedDofPerElement(c);
      for (const gid of geomIds) {
        consumedDof.set(gid, (consumedDof.get(gid) ?? 0) + perElem);
      }
    }

    // over-constrained/error 상태이면 구속에 참여하는 모든 요소를 over-constrained로 표시
    if (
      this.solveStatus === "over-constrained" ||
      this.solveStatus === "error"
    ) {
      for (const gid of consumedDof.keys()) {
        this.elementConstraintStatus.set(gid, "over-constrained");
      }
      return;
    }

    // 요소별 상태 결정
    for (const [gid, consumed] of consumedDof) {
      const geom = this.geometries.get(gid);
      if (!geom) continue;
      const inherent = getInherentDof(geom);
      if (
        consumed >= inherent &&
        (this.solveStatus === "ok" || this.solveStatus === "fully-constrained")
      ) {
        this.elementConstraintStatus.set(gid, "fully-constrained");
      } else {
        this.elementConstraintStatus.set(gid, "under-constrained");
      }
    }
  }

  // 라이브 드래그 중 구속 솔버 실행 (커맨드 히스토리 없이 좌표만 반영)
  // fixedPointKeys: 드래그 중 고정할 점 ("geomId:vertexIndex" 집합)
  solveLive(fixedPointKeys?: Set<PointKey>): void {
    this.solveConstraints(fixedPointKeys);
    this.refreshShapeVertices();
    this.markGeometryChanged();
    this.requestRender();
  }

  // --- 폐루프 면 ---

  recomputeFaces(): void {
    this.recomputeShapes();
    this.markGeometryChanged();
  }

  /**
   * Shape 을 직접 등록 (DrawTool 이 closed loop 완성 시 호출).
   *
   * 호출자는 lineIds 를 임의의 순서로 push 해도 됨 — orderLineIdsByCoincidence 가 coincident
   * chain 따라 closed loop 순서로 자동 정렬. zigzag (예: ElongatedHole 의 `[line0, line1,
   * arc0, arc1]`) 도 `[line0, arc0, line1, arc1]` 로 재배열되어 vertices 가 self-intersecting
   * polygon 으로 그려지지 않음.
   *
   * shape.id 는 정렬되지 않은 lineIds set 기반 (sort) — 같은 edge 묶음을 같은 shape 로 식별.
   */
  registerShape(lineIds: string[], planeKey = ""): SketchShape {
    const id = `shape_${[...lineIds].sort().join(",")}`;
    // 이미 동일 lineIds로 등록된 shape이 있으면 반환
    const existing = this.shapes.find((s) => s.id === id);
    if (existing) return existing;
    // constraintStore 가 미연결인 케이스 (테스트 / 초기 setup) 는 빈 Map 으로 fallback —
    // coincident 정보 없으면 ordering 알고리즘이 chain 을 못 찾고 원본 순서 그대로 반환.
    const ordered = orderLineIdsByCoincidence(
      lineIds,
      this.geometries,
      this.constraintStore?.constraints ?? new Map(),
    );
    // sceneIndex 는 미할당 (optional) — 명시적 undefined 를 두면 isModified 비교가 디스크
    // round-trip 결과 (key 자체 없음) 와 어긋남.
    const shape: SketchShape = {
      id,
      lineIds: ordered,
      planeKey,
      baseAngle: 0,
      holes: [],
      vertices: [],
      origin: "declared",
    };
    shape.vertices = getShapeVerticesFromGeometries(shape, this.geometries);
    this.shapes.push(shape);
    this.markShapesChanged();
    return shape;
  }

  /** lineIds로 shape 삭제 */
  unregisterShape(lineIds: string[]): void {
    const id = `shape_${[...lineIds].sort().join(",")}`;
    this.shapes = this.shapes.filter((s) => s.id !== id);
    this.markShapesChanged();
  }

  /**
   * 주어진 기하를 쓰는 shape 를 목록 위치와 함께 복제해 둔다 (기하를 지우는 커맨드의 execute 용).
   *
   * 기하가 지워지면 recomputeShapes 가 그 shape 를 버린다. undo 로 기하만 되살리면 같은 루프가
   * 이미지·origin·sceneIndex 같은 설정 없는 detected shape 로 새로 잡히므로, undo 에서
   * restoreShapes 로 이 사본을 되돌려야 한다.
   */
  snapshotShapesUsing(geomIds: Set<string>): ShapeSnapshot[] {
    const saved: ShapeSnapshot[] = [];
    this.shapes.forEach((shape, index) => {
      if (shape.lineIds.some((id) => geomIds.has(id))) {
        // 얕은 복사 — image dataURL(수 MB)은 불변 문자열이라 공유하고, 배열 필드만 새로 만든다
        const copy = { ...shape, lineIds: [...shape.lineIds], vertices: [...shape.vertices], holes: [...shape.holes] };
        saved.push({ index, shape: copy });
      }
    });
    return saved;
  }

  /** snapshotShapesUsing 으로 복제해 둔 shape 를 원래 위치에 되돌림 (같은 id 가 있으면 교체) */
  restoreShapes(saved: ShapeSnapshot[]): void {
    if (saved.length === 0) return;
    for (const { index, shape } of saved) {
      this.shapes = this.shapes.filter((s) => s.id !== shape.id);
      this.shapes.splice(Math.min(index, this.shapes.length), 0, shape);
    }
    this.markShapesChanged();
  }

  /**
   * Shape vertices 갱신 + stale lineIds 정리 + free-hand closed loop auto-detect.
   *
   * 동작:
   *  1. 존재하지 않는 geometry 를 참조하는 shape 제거 (declared / detected 공통)
   *  2. declared shape 의 lineIds 모음 → detect 알고리즘에서 제외 (도메인 정합: declared 끼리
   *     겹쳐도 서로 영향 없게)
   *  3. free-hand line/arc 만으로 detect → detected shape 들 추출
   *  4. 기존 detected shape 중 새 detect 결과에 없는 건 제거. 새로 발견된 건 push.
   *  5. vertices 캐시 갱신.
   *
   * "declared" = 도구가 registerShape 로 명시 추가 (Rectangle / Profile / ElongatedHole 등).
   * "detected" = Line 도구로 자유롭게 그린 line 들이 closed loop 를 형성하면 자동 감지.
   *
   * 기존 shape 의 origin 이 undefined 면 declared 로 간주 (구 버전 .mth 호환).
   */
  recomputeShapes(): void {
    // 1. stale lineIds 정리
    this.shapes = this.shapes.filter((s) =>
      s.lineIds.every((lid) => this.geometries.has(lid)),
    );

    // 2. declared shape 의 lineIds 수집
    const declaredLineIds = new Set<string>();
    for (const s of this.shapes) {
      if (s.origin === "detected") continue;
      for (const lid of s.lineIds) declaredLineIds.add(lid);
    }

    // 3. detect (constraintStore 미연결이면 detect 자체를 skip — 빈 결과로 진행)
    const detected = this.constraintStore
      ? detectClosedShapes(this.geometries, this.constraintStore.constraints, declaredLineIds)
      : [];

    // 4. detected merge
    //   - 기존 store.shapes 의 detected 중 새 결과에 없는 id 는 제거
    //   - 새 결과 중 기존 store 에 없는 id 는 push
    //   - 같은 id (lineIds set 기반) 가 양쪽에 있으면 기존 유지 (role / sceneIndex 등 사용자
    //     설정 보존)
    const newDetectedIds = new Set(detected.map((d) => d.id));
    this.shapes = this.shapes.filter((s) => s.origin !== "detected" || newDetectedIds.has(s.id));
    const existingIds = new Set(this.shapes.map((s) => s.id));
    for (const d of detected) {
      if (!existingIds.has(d.id)) this.shapes.push(d);
    }

    // 5. vertices 캐시 갱신
    this.refreshShapeVertices();
  }

  /** Shape vertices 캐시 갱신 (shapes 재생성 없이 현재 geometry에서 좌표만 업데이트) */
  refreshShapeVertices(): void {
    for (const s of this.shapes) {
      s.vertices = getShapeVerticesFromGeometries(s, this.geometries);
      for (const h of s.holes) {
        h.vertices = getShapeVerticesFromGeometries(h, this.geometries);
      }
    }
  }

  /** Shape 기반 hitTest (면적 오름차순 — 작은 면 우선, holes 포함) */
  hitTestShape(pos: { x: number; y: number }): SketchShape | null {
    // solid + hole 모두 수집 (숨겨진 shape 제외)
    const all: { shape: SketchShape; area: number }[] = [];
    for (const s of this.shapes) {
      // lineIds가 모두 hiddenGeoIds에 포함되면 hitTest에서 제외
      if (
        s.lineIds.length > 0 &&
        s.lineIds.every((lid) => this.hiddenGeoIds.has(lid))
      )
        continue;
      if (s.vertices.length >= 3)
        all.push({ shape: s, area: Math.abs(this._polyArea(s.vertices)) });
      for (const h of s.holes) {
        if (h.vertices.length >= 3)
          all.push({ shape: h, area: Math.abs(this._polyArea(h.vertices)) });
      }
    }
    all.sort((a, b) => a.area - b.area);

    for (const { shape } of all) {
      if (this._pointInPolygon(pos, shape.vertices)) return shape;
    }
    return null;
  }

  /**
   * 점/선/면 tier 를 분리해 반환. 같은 tier 안에서 reference (REF_ORIGIN / axis) 가 sub-1 최우선.
   *
   * 1. 점 tier (좁은 반경 = radius * VERTEX_HIT_RATIO)
   *    - sub-1: REF_ORIGIN_ID (origin point)
   *    - sub-2: standalone point geom / geometry endpoint vertex — distance ascending.
   * 2. 선 tier (radius)
   *    - sub-1: axis (REF_X_AXIS / REF_Y_AXIS)
   *    - sub-2: standard / construction / reference line / arc / circle / curve(0.85×) / polygon
   *             — distance ascending. curve 만 좁은 hit zone.
   * 3. 면 tier — 면적 작은 것 우선.
   *
   * constraint hits 는 외부 (useSketchPointerHandler.collectAllHitCandidates) 가 점 / 선 사이에 끼워넣음.
   * filter: "all" 외 값은 해당 tier 만 검사.
   */
  hitTestSplit(
    pos: { x: number; y: number },
    radius: number,
    filter: "all" | "vertex" | "edge" | "face" = "all",
  ): { point: HitResult[]; edge: HitResult[]; face: HitResult[] } {
    return this._collectHitCandidatesSplit(pos, radius, filter);
  }

  private _collectHitCandidates(
    pos: { x: number; y: number },
    radius: number,
    filter: "all" | "vertex" | "edge" | "face",
  ): HitResult[] {
    const split = this._collectHitCandidatesSplit(pos, radius, filter);
    return [...split.point, ...split.edge, ...split.face];
  }

  private _collectHitCandidatesSplit(
    pos: { x: number; y: number },
    radius: number,
    filter: "all" | "vertex" | "edge" | "face",
  ): { point: HitResult[]; edge: HitResult[]; face: HitResult[] } {
    const pointTier: HitResult[] = [];
    const edgeTier: HitResult[] = [];
    const faceTier: HitResult[] = [];
    const allowVertex = filter === "all" || filter === "vertex";
    const allowEdge = filter === "all" || filter === "edge";
    const allowFace = filter === "all" || filter === "face";

    // 1. 점 tier — sub-1: REF_ORIGIN / sub-2: 그 외 점 + endpoint vertex (distance ascending)
    if (allowVertex) {
      const vertexRadius = radius * VERTEX_HIT_RATIO;
      const refPointHits: HitResult[] = [];
      const otherPointHits: HitResult[] = [];

      for (const [id, geom] of this.geometries) {
        if (this.hiddenGeoIds.has(id)) continue;

        if (geom.type === "point") {
          // standalone point / REF_ORIGIN
          const d = Math.hypot(pos.x - geom.x, pos.y - geom.y);
          if (d >= vertexRadius) continue;
          const hit: HitResult = {
            kind: "geometry",
            distance: d,
            geomId: id,
            geomSubKind: "point",
          };
          if (id === REF_ORIGIN_ID) refPointHits.push(hit);
          else otherPointHits.push(hit);
          continue;
        }

        // 그 외 geometry: endpoint vertex 검사
        // - axis endpoint: 무한선 개념이라 (1,0) / (0,1) 같은 임의 endpoint 노출 안 함
        if (isAxisId(id)) continue;
        const verts = extractVertices(geom);
        for (const v of verts) {
          const d = Math.hypot(pos.x - v.x, pos.y - v.y);
          if (d < vertexRadius) {
            otherPointHits.push({
              kind: "vertex",
              distance: d,
              geomId: v.geomId,
              vertexIndex: v.vertexIndex,
              x: v.x,
              y: v.y,
            });
          }
        }
      }
      refPointHits.sort((a, b) => a.distance - b.distance);
      otherPointHits.sort((a, b) => a.distance - b.distance);
      pointTier.push(...refPointHits, ...otherPointHits);
    }

    // 2. 선 tier — sub-1: axis / sub-2: standard + construction + reference 선 (distance ascending)
    //
    // 우선순위 변경 (081):
    //   - 이전: standard → construction → reference tier-strict (axis 는 reference tier 최하위)
    //   - 현재: axis 만 sub-1 으로 명시 승격 (CATIA 식 — 축선은 자주 선택해야 하는 reference),
    //          그 외 standard / construction / reference line 는 distance ascending 통합.
    //          construction 이 standard 보다 마우스에 가까우면 먼저 hit — 빽빽한 영역에서 자연스러움.
    if (allowEdge) {
      const axisHits: HitResult[] = [];
      const lineHits: HitResult[] = [];

      // Phase 3 — AABB pre-filter. exact distance 계산 전 bbox+radius 밖이면 skip.
      // 특히 curve (NURBS) 의 nurbsEvaluate N×8 비용을 미리 회피.
      const aabbMinX = pos.x - radius;
      const aabbMaxX = pos.x + radius;
      const aabbMinY = pos.y - radius;
      const aabbMaxY = pos.y + radius;

      for (const [id, geom] of this.geometries) {
        if (this.hiddenGeoIds.has(id)) continue;
        if (geom.type === "point") continue; // 점 tier 에서 처리

        // axis 는 무한선 — AABB pre-filter 우회 (bbox 가 null 또는 무의미).
        const isAxis = geom.type === "axis";
        if (!isAxis) {
          const bbox = this._getGeomAABB(geom);
          if (
            bbox &&
            (bbox.maxX < aabbMinX || bbox.minX > aabbMaxX || bbox.maxY < aabbMinY || bbox.minY > aabbMaxY)
          ) {
            continue;
          }
        }

        const axisD = this._axisHitDistance(pos, id, geom, radius);
        const d = axisD !== null ? axisD : this._distanceToGeometry(pos, geom);
        // curve(NURBS) 는 빽빽한 영역에서 hit 충돌 잦으므로 좁게 (×0.85)
        const typeRadius = geom.type === "curve" ? radius * 0.85 : radius;
        if (d >= typeRadius) continue;
        const hit: HitResult = isAxis
          ? { kind: "geometry", distance: d, geomId: id, geomSubKind: "axis" }
          : { kind: "geometry", distance: d, geomId: id };
        if (isAxis) axisHits.push(hit);
        else lineHits.push(hit);
      }
      axisHits.sort((a, b) => a.distance - b.distance);
      lineHits.sort((a, b) => a.distance - b.distance);
      edgeTier.push(...axisHits, ...lineHits);
    }

    // 3. 면 tier — 면적 작은 것 우선
    if (allowFace) {
      const faceHits: { shape: SketchShape; area: number }[] = [];
      for (const s of this.shapes) {
        if (s.lineIds.length > 0 && s.lineIds.every((lid) => this.hiddenGeoIds.has(lid))) continue;
        if (s.vertices.length < 3) continue;
        if (this._pointInPolygon(pos, s.vertices)) {
          faceHits.push({ shape: s, area: Math.abs(this._polyArea(s.vertices)) });
        }
      }
      faceHits.sort((a, b) => a.area - b.area);
      for (const fh of faceHits) {
        faceTier.push({ kind: "face", distance: 0, faceId: fh.shape.id });
      }
    }

    return { point: pointTier, edge: edgeTier, face: faceTier };
  }

  /** geometry까지의 최단 거리 계산 */
  private _distanceToGeometry(
    pos: { x: number; y: number },
    geom: SerializedGeometry,
  ): number {
    switch (geom.type) {
      case "point":
        return Math.hypot(pos.x - geom.x, pos.y - geom.y);
      case "line":
        return Math.sqrt(
          pointToSegmentDist2(pos, geom.x1, geom.y1, geom.x2, geom.y2),
        );
      case "circle": {
        const d = Math.hypot(pos.x - geom.cx, pos.y - geom.cy);
        return Math.abs(d - geom.r);
      }
      case "arc": {
        const dx = pos.x - geom.cx,
          dy = pos.y - geom.cy;
        const angle = Math.atan2(dy, dx);
        if (isAngleBetween(angle, geom.startAngle, geom.endAngle)) {
          return Math.abs(Math.hypot(dx, dy) - geom.r);
        }
        // arc 밖이면 endpoint까지 거리
        const s = {
          x: geom.cx + geom.r * Math.cos(geom.startAngle),
          y: geom.cy + geom.r * Math.sin(geom.startAngle),
        };
        const e = {
          x: geom.cx + geom.r * Math.cos(geom.endAngle),
          y: geom.cy + geom.r * Math.sin(geom.endAngle),
        };
        return Math.min(
          Math.hypot(pos.x - s.x, pos.y - s.y),
          Math.hypot(pos.x - e.x, pos.y - e.y),
        );
      }
      case "ellipse": {
        const cosR = Math.cos(-geom.rotation),
          sinR = Math.sin(-geom.rotation);
        const dx = pos.x - geom.cx,
          dy = pos.y - geom.cy;
        const lx = dx * cosR - dy * sinR,
          ly = dx * sinR + dy * cosR;
        const a = Math.atan2(ly, lx);
        const ex = geom.rx * Math.cos(a),
          ey = geom.ry * Math.sin(a);
        return Math.hypot(lx - ex, ly - ey);
      }
      case "curve": {
        // NURBS 평가된 곡선 위의 세그먼트 중 최단거리 (렌더링보다 적은 세분화).
        const evaluated = nurbsEvaluate(
          geom.points,
          geom.degree,
          geom.knots,
          geom.weights,
          geom.points.length * 8,
        );
        let best = Infinity;
        for (let i = 0; i < evaluated.length - 1; i++) {
          const d2 = pointToSegmentDist2(
            pos,
            evaluated[i].x,
            evaluated[i].y,
            evaluated[i + 1].x,
            evaluated[i + 1].y,
          );
          if (d2 < best) best = d2;
        }
        return Math.sqrt(best);
      }
      case "axis": {
        // 무한선 — H/V axis. AXIS_SCREEN_PX 길이 제한은 _axisHitDistance 가 처리하므로 여기는
        // 무한선 perpendicular 거리만. axis 가 _collectHitCandidatesSplit 에서는 항상
        // _axisHitDistance 경로로 가지만 다른 caller (예: edge 도구) 가 부르면 안전 fallback.
        return geom.direction === "h" ? Math.abs(pos.y) : Math.abs(pos.x);
      }
      case "polygon": {
        // polygon 은 edge segment 들 중 최단거리로 hit 판정.
        const verts = geom.vertices;
        if (verts.length < 2) return Infinity;
        let best = Infinity;
        for (let i = 0; i < verts.length; i++) {
          const a = verts[i];
          const b = verts[(i + 1) % verts.length];
          const d2 = pointToSegmentDist2(pos, a.x, a.y, b.x, b.y);
          if (d2 < best) best = d2;
        }
        return Math.sqrt(best);
      }
      default:
        return Infinity;
    }
  }

  private _pointInPolygon(
    p: { x: number; y: number },
    verts: { x: number; y: number }[],
  ): boolean {
    let inside = false;
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
      const xi = verts[i].x,
        yi = verts[i].y;
      const xj = verts[j].x,
        yj = verts[j].y;
      if (
        yi > p.y !== yj > p.y &&
        p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
      ) {
        inside = !inside;
      }
    }
    return inside;
  }

  private _polyArea(verts: { x: number; y: number }[]): number {
    let area = 0;
    for (let i = 0; i < verts.length; i++) {
      const c = verts[i],
        n = verts[(i + 1) % verts.length];
      area += c.x * n.y - n.x * c.y;
    }
    return area / 2;
  }

  // --- 유틸리티 ---

  /**
   * Axis line (REF_X_AXIS_ID / REF_Y_AXIS_ID) 의 hit 거리 계산. 화면에 그려진 화살표 길이
   * (AXIS_SCREEN_PX) 만큼만 매칭 — 시각적 영역 = hit 영역 정합성. axis 가 아니면 null.
   */
  private _axisHitDistance(
    pos: { x: number; y: number },
    id: string,
    geom: SerializedGeometry,
    radius: number,
  ): number | null {
    if (geom.type !== "axis") return null;
    // 무한선이지만 화면에 그려진 화살표 길이 (AXIS_SCREEN_PX) 만큼만 hit. 원점에서 direction
    // 방향으로 hitLen 까지의 segment 와의 거리.
    const hitLen = radius * (AXIS_SCREEN_PX / HIT_BUFFER);
    const tipX = geom.direction === "h" ? hitLen : 0;
    const tipY = geom.direction === "v" ? hitLen : 0;
    return Math.sqrt(pointToSegmentDist2(pos, 0, 0, tipX, tipY));
  }
}

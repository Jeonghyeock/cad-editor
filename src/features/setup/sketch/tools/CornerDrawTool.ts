// Corner 도구: 두 선분을 교차점까지 연장/트림하여 코너 생성
// 반지름 입력 없이 즉시 실행 (Fillet radius=0과 동일한 결과)
// 2-상태 머신: idle → line1-selected → 즉시 실행

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

type CornerState = "idle" | "line1-selected";

export class CornerDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "corner";


  selectionOnly = true;
  // 스냅 필터: endpoint, origin, nearest만 허용
  snapFilter: Set<SnapType> | null = new Set<SnapType>(["endpoint", "origin", "nearest"]);

  private _state: CornerState = "idle";
  private _line1: (SerializedGeometry & { type: "line" }) | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    const hitRadius = this.inferenceRadius || 5;

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
    const hitRadius = this.inferenceRadius || 5;

    if (this._state === "idle") {
      this._handleIdleMove(store, rawPos, hitRadius);
    } else if (this._state === "line1-selected") {
      this._handleLine1SelectedMove(store, rawPos, hitRadius);
    }

    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {}

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
    return this._state !== "idle";
  }

  cancel(): void {
    super.cancel();
    this._state = "idle";
    this._line1 = null;
  }

  // --- idle 상태 클릭 ---

  private _handleIdleClick(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    hitRadius: number,
  ): void {
    // 1. 꼭짓점 클릭 → 2선이 만나는 vertex
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
          this._applyCorner(store, l1, l2, hit, keepDir1, keepDir2);
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
        this.previews = [{ ...geom, id: `__corner_hl_${geom.id}__` }];
        store.requestRender();
        return;
      }
    }

    // 3. 교차점 근처 클릭 폴백
    const searchRadius = hitRadius * INTERSECTION_SEARCH_MULTIPLIER;
    const cornerResult = findCornerNearPoint(store, rawPos, searchRadius);
    if (cornerResult) {
      const keepDir1 = getKeepDirFromT(cornerResult.intersection.t1);
      const keepDir2 = getKeepDirFromT(cornerResult.intersection.t2);
      this._applyCorner(store, cornerResult.line1, cornerResult.line2, cornerResult.intersection, keepDir1, keepDir2);
    }
  }

  // --- line1-selected 상태 클릭 ---

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

    this._applyCorner(store, this._line1, line2, hit, keepDir1, keepDir2);
  }

  // --- hover ---

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
        this.preview = { type: "point", id: "__corner_hover__", x: vertex.x, y: vertex.y };
        this.previews = [
          { ...twoLines[0], id: `__corner_hl_${twoLines[0].id}__` },
          { ...twoLines[1], id: `__corner_hl_${twoLines[1].id}__` },
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
        this.previews = [{ ...geom, id: `__corner_hl_${geom.id}__` }];
        return;
      }
    }

    // 교차점 근처 호버
    const searchRadius = hitRadius * INTERSECTION_SEARCH_MULTIPLIER;
    const cornerResult = findCornerNearPoint(store, rawPos, searchRadius);
    if (cornerResult) {
      store.hoveredItem = { kind: "geometry", geomId: cornerResult.line1.id };
      this.preview = { type: "point", id: "__corner_hover__", x: cornerResult.intersection.x, y: cornerResult.intersection.y };
      this.previews = [
        { ...cornerResult.line1, id: `__corner_hl_${cornerResult.line1.id}__` },
        { ...cornerResult.line2, id: `__corner_hl_${cornerResult.line2.id}__` },
      ];
      return;
    }

    store.hoveredItem = null;
    this.preview = null;
    this.previews = [];
  }

  private _handleLine1SelectedMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    hitRadius: number,
  ): void {
    if (!this._line1) return;

    const line1Preview: SerializedGeometry = { ...this._line1, id: `__corner_hl_${this._line1.id}__` };

    const hitId = store.hitTest(rawPos, hitRadius);
    if (hitId && hitId !== this._line1.id) {
      const geom = store.geometries.get(hitId);
      if (geom && geom.type === "line" && !isRefOrConstruction(geom)) {
        const hit = lineLineIntersectionUnbounded(
          this._line1.x1, this._line1.y1, this._line1.x2, this._line1.y2,
          geom.x1, geom.y1, geom.x2, geom.y2,
        );
        if (hit) {
          // 라이브 프리뷰: 트림 결과 표시
          const { keepDir1, keepDir2 } = determineCornerQuadrant(
            this._line1, geom, hit, rawPos,
          );
          const trimPreview = this._computeCornerPreview(this._line1, geom, hit, keepDir1, keepDir2);
          if (trimPreview.length > 0) {
            this.preview = { type: "point", id: "__corner_hover__", x: hit.x, y: hit.y };
            this.previews = trimPreview;
            return;
          }
        }
      }
    }

    this.preview = null;
    this.previews = [line1Preview];
  }

  // --- Corner 실행 ---

  private _applyCorner(
    store: SketchGeometryStore,
    line1: SerializedGeometry & { type: "line" },
    line2: SerializedGeometry & { type: "line" },
    intersection: { x: number; y: number; t1: number; t2: number },
    keepDir1: 1 | -1,
    keepDir2: 1 | -1,
  ): void {
    const P = intersection;

    const newGeoms: SerializedGeometry[] = [];
    const vertexRemaps: VertexRemap[] = [];
    const geomRemaps: GeomRemap[] = [];

    // 트림된 line1: farEnd ~ 교차점
    const result1 = this._trimLineToPoint(line1, P, keepDir1);
    if (result1) {
      newGeoms.push(result1.geom);
      vertexRemaps.push(...result1.vertexRemaps);
      geomRemaps.push(result1.geomRemap);
    }

    // 트림된 line2: farEnd ~ 교차점
    const result2 = this._trimLineToPoint(line2, P, keepDir2);
    if (result2) {
      newGeoms.push(result2.geom);
      vertexRemaps.push(...result2.vertexRemaps);
      geomRemaps.push(result2.geomRemap);
    }

    // coincident 구속: 두 트림된 선의 교차점 끝 (vertexIndex 1)
    const addedConstraints: SketchConstraint[] = [];
    if (result1 && result2) {
      addedConstraints.push({
        type: "coincident",
        id: generateConstraintId("auto-cst-corner"),
        pointA: { geomId: result1.geom.id, vertexIndex: 1 },
        pointB: { geomId: result2.geom.id, vertexIndex: 1 },
      });
    }

    store.execute(new CompoundSketchCommand(
      [line1, line2],
      newGeoms,
      [],
      addedConstraints,
      vertexRemaps,
      geomRemaps,
    ));

    this._state = "idle";
    this._line1 = null;
    this.preview = null;
    this.previews = [];
    store.requestRender();
  }

  // --- 트림 ---

  private _trimLineToPoint(
    line: SerializedGeometry & { type: "line" },
    P: { x: number; y: number },
    keepDir: 1 | -1,
  ): { geom: SerializedGeometry; vertexRemaps: VertexRemap[]; geomRemap: GeomRemap } | null {
    const farX = keepDir > 0 ? line.x2 : line.x1;
    const farY = keepDir > 0 ? line.y2 : line.y1;
    const farVertexIndex = keepDir > 0 ? 1 : 0;

    const trimLen = Math.hypot(farX - P.x, farY - P.y);
    if (trimLen < 1e-6) return null;

    const newId = this._generateId();
    const geom: SerializedGeometry = {
      type: "line",
      id: newId,
      x1: farX, y1: farY,
      x2: P.x, y2: P.y,
    };

    // vertex 0 = farEnd (기존 구속 유지), vertex 1 = 교차점 (새 끝점)
    const vertexRemaps: VertexRemap[] = [
      { oldGeomId: line.id, oldVertexIndex: farVertexIndex, newGeomId: newId, newVertexIndex: 0 },
    ];
    const geomRemap: GeomRemap = { oldGeomId: line.id, newGeomId: newId };

    return { geom, vertexRemaps, geomRemap };
  }

  // --- 프리뷰 ---

  private _computeCornerPreview(
    line1: SerializedGeometry & { type: "line" },
    line2: SerializedGeometry & { type: "line" },
    P: { x: number; y: number },
    keepDir1: 1 | -1,
    keepDir2: 1 | -1,
  ): SerializedGeometry[] {
    const result: SerializedGeometry[] = [];

    const far1x = keepDir1 > 0 ? line1.x2 : line1.x1;
    const far1y = keepDir1 > 0 ? line1.y2 : line1.y1;
    if (Math.hypot(far1x - P.x, far1y - P.y) > 1e-6) {
      result.push({ type: "line", id: "__corner_trim1__", x1: far1x, y1: far1y, x2: P.x, y2: P.y });
    }

    const far2x = keepDir2 > 0 ? line2.x2 : line2.x1;
    const far2y = keepDir2 > 0 ? line2.y2 : line2.y1;
    if (Math.hypot(far2x - P.x, far2y - P.y) > 1e-6) {
      result.push({ type: "line", id: "__corner_trim2__", x1: far2x, y1: far2y, x2: P.x, y2: P.y });
    }

    return result;
  }

}

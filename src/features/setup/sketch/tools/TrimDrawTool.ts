// Trim 도구 (CATIA Quick Trim 스타일)
// hover 시 삭제 구간을 빨간색으로 하이라이트, 클릭 시 해당 구간 삭제
// 드래그 모드: 포인터를 일정 거리 이상 이동하면 경로 위의 모든 기하를 일괄 트림

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";
import { isAngleBetween, normalizeAngle } from "../../utils/mathUtils";

import { BatchCommand } from "../commands/BatchCommand";
import { CompoundSketchCommand } from "../commands/CompoundSketchCommand";
import type { GeomRemap, VertexRemap } from "../commands/CompoundSketchCommand";
import { findAllIntersections } from "../GeometryIntersection";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import { DrawTool } from "./DrawTool";

// 드래그 모드 전환 임계값 (월드 좌표 단위)
const DRAG_THRESHOLD = 3;

// Trim 도구 모드 (Gap 9: rubber-in / rubber-out / break-keep)
export type TrimMode = "rubber-in" | "rubber-out" | "break-keep";

export class TrimDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "trim";


  selectionOnly = true;
  // 트림 모드 (외부에서 설정, 기본 rubber-in)
  trimMode: TrimMode = "rubber-in";

  // 삭제 프리뷰: 빨간색으로 표시할 세그먼트
  trimPreview: SerializedGeometry | null = null;

  // 멀티 트림 프리뷰: 드래그 경로에 교차된 모든 세그먼트
  multiTrimPreviews: SerializedGeometry[] = [];

  // 내부 계산 캐시
  private _hoveredGeomId: string | null = null;
  private _trimSegment: {
    geomId: string;
    tStart: number;
    tEnd: number;
  } | null = null;

  // 드래그 상태
  private _isDragging = false;
  private _dragStartPos: { x: number; y: number } | null = null;
  private _dragPath: { x: number; y: number }[] = [];
  private _dragHitGeomIds: Set<string> = new Set();
  // 드래그 중 수집된 trim 작업 목록
  private _dragTrimOps: { geomId: string; tStart: number; tEnd: number }[] = [];

  onPointerDown(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    // 드래그 시작 준비
    this._dragStartPos = { ...rawPos };
    this._dragPath = [{ ...rawPos }];
    this._isDragging = false;
    this._dragHitGeomIds.clear();
    this._dragTrimOps = [];
    this.multiTrimPreviews = [];

    // 싱글 클릭 트림 (드래그 안 됐으면 pointerUp에서 실행)
  }

  onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    // 드래그 중인 경우
    if (this._dragStartPos) {
      this._dragPath.push({ ...rawPos });

      const dist = Math.hypot(
        rawPos.x - this._dragStartPos.x,
        rawPos.y - this._dragStartPos.y,
      );

      if (dist > DRAG_THRESHOLD) {
        this._isDragging = true;
      }

      if (this._isDragging) {
        this._updateDragTrim(store, rawPos);
        store.requestRender();
        return;
      }
    }

    // 일반 hover 모드 (싱글 트림 프리뷰)
    const hitRadius = this.inferenceRadius || 5;
    const hitId = store.hitTest(rawPos, hitRadius);

    this.trimPreview = null;
    this._trimSegment = null;
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

    this._hoveredGeomId = hitId;
    store.hoveredItem = { kind: "geometry", geomId: hitId };

    const intersections = findAllIntersections(geom, store.geometries);

    if (intersections.length === 0) {
      // 교차점 없음 → 전체 기하를 삭제 프리뷰
      this.trimPreview = { ...geom };
      this._trimSegment = { geomId: hitId, tStart: 0, tEnd: 1 };
    } else if (geom.type === "line") {
      this._computeLineTrimPreview(geom, rawPos, intersections);
    } else if (geom.type === "circle") {
      this._computeCircleTrimPreview(geom, rawPos, intersections);
    } else if (geom.type === "arc") {
      this._computeArcTrimPreview(geom, rawPos, intersections);
    }

    store.requestRender();
  }

  onPointerUp(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    if (this._isDragging) {
      // 멀티 트림 실행
      this._executeMultiTrim(store);
    } else {
      // 싱글 클릭 트림
      this._executeSingleTrim(store);
    }

    // 상태 초기화
    this._dragStartPos = null;
    this._dragPath = [];
    this._isDragging = false;
    this._dragHitGeomIds.clear();
    this._dragTrimOps = [];
    this.multiTrimPreviews = [];
    this.trimPreview = null;
    this._trimSegment = null;
    this._hoveredGeomId = null;
    store.hoveredItem = null;
    store.requestRender();
  }

  cancel(): void {
    super.cancel();
    this.trimPreview = null;
    this.multiTrimPreviews = [];
    this._trimSegment = null;
    this._hoveredGeomId = null;
    this._dragStartPos = null;
    this._dragPath = [];
    this._isDragging = false;
    this._dragHitGeomIds.clear();
    this._dragTrimOps = [];
  }

  // --- 싱글 트림 실행 ---

  private _executeSingleTrim(store: SketchGeometryStore): void {
    if (!this._trimSegment || !this._hoveredGeomId) return;

    const geom = store.geometries.get(this._hoveredGeomId);
    if (!geom) return;
    if ("isReference" in geom && geom.isReference) return;

    const { tStart, tEnd } = this._trimSegment;
    const intersections = findAllIntersections(geom, store.geometries);

    if (this.trimMode === "rubber-out") {
      // rubber-out: 클릭한 세그먼트만 유지, 나머지 삭제
      this._executeRubberOut(store, geom, tStart, tEnd, intersections);
      return;
    }

    if (this.trimMode === "break-keep") {
      // break-keep: 교차점에서 분할하되 모든 세그먼트 유지
      this._executeBreakKeep(store, geom, intersections);
      return;
    }

    // rubber-in (기본): 클릭한 세그먼트 삭제
    if (intersections.length === 0) {
      store.execute(new CompoundSketchCommand([geom], [], [], []));
    } else if (geom.type === "line") {
      this._trimLine(store, geom, tStart, tEnd, intersections);
    } else if (geom.type === "circle") {
      this._trimCircle(store, geom, tStart, tEnd, intersections);
    } else if (geom.type === "arc") {
      this._trimArc(store, geom, tStart, tEnd, intersections);
    }
  }

  // rubber-out: 클릭한 세그먼트만 유지, 나머지 삭제
  private _executeRubberOut(
    store: SketchGeometryStore,
    geom: SerializedGeometry,
    tStart: number,
    tEnd: number,
    intersections: { x: number; y: number; t: number }[],
  ): void {
    if (intersections.length === 0) {
      // 교차점 없으면 전체 유지 (삭제 없음)
      return;
    }

    if (geom.type === "line") {
      // 클릭한 세그먼트만 남기기
      const dx = geom.x2 - geom.x1, dy = geom.y2 - geom.y1;
      const newId = this._generateId();
      const kept: SerializedGeometry = {
        type: "line", id: newId,
        x1: geom.x1 + tStart * dx, y1: geom.y1 + tStart * dy,
        x2: geom.x1 + tEnd * dx, y2: geom.y1 + tEnd * dy,
      };
      const vertexRemaps: VertexRemap[] = [];
      const geomRemaps: GeomRemap[] = [{ oldGeomId: geom.id, newGeomId: newId }];
      // 시작점이 원본 시작과 일치하면 vertex remap
      if (tStart < 1e-6) {
        vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: newId, newVertexIndex: 0 });
      }
      // 끝점이 원본 끝과 일치하면 vertex remap
      if (tEnd > 1 - 1e-6) {
        vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 1, newGeomId: newId, newVertexIndex: 1 });
      }
      store.execute(new CompoundSketchCommand([geom], [kept], [], [], vertexRemaps, geomRemaps));
    } else if (geom.type === "circle") {
      // circle → 클릭한 호만 남기기
      const newId = this._generateId();
      const kept: SerializedGeometry = {
        type: "arc", id: newId,
        cx: geom.cx, cy: geom.cy, r: geom.r,
        startAngle: tStart, endAngle: tEnd,
      };
      const geomRemaps: GeomRemap[] = [{ oldGeomId: geom.id, newGeomId: newId }];
      store.execute(new CompoundSketchCommand([geom], [kept], [], [], [], geomRemaps));
    } else if (geom.type === "arc") {
      // arc → 클릭한 구간만 남기기
      const startA = this._arcAngleAt(tStart, geom.startAngle, geom.endAngle);
      const endA = this._arcAngleAt(tEnd, geom.startAngle, geom.endAngle);
      const newId = this._generateId();
      const kept: SerializedGeometry = {
        type: "arc", id: newId,
        cx: geom.cx, cy: geom.cy, r: geom.r,
        startAngle: startA, endAngle: endA,
      };
      const vertexRemaps: VertexRemap[] = [];
      const geomRemaps: GeomRemap[] = [{ oldGeomId: geom.id, newGeomId: newId }];
      if (tStart < 1e-6) {
        vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: newId, newVertexIndex: 0 });
        vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 1, newGeomId: newId, newVertexIndex: 1 });
      }
      if (tEnd > 1 - 1e-6) {
        vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 2, newGeomId: newId, newVertexIndex: 2 });
      }
      store.execute(new CompoundSketchCommand([geom], [kept], [], [], vertexRemaps, geomRemaps));
    }
  }

  // break-keep: 교차점에서 분할하되 모든 세그먼트 유지 (삭제 없음)
  private _executeBreakKeep(
    store: SketchGeometryStore,
    geom: SerializedGeometry,
    intersections: { x: number; y: number; t: number }[],
  ): void {
    if (intersections.length === 0) return; // 교차점 없으면 아무 동작 없음

    if (geom.type === "line") {
      const dx = geom.x2 - geom.x1, dy = geom.y2 - geom.y1;
      const ts = [0, ...intersections.map((i) => i.t).sort((a, b) => a - b), 1];
      const newGeoms: SerializedGeometry[] = [];
      const vertexRemaps: VertexRemap[] = [];
      const geomRemaps: GeomRemap[] = [];

      for (let i = 0; i < ts.length - 1; i++) {
        const segStart = ts[i];
        const segEnd = ts[i + 1];
        if (segEnd - segStart < 1e-6) continue;
        const id = this._generateId();
        newGeoms.push({
          type: "line", id,
          x1: geom.x1 + segStart * dx, y1: geom.y1 + segStart * dy,
          x2: geom.x1 + segEnd * dx, y2: geom.y1 + segEnd * dy,
        });
        // 첫 세그먼트: 원본 시작점 보존
        if (i === 0) {
          vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: id, newVertexIndex: 0 });
          geomRemaps.push({ oldGeomId: geom.id, newGeomId: id });
        }
        // 마지막 세그먼트: 원본 끝점 보존
        if (i === ts.length - 2) {
          vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 1, newGeomId: id, newVertexIndex: 1 });
        }
      }

      if (newGeoms.length > 0) {
        store.execute(new CompoundSketchCommand([geom], newGeoms, [], [], vertexRemaps, geomRemaps));
      }
    } else if (geom.type === "arc") {
      const ts = [0, ...intersections.map((i) => i.t).sort((a, b) => a - b), 1];
      const newGeoms: SerializedGeometry[] = [];
      const vertexRemaps: VertexRemap[] = [];
      const geomRemaps: GeomRemap[] = [];

      for (let i = 0; i < ts.length - 1; i++) {
        const segStart = ts[i];
        const segEnd = ts[i + 1];
        if (segEnd - segStart < 1e-6) continue;
        const id = this._generateId();
        newGeoms.push({
          type: "arc", id,
          cx: geom.cx, cy: geom.cy, r: geom.r,
          startAngle: this._arcAngleAt(segStart, geom.startAngle, geom.endAngle),
          endAngle: this._arcAngleAt(segEnd, geom.startAngle, geom.endAngle),
        });
        if (i === 0) {
          vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: id, newVertexIndex: 0 });
          vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 1, newGeomId: id, newVertexIndex: 1 });
          geomRemaps.push({ oldGeomId: geom.id, newGeomId: id });
        }
        if (i === ts.length - 2) {
          vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 2, newGeomId: id, newVertexIndex: 2 });
        }
      }

      if (newGeoms.length > 0) {
        store.execute(new CompoundSketchCommand([geom], newGeoms, [], [], vertexRemaps, geomRemaps));
      }
    } else if (geom.type === "circle") {
      // circle → 교차점에서 arc들로 분할
      const angles = intersections.map((i) =>
        normalizeAngle(Math.atan2(i.y - geom.cy, i.x - geom.cx)),
      ).sort((a, b) => a - b);
      const segments = this._getCircularSegments(angles);
      const newGeoms: SerializedGeometry[] = [];
      const geomRemaps: GeomRemap[] = [];

      for (let i = 0; i < segments.length; i++) {
        const id = this._generateId();
        newGeoms.push({
          type: "arc", id,
          cx: geom.cx, cy: geom.cy, r: geom.r,
          startAngle: segments[i].start, endAngle: segments[i].end,
        });
        if (i === 0) {
          geomRemaps.push({ oldGeomId: geom.id, newGeomId: id });
        }
      }

      if (newGeoms.length > 0) {
        store.execute(new CompoundSketchCommand([geom], newGeoms, [], [], [], geomRemaps));
      }
    }
  }

  // --- 멀티 트림: 드래그 경로 위 기하 수집 ---

  private _updateDragTrim(store: SketchGeometryStore, rawPos: { x: number; y: number }): void {
    const hitRadius = this.inferenceRadius || 5;
    const hitId = store.hitTest(rawPos, hitRadius);
    if (!hitId) return;

    const geom = store.geometries.get(hitId);
    if (!geom) return;
    if ("isReference" in geom && geom.isReference) return;
    if ("isConstruction" in geom && geom.isConstruction) return;

    // 이미 수집된 기하는 스킵
    if (this._dragHitGeomIds.has(hitId)) return;
    this._dragHitGeomIds.add(hitId);

    const intersections = findAllIntersections(geom, store.geometries);

    if (intersections.length === 0) {
      // 교차점 없으면 전체 삭제
      this._dragTrimOps.push({ geomId: hitId, tStart: 0, tEnd: 1 });
      this.multiTrimPreviews.push({ ...geom });
    } else if (geom.type === "line") {
      // 마우스 위치 기반으로 어느 구간인지 결정
      const t = this._projectPointToLine(rawPos, geom);
      const ts = [0, ...intersections.map((i) => i.t).sort((a, b) => a - b), 1];
      for (let i = 0; i < ts.length - 1; i++) {
        if (t >= ts[i] && t <= ts[i + 1]) {
          const tStart = ts[i];
          const tEnd = ts[i + 1];
          this._dragTrimOps.push({ geomId: hitId, tStart, tEnd });
          const dx = geom.x2 - geom.x1, dy = geom.y2 - geom.y1;
          this.multiTrimPreviews.push({
            type: "line", id: `__trim_multi_${hitId}__`,
            x1: geom.x1 + tStart * dx, y1: geom.y1 + tStart * dy,
            x2: geom.x1 + tEnd * dx, y2: geom.y1 + tEnd * dy,
          });
          break;
        }
      }
    } else if (geom.type === "circle") {
      const clickAngle = normalizeAngle(Math.atan2(rawPos.y - geom.cy, rawPos.x - geom.cx));
      const angles = intersections.map((i) =>
        normalizeAngle(Math.atan2(i.y - geom.cy, i.x - geom.cx)),
      ).sort((a, b) => a - b);
      const segments = this._getCircularSegments(angles);
      for (const seg of segments) {
        if (isAngleBetween(clickAngle, seg.start, seg.end)) {
          this._dragTrimOps.push({ geomId: hitId, tStart: seg.start, tEnd: seg.end });
          this.multiTrimPreviews.push({
            type: "arc", id: `__trim_multi_${hitId}__`,
            cx: geom.cx, cy: geom.cy, r: geom.r,
            startAngle: seg.start, endAngle: seg.end,
          });
          break;
        }
      }
    } else if (geom.type === "arc") {
      const clickAngle = normalizeAngle(Math.atan2(rawPos.y - geom.cy, rawPos.x - geom.cx));
      const clickT = this._arcParameterize(clickAngle, geom.startAngle, geom.endAngle);
      const ts = [0, ...intersections.map((i) => i.t).sort((a, b) => a - b), 1];
      for (let i = 0; i < ts.length - 1; i++) {
        if (clickT >= ts[i] && clickT <= ts[i + 1]) {
          const tStart = ts[i];
          const tEnd = ts[i + 1];
          this._dragTrimOps.push({ geomId: hitId, tStart, tEnd });
          const startA = this._arcAngleAt(tStart, geom.startAngle, geom.endAngle);
          const endA = this._arcAngleAt(tEnd, geom.startAngle, geom.endAngle);
          this.multiTrimPreviews.push({
            type: "arc", id: `__trim_multi_${hitId}__`,
            cx: geom.cx, cy: geom.cy, r: geom.r,
            startAngle: startA, endAngle: endA,
          });
          break;
        }
      }
    }
  }

  // --- 멀티 트림 실행: 수집된 모든 작업을 BatchCommand로 일괄 실행 ---

  private _executeMultiTrim(store: SketchGeometryStore): void {
    if (this._dragTrimOps.length === 0) return;

    const commands: CompoundSketchCommand[] = [];
    for (const op of this._dragTrimOps) {
      const geom = store.geometries.get(op.geomId);
      if (!geom) continue;

      const intersections = findAllIntersections(geom, store.geometries);
      const cmd = this._buildTrimCommand(geom, op.tStart, op.tEnd, intersections);
      if (cmd) commands.push(cmd);
    }

    if (commands.length === 0) return;

    if (commands.length === 1) {
      store.execute(commands[0]);
    } else {
      store.execute(new BatchCommand(commands));
    }
  }

  // --- 트림 커맨드 빌드 (실행 안 함) ---

  private _buildTrimCommand(
    geom: SerializedGeometry,
    tStart: number,
    tEnd: number,
    intersections: { x: number; y: number; t: number }[],
  ): CompoundSketchCommand | null {
    if (intersections.length === 0) {
      return new CompoundSketchCommand([geom], [], [], []);
    }
    if (geom.type === "line") {
      return this._buildLineTrimCommand(geom, tStart, tEnd);
    }
    if (geom.type === "circle") {
      return this._buildCircleTrimCommand(geom, tStart, tEnd);
    }
    if (geom.type === "arc") {
      return this._buildArcTrimCommand(geom, tStart, tEnd);
    }
    return null;
  }

  // --- Line Trim ---

  private _computeLineTrimPreview(
    geom: SerializedGeometry & { type: "line" },
    rawPos: { x: number; y: number },
    intersections: { x: number; y: number; t: number }[],
  ): void {
    const t = this._projectPointToLine(rawPos, geom);
    const ts = [0, ...intersections.map((i) => i.t).sort((a, b) => a - b), 1];

    // 클릭 위치의 t가 어느 구간에 속하는지 찾기
    for (let i = 0; i < ts.length - 1; i++) {
      if (t >= ts[i] && t <= ts[i + 1]) {
        const tStart = ts[i];
        const tEnd = ts[i + 1];
        this._trimSegment = { geomId: geom.id, tStart, tEnd };

        const dx = geom.x2 - geom.x1, dy = geom.y2 - geom.y1;
        this.trimPreview = {
          type: "line",
          id: "__trim_preview__",
          x1: geom.x1 + tStart * dx,
          y1: geom.y1 + tStart * dy,
          x2: geom.x1 + tEnd * dx,
          y2: geom.y1 + tEnd * dy,
        };
        return;
      }
    }
  }

  private _trimLine(
    store: SketchGeometryStore,
    geom: SerializedGeometry & { type: "line" },
    tStart: number,
    tEnd: number,
    _intersections: { x: number; y: number; t: number }[],
  ): void {
    const cmd = this._buildLineTrimCommand(geom, tStart, tEnd);
    if (cmd) store.execute(cmd);
  }

  private _buildLineTrimCommand(
    geom: SerializedGeometry & { type: "line" },
    tStart: number,
    tEnd: number,
  ): CompoundSketchCommand {
    const dx = geom.x2 - geom.x1, dy = geom.y2 - geom.y1;
    const newGeoms: SerializedGeometry[] = [];
    const vertexRemaps: VertexRemap[] = [];
    const geomRemaps: GeomRemap[] = [];

    // tStart 이전 구간 (0 ~ tStart) — 원본 시작점 보존
    if (tStart > 1e-6) {
      const id = this._generateId();
      newGeoms.push({
        type: "line",
        id,
        x1: geom.x1,
        y1: geom.y1,
        x2: geom.x1 + tStart * dx,
        y2: geom.y1 + tStart * dy,
      });
      vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: id, newVertexIndex: 0 });
      geomRemaps.push({ oldGeomId: geom.id, newGeomId: id });
    }

    // tEnd 이후 구간 (tEnd ~ 1) — 원본 끝점 보존
    if (tEnd < 1 - 1e-6) {
      const id = this._generateId();
      newGeoms.push({
        type: "line",
        id,
        x1: geom.x1 + tEnd * dx,
        y1: geom.y1 + tEnd * dy,
        x2: geom.x2,
        y2: geom.y2,
      });
      vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 1, newGeomId: id, newVertexIndex: 1 });
      if (geomRemaps.length === 0) {
        geomRemaps.push({ oldGeomId: geom.id, newGeomId: id });
      }
    }

    return new CompoundSketchCommand([geom], newGeoms, [], [], vertexRemaps, geomRemaps);
  }

  // --- Circle Trim ---

  private _computeCircleTrimPreview(
    geom: SerializedGeometry & { type: "circle" },
    rawPos: { x: number; y: number },
    intersections: { x: number; y: number; t: number }[],
  ): void {
    if (intersections.length === 0) {
      // 교차점 없음: 전체 삭제 프리뷰
      this.trimPreview = { ...geom };
      this._trimSegment = { geomId: geom.id, tStart: 0, tEnd: Math.PI * 2 };
      return;
    }

    if (intersections.length === 1) {
      // 교차점 1개: 교차점을 기준으로 클릭한 쪽 반원 삭제
      const intAngle = normalizeAngle(Math.atan2(intersections[0].y - geom.cy, intersections[0].x - geom.cx));
      const oppositeAngle = normalizeAngle(intAngle + Math.PI);
      const clickAngle = normalizeAngle(Math.atan2(rawPos.y - geom.cy, rawPos.x - geom.cx));

      if (isAngleBetween(clickAngle, intAngle, oppositeAngle)) {
        this._trimSegment = { geomId: geom.id, tStart: intAngle, tEnd: oppositeAngle };
        this.trimPreview = {
          type: "arc", id: "__trim_preview__",
          cx: geom.cx, cy: geom.cy, r: geom.r,
          startAngle: intAngle, endAngle: oppositeAngle,
        };
      } else {
        this._trimSegment = { geomId: geom.id, tStart: oppositeAngle, tEnd: intAngle };
        this.trimPreview = {
          type: "arc", id: "__trim_preview__",
          cx: geom.cx, cy: geom.cy, r: geom.r,
          startAngle: oppositeAngle, endAngle: intAngle,
        };
      }
      return;
    }

    const clickAngle = normalizeAngle(Math.atan2(rawPos.y - geom.cy, rawPos.x - geom.cx));
    const angles = intersections.map((i) =>
      normalizeAngle(Math.atan2(i.y - geom.cy, i.x - geom.cx)),
    ).sort((a, b) => a - b);

    const segments = this._getCircularSegments(angles);
    for (const seg of segments) {
      if (isAngleBetween(clickAngle, seg.start, seg.end)) {
        this._trimSegment = { geomId: geom.id, tStart: seg.start, tEnd: seg.end };
        this.trimPreview = {
          type: "arc",
          id: "__trim_preview__",
          cx: geom.cx,
          cy: geom.cy,
          r: geom.r,
          startAngle: seg.start,
          endAngle: seg.end,
        };
        return;
      }
    }
  }

  private _trimCircle(
    store: SketchGeometryStore,
    geom: SerializedGeometry & { type: "circle" },
    tStart: number,
    tEnd: number,
    _intersections: { x: number; y: number; t: number }[],
  ): void {
    const cmd = this._buildCircleTrimCommand(geom, tStart, tEnd);
    if (cmd) store.execute(cmd);
  }

  private _buildCircleTrimCommand(
    geom: SerializedGeometry & { type: "circle" },
    tStart: number,
    tEnd: number,
  ): CompoundSketchCommand {
    const newGeoms: SerializedGeometry[] = [];
    const vertexRemaps: VertexRemap[] = [];
    const geomRemaps: GeomRemap[] = [];
    const remainStart = tEnd;
    const remainEnd = tStart;

    if (Math.abs(normalizeAngle(remainEnd - remainStart)) > 1e-6) {
      const id = this._generateId();
      newGeoms.push({
        type: "arc",
        id,
        cx: geom.cx,
        cy: geom.cy,
        r: geom.r,
        startAngle: remainStart,
        endAngle: remainEnd,
      });
      vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: id, newVertexIndex: 0 });
      geomRemaps.push({ oldGeomId: geom.id, newGeomId: id });
    }

    return new CompoundSketchCommand([geom], newGeoms, [], [], vertexRemaps, geomRemaps);
  }

  // --- Arc Trim ---

  private _computeArcTrimPreview(
    geom: SerializedGeometry & { type: "arc" },
    rawPos: { x: number; y: number },
    intersections: { x: number; y: number; t: number }[],
  ): void {
    if (intersections.length === 0) {
      this.trimPreview = { ...geom };
      this._trimSegment = { geomId: geom.id, tStart: 0, tEnd: 1 };
      return;
    }

    const clickAngle = normalizeAngle(Math.atan2(rawPos.y - geom.cy, rawPos.x - geom.cx));
    const clickT = this._arcParameterize(clickAngle, geom.startAngle, geom.endAngle);
    const ts = [0, ...intersections.map((i) => i.t).sort((a, b) => a - b), 1];

    for (let i = 0; i < ts.length - 1; i++) {
      if (clickT >= ts[i] && clickT <= ts[i + 1]) {
        const tStart = ts[i];
        const tEnd = ts[i + 1];
        this._trimSegment = { geomId: geom.id, tStart, tEnd };

        const startA = this._arcAngleAt(tStart, geom.startAngle, geom.endAngle);
        const endA = this._arcAngleAt(tEnd, geom.startAngle, geom.endAngle);
        this.trimPreview = {
          type: "arc",
          id: "__trim_preview__",
          cx: geom.cx,
          cy: geom.cy,
          r: geom.r,
          startAngle: startA,
          endAngle: endA,
        };
        return;
      }
    }
  }

  private _trimArc(
    store: SketchGeometryStore,
    geom: SerializedGeometry & { type: "arc" },
    tStart: number,
    tEnd: number,
    _intersections: { x: number; y: number; t: number }[],
  ): void {
    const cmd = this._buildArcTrimCommand(geom, tStart, tEnd);
    if (cmd) store.execute(cmd);
  }

  private _buildArcTrimCommand(
    geom: SerializedGeometry & { type: "arc" },
    tStart: number,
    tEnd: number,
  ): CompoundSketchCommand {
    const newGeoms: SerializedGeometry[] = [];
    const vertexRemaps: VertexRemap[] = [];
    const geomRemaps: GeomRemap[] = [];

    if (tStart > 1e-6) {
      const id = this._generateId();
      newGeoms.push({
        type: "arc",
        id,
        cx: geom.cx,
        cy: geom.cy,
        r: geom.r,
        startAngle: geom.startAngle,
        endAngle: this._arcAngleAt(tStart, geom.startAngle, geom.endAngle),
      });
      vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: id, newVertexIndex: 0 });
      vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 1, newGeomId: id, newVertexIndex: 1 });
      geomRemaps.push({ oldGeomId: geom.id, newGeomId: id });
    }

    if (tEnd < 1 - 1e-6) {
      const id = this._generateId();
      newGeoms.push({
        type: "arc",
        id,
        cx: geom.cx,
        cy: geom.cy,
        r: geom.r,
        startAngle: this._arcAngleAt(tEnd, geom.startAngle, geom.endAngle),
        endAngle: geom.endAngle,
      });
      vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 2, newGeomId: id, newVertexIndex: 2 });
      if (geomRemaps.length === 0) {
        vertexRemaps.push({ oldGeomId: geom.id, oldVertexIndex: 0, newGeomId: id, newVertexIndex: 0 });
        geomRemaps.push({ oldGeomId: geom.id, newGeomId: id });
      }
    }

    return new CompoundSketchCommand([geom], newGeoms, [], [], vertexRemaps, geomRemaps);
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


  private _getCircularSegments(sortedAngles: number[]): { start: number; end: number }[] {
    const segs: { start: number; end: number }[] = [];
    for (let i = 0; i < sortedAngles.length; i++) {
      const next = (i + 1) % sortedAngles.length;
      segs.push({ start: sortedAngles[i], end: sortedAngles[next] });
    }
    return segs;
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

// Profile 도구: 연속 Line + Tangent Arc + Three Point Arc 혼합 그리기 (CATIA Profile 동작)
//
// 모드:
// - "line": 클릭-클릭 = 직선 세그먼트 (기본)
// - "tangent-arc": 클릭 = 이전 세그먼트에 접선인 호 생성 (이전 방향 자동 사용)
//   이전 세그먼트 없으면 드래그로 접선 방향 지정 가능
// - "three-point-arc": 시작점(체인 현재점) + 중간점 클릭 + 끝점 클릭 = 3점 호
//
// 공통:
// 1. 시작점 근처 클릭 → 자동 닫기 (coincident)
// 2. 더블클릭/Escape → 체인 종료
// 3. 호-선/선-호 연결점에 tangent 구속 자동 추가 (tangent-arc 모드)
// 4. 모드 전환은 체인 중간에서도 가능 (CATIA Sketch Tools 패널에서)

import type { ProfileMode } from "../../Setup.store";
import type { SketchDrawToolType } from "../../Setup.type";
import { generateConstraintId } from "../../utils/idGenerator";

import { AddConstraintCommand } from "../commands/AddConstraintCommand";
import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { computeDirectionalInferences, computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapResult } from "../SnapEngine";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

const MIN_SEG_LEN = 0.1;
const CLOSE_THRESHOLD = 5; // 시작점 자동 닫기 거리 (월드 단위, inferenceRadius 기준으로 조정)

export class ProfileDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "profile";

  // 외부에서 설정하는 모드 (atom과 동기화)
  profileMode: ProfileMode = "line";

  // 체인 상태
  private _chainStartPos: { x: number; y: number } | null = null; // 체인 시작점 (닫기 판정용)
  private _chainStartSnap: SnapResult = null;
  private _currentPos: { x: number; y: number } | null = null; // 현재 끝점 (다음 세그먼트 시작점)
  private _lastGeomId: string | null = null;
  private _lastVertexIndex = 1; // line=1, arc=2
  private _chainLineIds: string[] = []; // 체인 전체 lineIds (closed loop 시 shape 등록용)
  private _lastDirection: { dx: number; dy: number } | null = null; // 마지막 세그먼트 끝 방향 (탄젠트 연속성)

  // 다음 세그먼트 모드 (드래그로 활성화, tangent-arc 명시 모드와 별개)
  private _nextIsArc = false;

  // Three Point Arc 중간점
  private _threePointArcMid: { x: number; y: number } | null = null;

  // 드래그 감지
  private _downPos: { x: number; y: number } | null = null;
  private _isDragging = false;

  // 더블클릭 감지
  private _lastClickTime = 0;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    const now = Date.now();

    // 더블클릭 → 체인 종료
    if (now - this._lastClickTime < 300 && this._currentPos) {
      this.cancel();
      store.requestRender();
      this._lastClickTime = 0;
      return;
    }
    this._lastClickTime = now;

    this._downPos = { ...snappedPos };
    this._isDragging = false;
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    const geometries = [...store.geometries.values()];
    const radius = this.inferenceRadius;

    // Profile 도구는 line 모드만 — drag→tangent arc 전환 기능 비활성 (직선만 그리기).
    // _isDragging 이 항상 false 라 _nextIsArc 활성화 안 됨 → _handleLineMode 가 무조건
    // 직선 분기로 falls through.

    if (!this._currentPos) {
      // 첫 점 찍기 전
      this.inferenceLines = computeGeometryInferences(snappedPos, store.snapResult, geometries, radius);
      store.requestRender();
      return;
    }

    const start = this._currentPos;

    if (this.profileMode === "three-point-arc") {
      // Three Point Arc 모드 프리뷰
      if (this._threePointArcMid) {
        // 중간점 확정 → 3점 호 프리뷰
        const arc = this._computeThreePointArc(start, this._threePointArcMid, snappedPos);
        if (arc) {
          this.preview = { ...arc, id: "__preview__" };
        } else {
          // 호 계산 불가 → 폴리라인 프리뷰
          this.preview = { type: "line", id: "__preview__", x1: start.x, y1: start.y, x2: snappedPos.x, y2: snappedPos.y };
        }
      } else {
        // 중간점 미확정 → 시작점에서 중간점까지 보조선 프리뷰
        this.preview = { type: "line", id: "__preview__", x1: start.x, y1: start.y, x2: snappedPos.x, y2: snappedPos.y };
      }
    } else if (this.profileMode === "tangent-arc") {
      // Tangent Arc 모드: 이전 방향이 있으면 접선 호 프리뷰
      if (this._lastDirection) {
        const arc = this._computeTangentArc(start, this._lastDirection, snappedPos);
        if (arc) {
          this.preview = { ...arc, id: "__preview__" };
        } else {
          this.preview = { type: "line", id: "__preview__", x1: start.x, y1: start.y, x2: snappedPos.x, y2: snappedPos.y };
        }
      } else {
        // 이전 세그먼트 없으면 직선 프리뷰 (첫 세그먼트에서 tangent-arc는 방향 미정)
        this.preview = { type: "line", id: "__preview__", x1: start.x, y1: start.y, x2: snappedPos.x, y2: snappedPos.y };
      }
    } else {
      // Line 모드
      if (this._isDragging && this._downPos) {
        // 드래그 중: downPos까지 직선 프리뷰
        this.preview = {
          type: "line", id: "__preview__",
          x1: start.x, y1: start.y,
          x2: this._downPos.x, y2: this._downPos.y,
        };
      } else if (this._nextIsArc && this._lastDirection) {
        // 드래그로 활성화된 탄젠트 호 모드
        const arc = this._computeTangentArc(start, this._lastDirection, snappedPos);
        if (arc) {
          this.preview = { ...arc, id: "__preview__" };
        } else {
          this.preview = { type: "line", id: "__preview__", x1: start.x, y1: start.y, x2: snappedPos.x, y2: snappedPos.y };
        }
      } else {
        // 직선 프리뷰
        this.preview = {
          type: "line", id: "__preview__",
          x1: start.x, y1: start.y,
          x2: snappedPos.x, y2: snappedPos.y,
        };
        this.inferenceLines = [
          ...computeDirectionalInferences(start, snappedPos, geometries, radius * 0.5),
          ...computeGeometryInferences(snappedPos, store.snapResult, geometries, radius),
        ];
      }
    }

    store.requestRender();
  }

  onPointerUp(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (!this._downPos) return;

    const snap = store.snapResult;

    // 첫 점 설정
    if (!this._currentPos) {
      this._currentPos = { ...snappedPos };
      this._chainStartPos = { ...snappedPos };
      this._chainStartSnap = snap;
      this._downPos = null;
      this._isDragging = false;
      return;
    }

    const start = this._currentPos;

    // 시작점 자동 닫기 판정 (모든 모드 공통)
    const closeThresh = this.inferenceRadius || CLOSE_THRESHOLD;
    if (this._chainStartPos && this._lastGeomId) {
      const distToStart = Math.hypot(snappedPos.x - this._chainStartPos.x, snappedPos.y - this._chainStartPos.y);
      if (distToStart < closeThresh) {
        // 닫기 세그먼트의 끝점 ↔ 첫 세그먼트 시작점 closing coincident 정보 사전 계산.
        // _create*Segment 가 같은 BatchCommand 에 포함시켜 undo 원자성 보장.
        const firstId: string | undefined = this._chainLineIds[0];
        const firstGeom = firstId ? store.geometries.get(firstId) : undefined;
        // line: vertex 0 = start. arc: vertex 1 = startPoint (vertex 0 = center).
        const firstStartVI = firstGeom?.type === "arc" ? 1 : 0;
        const closingTo = firstId ? { geomId: firstId, vertexIndex: firstStartVI } : null;

        // 현재 모드에 따라 닫기
        if (this.profileMode === "three-point-arc" && this._threePointArcMid) {
          const arc = this._computeThreePointArc(start, this._threePointArcMid, this._chainStartPos);
          if (arc) {
            this._createArcSegment(store, arc, this._chainStartSnap, false, closingTo);
          } else {
            this._createLineSegment(store, start, this._chainStartPos, this._chainStartSnap, closingTo);
          }
        } else if (this.profileMode === "tangent-arc" && this._lastDirection) {
          const arc = this._computeTangentArc(start, this._lastDirection, this._chainStartPos);
          if (arc) {
            this._createArcSegment(store, arc, this._chainStartSnap, true, closingTo);
          } else {
            this._createLineSegment(store, start, this._chainStartPos, this._chainStartSnap, closingTo);
          }
        } else {
          this._createLineSegment(store, start, this._chainStartPos, this._chainStartSnap, closingTo);
        }
        // closed loop 완성 → shape 등록
        if (this._chainLineIds.length >= 3) {
          store.registerShape(this._chainLineIds);
        }
        this.cancel();
        store.requestRender();
        return;
      }
    }

    if (this.profileMode === "three-point-arc") {
      this._handleThreePointArc(store, start, snappedPos, snap);
    } else if (this.profileMode === "tangent-arc") {
      this._handleTangentArc(store, start, snappedPos, snap);
    } else {
      // Line 모드
      this._handleLineMode(store, start, snappedPos, snap);
    }

    this._downPos = null;
    this._isDragging = false;
    this.preview = null;
    this.inferenceLines = [];
  }

  // --- Line 모드 처리 ---

  private _handleLineMode(
    store: SketchGeometryStore,
    start: { x: number; y: number },
    snappedPos: { x: number; y: number },
    snap: SnapResult,
  ): void {
    if (this._isDragging) {
      // 드래그: downPos까지 직선 확정 + 다음 세그먼트를 탄젠트 호 모드로
      const endPos = this._downPos!;
      const segLen = Math.hypot(endPos.x - start.x, endPos.y - start.y);
      if (segLen >= MIN_SEG_LEN) {
        this._createLineSegment(store, start, endPos, null);
        this._currentPos = { ...endPos };

        // 드래그 방향 = 다음 호의 접선 방향
        const dragDx = snappedPos.x - endPos.x;
        const dragDy = snappedPos.y - endPos.y;
        const dragLen = Math.hypot(dragDx, dragDy);
        if (dragLen > 1e-6) {
          this._lastDirection = { dx: dragDx / dragLen, dy: dragDy / dragLen };
          this._nextIsArc = true;
        }
      }
    } else if (this._nextIsArc && this._lastDirection) {
      // 드래그로 활성화된 탄젠트 호 모드: 클릭 위치까지 호 생성
      const arc = this._computeTangentArc(start, this._lastDirection, snappedPos);
      if (arc && arc.type === "arc") {
        this._createArcSegment(store, arc, snap, true);
        this._currentPos = { ...snappedPos };
        this._updateLastDirectionFromArc(arc, snappedPos);
        this._nextIsArc = false;
      } else {
        this._createLineSegment(store, start, snappedPos, snap);
        this._currentPos = { ...snappedPos };
        this._nextIsArc = false;
        this._updateLastDirection(start, snappedPos);
      }
    } else {
      const segLen = Math.hypot(snappedPos.x - start.x, snappedPos.y - start.y);
      if (segLen >= MIN_SEG_LEN) {
        this._createLineSegment(store, start, snappedPos, snap);
        this._currentPos = { ...snappedPos };
        this._nextIsArc = false;
        this._updateLastDirection(start, snappedPos);
      }
    }
  }

  // --- Tangent Arc 모드 처리 ---

  private _handleTangentArc(
    store: SketchGeometryStore,
    start: { x: number; y: number },
    snappedPos: { x: number; y: number },
    snap: SnapResult,
  ): void {
    if (this._lastDirection) {
      // 이전 세그먼트 방향 존재 → 접선 호 생성
      const arc = this._computeTangentArc(start, this._lastDirection, snappedPos);
      if (arc) {
        this._createArcSegment(store, arc, snap, true);
        this._currentPos = { ...snappedPos };
        this._updateLastDirectionFromArc(arc, snappedPos);
      } else {
        // 호 계산 실패 → 직선 폴백
        const segLen = Math.hypot(snappedPos.x - start.x, snappedPos.y - start.y);
        if (segLen >= MIN_SEG_LEN) {
          this._createLineSegment(store, start, snappedPos, snap);
          this._currentPos = { ...snappedPos };
          this._updateLastDirection(start, snappedPos);
        }
      }
    } else {
      // 이전 세그먼트 없음 (체인 첫 세그먼트) → 직선으로 폴백
      const segLen = Math.hypot(snappedPos.x - start.x, snappedPos.y - start.y);
      if (segLen >= MIN_SEG_LEN) {
        this._createLineSegment(store, start, snappedPos, snap);
        this._currentPos = { ...snappedPos };
        this._updateLastDirection(start, snappedPos);
      }
    }
  }

  // --- Three Point Arc 모드 처리 ---

  private _handleThreePointArc(
    store: SketchGeometryStore,
    start: { x: number; y: number },
    snappedPos: { x: number; y: number },
    snap: SnapResult,
  ): void {
    if (!this._threePointArcMid) {
      // 중간점 확정 (첫 번째 클릭)
      this._threePointArcMid = { ...snappedPos };
    } else {
      // 끝점 확정 (두 번째 클릭) → 3점 호 생성
      const arc = this._computeThreePointArc(start, this._threePointArcMid, snappedPos);
      if (arc) {
        this._createArcSegment(store, arc, snap, false);
        this._currentPos = { ...snappedPos };
        this._updateLastDirectionFromArc(arc, snappedPos);
      } else {
        // 호 계산 실패 → 직선 폴백
        const segLen = Math.hypot(snappedPos.x - start.x, snappedPos.y - start.y);
        if (segLen >= MIN_SEG_LEN) {
          this._createLineSegment(store, start, snappedPos, snap);
          this._currentPos = { ...snappedPos };
          this._updateLastDirection(start, snappedPos);
        }
      }
      this._threePointArcMid = null;
    }
  }

  onKeyDown(store: SketchGeometryStore, event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.cancel();
      store.requestRender();
    }
  }

  hasPendingWork(): boolean {
    return this._currentPos !== null;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    // L: 현재 세그먼트 길이, A: 현재 세그먼트 각도
    const l = this._currentPos && mousePos
      ? Math.hypot(mousePos.x - this._currentPos.x, mousePos.y - this._currentPos.y) : undefined;
    const a = this._currentPos && mousePos
      ? Math.atan2(mousePos.y - this._currentPos.y, mousePos.x - this._currentPos.x) * 180 / Math.PI : undefined;
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "L", label: "L", value: l },
      { type: "A", label: "A", value: a },
    ];
  }

  override applyInputValues(
    store: SketchGeometryStore,
    values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    // Profile은 pointerDown→pointerUp 체인을 사용
    // L+A: 현재 시작점 기준 극좌표
    if (this._currentPos && values.L !== undefined && values.A !== undefined) {
      const rad = values.A * Math.PI / 180;
      const endX = this._currentPos.x + values.L * Math.cos(rad);
      const endY = this._currentPos.y + values.L * Math.sin(rad);
      const pos = { x: endX, y: endY };
      // pointerDown + pointerUp 시뮬레이션
      this._downPos = { ...pos };
      this._isDragging = false;
      this._lastClickTime = 0;
      this.onPointerUp(store, pos, pos);
      return true;
    }
    // H/V: 좌표 직접 지정
    if (values.H !== undefined && values.V !== undefined) {
      const pos = { x: values.H, y: values.V };
      if (!this._currentPos) {
        // 첫 점 설정
        this._downPos = { ...pos };
        this._isDragging = false;
        this._lastClickTime = 0;
        this.onPointerUp(store, pos, pos);
      } else {
        // 다음 세그먼트 끝점
        this._downPos = { ...pos };
        this._isDragging = false;
        this._lastClickTime = 0;
        this.onPointerUp(store, pos, pos);
      }
      return true;
    }
    return false;
  }

  cancel(): void {
    super.cancel();
    this._chainStartPos = null;
    this._chainStartSnap = null;
    this._currentPos = null;
    this._lastGeomId = null;
    this._lastVertexIndex = 1;
    this._lastDirection = null;
    this._chainLineIds = [];
    this._nextIsArc = false;
    this._threePointArcMid = null;
    this._downPos = null;
    this._isDragging = false;
  }

  // --- 직선 세그먼트 생성 ---

  // closingTo: 닫기 세그먼트인 경우 첫 세그먼트 시작점 ref. 같은 BatchCommand 에 closing coincident
  // 도 포함시켜 undo 원자성 보장.
  private _createLineSegment(
    store: SketchGeometryStore,
    start: { x: number; y: number },
    end: { x: number; y: number },
    endSnap: SnapResult,
    closingTo: { geomId: string; vertexIndex: number } | null = null,
  ): void {
    const id = this._generateId();
    const cmds: GeometryCommand[] = [
      this._addGeometry({ type: "line", id, x1: start.x, y1: start.y, x2: end.x, y2: end.y }),
    ];

    if (this._lastGeomId) {
      // 이전 세그먼트와 coincident
      cmds.push(new AddConstraintCommand({
        type: "coincident",
        id: generateConstraintId("auto-prf"),
        pointA: { geomId: this._lastGeomId, vertexIndex: this._lastVertexIndex },
        pointB: { geomId: id, vertexIndex: 0 },
      }));
    } else if (this._chainStartSnap) {
      const startCst = this._buildAutoConstraint(store, id, 0, this._chainStartSnap);
      if (startCst) cmds.push(startCst);
    }

    if (endSnap) {
      const endCst = this._buildAutoConstraint(store, id, 1, endSnap);
      if (endCst) cmds.push(endCst);
      // line 끝점이 circle/arc 에 tangent 인 경우 자동 tangent 구속 (LineDrawTool 과 동일 로직)
      const tanCst = this._buildAutoTangentConstraint(store, id, start, end, endSnap);
      if (tanCst) cmds.push(tanCst);
    }

    // 닫기 세그먼트: 끝점 ↔ 첫 세그먼트 시작점 coincident (loop close)
    if (closingTo && closingTo.geomId !== id) {
      cmds.push(new AddConstraintCommand({
        type: "coincident",
        id: generateConstraintId("auto-prf-close"),
        pointA: { geomId: id, vertexIndex: 1 },
        pointB: { geomId: closingTo.geomId, vertexIndex: closingTo.vertexIndex },
      }));
    }

    store.execute(new BatchCommand(cmds));
    this._lastGeomId = id;
    this._lastVertexIndex = 1;
    this._chainLineIds.push(id);
  }

  // --- 호 세그먼트 생성 ---

  // closingTo: 닫기 세그먼트인 경우 첫 세그먼트 시작점 ref. _createLineSegment 와 동일한 의미.
  private _createArcSegment(
    store: SketchGeometryStore,
    arcGeom: { type: "arc"; cx: number; cy: number; r: number; startAngle: number; endAngle: number },
    _endSnap: SnapResult,
    addTangent: boolean,
    closingTo: { geomId: string; vertexIndex: number } | null = null,
  ): void {
    const id = this._generateId();
    const cmds: GeometryCommand[] = [
      this._addGeometry({ ...arcGeom, id, type: "arc" }),
    ];
    // 체인 현재점에 놓인 호 끝점(joinVi)과 새 체인 끝점(endVi). 시계 방향으로 도는 호는 start/end 를 바꿔 두므로
    // (_computeTangentArc·_computeThreePointArc) 체인은 vertex 2 에서 들어와 vertex 1 로 나간다.
    const joinVi = this._currentPos ? this._arcEndVertexAt(arcGeom, this._currentPos) : 1;
    const endVi = joinVi === 1 ? 2 : 1;

    if (this._lastGeomId) {
      // coincident: 이전 세그먼트 끝점 ≡ 체인 현재점에 놓인 호 끝점
      cmds.push(new AddConstraintCommand({
        type: "coincident",
        id: generateConstraintId("auto-prf"),
        pointA: { geomId: this._lastGeomId, vertexIndex: this._lastVertexIndex },
        pointB: { geomId: id, vertexIndex: joinVi },
      }));
      // tangent: 이전 기하 ↔ 호 (접선 연속성, tangent-arc 모드에서만)
      if (addTangent) {
        cmds.push(new AddConstraintCommand({
          type: "tangent",
          id: generateConstraintId("auto-prf-tan"),
          entityA: { geomId: this._lastGeomId },
          entityB: { geomId: id },
        }));
      }
    }

    // 닫기 세그먼트: 체인 끝에 놓인 호 끝점 ↔ 첫 세그먼트 시작점 coincident
    if (closingTo && closingTo.geomId !== id) {
      cmds.push(new AddConstraintCommand({
        type: "coincident",
        id: generateConstraintId("auto-prf-close"),
        pointA: { geomId: id, vertexIndex: endVi },
        pointB: { geomId: closingTo.geomId, vertexIndex: closingTo.vertexIndex },
      }));
    }

    store.execute(new BatchCommand(cmds));
    this._lastGeomId = id;
    this._lastVertexIndex = endVi; // 체인 끝에 놓인 호 끝점
    this._chainLineIds.push(id);
  }

  // 호의 두 끝점(vertex 1 = startAngle, vertex 2 = endAngle) 중 p 에 놓인 쪽
  private _arcEndVertexAt(
    arc: { cx: number; cy: number; r: number; startAngle: number; endAngle: number },
    p: { x: number; y: number },
  ): 1 | 2 {
    const d1 = Math.hypot(arc.cx + arc.r * Math.cos(arc.startAngle) - p.x, arc.cy + arc.r * Math.sin(arc.startAngle) - p.y);
    const d2 = Math.hypot(arc.cx + arc.r * Math.cos(arc.endAngle) - p.x, arc.cy + arc.r * Math.sin(arc.endAngle) - p.y);
    return d1 <= d2 ? 1 : 2;
  }

  // --- 탄젠트 호 계산 (시작점 + 접선 방향 + 끝점) ---

  private _computeTangentArc(
    start: { x: number; y: number },
    tangentDir: { dx: number; dy: number },
    end: { x: number; y: number },
  ): { type: "arc"; cx: number; cy: number; r: number; startAngle: number; endAngle: number } | null {
    // 시작점에서 tangentDir 방향이 접선인 호 → 중심은 접선 수직 + 현의 수직이등분선 교차점
    const chordX = end.x - start.x;
    const chordY = end.y - start.y;
    const chordLen = Math.hypot(chordX, chordY);
    if (chordLen < MIN_SEG_LEN) return null;

    // 현 중점
    const mx = (start.x + end.x) / 2;
    const my = (start.y + end.y) / 2;

    // 접선 수직 방향 (시작점에서)
    const nx = -tangentDir.dy;
    const ny = tangentDir.dx;

    // 현의 수직이등분선 방향
    const perpX = -chordY;
    const perpY = chordX;

    // 두 직선 교차: start + t*(nx,ny) = (mx,my) + s*(perpX,perpY)
    const denom = nx * perpY - ny * perpX;
    if (Math.abs(denom) < 1e-9) return null;

    const t = ((mx - start.x) * perpY - (my - start.y) * perpX) / denom;
    const cx = start.x + t * nx;
    const cy = start.y + t * ny;
    const r = Math.hypot(start.x - cx, start.y - cy);
    if (r < 0.1 || r > 50000) return null;

    const startAngle = Math.atan2(start.y - cy, start.x - cx);
    const endAngle = Math.atan2(end.y - cy, end.x - cx);

    // 호는 startAngle 에서 CCW 로 endAngle 까지 그려진다. 접선 방향에서 끝점이 오른쪽(cross < 0)이면 시계 방향으로
    // 도는 호라, start/end 를 바꿔 둔다 — 그대로 두면 반대로 도는 270° 호가 된다. 이때 체인의 시작점은 호의 vertex 2 에
    // 놓인다(_createArcSegment 가 좌표로 판별).
    if (tangentDir.dx * chordY - tangentDir.dy * chordX < 0) {
      return { type: "arc", cx, cy, r, startAngle: endAngle, endAngle: startAngle };
    }
    return { type: "arc", cx, cy, r, startAngle, endAngle };
  }

  // --- 3점 호 계산 (시작점 + 중간점 + 끝점 → 외접원 호) ---

  private _computeThreePointArc(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
  ): { type: "arc"; cx: number; cy: number; r: number; startAngle: number; endAngle: number } | null {
    // 3점 외접원 중심 계산 (수직이등분선 교차)
    const ax = p1.x, ay = p1.y;
    const bx = p2.x, by = p2.y;
    const cx = p3.x, cy = p3.y;

    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-9) return null; // 세 점이 일직선

    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    const r = Math.hypot(ax - ux, ay - uy);
    if (r < 0.1 || r > 50000) return null;

    const startAngle = Math.atan2(p1.y - uy, p1.x - ux);
    const endAngle = Math.atan2(p3.y - uy, p3.x - ux);

    // 중간점이 호 위에 있도록 방향 검증
    // 중간점 각도 계산
    const midAngle = Math.atan2(p2.y - uy, p2.x - ux);

    // startAngle → endAngle 방향으로 midAngle이 포함되는지 확인
    // CCW 방향으로 정규화
    const normalizeAngle = (a: number, ref: number) => {
      let result = a - ref;
      while (result < 0) result += Math.PI * 2;
      while (result >= Math.PI * 2) result -= Math.PI * 2;
      return result;
    };

    const midNorm = normalizeAngle(midAngle, startAngle);
    const endNorm = normalizeAngle(endAngle, startAngle);

    // midNorm이 0~endNorm 사이에 있으면 CCW가 올바른 방향
    // 아니면 반대 방향 (startAngle↔endAngle 교환)
    if (endNorm > 0 && midNorm > 0 && midNorm < endNorm) {
      // CCW: start → end 순서 유지
      return { type: "arc", cx: ux, cy: uy, r, startAngle, endAngle };
    } else {
      // CW: start와 end 교환하여 반대 방향 호
      return { type: "arc", cx: ux, cy: uy, r, startAngle: endAngle, endAngle: startAngle };
    }
  }

  // --- 호 끝점에서의 접선 방향 업데이트 ---

  private _updateLastDirectionFromArc(
    arc: { cx: number; cy: number; r: number; startAngle: number; endAngle: number },
    endPos: { x: number; y: number },
  ): void {
    const rx = endPos.x - arc.cx;
    const ry = endPos.y - arc.cy;
    const rLen = Math.hypot(rx, ry);
    if (rLen > 1e-6) {
      // 체인이 호를 vertex 1→2(CCW)로 지나왔으면 끝 방향은 반지름을 +90° 돌린 쪽이다. start/end 를 바꿔 둔
      // 시계 방향 호는 체인 끝이 vertex 1 이라 그 반대 방향이다.
      const sign = this._arcEndVertexAt(arc, endPos) === 2 ? 1 : -1;
      this._lastDirection = { dx: (-ry / rLen) * sign, dy: (rx / rLen) * sign };
    }
  }

  // --- 방향 업데이트 ---

  private _updateLastDirection(from: { x: number; y: number }, to: { x: number; y: number }): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      this._lastDirection = { dx: dx / len, dy: dy / len };
    }
  }
}

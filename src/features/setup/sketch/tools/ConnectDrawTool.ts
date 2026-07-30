// 연결(Connect) 그리기 도구: 2클릭 — 시작 끝점 → 끝 끝점 (기존 기하 위)
// 두 끝점에 접선 방향이 있으면 접선 arc 생성, 없으면 직선 생성
// 결과: line 또는 arc + 2 coincident (기존 끝점에 연결)

import type { ConnectContinuity, SketchDrawToolType } from "../../Setup.type";
import { generateConstraintId } from "../../utils/idGenerator";

import { AddConstraintCommand } from "../commands/AddConstraintCommand";
import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapResult } from "../SnapEngine";

import type { SketchInputField } from "./DrawTool";
import { DrawTool } from "./DrawTool";

export class ConnectDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "connect";

  // 연속성 모드 (외부 atom을 통해 동기화)
  // G0: 강제 직선 (접선 무시)
  // G1: 접선 arc (기존 동작) — 접선 계산 실패 시 직선 폴백
  // G2: 곡률 연속 cubic NURBS 곡선 (제어점 4개)
  continuityMode: ConnectContinuity = "G1";

  private _startPos: { x: number; y: number } | null = null;
  private _startSnap: SnapResult = null;

  // endpoint 스냅만 허용
  override snapFilter = new Set<"endpoint" | "center" | "nearest" | "grid" | "intersection">(["endpoint"] as const);

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (!this._startPos) {
      // 첫 클릭: 시작 끝점
      this._recordSnap(store);
      this._startSnap = store.snapResult;
      this._startPos = { ...snappedPos };
    } else {
      // 두 번째 클릭: 끝 끝점 → 연결
      this._recordSnap(store);
      const endSnap = store.snapResult;
      this._finalize(store, snappedPos, endSnap);
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    const geometries = [...store.geometries.values()];
    this.inferenceLines = computeGeometryInferences(
      snappedPos, store.snapResult, geometries, this.inferenceRadius,
    );

    if (this._startPos) {
      const tangentDir = this._getEndpointTangent(store, this._startSnap);
      const endSnap = store.snapResult;
      const endTangentDir = this._getEndpointTangent(store, endSnap);

      // G2: cubic NURBS 프리뷰 (양쪽 접선이 있을 때만)
      if (this.continuityMode === "G2" && tangentDir && endTangentDir) {
        const curvePoints = this._computeG2CubicPoints(this._startPos, snappedPos, tangentDir, endTangentDir);
        this.preview = {
          type: "curve",
          id: "__preview__",
          points: curvePoints,
          degree: 3,
        };
        store.requestRender();
        return;
      }

      // G1: 접선 arc (기존 동작)
      if (this.continuityMode === "G1" && tangentDir && endTangentDir) {
        const arcPreview = this._computeTangentArc(this._startPos, snappedPos, tangentDir, endTangentDir);
        if (arcPreview) {
          this.preview = {
            type: "arc",
            id: "__preview__",
            cx: arcPreview.cx,
            cy: arcPreview.cy,
            r: arcPreview.r,
            startAngle: arcPreview.startAngle,
            endAngle: arcPreview.endAngle,
          };
          store.requestRender();
          return;
        }
      }

      // G0 또는 폴백: 직선 프리뷰
      this.preview = {
        type: "line",
        id: "__preview__",
        x1: this._startPos.x,
        y1: this._startPos.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
      };
    }
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식
  }

  hasPendingWork(): boolean {
    return this._startPos !== null;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
    ];
  }

  cancel(): void {
    super.cancel();
    this._startPos = null;
    this._startSnap = null;
  }

  // --- 내부 ---

  // endpoint의 접선 방향 계산 (인접 기하에서 추출)
  private _getEndpointTangent(
    store: SketchGeometryStore,
    snap: SnapResult,
  ): { x: number; y: number } | null {
    if (!snap || !snap.sourceGeomId) return null;
    if (snap.type !== "endpoint") return null;
    const geom = store.geometries.get(snap.sourceGeomId);
    if (!geom) return null;

    if (geom.type === "line") {
      const dx = geom.x2 - geom.x1;
      const dy = geom.y2 - geom.y1;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return null;
      // vertexIndex 0(start): 방향 = start→end
      // vertexIndex 1(end): 방향 = end→외부 (start→end 방향 유지)
      if (snap.sourceVertexIndex === 0) {
        return { x: -dx / len, y: -dy / len }; // start에서 외부 방향
      }
      return { x: dx / len, y: dy / len }; // end에서 외부 방향
    }

    if (geom.type === "arc") {
      const vi = snap.sourceVertexIndex;
      if (vi === undefined || vi === 0) return null; // center
      const angle = vi === 1 ? geom.startAngle : geom.endAngle;
      // arc 접선 = 반지름에 수직 (CCW 방향)
      // vi=1(start): 접선은 외부로 나가는 방향 (arc 시작 반대)
      // vi=2(end): 접선은 arc 끝에서 외부 방향
      const tx = -Math.sin(angle);
      const ty = Math.cos(angle);
      if (vi === 1) {
        return { x: -tx, y: -ty }; // start에서 외부 방향 (arc 진행 반대)
      }
      return { x: tx, y: ty }; // end에서 외부 방향
    }

    return null;
  }

  // G2 cubic Bezier 제어점 4개 계산 (NURBS degree 3으로 저장)
  // 양 끝점과 접선 방향을 받아 제어점 [p0, p0+|d|/3*t1, p1-|d|/3*t2, p1] 배치
  // Why: 접선 방향 보존 + 제어점 간격을 균일하게 맞춰 G1에 가까운 G2 근사 형상 제공
  // (완전한 G2 곡률 연속은 제어점 간격을 반지름에 맞춰 조정해야 하지만, 이 구현은 근사)
  private _computeG2CubicPoints(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    t1: { x: number; y: number },
    t2: { x: number; y: number },
  ): { x: number; y: number }[] {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy);
    const k = dist / 3;
    // t1은 startSnap의 "외부 방향"이므로 곡선이 들어가는 방향은 -t1 (접선의 반대)
    // t2도 "외부 방향"이므로 곡선이 나오는 방향은 -t2
    // 간단하게 t1, t2를 그대로 사용해 제어점을 안쪽으로 밀어넣음
    return [
      { x: p1.x, y: p1.y },
      { x: p1.x + k * t1.x, y: p1.y + k * t1.y },
      { x: p2.x + k * t2.x, y: p2.y + k * t2.y },
      { x: p2.x, y: p2.y },
    ];
  }

  // 두 점과 접선 방향으로 접선 arc 계산
  private _computeTangentArc(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    t1: { x: number; y: number },
    t2: { x: number; y: number },
  ): { cx: number; cy: number; r: number; startAngle: number; endAngle: number } | null {
    // 접선에 수직인 법선 (원 중심 방향)
    const n1 = { x: -t1.y, y: t1.x };
    const n2 = { x: -t2.y, y: t2.x };

    // 두 법선의 교점 = 원 중심
    // p1 + s*n1 = p2 + t*n2 → s, t 계산
    const denom = n1.x * n2.y - n1.y * n2.x;
    if (Math.abs(denom) < 1e-9) return null; // 평행 → arc 불가

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const s = (dx * n2.y - dy * n2.x) / denom;

    const cx = p1.x + s * n1.x;
    const cy = p1.y + s * n1.y;
    const r = Math.hypot(cx - p1.x, cy - p1.y);

    if (r < 0.1 || r > 10000) return null; // 반지름이 너무 작거나 큼

    const startAngle = Math.atan2(p1.y - cy, p1.x - cx);
    const endAngle = Math.atan2(p2.y - cy, p2.x - cx);

    return { cx, cy, r, startAngle, endAngle };
  }

  private _finalize(
    store: SketchGeometryStore,
    endPos: { x: number; y: number },
    endSnap: SnapResult,
  ): void {
    if (!this._startPos) return;

    const dist = Math.hypot(endPos.x - this._startPos.x, endPos.y - this._startPos.y);
    if (dist < 0.1) {
      this.cancel();
      return;
    }

    const tangentDir = this._getEndpointTangent(store, this._startSnap);
    const endTangentDir = this._getEndpointTangent(store, endSnap);

    const cmds: GeometryCommand[] = [];
    let geomId: string;
    // 결과 기하 타입: 끝점 vertex 인덱스 계산용
    // line: [0 start, 1 end], arc: [0 center, 1 start, 2 end], curve: [0 first, n-1 last]
    let resultKind: "line" | "arc" | "curve" = "line";
    let startVi = 0;
    let endVi = 1;

    if (this.continuityMode === "G2" && tangentDir && endTangentDir) {
      // G2: cubic NURBS curve (제어점 4개). tangentDir/endTangentDir는 기존 기하의 "끝점에서 외부로 나가는" 방향.
      // tangentStart/tangentEnd 필드는 curve 양끝에서 각자 외부로 뻗는 tangent를 저장 (제어점 오프셋 방향과 정합)
      const curvePoints = this._computeG2CubicPoints(this._startPos, endPos, tangentDir, endTangentDir);
      geomId = this._generateId();
      cmds.push(this._addGeometry({
        type: "curve",
        id: geomId,
        points: curvePoints,
        degree: 3,
        tangentStart: { x: tangentDir.x, y: tangentDir.y },
        tangentEnd: { x: endTangentDir.x, y: endTangentDir.y },
      }));
      resultKind = "curve";
      startVi = 0;
      endVi = curvePoints.length - 1;
    } else if (this.continuityMode === "G1" && tangentDir && endTangentDir) {
      // G1: 접선 arc (실패 시 직선 폴백)
      const arcData = this._computeTangentArc(this._startPos, endPos, tangentDir, endTangentDir);
      if (arcData) {
        geomId = this._generateId();
        cmds.push(this._addGeometry({
          type: "arc",
          id: geomId,
          cx: arcData.cx,
          cy: arcData.cy,
          r: arcData.r,
          startAngle: arcData.startAngle,
          endAngle: arcData.endAngle,
        }));
        resultKind = "arc";
        startVi = 1;
        endVi = 2;
      } else {
        geomId = this._generateId();
        cmds.push(this._addGeometry({
          type: "line",
          id: geomId,
          x1: this._startPos.x,
          y1: this._startPos.y,
          x2: endPos.x,
          y2: endPos.y,
        }));
      }
    } else {
      // G0 또는 접선 정보 부족 → 직선
      geomId = this._generateId();
      cmds.push(this._addGeometry({
        type: "line",
        id: geomId,
        x1: this._startPos.x,
        y1: this._startPos.y,
        x2: endPos.x,
        y2: endPos.y,
      }));
    }

    // start 끝점 coincident
    if (this._startSnap && this._startSnap.sourceGeomId && this._startSnap.sourceVertexIndex !== undefined) {
      cmds.push(new AddConstraintCommand({
        type: "coincident",
        id: generateConstraintId("auto-cst"),
        pointA: { geomId, vertexIndex: startVi },
        pointB: { geomId: this._startSnap.sourceGeomId, vertexIndex: this._startSnap.sourceVertexIndex },
      }));
    }

    // end 끝점 coincident
    if (endSnap && endSnap.sourceGeomId && endSnap.sourceVertexIndex !== undefined) {
      cmds.push(new AddConstraintCommand({
        type: "coincident",
        id: generateConstraintId("auto-cst"),
        pointA: { geomId, vertexIndex: endVi },
        pointB: { geomId: endSnap.sourceGeomId, vertexIndex: endSnap.sourceVertexIndex },
      }));
    }

    // G1 arc에서 tangent 구속 추가 (양쪽 인접 기하와 접선 연속)
    if (resultKind === "arc") {
      if (this._startSnap?.sourceGeomId) {
        cmds.push(new AddConstraintCommand({
          type: "tangent",
          id: generateConstraintId("auto-cst"),
          entityA: { geomId },
          entityB: { geomId: this._startSnap.sourceGeomId },
        }));
      }
      if (endSnap?.sourceGeomId && endSnap.sourceGeomId !== this._startSnap?.sourceGeomId) {
        cmds.push(new AddConstraintCommand({
          type: "tangent",
          id: generateConstraintId("auto-cst"),
          entityA: { geomId },
          entityB: { geomId: endSnap.sourceGeomId },
        }));
      }
    }

    if (cmds.length > 1) {
      store.execute(new BatchCommand(cmds));
    } else if (cmds.length === 1) {
      store.execute(cmds[0]);
    }

    this.cancel();
    store.requestRender();
  }
}

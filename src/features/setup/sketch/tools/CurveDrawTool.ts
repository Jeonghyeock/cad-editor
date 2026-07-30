// 곡선(폴리라인) 그리기 도구: 연속 클릭(제어점) → 더블클릭/Escape(확정)
// start/end 스냅 시 auto-coincident 구속을 BatchCommand로 원자적 undo

import type { SketchDrawToolType } from "../../Setup.type";
import { generateConstraintId } from "../../utils/idGenerator";

import { AddConstraintCommand } from "../commands/AddConstraintCommand";
import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapResult } from "../SnapEngine";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

export class CurveDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "curve";

  private _points: { x: number; y: number }[] = [];
  private _lastClickTime = 0;
  private _startSnap: SnapResult = null;
  private _endSnap: SnapResult = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    const now = Date.now();

    // 더블클릭 감지 (300ms 이내)
    // _endSnap은 직전 클릭에서 이미 캡처됨 — 여기서 덮어쓰지 않음
    if (now - this._lastClickTime < 300 && this._points.length >= 2) {
      this._finalize(store);
      this._lastClickTime = 0;
      return;
    }
    this._lastClickTime = now;

    // 첫 점: 시작 스냅 캡처
    if (this._points.length === 0) {
      this._startSnap = store.snapResult;
    }
    // 매 클릭마다 끝 스냅 갱신 (마지막 점이 끝점이 됨)
    this._endSnap = store.snapResult;

    this._points.push({ ...snappedPos });
    this._updatePreview(snappedPos, store);
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    // 기하 기반 추론선 (첫 클릭 전에도 작동)
    const geometries = [...store.geometries.values()];
    this.inferenceLines = computeGeometryInferences(
      snappedPos, store.snapResult, geometries, this.inferenceRadius,
    );

    if (this._points.length > 0) {
      this._updatePreview(snappedPos, store);
    }
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식이므로 pointerUp에서는 처리 없음
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
    ];
  }

  override applyInputValues(
    store: SketchGeometryStore,
    values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    if (values.H !== undefined && values.V !== undefined) {
      this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
      return true;
    }
    return false;
  }

  onKeyDown(store: SketchGeometryStore, event: KeyboardEvent): void {
    if (event.key === "Escape") {
      if (this._points.length >= 2) {
        // Escape로 현재까지의 점들 확정
        this._finalize(store);
      } else {
        this.cancel();
        store.requestRender();
      }
    }
  }

  cancel(): void {
    super.cancel();
    this._points = [];
    this._lastClickTime = 0;
    this._startSnap = null;
    this._endSnap = null;
  }

  private _finalize(store: SketchGeometryStore): void {
    if (this._points.length >= 2) {
      const curveId = this._generateId();

      // 스냅된 endpoint가 line인 경우 G1 연속성을 위한 tangent 벡터 계산
      const tangentStart = this._computeAutoTangent(store, this._startSnap, this._points[0], true);
      const tangentEnd = this._computeAutoTangent(store, this._endSnap, this._points[this._points.length - 1], false);

      const curveGeom: Parameters<typeof this._addGeometry>[0] = {
        type: "curve",
        id: curveId,
        points: [...this._points],
        degree: Math.min(3, this._points.length - 1),
      };
      if (tangentStart) (curveGeom as { tangentStart?: { x: number; y: number } }).tangentStart = tangentStart;
      if (tangentEnd) (curveGeom as { tangentEnd?: { x: number; y: number } }).tangentEnd = tangentEnd;

      const addCmd = this._addGeometry(curveGeom);

      // start/end auto-coincident + tangent 구속 생성
      const autoConstraintCmds: GeometryCommand[] = [];
      const startCst = this._buildAutoConstraint(store, curveId, 0, this._startSnap);
      if (startCst) autoConstraintCmds.push(startCst);
      const endCst = this._buildAutoConstraint(store, curveId, this._points.length - 1, this._endSnap);
      if (endCst) autoConstraintCmds.push(endCst);

      // line endpoint에 스냅 시 auto-tangent 구속 추가 (G1 연속성)
      const startTanCst = this._buildAutoTangentAtSnap(store, curveId, this._startSnap);
      if (startTanCst) autoConstraintCmds.push(startTanCst);
      const endTanCst = this._buildAutoTangentAtSnap(store, curveId, this._endSnap);
      if (endTanCst) autoConstraintCmds.push(endTanCst);

      if (autoConstraintCmds.length > 0) {
        store.execute(new BatchCommand([addCmd, ...autoConstraintCmds]));
      } else {
        store.execute(addCmd);
      }
    }
    this._points = [];
    this._lastClickTime = 0;
    this._startSnap = null;
    this._endSnap = null;
    this.preview = null;
  }

  // 스냅 대상이 line인 경우 접선 방향 벡터 계산 (G1 연속성)
  private _computeAutoTangent(
    store: SketchGeometryStore,
    snap: SnapResult,
    _curveEndpoint: { x: number; y: number },
    _isStart: boolean,
  ): { x: number; y: number } | undefined {
    if (!snap || !snap.sourceGeomId) return undefined;
    if (snap.type !== "endpoint") return undefined;
    const targetGeom = store.geometries.get(snap.sourceGeomId);
    if (!targetGeom || targetGeom.type !== "line") return undefined;

    // line 방향 벡터 계산 (스냅된 endpoint에서 먼 쪽으로의 방향)
    const dx = targetGeom.x2 - targetGeom.x1;
    const dy = targetGeom.y2 - targetGeom.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return undefined;

    // 단위 접선 벡터 반환
    return { x: dx / len, y: dy / len };
  }

  // 스냅 대상이 line endpoint인 경우 tangent 구속 커맨드 생성
  private _buildAutoTangentAtSnap(
    store: SketchGeometryStore,
    curveId: string,
    snap: SnapResult,
  ): GeometryCommand | null {
    if (!this.autoGeoConstraints) return null;
    if (!snap || !snap.sourceGeomId) return null;
    if (snap.type !== "endpoint") return null;
    const targetGeom = store.geometries.get(snap.sourceGeomId);
    if (!targetGeom || targetGeom.type !== "line") return null;

    // 중복 체크
    const cStore = store.constraintStore;
    if (cStore) {
      for (const [, c] of cStore.constraints) {
        if (c.type !== "tangent") continue;
        const matchAB = c.entityA.geomId === curveId && c.entityB.geomId === snap.sourceGeomId;
        const matchBA = c.entityB.geomId === curveId && c.entityA.geomId === snap.sourceGeomId;
        if (matchAB || matchBA) return null;
      }
    }

    return new AddConstraintCommand({
      type: "tangent",
      id: generateConstraintId("auto-cst-tan"),
      entityA: { geomId: curveId },
      entityB: { geomId: snap.sourceGeomId },
    });
  }

  private _updatePreview(
    currentPos: { x: number; y: number },
    store: SketchGeometryStore,
  ): void {
    const previewPoints = [...this._points, { ...currentPos }];
    this.preview = {
      type: "curve",
      id: "__preview__",
      points: previewPoints,
      degree: Math.min(3, previewPoints.length - 1),
    };
    store.requestRender();
  }
}

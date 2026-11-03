// 선 그리기 도구: 클릭(시작) → 이동(프리뷰) → 클릭(끝)
// 수평/수직 추론선 + 스냅 지원
// line + auto-coincident + auto H/V + auto-tangent 구속을 BatchCommand로 원자적 undo 단위 처리

import type { SketchDrawToolType } from "../../Setup.type";
import { generateConstraintId } from "../../utils/idGenerator";

import { AddConstraintCommand } from "../commands/AddConstraintCommand";
import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import {
  computeDirectionalInferences,
  computeGeometryInferences,
  computeInferenceIntersections,
  projectOntoInferenceLine,
} from "../InferenceEngine";
import type { InferenceLine } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";
import type { SnapResult } from "../SnapEngine";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

// 수평/수직 스냅 기본 임계값 (±5°)
const HV_SNAP_THRESHOLD_BASE = Math.PI / 36;
// 긴 선에서 임계값을 줄이기 위한 기준 길이
const HV_ADAPTIVE_LENGTH = 50;
// 최소 선 길이 (이보다 짧으면 무시)
const MIN_LINE_LENGTH = 0.1;

export class LineDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "line";

  private _startPos: { x: number; y: number } | null = null;
  // 시작점 스냅 정보 (auto-coincident 구속 생성용)
  private _startSnap: SnapResult = null;
  // 지금 찍는 점이 입력 패널 값(H/V, L/A)에서 왔는지 — 그런 점은 값 그대로 쓴다(_placeFromInput)
  private _fromInput = false;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    // 입력 패널 값은 커서 위치와 무관하므로, 커서가 잡은 스냅 결과로 자동 구속을 만들지 않는다
    const snap = this._fromInput ? null : store.snapResult;
    if (!this._startPos) {
      // 첫 클릭: 시작점 설정 + 스냅 정보 캡처
      this._startPos = { ...snappedPos };
      this._startSnap = snap;
    } else {
      // 두 번째 클릭: H/V 스냅 우선, H/V 미발동 시 parallel/perpendicular/colinear 추론.
      // 입력 패널 값으로 들어온 끝점은 입력한 길이·각도를 지키도록 두 보정을 모두 건너뛴다.
      const endSnap = snap;
      const hvResult = this._fromInput ? { pos: snappedPos, snapDir: null } : this._applyHVSnap(snappedPos);
      let snapped = hvResult.pos;
      const hvFired = hvResult.snapDir !== null;

      // CATIA SmartPick: H/V 안 걸린 경우 기존 line 과 평행/수직/공선 자동 추론.
      let ppResult: ReturnType<typeof this._applyParallelPerpendicularSnap> = null;
      if (!hvFired && this._startPos && !this._fromInput) {
        ppResult = this._applyParallelPerpendicularSnap(store, this._startPos, snapped);
        if (ppResult) snapped = ppResult.pos;
      }

      // 최소 길이 가드: 퇴화 선분(zero-length) 방지
      const lineLen = Math.hypot(snapped.x - this._startPos.x, snapped.y - this._startPos.y);
      if (lineLen < MIN_LINE_LENGTH) return;

      const lineId = this._generateId();
      const addLineCmd = this._addGeometry({
        type: "line",
        id: lineId,
        x1: this._startPos.x,
        y1: this._startPos.y,
        x2: snapped.x,
        y2: snapped.y,
      });

      // auto-constraint 수집
      const autoConstraintCmds: GeometryCommand[] = [];

      // 시작점 auto-coincident
      const startCst = this._buildAutoConstraint(store, lineId, 0, this._startSnap);
      if (startCst) autoConstraintCmds.push(startCst);

      // 끝점 auto-coincident (H/V 스냅과 상호 배타 아님)
      // H/V 스냅 시에도 끝점이 다른 기하에 스냅되어 있으면 coincident 생성
      if (endSnap && (endSnap.type === "endpoint" || endSnap.type === "center")) {
        // H/V 보정 후 스냅 대상과의 거리가 허용 범위 내인지 확인
        const snapDist = Math.hypot(snapped.x - endSnap.x, snapped.y - endSnap.y);
        if (snapDist < lineLen * 0.05 + 0.5) {
          // 스냅 대상에 맞춰 끝점 좌표 미세 보정 (H/V 방향 유지)
          const endCst = this._buildAutoConstraint(store, lineId, 1, endSnap);
          if (endCst) autoConstraintCmds.push(endCst);
        }
      } else if (!hvFired) {
        // H/V 아니고 endpoint/center 스냅도 아닌 경우: nearest 등 처리
        const endCst = this._buildAutoConstraint(store, lineId, 1, endSnap);
        if (endCst) autoConstraintCmds.push(endCst);
      }

      // H/V 구속 (자동 구속 토글 연동)
      if (hvFired && this.autoGeoConstraints) {
        autoConstraintCmds.push(this._buildHVConstraint(lineId, hvResult.snapDir === "h"));
      }

      // Parallel / Perpendicular / Colinear 구속 (CATIA SmartPick 표준 — H/V 와 상호 배타).
      if (ppResult && this.autoGeoConstraints) {
        autoConstraintCmds.push(new AddConstraintCommand({
          type: ppResult.relation,
          id: generateConstraintId("auto-cst"),
          lineA: { geomId: lineId },
          lineB: { geomId: ppResult.sourceGeomId },
        }));
      }

      // Tangent 자동 감지: 끝점이 circle/arc에 접할 때
      if (endSnap && endSnap.sourceGeomId) {
        const tanCst = this._buildAutoTangentConstraint(store, lineId, this._startPos, snapped, endSnap);
        if (tanCst) autoConstraintCmds.push(tanCst);
      }

      // line + auto-constraints를 단일 undo 단위로 묶기
      if (autoConstraintCmds.length > 0) {
        store.execute(new BatchCommand([addLineCmd, ...autoConstraintCmds]));
      } else {
        store.execute(addLineCmd);
      }

      // 선 하나 완료 → idle 복귀 (연속 체인은 Profile 도구에서)
      this.cancel();
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
    event?: PointerEvent,
  ): void {
    const geometries = [...store.geometries.values()];
    const radius = this.inferenceRadius;
    const ctrlHeld = event?.ctrlKey ?? false;

    if (this._startPos) {
      const hvResult = this._applyHVSnap(snappedPos);
      let endPos = hvResult.pos;
      // 확정(onPointerDown)과 같은 기준: H/V 가 안 걸리면 평행·수직·공선 추론으로 보정한 끝점을 보여 준다
      if (hvResult.snapDir === null) {
        const ppResult = this._applyParallelPerpendicularSnap(store, this._startPos, endPos);
        if (ppResult) endPos = ppResult.pos;
      }

      // 방향 기반 + 기하 기반 추론선 계산
      const directional = computeDirectionalInferences(
        this._startPos, endPos, geometries, radius * 0.5,
      );
      const geometry = computeGeometryInferences(
        endPos, store.snapResult, geometries, radius,
      );
      let allLines: InferenceLine[] = [...directional, ...geometry];

      // Ctrl-Lock: Ctrl 키가 눌려있고 추론선이 있으면 잠금
      if (ctrlHeld && allLines.length > 0) {
        // 가장 가까운 추론선을 잠금 대상으로 선택
        if (!this.lockedInference) {
          this.lockedInference = this._findClosestInferenceLine(endPos, allLines);
        }
      } else {
        this.lockedInference = null;
      }

      // 잠긴 추론선이 있으면 커서를 그 위로 투영
      if (this.lockedInference) {
        endPos = projectOntoInferenceLine(snappedPos, this.lockedInference);
        // 잠긴 선은 실선 표시 (isLocked=true)
        const locked = { ...this.lockedInference, isLocked: true };
        allLines = [locked];
      } else {
        // SmartPick: 2개 이상의 추론선 교차점 스냅
        const intersection = computeInferenceIntersections(allLines, endPos, radius);
        if (intersection) {
          endPos = { x: intersection.x, y: intersection.y };
          // 교차에 기여한 추론선만 표시
          allLines = intersection.sourceLines;
        }
      }

      this.preview = {
        type: "line",
        id: "__preview__",
        x1: this._startPos.x,
        y1: this._startPos.y,
        x2: endPos.x,
        y2: endPos.y,
      };
      this.inferenceLines = allLines;
    } else {
      // 첫 클릭 전: 기하 기반 추론선만
      let allLines = computeGeometryInferences(
        snappedPos, store.snapResult, geometries, radius,
      );

      // Ctrl-Lock (첫 클릭 전)
      if (ctrlHeld && allLines.length > 0) {
        if (!this.lockedInference) {
          this.lockedInference = this._findClosestInferenceLine(snappedPos, allLines);
        }
      } else {
        this.lockedInference = null;
      }

      if (this.lockedInference) {
        allLines = [{ ...this.lockedInference, isLocked: true }];
      } else {
        // SmartPick 교차점 (첫 클릭 전)
        const intersection = computeInferenceIntersections(allLines, snappedPos, radius);
        if (intersection) {
          allLines = intersection.sourceLines;
        }
      }
      this.inferenceLines = allLines;
    }

    store.requestRender();
  }

  /** 커서에 가장 가까운 추론선 찾기 (Ctrl-Lock 대상 선택) */
  private _findClosestInferenceLine(
    cursor: { x: number; y: number },
    lines: InferenceLine[],
  ): InferenceLine | null {
    let best: InferenceLine | null = null;
    let bestDist = Infinity;
    for (const line of lines) {
      const projected = projectOntoInferenceLine(cursor, line);
      const d = Math.hypot(cursor.x - projected.x, cursor.y - projected.y);
      if (d < bestDist) {
        bestDist = d;
        best = line;
      }
    }
    return best;
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 선은 클릭-클릭 방식이므로 pointerUp에서는 아무것도 하지 않음
  }

  hasPendingWork(): boolean {
    return this._startPos !== null;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    // 항상 H, V, L, A 표시 — 시작점 전이면 L/A는 0
    const l = this._startPos && mousePos
      ? Math.hypot(mousePos.x - this._startPos.x, mousePos.y - this._startPos.y) : undefined;
    const a = this._startPos && mousePos
      ? Math.atan2(mousePos.y - this._startPos.y, mousePos.x - this._startPos.x) * 180 / Math.PI : undefined;
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
    if (!this._startPos) {
      // 시작점 설정: H/V 필요
      if (values.H !== undefined && values.V !== undefined) {
        this._placeFromInput(store, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    // 끝점 결정: L+A 또는 H+V
    if (values.L !== undefined && values.A !== undefined) {
      const rad = values.A * Math.PI / 180;
      const endX = this._startPos.x + values.L * Math.cos(rad);
      const endY = this._startPos.y + values.L * Math.sin(rad);
      this._placeFromInput(store, { x: endX, y: endY });
      return true;
    }
    if (values.H !== undefined && values.V !== undefined) {
      this._placeFromInput(store, { x: values.H, y: values.V });
      return true;
    }
    return false;
  }

  // 입력 패널 값으로 점을 찍는다. 값이 곧 좌표라 H/V·평행·수직 보정을 하지 않고, 커서 위치의 스냅 결과로 자동 구속도
  // 만들지 않는다 — 그러면 L=100, A=2 가 0° 수평선으로, 30° 선 옆의 A=33 이 30° 평행선으로 바뀌었다.
  private _placeFromInput(store: SketchGeometryStore, pos: { x: number; y: number }): void {
    this._fromInput = true;
    try {
      this.onPointerDown(store, pos, pos);
    } finally {
      this._fromInput = false;
    }
  }

  cancel(): void {
    super.cancel();
    this._startPos = null;
    this._startSnap = null;
  }

  // H/V 자동 구속 커맨드 빌드
  private _buildHVConstraint(lineId: string, isHorizontal: boolean): GeometryCommand {
    return new AddConstraintCommand({
      type: isHorizontal ? "horizontal" : "vertical",
      id: generateConstraintId("auto-cst"),
      line: { geomId: lineId },
    });
  }

  // 수평/수직 스냅 (적응형 임계값 — 긴 선에서 더 정밀)
  private _applyHVSnap(pos: { x: number; y: number }): { pos: { x: number; y: number }; snapDir: "h" | "v" | null } {
    if (!this._startPos) return { pos, snapDir: null };

    const dx = pos.x - this._startPos.x;
    const dy = pos.y - this._startPos.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return { pos, snapDir: null };

    // 적응형 임계값: 긴 선에서는 더 정밀하게
    const threshold = Math.min(HV_SNAP_THRESHOLD_BASE, HV_SNAP_THRESHOLD_BASE * HV_ADAPTIVE_LENGTH / Math.max(dist, 1));
    const angle = Math.atan2(dy, dx);

    const hvAngles: [number, "h" | "v"][] = [
      [0, "h"], [Math.PI / 2, "v"], [Math.PI, "h"], [-Math.PI / 2, "v"],
    ];
    for (const [hvAngle, dir] of hvAngles) {
      let diff = Math.abs(angle - hvAngle);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;

      if (diff <= threshold) {
        const snappedX = this._startPos.x + dist * Math.cos(hvAngle);
        const snappedY = this._startPos.y + dist * Math.sin(hvAngle);
        return { pos: { x: snappedX, y: snappedY }, snapDir: dir };
      }
    }

    return { pos, snapDir: null };
  }
}

// 축선 그리기 도구: Revolve 회전축용 특수 라인
// 스케치당 하나만 허용, 대시-도트 패턴으로 렌더링
// LineDrawTool과 동일한 클릭-클릭 방식

import type { SketchDrawToolType } from "../../Setup.type";

import { AddGeometryCommand } from "../commands/AddGeometryCommand";
import { BatchCommand } from "../commands/BatchCommand";
import type { GeometryCommand } from "../commands/GeometryCommand";
import { RemoveGeometryCommand } from "../commands/RemoveGeometryCommand";
import { computeDirectionalInferences, computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField } from "./DrawTool";
import { DrawTool } from "./DrawTool";

// 최소 축선 길이 (이보다 짧으면 무시)
const MIN_AXIS_LENGTH = 0.1;

export class AxisDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "axis";

  private _startPos: { x: number; y: number } | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (!this._startPos) {
      // 첫 클릭: 시작점 설정
      this._startPos = { ...snappedPos };
    } else {
      // 두 번째 클릭: 축선 확정
      const lineLen = Math.hypot(snappedPos.x - this._startPos.x, snappedPos.y - this._startPos.y);
      if (lineLen < MIN_AXIS_LENGTH) return;

      const lineId = this._generateId();

      // 기존 축선이 있으면 제거 후 새 축선 추가 (스케치당 1개만 허용)
      const cmds: GeometryCommand[] = [];
      const existingAxis = this._findExistingAxis(store);
      if (existingAxis) {
        cmds.push(new RemoveGeometryCommand([existingAxis]));
      }

      cmds.push(new AddGeometryCommand({
        type: "line",
        id: lineId,
        x1: this._startPos.x,
        y1: this._startPos.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
        isAxis: true,
      }));

      if (cmds.length > 1) {
        store.execute(new BatchCommand(cmds));
      } else {
        store.execute(cmds[0]);
      }

      // 완료: 상태 초기화
      this._startPos = null;
      this.preview = null;
      this.inferenceLines = [];
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    const geometries = [...store.geometries.values()];
    const radius = this.inferenceRadius;

    if (this._startPos) {
      this.preview = {
        type: "line",
        id: "__preview__",
        x1: this._startPos.x,
        y1: this._startPos.y,
        x2: snappedPos.x,
        y2: snappedPos.y,
        isAxis: true,
      };

      // 방향 기반 + 기하 기반 추론선
      const directional = computeDirectionalInferences(
        this._startPos, snappedPos, geometries, radius * 0.5,
      );
      const geometry = computeGeometryInferences(
        snappedPos, store.snapResult, geometries, radius,
      );
      this.inferenceLines = [...directional, ...geometry];
    } else {
      // 첫 클릭 전: 기하 기반 추론선만
      this.inferenceLines = computeGeometryInferences(
        snappedPos, store.snapResult, geometries, radius,
      );
    }

    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭-클릭 방식이므로 pointerUp에서는 아무것도 하지 않음
  }

  hasPendingWork(): boolean {
    return this._startPos !== null;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
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

  cancel(): void {
    super.cancel();
    this._startPos = null;
  }

  // 기존 축선 찾기 (스케치당 1개만 허용)
  private _findExistingAxis(store: SketchGeometryStore) {
    for (const geom of store.geometries.values()) {
      if (geom.type === "line" && "isAxis" in geom && geom.isAxis) {
        return geom;
      }
    }
    return null;
  }
}

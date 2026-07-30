// 사각형 그리기 도구: 클릭(꼭짓점) → 이동(프리뷰) → 클릭(대각 꼭짓점 확정)
// 4개 독립 line으로 분해하여 생성 (BatchCommand로 단일 undo 단위)

import type { SketchDrawToolType } from "../../Setup.type";

import { AddRectangleCommand, createRectangleGeometryAndConstraints } from "../commands/AddRectangleCommand";
import { BatchCommand } from "../commands/BatchCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType, SnapVertexMapping } from "./DrawTool";
import { DrawTool } from "./DrawTool";

export class RectangleDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "rectangle";

  private _startPos: { x: number; y: number } | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (!this._startPos) {
      // 첫 클릭: 시작 꼭짓점 설정
      this._recordSnap(store);
      this._startPos = { ...snappedPos };
    } else {
      // 두 번째 클릭: 4개 line으로 사각형 확정
      this._recordSnap(store);
      const w = Math.abs(snappedPos.x - this._startPos.x);
      const h = Math.abs(snappedPos.y - this._startPos.y);

      if (w > 0.1 && h > 0.1) {
        const x = Math.min(this._startPos.x, snappedPos.x);
        const y = Math.min(this._startPos.y, snappedPos.y);

        const lineIds: [string, string, string, string] = [
          this._generateId(), this._generateId(),
          this._generateId(), this._generateId(),
        ];
        const { geometries, constraints } = createRectangleGeometryAndConstraints(x, y, w, h, lineIds);
        const finalGeometries = this.constructionMode
          ? geometries.map((g) => ({ ...g, isConstruction: true }))
          : geometries;

        // 스냅 기반 auto-constraint 생성
        // 꼭짓점: TL(x,y)=line[0].v0, TR=line[0].v1, BR=line[1].v1, BL=line[2].v1
        // click 0=_startPos, click 1=snappedPos → min/max에 따라 매핑
        const mappings: SnapVertexMapping[] = [];
        const sp = this._startPos;
        // click 0 매핑: _startPos가 어떤 꼭짓점에 해당하는지
        if (sp.x <= snappedPos.x && sp.y <= snappedPos.y) {
          // startPos=TL → line[0].v0
          mappings.push({ clickIndex: 0, geomId: lineIds[0], vertexIndex: 0 });
          // snappedPos=BR → line[1].v1
          mappings.push({ clickIndex: 1, geomId: lineIds[1], vertexIndex: 1 });
        } else if (sp.x > snappedPos.x && sp.y <= snappedPos.y) {
          // startPos=TR → line[0].v1
          mappings.push({ clickIndex: 0, geomId: lineIds[0], vertexIndex: 1 });
          // snappedPos=BL → line[2].v1
          mappings.push({ clickIndex: 1, geomId: lineIds[2], vertexIndex: 1 });
        } else if (sp.x <= snappedPos.x && sp.y > snappedPos.y) {
          // startPos=BL → line[2].v1
          mappings.push({ clickIndex: 0, geomId: lineIds[2], vertexIndex: 1 });
          // snappedPos=TR → line[0].v1
          mappings.push({ clickIndex: 1, geomId: lineIds[0], vertexIndex: 1 });
        } else {
          // startPos=BR → line[1].v1
          mappings.push({ clickIndex: 0, geomId: lineIds[1], vertexIndex: 1 });
          // snappedPos=TL → line[0].v0
          mappings.push({ clickIndex: 1, geomId: lineIds[0], vertexIndex: 0 });
        }
        const autoCmds = this._buildSnapConstraints(store, mappings);

        const mainCmd = new AddRectangleCommand(finalGeometries, constraints);
        if (autoCmds.length > 0) {
          store.execute(new BatchCommand([mainCmd, ...autoCmds]));
        } else {
          store.execute(mainCmd);
        }
      }

      this._startPos = null;
      this._clearSnaps();
      this.preview = null;
      this.previews = [];
    }
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

    if (!this._startPos) {
      store.requestRender();
      return;
    }

    const x = Math.min(this._startPos.x, snappedPos.x);
    const y = Math.min(this._startPos.y, snappedPos.y);
    const w = Math.abs(snappedPos.x - this._startPos.x);
    const h = Math.abs(snappedPos.y - this._startPos.y);

    // 4개 line 프리뷰
    this.previews = [
      { type: "line", id: "__preview_0__", x1: x, y1: y, x2: x + w, y2: y },
      { type: "line", id: "__preview_1__", x1: x + w, y1: y, x2: x + w, y2: y + h },
      { type: "line", id: "__preview_2__", x1: x + w, y1: y + h, x2: x, y2: y + h },
      { type: "line", id: "__preview_3__", x1: x, y1: y + h, x2: x, y2: y },
    ];
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭-클릭 방식이므로 pointerUp에서는 처리 없음
  }

  hasPendingWork(): boolean {
    return this._startPos !== null;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    const w = this._startPos && mousePos
      ? Math.abs(mousePos.x - this._startPos.x) : undefined;
    const l = this._startPos && mousePos
      ? Math.abs(mousePos.y - this._startPos.y) : undefined;
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "W", label: "W", value: w },
      { type: "L", label: "L", value: l },
    ];
  }

  override applyInputValues(
    store: SketchGeometryStore,
    values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    if (!this._startPos) {
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    // W+L → 시작점에서 폭/높이로 대각점 계산
    if (values.W !== undefined && values.L !== undefined) {
      this.onPointerDown(store, {
        x: this._startPos.x + values.W,
        y: this._startPos.y + values.L,
      }, {
        x: this._startPos.x + values.W,
        y: this._startPos.y + values.L,
      });
      return true;
    }
    // H+V → 대각점 직접 지정
    if (values.H !== undefined && values.V !== undefined) {
      this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
      return true;
    }
    return false;
  }

  cancel(): void {
    super.cancel();
    this._startPos = null;
  }
}

// 중심 기준 사각형 그리기 도구: 2클릭 — 중심 → 꼭짓점
// 중심으로부터 대칭으로 확장되는 축 정렬 사각형
// 4 line + 4 coincident + 2 horizontal + 2 vertical 구속

import type { SketchDrawToolType } from "../../Setup.type";

import { AddRectangleCommand, createRectangleGeometryAndConstraints } from "../commands/AddRectangleCommand";
import { BatchCommand } from "../commands/BatchCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

export class CenteredRectangleDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "centered-rectangle";

  private _center: { x: number; y: number } | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (!this._center) {
      // 첫 클릭: 중심점 설정 (중심은 vertex에 직접 매핑되지 않으므로 기록만)
      this._recordSnap(store);
      this._center = { ...snappedPos };
    } else {
      // 두 번째 클릭: 꼭짓점으로 사각형 확정
      this._recordSnap(store);
      const halfW = Math.abs(snappedPos.x - this._center.x);
      const halfH = Math.abs(snappedPos.y - this._center.y);

      if (halfW > 0.05 && halfH > 0.05) {
        const x = this._center.x - halfW;
        const y = this._center.y - halfH;
        const w = halfW * 2;
        const h = halfH * 2;

        const lineIds: [string, string, string, string] = [
          this._generateId(), this._generateId(),
          this._generateId(), this._generateId(),
        ];
        const { geometries, constraints } = createRectangleGeometryAndConstraints(x, y, w, h, lineIds);
        const finalGeometries = this.constructionMode
          ? geometries.map((g) => ({ ...g, isConstruction: true }))
          : geometries;

        // 스냅 기반 auto-constraint: click 1(corner)의 vertex 매핑
        // click 0=center → 사각형 vertex에 해당하지 않으므로 제외
        // click 1=snappedPos → 4개 꼭짓점 중 하나 (TL/TR/BR/BL)
        // 꼭짓점: TL(x,y)=line[0].v0, TR=line[0].v1, BR=line[1].v1, BL=line[2].v1
        const mappings = [];
        const cp = this._center;
        if (snappedPos.x >= cp.x && snappedPos.y >= cp.y) {
          // snappedPos=BR → line[1].v1
          mappings.push({ clickIndex: 1, geomId: lineIds[1], vertexIndex: 1 });
        } else if (snappedPos.x < cp.x && snappedPos.y >= cp.y) {
          // snappedPos=BL → line[2].v1
          mappings.push({ clickIndex: 1, geomId: lineIds[2], vertexIndex: 1 });
        } else if (snappedPos.x >= cp.x && snappedPos.y < cp.y) {
          // snappedPos=TR → line[0].v1
          mappings.push({ clickIndex: 1, geomId: lineIds[0], vertexIndex: 1 });
        } else {
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

      this._center = null;
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
    // 기하 기반 추론선
    const geometries = [...store.geometries.values()];
    this.inferenceLines = computeGeometryInferences(
      snappedPos, store.snapResult, geometries, this.inferenceRadius,
    );

    if (!this._center) {
      store.requestRender();
      return;
    }

    const halfW = Math.abs(snappedPos.x - this._center.x);
    const halfH = Math.abs(snappedPos.y - this._center.y);
    const x = this._center.x - halfW;
    const y = this._center.y - halfH;
    const w = halfW * 2;
    const h = halfH * 2;

    // 4개 line 프리뷰
    this.previews = [
      { type: "line", id: "__preview_0__", x1: x, y1: y, x2: x + w, y2: y },
      { type: "line", id: "__preview_1__", x1: x + w, y1: y, x2: x + w, y2: y + h },
      { type: "line", id: "__preview_2__", x1: x + w, y1: y + h, x2: x, y2: y + h },
      { type: "line", id: "__preview_3__", x1: x, y1: y + h, x2: x, y2: y },
    ];

    // 중심 표시 (construction point)
    this.preview = {
      type: "point", id: "__center_preview__",
      x: this._center.x, y: this._center.y,
      isConstruction: true,
    };

    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭-클릭 방식
  }

  hasPendingWork(): boolean {
    return this._center !== null;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    const w = this._center && mousePos
      ? Math.abs(mousePos.x - this._center.x) * 2 : undefined;
    const l = this._center && mousePos
      ? Math.abs(mousePos.y - this._center.y) * 2 : undefined;
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
    if (!this._center) {
      // 중심 설정: H/V
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    // W+L: 폭/높이로 꼭짓점 계산
    if (values.W !== undefined && values.L !== undefined) {
      this.onPointerDown(store, {
        x: this._center.x + values.W / 2,
        y: this._center.y + values.L / 2,
      }, {
        x: this._center.x + values.W / 2,
        y: this._center.y + values.L / 2,
      });
      return true;
    }
    if (values.H !== undefined && values.V !== undefined) {
      this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
      return true;
    }
    return false;
  }

  cancel(): void {
    super.cancel();
    this._center = null;
  }
}

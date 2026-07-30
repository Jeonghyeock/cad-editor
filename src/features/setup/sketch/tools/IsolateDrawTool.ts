// Isolate 도구 (CATIA Relimit 스타일)
// 기하를 클릭하면 해당 기하에 연결된 모든 구속조건을 일괄 제거
// 기하 자체는 유지되나 완전 자유 상태(under-constrained)가 됨

import type { SketchDrawToolType } from "../../Setup.type";
import { getConstraintGeomIds } from "../../utils/geometryUtils";

import { BatchCommand } from "../commands/BatchCommand";
import { RemoveConstraintCommand } from "../commands/RemoveConstraintCommand";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import { DrawTool } from "./DrawTool";

export class IsolateDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "isolate";


  selectionOnly = true;
  // hover 하이라이트: 대상 기하 ID
  isolateTargetId: string | null = null;
  // hover 시 제거 대상 구속 수 (UI 정보 표시용)
  constraintCount = 0;

  private _hoveredGeomId: string | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    if (!this._hoveredGeomId) return;

    const geom = store.geometries.get(this._hoveredGeomId);
    if (!geom) return;

    const cStore = store.constraintStore;
    if (!cStore) return;

    // 대상 기하에 연결된 모든 구속 수집
    const targetId = this._hoveredGeomId;
    const removeCommands: RemoveConstraintCommand[] = [];

    for (const [, constraint] of cStore.constraints) {
      const geomIds = getConstraintGeomIds(constraint);
      if (geomIds.includes(targetId)) {
        removeCommands.push(new RemoveConstraintCommand(constraint));
      }
    }

    if (removeCommands.length === 0) {
      // 제거할 구속 없음
      this.isolateTargetId = null;
      this._hoveredGeomId = null;
      store.hoveredItem = null;
      store.requestRender();
      return;
    }

    // BatchCommand로 일괄 실행
    store.execute(
      removeCommands.length === 1
        ? removeCommands[0]
        : new BatchCommand(removeCommands),
    );

    // 상태 초기화
    this.isolateTargetId = null;
    this.constraintCount = 0;
    this._hoveredGeomId = null;
    store.hoveredItem = null;
    store.requestRender();
  }

  onPointerMove(
    store: SketchGeometryStore,
    rawPos: { x: number; y: number },
    _snappedPos: { x: number; y: number },
  ): void {
    const hitRadius = this.inferenceRadius || 5;
    const hitId = store.hitTest(rawPos, hitRadius);

    this.isolateTargetId = null;
    this.constraintCount = 0;
    this._hoveredGeomId = null;
    store.hoveredItem = null;

    if (!hitId) {
      store.requestRender();
      return;
    }

    const geom = store.geometries.get(hitId);
    if (!geom) { store.requestRender(); return; }
    if ("isReference" in geom && geom.isReference) { store.requestRender(); return; }

    this._hoveredGeomId = hitId;
    this.isolateTargetId = hitId;
    store.hoveredItem = { kind: "geometry", geomId: hitId };

    // 제거 대상 구속 수 계산 (프리뷰 정보)
    const cStore = store.constraintStore;
    if (cStore) {
      let count = 0;
      for (const [, constraint] of cStore.constraints) {
        const geomIds = getConstraintGeomIds(constraint);
        if (geomIds.includes(hitId)) count++;
      }
      this.constraintCount = count;
    }

    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // isolate는 pointerDown에서 처리
  }

  cancel(): void {
    super.cancel();
    this.isolateTargetId = null;
    this.constraintCount = 0;
    this._hoveredGeomId = null;
  }
}

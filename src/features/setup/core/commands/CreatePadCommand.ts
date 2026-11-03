// Pad/Pocket 생성 커맨드 (글로벌 히스토리)
// CATIA 식 — Pad 생성 시 source shape 자동 hide 가 같이 command 안에서 처리되어 ctrl+z 한 번에
// operation 삭제 + source shape visible 복원이 atomic.

import type { SetStateAction } from "jotai";

import type SetupScene from "../../rendering/SetupScene";
import type { OperationTreeEntry, PadPocketOperation, SerializedGeometry } from "../../Setup.type";

import type { GlobalCommand } from "../GlobalCommand";

import { SceneTaskQueue } from "./SceneTaskQueue";

export class CreatePadCommand implements GlobalCommand {
  readonly label: string;
  /** 솔리드 add(비동기)·remove 를 차례로 — 결과가 나오기 전에 undo/redo 해도 늦은 add 가 씬을 덮어쓰지 않게. */
  private _sceneTasks = new SceneTaskQueue();
  /**
   * execute 시점에 새로 hiddenShapeIds 에 추가한 id 들의 백업.
   * undo 시 그것만 remove — 사용자가 그 사이 manually hide 한 다른 shape 의 상태는 보존.
   */
  private _addedHiddenIds = new Set<string>();

  constructor(
    private _operation: PadPocketOperation,
    private _planeName: string,
    private _geometries: Map<string, SerializedGeometry>,
    private _setOperations: (update: SetStateAction<OperationTreeEntry[]>) => void,
    private _getScene: () => SetupScene | null,
    private _setHiddenShapeIds: (update: SetStateAction<Set<string>>) => void,
    private _getHiddenShapeIds: () => Set<string>,
  ) {
    this.label = `Create ${_operation.type === "pad" ? "Pad" : "Pocket"}`;
  }

  execute(): void {
    const entry: OperationTreeEntry = {
      operation: this._operation,
      sketchPlaneName: this._planeName,
    };
    this._setOperations((prev) => [...prev, entry]);

    this._sceneTasks.run(() =>
      this._getScene()?.addExtrudedSolid(this._operation, this._geometries),
    );

    // CATIA 식 — source shape 자동 hide. profileIds 중 이미 hidden 아닌 id 만 추가하고
    // _addedHiddenIds 에 백업 → undo 시 그것만 remove.
    if (this._operation.profileIds.length > 0) {
      const prev = this._getHiddenShapeIds();
      this._addedHiddenIds.clear();
      const next = new Set(prev);
      for (const id of this._operation.profileIds) {
        if (!next.has(id)) {
          next.add(id);
          this._addedHiddenIds.add(id);
        }
      }
      if (this._addedHiddenIds.size > 0) this._setHiddenShapeIds(next);
    }
  }

  undo(): void {
    const opId = this._operation.id;
    this._setOperations((prev) => prev.filter((e) => e.operation.id !== opId));

    this._sceneTasks.run(() => {
      const scene = this._getScene();
      if (!scene) return;
      scene.removeExtrudedSolid(opId);
      // 소스 솔리드 다시 표시 (CSG 연산이었을 경우)
      if (this._operation.targetOperationId) {
        scene.restoreSourceVisibility(this._operation.targetOperationId);
      }
    });

    // execute 가 추가한 hidden id 만 remove (그 외 manually hidden 된 건 보존).
    if (this._addedHiddenIds.size > 0) {
      const prev = this._getHiddenShapeIds();
      const next = new Set(prev);
      for (const id of this._addedHiddenIds) next.delete(id);
      this._setHiddenShapeIds(next);
    }
  }
}

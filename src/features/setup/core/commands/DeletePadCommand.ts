// Operation 삭제 커맨드 (글로벌 히스토리)
// CATIA 식 — Pad 삭제 시 source shape 자동 show. CreatePadCommand 의 auto-hide 와 짝.
// 사용자가 그 사이 manually hide 한 다른 shape 의 상태는 별개 history entry — 영향 없음.

import type { SetStateAction } from "jotai";

import type SetupScene from "../../rendering/SetupScene";
import type { OperationTreeEntry, PadPocketOperation, RevolveOperation, SerializedGeometry } from "../../Setup.type";

import type { GlobalCommand } from "../GlobalCommand";

export class DeletePadCommand implements GlobalCommand {
  readonly label = "Delete Pad/Pocket";
  private _savedEntry: OperationTreeEntry | null = null;
  /** execute 시점에 hiddenShapeIds 에서 실제로 제거한 id 들 — undo 시 그것만 다시 추가. */
  private _removedHiddenIds = new Set<string>();

  constructor(
    private _operationId: string,
    private _setOperations: (update: SetStateAction<OperationTreeEntry[]>) => void,
    private _getScene: () => SetupScene | null,
    private _geometries: Map<string, SerializedGeometry>,
    private _setHiddenShapeIds: (update: SetStateAction<Set<string>>) => void,
    private _getHiddenShapeIds: () => Set<string>,
  ) {}

  execute(): void {
    this._setOperations((prev) => {
      const idx = prev.findIndex((e) => e.operation.id === this._operationId);
      if (idx >= 0) this._savedEntry = prev[idx];
      return prev.filter((e) => e.operation.id !== this._operationId);
    });

    const scene = this._getScene();
    if (scene) {
      scene.removeExtrudedSolid(this._operationId);
    }

    // auto-show — source shape 의 hidden 상태 해제. operation.profileIds 중 현재 hidden 인 것만
    // 제거 (manual hide 후 다시 show 한 케이스는 영향 없음). 백업해서 undo 시 복원.
    const op = this._savedEntry?.operation;
    if (op && "profileIds" in op && op.profileIds.length > 0) {
      const prev = this._getHiddenShapeIds();
      this._removedHiddenIds.clear();
      for (const id of op.profileIds) {
        if (prev.has(id)) this._removedHiddenIds.add(id);
      }
      if (this._removedHiddenIds.size > 0) {
        const next = new Set(prev);
        for (const id of this._removedHiddenIds) next.delete(id);
        this._setHiddenShapeIds(next);
      }
    }
  }

  undo(): void {
    if (!this._savedEntry) return;

    this._setOperations((prev) => [...prev, this._savedEntry!]);

    const scene = this._getScene();
    if (scene) {
      const op = this._savedEntry.operation;
      switch (op.type) {
        case "pad":
        case "pocket":
          scene.addExtrudedSolid(op as PadPocketOperation, this._geometries);
          break;
        case "revolve":
          scene.addRevolvedSolid(op as RevolveOperation, this._geometries);
          break;
      }
    }

    // execute 가 제거했던 id 들만 다시 hidden 으로.
    if (this._removedHiddenIds.size > 0) {
      const prev = this._getHiddenShapeIds();
      const next = new Set(prev);
      for (const id of this._removedHiddenIds) next.add(id);
      this._setHiddenShapeIds(next);
    }
  }
}

// Body 개별 삭제 커맨드 (글로벌 히스토리)
// deletedBodies atom에 추가 + 3D 숨김, undo 시 복원

import type { SetStateAction } from "jotai";

import type SetupScene from "../../rendering/SetupScene";

import type { GlobalCommand } from "../GlobalCommand";

export class DeleteBodyCommand implements GlobalCommand {
  readonly label = "Delete Body";

  constructor(
    private _modelId: string,
    private _bodyIndex: number,
    private _setDeletedBodies: (update: SetStateAction<Map<string, Set<number>>>) => void,
    private _setHiddenBodies: (update: SetStateAction<Map<string, Set<number>>>) => void,
    private _getScene: () => SetupScene | null,
  ) {}

  execute(): void {
    // deleted 목록에 추가
    this._setDeletedBodies((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(this._modelId) ?? []);
      set.add(this._bodyIndex);
      next.set(this._modelId, set);
      return next;
    });
    // 3D에서 숨김
    this._getScene()?.setBodyVisible(this._modelId, this._bodyIndex, false);
  }

  undo(): void {
    // deleted 목록에서 제거
    this._setDeletedBodies((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(this._modelId) ?? []);
      set.delete(this._bodyIndex);
      if (set.size === 0) next.delete(this._modelId);
      else next.set(this._modelId, set);
      return next;
    });
    // 3D에서 다시 보이기
    this._getScene()?.setBodyVisible(this._modelId, this._bodyIndex, true);
  }
}

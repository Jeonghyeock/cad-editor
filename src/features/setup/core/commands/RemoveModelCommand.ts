// STEP 모델 삭제 커맨드 (글로벌 히스토리용)

import type { SetStateAction } from "jotai";

import type SetupScene from "../../rendering/SetupScene";
import type { StepModelData } from "../../Setup.type";

import type { GlobalCommand } from "../GlobalCommand";

export class RemoveModelCommand implements GlobalCommand {
  readonly label = "Remove Model";

  // 삭제 시 보존할 가시성 상태
  private _savedHiddenBodies: Set<number> | null = null;
  private _wasModelHidden = false;

  constructor(
    private _model: StepModelData,
    private _setModels: (update: SetStateAction<StepModelData[]>) => void,
    private _getScene: () => SetupScene | null,
    private _setHiddenBodies: (update: SetStateAction<Map<string, Set<number>>>) => void,
    private _setHiddenModels: (update: SetStateAction<Set<string>>) => void,
    private _getHiddenBodies: () => Map<string, Set<number>>,
    private _getHiddenModels: () => Set<string>,
  ) {}

  execute(): void {
    const id = this._model.id;

    // 가시성 상태 스냅샷 저장
    this._savedHiddenBodies = this._getHiddenBodies().get(id) ?? null;
    this._wasModelHidden = this._getHiddenModels().has(id);

    // 가시성 상태 정리
    if (this._savedHiddenBodies) {
      this._setHiddenBodies((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
    if (this._wasModelHidden) {
      this._setHiddenModels((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }

    this._setModels((prev) => prev.filter((m) => m.id !== id));
    this._getScene()?.removeStepModel(id);
  }

  undo(): void {
    const id = this._model.id;
    this._setModels((prev) => [...prev, this._model]);
    this._getScene()?.addStepModel(this._model);

    // 가시성 상태 복원
    if (this._savedHiddenBodies) {
      const bodies = this._savedHiddenBodies;
      this._setHiddenBodies((prev) => {
        const next = new Map(prev);
        next.set(id, bodies);
        return next;
      });
      // 씬에도 바디 숨김 반영
      const s = this._getScene();
      if (s) {
        for (const bodyIndex of bodies) {
          s.setBodyVisible(id, bodyIndex, false);
        }
      }
    }
    if (this._wasModelHidden) {
      this._setHiddenModels((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      this._getScene()?.setModelVisible(id, false);
    }
  }
}

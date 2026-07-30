// STEP 모델 임포트 커맨드 (글로벌 히스토리용)

import type { SetStateAction } from "jotai";

import type SetupScene from "../../rendering/SetupScene";
import type { StepModelData } from "../../Setup.type";

import type { GlobalCommand } from "../GlobalCommand";

export class ImportModelCommand implements GlobalCommand {
  readonly label = "Import Model";

  constructor(
    private _model: StepModelData,
    private _setModels: (update: SetStateAction<StepModelData[]>) => void,
    private _getScene: () => SetupScene | null,
  ) {}

  execute(): void {
    this._setModels((prev) => [...prev, this._model]);
    this._getScene()?.addStepModel(this._model);
  }

  undo(): void {
    const id = this._model.id;
    this._setModels((prev) => prev.filter((m) => m.id !== id));
    this._getScene()?.removeStepModel(id);
  }
}

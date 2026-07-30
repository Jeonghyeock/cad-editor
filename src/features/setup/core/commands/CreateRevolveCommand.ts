// Revolve 생성 커맨드 (글로벌 히스토리)

import type { SetStateAction } from "jotai";

import type SetupScene from "../../rendering/SetupScene";
import type { OperationTreeEntry, RevolveOperation, SerializedGeometry } from "../../Setup.type";

import type { GlobalCommand } from "../GlobalCommand";

export class CreateRevolveCommand implements GlobalCommand {
  readonly label = "Create Revolve";

  constructor(
    private _operation: RevolveOperation,
    private _planeName: string,
    private _geometries: Map<string, SerializedGeometry>,
    private _setOperations: (update: SetStateAction<OperationTreeEntry[]>) => void,
    private _getScene: () => SetupScene | null,
  ) {}

  execute(): void {
    const entry: OperationTreeEntry = {
      operation: this._operation,
      sketchPlaneName: this._planeName,
    };
    this._setOperations((prev) => [...prev, entry]);

    const scene = this._getScene();
    if (scene) {
      scene.addRevolvedSolid(this._operation, this._geometries);
    }
  }

  undo(): void {
    const opId = this._operation.id;
    this._setOperations((prev) => prev.filter((e) => e.operation.id !== opId));

    const scene = this._getScene();
    if (scene) {
      scene.removeExtrudedSolid(opId);
    }
  }
}

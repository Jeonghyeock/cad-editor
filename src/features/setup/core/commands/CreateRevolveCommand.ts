// Revolve 생성 커맨드 (글로벌 히스토리)

import type { SetStateAction } from "jotai";

import type SetupScene from "../../rendering/SetupScene";
import type { OperationTreeEntry, RevolveOperation, SerializedGeometry } from "../../Setup.type";

import type { GlobalCommand } from "../GlobalCommand";

import { sceneTasksFor } from "./SceneTaskQueue";

// 솔리드 add(비동기)·remove 는 씬의 공용 큐로 차례로 실행 — 결과가 나오기 전에 undo/redo 해도 늦은 add 가 씬을
// 덮어쓰지 않게.
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
      sceneTasksFor(scene).run(this._operation.id, () =>
        scene.addRevolvedSolid(this._operation, this._geometries),
      );
    }
  }

  undo(): void {
    const opId = this._operation.id;
    this._setOperations((prev) => prev.filter((e) => e.operation.id !== opId));

    const scene = this._getScene();
    if (scene) {
      sceneTasksFor(scene).run(opId, () => scene.removeExtrudedSolid(opId));
    }
  }
}

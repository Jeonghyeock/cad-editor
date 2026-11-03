// Pad/Pocket 편집 커맨드 (기존 삭제 + 새 생성을 단일 undo 단위로)

import type { SetStateAction } from "jotai";

import type SetupScene from "../../rendering/SetupScene";
import type { OperationTreeEntry, PadPocketOperation, SerializedGeometry } from "../../Setup.type";

import type { GlobalCommand } from "../GlobalCommand";

import { sceneTasksFor } from "./SceneTaskQueue";

// 솔리드 교체는 씬의 공용 큐로 차례로 실행 — 새/이전 op 가 같은 id 라, 결과 전에 undo 하거나 생성 중인 Pad 를 편집하면
// 두 add 가 겹쳐 고아 메시가 남는다.
export class EditPadCommand implements GlobalCommand {
  readonly label: string;

  constructor(
    private _oldOperation: PadPocketOperation,
    private _newOperation: PadPocketOperation,
    private _planeName: string,
    private _geometries: Map<string, SerializedGeometry>,
    private _setOperations: (update: SetStateAction<OperationTreeEntry[]>) => void,
    private _getScene: () => SetupScene | null,
  ) {
    this.label = `Edit ${_newOperation.type === "pad" ? "Pad" : "Pocket"}`;
  }

  execute(): void {
    const oldId = this._oldOperation.id;
    const newEntry: OperationTreeEntry = {
      operation: this._newOperation,
      sketchPlaneName: this._planeName,
    };
    // 기존 operation을 새 operation으로 교체
    this._setOperations((prev) =>
      prev.map((e) => (e.operation.id === oldId ? newEntry : e)),
    );

    const scene = this._getScene();
    if (scene) {
      sceneTasksFor(scene).run(oldId, () => {
        // 기존 솔리드 제거
        scene.removeExtrudedSolid(oldId);
        if (this._oldOperation.targetOperationId) {
          scene.restoreSourceVisibility(this._oldOperation.targetOperationId);
        }
        // 새 솔리드 생성
        return scene.addExtrudedSolid(this._newOperation, this._geometries);
      });
    }
  }

  undo(): void {
    const newId = this._newOperation.id;
    const oldEntry: OperationTreeEntry = {
      operation: this._oldOperation,
      sketchPlaneName: this._planeName,
    };
    // 새 operation을 이전 operation으로 복원
    this._setOperations((prev) =>
      prev.map((e) => (e.operation.id === newId ? oldEntry : e)),
    );

    const scene = this._getScene();
    if (scene) {
      sceneTasksFor(scene).run(this._oldOperation.id, () => {
        // 새 솔리드 제거
        scene.removeExtrudedSolid(newId);
        if (this._newOperation.targetOperationId) {
          scene.restoreSourceVisibility(this._newOperation.targetOperationId);
        }
        // 이전 솔리드 복원
        return scene.addExtrudedSolid(this._oldOperation, this._geometries);
      });
    }
  }
}

// Revolve 생성 커맨드 (글로벌 히스토리)

import type { SetStateAction } from "jotai";

import type SetupScene from "../../rendering/SetupScene";
import type { OperationTreeEntry, RevolveOperation, SerializedGeometry } from "../../Setup.type";

import type { GlobalCommand } from "../GlobalCommand";

import { SceneTaskQueue } from "./SceneTaskQueue";

export class CreateRevolveCommand implements GlobalCommand {
  readonly label = "Create Revolve";
  /** 솔리드 add(비동기)·remove 를 차례로 — 결과가 나오기 전에 undo/redo 해도 늦은 add 가 씬을 덮어쓰지 않게. */
  private _sceneTasks = new SceneTaskQueue();

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

    this._sceneTasks.run(() =>
      this._getScene()?.addRevolvedSolid(this._operation, this._geometries),
    );
  }

  undo(): void {
    const opId = this._operation.id;
    this._setOperations((prev) => prev.filter((e) => e.operation.id !== opId));

    this._sceneTasks.run(() => this._getScene()?.removeExtrudedSolid(opId));
  }
}

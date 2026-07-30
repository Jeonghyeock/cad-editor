// 복수 커맨드를 단일 undo/redo 단위로 묶는 래퍼

import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

export class BatchCommand implements GeometryCommand {
  constructor(private _commands: GeometryCommand[]) {}

  isEmpty(): boolean {
    return this._commands.length === 0;
  }

  execute(store: SketchGeometryStore): void {
    for (const c of this._commands) c.execute(store);
  }

  undo(store: SketchGeometryStore): void {
    for (let i = this._commands.length - 1; i >= 0; i--) {
      this._commands[i].undo(store);
    }
  }
}

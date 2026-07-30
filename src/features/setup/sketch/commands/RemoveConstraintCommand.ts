// 구속조건 삭제 커맨드

import type { SketchConstraint } from "../constraints/SketchConstraint.type";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

export class RemoveConstraintCommand implements GeometryCommand {
  private _constraint: SketchConstraint;

  constructor(constraint: SketchConstraint) {
    this._constraint = constraint;
  }

  execute(store: SketchGeometryStore): void {
    store.constraintStore?.removeConstraint(this._constraint.id);
  }

  undo(store: SketchGeometryStore): void {
    store.constraintStore?.addConstraint(this._constraint);
  }
}

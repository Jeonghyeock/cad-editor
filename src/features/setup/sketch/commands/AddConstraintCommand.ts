// 구속조건 추가 커맨드

import type { SketchConstraint } from "../constraints/SketchConstraint.type";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

export class AddConstraintCommand implements GeometryCommand {
  private _constraint: SketchConstraint;

  constructor(constraint: SketchConstraint) {
    this._constraint = constraint;
  }

  execute(store: SketchGeometryStore): void {
    store.constraintStore?.addConstraint(this._constraint);
  }

  undo(store: SketchGeometryStore): void {
    store.constraintStore?.removeConstraint(this._constraint.id);
  }
}

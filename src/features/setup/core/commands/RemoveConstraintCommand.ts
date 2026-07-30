// 조립 구속조건 제거 커맨드 (글로벌 히스토리)

import type { SetStateAction } from "jotai";

import type { ConstraintTreeEntry } from "../../Setup.type";

import type { GlobalCommand } from "../GlobalCommand";

export class RemoveConstraintCommand implements GlobalCommand {
  readonly label = "Remove constraint";
  private _savedEntry: ConstraintTreeEntry | null = null;

  constructor(
    private _constraintId: string,
    private _setConstraints: (update: SetStateAction<ConstraintTreeEntry[]>) => void,
  ) {}

  execute(): void {
    this._setConstraints((prev) => {
      const idx = prev.findIndex((e) => e.constraint.id === this._constraintId);
      if (idx >= 0) this._savedEntry = prev[idx];
      return prev.filter((e) => e.constraint.id !== this._constraintId);
    });
  }

  undo(): void {
    if (!this._savedEntry) return;
    this._setConstraints((prev) => [...prev, this._savedEntry!]);
  }
}

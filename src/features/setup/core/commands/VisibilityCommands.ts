// Body/Model 가시성 토글 커맨드 (글로벌 히스토리용)

import type { SetStateAction } from "jotai";

import type SetupScene from "../../rendering/SetupScene";

import type { GlobalCommand } from "../GlobalCommand";

export class HideBodyCommand implements GlobalCommand {
  readonly label: string;

  constructor(
    private _modelId: string,
    private _bodyIndex: number,
    private _hide: boolean, // true=숨기기, false=보이기
    private _setHiddenBodies: (update: SetStateAction<Map<string, Set<number>>>) => void,
    private _getScene: () => SetupScene | null,
  ) {
    this.label = _hide ? "Hide Body" : "Show Body";
  }

  execute(): void {
    this._getScene()?.setBodyVisible(this._modelId, this._bodyIndex, !this._hide);
    this._updateAtom(this._hide);
  }

  undo(): void {
    this._getScene()?.setBodyVisible(this._modelId, this._bodyIndex, this._hide);
    this._updateAtom(!this._hide);
  }

  private _updateAtom(hide: boolean): void {
    this._setHiddenBodies((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(this._modelId) ?? []);
      if (hide) {
        set.add(this._bodyIndex);
      } else {
        set.delete(this._bodyIndex);
      }
      if (set.size === 0) next.delete(this._modelId);
      else next.set(this._modelId, set);
      return next;
    });
  }
}

export class HideModelCommand implements GlobalCommand {
  readonly label: string;

  constructor(
    private _modelId: string,
    private _hide: boolean,
    private _setHiddenModels: (update: SetStateAction<Set<string>>) => void,
    private _getScene: () => SetupScene | null,
  ) {
    this.label = _hide ? "Hide Model" : "Show Model";
  }

  execute(): void {
    this._getScene()?.setModelVisible(this._modelId, !this._hide);
    this._updateAtom(this._hide);
  }

  undo(): void {
    this._getScene()?.setModelVisible(this._modelId, this._hide);
    this._updateAtom(!this._hide);
  }

  private _updateAtom(hide: boolean): void {
    this._setHiddenModels((prev) => {
      const next = new Set(prev);
      if (hide) next.add(this._modelId);
      else next.delete(this._modelId);
      return next;
    });
  }
}

// 스케치 삭제 커맨드 (글로벌 히스토리용)

import type { SetStateAction } from "jotai";

import type SetupScene from "../../rendering/SetupScene";
import type { SerializedSketch, SketchTreeEntry } from "../../Setup.type";

import type { GlobalCommand } from "../GlobalCommand";

export class DeleteSketchCommand implements GlobalCommand {
  readonly label = "Delete Sketch";

  private _savedEntry: SketchTreeEntry | null = null;
  private _savedSketchData: SerializedSketch | null = null;

  constructor(
    private _planeKey: string,
    private _setSketchEntries: (update: SetStateAction<SketchTreeEntry[]>) => void,
    private _getScene: () => SetupScene | null,
  ) {}

  execute(): void {
    const s = this._getScene();
    // 삭제 전 직렬화 데이터 보존 (undo 복원용)
    if (s) {
      this._savedSketchData = s.getSavedSketchByKey(this._planeKey);
      s.deleteSavedSketch(this._planeKey);
    }
    this._setSketchEntries((prev) => {
      this._savedEntry = prev.find((e) => e.planeKey === this._planeKey) ?? null;
      return prev.filter((e) => e.planeKey !== this._planeKey);
    });
  }

  undo(): void {
    if (!this._savedEntry) return;
    const entry = this._savedEntry;
    this._setSketchEntries((prev) => [...prev, entry]);
    // 3D bake 지오메트리 + 직렬화 데이터 복원
    const s = this._getScene();
    if (s && this._savedSketchData) {
      s.restoreSavedSketch(this._planeKey, this._savedSketchData);
    }
  }
}

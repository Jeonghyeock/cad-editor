// 스케치 삭제 커맨드 (글로벌 히스토리용)

import type { SetStateAction } from "jotai";

import type SetupScene from "../../rendering/SetupScene";
import type { SerializedSketch, SketchTreeEntry } from "../../Setup.type";

import type { GlobalCommand } from "../GlobalCommand";
import type { GlobalHistoryManager } from "../GlobalHistoryManager";

export class DeleteSketchCommand implements GlobalCommand {
  readonly label = "Delete Sketch";

  private _savedEntry: SketchTreeEntry | null = null;
  private _savedSketchData: SerializedSketch | null = null;

  constructor(
    private _planeKey: string,
    private _setSketchEntries: (update: SetStateAction<SketchTreeEntry[]>) => void,
    private _getScene: () => SetupScene | null,
    // 지운 스케치의 기하 엔트리를 같은 평면에 새로 만든 스케치에 적용하지 않도록 히스토리에 알린다.
    private _history?: Pick<GlobalHistoryManager, "retireSketch" | "reviveSketch" | "isPlaneOpen">,
  ) {}

  // 이 평면에 스케치가 열려 있는 동안에는 삭제를 되돌리지도(열린 스케치 밑에서 옛 스케치·트리 엔트리를 되살려, 닫을 때
  // bake 가 덮어써 옛 스케치는 사라지고 엔트리가 둘이 된다) 다시 하지도(열린 스케치의 저장본을 지운다) 않는다 —
  // 히스토리가 그 자리에서 멈추고, 스케치를 닫으면 이어진다(스케치 경계 정책과 같음).
  canUndo(): boolean {
    return !this._history?.isPlaneOpen(this._planeKey);
  }

  canRedo(): boolean {
    return !this._history?.isPlaneOpen(this._planeKey);
  }

  execute(): void {
    this._history?.retireSketch(this._planeKey);
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
    this._history?.reviveSketch(this._planeKey);
    if (!this._savedEntry) return;
    const entry = this._savedEntry;
    // 그사이 같은 평면에 새 스케치를 만들었다 닫았으면 그 엔트리가 있다 — 평면마다 스케치는 하나(저장본도 아래에서
    // 지운 스케치로 덮어쓴다)이므로, 덧붙여 엔트리를 둘로 만들지 않고 바꿔 넣는다. 그 새 스케치의 기하 엔트리는 스택에서
    // 이 위에 있어 여기 오기 전에 모두 되돌려졌다.
    this._setSketchEntries((prev) => [...prev.filter((e) => e.planeKey !== this._planeKey), entry]);
    // 3D bake 지오메트리 + 직렬화 데이터 복원
    const s = this._getScene();
    if (s && this._savedSketchData) {
      s.restoreSavedSketch(this._planeKey, this._savedSketchData);
    }
  }
}

// 기하 프리미티브 커맨드 인터페이스 (undo/redo 패턴)

import type { SketchGeometryStore } from "../SketchGeometryStore";

export interface GeometryCommand {
  execute(store: SketchGeometryStore): void;
  undo(store: SketchGeometryStore): void;
  /** 커맨드가 아무 변경도 하지 않는 no-op인지 여부 (true면 히스토리에 push하지 않음) */
  isEmpty?(): boolean;
  /**
   * true 면 커맨드가 기하 전체의 전·후 스냅샷을 직접 들고 undo/redo 때 store 를 그 사본으로 통째로 바꾼다
   * (DragSnapshotCommand). 히스토리는 이런 커맨드에 좌표 스냅샷을 따로 만들지도 되돌리지도 않는다.
   */
  readonly ownsSnapshot?: boolean;
}

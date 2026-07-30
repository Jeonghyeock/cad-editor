// 기하 프리미티브 커맨드 인터페이스 (undo/redo 패턴)

import type { SketchGeometryStore } from "../SketchGeometryStore";

export interface GeometryCommand {
  execute(store: SketchGeometryStore): void;
  undo(store: SketchGeometryStore): void;
  /** 커맨드가 아무 변경도 하지 않는 no-op인지 여부 (true면 히스토리에 push하지 않음) */
  isEmpty?(): boolean;
}

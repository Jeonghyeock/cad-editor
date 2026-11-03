// 글로벌 히스토리 커맨드 인터페이스
// 3D 모델 작업(Import, Delete 등)에 사용

export interface GlobalCommand {
  readonly label: string;
  execute(): void;
  undo(): void;
  /**
   * false 면 지금은 undo/redo 하지 않는다 — 히스토리가 그 엔트리 앞에서 멈춘다(스케치 경계 정책과 같음).
   * 예) 참조 평면 생성의 undo 는 그 평면을 쓰는 스케치·연산이 있으면 막는다. 없으면 언제나 가능.
   */
  canUndo?(): boolean;
  canRedo?(): boolean;
  /**
   * true 면 지금 열린 스케치의 기하 store 를 직접 바꾸는 커맨드다 (DeleteShapeCommand). 히스토리는 기하 엔트리처럼
   * 실행한 스케치를 기록해 그 스케치가 열려 있을 때만 undo/redo 한다.
   */
  readonly sketchScoped?: boolean;
}

// 글로벌 히스토리 커맨드 인터페이스
// 3D 모델 작업(Import, Delete 등)에 사용

export interface GlobalCommand {
  readonly label: string;
  execute(): void;
  undo(): void;
}

// 커맨드 하나의 씬 작업(솔리드 add/remove)을 차례로 실행하는 큐 (Pad/Pocket/Revolve 커맨드 공용)
//
// addExtrudedSolid / addRevolvedSolid 는 native 애드온 IPC 등을 기다린 뒤에야 메시를 씬에 넣는다. 그 사이에 undo/redo
// 가 오면 늦게 끝난 add 가 undo 이후 상태 위에 메시를 넣어 지울 수 없는 유령 솔리드가 남고, 같은 op id 의 add 둘이
// 겹치면 먼저 넣은 메시가 고아가 된다. 그래서 앞 작업이 끝나기 전에 들어온 작업은 앞 작업이 끝난 뒤에 실행하고,
// 그사이 더 새 작업이 들어왔으면 건너뛴다 — 각 작업은 'undo/redo 후 씬을 이 상태로 맞춘다'는 뜻이라 마지막 것만
// 실행하면 된다. 진행 중인 작업이 없으면 지금 바로(동기로) 실행해 기존 타이밍을 지킨다.

export class SceneTaskQueue {
  private _tail: Promise<void> | null = null;
  private _latest = 0;

  run(task: () => void | Promise<void>): void {
    const ticket = ++this._latest;
    const result = this._tail
      ? this._tail.then(() => (ticket === this._latest ? task() : undefined))
      : task();
    if (!result) return;
    const tail: Promise<void> = result
      .catch((e) => console.error("[SceneTaskQueue] 솔리드 작업 실패:", e))
      .then(() => {
        if (this._tail === tail) this._tail = null;
      });
    this._tail = tail;
  }
}

// 씬 하나의 솔리드 작업(add/remove)을 차례로 실행하는 큐 (Pad/Pocket/Revolve 커맨드 공용)
//
// addExtrudedSolid / addRevolvedSolid 는 native 애드온 IPC 등을 기다린 뒤에야 메시를 씬에 넣는다. 그 사이에 undo/redo
// 나 같은 op 를 다루는 다른 명령(생성 중인 Pad 의 삭제·편집)이 오면 늦게 끝난 add 가 그 뒤 상태 위에 메시를 넣어 지울 수
// 없는 유령 솔리드가 남고, 같은 op id 의 add 둘이 겹치면 먼저 넣은 메시가 고아가 된다. 그래서 씬마다 큐 하나를 두고
// (명령마다 두면 서로 다른 명령끼리는 순서가 지켜지지 않는다) 앞 작업이 끝나기 전에 들어온 작업은 앞 작업이 끝난 뒤에
// 실행한다. 같은 op id 의 더 새 작업이 그사이 들어왔으면 그 작업은 건너뛴다 — 각 작업은 '이 op 의 솔리드를 이 상태로
// 맞춘다'는 뜻이라 op 마다 마지막 것만 실행하면 된다. 다른 op 의 작업은 건너뛰지 않는다(Pocket 의 대상 솔리드처럼
// 앞 op 가 먼저 있어야 하는 경우가 있다). 진행 중인 작업이 없으면 지금 바로(동기로) 실행해 평소 타이밍을 지킨다.

export class SceneTaskQueue {
  private _tail: Promise<void> | null = null;
  private _seq = 0;
  // op id → 그 op 에 가장 나중에 들어온 작업 번호
  private _latest = new Map<string, number>();

  run(opId: string, task: () => void | Promise<void>): void {
    const ticket = ++this._seq;
    this._latest.set(opId, ticket);
    const guarded = () => (this._latest.get(opId) === ticket ? task() : undefined);
    const done = () => {
      if (this._latest.get(opId) === ticket) this._latest.delete(opId);
    };
    const result = this._tail ? this._tail.then(guarded) : guarded();
    if (!result) {
      done();
      return;
    }
    const tail: Promise<void> = result
      .catch((e) => console.error("[SceneTaskQueue] 솔리드 작업 실패:", e))
      .then(() => {
        done();
        if (this._tail === tail) this._tail = null;
      });
    this._tail = tail;
  }
}

const queues = new WeakMap<object, SceneTaskQueue>();

/** 씬마다 하나인 큐 — 같은 씬의 솔리드를 다루는 명령들이 함께 쓴다. */
export function sceneTasksFor(scene: object): SceneTaskQueue {
  let queue = queues.get(scene);
  if (!queue) {
    queue = new SceneTaskQueue();
    queues.set(scene, queue);
  }
  return queue;
}

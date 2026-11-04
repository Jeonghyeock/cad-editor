import "./support/browserStubs";

import assert from "node:assert/strict";
import { test } from "node:test";

import { CreatePadCommand } from "src/features/setup/core/commands/CreatePadCommand";
import { CreateRevolveCommand } from "src/features/setup/core/commands/CreateRevolveCommand";
import { DeletePadCommand } from "src/features/setup/core/commands/DeletePadCommand";
import { EditPadCommand } from "src/features/setup/core/commands/EditPadCommand";
import type SetupScene from "src/features/setup/rendering/SetupScene";
import type { OperationTreeEntry, PadPocketOperation, RevolveOperation, SolidOperation } from "src/features/setup/Setup.type";

// 2026-10-28 코드리뷰 cad-editor#48 — Pad/Pocket 명령이 비동기 addExtrudedSolid 를 기다리지 않아, 결과가 나오기 전에
// undo 하면 늦게 끝난 add 가 씬에 유령 솔리드를 남겼다(native 애드온 IPC 를 기다리는 사이).

// SolidOperationManager 의 씬 동작을 흉내 낸다: add 는 먼저 같은 id 를 지우고, (IPC 를 기다린 뒤) 메시를 넣고 대상
// 솔리드를 숨긴다. 메시를 넣을 때 같은 id 의 이전 메시를 지우지 않으므로, add 둘이 겹치면 앞 메시가 씬에 고아로 남는다.
class FakeScene {
  meshes = new Set<string>(); // 씬에 붙은 메시
  private _byOp = new Map<string, string>(); // _extrudedSolids
  hiddenSources = new Set<string>();
  private _pending: (() => void)[] = [];
  private _n = 0;

  addExtrudedSolid(op: PadPocketOperation | RevolveOperation): Promise<void> {
    this.removeExtrudedSolid(op.id);
    return new Promise((resolve) => {
      this._pending.push(() => {
        const mesh = `${op.id}#${++this._n}:${"depth" in op ? op.depth : op.angle}`;
        this.meshes.add(mesh);
        this._byOp.set(op.id, mesh);
        if ("targetOperationId" in op && op.targetOperationId) this.hiddenSources.add(op.targetOperationId);
        resolve();
      });
    });
  }
  addRevolvedSolid(op: RevolveOperation): Promise<void> {
    return this.addExtrudedSolid(op);
  }
  removeExtrudedSolid(id: string): void {
    const mesh = this._byOp.get(id);
    if (mesh) this.meshes.delete(mesh);
    this._byOp.delete(id);
  }
  restoreSourceVisibility(id: string): void {
    this.hiddenSources.delete(id);
  }
  /** 기다리던 add 를 차례로 끝낸다(IPC 응답 도착) */
  async finishAll(): Promise<void> {
    await settle();
    while (this._pending.length > 0) {
      this._pending.shift()!();
      await settle();
    }
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

const pocket: PadPocketOperation = {
  id: "op2",
  type: "pocket",
  sketchPlaneKey: "XY",
  profileIds: [],
  depth: 10,
  direction: "normal",
  targetOperationId: "op1",
};

function setup() {
  const scene = new FakeScene();
  let operations: OperationTreeEntry[] = [];
  let hidden = new Set<string>();
  const deps = {
    setOperations: (u: OperationTreeEntry[] | ((p: OperationTreeEntry[]) => OperationTreeEntry[])) => {
      operations = typeof u === "function" ? u(operations) : u;
    },
    getScene: () => scene as unknown as SetupScene,
    setHidden: (u: Set<string> | ((p: Set<string>) => Set<string>)) => {
      hidden = typeof u === "function" ? u(hidden) : u;
    },
    getHidden: () => hidden,
    ops: () => operations.map((e) => e.operation as SolidOperation),
  };
  return { scene, deps };
}

test("Pocket 생성 직후, 결과가 나오기 전에 undo 하면 솔리드가 남지 않고 대상도 다시 보인다", async () => {
  const { scene, deps } = setup();
  const cmd = new CreatePadCommand(pocket, "Sketch 1", new Map(), deps.setOperations, deps.getScene, deps.setHidden, deps.getHidden);
  cmd.execute();
  cmd.undo();
  await scene.finishAll();

  assert.deepEqual(deps.ops(), []);
  // 고치기 전에는 늦게 끝난 add 가 메시를 넣고 대상 솔리드(op1)를 숨긴 채로 남겼다
  assert.deepEqual([...scene.meshes], []);
  assert.deepEqual([...scene.hiddenSources], []);
});

test("Pad 생성 → undo → redo 를 결과 전에 하면 메시가 하나만 남는다", async () => {
  const { scene, deps } = setup();
  const cmd = new CreatePadCommand(pocket, "Sketch 1", new Map(), deps.setOperations, deps.getScene, deps.setHidden, deps.getHidden);
  cmd.execute();
  cmd.undo();
  cmd.execute();
  await scene.finishAll();

  assert.equal(deps.ops().length, 1);
  assert.equal(scene.meshes.size, 1);
  assert.deepEqual([...scene.hiddenSources], ["op1"]);
});

test("Pad 편집 직후 undo 하면 이전 깊이의 메시 하나만 남는다", async () => {
  const { scene, deps } = setup();
  const pad: PadPocketOperation = { ...pocket, type: "pad", targetOperationId: undefined };
  new CreatePadCommand(pad, "Sketch 1", new Map(), deps.setOperations, deps.getScene, deps.setHidden, deps.getHidden).execute();
  await scene.finishAll();

  // 편집은 같은 id 로 깊이만 바꾼다(setup/index.tsx)
  const edit = new EditPadCommand(pad, { ...pad, depth: 30 }, "Sketch 1", new Map(), deps.setOperations, deps.getScene);
  edit.execute();
  edit.undo();
  await scene.finishAll();

  assert.equal((deps.ops()[0] as PadPocketOperation).depth, 10);
  // 고치기 전에는 편집 결과(30) 메시가 지울 수 없는 고아로 남았다
  assert.deepEqual([...scene.meshes].map((m) => m.split(":")[1]), ["10"]);
});

test("Pad 삭제를 undo 하고 결과 전에 redo 하면 솔리드가 남지 않는다", async () => {
  const { scene, deps } = setup();
  const pad: PadPocketOperation = { ...pocket, type: "pad", targetOperationId: undefined };
  new CreatePadCommand(pad, "Sketch 1", new Map(), deps.setOperations, deps.getScene, deps.setHidden, deps.getHidden).execute();
  await scene.finishAll();

  const del = new DeletePadCommand(pad.id, deps.setOperations, deps.getScene, new Map(), deps.setHidden, deps.getHidden);
  del.execute();
  del.undo();
  del.execute();
  await scene.finishAll();

  assert.deepEqual(deps.ops(), []);
  assert.deepEqual([...scene.meshes], []);
});

test("Revolve 생성 직후, 결과가 나오기 전에 undo 하면 솔리드가 남지 않는다", async () => {
  const { scene, deps } = setup();
  const revolve: RevolveOperation = {
    id: "rev1",
    type: "revolve",
    sketchPlaneKey: "XY",
    profileIds: [],
    angle: 360,
    axisType: "x",
  };
  const cmd = new CreateRevolveCommand(revolve, "Sketch 1", new Map(), deps.setOperations, deps.getScene);
  cmd.execute();
  cmd.undo();
  await scene.finishAll();

  assert.deepEqual(deps.ops(), []);
  assert.deepEqual([...scene.meshes], []);
});

// 같은 op id 를 다루는 서로 다른 명령끼리도 순서를 지킨다(리뷰 반영) — 명령마다 큐를 따로 두면 생성 중인 Pad 를 바로
// 지우거나 편집할 때 앞 명령의 늦은 add 가 뒤 명령의 결과를 덮어썼다.

test("생성 add 가 끝나기 전에 그 Pad 를 지우면, add 가 끝나도 메시가 남지 않는다", async () => {
  const { scene, deps } = setup();
  const pad: PadPocketOperation = { ...pocket, type: "pad", targetOperationId: undefined };
  new CreatePadCommand(pad, "Sketch 1", new Map(), deps.setOperations, deps.getScene, deps.setHidden, deps.getHidden).execute();
  new DeletePadCommand(pad.id, deps.setOperations, deps.getScene, new Map(), deps.setHidden, deps.getHidden).execute();
  await scene.finishAll();

  assert.deepEqual(deps.ops(), []);
  assert.deepEqual([...scene.meshes], []);
});

test("생성 add 가 끝나기 전에 그 Pad 를 편집하면 편집 결과 메시 하나만 남는다", async () => {
  const { scene, deps } = setup();
  const pad: PadPocketOperation = { ...pocket, type: "pad", targetOperationId: undefined };
  new CreatePadCommand(pad, "Sketch 1", new Map(), deps.setOperations, deps.getScene, deps.setHidden, deps.getHidden).execute();
  new EditPadCommand(pad, { ...pad, depth: 30 }, "Sketch 1", new Map(), deps.setOperations, deps.getScene).execute();
  await scene.finishAll();

  assert.deepEqual([...scene.meshes].map((m) => m.split(":")[1]), ["30"]);
});

test("서로 다른 Pad 둘을 결과 전에 잇달아 만들면 둘 다 남는다", async () => {
  const { scene, deps } = setup();
  const pad1: PadPocketOperation = { ...pocket, id: "p1", type: "pad", targetOperationId: undefined };
  const pad2: PadPocketOperation = { ...pad1, id: "p2" };
  new CreatePadCommand(pad1, "Sketch 1", new Map(), deps.setOperations, deps.getScene, deps.setHidden, deps.getHidden).execute();
  new CreatePadCommand(pad2, "Sketch 1", new Map(), deps.setOperations, deps.getScene, deps.setHidden, deps.getHidden).execute();
  await scene.finishAll();

  assert.deepEqual([...scene.meshes].map((m) => m.split("#")[0]).sort(), ["p1", "p2"]);
});

// 리뷰 반영(2차) — 스케치를 닫을 때 도는 rebuildOperationsForSketch 가 씬 공유 큐를 거치지 않고 add 를 기다리지 않아,
// 같은 op 의 add 가 명령의 add 와 겹쳐 고아 메시가 남았다.

test("Pad 생성 add 가 끝나기 전에 스케치를 닫아 rebuild 가 돌아도 메시가 하나만 남는다", async () => {
  // SetupScene 은 불러올 때 native IPC 모듈이 window.electron 을 읽는다 — 빈 window 로 대신한다
  (globalThis as Record<string, unknown>).window ??= {};
  const { default: RealSetupScene } = await import("src/features/setup/rendering/SetupScene");
  const { scene, deps } = setup();
  const pad: PadPocketOperation = { ...pocket, type: "pad", targetOperationId: undefined };
  // SolidOperationManager.rebuildOperationsForSketch 처럼 스케치의 op 마다 add 를 다시 부른다
  Object.assign(scene, {
    _solidOperationManager: {
      rebuildOperationsForSketch: (_key: string, ops: OperationTreeEntry[]) =>
        Promise.all(ops.map((e) => scene.addExtrudedSolid(e.operation as PadPocketOperation))).then(() => {}),
    },
  });

  new CreatePadCommand(pad, "Sketch 1", new Map(), deps.setOperations, deps.getScene, deps.setHidden, deps.getHidden).execute();
  RealSetupScene.prototype.rebuildOperationsForSketch.call(scene, "XY", [{ operation: pad, sketchPlaneName: "Sketch 1" }]);
  await scene.finishAll();

  assert.equal(scene.meshes.size, 1);
});

import * as jotai from "jotai";
import * as React from "react";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { FileChannels } from "src/app/channels/fileChannels";
import type FileIpcUtil from "src/app/ipc/fileIpcUtil";

import type { ReferencePlane } from "src/features/setup/Setup.type";

import type * as FileStore from "src/shared/stores/File.store";
import type { GlobalData } from "src/shared/types/File.type";

// useFileActions 를 React 없이 부르고(closeWindow.test 와 같은 방식), main 쪽은 실제 fileIpcUtil 이 디스크에 쓰고 읽는다.
// 이 프로젝트는 CommonJS 로 컴파일되므로 require 캐시에 대신할 모듈을 넣어 둔다.
const store = jotai.createStore();
const stub = (specifier: string, exports: object) => {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
};
stub("react", { ...React, useCallback: (fn: unknown) => fn });
stub("react-router-dom", { useNavigate: () => () => {} });
stub("jotai", { ...jotai, useStore: () => store });
// 스케치 상태 store 는 아이콘(svg) 까지 불러와 node 에서 읽을 수 없다. 저장 직전 flush 만 쓰므로 빈 atom 으로 둔다.
stub("src/features/setup/Setup.store", { setupFlushSyncAtom: jotai.atom(null) });
// Save As 대화상자가 고른 경로는 테스트가 정하고, 닫기 확인창에서는 Save 를 누른다
let saveDialogPath = "";
stub("electron", {
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: saveDialogPath }),
    showMessageBox: async () => ({ response: 0 }),
  },
});

// 저장 IPC 가 파일을 쓴 뒤 renderer 에 답하기 전에 부른다 — 그사이 사용자가 한 편집
let duringSave: (() => void) | null = null;
let main: typeof FileIpcUtil;
(globalThis as Record<string, unknown>).electron = {
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      switch (channel) {
        case FileChannels.GET_FILE_ID:
          return main.getFileId();
        case FileChannels.SET_FILE_ID:
          return main.setFileId(args[0] as string);
        case FileChannels.GET_OPEN_FILE_LIST:
          return main.getOpenFileList();
        case FileChannels.OPEN_FILE:
          return main.openFile(args[0] as boolean, args[1] as string);
        case FileChannels.SAVE_FILE:
        case FileChannels.SAVE_AS_FILE: {
          const res =
            channel === FileChannels.SAVE_FILE
              ? await main.saveFile(args[0] as string, args[1] as never)
              : await main.saveAsFile(args[0] as string, args[1] as never);
          duringSave?.();
          return res;
        }
        case FileChannels.CLOSE_FILE:
          return main.closeFile({} as never, args[0] as string, args[1] as never, args[2] as boolean);
        default:
          return undefined;
      }
    },
  },
};

const tempDirs: string[] = [];
afterEach(() => {
  duringSave = null;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

let fileStore: typeof FileStore;

// fileId 의 .cad 를 새 main(빈 열린 목록)으로 연다. store 는 테스트끼리 같이 쓰므로 fileId 를 테스트마다 다르게 준다.
async function openFile(fileId: string) {
  delete require.cache[require.resolve("src/app/ipc/fileIpcUtil")];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  main = require("src/app/ipc/fileIpcUtil").default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-save-"));
  tempDirs.push(dir);
  const file = path.join(dir, `${fileId}.cad`);
  fs.writeFileSync(file, JSON.stringify({ fileId, unit: "MMGS", lastURL: "/input", setup: {} }), "utf-8");

  fileStore = await import("src/shared/stores/File.store");
  const { useFileActions } = await import("src/shared/hooks/useFileActions");
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React 없이 훅이 만든 콜백만 부른다
  const actions = useFileActions();
  assert.equal(await actions.openFileAction(file), true);
  return { actions, dir, file };
}

const plane = (id: string): ReferencePlane => ({
  id,
  name: id,
  plane: {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    u: { x: 1, y: 0, z: 0 },
    v: { x: 0, y: 1, z: 0 },
  },
  creationMethod: "offset",
  sourceDescription: "",
});

// 지금 활성 파일에 참조 평면 하나를 더한다
const addPlane = (id: string) =>
  store.set(fileStore.globalDataAtom, (prev: GlobalData) => ({
    ...prev,
    setup: { ...prev.setup, referencePlanes: [...prev.setup.referencePlanes, plane(id)] },
  }));

const planesInMemory = (fileId: string) =>
  store.get(fileStore.fileDataAtomFamily(fileId)).globalData.setup.referencePlanes.map((p) => p.id);

const planesOnDisk = (file: string): string[] =>
  JSON.parse(fs.readFileSync(file, "utf-8")).setup.referencePlanes.map((p: ReferencePlane) => p.id);

const isModified = (fileId: string) => store.get(fileStore.isModifiedAtomFamily(fileId));

test("저장하는 동안 한 편집은 저장 뒤에도 '수정됨'으로 남아, 탭을 닫을 때 확인창이 뜬다", async () => {
  // 고치기 전에는 저장이 끝난 시점의 globalData 로 originData 를 맞춰, 디스크에 없는 편집 2 까지 clean 이 됐다.
  // 그 탭을 닫으면 확인창 없이 닫히고, main 은 수정 없는 탭을 쓰지 않아 편집 2 가 사라졌다
  const { actions, file } = await openFile("save-race");
  addPlane("P1"); // 편집 1 — 저장 전
  duringSave = () => addPlane("P2"); // 편집 2 — 저장이 끝나기 전
  await actions.saveFileAction();

  assert.deepEqual(planesInMemory("save-race"), ["P1", "P2"]);
  assert.deepEqual(planesOnDisk(file), ["P1"]);
  assert.equal(isModified("save-race"), true);

  // 확인창에서 Save — 편집 2 까지 디스크에 남는다
  assert.equal(await actions.closeFileAction("save-race"), true);
  assert.deepEqual(planesOnDisk(file), ["P1", "P2"]);
});

test("Save As 하는 동안 한 편집은 새 파일 탭에 남고 '수정됨'으로 표시된다", async () => {
  // 고치기 전에는 Save As 뒤 디스크에서 새 파일을 다시 읽어 globalData 를 만들어, 그사이 편집이 바로 사라졌다
  const { actions, dir } = await openFile("save-as-race");
  saveDialogPath = path.join(dir, "copy.cad");
  addPlane("P1");
  duringSave = () => addPlane("P2");
  await actions.saveAsFileAction();

  const newFileId = store.get(fileStore.fileIdAtom);
  assert.notEqual(newFileId, "save-as-race");
  assert.equal(newFileId, main.getFileId());
  assert.deepEqual(
    store.get(fileStore.openFileListAtom).map((f) => f.fileId),
    [newFileId],
  );
  assert.deepEqual(planesInMemory(newFileId), ["P1", "P2"]);
  assert.deepEqual(planesOnDisk(saveDialogPath), ["P1"]);
  assert.equal(isModified(newFileId), true);
});

test("Save As 가 끝나자마자 다른 탭을 눌러도 그 탭의 데이터를 Save As 한 파일 데이터로 덮지 않는다", async () => {
  // 고치기 전에는 Save As 뒤 새 fileId 를 GET_FILE_ID 로 따로 물었다. main 이 새 id 를 활성으로 둔 뒤 그 질문보다
  // 탭 클릭(SET_FILE_ID)이 먼저 닿으면 그 탭의 id 가 돌아와, 그 탭의 미저장 편집이 Save As 한 파일 내용으로 바뀌었다
  const { actions, dir } = await openFile("tab-b");
  addPlane("B-unsaved"); // B 탭의 저장 안 한 편집
  const fileA = path.join(dir, "tab-a.cad");
  fs.writeFileSync(fileA, JSON.stringify({ fileId: "tab-a", unit: "MMGS", lastURL: "/input", setup: {} }), "utf-8");
  assert.equal(await actions.openFileAction(fileA), true);
  addPlane("A1");

  saveDialogPath = path.join(dir, "copy.cad");
  let clickB: Promise<void> | undefined;
  duringSave = () => {
    clickB = actions.activateFileAction("tab-b"); // main 이 Save As 를 마친 뒤 renderer 가 답을 받기 전에 탭 B 클릭
  };
  await actions.saveAsFileAction();
  await clickB;

  const newFileId = main.getOpenFileList().find((f) => f.path === saveDialogPath)!.fileId;
  assert.notEqual(newFileId, "tab-b");
  assert.deepEqual(planesInMemory("tab-b"), ["B-unsaved"]);
  assert.deepEqual(planesInMemory(newFileId), ["A1"]);
  assert.equal(store.get(fileStore.fileIdAtom), "tab-b");
});

test("저장·Save As 하는 동안 편집이 없으면 저장 뒤 '수정 없음'이다", async () => {
  const { actions, dir, file } = await openFile("save-clean");
  addPlane("P1");
  assert.equal(isModified("save-clean"), true);
  await actions.saveFileAction();
  assert.deepEqual(planesOnDisk(file), ["P1"]);
  assert.equal(isModified("save-clean"), false);

  addPlane("P2");
  saveDialogPath = path.join(dir, "copy.cad");
  await actions.saveAsFileAction();
  const newFileId = store.get(fileStore.fileIdAtom);
  assert.deepEqual(planesInMemory(newFileId), ["P1", "P2"]);
  assert.deepEqual(planesOnDisk(saveDialogPath), ["P1", "P2"]);
  assert.equal(isModified(newFileId), false);
});

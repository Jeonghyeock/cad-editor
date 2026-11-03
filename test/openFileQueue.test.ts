import * as jotai from "jotai";
import * as React from "react";

import assert from "node:assert/strict";
import { test } from "node:test";

import { FileChannels } from "src/app/channels/fileChannels";

// useFileActions 를 React 없이 부른다(closeWindow.test 와 같은 방식). 이 프로젝트는 CommonJS 로 컴파일되므로
// require 캐시에 대신할 모듈을 넣어 둔다. useCallback 은 함수를 그대로 돌려주고, store 는 테스트가 만든 것을 쓴다.
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

// main 프로세스 대신 디스크의 파일, 열린 목록, 활성 fileId 를 흉내 낸다. 실제 IPC 처럼 매번 조금 늦게 답해,
// 기다리지 않고 연달아 부른 두 열기가 겹치게 한다.
const disk: Record<string, { fileId: string; unit: string }> = {
  "a.cad": { fileId: "a", unit: "MKS" },
  "b.cad": { fileId: "b", unit: "CGS" },
};
const main = { fileId: "", list: [] as { fileId: string; fileName: string; path: string }[] };
const invoked: string[] = [];
let failOpenOnce = false;
(globalThis as Record<string, unknown>).electron = {
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      invoked.push(channel === FileChannels.OPEN_FILE ? `${channel}:${args[1]}` : channel);
      if (channel === FileChannels.OPEN_FILE) {
        if (failOpenOnce) {
          failOpenOnce = false;
          throw new Error("IPC failed");
        }
        const filePath = args[1] as string;
        main.list.push({ fileId: disk[filePath].fileId, fileName: filePath, path: filePath });
        main.fileId = disk[filePath].fileId;
        return true;
      }
      if (channel === FileChannels.GET_OPEN_FILE_LIST) {
        return main.list.map((file) => ({ ...file, mtime: null, fileContent: { ...disk[file.path] } }));
      }
      if (channel === FileChannels.GET_FILE_ID) return main.fileId;
      return undefined;
    },
  },
};

async function setup() {
  const { useFileActions } = await import("src/shared/hooks/useFileActions");
  main.fileId = "";
  main.list = [];
  invoked.length = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React 없이 훅이 만든 콜백만 부른다
  return useFileActions();
}

test("연달아 부른 파일 열기는 앞 열기가 끝난 뒤 다음 열기를 시작해, 두 탭 모두 제 내용으로 채운다", async () => {
  // 고치기 전에는 두 열기가 겹쳐, 앞 열기가 내용을 채울 때 main 의 fileId 가 이미 b 로 바뀌어 있었다.
  // a 탭은 빈 기본 문서로 남고, 그 탭에서 저장하면 a.cad 를 빈 내용으로 덮어썼다.
  const { fileDataAtomFamily } = await import("src/shared/stores/File.store");
  const actions = await setup();

  // 콜드 스타트에 main 이 경로 둘을 연달아 보낸 것처럼, 기다리지 않고 부른다(AppContainer 의 리스너와 같다)
  const opened = [actions.openFileAction("a.cad"), actions.openFileAction("b.cad")];
  assert.deepEqual(await Promise.all(opened), [true, true]);

  assert.equal(store.get(fileDataAtomFamily("a")).globalData.unit, "MKS");
  assert.equal(store.get(fileDataAtomFamily("b")).globalData.unit, "CGS");
  // b 의 열기는 a 의 열기가 활성 fileId 까지 받아 간 뒤에 시작한다
  assert.deepEqual(invoked, [
    `${FileChannels.OPEN_FILE}:a.cad`,
    FileChannels.GET_OPEN_FILE_LIST,
    FileChannels.GET_FILE_ID,
    `${FileChannels.OPEN_FILE}:b.cad`,
    FileChannels.GET_OPEN_FILE_LIST,
    FileChannels.GET_FILE_ID,
  ]);
});

test("앞 열기가 실패해도 다음 열기는 한다", async () => {
  const { fileDataAtomFamily } = await import("src/shared/stores/File.store");
  const actions = await setup();
  failOpenOnce = true;

  const first = actions.openFileAction("a.cad");
  const second = actions.openFileAction("b.cad");
  await assert.rejects(first);
  assert.equal(await second, true);
  assert.equal(store.get(fileDataAtomFamily("b")).globalData.unit, "CGS");
});

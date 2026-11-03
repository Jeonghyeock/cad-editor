import * as jotai from "jotai";
import * as React from "react";

import assert from "node:assert/strict";
import { test } from "node:test";

import { FileChannels } from "src/app/channels/fileChannels";
import { MenuChannels } from "src/app/channels/menuChannels";

// useFileActions 를 React 없이 부른다. 이 프로젝트는 CommonJS 로 컴파일되므로 require 캐시에 대신할 모듈을 넣어 둔다.
// useCallback 은 함수를 그대로 돌려주고, store 는 테스트가 만든 것을 쓴다.
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

// main 프로세스 대신 응답한다. 닫기 확인창의 답(CLOSE_FILE 결과)을 테스트마다 정한다.
const invoked: string[] = [];
let closeFileResult = true;
(globalThis as Record<string, unknown>).electron = {
  ipcRenderer: {
    invoke: async (channel: string) => {
      invoked.push(channel);
      if (channel === FileChannels.CLOSE_FILE) return closeFileResult;
      if (channel === FileChannels.GET_OPEN_FILE_LIST) return [];
      return undefined;
    },
  },
};

async function setup(fileIds = ["a"]) {
  const { fileDataAtomFamily, openFileListAtom } = await import("src/shared/stores/File.store");
  const { createFileData } = await import("src/shared/utils/FileUtils");
  const { useFileActions } = await import("src/shared/hooks/useFileActions");

  // 수정된(저장하지 않은) 파일들이 열려 있다
  for (const fileId of fileIds) {
    const data = createFileData(fileId, { fileId, unit: "MMGS", lastURL: null, setup: {} });
    data.globalData = { ...data.globalData, unit: "MKS" };
    store.set(fileDataAtomFamily(fileId), data);
  }
  store.set(
    openFileListAtom,
    fileIds.map((fileId) => ({ fileId, fileName: fileId, path: `${fileId}.cad` })) as never,
  );
  invoked.length = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React 없이 훅이 만든 콜백만 부른다
  return useFileActions();
}

test("닫기 확인창에서 Cancel 하면 창을 닫지 않는다", async () => {
  // 고치기 전에는 closeFileAction 의 결과를 버리고 finally 에서 언제나 WINDOW_CLOSE 를 보내, 미저장 변경이 사라졌다
  const actions = await setup();
  closeFileResult = false;
  await actions.closeWindowAction();
  assert.ok(invoked.includes(FileChannels.CLOSE_FILE));
  assert.ok(!invoked.includes(MenuChannels.WINDOW_CLOSE));
});

test("미저장 파일 둘 중 먼저 묻는 쪽에서 Cancel 하면 나머지는 묻지 않고 창도 닫지 않는다", async () => {
  const actions = await setup(["a", "b"]);
  closeFileResult = false;
  await actions.closeWindowAction();
  assert.equal(invoked.filter((channel) => channel === FileChannels.CLOSE_FILE).length, 1);
  assert.ok(!invoked.includes(MenuChannels.WINDOW_CLOSE));
});

test("미저장 파일을 모두 닫으면 창을 닫는다", async () => {
  const actions = await setup();
  closeFileResult = true;
  await actions.closeWindowAction();
  assert.ok(invoked.includes(MenuChannels.WINDOW_CLOSE));
});

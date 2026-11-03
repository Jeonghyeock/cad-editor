import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { test } from "node:test";

import { FileChannels } from "src/app/channels/fileChannels";
import { MenuChannels } from "src/app/channels/menuChannels";

// main.ts 를 Electron 없이 불러, .cad 를 여는 이벤트(open-file·second-instance) 처리만 확인한다.
// 이 프로젝트는 CommonJS 로 컴파일되므로 require 캐시에 가짜 electron·창 만들기·개발 도구 설치를 넣어 둔다.
//
// ‼ whenReady 의 .cad 연결 등록(reg add)은 isPackaged 가 false 면 돌지 않는다. 혹시라도 닿으면 이 PC 의
// 레지스트리를 건드리지 않도록 spawnSync 를 막아 둔다(main.ts 는 부를 때마다 모듈의 spawnSync 를 읽는다).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess = require("node:child_process");
childProcess.spawnSync = () => {
  throw new Error("테스트에서는 spawnSync 를 막아 둔다");
};

const stub = (specifier: string, exports: unknown) => {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
};

// 실제 BrowserWindow 처럼 파괴된 창의 메서드는 throw 하고, 이벤트는 한 번 지나가면 다시 오지 않는다
const createFakeWindow = () => {
  const webContents = Object.assign(new EventEmitter(), {
    loading: true,
    sent: [] as unknown[][],
    isLoading: () => webContents.loading,
    send: (...args: unknown[]) => webContents.sent.push(args),
  });
  let destroyed = false;
  const alive = () => {
    if (destroyed) throw new TypeError("Object has been destroyed");
  };
  return {
    webContents,
    isDestroyed: () => destroyed,
    isMinimized: () => {
      alive();
      return false;
    },
    restore: alive,
    focus: alive,
    destroy: () => {
      destroyed = true;
    },
    finishLoad: () => {
      webContents.loading = false;
      webContents.emit("did-finish-load");
    },
  };
};

const windows: ReturnType<typeof createFakeWindow>[] = [];
const electron = {
  app: null as unknown,
  BrowserWindow: { getAllWindows: () => windows.filter((win) => !win.isDestroyed()) },
};
stub("electron", electron);
stub("electron-squirrel-startup", false);
stub("src/app/electrons/appWindow", {
  createAppWindow: () => {
    const win = createFakeWindow();
    windows.push(win);
    return win;
  },
});
stub("src/app/electrons/devTools", { installReactDevTools: async () => "stub" });

// main.ts 는 불러올 때 app 에 이벤트를 단다. 테스트마다 새 app 으로 다시 불러온다.
function loadMain() {
  let markReady = () => {};
  const readyPromise = new Promise<void>((resolve) => (markReady = resolve));
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    ready: false,
    isReady: () => app.ready,
    whenReady: () => readyPromise,
    requestSingleInstanceLock: () => true,
    quit: () => {},
  });
  electron.app = app;
  windows.length = 0;

  delete require.cache[require.resolve("src/app/electrons/main")];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("src/app/electrons/main");

  const becomeReady = async () => {
    app.ready = true;
    app.emit("ready");
    markReady();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { app, becomeReady };
}

const openFileEvent = { preventDefault: () => {} };
const openedPaths = (win: ReturnType<typeof createFakeWindow>) =>
  win.webContents.sent
    .filter(([channel, action]) => channel === MenuChannels.MENU_EVENT && action === FileChannels.OPEN_FILE)
    .map(([, , filePath]) => filePath);

test("콜드 스타트에 창보다 먼저 받은 .cad 들은 창 로드가 끝난 뒤 한 번씩만 보낸다", async () => {
  const { app, becomeReady } = loadMain();
  app.emit("open-file", openFileEvent, "/docs/a.cad");
  app.emit("open-file", openFileEvent, "/docs/b.cad");

  await becomeReady();
  assert.equal(windows.length, 1);
  assert.deepEqual(openedPaths(windows[0]), []);

  windows[0].finishLoad();
  windows[0].finishLoad();
  assert.deepEqual(openedPaths(windows[0]), ["/docs/a.cad", "/docs/b.cad"]);
});

test("실행 중에 받은 open-file 은 그 창에 바로 한 번 보낸다", async () => {
  const { app, becomeReady } = loadMain();
  await becomeReady();
  windows[0].finishLoad();

  app.emit("open-file", openFileEvent, "/docs/a.cad");
  assert.equal(windows.length, 1);
  assert.deepEqual(openedPaths(windows[0]), ["/docs/a.cad"]);
});

test("창이 파괴된 뒤 open-file·second-instance 가 오면 창을 새로 만들어 연다", async () => {
  // 고치기 전에는 파괴된 창의 isMinimized() 가 throw 해 파일이 열리지 않았다
  const { app, becomeReady } = loadMain();
  await becomeReady();
  windows[0].finishLoad();

  windows[0].destroy();
  app.emit("open-file", openFileEvent, "/docs/a.cad");
  assert.equal(windows.length, 2);
  windows[1].finishLoad();
  assert.deepEqual(openedPaths(windows[1]), ["/docs/a.cad"]);

  windows[1].destroy();
  app.emit("second-instance", {}, ["CAD Editor.exe", path.resolve("/docs/b.cad")], path.resolve("/"));
  assert.equal(windows.length, 3);
  windows[2].finishLoad();
  assert.deepEqual(openedPaths(windows[2]), [path.resolve("/docs/b.cad")]);
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { FileChannels } from "src/app/channels/fileChannels";
import { MenuChannels } from "src/app/channels/menuChannels";
import { sendOpenFile } from "src/app/electrons/sendOpenFile";

// BrowserWindow.webContents 대신. 이벤트는 실제처럼 한 번 지나가면 다시 오지 않는다.
const fakeWebContents = (isLoading: boolean) => {
  const emitter = new EventEmitter();
  const sent: unknown[][] = [];
  const webContents = {
    isLoading: () => isLoading,
    once: (event: string, listener: () => void) => emitter.once(event, listener),
    send: (...args: unknown[]) => sent.push(args),
  };
  return { webContents, emitter, sent };
};

test("로드가 끝난 창(앱이 이미 실행 중)에는 바로 한 번 보낸다", () => {
  // 고치기 전 macOS open-file 은 이미 지나간 ready-to-show 를 기다려, 실행 중에 .cad 를 열어도 아무것도 보내지 않았다
  const { webContents, sent } = fakeWebContents(false);
  sendOpenFile(webContents as never, "/Users/me/part.cad");
  assert.deepEqual(sent, [
    [MenuChannels.MENU_EVENT, FileChannels.OPEN_FILE, "/Users/me/part.cad"],
  ]);
});

test("로드 중인 창에는 did-finish-load 에서 한 번만 보낸다", () => {
  // 고치기 전 콜드 스타트는 ready-to-show 와 did-finish-load 에서 두 번 보냈다
  const { webContents, emitter, sent } = fakeWebContents(true);
  sendOpenFile(webContents as never, "/Users/me/part.cad");
  assert.equal(sent.length, 0);

  emitter.emit("ready-to-show");
  emitter.emit("did-finish-load");
  emitter.emit("did-finish-load");
  assert.deepEqual(sent, [
    [MenuChannels.MENU_EVENT, FileChannels.OPEN_FILE, "/Users/me/part.cad"],
  ]);
});

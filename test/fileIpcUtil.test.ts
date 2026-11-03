import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

// fileIpcUtil 은 electron 의 dialog 를 쓴다. 이 프로젝트는 CommonJS 로 컴파일되므로 require 캐시에 가짜 electron 을
// 넣어 둔다. 실제 electron 모듈은 node 에서 실행 파일 경로 문자열일 뿐이다.
const stub = (specifier: string, exports: object) => {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
};
stub("electron", { dialog: {} });

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-file-io-"));
  tempDirs.push(dir);
  return dir;
};

const writeCad = (filePath: string, content: object) =>
  fs.writeFileSync(filePath, JSON.stringify(content), "utf-8");

// 싱글턴이라 테스트마다 모듈을 새로 읽어 빈 목록에서 시작한다
async function loadFileIpcUtil() {
  delete require.cache[require.resolve("src/app/ipc/fileIpcUtil")];
  return (await import("src/app/ipc/fileIpcUtil")).default;
}

test("열린 파일 하나를 읽지 못해도 목록에서 빼지 않는다", async () => {
  // 고치기 전에는 읽기에 실패한 항목을 건너뛰어, renderer 가 그 탭의 메모리 데이터(미저장 편집 포함)를 지웠다
  const fileIpcUtil = await loadFileIpcUtil();
  const dir = tempDir();
  const a = path.join(dir, "a.cad");
  const b = path.join(dir, "b.cad");
  writeCad(a, { fileId: "a" });
  writeCad(b, { fileId: "b" });
  assert.ok(await fileIpcUtil.openFile(true, a));
  assert.ok(await fileIpcUtil.openFile(true, b));

  // 열어 둔 사이 탐색기에서 이름을 바꿨다
  fs.renameSync(a, path.join(dir, "a-renamed.cad"));

  const list = fileIpcUtil.getOpenFileList();
  assert.deepEqual(
    list.map((file) => file.path),
    [a, b],
  );
  assert.equal(list[0].fileContent, null);
  assert.equal(list[1].fileContent.fileId, "b");
});

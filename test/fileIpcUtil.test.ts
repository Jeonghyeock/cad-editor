import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import type FileIpcUtil from "src/app/ipc/fileIpcUtil";

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

// 싱글턴이라 테스트마다 모듈을 새로 읽어 빈 목록에서 시작한다. import() 는 캐시를 지워도 같은 모듈을 돌려줘 require 를 쓴다.
function loadFileIpcUtil(): typeof FileIpcUtil {
  delete require.cache[require.resolve("src/app/ipc/fileIpcUtil")];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("src/app/ipc/fileIpcUtil").default;
}

test("열린 파일 하나를 읽지 못해도 목록에서 빼지 않는다", async () => {
  // 고치기 전에는 읽기에 실패한 항목을 건너뛰어, renderer 가 그 탭의 메모리 데이터(미저장 편집 포함)를 지웠다
  const fileIpcUtil = loadFileIpcUtil();
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

test("수정하지 않은 읽기 전용 파일의 탭을 닫으면 닫힌다", async () => {
  // 고치기 전에는 수정이 없어도 디스크에 다시 써서, 읽기 전용 파일은 EPERM 으로 false 가 나 탭이 닫히지 않았다
  const fileIpcUtil = loadFileIpcUtil();
  const a = path.join(tempDir(), "a.cad");
  writeCad(a, { fileId: "a" });
  assert.ok(await fileIpcUtil.openFile(true, a));
  const fileId = fileIpcUtil.getFileId();

  fs.chmodSync(a, 0o444);
  try {
    const closed = await fileIpcUtil.closeFile(null, fileId, { fileId } as never, false);
    assert.equal(closed, true);
    assert.ok(!fileIpcUtil.getOpenFileList().some((file) => file.fileId === fileId));
  } finally {
    fs.chmodSync(a, 0o666);
  }
});

test("수정하지 않은 탭을 닫아도 그 사이 바깥에서 바뀐 파일을 옛 내용으로 덮어쓰지 않는다", async () => {
  const fileIpcUtil = loadFileIpcUtil();
  const a = path.join(tempDir(), "a.cad");
  writeCad(a, { fileId: "a", unit: "MMGS" });
  assert.ok(await fileIpcUtil.openFile(true, a));
  const fileId = fileIpcUtil.getFileId();

  // 열어 둔 사이 git·동기화가 파일을 바꿨다. renderer 는 연 시점의 내용을 들고 있다
  writeCad(a, { fileId: "a", unit: "MKS" });
  assert.ok(await fileIpcUtil.closeFile(null, fileId, { fileId, unit: "MMGS" } as never, false));

  assert.equal(JSON.parse(fs.readFileSync(a, "utf-8")).unit, "MKS");
});

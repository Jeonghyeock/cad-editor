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
// Save As 대화상자가 고른 경로는 테스트가 정한다
let saveDialogPath = "";
stub("electron", {
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: saveDialogPath }),
  },
});

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

test("같은 fileId 를 가진 복사본은 원본과 다른 탭으로 연다", async () => {
  // 고치기 전에는 파일 안의 fileId 로 '이미 열린 파일'을 판정해, 탐색기 복사본을 열면 원본 탭으로 바꾸기만 했다
  const fileIpcUtil = loadFileIpcUtil();
  const dir = tempDir();
  const part = path.join(dir, "part.cad");
  const copy = path.join(dir, "part - 복사본.cad");
  writeCad(part, { fileId: "part" });
  fs.copyFileSync(part, copy);

  assert.ok(await fileIpcUtil.openFile(true, part));
  assert.ok(await fileIpcUtil.openFile(true, copy));

  const list = fileIpcUtil.getOpenFileList();
  assert.deepEqual(
    list.map((file) => file.path),
    [part, copy],
  );
  // 같은 fileId 로 두 탭이 열리면 renderer 가 fileId 별로 둔 데이터가 섞인다
  assert.notEqual(list[0].fileId, list[1].fileId);
  assert.equal(fileIpcUtil.getFileId(), list[1].fileId);
});

test("fileId 가 없는 파일끼리도 서로 다른 파일로 연다", async () => {
  const fileIpcUtil = loadFileIpcUtil();
  const dir = tempDir();
  const a = path.join(dir, "a.cad");
  const b = path.join(dir, "b.cad");
  writeCad(a, { unit: "MMGS" });
  writeCad(b, { unit: "MKS" });

  assert.ok(await fileIpcUtil.openFile(true, a));
  assert.ok(await fileIpcUtil.openFile(true, b));

  const list = fileIpcUtil.getOpenFileList();
  assert.equal(list.length, 2);
  assert.ok(list.every((file) => typeof file.fileId === "string" && file.fileId));
  assert.notEqual(list[0].fileId, list[1].fileId);
});

test("이미 연 파일을 다른 표기의 경로로 다시 열면 그 탭으로 바꾸기만 한다", async () => {
  const fileIpcUtil = loadFileIpcUtil();
  const dir = tempDir();
  const a = path.join(dir, "a.cad");
  const b = path.join(dir, "b.cad");
  writeCad(a, { fileId: "a" });
  writeCad(b, { fileId: "b" });

  assert.ok(await fileIpcUtil.openFile(true, a));
  const fileIdA = fileIpcUtil.getFileId();
  assert.ok(await fileIpcUtil.openFile(true, b));
  assert.ok(await fileIpcUtil.openFile(true, path.relative(process.cwd(), a)));

  assert.equal(fileIpcUtil.getOpenFileList().length, 2);
  assert.equal(fileIpcUtil.getFileId(), fileIdA);
});

test("Save As 한 파일에는 새 fileId 를 기록해, 다시 열면 그 탭으로 바꾸기만 한다", async () => {
  // 고치기 전에는 새 경로에 옛 fileId 를 그대로 써서, 다시 열면 같은 경로가 두 탭에 열려 서로 덮어썼다
  const fileIpcUtil = loadFileIpcUtil();
  const dir = tempDir();
  const a = path.join(dir, "a.cad");
  const b = path.join(dir, "b.cad");
  writeCad(a, { fileId: "a" });

  assert.ok(await fileIpcUtil.openFile(true, a));
  saveDialogPath = b;
  assert.ok(await fileIpcUtil.saveAsFile("a", { fileId: "a" } as never));
  const fileIdB = fileIpcUtil.getFileId();
  assert.notEqual(fileIdB, "a");
  assert.equal(JSON.parse(fs.readFileSync(b, "utf-8")).fileId, fileIdB);

  assert.ok(await fileIpcUtil.openFile(true, b));
  const list = fileIpcUtil.getOpenFileList();
  assert.deepEqual(
    list.map((file) => file.path),
    [b],
  );
  assert.equal(fileIpcUtil.getFileId(), fileIdB);
});

test("경로 비교: Windows 는 대소문자와 구분자를 가리지 않고, 그 밖에서는 대소문자를 가린다", async () => {
  const { isSameFilePath } = await import("src/app/ipc/fileIpcUtil");
  assert.ok(isSameFilePath(String.raw`C:\Work\Part.cad`, "c:/work/sub/../PART.CAD", "win32"));
  assert.ok(!isSameFilePath(String.raw`C:\Work\Part.cad`, String.raw`C:\Work\Part2.cad`, "win32"));
  assert.ok(isSameFilePath("/work/part.cad", "/work/./part.cad", "linux"));
  assert.ok(!isSameFilePath("/work/Part.cad", "/work/part.cad", "linux"));
});

test("이미 연 파일은 디스크에서 다시 읽지 않고 그 탭으로 바꾼다(깨졌거나 쓰는 중이어도)", async () => {
  // 고치기 전에는 읽고 JSON.parse 한 뒤에 경로를 봐서, 쓰는 중이라 깨진 파일을 다시 열면 false 로 아무 일도 없었다
  const fileIpcUtil = loadFileIpcUtil();
  const dir = tempDir();
  const a = path.join(dir, "a.cad");
  const b = path.join(dir, "b.cad");
  writeCad(a, { fileId: "a" });
  writeCad(b, { fileId: "b" });
  assert.ok(await fileIpcUtil.openFile(true, a));
  const fileIdA = fileIpcUtil.getFileId();
  assert.ok(await fileIpcUtil.openFile(true, b));

  fs.writeFileSync(a, '{"fileId": "a", "setup": {', "utf-8");
  assert.equal(await fileIpcUtil.openFile(true, a), true);
  assert.equal(fileIpcUtil.getFileId(), fileIdA);
});

test("링크(정션)를 거친 경로로 다시 열어도 같은 파일로 보고 그 탭으로 바꾼다", async () => {
  // 고치기 전에는 경로 문자열만 비교해, 링크를 거친 경로는 다른 파일로 보고 같은 파일을 탭 둘에 열었다
  const fileIpcUtil = loadFileIpcUtil();
  const dir = tempDir();
  const real = path.join(dir, "real");
  const link = path.join(dir, "link");
  fs.mkdirSync(real);
  writeCad(path.join(real, "a.cad"), { fileId: "a" });
  writeCad(path.join(real, "b.cad"), { fileId: "b" });
  // Windows 의 정션은 관리자 권한 없이 만들 수 있다(다른 OS 에서는 디렉터리 심볼릭 링크)
  fs.symlinkSync(real, link, "junction");

  assert.ok(await fileIpcUtil.openFile(true, path.join(real, "a.cad")));
  const fileIdA = fileIpcUtil.getFileId();
  assert.ok(await fileIpcUtil.openFile(true, path.join(link, "a.cad")));

  assert.equal(fileIpcUtil.getOpenFileList().length, 1);
  assert.equal(fileIpcUtil.getFileId(), fileIdA);

  const { isSameFilePath } = await import("src/app/ipc/fileIpcUtil");
  assert.ok(!isSameFilePath(path.join(link, "a.cad"), path.join(real, "b.cad")));
});

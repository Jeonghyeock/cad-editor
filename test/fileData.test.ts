import assert from "node:assert/strict";
import { test } from "node:test";

import { INITIAL_SETUP_DATA } from "src/features/setup/Setup.constant";

import { createFileData } from "src/shared/utils/FileUtils";

const fileContent = (fileId: string) => ({
  fileId,
  preview: "",
  unit: "MKS",
  lastURL: "/input",
  setup: { sketches: [], operations: [] },
});

test("디스크에서 연 파일마다 undo 이력 인스턴스가 따로다", () => {
  const a = createFileData("a", fileContent("a"));
  const b = createFileData("b", fileContent("b"));
  const history = (data: typeof a) => data.globalData.setup.globalHistory;

  assert.notEqual(history(a), history(b));
  assert.notEqual(history(a), INITIAL_SETUP_DATA.globalHistory);
  assert.notEqual(history(a), a.originData.setup.globalHistory);
});

test("앞 파일의 이력을 화면이 구독한 뒤에도 다음 파일을 열 수 있다", () => {
  // 고치기 전에는 두 파일이 이력 하나를 같이 써서, 리스너(함수)가 붙은 이력을 structuredClone 하다
  // DataCloneError 가 났다. 이때 fileId 는 이미 바뀌어 빈 문서가 뜨고, 저장하면 원본을 덮어썼다.
  const a = createFileData("a", fileContent("a"));
  a.globalData.setup.globalHistory.addRenderListener(() => {});

  const b = createFileData("b", fileContent("b"));
  assert.equal(b.globalData.unit, "MKS");
  assert.equal(b.globalData.lastURL, "/input");
});

test("originData 는 globalData 와 분리된 사본이다", () => {
  const data = createFileData("a", fileContent("a"));
  data.globalData.setup.sketches.push({} as never);
  assert.equal(data.originData.setup.sketches.length, 0);
});

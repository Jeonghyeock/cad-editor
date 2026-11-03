import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { getOcctAddonCandidates } from "src/app/ipc/occtAddonPath";

const dirs = {
  resourcesPath: path.resolve("/Program Files/CAD Editor/resources"),
  dirname: path.resolve("/Program Files/CAD Editor/resources/app.asar/.vite/build"),
  // 탐색기에서 .cad 를 더블클릭하면 그 파일이 있는 (남이 건넨) 폴더가 cwd 가 될 수 있다
  cwd: path.resolve("/Users/me/Downloads/shared-project"),
};

test("배포판은 resources 아래 애드온 하나만 찾고, cwd 아래는 보지 않는다", () => {
  // 고치기 전에는 배포판도 cwd 아래 packages/occt-native/... 를 조건 없이 require 해, 심어 둔 .node 를 불러왔다
  const candidates = getOcctAddonCandidates({ isPackaged: true, ...dirs });
  assert.deepEqual(candidates, [path.join(dirs.resourcesPath, "occt_native.node")]);
  assert.ok(candidates.every((candidate) => !candidate.startsWith(dirs.cwd)));
});

test("패키징하지 않은 개발 실행은 저장소의 빌드 결과를 찾는다", () => {
  const candidates = getOcctAddonCandidates({ isPackaged: false, ...dirs });
  assert.ok(
    candidates.includes(
      path.join(dirs.cwd, "packages/occt-native/build/Release/occt_native.node"),
    ),
  );
});

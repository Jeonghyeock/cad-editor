import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveIfSameFile } from "src/features/setup/utils/fileScopedTask";

test("불러오는 동안 다른 파일 탭으로 바뀌면 결과를 버린다", async () => {
  // 고치기 전에는 STEP 을 불러오는 동안 B 탭으로 바꾸면 모델은 B 에, Import 명령은 A 의 이력에 들어갔다
  let fileId = "a";
  let finishLoad: (model: string) => void = () => {};
  const pending = resolveIfSameFile(
    () => fileId,
    () => new Promise<string>((resolve) => (finishLoad = resolve)),
  );

  fileId = "b";
  finishLoad("model");
  assert.equal(await pending, null);
});

test("같은 파일에서 끝나면 결과를 돌려준다", async () => {
  const result = await resolveIfSameFile(
    () => "a",
    async () => "model",
  );
  assert.equal(result, "model");
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { installReactDevToolsFrom } from "src/app/electrons/devTools";

const REACT_DEVELOPER_TOOLS = { id: "fmkadmapgofadopljbjfkapdkoienihi" };

const fakeInstaller = () => {
  const installed: unknown[] = [];
  const installExtension = async (extension: unknown) => {
    installed.push(extension);
    return "React Developer Tools";
  };
  return { installed, installExtension };
};

test("import() 의 default 가 설치 함수로 풀리면 그대로 쓴다", async () => {
  // vite 빌드, __esModule 을 따르는 interop
  const { installed, installExtension } = fakeInstaller();
  await installReactDevToolsFrom({ default: installExtension, REACT_DEVELOPER_TOOLS });
  assert.deepEqual(installed, [REACT_DEVELOPER_TOOLS]);
});

test("default 가 module.exports 전체로 한 번 더 감싸여 풀려도 설치 함수를 꺼낸다", async () => {
  // node 의 ESM import·__esModule 을 무시하는 interop 에서는 default 가 module.exports 이고, 함수는 그 안의 default 다.
  // 고치기 전 main.ts 는 이 경우 default 를 그대로 불러 TypeError 가 났다
  const { installed, installExtension } = fakeInstaller();
  const moduleExports = { default: installExtension, REACT_DEVELOPER_TOOLS };
  await installReactDevToolsFrom({ default: moduleExports, REACT_DEVELOPER_TOOLS });
  await installReactDevToolsFrom({ default: moduleExports });
  assert.deepEqual(installed, [REACT_DEVELOPER_TOOLS, REACT_DEVELOPER_TOOLS]);
});

test("default 없이 모듈 자체가 설치 함수로 풀려도 그 함수를 쓴다", async () => {
  const { installed, installExtension } = fakeInstaller();
  await installReactDevToolsFrom(Object.assign(installExtension, { REACT_DEVELOPER_TOOLS }));
  assert.deepEqual(installed, [REACT_DEVELOPER_TOOLS]);
});

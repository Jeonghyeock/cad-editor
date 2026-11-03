import assert from "node:assert/strict";
import { test } from "node:test";

import { MenuChannels } from "src/app/channels/menuChannels";

import { APP_MENU_OPTIONS } from "src/shared/constants/App.constant";

test("File > Exit 는 role 없이 click 으로 renderer 의 닫기(저장 확인)로 넘긴다", () => {
  // 고치기 전에는 role:"quit" 이라 click 이 무시되고 app.quit() 이 바로 실행돼, 미저장 변경을 묻지 않고 꺼졌다
  const items = APP_MENU_OPTIONS.flatMap((menu) =>
    Array.isArray(menu.submenu) ? menu.submenu : [],
  );
  const exit = items.find((item) => item.id === MenuChannels.WINDOW_CLOSE);
  assert.ok(exit);
  assert.equal(exit.role, undefined);
  assert.equal(typeof exit.click, "function");
});

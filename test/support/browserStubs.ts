// 렌더러 쪽 모듈을 node 에서 읽기 위한 최소한의 대체물. 테스트 파일에서 다른 import 보다 먼저 불러온다.
// - SVG 아이콘 import: vite 처럼 파일 경로(URL) 문자열로 돌려준다.
// - Image: overlayConstants 가 모듈을 읽을 때 아이콘을 미리 불러온다. node 에는 없어서 끝나지 않는 빈 이미지로 둔다.
// - window: 일부 모듈이 읽는 시점에 window.electron 등을 참조한다.
require.extensions[".svg"] = (module, filename) => {
  module.exports = filename;
};

const g = globalThis as Record<string, unknown>;
g.Image ??= class {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
};
g.window ??= globalThis;

// node 는 svg 를 모듈로 읽지 못한다(vite 가 번들할 때 경로 문자열로 바꾼다). 테스트에서는 파일 경로를 그대로 돌려준다.
// 스케치 store 가 overlayConstants 를 거쳐 아이콘 svg 를 불러오므로, 이 파일을 다른 import 보다 먼저 불러와야 한다.
require.extensions[".svg"] = (module, filename) => {
  module.exports = filename;
};

// overlayConstants 가 불러오자마자 아이콘을 Image 로 미리 읽는다. node 에는 Image 가 없으니, 읽기를 끝내지 않는 빈 객체로 둔다.
(globalThis as Record<string, unknown>).Image ??= class {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
};

// 일부 렌더러 모듈이 읽는 시점에 window.electron 등을 참조한다(StepLoaderNative 등). node 에는 window 가 없어 globalThis 로 둔다.
// browserStubs 와 따로 두는 까닭: window 가 객체이면 planegcs(emscripten) 가 브라우저 환경으로 보고 wasm 을 다른 경로로 읽으며,
// 테스트가 스스로 정한 window(예: padCommandAsync 의 `window ??= {}`)도 덮인다. 그래서 window 가 꼭 필요한 테스트만 불러온다.
(globalThis as Record<string, unknown>).window ??= globalThis;

/**
 * React DevTools 확장을 설치한다. 패키징하지 않은 개발 실행에서만 부른다(main.ts).
 * 동적 import 라 설치 코드(Google 에서 확장을 내려받는 코드)는 main 번들에서 빠져 별도 청크로 간다.
 */
export const installReactDevTools = async () =>
  installReactDevToolsFrom(await import("electron-devtools-installer"));

/**
 * electron-devtools-installer 는 CommonJS 모듈이라 번들러·로더의 interop 에 따라 import() 의 default 가 설치 함수이거나,
 * module.exports 전체(설치 함수는 그 안의 default)로 풀리고, default 없이 모듈 자체가 함수일 수도 있다.
 * 어느 쪽이든 처음 나오는 함수를 꺼내 React DevTools 를 설치한다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const installReactDevToolsFrom = (mod: any): Promise<string> => {
  const installExtension = [mod.default, mod.default?.default, mod].find(
    (candidate) => typeof candidate === "function",
  );
  const reactDevTools =
    mod.REACT_DEVELOPER_TOOLS ?? mod.default?.REACT_DEVELOPER_TOOLS;
  return installExtension(reactDevTools);
};

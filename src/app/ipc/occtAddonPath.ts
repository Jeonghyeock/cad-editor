import path from "path";

/**
 * OCCT Native Addon(.node)을 찾아볼 경로 후보.
 *
 * 배포판은 resources 아래 절대 경로 하나만 본다. 작업 폴더(cwd) 기준 후보를 배포판에서도 쓰면, 앱이 꺼진 상태에서
 * 탐색기로 다른 폴더의 .cad 를 더블클릭해 그 폴더가 cwd 가 됐을 때 그 아래에 심어 둔 .node 를 메인 프로세스에
 * 불러온다(DllMain 실행). 개발용 후보는 패키징하지 않은 실행에서만 쓴다.
 */
export const getOcctAddonCandidates = ({
  isPackaged,
  resourcesPath,
  dirname,
  cwd,
}: {
  isPackaged: boolean;
  resourcesPath: string;
  dirname: string;
  cwd: string;
}): string[] => {
  // 프로덕션: extraResource 경로
  if (isPackaged) return [path.join(resourcesPath, "occt_native.node")];

  return [
    // 개발 모드: packages/occt-native/build/Release/
    path.join(dirname, "../../../packages/occt-native/build/Release/occt_native.node"),
    // 개발 모드 (vite 빌드 후)
    path.join(cwd, "packages/occt-native/build/Release/occt_native.node"),
  ];
};

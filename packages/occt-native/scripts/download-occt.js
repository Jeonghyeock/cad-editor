#!/usr/bin/env node
// OCCT 7.8.1 사전 빌드 라이브러리 다운로드 스크립트
// CI 또는 개발 환경 초기 설정 시 실행
//
// 사용법:
//   node scripts/download-occt.js
//
// OCCT 사전 빌드는 다음 중 하나에서 가져올 수 있음:
// 1. https://github.com/nickvdp/occt-prebuilt (커뮤니티)
// 2. https://dev.opencascade.org/release (공식)
// 3. vcpkg: vcpkg install opencascade
//
// 현재는 수동 설치 가이드를 출력합니다.

console.log(`
=== OCCT 7.8.1 설치 가이드 ===

@cad-editor/occt-native를 빌드하려면 OCCT 정적 라이브러리가 필요합니다.

방법 1: vcpkg (권장)
  > vcpkg install opencascade:x64-windows-static
  > set OCCT_ROOT=C:/vcpkg/installed/x64-windows-static

방법 2: 공식 릴리스
  1. https://dev.opencascade.org/release 에서 OCCT 7.8.1 다운로드
  2. CMake로 정적 빌드:
     cmake -DBUILD_LIBRARY_TYPE=Static -DCMAKE_INSTALL_PREFIX=C:/occt-7.8.1 ..
     cmake --build . --config Release --target install
  3. set OCCT_ROOT=C:/occt-7.8.1

방법 3: conda-forge
  > conda install -c conda-forge occt

설치 후:
  > cd packages/occt-native
  > npx cmake-js compile --CDOCCT_ROOT=<설치경로>

============================
`);

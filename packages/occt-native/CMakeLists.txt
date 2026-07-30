cmake_minimum_required(VERSION 3.15)
cmake_policy(SET CMP0091 NEW) # MSVC runtime selection

project(occt_native)

# cmake-js 변수 (cmake-js가 자동 주입)
include_directories(${CMAKE_JS_INC})

# node-addon-api 헤더
execute_process(
  COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
include_directories(${NODE_ADDON_API_DIR})

# OCCT 헤더 및 라이브러리
# OCCT_ROOT를 환경변수 또는 cmake 인자로 전달
# 예: cmake-js compile --CDOCCT_ROOT=C:/occt-7.8.1
if(DEFINED OCCT_ROOT)
  include_directories(${OCCT_ROOT}/include/opencascade ${OCCT_ROOT}/include)
  link_directories(${OCCT_ROOT}/lib)
endif()

# 소스 파일
file(GLOB_RECURSE SOURCES "src/cpp/*.cpp")

# 네이티브 모듈 빌드
add_library(${PROJECT_NAME} SHARED ${SOURCES} ${CMAKE_JS_SRC})

# N-API 정의
target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_VERSION=9
  NODE_ADDON_API_DISABLE_DEPRECATED
)

# .node 확장자
set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

# Node.js 라이브러리 링크
target_link_libraries(${PROJECT_NAME} "${CMAKE_SOURCE_DIR}/node.lib")

# OCCT 라이브러리 링크 (Phase 1에서 추가)
if(DEFINED OCCT_ROOT)
  target_compile_definitions(${PROJECT_NAME} PRIVATE HAVE_OCCT)
  target_link_libraries(${PROJECT_NAME}
    # Core
    TKernel TKMath TKG2d TKG3d TKGeomBase TKGeomAlgo
    # Topology
    TKBRep TKTopAlgo TKPrim TKMesh
    # Boolean + Healing
    TKBO TKBool TKShHealing
    # Features
    TKFillet TKOffset TKFeat
    # STEP/XCAF (OCCT 7.9 vcpkg naming)
    TKDESTEP TKDEIGES TKDE TKXSBase
    TKXCAF TKCAF TKLCAF TKCDF
    # Visualization (TKXCAF dependency)
    TKService TKV3d TKOpenGl TKVCAF TKHLR
    # Third-party (vcpkg)
    freetype libpng16 zlib bz2 brotlidec brotlicommon
    # Windows system libs
    OpenGL32 GlU32 User32 Gdi32 Advapi32 Ws2_32
  )
endif()

# C++17
set_target_properties(${PROJECT_NAME} PROPERTIES
  CXX_STANDARD 17
  CXX_STANDARD_REQUIRED ON
)

# Windows: 정적 CRT 링크 (단일 바이너리 배포)
if(MSVC)
  set_property(TARGET ${PROJECT_NAME} PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
endif()

// OCCT IPC payload + result types — main 과 renderer 양쪽이 공유.
// renderer 의 sketch primitive / plane / vector 형태를 main 의 OCCT C++ addon 이 그대로 받음.

/** 3D 벡터 (또는 plane origin / axis direction). */
export type OcctVec3 = { x: number; y: number; z: number };

/** Sketch plane (origin + 2 축 basis). u / v 가 plane 의 local X / Y axis. */
export type OcctPlaneData = {
  origin: OcctVec3;
  u: OcctVec3;
  v: OcctVec3;
};

/**
 * Sketch primitive → OCCT edge data — line / arc / circle / curve 등. 정확한 shape 은 sketch
 * geometry type 에 따름 (renderer 의 profileToEdgeData 가 변환). main 측에서 형태 검사 안 하고
 * addon 에 그대로 전달.
 */
export type OcctEdgeData = Record<string, unknown>;

/** OCCT mesh 결과 — main 이 raw addon 결과를 JS 친화 array 로 변환해 반환. */
export type OcctMeshResult = {
  handle: number;
  mesh: {
    positions: number[];
    normals: number[];
    indices: number[];
  };
};

/** Pad / Pocket 의 direction — Vec3 또는 정규화된 unit vector. */
export type OcctDirection = OcctVec3;

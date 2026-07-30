// 단면 계산 통합 모듈
// Face boundary 추출 + Mesh-Plane intersection 두 경로 지원

import type { CrossSectionDef, StepModelData, Vec3 } from "../Setup.type";

import { extractFaceBoundary, chainBoundaryEdges, findMeshAndFace } from "./FaceBoundaryExtractor";
import {
  computeMeshPlaneIntersection,
  chainSegments,
} from "./MeshPlaneIntersection";

export type CrossSectionResult = {
  polylines: Vec3[][];
  planeOrigin: Vec3;
  planeNormal: Vec3;
};

/**
 * 단면 계산: face 선택 또는 절단면 정의에 따라 3D polyline 반환
 */
export const computeCrossSection = (
  model: StepModelData,
  crossSection: CrossSectionDef,
): CrossSectionResult => {
  if (crossSection.type === "face") {
    return computeFaceCrossSection(model, crossSection.faceGroupId);
  }
  return computePlaneCrossSection(model, crossSection.origin, crossSection.normal);
};

/**
 * Face 선택 단면: face boundary edge 추출 → 체이닝
 */
const computeFaceCrossSection = (
  model: StepModelData,
  faceGroupId: number,
): CrossSectionResult => {
  const boundaries = extractFaceBoundary(model, faceGroupId);
  const polylines = chainBoundaryEdges(boundaries);

  const found = findMeshAndFace(model, faceGroupId);
  const normal = found
    ? computeFaceNormal(found.body.positions, found.body.normals, found.body.indices, found.body.brepFaces[found.faceIndex])
    : { x: 0, y: 0, z: 1 };
  const centroid = found
    ? computeFaceCentroid(found.body.positions, found.body.indices, found.body.brepFaces[found.faceIndex])
    : { x: 0, y: 0, z: 0 };

  return {
    polylines,
    planeOrigin: centroid,
    planeNormal: normal,
  };
};

/**
 * 절단면 단면: 모든 mesh의 mesh-plane intersection → segment chaining
 */
const computePlaneCrossSection = (
  model: StepModelData,
  origin: Vec3,
  normal: Vec3,
): CrossSectionResult => {
  // 모든 mesh에 대해 intersection 수행 후 합침
  const allSegments: { a: Vec3; b: Vec3 }[] = [];
  for (const body of model.bodies) {
    const segments = computeMeshPlaneIntersection(
      body.positions,
      body.indices,
      origin,
      normal,
    );
    allSegments.push(...segments);
  }

  const polylines = chainSegments(allSegments);

  return {
    polylines,
    planeOrigin: origin,
    planeNormal: normal,
  };
};

// brep face 의 평면 normal 계산.
// 평면 face 라면 모든 triangle 의 기하 normal 이 동일 → 첫 triangle 의 cross product 로 정확.
// 곡면 face (cylinder/sphere 등) 는 위치별 normal 이 달라 모호 — 첫 triangle 의 normal 사용
// (centroid 부근의 접평면 추정으로 충분).
//
// 이전 구현은 vertex normal 평균 — OCCT tessellation 옵션에 따라 face 간 vertex 가 공유되면
// boundary vertex normal 이 인접 face 들의 평균이 되어 plane normal 과 어긋남.
// axis-aligned 면은 모든 인접 면 normal 이 같은 방향이라 우연히 정상 동작했으나
// 비-axis-aligned 평면 face 에서 normal 이 비뚤어져 카메라가 face 정면을 못 잡았음.
//
// winding orientation 검증을 위해 vertex normal 평균과 dot 비교 — outward 보정.
const computeFaceNormal = (
  positions: number[],
  normals: number[],
  indices: number[],
  face: { first: number; last: number } | undefined,
): Vec3 => {
  if (!face) return { x: 0, y: 0, z: 1 };

  const startIdx = face.first * 3;
  // 첫 triangle 의 세 vertex
  const i0 = indices[startIdx];
  const i1 = indices[startIdx + 1];
  const i2 = indices[startIdx + 2];
  if (i0 === undefined || i1 === undefined || i2 === undefined) return { x: 0, y: 0, z: 1 };

  const v0x = positions[i0 * 3], v0y = positions[i0 * 3 + 1], v0z = positions[i0 * 3 + 2];
  const v1x = positions[i1 * 3], v1y = positions[i1 * 3 + 1], v1z = positions[i1 * 3 + 2];
  const v2x = positions[i2 * 3], v2y = positions[i2 * 3 + 1], v2z = positions[i2 * 3 + 2];

  const ax = v1x - v0x, ay = v1y - v0y, az = v1z - v0z;
  const bx = v2x - v0x, by = v2y - v0y, bz = v2z - v0z;
  // cross product (v1 - v0) × (v2 - v0)
  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-10) return { x: 0, y: 0, z: 1 };
  nx /= len; ny /= len; nz /= len;

  // OCCT 가 제공한 vertex normal 평균과 부호 비교 — winding 이 inward 면 뒤집어 outward 확정.
  if (normals.length > 0) {
    let avgNx = 0, avgNy = 0, avgNz = 0, count = 0;
    for (const idx of [i0, i1, i2]) {
      avgNx += normals[idx * 3] || 0;
      avgNy += normals[idx * 3 + 1] || 0;
      avgNz += normals[idx * 3 + 2] || 0;
      count++;
    }
    if (count > 0) {
      const dot = nx * avgNx + ny * avgNy + nz * avgNz;
      if (dot < 0) { nx = -nx; ny = -ny; nz = -nz; }
    }
  }

  return { x: nx, y: ny, z: nz };
};

// brep face의 중심점 계산
const computeFaceCentroid = (
  positions: number[],
  indices: number[],
  face: { first: number; last: number } | undefined,
): Vec3 => {
  if (!face) return { x: 0, y: 0, z: 0 };

  let cx = 0, cy = 0, cz = 0;
  const visited = new Set<number>();

  // first/last는 삼각형 인덱스
  const startIdx = face.first * 3;
  const endIdx = (face.last + 1) * 3;

  for (let i = startIdx; i < endIdx; i++) {
    const idx = indices[i];
    if (visited.has(idx)) continue;
    visited.add(idx);
    cx += positions[idx * 3];
    cy += positions[idx * 3 + 1];
    cz += positions[idx * 3 + 2];
  }

  const n = visited.size || 1;
  return { x: cx / n, y: cy / n, z: cz / n };
};

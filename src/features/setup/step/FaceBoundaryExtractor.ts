// Face Group 삼각형에서 Boundary Edge 추출
// half-edge 검출: 1개 삼각형에만 속하는 edge = boundary

import type { StepBodyData, StepModelData, Vec3 } from "../Setup.type";

export type BoundaryEdge = {
  a: Vec3;
  b: Vec3;
};

// edge key 생성 (정렬된 vertex index 쌍)
const edgeKey = (i0: number, i1: number): string =>
  i0 < i1 ? `${i0}_${i1}` : `${i1}_${i0}`;

/**
 * globalFaceId로 해당 mesh와 brepFace를 찾는 유틸
 */
export const findMeshAndFace = (
  model: StepModelData,
  faceGroupId: number,
): { body: StepBodyData; faceIndex: number } | null => {
  let offset = 0;
  for (const body of model.bodies) {
    const count = Math.max(body.brepFaces.length, 1);
    if (faceGroupId < offset + count) {
      return { body, faceIndex: faceGroupId - offset };
    }
    offset += count;
  }
  return null;
};

/**
 * face group의 삼각형에서 boundary edge 추출
 * boundary = 1개 삼각형에만 속하는 edge
 */
export const extractFaceBoundary = (
  model: StepModelData,
  faceGroupId: number,
): BoundaryEdge[] => {
  const found = findMeshAndFace(model, faceGroupId);
  if (!found) return [];

  const { body, faceIndex } = found;
  const face = body.brepFaces[faceIndex];
  if (!face) return [];

  const edgeCount = new Map<string, number>();
  const edgeVertices = new Map<string, [number, number]>();

  // first/last는 삼각형 인덱스 (배열 오프셋 = triangle * 3)
  const startIdx = face.first * 3;
  const endIdx = (face.last + 1) * 3;

  for (let i = startIdx; i + 2 < endIdx; i += 3) {
    const a = body.indices[i];
    const b = body.indices[i + 1];
    const c = body.indices[i + 2];

    const edges: [number, number][] = [
      [a, b],
      [b, c],
      [c, a],
    ];

    for (const [v0, v1] of edges) {
      const key = edgeKey(v0, v1);
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      if (!edgeVertices.has(key)) {
        edgeVertices.set(key, [v0, v1]);
      }
    }
  }

  // boundary = count가 1인 edge
  const boundaries: BoundaryEdge[] = [];
  for (const [key, count] of edgeCount) {
    if (count === 1) {
      const v = edgeVertices.get(key);
      if (!v) continue;
      const [i0, i1] = v;
      boundaries.push({
        a: {
          x: body.positions[i0 * 3],
          y: body.positions[i0 * 3 + 1],
          z: body.positions[i0 * 3 + 2],
        },
        b: {
          x: body.positions[i1 * 3],
          y: body.positions[i1 * 3 + 1],
          z: body.positions[i1 * 3 + 2],
        },
      });
    }
  }

  return boundaries;
};

/**
 * boundary edge를 체이닝하여 닫힌 루프 구성
 */
export const chainBoundaryEdges = (
  edges: BoundaryEdge[],
  epsilon = 1e-6,
): Vec3[][] => {
  if (edges.length === 0) return [];

  const near = (a: Vec3, b: Vec3) =>
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.z - b.z) < epsilon;

  const used = new Array(edges.length).fill(false);
  const chains: Vec3[][] = [];

  for (let seed = 0; seed < edges.length; seed++) {
    if (used[seed]) continue;
    used[seed] = true;

    const chain: Vec3[] = [edges[seed].a, edges[seed].b];
    let changed = true;

    while (changed) {
      changed = false;
      for (let i = 0; i < edges.length; i++) {
        if (used[i]) continue;
        const e = edges[i];
        const tail = chain[chain.length - 1];
        const head = chain[0];

        if (near(tail, e.a)) {
          chain.push(e.b);
          used[i] = true;
          changed = true;
        } else if (near(tail, e.b)) {
          chain.push(e.a);
          used[i] = true;
          changed = true;
        } else if (near(head, e.b)) {
          chain.unshift(e.a);
          used[i] = true;
          changed = true;
        } else if (near(head, e.a)) {
          chain.unshift(e.b);
          used[i] = true;
          changed = true;
        }
      }
    }

    chains.push(chain);
  }

  return chains;
};

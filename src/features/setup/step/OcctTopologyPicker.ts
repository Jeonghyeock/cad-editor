// OCCT B-Rep topology 기반 picking
// raycast hit triangle → OCCT face index 매핑
// screen-space distance → OCCT edge/vertex index 매핑

import * as THREE from "three";

import type {
  FaceGroupedMesh,
  ShapeTopologyData,
  TopologyEdge,
  TopologyVertex,
} from "./OcctSketchNative";
import {
  getDetailedShapeTopology,
  tessellateShapeWithTopology,
} from "./OcctSketchNative";

const EDGE_PICK_THRESHOLD_PX = 8;
const VERTEX_PICK_THRESHOLD_PX = 6;

export type OcctFacePickResult = {
  faceIndex: number;
  surfaceType: string;
  point: THREE.Vector3;
  normal: THREE.Vector3;
};

export type OcctEdgePickResult = {
  edgeIndex: number;
  curveType: string;
  point: THREE.Vector3;
};

export type OcctVertexPickResult = {
  vertexIndex: number;
  point: THREE.Vector3;
};

// 2D screen-space: point → line segment distance + parameter t
function screenDistToSegment(
  p: THREE.Vector2,
  a: THREE.Vector2,
  b: THREE.Vector2,
): { dist: number; t: number } {
  const ab = new THREE.Vector2().subVectors(b, a);
  const ap = new THREE.Vector2().subVectors(p, a);
  const len2 = ab.lengthSq();
  if (len2 < 1e-6) return { dist: p.distanceTo(a), t: 0 };
  let t = ap.dot(ab) / len2;
  t = Math.max(0, Math.min(1, t));
  const closest = new THREE.Vector2().addVectors(a, ab.clone().multiplyScalar(t));
  return { dist: p.distanceTo(closest), t };
}

// 3D → NDC → screen 변환
function toScreen(
  pt3d: { x: number; y: number; z: number },
  camera: THREE.Camera,
  w: number,
  h: number,
): THREE.Vector2 {
  const v = new THREE.Vector3(pt3d.x, pt3d.y, pt3d.z).project(camera);
  return new THREE.Vector2((v.x + 1) * w / 2, (-v.y + 1) * h / 2);
}

/**
 * OCCT B-Rep topology 기반 picker.
 * shape handle별 topology + face-indexed mesh를 캐시하여
 * raycast hit → face / screen distance → edge/vertex 매핑 수행.
 */
export class OcctTopologyPicker {
  private _topologyCache = new Map<number, ShapeTopologyData>();
  private _meshCache = new Map<number, { mesh: THREE.Mesh; faceGroups: FaceGroupedMesh["faceGroups"] }>();

  /** shape handle에 대한 topology 데이터 사전 로드 */
  async loadTopology(handle: number): Promise<void> {
    if (this._topologyCache.has(handle)) return;
    try {
      const [topo, faceMesh] = await Promise.all([
        getDetailedShapeTopology(handle),
        tessellateShapeWithTopology(handle),
      ]);
      this._topologyCache.set(handle, topo);

      // Three.js mesh 생성
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(faceMesh.positions, 3));
      if (faceMesh.normals.length > 0) {
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(faceMesh.normals, 3));
      }
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(faceMesh.indices), 1));

      const material = new THREE.MeshPhongMaterial({
        color: 0xcccccc,
        specular: 0x111111,
        shininess: 30,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = { occtHandle: handle };

      this._meshCache.set(handle, { mesh, faceGroups: faceMesh.faceGroups });
    } catch (err) {
      console.error("[OcctTopologyPicker] loadTopology failed:", err);
    }
  }

  /** 캐시된 Three.js mesh 반환 (scene에 추가용) */
  getMesh(handle: number): THREE.Mesh | null {
    return this._meshCache.get(handle)?.mesh ?? null;
  }

  /** topology 데이터 반환 */
  getTopology(handle: number): ShapeTopologyData | null {
    return this._topologyCache.get(handle) ?? null;
  }

  /**
   * Raycast hit의 triangle index → OCCT face index 매핑.
   * faceGroups의 {first, count} 범위에서 해당 triangle이 속한 face를 찾음.
   */
  pickFace(
    handle: number,
    raycaster: THREE.Raycaster,
  ): OcctFacePickResult | null {
    const cached = this._meshCache.get(handle);
    const topo = this._topologyCache.get(handle);
    if (!cached || !topo) return null;

    const intersections = raycaster.intersectObject(cached.mesh);
    if (intersections.length === 0) return null;

    const hit = intersections[0];
    // faceIndex = indices 배열에서의 triangle 인덱스 (3개씩 묶음)
    const triIdx = hit.faceIndex;
    if (triIdx == null) return null;

    // faceGroups에서 해당 triangle이 속한 OCCT face 찾기
    for (let i = 0; i < cached.faceGroups.length; i++) {
      const { first, count } = cached.faceGroups[i];
      if (triIdx >= first && triIdx < first + count) {
        const face = topo.faces[i];
        if (!face) continue;
        return {
          faceIndex: i,
          surfaceType: face.surfaceType,
          point: hit.point.clone(),
          normal: new THREE.Vector3(face.normal.x, face.normal.y, face.normal.z),
        };
      }
    }

    return null;
  }

  /**
   * Screen-space distance 기반 edge picking.
   * OCCT edge의 polyline을 화면에 투영하여 마우스와의 최소 거리 계산.
   */
  pickEdge(
    handle: number,
    mouseScreen: THREE.Vector2,
    camera: THREE.Camera,
    screenWidth: number,
    screenHeight: number,
  ): OcctEdgePickResult | null {
    const topo = this._topologyCache.get(handle);
    if (!topo) return null;

    let bestDist = EDGE_PICK_THRESHOLD_PX;
    let bestEdge: TopologyEdge | null = null;
    let bestPoint3D: THREE.Vector3 | null = null;

    for (const edge of topo.edges) {
      const screenPts = edge.polyline.map((p) => toScreen(p, camera, screenWidth, screenHeight));

      for (let i = 0; i < screenPts.length - 1; i++) {
        const { dist, t } = screenDistToSegment(mouseScreen, screenPts[i], screenPts[i + 1]);
        if (dist < bestDist) {
          bestDist = dist;
          bestEdge = edge;
          // segment의 t 값으로 3D closest point 보간
          const pA = edge.polyline[i];
          const pB = edge.polyline[i + 1];
          bestPoint3D = new THREE.Vector3(
            pA.x + (pB.x - pA.x) * t,
            pA.y + (pB.y - pA.y) * t,
            pA.z + (pB.z - pA.z) * t,
          );
        }
      }
    }

    if (!bestEdge || !bestPoint3D) return null;
    return {
      edgeIndex: bestEdge.index,
      curveType: bestEdge.curveType,
      point: bestPoint3D,
    };
  }

  /**
   * Screen-space distance 기반 vertex picking.
   * OCCT vertex를 화면에 투영하여 마우스와의 최소 거리 계산.
   */
  pickVertex(
    handle: number,
    mouseScreen: THREE.Vector2,
    camera: THREE.Camera,
    screenWidth: number,
    screenHeight: number,
  ): OcctVertexPickResult | null {
    const topo = this._topologyCache.get(handle);
    if (!topo) return null;

    let bestDist = VERTEX_PICK_THRESHOLD_PX;
    let bestVtx: TopologyVertex | null = null;

    for (const vtx of topo.vertices) {
      const screenPt = toScreen(vtx, camera, screenWidth, screenHeight);
      const dist = mouseScreen.distanceTo(screenPt);
      if (dist < bestDist) {
        bestDist = dist;
        bestVtx = vtx;
      }
    }

    if (!bestVtx) return null;
    return {
      vertexIndex: bestVtx.index,
      point: new THREE.Vector3(bestVtx.x, bestVtx.y, bestVtx.z),
    };
  }

  /** handle에 대한 캐시 해제 */
  release(handle: number): void {
    this._topologyCache.delete(handle);
    const cached = this._meshCache.get(handle);
    if (cached) {
      cached.mesh.geometry.dispose();
      if (cached.mesh.material instanceof THREE.Material) {
        cached.mesh.material.dispose();
      }
      this._meshCache.delete(handle);
    }
  }

  /** 전체 캐시 해제 */
  dispose(): void {
    for (const handle of this._meshCache.keys()) {
      this.release(handle);
    }
    this._topologyCache.clear();
  }
}

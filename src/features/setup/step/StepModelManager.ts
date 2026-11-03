// STEP 모델 3D 시각화 매니저
// StepModelData → THREE.Group 변환

import * as THREE from "three";

import { COLOR_HOVERED, COLOR_SELECTED } from "../rendering/overlayConstants";
import type { StepModelData } from "../Setup.type";

const HIGHLIGHT_EMISSIVE = 0x446688;
// hover / select 톤은 overlayConstants 통일 색상을 그대로 사용 (sketch / 3D body / linkage 와 동일)
const EDGE_HOVER_COLOR = COLOR_HOVERED;
const VERTEX_HOVER_COLOR = COLOR_HOVERED;
const EDGE_SELECT_COLOR = COLOR_SELECTED;
const VERTEX_SELECT_COLOR = COLOR_SELECTED;
const EDGE_HIGHLIGHT_NAME = "__edge-highlight__";
const VERTEX_HIGHLIGHT_NAME = "__vertex-highlight__";
const EDGE_SELECT_NAME = "__edge-select__";
const VERTEX_SELECT_NAME = "__vertex-select__";
const EDGE_PICK_THRESHOLD_PX = 8;
const VERTEX_PICK_THRESHOLD_PX = 6;
const EDGE_ANGLE_THRESHOLD = 30; // degrees for EdgesGeometry

// Edge segment 단위 — brepEdgeId 가 같은 segment 들은 한 BRep edge 의 polyline 조각.
// brepEdgeId === -1 이면 grouping 없음 (mesh tessellation fallback).
type EdgeSegment = { start: THREE.Vector3; end: THREE.Vector3; brepEdgeId: number };

const edgeCache = new WeakMap<THREE.BufferGeometry, EdgeSegment[]>();
const vertexCache = new WeakMap<THREE.BufferGeometry, THREE.Vector3[]>();

/**
 * mesh 의 부모 model group 에서 이 mesh body 의 BRep wireframe sub-Group 찾기 (없으면 null).
 *
 * group 구조:
 *   model group
 *   ├── mesh-body-0 (Mesh, userData.bodyIndex=0)
 *   ├── edges-body-0 (LineSegments, EdgesGeometry fallback)
 *   ├── ...
 *   └── brep-wireframe (Group)
 *       ├── brep-wireframe-body-0 (Group of THREE.Line, userData.bodyIndex=0)
 *       ├── brep-wireframe-body-1 (Group of THREE.Line, userData.bodyIndex=1)
 *       └── ...
 *
 * bodyIndex 는 `createStepModelGroup` 에서 mesh.userData.bodyIndex 에 저장. wireframe root
 * 의 sub-Group 중 userData.bodyIndex 일치하는 것을 반환.
 *
 * 반환이 null 인 경우:
 *  - wireframe root 자체가 없음 (_enhanceWireframe 미완료 / 호출 안 됨)
 *  - sub-Group 의 visible=false: 두 가지 의미가 섞임 — (1) wireValid=false 라 좌표가 mesh 와
 *    어긋난 상태 (mesh 와 다른 곳에 그려질 수 있어 무효 처리), (2) body 자체가 hidden. 어느
 *    쪽이든 EdgesGeometry fallback 사용. body hidden 인 경우는 어차피 raycaster hit 자체가
 *    없어 pick 흐름에 도달하지 않으므로 fallback 으로 가도 결과는 동일.
 */
function getBRepWireframe(mesh: THREE.Mesh): THREE.Group | null {
  const parent = mesh.parent;
  if (!parent) return null;
  const bodyIndex = mesh.userData.bodyIndex;
  if (typeof bodyIndex !== "number") return null;
  const root = parent.children.find(
    (c): c is THREE.Group => c instanceof THREE.Group && c.name === "brep-wireframe",
  );
  if (!root) return null;
  const sub = root.children.find(
    (c): c is THREE.Group => c instanceof THREE.Group && c.userData.bodyIndex === bodyIndex,
  );
  if (!sub || !sub.visible) return null;
  return sub;
}

/**
 * mesh 의 edge segment 추출. BRep wireframe 가 있으면 그 polyline segment 사용 (한 BRep edge =
 * 같은 brepEdgeId 의 연속 segment 들). 없으면 mesh tessellation EdgesGeometry fallback.
 */
function getEdges(mesh: THREE.Mesh): EdgeSegment[] {
  const geom = mesh.geometry;
  if (edgeCache.has(geom)) return edgeCache.get(geom)!;

  const segments: EdgeSegment[] = [];
  const wireframe = getBRepWireframe(mesh);

  if (wireframe) {
    let edgeIdx = 0;
    for (const child of wireframe.children) {
      if (!(child instanceof THREE.Line)) continue;
      const pos = child.geometry.getAttribute("position");
      const matWorld = child.matrixWorld;
      for (let i = 0; i < pos.count - 1; i++) {
        const s = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(matWorld);
        const e = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)).applyMatrix4(matWorld);
        segments.push({ start: s, end: e, brepEdgeId: edgeIdx });
      }
      edgeIdx++;
    }
  } else {
    const edgesGeom = new THREE.EdgesGeometry(geom, EDGE_ANGLE_THRESHOLD);
    const pos = edgesGeom.getAttribute("position");
    const matWorld = mesh.matrixWorld;
    for (let i = 0; i < pos.count; i += 2) {
      const s = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(matWorld);
      const e = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)).applyMatrix4(matWorld);
      segments.push({ start: s, end: e, brepEdgeId: -1 });
    }
    edgesGeom.dispose();
  }

  edgeCache.set(geom, segments);
  return segments;
}

/**
 * mesh 의 vertex 추출. BRep wireframe 가 있으면 BRep edge 의 endpoint (closed curve = vertex
 * 없음) 사용. 없으면 mesh edge segment endpoint fallback.
 */
function getVertices(mesh: THREE.Mesh): THREE.Vector3[] {
  const geom = mesh.geometry;
  if (vertexCache.has(geom)) return vertexCache.get(geom)!;

  const unique: THREE.Vector3[] = [];
  const seen = new Set<string>();
  const round = (n: number) => Math.round(n * 1000);
  const addUnique = (p: THREE.Vector3) => {
    const key = `${round(p.x)}_${round(p.y)}_${round(p.z)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p.clone());
    }
  };

  const wireframe = getBRepWireframe(mesh);
  if (wireframe) {
    for (const child of wireframe.children) {
      if (!(child instanceof THREE.Line)) continue;
      const pos = child.geometry.getAttribute("position");
      if (pos.count < 2) continue;
      const matWorld = child.matrixWorld;
      const firstP = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0)).applyMatrix4(matWorld);
      const lastIdx = pos.count - 1;
      const lastP = new THREE.Vector3(pos.getX(lastIdx), pos.getY(lastIdx), pos.getZ(lastIdx)).applyMatrix4(matWorld);
      // closed curve (full circle 등) — vertex 없음
      if (firstP.distanceTo(lastP) < 1e-4) continue;
      addUnique(firstP);
      addUnique(lastP);
    }
  } else {
    const edges = getEdges(mesh);
    for (const seg of edges) {
      addUnique(seg.start);
      addUnique(seg.end);
    }
  }

  vertexCache.set(geom, unique);
  return unique;
}

/**
 * group 의 보이는 몸체 메시(createStepModelGroup 이 만든, userData.bodyIndex 가 숫자인 Mesh)만 모은다 — 픽킹 대상.
 * 꼭짓점 hover/선택 구슬도 group 에 붙는 Mesh 라, 함께 레이캐스트하면 구슬을 맞혀 엉뚱한 bodyIndex 와
 * 구슬의 꼭짓점을 돌려주고 occlusion 검사에서 꼭짓점이 자기 구슬에 가려진다.
 * Raycaster 는 visible 을 보지 않으므로, 숨긴 모델(group)·몸체(mesh)는 traverseVisible 로 여기서 뺀다.
 */
export function getVisibleBodyMeshes(group: THREE.Group): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  group.traverseVisible((child) => {
    if (child instanceof THREE.Mesh && typeof child.userData.bodyIndex === "number") meshes.push(child);
  });
  return meshes;
}

/** ModelManager 가 BRep wireframe 추가/제거 후 호출 — cache invalidate. */
export function invalidateEdgeCacheForGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      edgeCache.delete(obj.geometry);
      vertexCache.delete(obj.geometry);
    }
  });
}

/**
 * brepEdgeId 단위 polyline highlight geometry 생성.
 * - brepEdgeId === -1: 단일 segment (start, end) — LineSegments
 * - 그 외: 같은 brepEdgeId 의 모든 segment 를 한 연속 polyline 으로 — Line
 */
function buildEdgeHighlight(
  segments: EdgeSegment[],
  edgeIndex: number,
  group: THREE.Group,
  color: number,
  name: string,
): THREE.Object3D {
  const target = segments[edgeIndex];
  const invMat = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const mat = new THREE.LineBasicMaterial({ color, linewidth: 3, depthTest: false });

  if (target.brepEdgeId < 0) {
    const geom = new THREE.BufferGeometry().setFromPoints([target.start, target.end]);
    geom.applyMatrix4(invMat);
    const line = new THREE.LineSegments(geom, mat);
    line.name = name;
    line.renderOrder = 999;
    return line;
  }

  // 같은 BRep edge 의 segment 들을 순서대로 모아 polyline (segments 가 sampling 순서대로 push 됨).
  const groupSegs = segments.filter((s) => s.brepEdgeId === target.brepEdgeId);
  const points: THREE.Vector3[] = [groupSegs[0].start];
  for (const s of groupSegs) points.push(s.end);
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  geom.applyMatrix4(invMat);
  const line = new THREE.Line(geom, mat);
  line.name = name;
  line.renderOrder = 999;
  return line;
}

// Screen-space distance: point to line segment (pixels)
function screenDistToEdge(
  p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2,
): { dist: number; closest: THREE.Vector2 } {
  const ab = new THREE.Vector2().subVectors(b, a);
  const ap = new THREE.Vector2().subVectors(p, a);
  const len2 = ab.lengthSq();
  if (len2 < 1e-6) return { dist: p.distanceTo(a), closest: a.clone() };
  let t = ap.dot(ab) / len2;
  t = Math.max(0, Math.min(1, t));
  const closest = new THREE.Vector2().addVectors(a, ab.multiplyScalar(t));
  return { dist: p.distanceTo(closest), closest };
}

function projectToScreen(
  point: THREE.Vector3, camera: THREE.Camera, width: number, height: number,
): THREE.Vector2 | null {
  const ndc = point.clone().project(camera);
  if (ndc.z < -1 || ndc.z > 1) return null; // behind camera
  return new THREE.Vector2((ndc.x + 1) * 0.5 * width, (-ndc.y + 1) * 0.5 * height);
}

/**
 * StepModelData로부터 Three.js Group을 생성
 * 공식 예제 BuildMesh 패턴 그대로 구현
 */
export const createStepModelGroup = (
  model: StepModelData,
): THREE.Group => {
  const group = new THREE.Group();
  group.name = `step-model-${model.id}`;
  group.userData.stepModelId = model.id;

  let globalFaceOffset = 0;

  for (let bodyIndex = 0; bodyIndex < model.bodies.length; bodyIndex++) {
    const bodyData = model.bodies[bodyIndex];
    const geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(bodyData.positions, 3),
    );
    if (bodyData.normals.length > 0) {
      geometry.setAttribute(
        "normal",
        new THREE.Float32BufferAttribute(bodyData.normals, 3),
      );
    }

    const index = Uint32Array.from(bodyData.indices);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));

    const defaultMaterial = new THREE.MeshPhongMaterial({
      color: bodyData.color ? new THREE.Color(bodyData.color) : 0xcccccc,
      specular: 0,
      side: THREE.DoubleSide,
    });
    const materials: THREE.MeshPhongMaterial[] = [defaultMaterial];

    if (bodyData.brepFaces.length > 0) {
      // face별 material 생성
      for (const face of bodyData.brepFaces) {
        const color = face.color
          ? new THREE.Color(face.color)
          : defaultMaterial.color;
        materials.push(new THREE.MeshPhongMaterial({
          color,
          specular: 0,
          side: THREE.DoubleSide,
        }));
      }

      // 공식 예제의 addGroup 로직 — brep_faces의 first/last는 삼각형 인덱스
      const triangleCount = bodyData.indices.length / 3;
      let triangleIndex = 0;
      let faceGroupIndex = 0;

      while (triangleIndex < triangleCount) {
        const firstIndex = triangleIndex;
        let lastIndex: number;
        let materialIndex: number;

        if (faceGroupIndex >= bodyData.brepFaces.length) {
          // 남은 삼각형은 default material
          lastIndex = triangleCount;
          materialIndex = 0;
        } else if (triangleIndex < bodyData.brepFaces[faceGroupIndex].first) {
          // face 시작 전 갭 → default material
          lastIndex = bodyData.brepFaces[faceGroupIndex].first;
          materialIndex = 0;
        } else {
          // face 범위 → face material (last는 inclusive이므로 +1)
          lastIndex = bodyData.brepFaces[faceGroupIndex].last + 1;
          materialIndex = faceGroupIndex + 1;
          faceGroupIndex++;
        }

        geometry.addGroup(
          firstIndex * 3,
          (lastIndex - firstIndex) * 3,
          materialIndex,
        );
        triangleIndex = lastIndex;
      }
    }

    const mesh = new THREE.Mesh(
      geometry,
      materials.length > 1 ? materials : materials[0],
    );
    mesh.name = `mesh-${bodyData.name}`;
    mesh.userData.stepModelId = model.id;
    mesh.userData.faceIdOffset = globalFaceOffset;
    mesh.userData.bodyIndex = bodyIndex;

    group.add(mesh);

    // body edge wireframe (CATIA 스타일 — body 경계를 검은 선으로 표시)
    const edgesGeom = new THREE.EdgesGeometry(geometry, EDGE_ANGLE_THRESHOLD);
    const edgeLine = new THREE.LineSegments(
      edgesGeom,
      new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 }),
    );
    edgeLine.name = `edges-${bodyData.name}`;
    group.add(edgeLine);

    globalFaceOffset += bodyData.brepFaces.length;
  }

  // transform 적용
  const { position, rotation, scale } = model.transform;
  group.position.set(position.x, position.y, position.z);
  group.rotation.set(rotation.x, rotation.y, rotation.z);
  group.scale.setScalar(scale);

  return group;
};

/**
 * face 하이라이트 (emissive 색상 변경)
 */
export const highlightFace = (
  group: THREE.Group,
  faceGroupId: number | null,
): void => {
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    const offset: number = child.userData.faceIdOffset ?? 0;

    for (let i = 0; i < materials.length; i++) {
      const mat = materials[i];
      if (mat instanceof THREE.MeshPhongMaterial) {
        // materials[0]은 default, face는 materials[1+]
        const thisFaceId = i > 0 ? offset + (i - 1) : -1;
        if (faceGroupId !== null && thisFaceId === faceGroupId) {
          mat.emissive.setHex(HIGHLIGHT_EMISSIVE);
        } else {
          mat.emissive.setHex(0x000000);
        }
      }
    }
  });
};

/**
 * 레이캐스트 교차로 face group ID 감지. hit 은 ModelManager 가 모든 모델의 보이는 몸체 메시
 * (getVisibleBodyMeshes)를 한 번에 레이캐스트해 고른 가장 앞의 교차다 — 같은 광선으로 다시 레이캐스트하지 않는다.
 */
export const pickFace = (
  hit: THREE.Intersection,
): { faceGroupId: number; point: THREE.Vector3 } => {
  const hitMesh = hit.object as THREE.Mesh;
  const offset: number = hitMesh.userData.faceIdOffset ?? 0;

  // materialIndex 0은 default, 1+는 face
  if (hit.face) {
    const matIdx = hit.face.materialIndex ?? 0;
    if (matIdx > 0) {
      return { faceGroupId: offset + (matIdx - 1), point: hit.point.clone() };
    }
  }

  return { faceGroupId: offset, point: hit.point.clone() };
};

/**
 * Edge picking: screen-space distance 기반. hit 은 커서 아래 가장 앞의 몸체 교차(pickFace 와 같음),
 * group 은 그 몸체가 속한 모델 — 가림 검사에 그 모델의 보이는 몸체 메시를 쓴다.
 */
export const pickEdge = (
  hit: THREE.Intersection,
  group: THREE.Group,
  camera: THREE.Camera,
  screenWidth: number,
  screenHeight: number,
  mouseScreen: THREE.Vector2,
): { bodyIndex: number; edgeIndex: number; point: THREE.Vector3 } | null => {
  const meshes = getVisibleBodyMeshes(group);
  const hitMesh = hit.object as THREE.Mesh;
  const bodyIndex: number = hitMesh.userData.bodyIndex;
  const edges = getEdges(hitMesh);
  const camPos = camera.position;
  const occlusionRay = new THREE.Raycaster();

  let bestDist = EDGE_PICK_THRESHOLD_PX;
  let bestIdx = -1;
  const bestPoint = new THREE.Vector3();

  for (let i = 0; i < edges.length; i++) {
    const sa = projectToScreen(edges[i].start, camera, screenWidth, screenHeight);
    const sb = projectToScreen(edges[i].end, camera, screenWidth, screenHeight);
    if (!sa || !sb) continue;

    const { dist, closest } = screenDistToEdge(mouseScreen, sa, sb);
    if (dist >= bestDist) continue;

    // edge의 closest point 계산
    const ab = new THREE.Vector2().subVectors(sb, sa);
    const ac = new THREE.Vector2().subVectors(closest, sa);
    const t = ab.lengthSq() > 1e-6 ? ac.dot(ab) / ab.lengthSq() : 0;
    const edgePt = new THREE.Vector3().lerpVectors(edges[i].start, edges[i].end, Math.max(0, Math.min(1, t)));

    // Occlusion check: edge point에서 카메라 방향으로 ray를 쏴서 가려지는지 확인
    const dirToCamera = new THREE.Vector3().subVectors(camPos, edgePt).normalize();
    occlusionRay.set(edgePt.clone().addScaledVector(dirToCamera, 0.01), dirToCamera);
    const occHits = occlusionRay.intersectObjects(meshes);
    const edgeToCamDist = edgePt.distanceTo(camPos);
    // 카메라와 edge 사이에 면이 있으면 가려진 것
    const isOccluded = occHits.some((h) => h.distance < edgeToCamDist - 0.1);
    if (isOccluded) continue;

    bestDist = dist;
    bestIdx = i;
    bestPoint.copy(edgePt);
  }

  if (bestIdx < 0) return null;
  return { bodyIndex, edgeIndex: bestIdx, point: bestPoint };
};

/**
 * Vertex picking: screen-space distance 기반. hit·group 은 pickEdge 와 같다.
 */
export const pickVertex = (
  hit: THREE.Intersection,
  group: THREE.Group,
  camera: THREE.Camera,
  screenWidth: number,
  screenHeight: number,
  mouseScreen: THREE.Vector2,
): { bodyIndex: number; vertexIndex: number; point: THREE.Vector3 } | null => {
  const meshes = getVisibleBodyMeshes(group);
  const hitMesh = hit.object as THREE.Mesh;
  const bodyIndex: number = hitMesh.userData.bodyIndex;
  const vertices = getVertices(hitMesh);
  const camPos = camera.position;
  const occlusionRay = new THREE.Raycaster();

  let bestDist = VERTEX_PICK_THRESHOLD_PX;
  let bestIdx = -1;

  for (let i = 0; i < vertices.length; i++) {
    const sp = projectToScreen(vertices[i], camera, screenWidth, screenHeight);
    if (!sp) continue;
    const dist = mouseScreen.distanceTo(sp);
    if (dist >= bestDist) continue;

    // Occlusion check
    const dirToCamera = new THREE.Vector3().subVectors(camPos, vertices[i]).normalize();
    occlusionRay.set(vertices[i].clone().addScaledVector(dirToCamera, 0.01), dirToCamera);
    const occHits = occlusionRay.intersectObjects(meshes);
    const vtxToCamDist = vertices[i].distanceTo(camPos);
    if (occHits.some((h) => h.distance < vtxToCamDist - 0.1)) continue;

    bestDist = dist;
    bestIdx = i;
  }

  if (bestIdx < 0) return null;
  return { bodyIndex, vertexIndex: bestIdx, point: vertices[bestIdx].clone() };
};

/**
 * Edge highlight: BRep edge 단위 polyline overlay (한 원 = 하나의 부드러운 highlight).
 * Mesh tessellation fallback 의 경우 단일 segment.
 */
export const highlightEdge = (
  group: THREE.Group,
  bodyIndex: number,
  edgeIndex: number | null,
): void => {
  const existing = group.getObjectByName(EDGE_HIGHLIGHT_NAME);
  if (existing) {
    group.remove(existing);
    if (existing instanceof THREE.Line || existing instanceof THREE.LineSegments) {
      existing.geometry.dispose();
    }
  }

  if (edgeIndex === null) return;

  const meshes: THREE.Mesh[] = [];
  group.traverse((child) => { if (child instanceof THREE.Mesh) meshes.push(child); });
  if (bodyIndex >= meshes.length) return;

  const edges = getEdges(meshes[bodyIndex]);
  if (edgeIndex >= edges.length) return;

  group.add(buildEdgeHighlight(edges, edgeIndex, group, EDGE_HOVER_COLOR, EDGE_HIGHLIGHT_NAME));
};

/**
 * Vertex highlight: small sphere overlay
 */
export const highlightVertex = (
  group: THREE.Group,
  bodyIndex: number,
  vertexIndex: number | null,
): void => {
  const existing = group.getObjectByName(VERTEX_HIGHLIGHT_NAME);
  if (existing) { group.remove(existing); (existing as THREE.Mesh).geometry?.dispose(); }

  if (vertexIndex === null) return;

  const meshes: THREE.Mesh[] = [];
  group.traverse((child) => { if (child instanceof THREE.Mesh) meshes.push(child); });
  if (bodyIndex >= meshes.length) return;

  const vertices = getVertices(meshes[bodyIndex]);
  if (vertexIndex >= vertices.length) return;

  const pos = vertices[vertexIndex].clone();
  // group 로컬 좌표로 변환
  const invMat = new THREE.Matrix4().copy(group.matrixWorld).invert();
  pos.applyMatrix4(invMat);

  const geom = new THREE.SphereGeometry(1.2, 8, 8);
  const mat = new THREE.MeshBasicMaterial({ color: VERTEX_HOVER_COLOR, depthTest: false });
  const sphere = new THREE.Mesh(geom, mat);
  sphere.position.copy(pos);
  sphere.name = VERTEX_HIGHLIGHT_NAME;
  sphere.renderOrder = 999;
  group.add(sphere);
};

/**
 * Edge selection (click): BRep edge 단위 polyline. highlightEdge 와 같은 패턴, 색상만 다름.
 */
export const selectEdge = (
  group: THREE.Group,
  bodyIndex: number,
  edgeIndex: number | null,
): void => {
  const existing = group.getObjectByName(EDGE_SELECT_NAME);
  if (existing) {
    group.remove(existing);
    if (existing instanceof THREE.Line || existing instanceof THREE.LineSegments) {
      existing.geometry.dispose();
    }
  }
  if (edgeIndex === null) return;

  const meshes: THREE.Mesh[] = [];
  group.traverse((child) => { if (child instanceof THREE.Mesh) meshes.push(child); });
  if (bodyIndex >= meshes.length) return;

  const edges = getEdges(meshes[bodyIndex]);
  if (edgeIndex >= edges.length) return;

  const line = buildEdgeHighlight(edges, edgeIndex, group, EDGE_SELECT_COLOR, EDGE_SELECT_NAME);
  // select 는 hover (999) 위에 그려져야 함 — pointermove 마다 hover 가 group children 끝에 재추가되므로
  // renderOrder 로 명시. 같은 톤이라 색만으로는 구분이 약함.
  line.renderOrder = 1000;
  group.add(line);
};

/**
 * Vertex selection (click): green sphere, persists until cleared
 */
export const selectVertex = (
  group: THREE.Group,
  bodyIndex: number,
  vertexIndex: number | null,
): void => {
  const existing = group.getObjectByName(VERTEX_SELECT_NAME);
  if (existing) { group.remove(existing); (existing as THREE.Mesh).geometry?.dispose(); }
  if (vertexIndex === null) return;

  const meshes: THREE.Mesh[] = [];
  group.traverse((child) => { if (child instanceof THREE.Mesh) meshes.push(child); });
  if (bodyIndex >= meshes.length) return;

  const vertices = getVertices(meshes[bodyIndex]);
  if (vertexIndex >= vertices.length) return;

  const pos = vertices[vertexIndex].clone();
  const invMat = new THREE.Matrix4().copy(group.matrixWorld).invert();
  pos.applyMatrix4(invMat);

  const geom = new THREE.SphereGeometry(1.5, 8, 8);
  const mat = new THREE.MeshBasicMaterial({ color: VERTEX_SELECT_COLOR, depthTest: false });
  const sphere = new THREE.Mesh(geom, mat);
  sphere.position.copy(pos);
  sphere.name = VERTEX_SELECT_NAME;
  // select 는 hover (999) 위에 그려져야 함 — pointermove 마다 hover sphere 가 children 끝에 재추가되므로
  // renderOrder 로 명시. 같은 톤이라 색만으로는 구분이 약함.
  sphere.renderOrder = 1000;
  group.add(sphere);
};

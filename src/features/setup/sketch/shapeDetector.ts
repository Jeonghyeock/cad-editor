// Shape 탐지: coincident 구속 기반 닫힌 루프 탐색
// half-edge + angle-sorted 최소 면 탐색 (planar graph face enumeration)

import type { SerializedGeometry } from "../Setup.type";

import type { SketchConstraint } from "./constraints/SketchConstraint.type";

// Shape 타입
export type SketchShape = {
  id: string;                    // lineIds 기반 stable ID
  lineIds: string[];             // 구성 geometry ID (체인 순서)
  planeKey: string;
  sceneIndex?: number;           // 해당 씬 인덱스
  sceneRange?: { from: number; to: number }; // 유효 씬 범위
  baseAngle: number;             // 절대 각도
  holes: SketchShape[];          // 미사용 (호환성 유지)
  vertices: { x: number; y: number }[];  // 캐시된 vertices (recomputeShapes마다 갱신)
  /**
   * shape 출처:
   *  - "declared": 도구가 명시적으로 registerShape 호출 (Rectangle / Elongated Hole / Profile 등)
   *  - "detected": recomputeShapes 가 free-hand line 으로 만든 closed loop 를 자동 감지
   *
   * declared 는 도구가 제어. detected 는 매 recomputeShapes 마다 재계산 → 사라진 free-hand
   * closed loop 는 자동 제거, 새로 생긴 건 자동 추가.
   * 직렬화: SerializedSketch.shapes[].origin 도 함께 저장 (구 버전 파일은 undefined → declared 로 fallback).
   */
  origin?: "declared" | "detected";
  /**
   * 이미지 배경 — base64 dataURL. 사각형 4 segments 의 polygon shape 안에
   * 이미지 표시 (problem-definition 의 Insert Image 패턴).
   */
  image?: string;
  /** 이미지 visibility 토글 (true 기본). */
  imageVisibility?: boolean;
};

type PointKey = string; // "geomId:vertexIndex"

function makePointKey(geomId: string, vertexIndex: number): PointKey {
  return `${geomId}:${vertexIndex}`;
}

/**
 * geometry 의 두 endpoint vertexIndex 반환.
 *
 * vertex 모델 (SketchGeometryStore._getVertices 와 정합):
 *  - line:  0 = start, 1 = end
 *  - arc:   0 = center, 1 = start, 2 = end  ← arc 의 endpoint 는 1/2 (center 는 endpoint 아님)
 *  - curve: 0 = first, last = end
 *
 * arc 를 0/1 로 잘못 매핑하면 elongated hole 등의 line ↔ arc coincident (line.1 ↔ arc.2)
 * 가 union-find 에 등록되지 않아 closed loop detect 가 실패한다.
 */
function getEndpointIndices(geom: SerializedGeometry): [number, number] | null {
  switch (geom.type) {
    case "line":
      return [0, 1];
    case "arc":
      return [1, 2];
    case "curve":
      if (geom.points.length >= 2) return [0, geom.points.length - 1];
      return null;
    default:
      return null;
  }
}

function getEndpointKeys(geomId: string, geom: SerializedGeometry): [PointKey, PointKey] | null {
  const idx = getEndpointIndices(geom);
  if (!idx) return null;
  return [makePointKey(geomId, idx[0]), makePointKey(geomId, idx[1])];
}

/** geometry 의 vertex 좌표 (vertex 모델은 getEndpointIndices 주석 참조). */
function getVertexCoord(geom: SerializedGeometry, vertexIndex: number): { x: number; y: number } | null {
  switch (geom.type) {
    case "line":
      return vertexIndex === 0 ? { x: geom.x1, y: geom.y1 } : { x: geom.x2, y: geom.y2 };
    case "arc":
      // 0 = center 는 endpoint 아님. 1 = start, 2 = end.
      if (vertexIndex === 1)
        return { x: geom.cx + geom.r * Math.cos(geom.startAngle), y: geom.cy + geom.r * Math.sin(geom.startAngle) };
      if (vertexIndex === 2)
        return { x: geom.cx + geom.r * Math.cos(geom.endAngle), y: geom.cy + geom.r * Math.sin(geom.endAngle) };
      return null;
    case "curve":
      if (geom.points.length < 2) return null;
      if (vertexIndex === 0) return geom.points[0];
      if (vertexIndex === geom.points.length - 1) return geom.points[geom.points.length - 1];
      return null;
    default:
      return null;
  }
}

// --- Half-Edge 구조 ---

type HalfEdge = {
  id: string;          // "geomId:fwd" or "geomId:rev"
  geomId: string;
  fromNode: PointKey;  // 등가 클래스 대표
  toNode: PointKey;
  angle: number;       // fromNode에서 toNode 방향 각도 (atan2)
  twin: HalfEdge | null; // 반대 방향
  next: HalfEdge | null; // 같은 face에서 다음 half-edge (angle sort 후 결정)
  used: boolean;
};

/**
 * coincident 구속 기반으로 닫힌 루프 탐지 → SketchShape 배열 반환
 *
 * 알고리즘 (half-edge planar face enumeration):
 * 1. coincident 구속으로 point 등가 클래스(union-find) 구축
 * 2. 각 geometry edge → 2개 half-edge (정방향 + 역방향) 생성
 * 3. 각 노드에서 출발하는 half-edge를 각도 순 정렬
 * 4. twin의 다음 CCW half-edge를 next로 연결 (planar embedding)
 * 5. next 체인을 따라가면 최소 면(minimal face) 완성
 * 6. CCW(양수 면적) 면만 Shape으로 등록
 * 7. 자체 닫힌 도형 (circle, ellipse) → 독립 Shape
 */
export function detectClosedShapes(
  geometries: Map<string, SerializedGeometry>,
  constraints: Map<string, SketchConstraint>,
  /**
   * 이미 declared shape 으로 등록된 lineIds — 해당 geometry 는 union-find / half-edge 에서
   * 제외. 도메인 정합: design area / obstacle / EE 가 서로 겹쳐도 각자 자기 declared shape
   * 으로 독립 유지되어야 함. detect 알고리즘은 free-hand 로 그린 line/arc 만 보조 처리.
   */
  excludeLineIds: ReadonlySet<string> = new Set(),
): SketchShape[] {
  const shapes: SketchShape[] = [];

  // 1. coincident union-find
  const parent = new Map<PointKey, PointKey>();
  function find(k: PointKey): PointKey {
    let root = k;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    let curr = k;
    while (curr !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  }
  function union(a: PointKey, b: PointKey) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // 노드 좌표 수집 (등가 클래스 대표 → 좌표)
  const nodeCoord = new Map<PointKey, { x: number; y: number }>();

  for (const [geomId, geom] of geometries) {
    if ("isReference" in geom && geom.isReference) continue;
    if ("isConstruction" in geom && geom.isConstruction) continue;
    if (excludeLineIds.has(geomId)) continue;
    const indices = getEndpointIndices(geom);
    if (!indices) continue;
    const keys: [PointKey, PointKey] = [makePointKey(geomId, indices[0]), makePointKey(geomId, indices[1])];
    if (!parent.has(keys[0])) parent.set(keys[0], keys[0]);
    if (!parent.has(keys[1])) parent.set(keys[1], keys[1]);
    const c0 = getVertexCoord(geom, indices[0]);
    const c1 = getVertexCoord(geom, indices[1]);
    if (c0) nodeCoord.set(keys[0], c0);
    if (c1) nodeCoord.set(keys[1], c1);
  }

  for (const c of constraints.values()) {
    if (c.type !== "coincident") continue;
    const ka = makePointKey(c.pointA.geomId, c.pointA.vertexIndex);
    const kb = makePointKey(c.pointB.geomId, c.pointB.vertexIndex);
    if (parent.has(ka) && parent.has(kb)) union(ka, kb);
  }

  // 등가 클래스 대표의 좌표 결정 (첫 번째 발견된 좌표 사용)
  const repCoord = new Map<PointKey, { x: number; y: number }>();
  for (const [key, coord] of nodeCoord) {
    const rep = find(key);
    if (!repCoord.has(rep)) repCoord.set(rep, coord);
  }

  // 2. Half-edge 생성
  const allHalfEdges: HalfEdge[] = [];
  const nodeOutgoing = new Map<PointKey, HalfEdge[]>(); // node → 출발하는 half-edge 목록

  for (const [geomId, geom] of geometries) {
    if ("isReference" in geom && geom.isReference) continue;
    if ("isConstruction" in geom && geom.isConstruction) continue;
    if (excludeLineIds.has(geomId)) continue;
    const keys = getEndpointKeys(geomId, geom);
    if (!keys) continue;
    const nodeA = find(keys[0]);
    const nodeB = find(keys[1]);
    if (nodeA === nodeB) continue;

    const cA = repCoord.get(nodeA);
    const cB = repCoord.get(nodeB);
    if (!cA || !cB) continue;

    const angleFwd = Math.atan2(cB.y - cA.y, cB.x - cA.x);
    const angleRev = Math.atan2(cA.y - cB.y, cA.x - cB.x);

    const fwd: HalfEdge = {
      id: `${geomId}:fwd`,
      geomId,
      fromNode: nodeA,
      toNode: nodeB,
      angle: angleFwd,
      twin: null,
      next: null,
      used: false,
    };
    const rev: HalfEdge = {
      id: `${geomId}:rev`,
      geomId,
      fromNode: nodeB,
      toNode: nodeA,
      angle: angleRev,
      twin: null,
      next: null,
      used: false,
    };
    fwd.twin = rev;
    rev.twin = fwd;

    allHalfEdges.push(fwd, rev);

    if (!nodeOutgoing.has(nodeA)) nodeOutgoing.set(nodeA, []);
    if (!nodeOutgoing.has(nodeB)) nodeOutgoing.set(nodeB, []);
    nodeOutgoing.get(nodeA)!.push(fwd);
    nodeOutgoing.get(nodeB)!.push(rev);
  }

  // 3. 각 노드에서 출발 half-edge를 각도 순 정렬 (CCW, parallel edge는 geomId로 안정 정렬)
  for (const [, edges] of nodeOutgoing) {
    edges.sort((a, b) => {
      const da = a.angle - b.angle;
      if (Math.abs(da) > 1e-9) return da;
      // 같은 각도 (parallel edge): geomId로 안정 정렬
      return a.geomId < b.geomId ? -1 : a.geomId > b.geomId ? 1 : 0;
    });
  }

  // 4. next 연결: he(A→B) 도착 노드 B에서, twin(B→A)의 바로 앞(시계 방향 이웃) half-edge를 next로 연결
  for (const he of allHalfEdges) {
    const arrivedNode = he.toNode;
    const outgoing = nodeOutgoing.get(arrivedNode);
    if (!outgoing || outgoing.length === 0) continue;

    const idx = outgoing.indexOf(he.twin!);
    if (idx < 0) continue;
    // twin 의 시계 방향 이웃 = 진행 방향에서 가장 왼쪽으로 꺾는 edge → 왼쪽 최소 면을 CCW 로 돈다.
    // CCW 이웃(가장 오른쪽 꺾기)을 고르면 안쪽 면은 CW 로 돌아 버려지고 바깥 경계만 남아, 나눈 칸·공유 변 사각형을
    // 따로 잡지 못하고 바깥 가지 선이 면에 섞였다. 차수 2 인 노드는 어느 쪽이든 같다.
    const nextIdx = (idx - 1 + outgoing.length) % outgoing.length;
    he.next = outgoing[nextIdx];
  }

  // 5. next 체인을 따라 face 탐색
  const seenShapeKeys = new Set<string>();

  for (const startHe of allHalfEdges) {
    if (startHe.used) continue;

    const faceEdges: HalfEdge[] = [];
    let curr: HalfEdge | null = startHe;
    let valid = true;

    for (let step = 0; step < 200; step++) {
      if (!curr) { valid = false; break; }
      if (curr.used) { valid = false; break; }
      faceEdges.push(curr);
      curr.used = true;

      curr = curr.next;
      if (curr === startHe) break; // 사이클 완성
    }

    if (!valid || faceEdges.length < 2 || curr !== startHe) continue;

    // 면적 계산 (CCW = 양수만 유지, CW = 외부 면 → 스킵)
    // 면 안으로 뻗은 가지 선은 같은 면에서 갔다가 되돌아오므로(정방향·역방향 반변 모두) 면 경계에서 뺀다.
    const faceHalfEdgeIds = new Set(faceEdges.map((e) => e.id));
    const lineIds = faceEdges
      .filter((e) => !faceHalfEdgeIds.has(e.twin!.id))
      .map((e) => e.geomId);
    // 가지만으로 된 면(열린 꺾은선을 한 바퀴 왕복한 것)은 면이 아니다. 왕복 면적은 0 이어야 하지만 부동소수 잔차로
    // 아주 작은 양수가 나와 아래 면적 검사를 통과하기도 한다.
    if (lineIds.length === 0) continue;
    const faceVerts: { x: number; y: number }[] = [];
    for (const e of faceEdges) {
      const c = repCoord.get(e.fromNode);
      if (c) faceVerts.push(c);
    }
    if (faceVerts.length < 2) continue;

    let area = 0;
    for (let i = 0; i < faceVerts.length; i++) {
      const c = faceVerts[i], n = faceVerts[(i + 1) % faceVerts.length];
      area += c.x * n.y - n.x * c.y;
    }
    if (area <= 0) continue; // CW (음수 면적) = 외부 면 → 스킵

    // 중복 체크 (lineIds sorted — 같은 edge set이면 같은 face)
    const uniqueLineIds = [...new Set(lineIds)];
    const shapeKey = [...uniqueLineIds].sort().join(",");
    if (seenShapeKeys.has(shapeKey)) continue;
    seenShapeKeys.add(shapeKey);

    shapes.push({
      id: `shape_${shapeKey}`,
      lineIds: uniqueLineIds,
      planeKey: "",
      baseAngle: 0,
      holes: [],
      vertices: [],
      origin: "detected",
    });
  }

  // 6. 자체 닫힌 도형 (circle, ellipse)
  for (const [geomId, geom] of geometries) {
    if ("isReference" in geom && geom.isReference) continue;
    if ("isConstruction" in geom && geom.isConstruction) continue;
    if (excludeLineIds.has(geomId)) continue;
    if (geom.type === "circle" || geom.type === "ellipse") {
      shapes.push({
        id: `shape_${geomId}`,
        lineIds: [geomId],
        planeKey: "",
        baseAngle: 0,
        holes: [],
        vertices: [],
        origin: "detected",
      });
    }
  }

  // 7. vertices 캐시
  for (const s of shapes) {
    s.vertices = getShapeVerticesFromGeometries(s, geometries);
  }

  return shapes;
}

/**
 * lineIds 를 coincident 구속 chain 으로 정렬해 closed loop 순서로 반환.
 *
 * registerShape 가 호출 시 도구가 어떤 순서로 lineIds 를 push 했든 자동 정렬.
 * elongated hole 처럼 `[line0, line1, arc0, arc1]` 식 concat 결과도 자동으로
 * `[line0, arc0, line1, arc1]` (closed loop 순서) 로 재배열.
 *
 * 알고리즘:
 *  1. 각 lineId 의 endpoint vertex (line 0/1, arc 1/2, curve 0/last) 를 PointKey 로 등록.
 *  2. coincident 구속으로 union-find 등가 클래스 구축 (lineIds 안의 vertex 만).
 *  3. node → 인접 lineId 들 그래프 구축.
 *  4. lineIds[0] 부터 greedy chain: 다음 노드의 adjacency 중 미사용 lineId 선택.
 *  5. chain 이 모든 lineId 를 포함하면 정렬 결과 반환. 아니면 원본 그대로 (fallback).
 */
export function orderLineIdsByCoincidence(
  lineIds: string[],
  geometries: Map<string, SerializedGeometry>,
  constraints: Map<string, SketchConstraint>,
): string[] {
  if (lineIds.length <= 1) return [...lineIds];

  // 1. lineIds 의 endpoint vertex 키 등록
  const parent = new Map<PointKey, PointKey>();
  const find = (k: PointKey): PointKey => {
    let root = k;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    let curr = k;
    while (curr !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  };
  const union = (a: PointKey, b: PointKey): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const idToVertices = new Map<string, [number, number]>();
  for (const id of lineIds) {
    const geom = geometries.get(id);
    if (!geom) continue;
    const indices = getEndpointIndices(geom);
    if (!indices) continue;
    idToVertices.set(id, indices);
    const k0 = makePointKey(id, indices[0]);
    const k1 = makePointKey(id, indices[1]);
    if (!parent.has(k0)) parent.set(k0, k0);
    if (!parent.has(k1)) parent.set(k1, k1);
  }

  // 2. coincident 구속 union (lineIds 안의 vertex 끼리만)
  for (const c of constraints.values()) {
    if (c.type !== "coincident") continue;
    const ka = makePointKey(c.pointA.geomId, c.pointA.vertexIndex);
    const kb = makePointKey(c.pointB.geomId, c.pointB.vertexIndex);
    if (parent.has(ka) && parent.has(kb)) union(ka, kb);
  }

  // 3. lineId 별 두 endpoint 의 node (등가 클래스 대표) 추출
  const idToNodes = new Map<string, [PointKey, PointKey]>();
  for (const [id, indices] of idToVertices) {
    const na = find(makePointKey(id, indices[0]));
    const nb = find(makePointKey(id, indices[1]));
    idToNodes.set(id, [na, nb]);
  }

  // 4. node → lineId 들 adjacency
  const nodeAdjacency = new Map<PointKey, string[]>();
  for (const [id, [na, nb]] of idToNodes) {
    if (!nodeAdjacency.has(na)) nodeAdjacency.set(na, []);
    if (!nodeAdjacency.has(nb)) nodeAdjacency.set(nb, []);
    nodeAdjacency.get(na)!.push(id);
    nodeAdjacency.get(nb)!.push(id);
  }

  // 5. greedy chain 시작 — lineIds[0] 의 임의 endpoint 부터
  const first = lineIds[0];
  const firstNodes = idToNodes.get(first);
  if (!firstNodes) return [...lineIds];

  const result: string[] = [first];
  const used = new Set<string>([first]);
  // first 의 두 endpoint 중 firstNodes[1] 쪽을 "진행 방향 끝점" 으로 (임의 선택 — closed loop
  // 라면 어느 쪽에서 시작해도 동일 cycle 을 한 번 돈다).
  let nextNode: PointKey = firstNodes[1];

  while (result.length < lineIds.length) {
    const adj = nodeAdjacency.get(nextNode) ?? [];
    const nextId = adj.find((aid) => !used.has(aid));
    if (!nextId) break; // chain 끊김
    result.push(nextId);
    used.add(nextId);
    const nodes = idToNodes.get(nextId)!;
    // nextId 가 nextNode 와 연결된 endpoint 의 반대 쪽이 다음 진행 끝점.
    const arrivedNode = nextNode;
    nextNode = nodes[0] === arrivedNode ? nodes[1] : nodes[0];
  }

  // chain 이 모든 lineId 를 포함하면 사용. 아니면 fallback (원본 순서).
  return result.length === lineIds.length ? result : [...lineIds];
}

/** Shape의 vertices 계산 (lineIds에서 endpoint 좌표 추출, 체인 순서) */
/**
 * Shape 의 polygon vertices 추출 — closed loop chain 따라 진행 방향대로.
 *
 * shape.lineIds 는 registerShape 가 closed loop 순서로 정렬해서 보관. 이 함수는 그 순서를
 * 따라 각 geometry 의 endpoint 를 chain 으로 잇고, arc 의 경우 진행 방향에 맞춰 sampling.
 *
 * arc 의 sampling 방향: arc 의 vertex 1 = start (startAngle 위치), vertex 2 = end (endAngle 위치).
 * 진행이 vertex 1 → vertex 2 면 순방향 (startAngle → endAngle), vertex 2 → vertex 1 면 역방향.
 * 이게 자동 판별 안 되면 elongated hole 같은 케이스에서 polygon 이 self-intersecting 되어
 * face mesh 가 꼬임.
 *
 * 단독 lineId (circle / ellipse) 은 자체 closed 라 24 점 sampling.
 */
export function getShapeVerticesFromGeometries(
  shape: SketchShape,
  geometries: Map<string, SerializedGeometry>,
): { x: number; y: number }[] {
  const ids = shape.lineIds;
  if (ids.length === 0) return [];

  // 단독 lineId — circle / ellipse 자체 closed
  if (ids.length === 1) {
    const geom = geometries.get(ids[0]);
    if (!geom) return [];
    if (geom.type === "circle") {
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        pts.push({ x: geom.cx + geom.r * Math.cos(a), y: geom.cy + geom.r * Math.sin(a) });
      }
      return pts;
    }
    if (geom.type === "ellipse") {
      const cosR = Math.cos(geom.rotation), sinR = Math.sin(geom.rotation);
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const px = geom.rx * Math.cos(a), py = geom.ry * Math.sin(a);
        pts.push({ x: geom.cx + px * cosR - py * sinR, y: geom.cy + px * sinR + py * cosR });
      }
      return pts;
    }
    // line / arc / curve 단독은 closed 가 아니지만 호환성 — endpoint 만 반환
    const indices = getEndpointIndices(geom);
    if (!indices) return [];
    const c0 = getVertexCoord(geom, indices[0]);
    const c1 = getVertexCoord(geom, indices[1]);
    return [c0, c1].filter((p): p is { x: number; y: number } => p !== null);
  }

  // 다중 edge closed loop — chain 따라 진행
  type EP = { idx: number; coord: { x: number; y: number } };
  const lineIdToEPs = new Map<string, [EP, EP]>();
  for (const id of ids) {
    const geom = geometries.get(id);
    if (!geom) continue;
    const indices = getEndpointIndices(geom);
    if (!indices) continue;
    const c0 = getVertexCoord(geom, indices[0]);
    const c1 = getVertexCoord(geom, indices[1]);
    if (!c0 || !c1) continue;
    lineIdToEPs.set(id, [
      { idx: indices[0], coord: c0 },
      { idx: indices[1], coord: c1 },
    ]);
  }

  // 좌표 tolerance 기반 인접 판정 — coincident 구속으로 묶여 있어도 솔버 결과 미세 차이 흡수.
  const TOL = 1e-2;
  const closer = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
    Math.hypot(a.x - b.x, a.y - b.y) < TOL;

  // 첫 lineId 의 "start" endpoint 결정 — closed loop 는 last.end → first.start 로 닫히므로
  // last 와 공유되는 endpoint 가 first 의 start (= 첫 iteration 의 시작점).
  const firstEPs = lineIdToEPs.get(ids[0]);
  const lastEPs = lineIdToEPs.get(ids[ids.length - 1]);
  if (!firstEPs || !lastEPs) return [];
  const first0SharedWithLast =
    closer(firstEPs[0].coord, lastEPs[0].coord) || closer(firstEPs[0].coord, lastEPs[1].coord);
  let currStart: EP = first0SharedWithLast ? firstEPs[0] : firstEPs[1];

  const result: { x: number; y: number }[] = [];

  for (const id of ids) {
    const geom = geometries.get(id);
    if (!geom) continue;
    const eps = lineIdToEPs.get(id);
    if (!eps) continue;

    // 두 endpoint 중 currStart 와 가까운 쪽이 이 edge 의 "시작", 반대가 "끝"
    const startEP = closer(eps[0].coord, currStart.coord) ? eps[0] : eps[1];
    const endEP = startEP === eps[0] ? eps[1] : eps[0];

    // 시작 vertex 좌표 push (끝 vertex 는 다음 iteration 의 시작과 같아 중복 push 안 함)
    result.push(startEP.coord);

    // arc 의 경우 진행 방향에 맞춰 중간 점 sampling
    if (geom.type === "arc") {
      const startA = geom.startAngle, endA = geom.endAngle;
      let sweep = endA - startA;
      if (sweep <= 0) sweep += Math.PI * 2;
      const segs = Math.max(4, Math.ceil((sweep / (Math.PI * 2)) * 24));
      // startEP.idx === 2 (endAngle 위치) 에서 시작 → 역방향 sampling
      const reverse = startEP.idx === 2;
      for (let s = 1; s < segs; s++) {
        const t = reverse ? 1 - s / segs : s / segs;
        const a = startA + t * sweep;
        result.push({ x: geom.cx + geom.r * Math.cos(a), y: geom.cy + geom.r * Math.sin(a) });
      }
    }
    // line / curve 는 중간 점 없음

    currStart = endEP;
  }

  return result;
}

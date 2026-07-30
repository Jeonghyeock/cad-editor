// planegcs Wasm 래퍼 — 기하+구속 → 솔버 실행 → 좌표 역반영
// 매 solve마다 GcsWrapper를 재생성하여 이전 상태 잔류 방지 (stateless)

import { GcsWrapper, init_planegcs_module, SolveStatus as GcsSolveStatus } from "@salusoft89/planegcs";
import type { ModuleStatic, SketchPrimitive } from "@salusoft89/planegcs";

import type { SerializedGeometry, VertexHandle } from "../../Setup.type";
import { extractVertices } from "../../utils/geometryUtils";

import { REF_X_AXIS_ID, REF_Y_AXIS_ID } from "../SketchGeometryStore";

import type { SketchConstraint, SolveStatus } from "./SketchConstraint.type";

// (geomId, vertexIndex) → planegcs point id
export type PointKey = string;
export function makePointKey(geomId: string, vertexIndex: number): PointKey {
  return `${geomId}:${vertexIndex}`;
}

/**
 * line 의 effective direction — direction 이 fixed 인 케이스만 반환:
 * - X axis / Y axis: reference geometry, 좌표 fixed
 * - horizontal constraint: direction (1, 0)
 * - vertical constraint: direction (0, 1)
 * line_line_distance solver 매핑에서 두 line 의 effective direction 이 동일하면 parallel
 * primitive 추가가 redundant 라 skip (over-determined 회피).
 */
function getEffectiveLineDirection(
  geomId: string,
  constraints: Map<string, SketchConstraint>,
): "h" | "v" | null {
  if (geomId === REF_X_AXIS_ID) return "h";
  if (geomId === REF_Y_AXIS_ID) return "v";
  for (const c of constraints.values()) {
    if (c.type === "horizontal" && c.line?.geomId === geomId) return "h";
    if (c.type === "vertical" && c.line?.geomId === geomId) return "v";
  }
  return null;
}

export class SketchConstraintSolver {
  private _module: ModuleStatic | null = null;

  // 프리미티브 캐시 — 토폴로지 변경 시만 재구축 (드래그 중 좌표만 갱신)
  private _cachedPrimitives: SketchPrimitive[] | null = null;
  private _cacheKey: string | null = null;
  // 캐시된 매핑 정보 (좌표 갱신 시 필요)
  private _cachedPointRegistry: Map<PointKey, string> | null = null;
  private _cachedUnionFind: Map<PointKey, PointKey> | null = null;
  private _cachedFind: ((k: PointKey) => PointKey) | null = null;

  get isReady(): boolean {
    return this._module !== null;
  }

  // 캐시된 ID 매핑 (캐시 히트 시 역반영에 사용)
  private _cachedLineIdMap: Map<string, string> | null = null;
  private _cachedCircleIdMap: Map<string, string> | null = null;
  private _cachedArcIdMap: Map<string, string> | null = null;
  private _cachedEllipseIdMap: Map<string, string> | null = null;

  /** 외부(formula 평가 후 등)에서 강제 캐시 무효화 — value만 변경된 경우 반영 보장 */
  invalidateCache(): void { this._invalidateCache(); }

  // 캐시 무효화 (토폴로지 변경 시 자동 감지되므로 외부 호출 불필요)
  // 주의: cache key는 ID+type만 포함, value 미포함.
  // value 변경은 항상 remove+add 패턴으로 ID가 변경되므로 cache miss가 자동 발생.
  private _invalidateCache(): void {
    this._cachedPrimitives = null;
    this._cacheKey = null;
    this._cachedPointRegistry = null;
    this._cachedUnionFind = null;
    this._cachedFind = null;
    this._cachedLineIdMap = null;
    this._cachedCircleIdMap = null;
    this._cachedArcIdMap = null;
    this._cachedEllipseIdMap = null;
  }

  // 토폴로지 해시: 기하 ID + 구속 ID 정렬 결합
  private _computeCacheKey(
    geometries: Map<string, SerializedGeometry>,
    constraints: Map<string, SketchConstraint>,
  ): string {
    // 기하 ID + 타입 (타입 변경도 감지)
    const geomParts: string[] = [];
    for (const [id, g] of geometries) {
      geomParts.push(`${id}:${g.type}`);
    }
    geomParts.sort();

    const constParts: string[] = [];
    for (const [id, c] of constraints) {
      constParts.push(`${id}:${c.type}`);
    }
    constParts.sort();

    return geomParts.join("|") + "||" + constParts.join("|");
  }

  async init(): Promise<void> {
    if (this._module) return;
    // planegcs wasm 의 stdout 메시지 (예: "Sketcher::RedundantSolving-DogLeg-",
    // "Sketcher Redundant solving: 1 redundants", "Solving with DogLeg") 는 정보성이라 콘솔 차단.
    // stderr (실제 에러) 만 console.error 로 노출.
    // (Module.print 옵션은 planegcs.js glue 가 EM_JS / fd_write 를 직접 console.log 호출
    //  하므로 무시됨 — 실제 차단은 solve() 내부의 _runWithSilencedSolverLogs 에서 console.log
    //  monkey-patch 로 처리.)
    this._module = await init_planegcs_module({
      print: () => {},
      printErr: (msg: string) => console.error(msg),
    });
  }

  /**
   * planegcs wasm 의 solver-stdout (DogLeg / RedundantSolving / Sketcher::*) 만 차단하면서
   * fn() 실행. fn 안에서 발생한 다른 console.log 은 통과.
   * Module.print 콜백이 wasm glue 에서 무시되므로 console.log 자체를 잠시 필터링.
   */
  private _runWithSilencedSolverLogs<T>(fn: () => T): T {
    // eslint-disable-next-line no-console
    const original = console.log;
    // eslint-disable-next-line no-console
    console.log = (...args: unknown[]) => {
      const head = typeof args[0] === "string" ? args[0] : "";
      if (
        head.startsWith("Sketcher::") ||
        head.startsWith("Sketcher Redundant") ||
        head.startsWith("Solving with ")
      ) {
        return;
      }
      original.apply(console, args);
    };
    try {
      return fn();
    } finally {
      // eslint-disable-next-line no-console
      console.log = original;
    }
  }

  // 기하+구속 → 솔버 실행 → 기하 좌표 수정
  // fixedPointKeys: 드래그 중 고정할 점 키 집합 ("geomId:vertexIndex")
  // 반환: { status, dof } — dof는 자유도 (-1 = 미계산)
  solve(
    geometries: Map<string, SerializedGeometry>,
    constraints: Map<string, SketchConstraint>,
    fixedPointKeys?: Set<PointKey>,
  ): { status: SolveStatus; dof: number } {
    if (!this._module) return { status: "error", dof: -1 };

    const cacheKey = this._computeCacheKey(geometries, constraints);
    const canReuseCache = cacheKey === this._cacheKey
      && this._cachedPrimitives !== null
      && this._cachedPointRegistry !== null
      && this._cachedFind !== null;

    let primitives: SketchPrimitive[];
    let pointRegistry: Map<PointKey, string>;
    let pointCoords: Map<string, { x: number; y: number }>;
    let find: (k: PointKey) => PointKey;
    let vertexMap: Map<string, VertexHandle[]>;
    let lineIdMap: Map<string, string>;
    let circleIdMap: Map<string, string>;
    let arcIdMap: Map<string, string>;
    let ellipseIdMap: Map<string, string>;

    if (canReuseCache) {
      // --- 캐시 히트: 좌표만 갱신 ---
      pointRegistry = this._cachedPointRegistry!;
      find = this._cachedFind!;

      // 좌표 맵 재구축 — cluster 첫 set 만 유지 (cache miss path 의 union-find build 와 동일
      // 정책). reference cluster 의 경우 reference vertex 가 가장 먼저 처리되도록 geometries
      // 순회 순서 의존 (injectReferenceGeometry 가 REF_ORIGIN 을 먼저 추가하니 OK). 매번
      // 덮어쓰면 drag 시 사각형 vertex (mouse 위치) 가 origin cluster 좌표를 override 해
      // origin coincident 무시되는 문제 발생.
      pointCoords = new Map();
      vertexMap = new Map();
      for (const geom of geometries.values()) {
        const verts = extractVertices(geom);
        vertexMap.set(geom.id, verts);
        for (const v of verts) {
          const key = makePointKey(v.geomId, v.vertexIndex);
          const pid = pointRegistry.get(key);
          if (!pid) continue;
          if (pointCoords.has(pid)) {
            // reference cluster 는 reference vertex 의 좌표 유지 (origin → (0,0)).
            if (this._clusterHasReference(pid, pointRegistry, find, geometries)) continue;
            // 일반 cluster 는 마지막 vertex 의 좌표로 업데이트 (drag 된 vertex 좌표 반영).
          }
          pointCoords.set(pid, { x: v.x, y: v.y });
        }
      }

      // 드래그 점 좌표 보정 — 단 cluster 에 reference 기하 (REF_ORIGIN_ID / REF_X_AXIS_ID /
      // REF_Y_AXIS_ID) 의 vertex 가 섞여 있으면 그 reference vertex 의 stored 좌표 (origin →
      // (0,0)) 를 유지해야 함. 안 그러면 사각형 vertex 가 origin 과 coincident 된 채 드래그될
      // 때 mouse 위치가 cluster 좌표로 override 되어 origin 이 mouse 위치로 끌려감.
      if (fixedPointKeys) {
        for (const key of fixedPointKeys) {
          const root = find(key);
          const pid = pointRegistry.get(root);
          if (!pid) continue;
          // cluster 가 reference vertex 를 포함하면 fixedKey 좌표 보정 skip — vertexMap 순회에서
          // 이미 reference 의 stored 좌표가 cluster 에 등록되어 있음 (REF_ origin/axis 는 sketch
          // 진입 시점에 가장 먼저 inject 되어 pointCoords 첫 set 차지).
          if (this._clusterHasReference(pid, pointRegistry, find, geometries)) continue;
          const sepIdx = key.lastIndexOf(":");
          const geomId = key.slice(0, sepIdx);
          const vi = parseInt(key.slice(sepIdx + 1), 10);
          const geom = geometries.get(geomId);
          if (!geom) continue;
          const verts = extractVertices(geom);
          const v = verts.find((h) => h.vertexIndex === vi);
          if (v) pointCoords.set(pid, { x: v.x, y: v.y });
        }
      }

      // 캐시된 프리미티브의 좌표 갱신
      primitives = this._cachedPrimitives!.map((p) => {
        if (p.type === "point") {
          const coord = pointCoords.get(p.id);
          if (coord) return { ...p, x: coord.x, y: coord.y };
        }
        if (p.type === "circle") {
          const geomId = this._findGeomIdByGcsId(p.id, "circle", geometries);
          if (geomId) {
            const geom = geometries.get(geomId);
            if (geom?.type === "circle") return { ...p, radius: geom.r };
          }
        }
        if (p.type === "arc") {
          const geomId = this._findGeomIdByGcsId(p.id, "arc", geometries);
          if (geomId) {
            const geom = geometries.get(geomId);
            if (geom?.type === "arc") return { ...p, radius: geom.r, start_angle: geom.startAngle, end_angle: geom.endAngle };
          }
        }
        if (p.type === "ellipse") {
          const geomId = this._findGeomIdByGcsId(p.id, "ellipse", geometries);
          if (geomId) {
            const geom = geometries.get(geomId);
            if (geom?.type === "ellipse") return { ...p, radmin: Math.min(geom.rx, geom.ry) };
          }
        }
        return p;
      });

      // 드래그 임시 좌표 구속 갱신/추가
      // 기존 drag 프리미티브 제거 후 재추가
      primitives = primitives.filter((p) => !p.id.startsWith("__drag_"));
      if (fixedPointKeys) {
        const addedDragPids = new Set<string>();
        for (const key of fixedPointKeys) {
          const root = find(key);
          const pid = pointRegistry.get(root);
          if (!pid || addedDragPids.has(pid)) continue;
          addedDragPids.add(pid);
          const coord = pointCoords.get(pid);
          if (coord) {
            primitives.push({
              id: `__drag_${pid}_x`, type: "coordinate_x",
              p_id: pid, x: coord.x, temporary: true,
            });
            primitives.push({
              id: `__drag_${pid}_y`, type: "coordinate_y",
              p_id: pid, y: coord.y, temporary: true,
            });
          }
        }
      }

      // 캐시된 ID 맵 사용
      lineIdMap = this._cachedLineIdMap!;
      circleIdMap = this._cachedCircleIdMap!;
      arcIdMap = this._cachedArcIdMap!;
      ellipseIdMap = this._cachedEllipseIdMap!;
    } else {
      // --- 캐시 미스: 전체 재구축 ---
      const buildResult = this._buildPrimitives(geometries, constraints, fixedPointKeys);
      primitives = buildResult.primitives;
      pointRegistry = buildResult.pointRegistry;
      pointCoords = buildResult.pointCoords;
      find = buildResult.find;
      vertexMap = buildResult.vertexMap;
      lineIdMap = buildResult.lineIdMap;
      circleIdMap = buildResult.circleIdMap;
      arcIdMap = buildResult.arcIdMap;
      ellipseIdMap = buildResult.ellipseIdMap;

      // 캐시 저장 (drag 프리미티브 제외한 기본 프리미티브)
      this._cachedPrimitives = primitives.filter((p) => !p.id.startsWith("__drag_"));
      this._cacheKey = cacheKey;
      this._cachedPointRegistry = pointRegistry;
      this._cachedFind = find;
      this._cachedLineIdMap = lineIdMap;
      this._cachedCircleIdMap = circleIdMap;
      this._cachedArcIdMap = arcIdMap;
      this._cachedEllipseIdMap = ellipseIdMap;
    }

    // --- 5. 솔버 실행 ---
    // gcs.solve() / apply_solution() 가 wasm 내부에서 console.log 로 정보성 메시지를 직접
    // 흘리므로 그 구간만 console.log 를 필터링.
    let gcs: GcsWrapper | null = null;
    try {
      gcs = new GcsWrapper(new this._module!.GcsSystem());
      gcs.push_primitives_and_params(primitives);
      const status = this._runWithSilencedSolverLogs(() => gcs!.solve());

      if (status === GcsSolveStatus.Failed) {
        return { status: "over-constrained", dof: -1 };
      }

      this._runWithSilencedSolverLogs(() => gcs!.apply_solution());

      // --- 6. 결과 좌표 역반영 ---
      const solvedPrimitives = gcs.sketch_index.get_primitives();
      const solvedPointCoords = new Map<string, { x: number; y: number }>();
      for (const p of solvedPrimitives) {
        if (p.type === "point") {
          solvedPointCoords.set(p.id, { x: p.x, y: p.y });
        }
      }

      // 기하 좌표 업데이트 — reference geometry (REF_ORIGIN_ID / REF_X_AXIS_ID / REF_Y_AXIS_ID)
      // 는 stored 좌표 불변이어야 함. cluster 좌표가 fixedKeys 보정 등으로 mouse 위치가 됐어도
      // reference vertex 에는 반영 안 함 (last line of defense).
      for (const geom of geometries.values()) {
        if ("isReference" in geom && geom.isReference) continue;
        const verts = vertexMap.get(geom.id);
        if (!verts) continue;
        for (const v of verts) {
          const key = makePointKey(v.geomId, v.vertexIndex);
          const pid = pointRegistry.get(find(key));
          if (!pid) continue;
          const solved = solvedPointCoords.get(pid);
          if (!solved) continue;
          applyVertexCoord(geom, v.vertexIndex, solved.x, solved.y);
        }
      }

      // Circle/Arc/Ellipse 반지름/각도/radmin 역반영
      const reverseCircleMap = new Map<string, string>();
      for (const [geomId, gcsId] of circleIdMap) reverseCircleMap.set(gcsId, geomId);
      const reverseArcMap = new Map<string, string>();
      for (const [geomId, gcsId] of arcIdMap) reverseArcMap.set(gcsId, geomId);
      const reverseEllipseMap = new Map<string, string>();
      for (const [geomId, gcsId] of ellipseIdMap) reverseEllipseMap.set(gcsId, geomId);

      for (const p of solvedPrimitives) {
        if (p.type === "circle") {
          const geomId = reverseCircleMap.get(p.id);
          if (!geomId) continue;
          const geom = geometries.get(geomId);
          if (geom?.type === "circle") geom.r = p.radius;
        }
        if (p.type === "arc") {
          const geomId = reverseArcMap.get(p.id);
          if (!geomId) continue;
          const geom = geometries.get(geomId);
          if (geom?.type === "arc") {
            geom.r = p.radius;
            geom.startAngle = p.start_angle;
            geom.endAngle = p.end_angle;
          }
        }
        if (p.type === "ellipse") {
          const geomId = reverseEllipseMap.get(p.id);
          if (!geomId) continue;
          const geom = geometries.get(geomId);
          if (geom?.type === "ellipse") {
            // radmin = 단반경, 솔버가 변경했을 수 있으므로 역반영
            // applyVertexCoord에서 focus1으로 rx/rotation을 갱신했으므로 ry만 갱신
            geom.ry = p.radmin;
            // rx = 장반경 = sqrt(focusDist² + radmin²)이므로 focus 좌표에서 재계산
            const focusDx = solvedPointCoords.get(pointRegistry.get(find(makePointKey(geomId, 1)))!)?.x;
            const focusDy = solvedPointCoords.get(pointRegistry.get(find(makePointKey(geomId, 1)))!)?.y;
            if (focusDx !== undefined && focusDy !== undefined) {
              const fd = Math.hypot(focusDx - geom.cx, focusDy - geom.cy);
              geom.rx = Math.sqrt(fd * fd + p.radmin * p.radmin);
            }
          }
        }
      }

      if (status === GcsSolveStatus.Success || status === GcsSolveStatus.Converged) {
        // 드래그 중이 아닐 때만 검증 (드래그 중에는 temporary 구속이 DOF를 줄임)
        if (!fixedPointKeys || fixedPointKeys.size === 0) {
          // 치수 구속 만족 여부 사후 검증 — SQP가 Converged를 반환해도
          // 상충하는 구속(예: H+V+angle(50°))은 실제로 만족되지 않음
          if (!validateDimensionConstraints(geometries, constraints)) {
            return { status: "over-constrained", dof: -1 };
          }
          const dof = gcs.gcs.dof();
          if (dof === 0) return { status: "fully-constrained", dof: 0 };
          return { status: "ok", dof };
        }
        return { status: "ok", dof: -1 };
      }
      if (status === GcsSolveStatus.SuccessfulSolutionInvalid) return { status: "error", dof: -1 };
      return { status: "under-constrained", dof: -1 };
    } catch (e) {
      console.error("[SketchConstraintSolver] solve failed:", e);
      return { status: "error", dof: -1 };
    } finally {
      if (gcs) {
        try { gcs.destroy_gcs_module(); } catch { /* 무시 */ }
      }
    }
  }

  /**
   * 같은 cluster (pid) 에 속하는 vertex 중 하나라도 reference geometry (isReference=true) 면 true.
   * coincident union-find 통합으로 reference vertex 와 일반 vertex 가 같은 pid 가 될 수 있는데,
   * 이 경우 cluster 의 좌표는 reference 의 stored 값 (origin → (0,0), axis → (1,0)/(0,1)) 으로
   * 유지되어야 함. drag 좌표 보정에서 이 cluster 의 좌표를 mouse 위치로 override 하지 않기 위함.
   *
   * cluster 크기가 보통 매우 작아 풀 스캔 O(N) 비용 무시할만함.
   */
  private _clusterHasReference(
    pid: string,
    pointRegistry: Map<PointKey, string>,
    _find: (k: PointKey) => PointKey,
    geometries: Map<string, SerializedGeometry>,
  ): boolean {
    for (const [key, mapPid] of pointRegistry) {
      if (mapPid !== pid) continue;
      const sepIdx = key.lastIndexOf(":");
      const geomId = key.slice(0, sepIdx);
      const geom = geometries.get(geomId);
      if (geom && "isReference" in geom && geom.isReference) return true;
    }
    return false;
  }

  // gcs ID → 원본 기하 ID 역매핑 (캐시 히트 시 좌표 갱신용)
  private _findGeomIdByGcsId(
    gcsId: string,
    geomType: "circle" | "arc" | "ellipse",
    _geometries: Map<string, SerializedGeometry>,
  ): string | null {
    const idMap =
      geomType === "circle" ? this._cachedCircleIdMap :
      geomType === "arc" ? this._cachedArcIdMap :
      this._cachedEllipseIdMap;
    if (!idMap) return null;
    for (const [geomId, cachedGcsId] of idMap) {
      if (cachedGcsId === gcsId) return geomId;
    }
    return null;
  }

  // 전체 프리미티브 구축 (캐시 미스 시)
  private _buildPrimitives(
    geometries: Map<string, SerializedGeometry>,
    constraints: Map<string, SketchConstraint>,
    fixedPointKeys?: Set<PointKey>,
  ) {
    // --- 1. PointRegistry 구축 ---
    const pointRegistry = new Map<PointKey, string>();
    const pointCoords = new Map<string, { x: number; y: number }>();
    let nextPointId = 0;

    const unionFind = new Map<PointKey, PointKey>();

    const find = (k: PointKey): PointKey => {
      let root = k;
      while (unionFind.has(root) && unionFind.get(root) !== root) {
        root = unionFind.get(root)!;
      }
      let curr = k;
      while (curr !== root) {
        const next = unionFind.get(curr)!;
        unionFind.set(curr, root);
        curr = next;
      }
      return root;
    };

    const union = (a: PointKey, b: PointKey): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) unionFind.set(rb, ra);
    };

    for (const c of constraints.values()) {
      if (c.type === "coincident") {
        const ka = makePointKey(c.pointA.geomId, c.pointA.vertexIndex);
        const kb = makePointKey(c.pointB.geomId, c.pointB.vertexIndex);
        union(ka, kb);
      }
    }

    const vertexMap = new Map<string, VertexHandle[]>();
    for (const geom of geometries.values()) {
      const verts = extractVertices(geom);
      vertexMap.set(geom.id, verts);
      for (const v of verts) {
        const key = makePointKey(v.geomId, v.vertexIndex);
        const root = find(key);
        if (!pointRegistry.has(root)) {
          const pid = `pt_${nextPointId++}`;
          pointRegistry.set(root, pid);
          pointCoords.set(pid, { x: v.x, y: v.y });
        }
        pointRegistry.set(key, pointRegistry.get(root)!);
      }
    }

    // --- 2. 드래그 점 좌표 보정 ---
    // reference cluster 는 stored ref 좌표 유지 (cache hit 분기와 동일 정책).
    if (fixedPointKeys) {
      for (const key of fixedPointKeys) {
        const root = find(key);
        const pid = pointRegistry.get(root);
        if (!pid) continue;
        if (this._clusterHasReference(pid, pointRegistry, find, geometries)) continue;
        const sepIdx = key.lastIndexOf(":");
        const geomId = key.slice(0, sepIdx);
        const vi = parseInt(key.slice(sepIdx + 1), 10);
        const geom = geometries.get(geomId);
        if (!geom) continue;
        const verts = extractVertices(geom);
        const v = verts.find((h) => h.vertexIndex === vi);
        if (v) pointCoords.set(pid, { x: v.x, y: v.y });
      }
    }

    // --- 3. planegcs 프리미티브 구축 ---
    const primitives: SketchPrimitive[] = [];
    const lineIdMap = new Map<string, string>();
    let nextLineId = 0;

    const refPointKeys = new Set<string>();
    for (const geom of geometries.values()) {
      if ("isReference" in geom && geom.isReference) {
        const verts = extractVertices(geom);
        for (const v of verts) {
          refPointKeys.add(find(makePointKey(v.geomId, v.vertexIndex)));
        }
      }
    }

    const addedPoints = new Set<string>();
    for (const [key, pid] of pointRegistry) {
      if (addedPoints.has(pid)) continue;
      addedPoints.add(pid);
      const coord = pointCoords.get(pid);
      if (!coord) continue;
      const isRefFixed = refPointKeys.has(find(key));
      primitives.push({ id: pid, type: "point", x: coord.x, y: coord.y, fixed: isRefFixed });
    }

    for (const geom of geometries.values()) {
      if (geom.type === "line") {
        const lid = `ln_${nextLineId++}`;
        lineIdMap.set(geom.id, lid);
        const p1Key = makePointKey(geom.id, 0);
        const p2Key = makePointKey(geom.id, 1);
        const p1Id = pointRegistry.get(find(p1Key))!;
        const p2Id = pointRegistry.get(find(p2Key))!;
        primitives.push({ id: lid, type: "line", p1_id: p1Id, p2_id: p2Id });
      }
      if (geom.type === "axis") {
        // axis 를 line primitive 로 변환 — 두 fixed point (origin + direction tip). 사용자가
        // vertex 를 axis 와 perpendicular snap 시 자동 생성되는 point_on_line constraint 가
        // 이 line 을 참조함.
        const lid = `ln_${nextLineId++}`;
        lineIdMap.set(geom.id, lid);
        const p1id = `axpt_${geom.id}_o`;
        const p2id = `axpt_${geom.id}_d`;
        primitives.push({ id: p1id, type: "point", x: 0, y: 0, fixed: true });
        primitives.push({
          id: p2id,
          type: "point",
          x: geom.direction === "h" ? 1 : 0,
          y: geom.direction === "v" ? 1 : 0,
          fixed: true,
        });
        primitives.push({ id: lid, type: "line", p1_id: p1id, p2_id: p2id });
      }
    }

    const circleIdMap = new Map<string, string>();
    const arcIdMap = new Map<string, string>();
    const ellipseIdMap = new Map<string, string>();
    let nextCircleId = 0;
    let nextArcId = 0;
    let nextEllipseId = 0;

    for (const geom of geometries.values()) {
      if (geom.type === "circle") {
        const cid = `circ_${nextCircleId++}`;
        circleIdMap.set(geom.id, cid);
        const centerKey = makePointKey(geom.id, 0);
        const centerId = pointRegistry.get(find(centerKey))!;
        primitives.push({ id: cid, type: "circle", c_id: centerId, radius: geom.r });
      }
      if (geom.type === "arc") {
        const aid = `arc_${nextArcId++}`;
        arcIdMap.set(geom.id, aid);
        const centerKey = makePointKey(geom.id, 0);
        const startKey = makePointKey(geom.id, 1);
        const endKey = makePointKey(geom.id, 2);
        const centerId = pointRegistry.get(find(centerKey))!;
        const startId = pointRegistry.get(find(startKey))!;
        const endId = pointRegistry.get(find(endKey))!;
        primitives.push({
          id: aid, type: "arc", c_id: centerId, start_id: startId, end_id: endId,
          radius: geom.r, start_angle: geom.startAngle, end_angle: geom.endAngle,
        });
        primitives.push({ id: `${aid}_rules`, type: "arc_rules", a_id: aid });
      }
      if (geom.type === "ellipse") {
        const eid = `ell_${nextEllipseId++}`;
        ellipseIdMap.set(geom.id, eid);
        const centerKey = makePointKey(geom.id, 0);
        const focus1Key = makePointKey(geom.id, 1);
        const centerId = pointRegistry.get(find(centerKey))!;
        const focus1Id = pointRegistry.get(find(focus1Key))!;
        const radmin = Math.min(geom.rx, geom.ry);
        primitives.push({ id: eid, type: "ellipse", c_id: centerId, focus1_id: focus1Id, radmin });
        primitives.push({ id: `${eid}_focus1`, type: "internal_alignment_ellipse_focus1", e_id: eid, p1_id: focus1Id });
      }
    }

    // --- 구속조건 → planegcs 프리미티브 변환 ---
    let nextCid = 0;
    for (const c of constraints.values()) {
      if ("isReference" in c && (c as { isReference?: boolean }).isReference) continue;
      const cid = `c_${nextCid++}`;
      switch (c.type) {
        case "coincident": {
          const p1Key = makePointKey(c.pointA.geomId, c.pointA.vertexIndex);
          const p2Key = makePointKey(c.pointB.geomId, c.pointB.vertexIndex);
          const p1Id = pointRegistry.get(find(p1Key));
          const p2Id = pointRegistry.get(find(p2Key));
          if (p1Id && p2Id && p1Id !== p2Id) {
            primitives.push({ id: cid, type: "p2p_coincident", p1_id: p1Id, p2_id: p2Id });
          }
          break;
        }
        case "horizontal": {
          const lid = lineIdMap.get(c.line.geomId);
          if (lid) primitives.push({ id: cid, type: "horizontal_l", l_id: lid });
          break;
        }
        case "vertical": {
          const lid = lineIdMap.get(c.line.geomId);
          if (lid) primitives.push({ id: cid, type: "vertical_l", l_id: lid });
          break;
        }
        case "horizontal_pp": {
          const p1Id = pointRegistry.get(find(makePointKey(c.pointA.geomId, c.pointA.vertexIndex)));
          const p2Id = pointRegistry.get(find(makePointKey(c.pointB.geomId, c.pointB.vertexIndex)));
          if (p1Id && p2Id) {
            primitives.push({ id: cid, type: "horizontal_pp", p1_id: p1Id, p2_id: p2Id });
          }
          break;
        }
        case "vertical_pp": {
          const p1Id = pointRegistry.get(find(makePointKey(c.pointA.geomId, c.pointA.vertexIndex)));
          const p2Id = pointRegistry.get(find(makePointKey(c.pointB.geomId, c.pointB.vertexIndex)));
          if (p1Id && p2Id) {
            primitives.push({ id: cid, type: "vertical_pp", p1_id: p1Id, p2_id: p2Id });
          }
          break;
        }
        case "fix": {
          const pKey = makePointKey(c.point.geomId, c.point.vertexIndex);
          const pid = pointRegistry.get(find(pKey));
          if (pid) {
            primitives.push({ id: `${cid}_x`, type: "coordinate_x", p_id: pid, x: c.x });
            primitives.push({ id: `${cid}_y`, type: "coordinate_y", p_id: pid, y: c.y });
          }
          break;
        }
        case "distance": {
          const p1Key = makePointKey(c.pointA.geomId, c.pointA.vertexIndex);
          const p2Key = makePointKey(c.pointB.geomId, c.pointB.vertexIndex);
          const p1Id = pointRegistry.get(find(p1Key));
          const p2Id = pointRegistry.get(find(p2Key));
          if (p1Id && p2Id) {
            primitives.push({ id: cid, type: "p2p_distance", p1_id: p1Id, p2_id: p2Id, distance: c.value });
          }
          break;
        }
        case "equal": {
          const l1 = lineIdMap.get(c.lineA.geomId);
          const l2 = lineIdMap.get(c.lineB.geomId);
          if (l1 && l2) primitives.push({ id: cid, type: "equal_length", l1_id: l1, l2_id: l2 });
          break;
        }
        case "parallel": {
          const l1 = lineIdMap.get(c.lineA.geomId);
          const l2 = lineIdMap.get(c.lineB.geomId);
          if (l1 && l2) primitives.push({ id: cid, type: "parallel", l1_id: l1, l2_id: l2 });
          break;
        }
        case "perpendicular": {
          const l1 = lineIdMap.get(c.lineA.geomId);
          const l2 = lineIdMap.get(c.lineB.geomId);
          if (l1 && l2) primitives.push({ id: cid, type: "perpendicular_ll", l1_id: l1, l2_id: l2 });
          break;
        }
        case "midpoint": {
          const pKey = makePointKey(c.point.geomId, c.point.vertexIndex);
          const pid = pointRegistry.get(find(pKey));
          const lid = lineIdMap.get(c.line.geomId);
          if (pid && lid) {
            primitives.push({ id: `${cid}_onl`, type: "point_on_line_pl", p_id: pid, l_id: lid });
            primitives.push({ id: `${cid}_bis`, type: "point_on_perp_bisector_pl", p_id: pid, l_id: lid });
          }
          break;
        }
        case "colinear": {
          const l1 = lineIdMap.get(c.lineA.geomId);
          const l2 = lineIdMap.get(c.lineB.geomId);
          if (l1 && l2) {
            primitives.push({ id: `${cid}_par`, type: "parallel", l1_id: l1, l2_id: l2 });
            const l2p1Key = makePointKey(c.lineB.geomId, 0);
            const l2p1Id = pointRegistry.get(find(l2p1Key));
            if (l2p1Id) {
              primitives.push({ id: `${cid}_pol`, type: "point_on_line_pl", p_id: l2p1Id, l_id: l1 });
            }
          }
          break;
        }
        case "concentric": {
          const c1CenterKey = makePointKey(c.circleA.geomId, 0);
          const c2CenterKey = makePointKey(c.circleB.geomId, 0);
          const c1CenterId = pointRegistry.get(find(c1CenterKey));
          const c2CenterId = pointRegistry.get(find(c2CenterKey));
          if (c1CenterId && c2CenterId && c1CenterId !== c2CenterId) {
            primitives.push({ id: cid, type: "p2p_coincident", p1_id: c1CenterId, p2_id: c2CenterId });
          }
          break;
        }
        case "point_on_line": {
          const pKey = makePointKey(c.point.geomId, c.point.vertexIndex);
          const pid = pointRegistry.get(find(pKey));
          const lid = lineIdMap.get(c.line.geomId);
          if (pid && lid) {
            primitives.push({ id: cid, type: "point_on_line_pl", p_id: pid, l_id: lid });
          }
          break;
        }
        case "tangent": {
          const geomA = geometries.get(c.entityA.geomId);
          const geomB = geometries.get(c.entityB.geomId);
          if (!geomA || !geomB) break;
          const aIsLine = geomA.type === "line";
          const bIsLine = geomB.type === "line";
          const aIsCircle = geomA.type === "circle";
          const bIsCircle = geomB.type === "circle";
          const aIsArc = geomA.type === "arc";
          const bIsArc = geomB.type === "arc";
          const aIsEllipse = geomA.type === "ellipse";
          const bIsEllipse = geomB.type === "ellipse";

          if (aIsLine && bIsCircle) {
            const lid = lineIdMap.get(geomA.id);
            const circId = circleIdMap.get(geomB.id);
            if (lid && circId) primitives.push({ id: cid, type: "tangent_lc", l_id: lid, c_id: circId });
          } else if (aIsCircle && bIsLine) {
            const lid = lineIdMap.get(geomB.id);
            const circId = circleIdMap.get(geomA.id);
            if (lid && circId) primitives.push({ id: cid, type: "tangent_lc", l_id: lid, c_id: circId });
          } else if (aIsLine && bIsArc) {
            const lid = lineIdMap.get(geomA.id);
            const aId = arcIdMap.get(geomB.id);
            if (lid && aId) primitives.push({ id: cid, type: "tangent_la", l_id: lid, a_id: aId });
          } else if (aIsArc && bIsLine) {
            const lid = lineIdMap.get(geomB.id);
            const aId = arcIdMap.get(geomA.id);
            if (lid && aId) primitives.push({ id: cid, type: "tangent_la", l_id: lid, a_id: aId });
          } else if (aIsLine && bIsEllipse) {
            const lid = lineIdMap.get(geomA.id);
            const eId = ellipseIdMap.get(geomB.id);
            if (lid && eId) primitives.push({ id: cid, type: "tangent_le", l_id: lid, e_id: eId });
          } else if (aIsEllipse && bIsLine) {
            const lid = lineIdMap.get(geomB.id);
            const eId = ellipseIdMap.get(geomA.id);
            if (lid && eId) primitives.push({ id: cid, type: "tangent_le", l_id: lid, e_id: eId });
          } else if (aIsCircle && bIsCircle) {
            const c1 = circleIdMap.get(geomA.id);
            const c2 = circleIdMap.get(geomB.id);
            if (c1 && c2) primitives.push({ id: cid, type: "tangent_cc", c1_id: c1, c2_id: c2 });
          } else if (aIsCircle && bIsArc) {
            const circId = circleIdMap.get(geomA.id);
            const aId = arcIdMap.get(geomB.id);
            if (circId && aId) primitives.push({ id: cid, type: "tangent_ca", c_id: circId, a_id: aId });
          } else if (aIsArc && bIsCircle) {
            const circId = circleIdMap.get(geomB.id);
            const aId = arcIdMap.get(geomA.id);
            if (circId && aId) primitives.push({ id: cid, type: "tangent_ca", c_id: circId, a_id: aId });
          } else if (aIsArc && bIsArc) {
            const a1 = arcIdMap.get(geomA.id);
            const a2 = arcIdMap.get(geomB.id);
            if (a1 && a2) primitives.push({ id: cid, type: "tangent_aa", a1_id: a1, a2_id: a2 });
          }
          break;
        }
        case "point_on_circle": {
          const pKey = makePointKey(c.point.geomId, c.point.vertexIndex);
          const pid = pointRegistry.get(find(pKey));
          const targetGeom = geometries.get(c.circle.geomId);
          if (!pid || !targetGeom) break;
          if (targetGeom.type === "circle") {
            const circId = circleIdMap.get(c.circle.geomId);
            if (circId) primitives.push({ id: cid, type: "point_on_circle", p_id: pid, c_id: circId });
          } else if (targetGeom.type === "arc") {
            const aId = arcIdMap.get(c.circle.geomId);
            if (aId) primitives.push({ id: cid, type: "point_on_arc", p_id: pid, a_id: aId });
          } else if (targetGeom.type === "ellipse") {
            const eId = ellipseIdMap.get(c.circle.geomId);
            if (eId) primitives.push({ id: cid, type: "point_on_ellipse", p_id: pid, e_id: eId });
          }
          break;
        }
        case "radius": {
          const targetGeom = geometries.get(c.circle.geomId);
          if (!targetGeom) break;
          if (targetGeom.type === "circle") {
            const circId = circleIdMap.get(c.circle.geomId);
            if (circId) primitives.push({ id: cid, type: "circle_radius", c_id: circId, radius: c.value });
          } else if (targetGeom.type === "arc") {
            const aId = arcIdMap.get(c.circle.geomId);
            if (aId) primitives.push({ id: cid, type: "arc_radius", a_id: aId, radius: c.value });
          } else if (targetGeom.type === "ellipse") {
            const eId = ellipseIdMap.get(c.circle.geomId);
            if (eId) {
              primitives.push({
                id: cid, type: "equal",
                param1: { o_id: eId, prop: "radmin" },
                param2: c.value,
              });
            }
          }
          break;
        }
        case "diameter": {
          const targetGeom = geometries.get(c.circle.geomId);
          if (!targetGeom) break;
          if (targetGeom.type === "circle") {
            const circId = circleIdMap.get(c.circle.geomId);
            if (circId) primitives.push({ id: cid, type: "circle_diameter", c_id: circId, diameter: c.value });
          } else if (targetGeom.type === "arc") {
            const aId = arcIdMap.get(c.circle.geomId);
            if (aId) primitives.push({ id: cid, type: "arc_radius", a_id: aId, radius: c.value / 2 });
          }
          break;
        }
        case "equal_radius": {
          const gA = geometries.get(c.circleA.geomId);
          const gB = geometries.get(c.circleB.geomId);
          if (!gA || !gB) break;
          if (gA.type === "circle" && gB.type === "circle") {
            const c1 = circleIdMap.get(gA.id);
            const c2 = circleIdMap.get(gB.id);
            if (c1 && c2) primitives.push({ id: cid, type: "equal_radius_cc", c1_id: c1, c2_id: c2 });
          } else if (gA.type === "circle" && gB.type === "arc") {
            const circId = circleIdMap.get(gA.id);
            const arcId = arcIdMap.get(gB.id);
            if (circId && arcId) primitives.push({ id: cid, type: "equal_radius_ca", c1_id: circId, a2_id: arcId });
          } else if (gA.type === "arc" && gB.type === "circle") {
            const circId = circleIdMap.get(gB.id);
            const arcId = arcIdMap.get(gA.id);
            if (circId && arcId) primitives.push({ id: cid, type: "equal_radius_ca", c1_id: circId, a2_id: arcId });
          } else if (gA.type === "arc" && gB.type === "arc") {
            const a1 = arcIdMap.get(gA.id);
            const a2 = arcIdMap.get(gB.id);
            if (a1 && a2) primitives.push({ id: cid, type: "equal_radius_aa", a1_id: a1, a2_id: a2 });
          } else if (gA.type === "ellipse" && gB.type === "ellipse") {
            const e1 = ellipseIdMap.get(gA.id);
            const e2 = ellipseIdMap.get(gB.id);
            if (e1 && e2) primitives.push({ id: cid, type: "equal_radii_ee", e1_id: e1, e2_id: e2 });
          }
          break;
        }
        case "line_length": {
          const p1Key = makePointKey(c.line.geomId, 0);
          const p2Key = makePointKey(c.line.geomId, 1);
          const p1Id = pointRegistry.get(find(p1Key));
          const p2Id = pointRegistry.get(find(p2Key));
          if (p1Id && p2Id) {
            primitives.push({ id: cid, type: "p2p_distance", p1_id: p1Id, p2_id: p2Id, distance: c.value });
          }
          break;
        }
        case "angle": {
          const l1 = lineIdMap.get(c.lineA.geomId);
          const l2 = lineIdMap.get(c.lineB.geomId);
          if (l1 && l2) {
            // problem-definition 의 zone 패턴 (사잇각 vs 보각 flag):
            // - isAcute (default, true): c.value 사잇각 그대로 enforce.
            // - isAcute=false (보각): c.value 는 보각 표시값. enforce = 180 - c.value = 자연 사잇각.
            // 부호는 line direction 의 자연 cross product 로 매칭 (line 회전 없음).
            const isObtuse = c.isAcute === false;
            const enforceDeg = isObtuse ? (180 - c.value) : c.value;
            const lA = geometries.get(c.lineA.geomId);
            const lB = geometries.get(c.lineB.geomId);
            let signedRad = enforceDeg * Math.PI / 180;
            if (lA?.type === "line" && lB?.type === "line") {
              const dxA = lA.x2 - lA.x1, dyA = lA.y2 - lA.y1;
              const dxB = lB.x2 - lB.x1, dyB = lB.y2 - lB.y1;
              const lenA = Math.hypot(dxA, dyA), lenB = Math.hypot(dxB, dyB);
              const cross = dxA * dyB - dyA * dxB;
              // 평행 근처 (sin(angle) 작음) 에서 cross 부호 노이즈로 떨림 방지 — epsilon 미만이면
              // 부호 매칭 안 함 (drag 중 line 이 평행 통과 시 enforced angle 부호 flip 방지).
              const sinThreshold = lenA * lenB * 1e-3;
              if (cross < -sinThreshold) signedRad = -signedRad;
            }
            primitives.push({ id: cid, type: "l2l_angle_ll", l1_id: l1, l2_id: l2, angle: signedRad });
          }
          break;
        }
        case "line_angle": {
          const targetLine = lineIdMap.get(c.line.geomId);
          if (targetLine) {
            const refP1 = `__la_ref_p1_${cid}`;
            const refP2 = `__la_ref_p2_${cid}`;
            const refLine = `__la_ref_ln_${cid}`;
            primitives.push({ id: refP1, type: "point", x: 0, y: 0, fixed: true });
            primitives.push({ id: refP2, type: "point", x: 1, y: 0, fixed: true });
            primitives.push({ id: refLine, type: "line", p1_id: refP1, p2_id: refP2 });
            primitives.push({ id: cid, type: "l2l_angle_ll", l1_id: refLine, l2_id: targetLine, angle: c.value * Math.PI / 180 });
          }
          break;
        }
        case "point_line_distance": {
          const pKey = makePointKey(c.point.geomId, c.point.vertexIndex);
          const pid = pointRegistry.get(find(pKey));
          const lid = lineIdMap.get(c.line.geomId);
          if (pid && lid) {
            primitives.push({ id: cid, type: "p2l_distance", p_id: pid, l_id: lid, distance: c.value });
          }
          break;
        }
        case "line_line_distance": {
          // 평행 두 line 사이 거리 — 명시적 parallel + 한쪽 endpoint 거리 = value.
          // 양 endpoint 의 p2l_distance 두 개 방식은 planegcs p2l_distance 가 unsigned 라
          // 평행 보장 안 됨 → parallel + 단일 endpoint 거리로 분리.
          // 단 두 line 의 effective direction 이 이미 fixed (axis / horizontal / vertical) 이고
          // 동일 방향이면 parallel 가 redundant → 추가하지 않음. redundancy 는 솔버 numerical
          // 불안정 + drag 시 over-determined 로 dimension 일부 깨지는 원인.
          const lAId = lineIdMap.get(c.lineA.geomId);
          const lBId = lineIdMap.get(c.lineB.geomId);
          if (lAId && lBId) {
            const aDir = getEffectiveLineDirection(c.lineA.geomId, constraints);
            const bDir = getEffectiveLineDirection(c.lineB.geomId, constraints);
            const parallelRedundant = aDir !== null && bDir !== null && aDir === bDir;
            if (!parallelRedundant) {
              primitives.push({ id: `${cid}_par`, type: "parallel", l1_id: lAId, l2_id: lBId });
            }
            const p1Key = makePointKey(c.lineA.geomId, 0);
            const p1Id = pointRegistry.get(find(p1Key));
            if (p1Id) {
              primitives.push({ id: `${cid}_dist`, type: "p2l_distance", p_id: p1Id, l_id: lBId, distance: c.value });
            }
          }
          break;
        }
        case "point_circle_distance": {
          // planegcs P2CDistance — 점-원 둘레 거리 직접 primitive (radius 변동에도 정확).
          const pKey = makePointKey(c.point.geomId, c.point.vertexIndex);
          const pId = pointRegistry.get(find(pKey));
          const circleGeom = geometries.get(c.circle.geomId);
          if (pId && circleGeom && circleGeom.type === "circle") {
            const cId = circleIdMap.get(c.circle.geomId);
            if (cId) {
              primitives.push({ id: cid, type: "p2cdistance", p_id: pId, c_id: cId, distance: c.value });
            }
          } else if (pId && circleGeom && circleGeom.type === "arc") {
            // arc 는 별도 primitive 부재 — center 까지 거리 = r + value 우회.
            const centerId = pointRegistry.get(find(makePointKey(c.circle.geomId, 0)));
            if (centerId) {
              primitives.push({ id: cid, type: "p2p_distance", p1_id: pId, p2_id: centerId, distance: circleGeom.r + c.value });
            }
          }
          break;
        }
        case "line_circle_distance": {
          // planegcs C2LDistance — line-원 둘레 거리 직접 primitive.
          const lid = lineIdMap.get(c.line.geomId);
          const circleGeom = geometries.get(c.circle.geomId);
          if (lid && circleGeom && circleGeom.type === "circle") {
            const cId = circleIdMap.get(c.circle.geomId);
            if (cId) {
              primitives.push({ id: cid, type: "c2ldistance", c_id: cId, l_id: lid, dist: c.value });
            }
          } else if (lid && circleGeom && circleGeom.type === "arc") {
            const centerId = pointRegistry.get(find(makePointKey(c.circle.geomId, 0)));
            if (centerId) {
              primitives.push({ id: cid, type: "p2l_distance", p_id: centerId, l_id: lid, distance: circleGeom.r + c.value });
            }
          }
          break;
        }
        case "circle_circle_distance": {
          // planegcs C2CDistance — 원-원 둘레 거리 직접 primitive.
          const a = geometries.get(c.circleA.geomId);
          const b = geometries.get(c.circleB.geomId);
          if (a?.type === "circle" && b?.type === "circle") {
            const aId = circleIdMap.get(c.circleA.geomId);
            const bId = circleIdMap.get(c.circleB.geomId);
            if (aId && bId) {
              primitives.push({ id: cid, type: "c2cdistance", c1_id: aId, c2_id: bId, dist: c.value });
            }
          } else if (a && b && (a.type === "circle" || a.type === "arc") && (b.type === "circle" || b.type === "arc")) {
            // arc 포함 시 center-center 거리 = rA + rB + value 우회.
            const aCenterId = pointRegistry.get(find(makePointKey(c.circleA.geomId, 0)));
            const bCenterId = pointRegistry.get(find(makePointKey(c.circleB.geomId, 0)));
            if (aCenterId && bCenterId) {
              primitives.push({ id: cid, type: "p2p_distance", p1_id: aCenterId, p2_id: bCenterId, distance: a.r + b.r + c.value });
            }
          }
          break;
        }
        case "arc_length": {
          // planegcs ArcLength — arc 호 길이 직접 primitive.
          const aId = arcIdMap.get(c.arc.geomId);
          if (aId) {
            primitives.push({ id: cid, type: "arc_length", a_id: aId, dist: c.value });
          }
          break;
        }
        // ellipse_major_radius: planegcs ellipse 가 (center, focus1, radmin) 표현이라 radmaj 가 derived
        // (radmaj² = focus_dist² + radmin²). 직접 set 못함 — driven-only. radmin 을 잡고 focus 위치도
        // 잡으면 간접 enforce 가능 (후속 작업).
        case "ellipse_minor_radius": {
          // planegcs ellipse 의 radmin parameter 직접 set.
          const eId = ellipseIdMap.get(c.ellipse.geomId);
          if (eId) {
            primitives.push({ id: cid, type: "equal", param1: { o_id: eId, prop: "radmin" }, param2: c.value });
          }
          break;
        }
        // curve_length: planegcs 에 BSpline length 직접 primitive 없음 — driven-only.
        case "symmetric": {
          const p1Key = makePointKey(c.pointA.geomId, c.pointA.vertexIndex);
          const p2Key = makePointKey(c.pointB.geomId, c.pointB.vertexIndex);
          const p1Id = pointRegistry.get(find(p1Key));
          const p2Id = pointRegistry.get(find(p2Key));
          const axisId = lineIdMap.get(c.axis.geomId);
          if (p1Id && p2Id && axisId) {
            primitives.push({ id: cid, type: "p2p_symmetric_ppl", p1_id: p1Id, p2_id: p2Id, l_id: axisId });
          }
          break;
        }
        case "symmetric_point": {
          // 점 기준 대칭 — center 가 pointA, pointB 의 중점.
          const p1Id = pointRegistry.get(find(makePointKey(c.pointA.geomId, c.pointA.vertexIndex)));
          const p2Id = pointRegistry.get(find(makePointKey(c.pointB.geomId, c.pointB.vertexIndex)));
          const cId = pointRegistry.get(find(makePointKey(c.center.geomId, c.center.vertexIndex)));
          if (p1Id && p2Id && cId) {
            primitives.push({ id: cid, type: "p2p_symmetric_ppp", p1_id: p1Id, p2_id: p2Id, p_id: cId });
          }
          break;
        }
        case "horizontal_distance": {
          // planegcs `difference` 는 param2 - param1 = difference 를 enforce.
          // pointB.x - pointA.x = sign * value 가 되도록 param1=pA, param2=pB 매핑.
          const p1Key = makePointKey(c.pointA.geomId, c.pointA.vertexIndex);
          const p2Key = makePointKey(c.pointB.geomId, c.pointB.vertexIndex);
          const p1Id = pointRegistry.get(find(p1Key));
          const p2Id = pointRegistry.get(find(p2Key));
          if (p1Id && p2Id) {
            primitives.push({
              id: cid, type: "difference",
              param1: { o_id: p1Id, prop: "x" },
              param2: { o_id: p2Id, prop: "x" },
              difference: c.sign * c.value,
            });
          }
          break;
        }
        case "vertical_distance": {
          const p1Key = makePointKey(c.pointA.geomId, c.pointA.vertexIndex);
          const p2Key = makePointKey(c.pointB.geomId, c.pointB.vertexIndex);
          const p1Id = pointRegistry.get(find(p1Key));
          const p2Id = pointRegistry.get(find(p2Key));
          if (p1Id && p2Id) {
            primitives.push({
              id: cid, type: "difference",
              param1: { o_id: p1Id, prop: "y" },
              param2: { o_id: p2Id, prop: "y" },
              difference: c.sign * c.value,
            });
          }
          break;
        }
        case "equidistant": {
          // A와 B가 center에서 같은 거리: dist(A, center) = dist(B, center)
          // planegcs에서 두 거리를 동일하게 만들기 위해: 현재 거리 계산 후 양쪽에 같은 distance 적용
          const paKey = makePointKey(c.pointA.geomId, c.pointA.vertexIndex);
          const pbKey = makePointKey(c.pointB.geomId, c.pointB.vertexIndex);
          const pcKey = makePointKey(c.center.geomId, c.center.vertexIndex);
          const paId = pointRegistry.get(find(paKey));
          const pbId = pointRegistry.get(find(pbKey));
          const pcId = pointRegistry.get(find(pcKey));
          if (paId && pbId && pcId) {
            // 현재 A-C 거리 계산
            const coordA = pointCoords.get(paId);
            const coordC = pointCoords.get(pcId);
            if (coordA && coordC) {
              const dist = Math.hypot(coordA.x - coordC.x, coordA.y - coordC.y);
              if (dist > 1e-6) {
                // 양쪽 모두 같은 거리 구속
                primitives.push({ id: `${cid}_ac`, type: "p2p_distance", p1_id: paId, p2_id: pcId, distance: dist });
                primitives.push({ id: `${cid}_bc`, type: "p2p_distance", p1_id: pbId, p2_id: pcId, distance: dist });
              }
            }
          }
          break;
        }
        case "fix_together": {
          // 매크로: 요소 쌍별 현재 distance 구속 추가
          // 첫 번째 요소의 vertex 0을 기준으로 나머지의 vertex 0까지 거리 고정
          const elems = c.elements;
          if (elems.length < 2) break;
          const baseKey = makePointKey(elems[0].geomId, 0);
          const baseId = pointRegistry.get(find(baseKey));
          if (!baseId) break;
          const baseCoord = pointCoords.get(baseId);
          if (!baseCoord) break;
          for (let i = 1; i < elems.length; i++) {
            const targKey = makePointKey(elems[i].geomId, 0);
            const targId = pointRegistry.get(find(targKey));
            if (!targId || targId === baseId) continue;
            const targCoord = pointCoords.get(targId);
            if (!targCoord) continue;
            const dist = Math.hypot(targCoord.x - baseCoord.x, targCoord.y - baseCoord.y);
            if (dist > 1e-6) {
              primitives.push({
                id: `${cid}_ft_${i}`, type: "p2p_distance",
                p1_id: baseId, p2_id: targId, distance: dist,
              });
            }
          }
          break;
        }
      }
    }

    // --- 4. 드래그 중 temporary coordinate 구속 추가 ---
    if (fixedPointKeys) {
      const addedDragPids = new Set<string>();
      for (const key of fixedPointKeys) {
        const root = find(key);
        const pid = pointRegistry.get(root);
        if (!pid || addedDragPids.has(pid)) continue;
        addedDragPids.add(pid);
        const coord = pointCoords.get(pid);
        if (coord) {
          primitives.push({
            id: `__drag_${pid}_x`, type: "coordinate_x",
            p_id: pid, x: coord.x, temporary: true,
          });
          primitives.push({
            id: `__drag_${pid}_y`, type: "coordinate_y",
            p_id: pid, y: coord.y, temporary: true,
          });
        }
      }
    }

    return {
      primitives, pointRegistry, pointCoords, find, vertexMap,
      lineIdMap, circleIdMap, arcIdMap, ellipseIdMap,
    };
  }
}

// 솔버 결과를 기하 좌표에 역반영
function applyVertexCoord(geom: SerializedGeometry, vertexIndex: number, x: number, y: number): void {
  switch (geom.type) {
    case "point":
      geom.x = x;
      geom.y = y;
      break;
    case "line":
      if (vertexIndex === 0) { geom.x1 = x; geom.y1 = y; }
      else { geom.x2 = x; geom.y2 = y; }
      break;
    case "circle":
      geom.cx = x;
      geom.cy = y;
      break;
    case "arc":
      if (vertexIndex === 0) { geom.cx = x; geom.cy = y; }
      // arc의 start/end point → 중심 기준 각도 + 반지름 역산
      if (vertexIndex === 1) {
        geom.startAngle = Math.atan2(y - geom.cy, x - geom.cx);
        geom.r = Math.hypot(x - geom.cx, y - geom.cy);
      }
      if (vertexIndex === 2) {
        geom.endAngle = Math.atan2(y - geom.cy, x - geom.cx);
        // r은 vertexIndex=1에서 갱신되며, 이후 reverseArcMap 패스에서 arc primitive의 radius로 최종 덮어씌워짐
      }
      break;
    case "curve":
      if (geom.points[vertexIndex]) {
        geom.points[vertexIndex] = { x, y };
      }
      break;
    case "ellipse":
      if (vertexIndex === 0) {
        geom.cx = x;
        geom.cy = y;
      }
      if (vertexIndex === 1) {
        // focus1 점 이동 → rotation 역산
        // rx, ry는 이후 ellipse primitive 역반영 패스에서 radmin + focus 좌표로 최종 갱신
        const focusDx = x - geom.cx;
        const focusDy = y - geom.cy;
        geom.rotation = Math.atan2(focusDy, focusDx);
      }
      break;
    case "polygon":
      if (geom.vertices[vertexIndex]) {
        geom.vertices[vertexIndex] = { x, y };
      }
      break;
  }
}

// 꼭짓점 참조 → 솔브 후 좌표 resolve
function resolvePointCoord(
  geometries: Map<string, SerializedGeometry>,
  ref: { geomId: string; vertexIndex: number },
): { x: number; y: number } | null {
  const geom = geometries.get(ref.geomId);
  if (!geom) return null;
  const verts = extractVertices(geom);
  return verts.find((v) => v.vertexIndex === ref.vertexIndex) ?? null;
}

// 솔브 후 치수 구속 실제 만족 여부 검증
// SQP가 Converged를 반환해도 상충 구속이 있으면 실제 기하가 목표값과 다름
const DIM_LENGTH_TOLERANCE = 0.5; // 길이/거리 허용 오차
const DIM_ANGLE_TOLERANCE = 0.5; // 각도 허용 오차 (도)

function validateDimensionConstraints(
  geometries: Map<string, SerializedGeometry>,
  constraints: Map<string, SketchConstraint>,
): boolean {
  for (const c of constraints.values()) {
    // 참조 전용(driven) dimension은 검증 스킵
    if ("isReference" in c && (c as { isReference?: boolean }).isReference) continue;
    switch (c.type) {
      case "line_length": {
        const geom = geometries.get(c.line.geomId);
        if (geom?.type === "line") {
          const actual = Math.hypot(geom.x2 - geom.x1, geom.y2 - geom.y1);
          if (Math.abs(actual - c.value) > DIM_LENGTH_TOLERANCE) return false;
        }
        break;
      }
      case "distance": {
        const pA = resolvePointCoord(geometries, c.pointA);
        const pB = resolvePointCoord(geometries, c.pointB);
        if (pA && pB) {
          const actual = Math.hypot(pB.x - pA.x, pB.y - pA.y);
          if (Math.abs(actual - c.value) > DIM_LENGTH_TOLERANCE) return false;
        }
        break;
      }
      case "horizontal_distance": {
        const pA = resolvePointCoord(geometries, c.pointA);
        const pB = resolvePointCoord(geometries, c.pointB);
        if (pA && pB) {
          const actual = Math.abs(pB.x - pA.x);
          if (Math.abs(actual - c.value) > DIM_LENGTH_TOLERANCE) return false;
        }
        break;
      }
      case "vertical_distance": {
        const pA = resolvePointCoord(geometries, c.pointA);
        const pB = resolvePointCoord(geometries, c.pointB);
        if (pA && pB) {
          const actual = Math.abs(pB.y - pA.y);
          if (Math.abs(actual - c.value) > DIM_LENGTH_TOLERANCE) return false;
        }
        break;
      }
      case "angle": {
        const gA = geometries.get(c.lineA.geomId);
        const gB = geometries.get(c.lineB.geomId);
        if (gA?.type === "line" && gB?.type === "line") {
          const dxA = gA.x2 - gA.x1, dyA = gA.y2 - gA.y1;
          const dxB = gB.x2 - gB.x1, dyB = gB.y2 - gB.y1;
          const magA = Math.hypot(dxA, dyA), magB = Math.hypot(dxB, dyB);
          if (magA > 1e-9 && magB > 1e-9) {
            const cosAngle = Math.max(-1, Math.min(1, (dxA * dxB + dyA * dyB) / (magA * magB)));
            const actual = Math.acos(cosAngle) * 180 / Math.PI;
            // c.value 가 사잇각 (isAcute=true/undefined) 또는 보각 (isAcute=false) 표시값.
            // actual 도 line direction 에 따라 사잇각 (cos>0) 또는 보각 (cos<0). 두 표현 (actual,
            // 180-actual) 중 c.value 와 가까운 쪽으로 비교 — flag 무관하게 동등성 검증.
            const diffDirect = Math.abs(actual - c.value);
            const diffSupp = Math.abs((180 - actual) - c.value);
            if (Math.min(diffDirect, diffSupp) > DIM_ANGLE_TOLERANCE) return false;
          }
        }
        break;
      }
      case "line_angle": {
        const g = geometries.get(c.line.geomId);
        if (g?.type === "line") {
          const dx = g.x2 - g.x1, dy = g.y2 - g.y1;
          if (Math.hypot(dx, dy) > 1e-9) {
            const actual = Math.atan2(dy, dx) * 180 / Math.PI;
            // 각도 정규화 후 비교 (wrap-around 고려)
            let diff = Math.abs(actual - c.value);
            if (diff > 180) diff = 360 - diff;
            if (diff > DIM_ANGLE_TOLERANCE) return false;
          }
        }
        break;
      }
      case "radius": {
        const geom = geometries.get(c.circle.geomId);
        if (geom && (geom.type === "circle" || geom.type === "arc")) {
          if (Math.abs(geom.r - c.value) > DIM_LENGTH_TOLERANCE) return false;
        }
        break;
      }
      case "diameter": {
        const geom = geometries.get(c.circle.geomId);
        if (geom && (geom.type === "circle" || geom.type === "arc")) {
          if (Math.abs(geom.r * 2 - c.value) > DIM_LENGTH_TOLERANCE) return false;
        }
        break;
      }
      case "point_line_distance": {
        const pt = resolvePointCoord(geometries, c.point);
        const lineGeom = geometries.get(c.line.geomId);
        if (pt && lineGeom?.type === "line") {
          const ldx = lineGeom.x2 - lineGeom.x1, ldy = lineGeom.y2 - lineGeom.y1;
          const llen = Math.hypot(ldx, ldy);
          if (llen > 1e-9) {
            const actual = Math.abs(ldx * (lineGeom.y1 - pt.y) - ldy * (lineGeom.x1 - pt.x)) / llen;
            if (Math.abs(actual - c.value) > DIM_LENGTH_TOLERANCE) return false;
          }
        }
        break;
      }
      case "line_line_distance": {
        // 평행 두 line 사이 거리 = value. lineA 의 양 끝점이 lineB 로부터 같은 거리.
        const lA = geometries.get(c.lineA.geomId);
        const lB = geometries.get(c.lineB.geomId);
        if (lA?.type === "line" && lB?.type === "line") {
          const bdx = lB.x2 - lB.x1, bdy = lB.y2 - lB.y1;
          const blen = Math.hypot(bdx, bdy);
          if (blen > 1e-9) {
            const d1 = Math.abs(bdx * (lB.y1 - lA.y1) - bdy * (lB.x1 - lA.x1)) / blen;
            const d2 = Math.abs(bdx * (lB.y1 - lA.y2) - bdy * (lB.x1 - lA.x2)) / blen;
            if (Math.abs(d1 - c.value) > DIM_LENGTH_TOLERANCE) return false;
            if (Math.abs(d2 - c.value) > DIM_LENGTH_TOLERANCE) return false;
          }
        }
        break;
      }
      case "point_circle_distance": {
        const pt = resolvePointCoord(geometries, c.point);
        const cir = geometries.get(c.circle.geomId);
        if (pt && cir && (cir.type === "circle" || cir.type === "arc")) {
          const actual = Math.abs(Math.hypot(pt.x - cir.cx, pt.y - cir.cy) - cir.r);
          if (Math.abs(actual - c.value) > DIM_LENGTH_TOLERANCE) return false;
        }
        break;
      }
      case "line_circle_distance": {
        const ln = geometries.get(c.line.geomId);
        const cir = geometries.get(c.circle.geomId);
        if (ln?.type === "line" && cir && (cir.type === "circle" || cir.type === "arc")) {
          const ldx = ln.x2 - ln.x1, ldy = ln.y2 - ln.y1;
          const llen = Math.hypot(ldx, ldy);
          if (llen > 1e-9) {
            const d = Math.abs(ldx * (ln.y1 - cir.cy) - ldy * (ln.x1 - cir.cx)) / llen;
            const actual = Math.abs(d - cir.r);
            if (Math.abs(actual - c.value) > DIM_LENGTH_TOLERANCE) return false;
          }
        }
        break;
      }
      case "circle_circle_distance": {
        const a = geometries.get(c.circleA.geomId);
        const b = geometries.get(c.circleB.geomId);
        if (a && b && (a.type === "circle" || a.type === "arc") && (b.type === "circle" || b.type === "arc")) {
          const actual = Math.abs(Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.r - b.r);
          if (Math.abs(actual - c.value) > DIM_LENGTH_TOLERANCE) return false;
        }
        break;
      }
      case "arc_length": {
        const arc = geometries.get(c.arc.geomId);
        if (arc?.type === "arc") {
          let span = arc.endAngle - arc.startAngle;
          if (span <= 0) span += Math.PI * 2;
          if (Math.abs(span * arc.r - c.value) > DIM_LENGTH_TOLERANCE) return false;
        }
        break;
      }
      case "ellipse_major_radius": {
        const e = geometries.get(c.ellipse.geomId);
        if (e?.type === "ellipse") {
          if (Math.abs(Math.max(e.rx, e.ry) - c.value) > DIM_LENGTH_TOLERANCE) return false;
        }
        break;
      }
      case "ellipse_minor_radius": {
        const e = geometries.get(c.ellipse.geomId);
        if (e?.type === "ellipse") {
          if (Math.abs(Math.min(e.rx, e.ry) - c.value) > DIM_LENGTH_TOLERANCE) return false;
        }
        break;
      }
      // curve_length: driven-only — validate skip.
      case "symmetric": {
        // 대칭 만족 여부: 중점이 축선 위 + P1P2가 축선에 수직
        const pA = resolvePointCoord(geometries, c.pointA);
        const pB = resolvePointCoord(geometries, c.pointB);
        const axisGeom = geometries.get(c.axis.geomId);
        if (pA && pB && axisGeom?.type === "line") {
          const mx = (pA.x + pB.x) / 2, my = (pA.y + pB.y) / 2;
          const adx = axisGeom.x2 - axisGeom.x1, ady = axisGeom.y2 - axisGeom.y1;
          const alen = Math.hypot(adx, ady);
          if (alen > 1e-9) {
            // 중점이 축선 위인지 (점-직선 거리)
            const midDist = Math.abs(adx * (axisGeom.y1 - my) - ady * (axisGeom.x1 - mx)) / alen;
            if (midDist > DIM_LENGTH_TOLERANCE) return false;
            // P1P2가 축선에 수직인지
            const pdx = pB.x - pA.x, pdy = pB.y - pA.y;
            const plen = Math.hypot(pdx, pdy);
            if (plen > 1e-9) {
              const dot = Math.abs(adx * pdx + ady * pdy) / (alen * plen);
              if (dot > 0.01) return false; // cos(angle) > 0.01 → 비수직
            }
          }
        }
        break;
      }
    }
  }
  return true;
}

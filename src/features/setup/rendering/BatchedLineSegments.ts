// 단일 LineSegments mesh 에 N 개 line 을 묶어 GPU draw call 1 회로 처리.
// per-vertex color attribute — hover / select 시 mesh 재생성 없이 색만 mutation.
//
// 구조:
//   - geomId → vertex range (start, count) 매핑
//   - positions / colors Float32Array (DynamicDrawUsage)
//   - 삭제된 range 는 hole 로 free-list 에 보관. 같은 size 재사용 시 fit, 아니면 capacity grow.
//   - capacity 부족 시 ×2 grow (BufferAttribute 재생성).
//
// vertex 는 pair 단위 (LineSegments). 한 line = 2 vertex, polygon N vert = 2N vertex (각 edge).

import * as THREE from "three";

type Range = { start: number; count: number };

const INITIAL_CAPACITY = 1024;

export type BatchedLineOptions = {
  /** true 면 LineDashedMaterial + lineDistance attribute. construction line 등 dashed. */
  dashed?: boolean;
  /** dashed=true 일 때 dashSize (world units). */
  dashSize?: number;
  /** dashed=true 일 때 gapSize. */
  gapSize?: number;
};

export class BatchedLineSegments {
  /** caller 가 scene group 에 add. */
  readonly mesh: THREE.LineSegments;

  private _positionAttr: THREE.BufferAttribute;
  private _colorAttr: THREE.BufferAttribute;
  /** dashed=true 일 때만 — LineDashedMaterial 의 dash 위치 계산용. */
  private _lineDistanceAttr: THREE.BufferAttribute | null = null;
  private _capacity: number;
  /** 현재까지 할당된 vertex 의 high-water mark (compact 안 함 — grow only). */
  private _used = 0;
  private _ranges: Map<string, Range> = new Map();
  /** 삭제된 range. 같은 count 면 재사용. */
  private _holes: Range[] = [];
  private _dashed: boolean;

  constructor(opts: BatchedLineOptions = {}) {
    this._dashed = opts.dashed ?? false;
    this._capacity = INITIAL_CAPACITY;
    const positions = new Float32Array(this._capacity * 3);
    const colors = new Float32Array(this._capacity * 3);
    this._positionAttr = new THREE.BufferAttribute(positions, 3).setUsage(
      THREE.DynamicDrawUsage,
    );
    this._colorAttr = new THREE.BufferAttribute(colors, 3).setUsage(
      THREE.DynamicDrawUsage,
    );

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", this._positionAttr);
    geom.setAttribute("color", this._colorAttr);

    if (this._dashed) {
      const lineDistances = new Float32Array(this._capacity);
      this._lineDistanceAttr = new THREE.BufferAttribute(lineDistances, 1).setUsage(
        THREE.DynamicDrawUsage,
      );
      geom.setAttribute("lineDistance", this._lineDistanceAttr);
    }
    geom.setDrawRange(0, 0);

    const mat = this._dashed
      ? new THREE.LineDashedMaterial({
          vertexColors: true,
          depthTest: false,
          dashSize: opts.dashSize ?? 2,
          gapSize: opts.gapSize ?? 1,
        })
      : new THREE.LineBasicMaterial({
          vertexColors: true,
          depthTest: false,
        });
    this.mesh = new THREE.LineSegments(geom, mat);
  }

  /**
   * id 에 해당하는 line segment vertex 들 추가/갱신.
   * points 는 vertex array (pair 단위 — segment 0 = points[0]-points[1], segment 1 = points[2]-points[3], ...).
   */
  set(id: string, points: THREE.Vector3[], color: THREE.Color): void {
    const count = points.length;
    if (count === 0 || count % 2 !== 0) return;

    let range = this._ranges.get(id);

    // 같은 크기면 in-place. range 유지.
    if (range && range.count === count) {
      this._writePositions(range.start, points);
      this._writeColors(range.start, count, color);
      return;
    }

    // 다른 크기 — free + 새 range allocate.
    if (range) {
      this._freeRange(range);
      this._ranges.delete(id);
    }

    range = this._allocate(count);
    this._ranges.set(id, range);
    this._writePositions(range.start, points);
    this._writeColors(range.start, count, color);
    this._updateDrawRange();
  }

  /** Color 만 갱신 (좌표 변경 없음 — hover/select fast path, mesh draw 재사용). */
  setColor(id: string, color: THREE.Color): void {
    const range = this._ranges.get(id);
    if (!range) return;
    this._writeColors(range.start, range.count, color);
  }

  remove(id: string): void {
    const range = this._ranges.get(id);
    if (!range) return;
    this._freeRange(range);
    this._ranges.delete(id);
  }

  has(id: string): boolean {
    return this._ranges.has(id);
  }

  /** 단일 id 의 vertex range — caller 가 자체 hit test 등에 사용. */
  getRange(id: string): Range | undefined {
    return this._ranges.get(id);
  }

  /** 모두 비우기 (file 전환 등). capacity 는 유지. */
  clear(): void {
    this._ranges.clear();
    this._holes.length = 0;
    this._used = 0;
    this._updateDrawRange();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.LineBasicMaterial).dispose();
  }

  // --- 내부 ---

  private _allocate(count: number): Range {
    // hole 중 정확히 같은 크기 찾기 (간단한 best-fit 대신 first-fit).
    const idx = this._holes.findIndex((h) => h.count === count);
    if (idx >= 0) {
      return this._holes.splice(idx, 1)[0];
    }
    // 새로 used 끝에 allocate. capacity 부족 시 grow.
    if (this._used + count > this._capacity) {
      this._grow(this._used + count);
    }
    const range = { start: this._used, count };
    this._used += count;
    return range;
  }

  private _freeRange(range: Range): void {
    // position 을 origin 으로 collapse — degenerate segment 라 GPU 가 drop.
    const positions = this._positionAttr.array as Float32Array;
    for (let i = 0; i < range.count; i++) {
      const base = (range.start + i) * 3;
      positions[base] = 0;
      positions[base + 1] = 0;
      positions[base + 2] = 0;
    }
    this._positionAttr.needsUpdate = true;
    this._holes.push(range);
  }

  private _writePositions(start: number, points: THREE.Vector3[]): void {
    const positions = this._positionAttr.array as Float32Array;
    for (let i = 0; i < points.length; i++) {
      const base = (start + i) * 3;
      const p = points[i];
      positions[base] = p.x;
      positions[base + 1] = p.y;
      positions[base + 2] = p.z;
    }
    this._positionAttr.needsUpdate = true;

    if (this._dashed && this._lineDistanceAttr) {
      // per-shape 누적 lineDistance — 같은 set() 호출 내의 pair 는 연속 누적,
      // 다음 set() 호출은 새로 0 부터. shape 별 dash phase 독립.
      // LineSegments 는 pair (2 vert) 단위 segment 이므로 vert k = start_dist, vert k+1 = start_dist+pairLen.
      // 다음 pair 의 start_dist = 이전 pair 의 end_dist (sequential shape 의 연속 dashing).
      const dists = this._lineDistanceAttr.array as Float32Array;
      let acc = 0;
      for (let pair = 0; pair < points.length / 2; pair++) {
        const a = points[pair * 2];
        const b = points[pair * 2 + 1];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        dists[start + pair * 2] = acc;
        dists[start + pair * 2 + 1] = acc + segLen;
        acc += segLen;
      }
      this._lineDistanceAttr.needsUpdate = true;
    }
  }

  private _writeColors(start: number, count: number, color: THREE.Color): void {
    const colors = this._colorAttr.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const base = (start + i) * 3;
      colors[base] = color.r;
      colors[base + 1] = color.g;
      colors[base + 2] = color.b;
    }
    this._colorAttr.needsUpdate = true;
  }

  private _updateDrawRange(): void {
    this.mesh.geometry.setDrawRange(0, this._used);
  }

  private _grow(minCapacity: number): void {
    let newCap = this._capacity;
    while (newCap < minCapacity) newCap *= 2;
    const newPositions = new Float32Array(newCap * 3);
    const newColors = new Float32Array(newCap * 3);
    newPositions.set(this._positionAttr.array as Float32Array);
    newColors.set(this._colorAttr.array as Float32Array);
    this._positionAttr = new THREE.BufferAttribute(newPositions, 3).setUsage(
      THREE.DynamicDrawUsage,
    );
    this._colorAttr = new THREE.BufferAttribute(newColors, 3).setUsage(
      THREE.DynamicDrawUsage,
    );
    this.mesh.geometry.setAttribute("position", this._positionAttr);
    this.mesh.geometry.setAttribute("color", this._colorAttr);

    if (this._dashed && this._lineDistanceAttr) {
      const newDists = new Float32Array(newCap);
      newDists.set(this._lineDistanceAttr.array as Float32Array);
      this._lineDistanceAttr = new THREE.BufferAttribute(newDists, 1).setUsage(
        THREE.DynamicDrawUsage,
      );
      this.mesh.geometry.setAttribute("lineDistance", this._lineDistanceAttr);
    }

    this._capacity = newCap;
  }
}

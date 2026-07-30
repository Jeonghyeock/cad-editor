// 공간 해시 그리드 — O(N²) 탐색을 O(N) 근사로 줄이기 위한 인덱스
// SnapEngine 등에서 근접 탐색에 사용

export class SpatialGrid<T> {
  private _cells = new Map<string, T[]>();
  private _cellSize: number;

  constructor(cellSize: number) {
    this._cellSize = cellSize;
  }

  private _key(x: number, y: number): string {
    return `${Math.floor(x / this._cellSize)},${Math.floor(y / this._cellSize)}`;
  }

  insert(x: number, y: number, item: T): void {
    const k = this._key(x, y);
    const cell = this._cells.get(k);
    if (cell) {
      cell.push(item);
    } else {
      this._cells.set(k, [item]);
    }
  }

  // AABB 범위 내 모든 아이템 반환
  query(minX: number, minY: number, maxX: number, maxY: number): T[] {
    const results: T[] = [];
    const cs = this._cellSize;
    const x0 = Math.floor(minX / cs);
    const x1 = Math.floor(maxX / cs);
    const y0 = Math.floor(minY / cs);
    const y1 = Math.floor(maxY / cs);

    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this._cells.get(`${cx},${cy}`);
        if (cell) {
          for (const item of cell) results.push(item);
        }
      }
    }
    return results;
  }

  // 원형 범위 내 아이템 반환 (AABB 근사 — 호출측에서 정밀 필터 필요)
  queryRadius(cx: number, cy: number, radius: number): T[] {
    return this.query(cx - radius, cy - radius, cx + radius, cy + radius);
  }

  clear(): void {
    this._cells.clear();
  }
}

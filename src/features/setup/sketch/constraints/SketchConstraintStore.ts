// 구속조건 저장소 (SketchGeometryStore와 병렬 구조)
// Map 기반 CRUD + 기하 삭제 시 연관 구속 cascade 삭제 + 직렬화

import { getConstraintGeomIds } from "../../utils/geometryUtils";

import type { SketchConstraint } from "./SketchConstraint.type";

export class SketchConstraintStore {
  constraints: Map<string, SketchConstraint> = new Map();

  private _renderListeners: Set<() => void> = new Set();
  private _mutationListeners: Set<() => void> = new Set();

  // --- 렌더 리스너 ---

  addRenderListener(callback: () => void): () => void {
    this._renderListeners.add(callback);
    return () => {
      this._renderListeners.delete(callback);
    };
  }

  requestRender(): void {
    for (const cb of this._renderListeners) cb();
  }

  // --- 변경 리스너 (solver cache invalidation 등) ---
  // Why: cache key 는 (id+type) 만 포함 — value 변경은 자동 감지 안 됨.
  //      remove+add 로 같은 id 재삽입하면 cache hit 으로 stale value 유지.
  addMutationListener(callback: () => void): () => void {
    this._mutationListeners.add(callback);
    return () => {
      this._mutationListeners.delete(callback);
    };
  }

  private _notifyMutation(): void {
    for (const cb of this._mutationListeners) cb();
  }

  // --- CRUD ---

  addConstraint(constraint: SketchConstraint): void {
    this.constraints.set(constraint.id, constraint);
    this._notifyMutation();
    this.requestRender();
  }

  addConstraints(constraints: SketchConstraint[]): void {
    for (const c of constraints) {
      this.constraints.set(c.id, c);
    }
    this._notifyMutation();
    this.requestRender();
  }

  removeConstraint(id: string): void {
    this.constraints.delete(id);
    this._notifyMutation();
    this.requestRender();
  }

  removeConstraints(ids: string[]): void {
    for (const id of ids) {
      this.constraints.delete(id);
    }
    this._notifyMutation();
    this.requestRender();
  }

  // 특정 기하에 연관된 모든 구속 조회
  getConstraintsForGeometry(geomIds: Set<string>): SketchConstraint[] {
    const result: SketchConstraint[] = [];
    for (const c of this.constraints.values()) {
      if (constraintReferencesAny(c, geomIds)) {
        result.push(c);
      }
    }
    return result;
  }

  // 특정 기하에 연관된 모든 구속 삭제 (cascade)
  removeConstraintsForGeometry(geomIds: Set<string>): SketchConstraint[] {
    const removed = this.getConstraintsForGeometry(geomIds);
    for (const c of removed) {
      this.constraints.delete(c.id);
    }
    if (removed.length > 0) this._notifyMutation();
    this.requestRender();
    return removed;
  }

  // --- 직렬화 ---

  serialize(): SketchConstraint[] {
    return [...this.constraints.values()];
  }

  deserialize(data: SketchConstraint[]): void {
    this.constraints.clear();
    for (const c of data) {
      this.constraints.set(c.id, c);
    }
    this._notifyMutation();
    this.requestRender();
  }

  clear(): void {
    this.constraints.clear();
    this._notifyMutation();
    this.requestRender();
  }
}

// 구속조건이 주어진 기하 ID 집합 중 하나라도 참조하는지 확인
function constraintReferencesAny(c: SketchConstraint, geomIds: Set<string>): boolean {
  return getConstraintGeomIds(c).some((id) => geomIds.has(id));
}

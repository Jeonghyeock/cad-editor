// 복합 스케치 커맨드: 기하 제거 + 추가 + 구속 제거 + 추가를 원자적으로 수행
// Trim, Fillet, Chamfer 도구에서 사용

import type { SerializedGeometry } from "../../Setup.type";

import type { ConstraintGeomRef, ConstraintPointRef, SketchConstraint } from "../constraints/SketchConstraint.type";
import type { ShapeSnapshot, SketchGeometryStore } from "../SketchGeometryStore";

import type { GeometryCommand } from "./GeometryCommand";

// 꼭짓점 재매핑 항목: 제거되는 기하의 vertex를 추가되는 기하의 vertex로 전달
export type VertexRemap = {
  oldGeomId: string;
  oldVertexIndex: number;
  newGeomId: string;
  newVertexIndex: number;
};

// 기하 참조 재매핑 항목: 제거되는 기하 ID를 새 기하 ID로 전달 (line→line 등)
export type GeomRemap = {
  oldGeomId: string;
  newGeomId: string;
};

export class CompoundSketchCommand implements GeometryCommand {
  // cascade 삭제된 구속조건 (undo 복원용 — 원본 상태)
  private _cascadeRemovedConstraints: SketchConstraint[] = [];
  // 재매핑되어 유지된 구속 (undo 시 제거 대상)
  private _remappedConstraints: SketchConstraint[] = [];
  // 제거한 기하를 쓰던 shape (undo 때 이미지·설정째 복원)
  private _removedShapes: ShapeSnapshot[] = [];

  constructor(
    private _removedGeometries: SerializedGeometry[],
    private _addedGeometries: SerializedGeometry[],
    private _removedConstraints: SketchConstraint[],
    private _addedConstraints: SketchConstraint[],
    private _vertexRemaps: VertexRemap[] = [],
    private _geomRemaps: GeomRemap[] = [],
  ) {}

  isEmpty(): boolean {
    return this._removedGeometries.length === 0
      && this._addedGeometries.length === 0
      && this._removedConstraints.length === 0
      && this._addedConstraints.length === 0;
  }

  execute(store: SketchGeometryStore): void {
    // redo 시 이전 실행 결과가 남지 않도록 초기화
    this._cascadeRemovedConstraints = [];
    this._remappedConstraints = [];
    this._remappedOriginals = [];

    const removedIds = new Set(this._removedGeometries.map((g) => g.id));
    this._removedShapes = store.snapshotShapesUsing(removedIds);

    // 1. 명시적 구속 제거
    if (store.constraintStore) {
      for (const c of this._removedConstraints) {
        store.constraintStore.constraints.delete(c.id);
      }

      // 재매핑 가능한 구속 분리 + cascade 삭제
      if (this._vertexRemaps.length > 0 || this._geomRemaps.length > 0) {
        // cascade 대상 구속 수집
        const cascadeCandidates = store.constraintStore.getConstraintsForGeometry(removedIds);
        for (const c of cascadeCandidates) {
          store.constraintStore.constraints.delete(c.id);
        }

        // 재매핑 시도
        const remapped: SketchConstraint[] = [];
        const notRemappable: SketchConstraint[] = [];

        for (const c of cascadeCandidates) {
          const cloned = this._tryRemapConstraint(c, removedIds);
          if (cloned) {
            remapped.push(cloned);
          } else {
            notRemappable.push(c);
          }
        }

        this._cascadeRemovedConstraints = notRemappable;
        this._remappedConstraints = remapped;

        // 재매핑된 구속 복원
        store.constraintStore.addConstraints(remapped);
      } else {
        // 재매핑 없음 → 기존 동작
        this._cascadeRemovedConstraints = store.constraintStore.removeConstraintsForGeometry(removedIds);
        this._remappedConstraints = [];
      }
    }

    // 2. 기하 제거
    for (const id of removedIds) {
      store.geometries.delete(id);
    }

    // 3. 기하 추가
    for (const geom of this._addedGeometries) {
      store.geometries.set(geom.id, geom);
    }

    // 4. 구속 추가
    if (store.constraintStore) {
      store.constraintStore.addConstraints(this._addedConstraints);
    }

    // 선택 초기화
    store.selectedIds = store.selectedIds.filter((id) => !removedIds.has(id));
    const h = store.hoveredItem;
    if (h && (h.kind === "geometry" || h.kind === "vertex") && removedIds.has(h.geomId)) store.hoveredItem = null;
  }

  undo(store: SketchGeometryStore): void {
    // 역순: 추가된 기하/구속 제거 → 제거된 기하/구속 복원

    // 1. 추가된 구속 + 재매핑된 구속 제거
    if (store.constraintStore) {
      for (const c of this._addedConstraints) {
        store.constraintStore.constraints.delete(c.id);
      }
      for (const c of this._remappedConstraints) {
        store.constraintStore.constraints.delete(c.id);
      }
    }

    // 2. 추가된 기하 제거
    for (const geom of this._addedGeometries) {
      store.geometries.delete(geom.id);
    }

    // 3. 제거된 기하 복원
    for (const geom of this._removedGeometries) {
      store.geometries.set(geom.id, geom);
    }
    store.restoreShapes(this._removedShapes);

    // 4. 제거된 구속 복원
    // - _removedConstraints: 명시적으로 제거된 구속
    // - _cascadeRemovedConstraints: 재매핑 불가능하여 삭제된 구속
    // - _remappedOriginals: 재매핑된 구속의 원본 (clone 전 상태)
    if (store.constraintStore) {
      store.constraintStore.addConstraints([
        ...this._removedConstraints,
        ...this._cascadeRemovedConstraints,
        ...this._remappedOriginals,
      ]);
    }
  }

  // 재매핑 원본 (undo용)
  private _remappedOriginals: SketchConstraint[] = [];

  // 구속의 기하 참조를 새 기하로 재매핑 시도
  // 모든 참조가 유효하면 clone 반환, 하나라도 실패하면 null
  private _tryRemapConstraint(
    c: SketchConstraint,
    removedIds: Set<string>,
  ): SketchConstraint | null {
    // 이 구속이 참조하는 geomId 중 제거 대상인 것이 있는지 확인
    // 모두 재매핑 가능해야 유지
    const cloned = structuredClone(c);

    let fullyMapped = true;

    const remapPointRef = (ref: ConstraintPointRef): boolean => {
      if (!removedIds.has(ref.geomId)) return true; // 제거 대상 아님
      const remap = this._vertexRemaps.find(
        (r) => r.oldGeomId === ref.geomId && r.oldVertexIndex === ref.vertexIndex,
      );
      if (!remap) return false;
      ref.geomId = remap.newGeomId;
      ref.vertexIndex = remap.newVertexIndex;
      return true;
    };

    const remapGeomRef = (ref: ConstraintGeomRef): boolean => {
      if (!removedIds.has(ref.geomId)) return true;
      const remap = this._geomRemaps.find((r) => r.oldGeomId === ref.geomId);
      if (!remap) return false;
      ref.geomId = remap.newGeomId;
      return true;
    };

    switch (cloned.type) {
      case "coincident":
        fullyMapped = remapPointRef(cloned.pointA) && remapPointRef(cloned.pointB);
        break;
      case "horizontal":
      case "vertical":
        fullyMapped = remapGeomRef(cloned.line);
        break;
      case "fix":
        fullyMapped = remapPointRef(cloned.point);
        break;
      case "distance":
        fullyMapped = remapPointRef(cloned.pointA) && remapPointRef(cloned.pointB);
        break;
      case "equal":
      case "parallel":
      case "perpendicular":
      case "colinear":
        fullyMapped = remapGeomRef(cloned.lineA) && remapGeomRef(cloned.lineB);
        break;
      case "tangent":
        fullyMapped = remapGeomRef(cloned.entityA) && remapGeomRef(cloned.entityB);
        break;
      case "midpoint":
        fullyMapped = remapPointRef(cloned.point) && remapGeomRef(cloned.line);
        break;
      case "point_on_line":
        fullyMapped = remapPointRef(cloned.point) && remapGeomRef(cloned.line);
        break;
      case "concentric":
        fullyMapped = remapGeomRef(cloned.circleA) && remapGeomRef(cloned.circleB);
        break;
      case "point_on_circle":
        fullyMapped = remapPointRef(cloned.point) && remapGeomRef(cloned.circle);
        break;
      case "radius":
        fullyMapped = remapGeomRef(cloned.circle);
        break;
      case "equal_radius":
        fullyMapped = remapGeomRef(cloned.circleA) && remapGeomRef(cloned.circleB);
        break;
      case "line_length":
        fullyMapped = remapGeomRef(cloned.line);
        break;
      case "angle":
        fullyMapped = remapGeomRef(cloned.lineA) && remapGeomRef(cloned.lineB);
        break;
      case "point_line_distance":
        fullyMapped = remapPointRef(cloned.point) && remapGeomRef(cloned.line);
        break;
      case "symmetric":
        fullyMapped = remapPointRef(cloned.pointA) && remapPointRef(cloned.pointB) && remapGeomRef(cloned.axis);
        break;
    }

    if (fullyMapped) {
      this._remappedOriginals.push(c); // undo용 원본 저장
      return cloned;
    }
    return null;
  }
}

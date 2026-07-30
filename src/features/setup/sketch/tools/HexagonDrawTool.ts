// 정육각형 그리기 도구: CATIA 방식 2클릭 — 중심 → 변의 중점
// 두 번째 클릭이 한 변의 중점을 지정 → across-flats 치수 + 회전 각도 동시 결정
// 6개 line + 6개 coincident + 5개 equal 구속으로 생성

import type { SerializedGeometry, SketchDrawToolType } from "../../Setup.type";

import { AddRectangleCommand } from "../commands/AddRectangleCommand";
import { BatchCommand } from "../commands/BatchCommand";
import { computeGeometryInferences } from "../InferenceEngine";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import type { SketchInputField, SketchInputFieldType } from "./DrawTool";
import { DrawTool } from "./DrawTool";

// 중심 + 변 중점(apothem) → 6개 꼭짓점 계산
function computeHexagonVertices(
  center: { x: number; y: number },
  midSidePos: { x: number; y: number },
): { x: number; y: number }[] {
  const dx = midSidePos.x - center.x;
  const dy = midSidePos.y - center.y;
  const apothem = Math.hypot(dx, dy); // 중심 → 변 중점 거리 = 내접원 반지름
  if (apothem < 1e-9) return [];

  // 변 중점 방향 각도 (이 방향이 한 변의 법선 = 변의 중점 방향)
  const midAngle = Math.atan2(dy, dx);

  // 외접원 반지름: R = apothem / cos(30°)
  const R = apothem / Math.cos(Math.PI / 6);

  // 첫 꼭짓점은 변 중점 방향에서 +30° 위치
  // 변의 중점이 midAngle 방향이면, 그 변의 양 끝 꼭짓점은 midAngle ± 30°
  const vertices: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = midAngle + Math.PI / 6 + (Math.PI / 3) * i;
    vertices.push({
      x: center.x + R * Math.cos(angle),
      y: center.y + R * Math.sin(angle),
    });
  }
  return vertices;
}

export class HexagonDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "hexagon";

  private _center: { x: number; y: number } | null = null;

  onPointerDown(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    if (!this._center) {
      // 첫 클릭: 중심 설정
      this._recordSnap(store);
      this._center = { ...snappedPos };
    } else {
      // 두 번째 클릭: 변의 중점 → 정육각형 확정
      const apothem = Math.hypot(snappedPos.x - this._center.x, snappedPos.y - this._center.y);
      if (apothem < 0.1) return;
      this._recordSnap(store);

      const vertices = computeHexagonVertices(this._center, snappedPos);
      if (vertices.length !== 6) return;

      // 6개 line ID 생성
      const lineIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        lineIds.push(this._generateId());
      }

      // 6개 line 기하 생성
      const geometries: SerializedGeometry[] = [];
      for (let i = 0; i < 6; i++) {
        const next = (i + 1) % 6;
        geometries.push({
          type: "line",
          id: lineIds[i],
          x1: vertices[i].x,
          y1: vertices[i].y,
          x2: vertices[next].x,
          y2: vertices[next].y,
        });
      }

      // 6개 coincident 구속: line[i].end ≡ line[(i+1)%6].start
      let cIdx = 0;
      const cid = () => `cst_${lineIds[0]}_${cIdx++}`;
      const constraints = [];
      for (let i = 0; i < 6; i++) {
        const next = (i + 1) % 6;
        constraints.push({
          type: "coincident" as const,
          id: cid(),
          pointA: { geomId: lineIds[i], vertexIndex: 1 },
          pointB: { geomId: lineIds[next], vertexIndex: 0 },
        });
      }

      // Equal: 체인으로 6변 모두 같은 길이 (5개 구속)
      for (let i = 0; i < 5; i++) {
        constraints.push({
          type: "equal" as const,
          id: cid(),
          lineA: { geomId: lineIds[i] },
          lineB: { geomId: lineIds[i + 1] },
        });
      }

      const finalGeometries = this.constructionMode
        ? geometries.map((g) => ({ ...g, isConstruction: true }))
        : geometries;

      // Snap 기반 auto-constraint — center / apothem 점 자체는 vertex 가 아니지만 클릭이
      // 다른 entity (기존 point/center 등) 와 snap 됐다면 가까운 hex vertex 에 coincident.
      // click 0 = center → 매핑 X (hex 자체는 center point geom 없음).
      // click 1 = apothem point → hex 변의 중점 — vertex 직접 없음. snap candidate 없으면 skip.
      // 현재는 _recordSnap 만 보존 (향후 hex center geom 추가 시 활용).
      const autoCmds = this._buildSnapConstraints(store, []);

      const mainCmd = new AddRectangleCommand(finalGeometries, constraints);
      if (autoCmds.length > 0) {
        store.execute(new BatchCommand([mainCmd, ...autoCmds]));
      } else {
        store.execute(mainCmd);
      }

      this._center = null;
      this._clearSnaps();
      this.preview = null;
      this.previews = [];
    }
  }

  onPointerMove(
    store: SketchGeometryStore,
    _rawPos: { x: number; y: number },
    snappedPos: { x: number; y: number },
  ): void {
    // 기하 기반 추론선
    const geometries = [...store.geometries.values()];
    this.inferenceLines = computeGeometryInferences(
      snappedPos, store.snapResult, geometries, this.inferenceRadius,
    );

    if (!this._center) {
      store.requestRender();
      return;
    }

    // 정육각형 프리뷰 (변 중점 방식)
    const vertices = computeHexagonVertices(this._center, snappedPos);
    this.previews = [];
    for (let i = 0; i < vertices.length; i++) {
      const next = (i + 1) % vertices.length;
      this.previews.push({
        type: "line",
        id: `__preview_${i}__`,
        x1: vertices[i].x,
        y1: vertices[i].y,
        x2: vertices[next].x,
        y2: vertices[next].y,
      });
    }
    store.requestRender();
  }

  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    // 클릭 방식이므로 pointerUp에서는 처리 없음
  }

  hasPendingWork(): boolean {
    return this._center !== null;
  }

  override getInputFields(mousePos?: { x: number; y: number }): SketchInputField[] {
    const r = this._center && mousePos
      ? Math.hypot(mousePos.x - this._center.x, mousePos.y - this._center.y) : undefined;
    const a = this._center && mousePos
      ? Math.atan2(mousePos.y - this._center.y, mousePos.x - this._center.x) * 180 / Math.PI : undefined;
    return [
      { type: "H", label: "H", value: mousePos?.x },
      { type: "V", label: "V", value: mousePos?.y },
      { type: "R", label: "R", value: r },
      { type: "A", label: "A", value: a },
    ];
  }

  override applyInputValues(
    store: SketchGeometryStore,
    values: Partial<Record<SketchInputFieldType, number>>,
  ): boolean {
    if (!this._center) {
      if (values.H !== undefined && values.V !== undefined) {
        this.onPointerDown(store, { x: values.H, y: values.V }, { x: values.H, y: values.V });
        return true;
      }
      return false;
    }
    // R+A → 중심에서 apothem 거리 + 각도의 점으로 클릭
    if (values.R !== undefined) {
      const a = (values.A ?? 0) * Math.PI / 180;
      this.onPointerDown(store, {
        x: this._center.x + values.R * Math.cos(a),
        y: this._center.y + values.R * Math.sin(a),
      }, {
        x: this._center.x + values.R * Math.cos(a),
        y: this._center.y + values.R * Math.sin(a),
      });
      return true;
    }
    return false;
  }

  cancel(): void {
    super.cancel();
    this._center = null;
    this._clearSnaps();
  }
}

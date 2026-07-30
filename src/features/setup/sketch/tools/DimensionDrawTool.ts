// CATIA V5 스타일 Dimension(치수) 도구
// 마우스 위치 = 치수 텍스트 위치. 텍스트에서 기하까지 치수선/확장선이 그려짐.
// store를 변경하지 않고 override로 dimension 감지 → race condition 없음


import type { DimensionChainMode, SketchDrawToolType, VertexHandle } from "../../Setup.type";

import type { DimensionConstraintType } from "../constraints/ConstraintValidator";
import {
  computeAngleFromLabelPos,
  computeDimensionDefaultValue,
  computeDimensionLabelReference,
  createDimensionConstraint,
  getDimensionConstraintType,
} from "../constraints/ConstraintValidator";
import type { SketchConstraint } from "../constraints/SketchConstraint.type";
import type { SketchGeometryStore } from "../SketchGeometryStore";

import { resolveDistanceVariant9Region, isDistanceVariant } from "./dimensionVariantResolver";
import { DrawTool } from "./DrawTool";

type DimStage = "idle" | "selected" | "placing";

export type DimensionPlacementResult = {
  dimType: DimensionConstraintType;
  defaultValue: number;
  labelPos: { x: number; y: number };
};

export class DimensionDrawTool extends DrawTool {
  readonly type: SketchDrawToolType = "dimension";
  selectionOnly = true;

  stage: DimStage = "idle";
  detectedType: DimensionConstraintType | null = null;
  detectedValue = 0;
  labelPos: { x: number; y: number } | null = null;

  // Dimension chain/baseline 모드 — 외부에서 atom을 통해 동기화
  chainMode: DimensionChainMode = "single";
  // chain/baseline 모드에서 다음 치수 첫 번째 vertex로 재사용할 anchor
  private _chainAnchor: VertexHandle | null = null;
  // chain/baseline 모드에서 labelPos 누적 오프셋 (y축 기본)
  private _lastLabelPos: { x: number; y: number } | null = null;

  private _sel: { geomIds: string[]; vertexHandles: VertexHandle[] } = { geomIds: [], vertexHandles: [] };

  onPlaced: ((result: DimensionPlacementResult) => void) | null = null;
  onOverConstrained: ((constraint: SketchConstraint, result: DimensionPlacementResult) => void) | null = null;

  // ConstraintRenderer가 읽는 프리뷰
  previewConstraint: {
    type: DimensionConstraintType;
    value: number;
    labelPos: { x: number; y: number };
    geomIds: string[];
    vertexHandles: VertexHandle[];
  } | null = null;

  private _detect(store: SketchGeometryStore, geomIds: string[], vertexHandles: VertexHandle[]) {
    const override = { selectedIds: geomIds, selectedVertices: vertexHandles };
    const type = getDimensionConstraintType(store, override);
    if (!type) return null;
    const value = computeDimensionDefaultValue(type, store, override);
    return { type, value };
  }

  // --- 이벤트 ---

  onPointerDown(store: SketchGeometryStore, rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    if (this.stage === "idle") { this._handleFirstPick(store, rawPos); return; }
    if (this.stage === "selected") { this._handleSecondPick(store, rawPos); return; }
    if (this.stage === "placing") {
      const excludeIds = new Set(this._sel.geomIds);
      const hitVertex = this._hitTestVertex(store, rawPos, excludeIds);
      const hitId = hitVertex ? null : this._hitTestGeometry(store, rawPos, excludeIds);
      if (hitId || hitVertex) {
        this._addToSelection(hitId, hitVertex);
        const det = this._detect(store, this._sel.geomIds, this._sel.vertexHandles);
        if (det) {
          this.detectedType = det.type;
          this.detectedValue = det.value;
          this.labelPos = { ...rawPos };
          this._syncStoreSelection(store);
          this._updatePreview();
          store.requestRender();
        }
      } else {
        this._confirmPlacement(store);
      }
      return;
    }
  }

  onPointerMove(store: SketchGeometryStore, rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {
    if (this.stage === "idle") { this._updateHover(store, rawPos); return; }
    if (this.stage === "selected") { this._updateHoverWithPreview(store, rawPos); return; }
    if (this.stage === "placing") {
      // placing 중에도 hover 스타일 표시 (추가 선택 가능)
      this._updateHover(store, rawPos);
      this.labelPos = { ...rawPos };
      // CATIA 9-영역 자동 감지: distance 변종 / line_length 변종 동적 전환
      this._maybeResolveDistanceVariant(store, rawPos);
      // angle: 라벨 영역 → c.value 사잇각/보각 자동 (panel 표시값 = 라벨 보이는 값).
      // solver 매핑이 c.value 가 자연 line angle 에 가까우면 자연 값 그대로 enforce → line 안 움직임.
      this._maybeResolveAngleVariant(store, rawPos);
      this._updatePreview();
      store.requestRender();
      return;
    }
  }

  /**
   * angle dim 의 라벨 영역 자동 감지 (problem-definition 의 zone 패턴).
   * 라벨이 사잇각 영역 (helper 결과 < 90) → c.value = 사잇각, isAcute=true.
   * 라벨이 보각 영역 (helper 결과 ≥ 90) → c.value = 보각, isAcute=false.
   * 적용 시점에 결정되어 이후 고정. solver 매핑이 isAcute=false 면 (180-c.value) enforce → line 안 움직임.
   */
  private _maybeResolveAngleVariant(store: SketchGeometryStore, labelPos: { x: number; y: number }): void {
    if (this.detectedType !== "angle") return;
    if (this._sel.geomIds.length !== 2) return;
    const lA = store.geometries.get(this._sel.geomIds[0]);
    const lB = store.geometries.get(this._sel.geomIds[1]);
    if (!lA || lA.type !== "line" || !lB || lB.type !== "line") return;
    const angle = computeAngleFromLabelPos(lA, lB, labelPos);
    if (angle !== null && angle > 0 && angle < 180) {
      this.detectedValue = angle;
      // angle ≤ 90 → 사잇각, > 90 → 보각
      this._isAngleAcute = angle <= 90;
    }
  }

  /** angle dim 의 적용 시점 사잇각 여부 (true = 사잇각, false = 보각). default 사잇각. */
  private _isAngleAcute = true;

  /**
   * CATIA 9-영역 자동 감지 (vertex 2개 한정). 라벨 위치 → distance / h_distance / v_distance.
   * 실제 로직은 dimensionVariantResolver 의 순수 함수에 분리 (단위 테스트 가능).
   * line 1개 케이스는 CATIA 표준이 불확실해 적용하지 않음 — line_length 만 유지.
   */
  private _maybeResolveDistanceVariant(_store: SketchGeometryStore, labelPos: { x: number; y: number }): void {
    if (!isDistanceVariant(this.detectedType)) return;
    const verts = this._sel.vertexHandles;
    if (verts.length !== 2) return;
    const result = resolveDistanceVariant9Region(verts[0], verts[1], labelPos);
    this.detectedType = result.type;
    this.detectedValue = result.value;
  }


  onPointerUp(_store: SketchGeometryStore, _rawPos: { x: number; y: number }, _snappedPos: { x: number; y: number }, _event: PointerEvent): void {}

  override onKeyDown(store: SketchGeometryStore, event: KeyboardEvent): void {
    if (event.key === "Escape" && this.stage !== "idle") {
      this._resetToIdle(store);
      store.requestRender();
    }
  }

  override hasPendingWork(): boolean { return this.stage !== "idle"; }

  override cancel(): void {
    this.stage = "idle";
    this.detectedType = null;
    this.detectedValue = 0;
    this.labelPos = null;
    this._chainAnchor = null;
    this._lastLabelPos = null;
    this._isAngleAcute = true;

    this._sel = { geomIds: [], vertexHandles: [] };
    this.previewConstraint = null;
    super.cancel();
  }

  // --- 내부 ---

  private _handleFirstPick(store: SketchGeometryStore, rawPos: { x: number; y: number }): void {
    const hitVertex = this._hitTestVertex(store, rawPos);
    const hitId = hitVertex ? null : this._hitTestGeometry(store, rawPos); // vertex 우선
    if (!hitId && !hitVertex) return;

    this._sel = { geomIds: hitId ? [hitId] : [], vertexHandles: hitVertex ? [hitVertex] : [] };
    this._syncStoreSelection(store);

    const det = this._detect(store, this._sel.geomIds, this._sel.vertexHandles);
    if (det) {
      this.detectedType = det.type;
      this.detectedValue = det.value;
      this.stage = "placing";
      this.labelPos = { ...rawPos };
      this._updatePreview();
    } else {
      this.stage = "selected";
      this.previewConstraint = null;
    }
    store.requestRender();
  }

  private _handleSecondPick(store: SketchGeometryStore, rawPos: { x: number; y: number }): void {
    const hitVertex = this._hitTestVertex(store, rawPos);
    const hitId = hitVertex ? null : this._hitTestGeometry(store, rawPos);
    if (!hitId && !hitVertex) return;

    this._addToSelection(hitId, hitVertex);
    const det = this._detect(store, this._sel.geomIds, this._sel.vertexHandles);
    if (det) {
      this.detectedType = det.type;
      this.detectedValue = det.value;
      this.stage = "placing";
      this.labelPos = { ...rawPos };
      // 두 번째 pick (= 라벨 첫 위치) 시점에 angle 변종 즉시 결정
      this._maybeResolveAngleVariant(store, rawPos);
      this._syncStoreSelection(store);
      this._updatePreview();
      store.requestRender();
    }
  }

  private _addToSelection(hitId: string | null, hitVertex: VertexHandle | null): void {
    if (hitVertex && !this._sel.vertexHandles.some((v) => v.geomId === hitVertex.geomId && v.vertexIndex === hitVertex.vertexIndex)) {
      this._sel.vertexHandles.push(hitVertex);
    }
    if (hitId && !this._sel.geomIds.includes(hitId)) {
      this._sel.geomIds.push(hitId);
    }
  }

  private _syncStoreSelection(store: SketchGeometryStore): void {
    store.selectedIds = [...this._sel.geomIds];
    store.selectedVertices = this._sel.vertexHandles.filter(
      (v) => !store.geometries.get(v.geomId)?.isReference,
    );
  }

  private _confirmPlacement(store: SketchGeometryStore): void {
    if (!this.detectedType || !this.labelPos) return;

    // constraint value는 항상 기하적 각도(0~180°)를 사용
    // 표시 각도(섹터 기반)는 렌더러가 labelPos에서 계산
    const finalValue = this.detectedValue;

    const result: DimensionPlacementResult = {
      dimType: this.detectedType,
      defaultValue: finalValue,
      labelPos: { ...this.labelPos },
    };

    const savedIds = [...store.selectedIds];
    const savedVerts = [...store.selectedVertices];
    store.selectedIds = [...this._sel.geomIds];
    store.selectedVertices = [...this._sel.vertexHandles];
    const constraint = createDimensionConstraint(this.detectedType, store, finalValue);
    store.selectedIds = savedIds;
    store.selectedVertices = savedVerts;

    if (constraint) {
      // labelPos: 절대좌표 (레거시 호환). labelOffset: 기하 reference 기준 상대 — 기하가
      // 움직이면 라벨이 따라가도록. reference 계산 가능한 경우에만 offset 저장.
      (constraint as Record<string, unknown>).labelPos = { ...this.labelPos };
      const ref = computeDimensionLabelReference(constraint, store.geometries);
      if (ref) {
        (constraint as Record<string, unknown>).labelOffset = {
          x: this.labelPos.x - ref.x,
          y: this.labelPos.y - ref.y,
        };
      }
      // angle dim 의 isAcute flag (보각 영역 라벨이면 false → solver 가 180-c.value enforce).
      // default (= true, 사잇각) 는 생략 — undefined 도 사잇각으로 처리됨.
      if (constraint.type === "angle" && !this._isAngleAcute) {
        (constraint as Record<string, unknown>).isAcute = false;
      }
      const ok = store.tryApplyConstraint(constraint);
      if (!ok && this.onOverConstrained) {
        this.onOverConstrained(constraint, result);
        this._resetToIdle(store);
        store.requestRender();
        return;
      }
    }

    this.onPlaced?.(result);

    // Chain/Baseline 모드: 다음 치수 첫 vertex를 자동 prefill
    if (this._shouldContinueChain(this.detectedType)) {
      this._continueChain(store, result.labelPos);
    } else {
      this._resetToIdle(store);
    }
    store.requestRender();
  }

  /** chain/baseline 모드 지속 여부 — vertex-pair 기반 거리 타입만 지원 */
  private _shouldContinueChain(type: DimensionConstraintType | null): boolean {
    if (this.chainMode === "single") return false;
    if (this._sel.vertexHandles.length < 2) return false;
    return type === "distance" || type === "horizontal_distance" || type === "vertical_distance";
  }

  /** 다음 치수를 위한 _sel/stage 재설정 (chain: 마지막 vertex 유지, baseline: 첫 vertex 유지) */
  private _continueChain(store: SketchGeometryStore, lastLabelPos: { x: number; y: number }): void {
    const verts = this._sel.vertexHandles;
    const anchor = this.chainMode === "chain" ? verts[verts.length - 1] : verts[0];
    this._chainAnchor = anchor;
    this._lastLabelPos = { ...lastLabelPos };

    this.stage = "selected";
    this.detectedType = null;
    this.detectedValue = 0;
    this.labelPos = null;
    this._sel = { geomIds: [], vertexHandles: [anchor] };
    this.previewConstraint = null;
    store.selectedIds = [];
    store.selectedVertices = [anchor];
    store.hoveredItem = null;
  }

  private _updateHover(store: SketchGeometryStore, rawPos: { x: number; y: number }): void {
    if (this._updateHoveredItem(store, rawPos)) {
      store.requestRender();
    }
  }

  private _updateHoverWithPreview(store: SketchGeometryStore, rawPos: { x: number; y: number }): void {
    const excludeIds = new Set(this._sel.geomIds);
    const changed = this._updateHoveredItem(store, rawPos, excludeIds);
    const h = store.hoveredItem;
    const hitVertex = h?.kind === "vertex" ? { geomId: h.geomId, vertexIndex: h.vertexIndex, x: h.x, y: h.y } : null;
    const hitId = h?.kind === "geometry" ? h.geomId : hitVertex?.geomId ?? null;

    const prevType = this.previewConstraint?.type ?? null;
    if (hitId || hitVertex) {
      const tempGeomIds = [...this._sel.geomIds];
      const tempVerts = [...this._sel.vertexHandles];
      if (hitVertex && !tempVerts.some((v) => v.geomId === hitVertex.geomId && v.vertexIndex === hitVertex.vertexIndex)) tempVerts.push(hitVertex);
      if (hitId && !tempGeomIds.includes(hitId)) tempGeomIds.push(hitId);

      const det = this._detect(store, tempGeomIds, tempVerts);
      if (det) {
        this.previewConstraint = {
          type: det.type, value: det.value,
          labelPos: { ...rawPos },
          geomIds: tempGeomIds, vertexHandles: tempVerts,
        };
      } else {
        this.previewConstraint = null;
      }
    } else {
      this.previewConstraint = null;
    }

    if (changed || (this.previewConstraint?.type ?? null) !== prevType) {
      store.requestRender();
    }
  }

  private _updatePreview(): void {
    if (!this.detectedType || !this.labelPos) { this.previewConstraint = null; return; }
    this.previewConstraint = {
      type: this.detectedType, value: this.detectedValue,
      labelPos: { ...this.labelPos },
      geomIds: this._sel.geomIds, vertexHandles: this._sel.vertexHandles,
    };
  }

  private _resetToIdle(store: SketchGeometryStore): void {
    this.stage = "idle";
    this.detectedType = null;
    this.detectedValue = 0;
    this.labelPos = null;
    this._chainAnchor = null;
    this._lastLabelPos = null;
    this._isAngleAcute = true;
    this._sel = { geomIds: [], vertexHandles: [] };
    this.previewConstraint = null;
    store.selectedIds = [];
    store.selectedVertices = [];
    store.hoveredItem = null;
  }

  // --- 히트 테스트 ---

  private _hitTestGeometry(store: SketchGeometryStore, rawPos: { x: number; y: number }, excludeIds?: Set<string>): string | null {
    // store.hitTest와 동일한 로직 사용 (일관된 히트박스)
    const hitId = store.hitTest(rawPos, this.hitRadius);
    if (!hitId) return null;
    if (excludeIds?.has(hitId)) return null;
    return hitId;
  }

  private _hitTestVertex(store: SketchGeometryStore, rawPos: { x: number; y: number }, excludeIds?: Set<string>): VertexHandle | null {
    // store의 hitTestVertexAll과 동일한 반경/로직 사용 (일관된 히트박스)
    const hit = store.hitTestVertexAll(rawPos, this.hitRadius);
    if (!hit) return null;
    if (excludeIds?.has(hit.geomId)) return null;
    return hit;
  }


}

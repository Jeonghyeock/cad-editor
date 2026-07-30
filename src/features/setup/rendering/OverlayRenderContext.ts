// 서브 렌더러들이 공유하는 컨텍스트 (상태 + 유틸리티)

import * as THREE from "three";

import type { HoverItem, SerializedGeometry, SketchPlane } from "../Setup.type";
import type { SketchConstraintStore } from "../sketch/constraints/SketchConstraintStore";
import type { SketchGeometryStore } from "../sketch/SketchGeometryStore";
import type { DrawTool } from "../sketch/tools/DrawTool";
import { hoverItemsEqual } from "../utils/hoverItemsEqual";

import { POINT_RADIUS } from "./overlayConstants";

// 서브 렌더러 인터페이스
export interface OverlaySubRenderer {
  sync(ctx: OverlayRenderContext): void;
  clearAll(ctx: OverlayRenderContext): void;
  clear(): void;
  dispose(): void;
}

export class OverlayRenderContext {
  readonly group: THREE.Group;
  sketchPlane: SketchPlane | null = null;
  store: SketchGeometryStore | null = null;
  constraintStore: SketchConstraintStore | null = null;
  camera: THREE.OrthographicCamera | null = null;
  canvasHeight = 1;
  /**
   * 3D 모드에서 활성 카메라 (perspective 또는 ortho) + canvas 로 wpp 계산.
   * SceneManager 가 setActiveCameraProvider 로 inject. ctx.camera 없을 때 fallback.
   */
  getActiveWpp: (() => number) | null = null;
  planeQuat = new THREE.Quaternion();
  circleGeom: THREE.CircleGeometry;
  drawTool: DrawTool | null = null;
  pointerPos: { x: number; y: number } | null = null;

  // 박스 선택 상태
  selectionBoxStart: { x: number; y: number } | null = null;
  selectionBoxEnd: { x: number; y: number } | null = null;

  // 외부 기하 참조
  externalGeometries: SerializedGeometry[] = [];

  // 다른 씬의 SO에 해당하는 geometry ID (메인 루프에서 숨김)
  hiddenGeoIds: Set<string> = new Set();

  // 구속조건 표시 토글 (false → ConstraintRenderer에서 렌더링 스킵)
  constraintVisible = true;

  // 구속조건 타입별 필터 (master toggle과 AND) — CATIA V5 스타일 부분 표시
  constraintFilter: { geometric: boolean; dimensional: boolean } = { geometric: true, dimensional: true };

  // 의존성 하이라이트 (Parent/Child) — 선택 변경 시 InputCanvas가 계산해 주입
  dependencyGeomIds: Set<string> = new Set();
  dependencyConstraintIds: Set<string> = new Set();

  // Undo/Redo 피드백: 플래시 표시할 기하 ID (일시적)
  flashGeomIds: Set<string> = new Set();

  // dirty 추적: 변경된 기하 ID만 재렌더링
  dirtyGeometries: Set<string> = new Set();
  fullRedraw = true; // 첫 sync 또는 토폴로지 변경 시 전체 재렌더링
  // 이전 프레임 상태 (변경 감지용)
  private _prevHoveredItem: HoverItem | null = null;
  private _prevSelectedIds: string[] = [];
  /** vertex selection 변경도 dirty 추적 — point geom 처럼 vertex == geometry 인 경우 색 갱신 필요. */
  private _prevSelectedVertexGeomIds: string[] = [];
  private _prevSolveStatus: string = "ok";
  private _prevGeomCount = 0;
  private _prevConstraintCount = 0;
  private _prevZoom = 0;
  private _prevGeometryVersion = -1;

  // 변경 감지 + dirty 마킹 (sync 전에 호출)
  detectDirty(): void {
    if (!this.store) { this.fullRedraw = true; return; }

    const store = this.store;
    const currentSelectedIds = store.selectedIds;

    // 카메라 zoom 변경 → 전체 재렌더링 (픽셀 기반 크기 요소 업데이트 필요)
    const currentZoom = this.camera?.zoom ?? 0;
    if (Math.abs(currentZoom - this._prevZoom) > 1e-6) {
      this.fullRedraw = true;
      this._prevZoom = currentZoom;
    }

    // 기하 좌표/구속 변경 → 전체 재렌더링 (드래그, 솔브, 커맨드 실행 시만)
    if (store.geometryVersion !== this._prevGeometryVersion) {
      this.fullRedraw = true;
      this._prevGeometryVersion = store.geometryVersion;
    }

    // 기하 개수 변경 → 전체 재렌더링
    if (store.geometries.size !== this._prevGeomCount) {
      this.fullRedraw = true;
      this._prevGeomCount = store.geometries.size;
    }

    // 구속 개수 변경 → 전체 재렌더링
    const cstCount = this.constraintStore?.constraints.size ?? 0;
    if (cstCount !== this._prevConstraintCount) {
      this.fullRedraw = true;
      this._prevConstraintCount = cstCount;
    }

    // 솔버 상태 변경 → 전체 재렌더링 (색상이 전역적으로 변경될 수 있음)
    if (store.solveStatus !== this._prevSolveStatus) {
      this.fullRedraw = true;
      this._prevSolveStatus = store.solveStatus;
    }

    if (!this.fullRedraw) {
      // hover 변경 → 이전/현재 hovered 관련 기하만 dirty (Phase 1B: fullRedraw 완화).
      // 사각형 N 개 face hover 시마다 모든 mesh 재생성되는 N 비례 비용을 제거.
      const prevH = this._prevHoveredItem;
      const currH = store.hoveredItem;
      if (!hoverItemsEqual(prevH, currH)) {
        if (prevH && (prevH.kind === "geometry" || prevH.kind === "vertex")) {
          this.dirtyGeometries.add(prevH.geomId);
        }
        if (currH && (currH.kind === "geometry" || currH.kind === "vertex")) {
          this.dirtyGeometries.add(currH.geomId);
        }
        // face hover — 해당 shape 의 lineIds 만 dirty (사각형 4 개 line). fullRedraw X.
        if (prevH?.kind === "face") {
          const sh = store.shapes.find((s) => s.id === prevH.faceId);
          if (sh) sh.lineIds.forEach((id) => this.dirtyGeometries.add(id));
        }
        if (currH?.kind === "face") {
          const sh = store.shapes.find((s) => s.id === currH.faceId);
          if (sh) sh.lineIds.forEach((id) => this.dirtyGeometries.add(id));
        }
        // constraint hover — constraint id 만 ConstraintRenderer 가 dirty 검사로 처리.
        // 별도 dirtyConstraints 시스템 없으면 모든 constraint label 매 hover 재생성되는 비용
        // 있지만 보통 constraint 수가 geometry 보다 적음. 추가 최적화는 ConstraintRenderer
        // 자체 dirty 추적 도입 시 (Phase 2 이후).
      }

      // selection 변경 → 이전/현재 selected ID만 dirty
      const prevSet = new Set(this._prevSelectedIds);
      const currSet = new Set(currentSelectedIds);
      for (const id of prevSet) {
        if (!currSet.has(id)) this.dirtyGeometries.add(id);
      }
      for (const id of currSet) {
        if (!prevSet.has(id)) this.dirtyGeometries.add(id);
      }

      // vertex selection 변경 — point geom 등 vertex == geometry 인 경우 색 갱신.
      // 모든 vertex selection geomId 를 추적 (point 가 아닌 line endpoint 도 포함되지만
      // dirty mark 만 하므로 cost 미미).
      const currVertGeoms = store.selection
        .filter((s) => s.kind === "vertex")
        .map((s) => s.geomId);
      const prevVertSet = new Set(this._prevSelectedVertexGeomIds);
      const currVertSet = new Set(currVertGeoms);
      for (const id of prevVertSet) {
        if (!currVertSet.has(id)) this.dirtyGeometries.add(id);
      }
      for (const id of currVertSet) {
        if (!prevVertSet.has(id)) this.dirtyGeometries.add(id);
      }
    }

    this._prevHoveredItem = store.hoveredItem;
    this._prevSelectedIds = [...currentSelectedIds];
    this._prevSelectedVertexGeomIds = store.selection
      .filter((s) => s.kind === "vertex")
      .map((s) => s.geomId);
  }

  // dirty 상태 초기화 (sync 완료 후 호출)
  clearDirty(): void {
    this.dirtyGeometries.clear();
    this.fullRedraw = false;
  }

  // 외부에서 특정 기하를 dirty로 마킹
  markDirty(geomId: string): void {
    this.dirtyGeometries.add(geomId);
  }

  // 전체 재렌더링 요청
  markFullRedraw(): void {
    this.fullRedraw = true;
  }

  constructor(group: THREE.Group) {
    this.group = group;
    this.circleGeom = new THREE.CircleGeometry(POINT_RADIUS, 16);
  }

  // 1 픽셀에 해당하는 월드 크기 (ortho 카메라 기준)
  get worldPerPixel(): number {
    if (!this.camera) return 1;
    const zoom = this.camera.zoom || 1;
    return (this.camera.top - this.camera.bottom) / zoom / this.canvasHeight;
  }

  // 2D 평면 좌표 → 3D 월드 좌표
  toWorld(x: number, y: number): THREE.Vector3 {
    const p = this.sketchPlane!;
    return new THREE.Vector3(
      p.origin.x + x * p.u.x + y * p.v.x,
      p.origin.y + x * p.u.y + y * p.v.y,
      p.origin.z + x * p.u.z + y * p.v.z,
    );
  }

  // Three.js 오브젝트 재귀적 dispose
  disposeObject(obj: THREE.Object3D): void {
    if (obj instanceof THREE.Group) {
      for (const child of obj.children) this.disposeObject(child);
    } else if (obj instanceof THREE.Mesh) {
      // circleGeom은 공유이므로 dispose하지 않음
      if (obj.geometry !== this.circleGeom) {
        obj.geometry.dispose();
      }
      (obj.material as THREE.Material).dispose();
    } else if (obj instanceof THREE.Line) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    } else if (obj instanceof THREE.Sprite) {
      obj.material.map?.dispose();
      obj.material.dispose();
    }
  }

  dispose(): void {
    this.circleGeom.dispose();
  }
}

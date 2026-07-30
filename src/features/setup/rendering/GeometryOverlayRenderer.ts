// 기하 프리미티브를 Three.js 오브젝트로 시각화
// 서브 렌더러로 분할된 오케스트레이터

import * as THREE from "three";

import type { SerializedGeometry, SketchPlane } from "../Setup.type";
import type { SketchConstraintStore } from "../sketch/constraints/SketchConstraintStore";
import type { SketchGeometryStore } from "../sketch/SketchGeometryStore";
import type { DrawTool } from "../sketch/tools/DrawTool";

import { ConstraintRenderer } from "./ConstraintRenderer";
import { GeometryPrimitiveRenderer } from "./GeometryPrimitiveRenderer";
import { OverlayRenderContext } from "./OverlayRenderContext";
import { SelectionRenderer } from "./SelectionRenderer";
import { SnapIndicatorRenderer } from "./SnapIndicatorRenderer";

export class GeometryOverlayRenderer {
  private _scene: THREE.Scene;
  private _ctx: OverlayRenderContext;
  private _unsubscribe: (() => void) | null = null;
  private _constraintUnsub: (() => void) | null = null;
  /** Phase 4 — _sync (mutation) 후 호출. SceneManager 가 requestRender 로 GL render 예약. */
  private _onRenderNeeded: (() => void) | null = null;

  // 서브 렌더러
  private _geometryRenderer: GeometryPrimitiveRenderer;
  private _constraintRenderer: ConstraintRenderer;
  private _selectionRenderer: SelectionRenderer;
  private _snapRenderer: SnapIndicatorRenderer;

  constructor(scene: THREE.Scene) {
    this._scene = scene;
    const group = new THREE.Group();
    group.name = "geometry-overlay";
    scene.add(group);

    this._ctx = new OverlayRenderContext(group);
    this._geometryRenderer = new GeometryPrimitiveRenderer();
    this._constraintRenderer = new ConstraintRenderer();
    this._selectionRenderer = new SelectionRenderer();
    this._snapRenderer = new SnapIndicatorRenderer();
  }

  // --- 공개 API ---

  setSketchPlane(plane: SketchPlane | null): void {
    const prevPlane = this._ctx.sketchPlane;
    this._ctx.sketchPlane = plane;
    if (plane) {
      const normal = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z);
      this._ctx.planeQuat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    } else if (prevPlane !== null) {
      // sketch 종료 — 다음 _sync 가 sketchPlane null 가드로 sub-renderer sync 를 skip 하므로
      // 이전 sketch 모드에서 만들어진 sketch primitive mesh 가 풀에 잔존. 명시적 clearAll.
      this._geometryRenderer.clearAll(this._ctx);
      this._selectionRenderer.clearAll(this._ctx);
      this._snapRenderer.clearAll(this._ctx);
      this._constraintRenderer.clearAll(this._ctx);
    }
    if (this._ctx.store) this._sync();
  }

  /** 현재 오프셋 적용된 sketchPlane 반환 */
  getSketchPlane(): SketchPlane | null {
    return this._ctx.sketchPlane;
  }

  /** 외부 (setup index 의 length unit 변경 listener 등) 가 sketch overlay 전체 재빌드를 요청. */
  markFullRedrawAndSync(): void {
    if (!this._ctx.store) return;
    this._ctx.markFullRedraw();
    this._sync();
  }

  attachStore(store: SketchGeometryStore): void {
    this.detachStore();
    this._ctx.store = store;
    this._unsubscribe = store.addRenderListener(() => this._sync());
    this._sync();
  }

  detachStore(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this._ctx.store = null;
    this._clearAll();
  }

  /** 현재 연결된 geoStore 반환 */
  getStore(): SketchGeometryStore | null {
    return this._ctx.store;
  }

  /** 현재 worldPerPixel (EE 회전 핸들 위치 계산용) */
  get worldPerPixel(): number {
    return this._ctx.worldPerPixel;
  }

  setDrawTool(tool: DrawTool | null): void {
    this._ctx.drawTool = tool;
    if (this._ctx.store) this._sync();
  }

  setVisible(visible: boolean): void {
    if (this._ctx.group.visible === visible) return;
    this._ctx.group.visible = visible;
    if (visible && this._ctx.store) {
      this._ctx.markFullRedraw();
      this._sync();
    }
  }

  setCamera(camera: THREE.OrthographicCamera, canvasHeight: number): void {
    this._ctx.camera = camera;
    this._ctx.canvasHeight = canvasHeight || 1;
  }

  /** 활성 카메라 기반 wpp provider */
  setActiveWppProvider(provider: () => number): void {
    this._ctx.getActiveWpp = provider;
  }

  /** Phase 4 — _sync 후 render 예약 콜백. SceneManager 가 inject. */
  setOnRenderNeeded(cb: () => void): void {
    this._onRenderNeeded = cb;
  }

  setPointerPosition(pos: { x: number; y: number } | null): void {
    this._ctx.pointerPos = pos;
  }

  /** 외부에서 재렌더링 요청 (줌/팬 시 픽셀 기반 요소 업데이트) */
  requestSync(): void {
    if (this._ctx.store) this._sync();
  }

  /** face mesh 포함 전체 재렌더링 강제 요청 */
  requestFullRedraw(): void {
    this._ctx.markFullRedraw();
    if (this._ctx.store) this._sync();
  }

  updateConstraintHover(worldPos: { x: number; y: number } | null, hitRadius: number): void {
    this._constraintRenderer.updateHover(this._ctx, worldPos, hitRadius);
  }

  /** 거리 기반 constraint hitTest */
  hitTestConstraintWithDistance(worldPos: { x: number; y: number }, hitRadius: number): { id: string; distance: number } | null {
    return this._constraintRenderer.hitTestConstraintWithDistance(this._ctx, worldPos, hitRadius);
  }

  /** 거리 기반 constraint hit 후보 배열 (CATIA PreSelection Navigator 통합) */
  hitTestConstraintCandidates(worldPos: { x: number; y: number }, hitRadius: number): { id: string; distance: number }[] {
    return this._constraintRenderer.hitTestConstraintCandidates(this._ctx, worldPos, hitRadius);
  }

  setSelectionBox(start: { x: number; y: number } | null, end: { x: number; y: number } | null): void {
    this._ctx.selectionBoxStart = start;
    this._ctx.selectionBoxEnd = end;
    if (this._ctx.store) this._sync();
  }

  setExternalGeometries(geoms: SerializedGeometry[]): void {
    this._ctx.externalGeometries = geoms;
    if (this._ctx.store) this._sync();
  }

  setHiddenGeoIds(ids: Set<string>): void {
    this._ctx.hiddenGeoIds = ids;
    if (this._ctx.store) this._ctx.store.hiddenGeoIds = ids;
    this._ctx.fullRedraw = true;
    if (this._ctx.store) this._sync();
  }

  setConstraintVisible(visible: boolean): void {
    if (this._ctx.constraintVisible !== visible) {
      this._ctx.constraintVisible = visible;
      this._ctx.markFullRedraw();
      if (this._ctx.store) this._sync();
    }
  }

  setConstraintFilter(filter: { geometric: boolean; dimensional: boolean }): void {
    const curr = this._ctx.constraintFilter;
    if (curr.geometric === filter.geometric && curr.dimensional === filter.dimensional) return;
    this._ctx.constraintFilter = { ...filter };
    this._ctx.markFullRedraw();
    if (this._ctx.store) this._sync();
  }

  setDependencyHighlight(geomIds: Set<string>, constraintIds: Set<string>): void {
    const gSame = geomIds.size === this._ctx.dependencyGeomIds.size
      && [...geomIds].every((id) => this._ctx.dependencyGeomIds.has(id));
    const cSame = constraintIds.size === this._ctx.dependencyConstraintIds.size
      && [...constraintIds].every((id) => this._ctx.dependencyConstraintIds.has(id));
    if (gSame && cSame) return;
    this._ctx.dependencyGeomIds = geomIds;
    this._ctx.dependencyConstraintIds = constraintIds;
    this._ctx.markFullRedraw();
    if (this._ctx.store) this._sync();
  }

  setFlashGeomIds(ids: Set<string>): void {
    this._ctx.flashGeomIds = ids;
    this._ctx.markFullRedraw();
    if (this._ctx.store) this._sync();
  }

  attachConstraintStore(store: SketchConstraintStore): void {
    this.detachConstraintStore();
    this._ctx.constraintStore = store;
    this._constraintUnsub = store.addRenderListener(() => this._sync());
    if (this._ctx.store) this._sync();
  }

  detachConstraintStore(): void {
    if (this._constraintUnsub) {
      this._constraintUnsub();
      this._constraintUnsub = null;
    }
    this._ctx.constraintStore = null;
    this._constraintRenderer.clearAll(this._ctx);
  }

  hitTestConstraint(pos: { x: number; y: number }, radius: number): string | null {
    return this._constraintRenderer.hitTestConstraint(this._ctx, pos, radius);
  }

  dispose(): void {
    this.detachStore();
    this.detachConstraintStore();
    this._scene.remove(this._ctx.group);
    this._ctx.dispose();
    this._selectionRenderer.dispose();
    this._geometryRenderer.dispose();
    this._constraintRenderer.dispose();
    this._snapRenderer.dispose();
  }

  // --- 내부 동기화 ---

  private _sync(): void {
    if (!this._ctx.store) return;

    this._ctx.detectDirty();

    // sketchPlane + camera 필요한 서브 렌더러
    if (this._ctx.sketchPlane && this._ctx.camera) {
      this._geometryRenderer.sync(this._ctx);
      this._selectionRenderer.sync(this._ctx);
      this._snapRenderer.sync(this._ctx);
      this._constraintRenderer.sync(this._ctx);
    }

    this._ctx.clearDirty();
    this._onRenderNeeded?.();
  }

  private _clearAll(): void {
    this._geometryRenderer.clearAll(this._ctx);
    this._selectionRenderer.clearAll(this._ctx);
    this._snapRenderer.clearAll(this._ctx);
    this._constraintRenderer.clearAll(this._ctx);
  }
}

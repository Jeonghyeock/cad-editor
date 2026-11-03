// Input 피처 3D 씬 관리 — Facade 패턴
// 실제 로직은 SceneManager, ModelManager, SketchPlaneManager, SolidOperationManager, BakedSketchManager에 위임

import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";


import { OcctFeatureTree } from "../core/OcctFeatureTree";
import type {
  CrossSectionDef,
  SetupCameraState,
  OperationTreeEntry,
  PadPocketDirection,
  PadPocketOperation,
  RevolveDirection,
  RevolveOperation,
  SelectionFilterMode,
  SerializedGeometry,
  SerializedSketch,
  SketchPlane,
  StepModelData,
  Vec3,
} from "../Setup.type";
import type { SketchConstraint } from "../sketch/constraints/SketchConstraint.type";
import { OcctTopologyPicker } from "../step/OcctTopologyPicker";

import { BakedSketchManager } from "./BakedSketchManager";
import { disposeObject3D } from "./disposeUtils";
import type { GeometryOverlayRenderer } from "./GeometryOverlayRenderer";
import { ModelManager } from "./ModelManager";
import type { PickCtx, PickEntity } from "./picking/EntityPicker";
import { SceneManager } from "./SceneManager";
import { SketchPlaneManager } from "./SketchPlaneManager";
import { SolidOperationManager } from "./SolidOperationManager";

export default class SetupScene {
  // 매니저 인스턴스
  private _sceneManager: SceneManager;
  private _modelManager: ModelManager;
  private _sketchPlaneManager: SketchPlaneManager;
  private _solidOperationManager: SolidOperationManager;
  private _bakedSketchManager: BakedSketchManager;
  private _occtFeatureTree: OcctFeatureTree;
  private _occtTopologyPicker: OcctTopologyPicker;

  // --- 공개 접근자 (기존 API 호환) ---

  get renderer(): THREE.WebGLRenderer {
    return this._sceneManager.renderer;
  }

  get scene(): THREE.Scene {
    return this._sceneManager.scene;
  }

  get controls(): OrbitControls {
    return this._sceneManager.controls;
  }

  get raycaster(): THREE.Raycaster {
    return this._sceneManager.raycaster;
  }

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this._sceneManager.camera;
  }

  /** 임시 카메라 + RenderTarget으로 offscreen 렌더 후 data URL 반환 (라이브 카메라 미변경) */
  captureScreenshot(): string | null {
    try {
      const r = this._sceneManager.renderer;
      const liveCam = this._sceneManager.camera;
      const scene = this._sceneManager.scene;
      const w = 320, h = 180; // 썸네일 해상도

      // 임시 ortho 카메라 생성 (라이브 카메라 복제)
      const tmpCam = liveCam.clone() as THREE.OrthographicCamera | THREE.PerspectiveCamera;

      // offscreen RenderTarget에 렌더
      const rt = new THREE.WebGLRenderTarget(w, h);
      r.setRenderTarget(rt);
      r.render(scene, tmpCam);
      r.autoClear = false;
      if (this._sceneManager.gridVisible && this._sceneManager.gridScene) {
        r.clearDepth();
        r.render(this._sceneManager.gridScene, tmpCam);
      }
      r.clearDepth();
      r.render(this._sceneManager.overlayScene, tmpCam);
      r.autoClear = true;

      // 픽셀 읽기 → canvas → dataURL
      const buf = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      r.setRenderTarget(null); // 라이브 렌더 복원

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      const imgData = ctx.createImageData(w, h);
      // WebGL은 Y축 반전이므로 뒤집기
      for (let y = 0; y < h; y++) {
        const srcRow = (h - 1 - y) * w * 4;
        const dstRow = y * w * 4;
        imgData.data.set(buf.subarray(srcRow, srcRow + w * 4), dstRow);
      }
      ctx.putImageData(imgData, 0, 0);

      rt.dispose();
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  // 그리드 표시 여부 (외부에서 토글)
  get gridVisible(): boolean {
    return this._sceneManager.gridVisible;
  }

  set gridVisible(value: boolean) {
    this._sceneManager.gridVisible = value;
  }

  // 3D body hover/select 변경 시 외부 알림 콜백
  get onBodyHoverChanged() {
    return this._modelManager.onBodyHoverChanged;
  }

  set onBodyHoverChanged(
    value: ((modelId: string | null, bodyIndex: number | null) => void) | null,
  ) {
    this._modelManager.onBodyHoverChanged = value;
  }

  get onBodySelectChanged() {
    return this._modelManager.onBodySelectChanged;
  }

  set onBodySelectChanged(
    value: ((modelId: string | null, bodyIndex: number | null) => void) | null,
  ) {
    this._modelManager.onBodySelectChanged = value;
  }

  constructor(canvas: HTMLCanvasElement) {
    // SceneManager 생성 (렌더러, 카메라, 컨트롤 등)
    this._sceneManager = new SceneManager(canvas);

    // SketchPlaneManager 생성 (기준 평면, 그리드, 스케치 평면)
    this._sketchPlaneManager = new SketchPlaneManager(
      this._sceneManager.scene,
      this._sceneManager.renderer,
      this._sceneManager.controls,
      this._sceneManager.raycaster,
    );
    this._sketchPlaneManager.onSceneChanged = () => this._sceneManager.requestRender();

    // ModelManager 생성 (STEP 모델, body 선택/호버/하이라이트, 측정)
    this._modelManager = new ModelManager(
      this._sceneManager.scene,
      this._sceneManager.controls,
    );
    // Phase 4 — ModelManager mutation 시 render 1 회 예약.
    this._modelManager.onSceneChanged = () => this._sceneManager.requestRender();

    // BakedSketchManager 생성 (스케치 직렬화/bake)
    this._bakedSketchManager = new BakedSketchManager(
      this._sceneManager.scene,
      this._sceneManager.renderer,
      (plane?: SketchPlane) => this._sketchPlaneManager.getPlaneKey(plane),
    );
    this._bakedSketchManager.onSceneChanged = () => this._sceneManager.requestRender();
    // baked role-shape label ("Design Area" / "End Effector #N" 등) 도 SolidOperationManager
    // / marker pivot 과 동일 wpp 소스 — 카메라 줌·회전에 동일 반응 + 화면 픽셀 일정 크기.
    this._bakedSketchManager.setWppProvider(() => this._sceneManager.computeActiveWpp());

    // OcctFeatureTree + TopologyPicker 생성 (B-Rep 파이프라인)
    this._occtFeatureTree = new OcctFeatureTree();
    this._occtTopologyPicker = new OcctTopologyPicker();

    // SolidOperationManager 생성 (CSG 돌출/패턴 등)
    this._solidOperationManager = new SolidOperationManager(
      this._sceneManager.scene,
      (key: string) => this._bakedSketchManager.getSavedSketchByKey(key),
      this._occtFeatureTree,
      this._occtTopologyPicker,
    );
    this._solidOperationManager.onSceneChanged = () => this._sceneManager.requestRender();
    // solid label sprite 가 marker label 과 동일 wpp (카메라↔controls.target 거리 기준) 를
    // 사용하도록 SceneManager 의 wpp 식 주입. 매 render 직전 sprite.scale 갱신.
    this._solidOperationManager.setWppProvider(() => this._sceneManager.computeActiveWpp());


    // 애니메이션 루프 시작
    this._sceneManager.startLoop();
  }

  // --- OCCT Feature Tree + Topology Picker ---

  getOcctFeatureTree(): OcctFeatureTree {
    return this._occtFeatureTree;
  }

  getOcctTopologyPicker(): OcctTopologyPicker {
    return this._occtTopologyPicker;
  }

  // --- SceneManager 위임 ---

  /** 외부 (React effect 등) 에서 scene mutation 후 1 frame render 예약. */
  requestRender(): void {
    this._sceneManager.requestRender();
  }

  /**
   * 통합 pick 진입점 — 모든 source (step / sketch / feature / linkage) 의 후보를
   * PickEntity 배열로 반환. 매니저 안에서 filter 게이팅 + depth 계산까지 완료.
   * 호출자는 depth 정렬 + 필터 후처리 + commit 만 담당.
   *
   * mouseScreen 은 ndc + renderer size 로 자체 계산 — 외부 노출 X (캔버스 크기를
   * 호출자가 알 필요 없게 SetupScene 가 캡슐화).
   */
  pickEntities(ndc: THREE.Vector2, filter: SelectionFilterMode): PickEntity[] {
    const size = this._sceneManager.renderer.getSize(new THREE.Vector2());
    const mouseScreen = new THREE.Vector2(
      (ndc.x + 1) * 0.5 * size.x,
      (-ndc.y + 1) * 0.5 * size.y,
    );
    const ctx: PickCtx = {
      raycaster: this._sceneManager.raycaster,
      camera: this._sceneManager.camera,
      mouseScreen,
      screenWidth: size.x,
      screenHeight: size.y,
    };
    return [
      ...this._modelManager.pickEntities(ndc, filter, ctx),
      ...this._bakedSketchManager.pickEntities(ndc, filter, ctx),
      ...this._solidOperationManager.pickEntities(ndc, filter, ctx),
    ];
  }

  resize(w: number, h: number): void {
    this._sceneManager.resize(w, h);
    // 그리드 + geometry overlay 갱신
    if (this._sceneManager.isSketchMode) {
      this._sketchPlaneManager.updateGridOverlay(this._sceneManager.orthoCamera);
      this._sceneManager.syncGeometryOverlayCamera();
    }
  }

  initViewCube(): void {
    this._sceneManager.initViewCube();
  }

  handleViewCubeClick(clientX: number, clientY: number): boolean {
    return this._sceneManager.handleViewCubeClick(clientX, clientY);
  }

  initGeometryOverlay(): GeometryOverlayRenderer {
    return this._sceneManager.initGeometryOverlay();
  }

  getGeometryOverlay(): GeometryOverlayRenderer | null {
    return this._sceneManager.getGeometryOverlay();
  }


  zoomToFit(): void {
    this._sceneManager.zoomToFit();
  }

  // --- SketchPlaneManager 위임 ---

  getPlaneKey(plane?: SketchPlane): string | null {
    return this._sketchPlaneManager.getPlaneKey(plane);
  }

  getSketchPlane(): SketchPlane | null {
    return this._sketchPlaneManager.getSketchPlane();
  }

  setupSketchPlane(
    plane: SketchPlane,
    modelId?: string,
    options?: {
      skipAnimation?: boolean;
      // 카메라 target 의 world 좌표. 미지정 시 sketch plane origin 을 사용.
      // face sketch 처럼 sketch origin (글로벌 원점 사영) 과 face 중심이 다른 경우 face 중심을 명시 → 카메라가 face 정면을 잡음.
      cameraTargetWorld?: { x: number; y: number; z: number };
    },
  ): void {
    const offset = modelId
      ? this._modelManager.getModelOffset(modelId)
      : new THREE.Vector3();

    this._sketchPlaneManager.setupSketchPlane(plane, offset);

    // overlay에 plane 전달
    const sketchPlaneData = this._sketchPlaneManager.sketchPlaneData;
    if (sketchPlaneData) {
      const overlayPlane: SketchPlane = {
        origin: {
          x: sketchPlaneData.origin.x,
          y: sketchPlaneData.origin.y,
          z: sketchPlaneData.origin.z,
        },
        normal: plane.normal,
        u: plane.u,
        v: plane.v,
      };
      this._sceneManager.getGeometryOverlay()?.setSketchPlane(overlayPlane);
    }

    // 스케치 모드: 선택 해제, 회전 잠금, 기준 평면 숨김, STEP 반투명, 솔리드 숨김, face 하이라이트 해제
    this._modelManager.deselectBody();
    this._sceneManager.controls.enableRotate = false;
    this._sceneManager.controls.mouseButtons = {
      LEFT: THREE.MOUSE.LEFT,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };
    this._sketchPlaneManager.highlightOriginPlane(null);
    this._sketchPlaneManager.setOriginPlanesVisible(false);
    this._modelManager.setStepModelsTransparent(true);
    this._solidOperationManager.setExtrudedSolidsVisible(false);
    for (const mid of this._modelManager.getStepModelIds()) {
      this._modelManager.highlightFace(mid, null);
    }

    // 스케치 모드 동안 모든 baked sketch 를 숨김.
    // - 다른 평면 baked: 카메라가 활성 평면 정면이라 시각적 의미 없음
    // - 현재 평면 baked: live geometry 와 위치가 겹쳐 ghost 잔상이 됨
    //   (저장 등으로 bake 가 발생해도 live 만 보이도록)
    this._bakedSketchManager.setAllBakedSketchesVisible(false);

    // perspective 카메라를 평면 정면으로 애니메이션 → 완료 후 ortho 전환
    const normal = new THREE.Vector3(
      plane.normal.x,
      plane.normal.y,
      plane.normal.z,
    ).normalize();
    // 카메라 target: 옵션 우선, 없으면 sketch plane origin (= sketch (0,0) world 위치).
    // face sketch 의 경우 cameraTargetWorld = face centroid 가 들어와 face 중심을 잡음.
    const origin = options?.cameraTargetWorld
      ? new THREE.Vector3(
          options.cameraTargetWorld.x,
          options.cameraTargetWorld.y,
          options.cameraTargetWorld.z,
        )
      : this._sketchPlaneManager.sketchPlaneData!.origin;

    // ortho 전환 + 그리드 overlay 생성 (애니메이션 / skip 둘 다 공통)
    const finalize = () => {
      this._sceneManager.switchToOrtho(() => {
        this._sketchPlaneManager.updateGridOverlay(this._sceneManager.orthoCamera);
        this._sceneManager.syncGeometryOverlayCamera();
        // 줌/팬 시 픽셀 기반 크기 요소(점, 핸들, 구속 아이콘) 재렌더링
        this._sceneManager.getGeometryOverlay()?.requestSync();
      }, new THREE.Vector3(plane.v.x, plane.v.y, plane.v.z)); // 스케치 V 축이 화면 위쪽, H 축이 화면 오른쪽
      // 그리드 overlay 생성
      this._sketchPlaneManager.createGridOverlay();
      this._sketchPlaneManager.updateGridOverlay(this._sceneManager.orthoCamera);
      this._sceneManager.gridScene = this._sketchPlaneManager.gridScene;

      // geometry overlay 카메라 정보 초기화
      this._sceneManager.syncGeometryOverlayCamera();
    };

    if (options?.skipAnimation) {
      // 파일 hydrate 흐름 — perspective 애니메이션 우회. 카메라를 즉시 평면 정면으로 텔레포트 후 ortho 전환.
      // 사용자가 3D → 2D 모션 안 보고 바로 2D 화면.
      this._sceneManager.placeCameraAtPlane(origin, normal, this._modelManager.stepModelGroups);
      finalize();
      return;
    }

    this._sceneManager.animateCameraToFacePlane(
      origin,
      normal,
      this._modelManager.stepModelGroups,
      finalize,
    );
  }

  clearSketchPlane(): void {
    // ortho → perspective 복원
    if (this._sceneManager.isSketchMode) {
      this._sceneManager.switchToPersp();
    }

    // 회전 복원, 기준 평면 표시, STEP 불투명 복원, 솔리드 표시
    this._sceneManager.controls.enableRotate = true;
    this._sceneManager.controls.mouseButtons = {
      LEFT: THREE.MOUSE.LEFT,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    this._sketchPlaneManager.setOriginPlanesVisible(true);
    this._modelManager.setStepModelsTransparent(false);
    this._solidOperationManager.setExtrudedSolidsVisible(true);

    // 모든 baked sketch 가시성 복원
    this._bakedSketchManager.setAllBakedSketchesVisible(true);

    // 카메라 애니메이션 중단
    this._sceneManager.cancelCameraAnimation();

    // 스케치 평면 해제
    this._sketchPlaneManager.clearSketchPlane();
    this._sceneManager.gridScene = null;

    // overlay plane 초기화
    this._sceneManager.getGeometryOverlay()?.setSketchPlane(null);
  }

  raycastSketchPlane(mouseNDC: THREE.Vector2): { x: number; y: number } | null {
    return this._sketchPlaneManager.raycastSketchPlane(mouseNDC, this._sceneManager.camera);
  }

  getSketchPlaneBasis(): {
    origin: THREE.Vector3;
    u: THREE.Vector3;
    v: THREE.Vector3;
  } | null {
    return this._sketchPlaneManager.getSketchPlaneBasis();
  }

  getGridSpacing(): number {
    return this._sketchPlaneManager.getGridSpacing(this._sceneManager.orthoCamera);
  }

  pickOriginPlane(mouseNDC: THREE.Vector2): number | null {
    return this._sketchPlaneManager.pickOriginPlane(mouseNDC, this._sceneManager.camera);
  }

  highlightOriginPlane(index: number | null): void {
    this._sketchPlaneManager.highlightOriginPlane(index);
  }

  setOriginPlaneHover(index: number | null): void {
    this._sketchPlaneManager.setOriginPlaneHover(index);
  }

  setOriginPlaneSelect(index: number | null): void {
    this._sketchPlaneManager.setOriginPlaneSelect(index);
  }

  getOriginPlaneAsSketchPlane(index: number): SketchPlane {
    return this._sketchPlaneManager.getOriginPlaneAsSketchPlane(index);
  }

  /**
   * planeKey 로 SketchPlane 역추적. origin plane (XY/YZ/ZX) → reference plane → saved sketch 순서로 탐색.
   * baked sketch 없는 empty sketch 재진입 (사용자가 sketch 진입 후 아무것도 안 그리고 파일 전환) 케이스 지원.
   * (face plane 은 viewState.sketchFaceSource 로 별도 처리 — applyCrossSection 으로 재계산.)
   */
  resolveSketchPlaneByKey(planeKey: string): SketchPlane | null {
    // 1. Origin plane 3개 후보
    for (let i = 0; i < 3; i++) {
      const plane = this._sketchPlaneManager.getOriginPlaneAsSketchPlane(i);
      if (this.getPlaneKey(plane) === planeKey) return plane;
    }
    // 2. Reference plane — 사용자 정의 plane 목록 (referencePlanes atom → scene sync 후 사용).
    for (const plane of this._sketchPlaneManager.getReferencePlanes()) {
      if (this.getPlaneKey(plane) === planeKey) return plane;
    }
    // 3. Saved sketch 의 plane (이미 enterSketchByKey 에서 시도하지만 fallback path 확보)
    const saved = this._bakedSketchManager.getSavedSketchByKey(planeKey);
    return saved?.plane ?? null;
  }

  setOriginPlanesVisible(visible: boolean): void {
    this._sketchPlaneManager.setOriginPlanesVisible(visible);
  }

  // --- ModelManager 위임 ---

  addStepModel(model: StepModelData): THREE.Group {
    return this._modelManager.addStepModel(model, this._sceneManager.perspCamera);
  }

  removeStepModel(modelId: string): void {
    this._modelManager.removeStepModel(modelId);
  }

  getStepModelGroup(modelId: string): THREE.Group | null {
    return this._modelManager.getStepModelGroup(modelId);
  }

  getStepModelIds(): string[] {
    return this._modelManager.getStepModelIds();
  }

  setStepModelsTransparent(transparent: boolean, opacity?: number): void {
    this._modelManager.setStepModelsTransparent(transparent, opacity);
  }

  setModelVisible(modelId: string, visible: boolean): void {
    this._modelManager.setModelVisible(modelId, visible);
  }

  setBodyVisible(modelId: string, bodyIndex: number, visible: boolean): void {
    this._modelManager.setBodyVisible(modelId, bodyIndex, visible);
  }

  highlightBody(modelId: string, bodyIndex: number | null): void {
    this._modelManager.highlightBody(modelId, bodyIndex);
  }

  setBodyTransform(modelId: string, bodyIndex: number, matrix: THREE.Matrix4): void {
    this._modelManager.setBodyTransform(modelId, bodyIndex, matrix);
  }

  resetAllBodyTransforms(): void {
    this._modelManager.resetAllBodyTransforms();
  }

  pickPointOnMesh(mouseNDC: THREE.Vector2): {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    modelId?: string;
    bodyIndex?: number;
    faceIndex?: number;
    mesh?: THREE.Mesh;
  } | null {
    return this._modelManager.pickPointOnMesh(
      mouseNDC,
      this._sceneManager.raycaster,
      this._sceneManager.camera,
      this._solidOperationManager.extrudedSolids,
    );
  }

  estimateRadiusAtHit(
    mesh: THREE.Mesh,
    faceIndex: number,
    hitPoint: THREE.Vector3,
  ): number | null {
    return this._modelManager.estimateRadiusAtHit(mesh, faceIndex, hitPoint);
  }

  hoverBody(modelId: string | null, bodyIndex: number | null): void {
    this._modelManager.hoverBody(modelId, bodyIndex);
  }

  highlightModel(modelId: string, highlight: boolean): void {
    this._modelManager.highlightModel(modelId, highlight);
  }

  selectBody(modelId: string, bodyIndex: number): void {
    this._modelManager.selectBody(modelId, bodyIndex);
  }

  toggleBodySelection(modelId: string, bodyIndex: number): void {
    this._modelManager.toggleBodySelection(modelId, bodyIndex);
  }

  get selectedBodies(): { modelId: string; bodyIndex: number }[] {
    return this._modelManager.selectedBodies;
  }

  deselectBody(): void {
    this._modelManager.deselectBody();
  }

  getSelectedBody(): { modelId: string; bodyIndex: number } | null {
    return this._modelManager.getSelectedBody();
  }

  highlightFace(modelId: string, faceGroupId: number | null): void {
    this._modelManager.highlightFace(modelId, faceGroupId);
  }

  highlightEdge(modelId: string, bodyIndex: number, edgeIndex: number | null): void {
    this._modelManager.highlightEdge(modelId, bodyIndex, edgeIndex);
  }

  /** Edge의 양 끝점을 world 좌표로 반환 */
  getEdgeEndpoints(
    modelId: string,
    bodyIndex: number,
    edgeIndex: number,
  ): { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } } | null {
    return this._modelManager.getEdgeEndpoints?.(modelId, bodyIndex, edgeIndex) ?? null;
  }

  highlightVertex(modelId: string, bodyIndex: number, vertexIndex: number | null): void {
    this._modelManager.highlightVertex(modelId, bodyIndex, vertexIndex);
  }

  clearEdgeHighlight(): void { this._modelManager.clearEdgeHighlight(); }
  clearVertexHighlight(): void { this._modelManager.clearVertexHighlight(); }

  selectEdge(modelId: string, bodyIndex: number, edgeIndex: number | null): void {
    this._modelManager.selectEdge(modelId, bodyIndex, edgeIndex);
  }
  selectVertex(modelId: string, bodyIndex: number, vertexIndex: number | null): void {
    this._modelManager.selectVertex(modelId, bodyIndex, vertexIndex);
  }
  clearEdgeSelection(): void { this._modelManager.clearEdgeSelection(); }
  clearVertexSelection(): void { this._modelManager.clearVertexSelection(); }

  // Reference planes
  addReferencePlane(id: string, plane: SketchPlane, name: string): void {
    this._sketchPlaneManager.addReferencePlane(id, plane, name);
  }
  removeReferencePlane(id: string): void {
    this._sketchPlaneManager.removeReferencePlane(id);
  }
  pickReferencePlane(mouseNDC: THREE.Vector2): string | null {
    return this._sketchPlaneManager.pickReferencePlane(mouseNDC, this._sceneManager.camera);
  }
  highlightReferencePlane(id: string | null): void {
    this._sketchPlaneManager.highlightReferencePlane(id);
  }
  setReferencePlaneHover(id: string | null): void {
    this._sketchPlaneManager.setReferencePlaneHover(id);
  }
  setReferencePlaneSelect(id: string | null): void {
    this._sketchPlaneManager.setReferencePlaneSelect(id);
  }
  getReferencePlaneAsSketchPlane(id: string): SketchPlane | null {
    return this._sketchPlaneManager.getReferencePlaneAsSketchPlane(id);
  }
  setRefPlanePreview(plane: SketchPlane | null): void {
    this._sketchPlaneManager.setRefPlanePreview(plane);
  }

  // Face에서 SketchPlane 추출 (reference plane용)
  getFacePlane(_modelId: string, _crossSection: CrossSectionDef): SketchPlane | null {
    // ModelManager에서 StepModelData가 필요하지만 직접 접근 불가
    // 외부에서 computeCrossSection을 호출해야 함 → null 반환하고 caller에서 처리
    return null;
  }

  getModelOffset(modelId: string): THREE.Vector3 {
    return this._modelManager.getModelOffset(modelId);
  }

  showSectionPreview(
    polylines: Vec3[][],
    modelId?: string,
    color?: number,
  ): void {
    this._modelManager.showSectionPreview(polylines, modelId, color);
  }

  hideSectionPreview(): void {
    this._modelManager.hideSectionPreview();
  }

  // --- BakedSketchManager 위임 ---

  bakeSketch(
    plane: SketchPlane,
    geometries?: SerializedGeometry[],
    constraints?: SketchConstraint[],
    shapes?: SerializedSketch["shapes"],
    name?: string,
  ): void {
    this._bakedSketchManager.bakeSketch(plane, geometries, constraints, shapes, name);
    // 스케치 모드 중 bake (저장 등) 시 새로 만들어진 baked group 의 default visible=true 가
    // live geometry 와 겹쳐 ghost 잔상이 됨. 모드 동안 모두 숨김 처리.
    if (this._sceneManager.isSketchMode) {
      this._bakedSketchManager.setAllBakedSketchesVisible(false);
    }
  }

  hasSavedSketch(plane: SketchPlane): boolean {
    return this._bakedSketchManager.hasSavedSketch(plane);
  }

  getSavedSketch(plane: SketchPlane): SerializedSketch | null {
    return this._bakedSketchManager.getSavedSketch(plane);
  }

  getSavedSketchByKey(planeKey: string): SerializedSketch | null {
    return this._bakedSketchManager.getSavedSketchByKey(planeKey);
  }

  getSavedSketches(): Map<string, SerializedSketch> {
    return this._bakedSketchManager.savedSketches;
  }

  /** baked Map mutation 시 외부 (atom) 동기화 콜백 등록 */
  setBakedChangeCallback(cb: ((snapshot: Record<string, SerializedSketch>) => void) | null): void {
    this._bakedSketchManager.setChangeCallback(cb);
  }

  removeBakedSketch(plane: SketchPlane): void {
    this._bakedSketchManager.removeBakedSketch(plane);
  }

  highlightBakedSketchFaces(targets: { planeKey: string; profileId: string | null }[]): void {
    this._bakedSketchManager.highlightBakedSketchFaces(targets);
  }

  highlightBakedSketchFace(planeKey: string | null): void {
    this._bakedSketchManager.highlightBakedSketchFace(planeKey);
  }

  /** Baked role-shape hover/select forwarders (SpecTree Definition entry / canvas raycast). */
  setBakedShapeHovered(id: string | null): void {
    this._bakedSketchManager.setBakedShapeHovered(id);
  }
  setBakedShapeSelected(id: string | null): void {
    this._bakedSketchManager.setBakedShapeSelected(id);
  }

  setBakedSketchVisible(planeKey: string, visible: boolean): void {
    this._bakedSketchManager.setBakedSketchVisible(planeKey, visible);
  }

  setHiddenShapeIds(ids: Set<string>): void {
    this._bakedSketchManager.setHiddenShapeIds(ids);
  }

  setHiddenSketchPortions(planeKeys: Set<string>): void {
    this._bakedSketchManager.setHiddenSketchPortions(planeKeys);
  }

  deleteSavedSketch(planeKey: string): void {
    this._bakedSketchManager.deleteSavedSketch(planeKey);
  }

  restoreSavedSketch(planeKey: string, data: SerializedSketch): void {
    this._bakedSketchManager.restoreSavedSketch(planeKey, data);
  }

  /** 현재 perspective 카메라 + OrbitControls target 직렬화 (파일별 보존용). */
  getCameraState(): SetupCameraState {
    return this._sceneManager.getCameraState();
  }

  /** SetupCameraState 를 적용 — 파일 전환 시 복원용. */
  applyCameraState(state: SetupCameraState): void {
    this._sceneManager.applyCameraState(state);
  }

  /** 카메라를 초기 상태 (생성자 default) 로 복원. */
  resetCamera(): void {
    this._sceneManager.resetCamera();
  }

  /**
   * 파일 전환 시 imperative scene state 초기화 — baked sketch / solid operation / geometry overlay.
   *
   * **modelManager 는 의도적으로 제외**. STEP 모델은 useInputSceneController 의 [scene, models]
   * effect 가 atom 과 diff sync — 여기서 같이 clear 하면 React effect 실행 순서 문제로 (자식
   * 컴포넌트 effect 가 부모보다 먼저 실행) child 가 add 한 모델을 parent 의 clear 가 즉시 제거.
   *
   * caller 가 카메라 복원/초기화 책임 (파일별 cameraState 가 있으면 applyCameraState, 없으면
   * resetCamera).
   */
  clearAllSketches(): void {
    this._bakedSketchManager.clearAll();
    this._solidOperationManager.clearAll();
    const overlay = this._sceneManager.getGeometryOverlay();
    if (overlay) {
      const geoStore = overlay.getStore();
      if (geoStore) {
        geoStore.clear();
        if (geoStore.constraintStore) geoStore.constraintStore.clear();
      }
    }
  }

  // --- SolidOperationManager 위임 ---

  addExtrudedSolid(
    operation: PadPocketOperation,
    geometries: Map<string, SerializedGeometry>,
  ): void {
    this._solidOperationManager.addExtrudedSolid(operation, geometries);
  }

  removeExtrudedSolid(operationId: string): void {
    this._solidOperationManager.removeExtrudedSolid(operationId);
  }

  showExtrudePreview(
    sketchPlaneKey: string,
    profileIds: string[],
    depth: number,
    direction: PadPocketDirection,
    geometries: Map<string, SerializedGeometry>,
    depth2?: number,
    draftAngle?: number,
  ): void {
    this._solidOperationManager.showExtrudePreview(sketchPlaneKey, profileIds, depth, direction, geometries, depth2, draftAngle);
  }

  clearExtrudePreview(): void {
    this._solidOperationManager.clearExtrudePreview();
  }

  getLastVisibleSolidId(): string | undefined {
    return this._solidOperationManager.getLastVisibleSolidId();
  }

  setSolidHovered(operationId: string | null): void {
    this._solidOperationManager.setSolidHovered(operationId);
  }

  setSolidSelected(operationId: string | null): void {
    this._solidOperationManager.setSolidSelected(operationId);
  }

  addRevolvedSolid(
    operation: RevolveOperation,
    geometries: Map<string, SerializedGeometry>,
  ): void {
    this._solidOperationManager.addRevolvedSolid(operation, geometries);
  }

  showRevolvePreview(
    sketchPlaneKey: string,
    profileIds: string[],
    angle: number,
    axisType: "x" | "y" | "custom",
    geometries: Map<string, SerializedGeometry>,
    angle2?: number,
    revolveDirection?: RevolveDirection,
    clockwise?: boolean,
    axisOrigin?: { x: number; y: number },
    axisDirection?: { x: number; y: number },
  ): void {
    this._solidOperationManager.showRevolvePreview(
      sketchPlaneKey, profileIds, angle, axisType, geometries,
      angle2, revolveDirection, clockwise, axisOrigin, axisDirection,
    );
  }

  setExtrudedSolidsVisible(visible: boolean): void {
    this._solidOperationManager.setExtrudedSolidsVisible(visible);
  }

  setExtrudedSolidVisible(operationId: string, visible: boolean): void {
    this._solidOperationManager.setExtrudedSolidVisible(operationId, visible);
  }

  restoreSourceVisibility(operationId: string): void {
    this._solidOperationManager.restoreSourceVisibility(operationId);
  }

  rebuildOperationsForSketch(
    sketchPlaneKey: string,
    operations: OperationTreeEntry[],
  ): void {
    this._solidOperationManager.rebuildOperationsForSketch(sketchPlaneKey, operations);
  }

  // --- 리소스 정리 ---

  dispose(): void {
    // STEP 모델 + 측정 해제
    this._modelManager.dispose();

    // 스케치 평면 해제
    this.clearSketchPlane();

    // bake된 스케치 해제
    this._bakedSketchManager.dispose();

    // 돌출 솔리드 해제
    this._solidOperationManager.dispose();

    // OCCT 해제
    this._occtFeatureTree.dispose().catch((err) => console.error("[SetupScene] OCCT dispose error:", err));
    this._occtTopologyPicker.dispose();

    // 기준 평면 해제
    disposeObject3D(this._sketchPlaneManager.originPlanesGroup);

    // 씬/렌더러/컨트롤/ViewCube/Overlay 해제
    this._sceneManager.dispose();
  }

  /** Body mesh의 world-space vertex positions 추출 (voxelization용) */
  getBodyWorldPositions(modelId: string, bodyIndex: number): number[] | null {
    const group = this._modelManager.getStepModelGroup(modelId);
    if (!group) return null;

    // group 내 bodyIndex번째 Mesh 찾기
    const meshes = group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    const mesh = meshes[bodyIndex];
    if (!mesh) return null;

    const posAttr = mesh.geometry.getAttribute("position");
    if (!posAttr) return null;

    // world matrix 업데이트
    mesh.updateMatrixWorld(true);
    const worldMatrix = mesh.matrixWorld;

    const worldPositions = new Float32Array(posAttr.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i);
      v.applyMatrix4(worldMatrix);
      worldPositions[i * 3] = v.x;
      worldPositions[i * 3 + 1] = v.y;
      worldPositions[i * 3 + 2] = v.z;
    }
    return Array.from(worldPositions);
  }
}

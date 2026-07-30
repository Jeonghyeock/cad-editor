// 씬/카메라/렌더러/컨트롤/ViewCube/LinkageOverlay/GeometryOverlay/애니메이션 루프 관리

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { SetupCameraState } from "../Setup.type";

import { GeometryOverlayRenderer } from "./GeometryOverlayRenderer";
import { ViewCubeGizmo } from "./ViewCubeGizmo";

// 카메라 dist 계산용 — 모든 group 의 visible mesh 합집합 box 의 max size * 1.5.
// setFromObject 는 visible=false 도 traverse 하므로 BRep wireframe fallback (잘못된 좌표로
// hide된) 까지 bbox 에 포함되어 모델 크기가 비정상적으로 커지는 케이스 발생.
// → traverseVisible 로 visible=true mesh 만 합산.
function computeStepModelDist(stepModelGroups: Map<string, THREE.Group>): number {
  const box = new THREE.Box3();
  for (const group of stepModelGroups.values()) {
    group.traverseVisible((obj) => {
      if (obj instanceof THREE.Mesh) {
        box.expandByObject(obj);
      }
    });
  }
  if (box.isEmpty()) return 200;
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  return maxDim > 1e-6 ? maxDim * 1.5 : 200;
}

export class SceneManager {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  controls: OrbitControls;
  raycaster: THREE.Raycaster;

  // 듀얼 카메라 (perspective + orthographic)
  private _perspCamera: THREE.PerspectiveCamera;
  private _orthoCamera: THREE.OrthographicCamera;
  private _activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private _isSketchMode = false;
  private _savedCameraState: {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    target: THREE.Vector3;
    up: THREE.Vector3;
  } | null = null;

  // camera getter — 외부 코드 호환
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this._activeCamera;
  }

  get perspCamera(): THREE.PerspectiveCamera {
    return this._perspCamera;
  }

  get orthoCamera(): THREE.OrthographicCamera {
    return this._orthoCamera;
  }

  get isSketchMode(): boolean {
    return this._isSketchMode;
  }

  private _animationId: number | null = null;
  private _cameraAnimId: number | null = null;
  /**
   * Phase 4 — render-on-demand. _renderRequested 가 true 일 때만 다음 frame 에 WebGL render
   * 수행. idle 시 RAF 자체를 schedule 하지 않아 CPU/GPU 모두 wake 하지 않음.
   * Continuous mode (playback 등) 는 _continuousCount 로 stack 카운팅.
   */
  private _renderRequested = false;
  private _continuousCount = 0;

  // ViewCube + LinkageOverlay + GeometryOverlay
  private _viewCube: ViewCubeGizmo | null = null;
  private _geometryOverlay: GeometryOverlayRenderer | null = null;

  // overlay 씬 (geometry + linkage — 그리드 위에 렌더)
  private _overlayScene: THREE.Scene;

  // 그리드 씬 참조 (SketchPlaneManager가 관리, 렌더루프에서 사용)
  gridScene: THREE.Scene | null = null;

  // 그리드 표시 여부 (외부에서 토글)
  gridVisible = true;


  constructor(canvas: HTMLCanvasElement) {
    const width = canvas.clientWidth || canvas.width || 1;
    const height = canvas.clientHeight || canvas.height || 1;

    // 렌더러
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height, false);
    // splash dark theme — viewport bg = #1f2227 (surface-dark-bg)
    this.renderer.setClearColor(0x1f2227);

    // 씬
    this.scene = new THREE.Scene();
    // overlay 씬 (geometry + linkage — 그리드 위에 렌더)
    this._overlayScene = new THREE.Scene();

    // 조명
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(30, 60, 45);
    this.scene.add(directional);

    // Perspective 카메라
    this._perspCamera = new THREE.PerspectiveCamera(
      50,
      width / height,
      1,
      3000,
    );
    this._perspCamera.position.set(150, 100, 150);
    this._perspCamera.lookAt(0, 0, 0);

    // Orthographic 카메라 (초기값, 스케치 전환 시 frustum 재계산)
    const halfH = 100;
    const aspect = width / height;
    this._orthoCamera = new THREE.OrthographicCamera(
      -halfH * aspect,
      halfH * aspect,
      halfH,
      -halfH,
      0.1,
      10000,
    );

    // 기본 활성 카메라 = perspective
    this._activeCamera = this._perspCamera;

    // OrbitControls (CATIA V5 마우스 매핑)
    this.controls = new OrbitControls(this._perspCamera, canvas);

    // 3D 모드 (default) controls.change → overlay fullRedraw. linkage 시각 요소 wpp 가변용.
    // switchToOrtho/switchToPersp 에서 listener 가 적절히 교체됨.
    this._onControlsChangeHandler = () => {
      this._geometryOverlay?.requestFullRedraw();
    };
    this.controls.addEventListener("change", this._onControlsChangeInternal);
    // Phase 4 — controls change 시 render 예약 (overlay sync 와 별개로 카메라 자체 이동도 redraw 필요)
    this.controls.addEventListener("change", this._onAnyChangeRequestRender);

    // 마우스 커서 위치 기준 줌 (CATIA 동작)
    this.controls.zoomToCursor = true;
    // CATIA 방식: 중간 버튼(휠 클릭) = 회전, 우클릭 = 팬
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.LEFT,      // 좌클릭: 선택 (OrbitControls는 사용 안 함)
      MIDDLE: THREE.MOUSE.ROTATE,  // 휠 클릭+드래그: 회전
      RIGHT: THREE.MOUSE.PAN,      // 우클릭+드래그: 팬
    };

    this.raycaster = new THREE.Raycaster();
  }

  get overlayScene(): THREE.Scene {
    return this._overlayScene;
  }

  /** Phase 4 — render-on-demand 시작. 첫 frame 예약. 이후는 requestRender / continuous 로 구동. */
  startLoop(): void {
    this.requestRender();
  }

  /** 외부 / 내부 호출자가 render 1 회 예약. 같은 frame 내 중복 호출은 1 회로 통합. */
  requestRender(): void {
    if (this._renderRequested) return;
    this._renderRequested = true;
    if (this._animationId == null) {
      this._animationId = requestAnimationFrame(this._renderFrame);
    }
  }

  /** 연속 render 모드 진입 (playback / camera anim). 짝 endContinuousRender 호출 필수. */
  beginContinuousRender(): void {
    this._continuousCount++;
    this.requestRender();
  }

  endContinuousRender(): void {
    this._continuousCount = Math.max(0, this._continuousCount - 1);
    // 마지막 frame 보장 — caller 가 stop 직후 추가 render 호출을 잊어도 정지 상태 반영됨.
    this.requestRender();
  }

  private _onAnyChangeRequestRender = (): void => {
    this.requestRender();
  };

  private _renderFrame = (): void => {
    this._animationId = null;
    if (!this._renderRequested && this._continuousCount === 0) return;
    this._renderRequested = false;

    if (!this._cameraAnimId) {
      this.controls.update();
    }

    // 메인 씬 렌더
    this.renderer.render(this.scene, this._activeCamera);

    // 그리드 + overlay 렌더 (스케치 모드: 그리드 위에 overlay, 3D 모드: overlay만)
    this.renderer.autoClear = false;
    if (this._isSketchMode && this.gridScene && this.gridVisible) {
      this.renderer.clearDepth();
      this.renderer.render(this.gridScene, this._activeCamera);
    }
    this.renderer.clearDepth();
    this.renderer.render(this._overlayScene, this._activeCamera);
    this.renderer.autoClear = true;

    // ViewCube 렌더링 (스케치 모드에서는 숨김)
    if (this._viewCube && !this._isSketchMode) {
      this._viewCube.syncWithCamera(this._activeCamera);
      this._viewCube.render();
    }

    // 연속 모드면 다음 frame 예약
    if (this._continuousCount > 0) {
      this._animationId = requestAnimationFrame(this._renderFrame);
    }
  };

  resize(w: number, h: number): void {
    if (this._isSketchMode) {
      // ortho 카메라 frustum 재계산 (aspect 유지)
      const aspect = w / h;
      const halfH = this._orthoCamera.top; // 현재 halfH 유지
      this._orthoCamera.left = -halfH * aspect;
      this._orthoCamera.right = halfH * aspect;
      this._orthoCamera.updateProjectionMatrix();
    } else {
      this._perspCamera.aspect = w / h;
      this._perspCamera.updateProjectionMatrix();
    }
    this.renderer.setSize(w, h, false);
    this.requestRender();
  }

  // --- ViewCube ---

  initViewCube(): void {
    if (this._viewCube) return;
    this._viewCube = new ViewCubeGizmo(this.renderer);
    this._viewCube.onFaceClick = (direction, up) => {
      this.animateCameraToDirection(direction, up);
    };
  }

  // ViewCube 면 클릭 이벤트 전달 (canvas click에서 호출)
  handleViewCubeClick(clientX: number, clientY: number): boolean {
    // 스케치 모드에서는 ViewCube 비활성
    if (this._isSketchMode) return false;
    if (!this._viewCube) return false;
    return this._viewCube.handleClick(clientX, clientY);
  }

  // --- GeometryOverlay ---

  initGeometryOverlay(): GeometryOverlayRenderer {
    if (this._geometryOverlay) return this._geometryOverlay;
    this._geometryOverlay = new GeometryOverlayRenderer(this._overlayScene);
    // 활성 카메라 (perspective/ortho 모두) 기반 wpp 콜백 inject — 3D 모드에서도 줌에 따라
    // linkage 시각 요소 크기가 가변되도록. 2D 모드는 ctx.camera 가 set 되어 있어 영향 X.
    this._geometryOverlay.setActiveWppProvider(() => this._computeActiveWpp());
    // Phase 4 — overlay sync (mutation) 시마다 GL render 1 회 예약.
    this._geometryOverlay.setOnRenderNeeded(() => this.requestRender());
    return this._geometryOverlay;
  }

  /**
   * 활성 카메라 + canvas 기반 worldPerPixel 계산 — perspective / ortho 둘 다.
   * MarkerOverlayRenderer 의 marker pivot · solid label sprite 등이 이 값을 공유해
   * 화면 픽셀 크기를 일치시킴 (persp: 카메라↔controls.target 거리 기준 — 모든 sprite
   * 가 동일 wpp 사용).
   */
  computeActiveWpp(): number {
    return this._computeActiveWpp();
  }

  private _computeActiveWpp(): number {
    const cam = this._activeCamera;
    const canvas = this.renderer.domElement;
    const canvasH = canvas.clientHeight || 1;
    if (cam instanceof THREE.OrthographicCamera) {
      const zoom = cam.zoom || 1;
      const frustumH = cam.top - cam.bottom;
      if (frustumH === 0) return 1;
      return frustumH / zoom / canvasH;
    }
    // Perspective: FOV + 카메라-target 거리.
    const fovRad = ((cam as THREE.PerspectiveCamera).fov * Math.PI) / 180;
    const dist = cam.position.distanceTo(this.controls.target);
    return (2 * dist * Math.tan(fovRad / 2)) / canvasH;
  }

  getGeometryOverlay(): GeometryOverlayRenderer | null {
    return this._geometryOverlay;
  }

  // --- Zoom to Fit ---

  zoomToFit(): void {
    const box = new THREE.Box3();
    // 모든 가시 메시의 바운딩 박스 계산
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.visible) {
        box.expandByObject(obj);
      }
    });
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim < 1e-6) return;

    const cam = this.camera;
    if (cam instanceof THREE.OrthographicCamera) {
      // 2D 스케치 모드: zoom 조정
      const aspect = this.renderer.domElement.clientWidth / this.renderer.domElement.clientHeight;
      const halfH = maxDim * 0.6;
      cam.left = -halfH * aspect;
      cam.right = halfH * aspect;
      cam.top = halfH;
      cam.bottom = -halfH;
      cam.zoom = 1;
      cam.updateProjectionMatrix();
      // 카메라 위치를 센터 앞으로
      const lookDir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      cam.position.copy(center).sub(lookDir.multiplyScalar(500));
      this.controls.target.copy(center);
    } else {
      // 3D 모드: 카메라를 적절한 거리에 배치
      const fov = (cam as THREE.PerspectiveCamera).fov * Math.PI / 180;
      const dist = maxDim / (2 * Math.tan(fov / 2)) * 1.5;
      const direction = cam.position.clone().sub(this.controls.target).normalize();
      cam.position.copy(center).add(direction.multiplyScalar(dist));
      this.controls.target.copy(center);
    }
    this.controls.update();
    this.requestRender();
  }

  // --- Perspective ↔ Orthographic 전환 ---

  switchToOrtho(onGridUpdate: () => void): void {
    this._isSketchMode = true;

    // 스케치 진입 전 카메라 상태 저장 — sketch 중 파일 전환 시 getCameraState 가
    // 사용자가 회전한 3D 시점을 정확히 복원하려면 quaternion 도 보존해야 함.
    this._savedCameraState = {
      position: this._perspCamera.position.clone(),
      quaternion: this._perspCamera.quaternion.clone(),
      target: this.controls.target.clone(),
      up: this._perspCamera.up.clone(),
    };

    // perspective frustum → ortho frustum 계산
    const cam = this._perspCamera;
    const dist = cam.position.distanceTo(this.controls.target);
    const fovRad = (cam.fov * Math.PI) / 180;
    const halfH = dist * Math.tan(fovRad / 2);
    const canvas = this.renderer.domElement;
    const aspect = canvas.clientWidth / canvas.clientHeight;

    // ortho 카메라 frustum 설정
    this._orthoCamera.left = -halfH * aspect;
    this._orthoCamera.right = halfH * aspect;
    this._orthoCamera.top = halfH;
    this._orthoCamera.bottom = -halfH;
    this._orthoCamera.near = 0.1;
    this._orthoCamera.far = 10000;
    this._orthoCamera.updateProjectionMatrix();

    // 위치/회전/업 벡터 복사
    this._orthoCamera.position.copy(cam.position);
    this._orthoCamera.quaternion.copy(cam.quaternion);
    this._orthoCamera.up.copy(cam.up);

    // OrbitControls를 ortho 카메라에 재연결
    this._activeCamera = this._orthoCamera;
    this.controls.object = this._orthoCamera;
    this.controls.update();

    // ortho 줌 시 그리드 갱신을 위한 이벤트 리스너 (중복 등록 방지)
    this.controls.removeEventListener("change", this._onControlsChangeInternal);
    this._onControlsChangeHandler = onGridUpdate;
    this.controls.addEventListener("change", this._onControlsChangeInternal);
    this.requestRender();
  }

  switchToPersp(): void {
    if (!this._isSketchMode) return;
    this._isSketchMode = false;

    // 스케치 진입 전 카메라 상태로 복원
    if (this._savedCameraState) {
      this._perspCamera.position.copy(this._savedCameraState.position);
      this._perspCamera.quaternion.copy(this._savedCameraState.quaternion);
      this._perspCamera.up.copy(this._savedCameraState.up);
      this.controls.target.copy(this._savedCameraState.target);
      this._savedCameraState = null;
    }

    // OrbitControls를 persp 카메라에 재연결
    this._activeCamera = this._perspCamera;
    this.controls.object = this._perspCamera;
    this.controls.update();

    // 3D 모드 controls.change → overlay fullRedraw. linkage 시각 요소 (cylinder 두께,
    // joint dot 크기 등) 가 활성 카메라 wpp 기반이므로 zoom/pan 시 모든 geom 재렌더 필요.
    this.controls.removeEventListener("change", this._onControlsChangeInternal);
    this._onControlsChangeHandler = () => {
      this._geometryOverlay?.requestFullRedraw();
    };
    this.controls.addEventListener("change", this._onControlsChangeInternal);
    this.requestRender();
  }

  /** 현재 perspective 카메라 + OrbitControls target 을 직렬화. sketch 모드면 saved state 사용 (sketch 진입 전). */
  getCameraState(): SetupCameraState {
    // sketch 모드: ortho 카메라가 활성. perspective 복원용 _savedCameraState 가 있으면 그걸 사용.
    // 라이브 _perspCamera 는 animateCameraToFacePlane 으로 면 정면 방향을 바라보게 변경된 상태라
    // quaternion 도 saved state 우선해야 사용자 회전 시점이 보존됨.
    const cam = this._perspCamera;
    const useSaved = this._isSketchMode && this._savedCameraState;
    const target = useSaved ? this._savedCameraState!.target : this.controls.target;
    const position = useSaved ? this._savedCameraState!.position : cam.position;
    const up = useSaved ? this._savedCameraState!.up : cam.up;
    const quaternion = useSaved ? this._savedCameraState!.quaternion : cam.quaternion;
    return {
      persp: {
        position: [position.x, position.y, position.z],
        quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
        up: [up.x, up.y, up.z],
      },
      target: [target.x, target.y, target.z],
    };
  }

  /** 외부 SetupCameraState 를 적용. 호출 전에 sketch 모드 종료 (resetCamera 의 sketch 정리 흐름과 동일). */
  applyCameraState(state: SetupCameraState): void {
    if (this._cameraAnimId !== null) {
      cancelAnimationFrame(this._cameraAnimId);
      this._cameraAnimId = null;
    }
    this._savedCameraState = null;
    if (this._isSketchMode) {
      this._isSketchMode = false;
      this._activeCamera = this._perspCamera;
      this.controls.object = this._perspCamera;
      this.controls.removeEventListener("change", this._onControlsChangeInternal);
      this._onControlsChangeHandler = null;
    }
    this._perspCamera.position.set(...state.persp.position);
    this._perspCamera.quaternion.set(...state.persp.quaternion);
    this._perspCamera.up.set(...state.persp.up);
    this.controls.target.set(...state.target);
    this.controls.update();
    this.requestRender();
  }

  /** 파일 전환 시 카메라 / OrbitControls 를 초기 상태로 복원. */
  resetCamera(): void {
    // 카메라 애니메이션 진행 중이면 취소
    if (this._cameraAnimId !== null) {
      cancelAnimationFrame(this._cameraAnimId);
      this._cameraAnimId = null;
    }
    // sketch 모드 잔여 상태 정리 (이론적으로 호출 전 closeSketch 가 처리하지만 보강)
    this._savedCameraState = null;
    if (this._isSketchMode) {
      this._isSketchMode = false;
      this._activeCamera = this._perspCamera;
      this.controls.object = this._perspCamera;
      this.controls.removeEventListener("change", this._onControlsChangeInternal);
      this._onControlsChangeHandler = null;
    }
    // 생성자 초기값으로 복원
    this._perspCamera.position.set(150, 100, 150);
    this._perspCamera.up.set(0, 1, 0);
    this._perspCamera.lookAt(0, 0, 0);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.requestRender();
  }

  private _onControlsChangeHandler: (() => void) | null = null;

  private _onControlsChangeInternal = (): void => {
    this._onControlsChangeHandler?.();
  };

  // geometry overlay 카메라 정보 동기화
  syncGeometryOverlayCamera(): void {
    if (this._geometryOverlay && this._isSketchMode) {
      const canvas = this.renderer.domElement;
      this._geometryOverlay.setCamera(this._orthoCamera, canvas.clientHeight);
    }
  }

  // 카메라 slerp 애니메이션 (~300ms, ease-out cubic) — 스케치 평면 정면으로
  animateCameraToFacePlane(
    origin: THREE.Vector3,
    normal: THREE.Vector3,
    stepModelGroups: Map<string, THREE.Group>,
    onComplete?: () => void,
  ): void {
    // 기존 카메라 애니메이션 취소
    if (this._cameraAnimId !== null) {
      cancelAnimationFrame(this._cameraAnimId);
      this._cameraAnimId = null;
    }
    // 모델 기준 적절한 거리 계산 — visible mesh 만 합산 (hidden BRep wireframe fallback 의
    // 잘못된 좌표가 bbox 에 포함되어 모델 크기가 비정상적으로 커지는 문제 방지).
    const dist = computeStepModelDist(stepModelGroups);

    const targetPos = origin.clone().add(normal.clone().multiplyScalar(dist));
    const targetTarget = origin.clone();

    const startPos = this._perspCamera.position.clone();
    const startTarget = this.controls.target.clone();
    const startTime = performance.now();
    const duration = 300;

    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const animateStep = () => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(elapsed / duration, 1);
      const e = easeOutCubic(t);

      this._perspCamera.position.lerpVectors(startPos, targetPos, e);
      this.controls.target.lerpVectors(startTarget, targetTarget, e);
      this.controls.update();

      if (t < 1) {
        this._cameraAnimId = requestAnimationFrame(animateStep);
      } else {
        this._cameraAnimId = null;
        // 마지막 frame — lerp 결과가 직전 frame 과 동일하면 controls.update 가 change emit 안
        // 할 수 있어 마지막 frame 누락 가능. 명시적으로 render 예약.
        this.requestRender();
        onComplete?.();
      }
    };

    this._cameraAnimId = requestAnimationFrame(animateStep);
  }

  // 애니메이션 없이 카메라를 평면 정면으로 즉시 텔레포트.
  // animateCameraToFacePlane 의 거리 계산 + 최종 위치 만 적용 (slerp 우회).
  // 파일 hydrate 시 3D → 2D 모션 안 보이게 하기 위함.
  placeCameraAtPlane(
    origin: THREE.Vector3,
    normal: THREE.Vector3,
    stepModelGroups: Map<string, THREE.Group>,
  ): void {
    if (this._cameraAnimId !== null) {
      cancelAnimationFrame(this._cameraAnimId);
      this._cameraAnimId = null;
    }
    const dist = computeStepModelDist(stepModelGroups);
    const targetPos = origin.clone().add(normal.clone().multiplyScalar(dist));
    this._perspCamera.position.copy(targetPos);
    this.controls.target.copy(origin);
    this.controls.update();
    this.requestRender();
  }

  // ViewCube 면 클릭 → 해당 방향에서 target을 바라보도록 카메라 이동
  animateCameraToDirection(
    direction: THREE.Vector3,
    up: THREE.Vector3,
  ): void {
    if (this._cameraAnimId !== null) {
      cancelAnimationFrame(this._cameraAnimId);
      this._cameraAnimId = null;
    }

    const target = this.controls.target.clone();
    const dist = this._perspCamera.position.distanceTo(target);
    const targetPos = target
      .clone()
      .add(direction.clone().multiplyScalar(dist));

    const startPos = this._perspCamera.position.clone();
    const startUp = this._perspCamera.up.clone();
    const startTime = performance.now();
    const duration = 300;

    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const animateStep = () => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(elapsed / duration, 1);
      const e = easeOutCubic(t);

      this._perspCamera.position.lerpVectors(startPos, targetPos, e);
      this._perspCamera.up.lerpVectors(startUp, up, e).normalize();
      this._perspCamera.lookAt(target);
      this.controls.update();

      if (t < 1) {
        this._cameraAnimId = requestAnimationFrame(animateStep);
      } else {
        this._cameraAnimId = null;
        // 마지막 frame — controls.update 가 change emit 안 할 수 있어 명시적으로 예약.
        this.requestRender();
      }
    };

    this._cameraAnimId = requestAnimationFrame(animateStep);
  }

  cancelCameraAnimation(): void {
    if (this._cameraAnimId !== null) {
      cancelAnimationFrame(this._cameraAnimId);
      this._cameraAnimId = null;
    }
  }

  dispose(): void {
    if (this._animationId !== null) {
      cancelAnimationFrame(this._animationId);
      this._animationId = null;
    }

    // ViewCube 해제
    if (this._viewCube) {
      this._viewCube.dispose();
      this._viewCube = null;
    }

    // GeometryOverlay 해제
    if (this._geometryOverlay) {
      this._geometryOverlay.dispose();
      this._geometryOverlay = null;
    }


    this.controls.removeEventListener("change", this._onControlsChangeInternal);
    this.controls.removeEventListener("change", this._onAnyChangeRequestRender);
    this.controls.dispose();
    this.renderer.dispose();
  }
}

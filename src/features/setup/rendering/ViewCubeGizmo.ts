// 축 기즈모 (Gnomon) — 메인 렌더러 우상단에 XYZ 축 표시.
// 메인 카메라 방향을 반영하는 3축 화살표 + 라벨 + 클릭 시 카메라 이동.
//
// 이전 (083 demoday 이전) 엔 three-viewport-gizmo 라이브러리의 cube widget 으로
// 교체했으나 drag 중 DOM/WebGL 두 pass + main scene re-render 누적으로 큰 mesh
// (OCCT STEP 모델) 와 함께 사용 시 render 지연 발생. 복귀.

import * as THREE from "three";

const VIEWPORT_SIZE = 100;
const ARROW_LENGTH = 0.7;
const CONE_LENGTH = 0.25;
const CONE_RADIUS = 0.08;
const SHAFT_RADIUS = 0.025;
const LABEL_OFFSET = 1.15;

// 축 정의: 방향, 색상, 라벨, 카메라 이동 방향, up 벡터
const AXES = [
  {
    dir: new THREE.Vector3(1, 0, 0),
    color: 0xe74c3c, // 빨강
    label: "X",
    up: new THREE.Vector3(0, 1, 0),
  },
  {
    dir: new THREE.Vector3(0, 1, 0),
    color: 0x2ecc71, // 초록
    label: "Y",
    up: new THREE.Vector3(0, 0, -1),
  },
  {
    dir: new THREE.Vector3(0, 0, 1),
    color: 0x3498db, // 파랑
    label: "Z",
    up: new THREE.Vector3(0, 1, 0),
  },
];

// 라벨 sprite 텍스처 생성
const createLabelSprite = (text: string, color: number): THREE.Sprite => {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;

  ctx.clearRect(0, 0, 64, 64);
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.font = "bold 40px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 32);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(0.35);
  return sprite;
};

export type ViewCubeFaceClickHandler = (direction: THREE.Vector3, up: THREE.Vector3) => void;

export class ViewCubeGizmo {
  private _renderer: THREE.WebGLRenderer;
  private _scene: THREE.Scene;
  private _camera: THREE.PerspectiveCamera;
  private _axisGroup: THREE.Group;
  private _raycaster: THREE.Raycaster;
  private _hitTargets: { mesh: THREE.Mesh; dir: THREE.Vector3; up: THREE.Vector3 }[] = [];
  private _onFaceClick: ViewCubeFaceClickHandler | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    this._renderer = renderer;
    this._scene = new THREE.Scene();

    this._camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
    this._camera.position.set(0, 0, 3);
    this._camera.lookAt(0, 0, 0);

    this._axisGroup = new THREE.Group();
    this._raycaster = new THREE.Raycaster();

    // 원점 구
    const centerGeom = new THREE.SphereGeometry(0.06, 16, 16);
    const centerMat = new THREE.MeshBasicMaterial({ color: 0x888888 });
    this._axisGroup.add(new THREE.Mesh(centerGeom, centerMat));

    // 축별 화살표(원기둥 + 콘) + 라벨 + 히트 영역
    const shaftGeom = new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, ARROW_LENGTH, 8);
    const coneGeom = new THREE.ConeGeometry(CONE_RADIUS, CONE_LENGTH, 12);

    for (const axis of AXES) {
      const mat = new THREE.MeshBasicMaterial({ color: axis.color });

      // 원기둥 (기본 Y축 → 원하는 방향으로 회전)
      const shaft = new THREE.Mesh(shaftGeom, mat);
      const quat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), axis.dir,
      );
      shaft.quaternion.copy(quat);
      shaft.position.copy(axis.dir.clone().multiplyScalar(ARROW_LENGTH / 2));
      this._axisGroup.add(shaft);

      // 콘 (화살표 머리)
      const cone = new THREE.Mesh(coneGeom, mat);
      cone.quaternion.copy(quat);
      cone.position.copy(axis.dir.clone().multiplyScalar(ARROW_LENGTH + CONE_LENGTH / 2));
      this._axisGroup.add(cone);

      // 라벨
      const sprite = createLabelSprite(axis.label, axis.color);
      sprite.position.copy(axis.dir.clone().multiplyScalar(LABEL_OFFSET));
      this._axisGroup.add(sprite);

      // 히트 영역 (투명 원기둥, 클릭 감지용)
      const hitGeom = new THREE.CylinderGeometry(0.12, 0.12, ARROW_LENGTH + CONE_LENGTH, 8);
      const hitMat = new THREE.MeshBasicMaterial({ visible: false });
      const hitMesh = new THREE.Mesh(hitGeom, hitMat);
      hitMesh.quaternion.copy(quat);
      hitMesh.position.copy(axis.dir.clone().multiplyScalar((ARROW_LENGTH + CONE_LENGTH) / 2));
      this._axisGroup.add(hitMesh);
      this._hitTargets.push({ mesh: hitMesh, dir: axis.dir.clone(), up: axis.up.clone() });
    }

    this._scene.add(this._axisGroup);
  }

  set onFaceClick(handler: ViewCubeFaceClickHandler | null) {
    this._onFaceClick = handler;
  }

  // 메인 카메라 방향을 축 그룹에 반영 (역방향 quaternion)
  syncWithCamera(mainCamera: THREE.Camera): void {
    this._axisGroup.quaternion.copy(mainCamera.quaternion).invert();
  }

  // 마우스 클릭이 gizmo viewport 영역 내인지 판정 + 축 선택
  handleClick(clientX: number, clientY: number): boolean {
    const domElement = this._renderer.domElement;
    const rect = domElement.getBoundingClientRect();
    const canvasW = domElement.clientWidth;

    // CSS 좌표에서 gizmo 영역 (우상단)
    const gizmoLeft = canvasW - VIEWPORT_SIZE;
    const gizmoTop = 0;
    const localX = (clientX - rect.left) - gizmoLeft;
    const localY = (clientY - rect.top) - gizmoTop;

    if (localX < 0 || localX > VIEWPORT_SIZE || localY < 0 || localY > VIEWPORT_SIZE) {
      return false;
    }

    const ndcX = (localX / VIEWPORT_SIZE) * 2 - 1;
    const ndcY = -(localY / VIEWPORT_SIZE) * 2 + 1;

    this._raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this._camera);
    const meshes = this._hitTargets.map((t) => t.mesh);
    const intersects = this._raycaster.intersectObjects(meshes);

    if (intersects.length > 0 && this._onFaceClick) {
      const hitMesh = intersects[0].object;
      const target = this._hitTargets.find((t) => t.mesh === hitMesh);
      if (target) {
        this._onFaceClick(target.dir.clone(), target.up.clone());
      }
      return true;
    }

    return false;
  }

  // scissored sub-viewport에 렌더링 (우상단, 투명 배경)
  render(): void {
    const renderer = this._renderer;
    const domElement = renderer.domElement;
    const width = domElement.clientWidth;
    const height = domElement.clientHeight;

    const vpX = width - VIEWPORT_SIZE;
    const vpY = height - VIEWPORT_SIZE;

    const currentScissorTest = renderer.getScissorTest();
    const prevAutoClear = renderer.autoClear;

    renderer.setViewport(vpX, vpY, VIEWPORT_SIZE, VIEWPORT_SIZE);
    renderer.setScissor(vpX, vpY, VIEWPORT_SIZE, VIEWPORT_SIZE);
    renderer.setScissorTest(true);

    // 배경 투명: color 클리어 없이 depth만 클리어
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this._scene, this._camera);

    // 복원
    renderer.autoClear = prevAutoClear;
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.setScissorTest(currentScissorTest);
  }

  dispose(): void {
    this._axisGroup.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
      if (child instanceof THREE.Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    });
  }
}

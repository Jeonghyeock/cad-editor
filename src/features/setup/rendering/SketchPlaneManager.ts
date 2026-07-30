// 스케치 평면 설정/해제, raycast, 그리드 overlay, 기준 평면 (XY/YZ/ZX) 관리

import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { NICE_STEPS } from "src/shared/constants/CanvasConstants";

import type { SketchPlane } from "../Setup.type";

import { COLOR_HOVERED, COLOR_SELECTED } from "./overlayConstants";

// 기준 평면 정의 (CATIA 스타일 XY/YZ/ZX) — splash dark theme: edge 흰색.
const ORIGIN_PLANES = [
  {
    name: "XY",
    normal: new THREE.Vector3(0, 0, 1),
    up: new THREE.Vector3(0, 1, 0),
    color: 0xffffff,
    rotation: new THREE.Euler(0, 0, 0), // PlaneGeometry 기본이 XY
  },
  {
    name: "YZ",
    normal: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    color: 0xffffff,
    rotation: new THREE.Euler(0, Math.PI / 2, 0),
  },
  {
    name: "ZX",
    normal: new THREE.Vector3(0, 1, 0),
    up: new THREE.Vector3(0, 0, -1),
    color: 0xffffff,
    rotation: new THREE.Euler(Math.PI / 2, 0, 0),
  },
];
const ORIGIN_PLANE_SIZE = 20;

/** 평면 좌표 → planeKey 문자열. `getPlaneKey` 의 instance 메서드와 동일 포맷 (origin + normal 3자리 반올림). */
export function planeKey(originX: number, originY: number, originZ: number, normalX: number, normalY: number, normalZ: number): string {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return `${r(originX)},${r(originY)},${r(originZ)}|${r(normalX)},${r(normalY)},${r(normalZ)}`;
}

/** SketchPlane 객체 → planeKey 문자열. file load 시 baked sketch hydrate 등 standalone 흐름 헬퍼. */
export function planeKeyFromSketchPlane(plane: {
  origin: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}): string {
  return planeKey(
    plane.origin.x,
    plane.origin.y,
    plane.origin.z,
    plane.normal.x,
    plane.normal.y,
    plane.normal.z,
  );
}

/**
 * Origin plane 3개의 planeKey 를 인덱스 0..2 순서대로 반환.
 * SpecTree 가 viewState.sketchPlaneKey 를 origin plane 인덱스로 역추적 — local state 없이 derive 가능.
 */
export const ORIGIN_PLANE_KEYS: readonly string[] = ORIGIN_PLANES.map((p) =>
  planeKey(0, 0, 0, p.normal.x, p.normal.y, p.normal.z),
);

// 그리드 overlay 상수 (drawGridLines 패턴 참고)
const GRID_MIN_PIXEL_SPACING = 30; // 화면상 최소 셀 픽셀 간격
// splash dark theme — 어두운 viewport (#1f2227) 위에 적당한 contrast 의 회색 grid.
const GRID_COLOR_MAJOR = 0x60666c; // $gray-600 — major grid (10 단위)
const GRID_COLOR_MINOR = 0x484c51; // $gray-700 — minor grid (1 단위)

export class SketchPlaneManager {
  /** Phase 4 — scene mutation 시 호출. */
  onSceneChanged: (() => void) | null = null;

  private _notifyChange(): void {
    this.onSceneChanged?.();
  }

  // 기준 평면 (XY, YZ, ZX)
  private _originPlanesGroup: THREE.Group;
  private _originPlaneMeshes: THREE.Mesh[] = [];
  // hover/select state 분리 — 동시에 둘 다 시각화 가능 (서로 다른 평면일 때 hover 색 / select 색 각각 적용)
  private _hoveredOriginIndex: number | null = null;
  private _selectedOriginIndex: number | null = null;

  // Reference planes (user-created)
  private _referencePlanesGroup: THREE.Group;
  private _referencePlaneMeshes: Map<string, THREE.Mesh> = new Map();
  private _referencePlaneData: Map<string, SketchPlane> = new Map();
  private _hoveredRefPlaneId: string | null = null;
  private _selectedRefPlaneId: string | null = null;

  // Ref plane preview (PlaneDefinitionPanel 입력 중 미리보기 — 실선이 아닌 dashed 보라)
  private _refPlanePreview: THREE.LineSegments | null = null;

  // 스케치 평면 (invisible raycast mesh)
  private _sketchPlaneMesh: THREE.Mesh | null = null;
  private _sketchPlaneData: {
    origin: THREE.Vector3;
    u: THREE.Vector3;
    v: THREE.Vector3;
  } | null = null;

  // 현재 스케치 평면의 SketchPlane (InputCanvas에서 전달받은 원본)
  private _currentSketchPlane: SketchPlane | null = null;

  // 그리드 overlay (별도 씬 + clearDepth 패턴)
  private _gridScene: THREE.Scene | null = null;
  private _gridMajor: THREE.LineSegments | null = null;
  private _gridMinor: THREE.LineSegments | null = null;
  // 원점 축선 + 마커
  private _originAxes: THREE.Group | null = null;
  // 그리드 좌표 라벨 (major spacing 위치 + 원점 "O")
  private _gridLabels: THREE.Sprite[] = [];

  // 재사용 벡터 (GC 최소화)
  private _gridTmpA = new THREE.Vector3();
  private _gridTmpB = new THREE.Vector3();

  constructor(
    private _scene: THREE.Scene,
    private _renderer: THREE.WebGLRenderer,
    private _controls: OrbitControls,
    private _raycaster: THREE.Raycaster,
  ) {
    // 기준 평면 (CATIA 스타일 XY/YZ/ZX)
    this._originPlanesGroup = new THREE.Group();
    this._originPlanesGroup.name = "origin-planes";
    this._createOriginPlanes();
    this._scene.add(this._originPlanesGroup);

    this._referencePlanesGroup = new THREE.Group();
    this._referencePlanesGroup.name = "reference-planes";
    this._scene.add(this._referencePlanesGroup);
  }

  get sketchPlaneData(): {
    origin: THREE.Vector3;
    u: THREE.Vector3;
    v: THREE.Vector3;
  } | null {
    return this._sketchPlaneData;
  }

  get gridScene(): THREE.Scene | null {
    return this._gridScene;
  }

  // 현재 스케치 평면 접근자
  getSketchPlane(): SketchPlane | null {
    return this._currentSketchPlane;
  }

  // 평면 고유 키 생성 (origin + normal 기반)
  getPlaneKey(plane?: SketchPlane): string | null {
    const p = plane ?? this._currentSketchPlane;
    if (!p) return null;
    const r = (n: number) => Math.round(n * 1000) / 1000;
    return `${r(p.origin.x)},${r(p.origin.y)},${r(p.origin.z)}|${r(p.normal.x)},${r(p.normal.y)},${r(p.normal.z)}`;
  }

  // --- 스케치 평면 설정 ---

  setupSketchPlane(
    plane: SketchPlane,
    modelOffset: THREE.Vector3,
  ): void {
    this.clearSketchPlane();
    this._currentSketchPlane = plane;

    const origin = new THREE.Vector3(
      plane.origin.x + modelOffset.x,
      plane.origin.y + modelOffset.y,
      plane.origin.z + modelOffset.z,
    );
    const normal = new THREE.Vector3(
      plane.normal.x,
      plane.normal.y,
      plane.normal.z,
    ).normalize();
    const u = new THREE.Vector3(plane.u.x, plane.u.y, plane.u.z);
    const v = new THREE.Vector3(plane.v.x, plane.v.y, plane.v.z);

    this._sketchPlaneData = { origin, u, v };

    // invisible plane mesh (raycast 전용)
    const planeGeom = new THREE.PlaneGeometry(10000, 10000);
    const planeMat = new THREE.MeshBasicMaterial({
      visible: false,
      side: THREE.DoubleSide,
    });
    this._sketchPlaneMesh = new THREE.Mesh(planeGeom, planeMat);
    this._sketchPlaneMesh.name = "sketch-plane";

    // 평면 배치: PlaneGeometry는 XY 평면이므로 법선 방향으로 회전
    const defaultNormal = new THREE.Vector3(0, 0, 1);
    const quat = new THREE.Quaternion().setFromUnitVectors(
      defaultNormal,
      normal,
    );
    this._sketchPlaneMesh.quaternion.copy(quat);
    this._sketchPlaneMesh.position.copy(origin);

    this._scene.add(this._sketchPlaneMesh);
    this._notifyChange();
  }

  clearSketchPlane(): void {
    // invisible plane 제거
    if (this._sketchPlaneMesh) {
      this._scene.remove(this._sketchPlaneMesh);
      this._sketchPlaneMesh.geometry.dispose();
      (this._sketchPlaneMesh.material as THREE.Material).dispose();
      this._sketchPlaneMesh = null;
    }

    this._sketchPlaneData = null;
    this._currentSketchPlane = null;

    // 그리드 overlay 해제
    this._disposeGridOverlay();
    this._notifyChange();
  }

  // NDC → invisible plane raycast → 평면 local 2D 좌표
  raycastSketchPlane(
    mouseNDC: THREE.Vector2,
    activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  ): { x: number; y: number } | null {
    if (!this._sketchPlaneMesh || !this._sketchPlaneData) return null;

    this._raycaster.setFromCamera(mouseNDC, activeCamera);
    const intersects = this._raycaster.intersectObject(this._sketchPlaneMesh);
    if (intersects.length === 0) return null;

    const hit = intersects[0].point;
    const { origin, u, v } = this._sketchPlaneData;
    const d = hit.clone().sub(origin);

    return {
      x: d.dot(u),
      y: d.dot(v),
    };
  }

  getSketchPlaneBasis(): {
    origin: THREE.Vector3;
    u: THREE.Vector3;
    v: THREE.Vector3;
  } | null {
    return this._sketchPlaneData;
  }

  // 현재 줌 레벨에 맞는 그리드 스냅 간격 반환
  getGridSpacing(orthoCamera: THREE.OrthographicCamera): number {
    const cam = orthoCamera;
    const zoom = cam.zoom || 1;
    const visibleWidth = (cam.right - cam.left) / zoom;
    const canvas = this._renderer.domElement;
    const pixelWidth = canvas.clientWidth || 1;
    const scale = pixelWidth / visibleWidth;

    for (const step of NICE_STEPS) {
      if (step * scale >= GRID_MIN_PIXEL_SPACING) {
        return step;
      }
    }
    return NICE_STEPS[NICE_STEPS.length - 1];
  }

  // --- 그리드 Overlay ---

  createGridOverlay(): void {
    this._disposeGridOverlay();
    this._gridScene = new THREE.Scene();
  }

  updateGridOverlay(orthoCamera: THREE.OrthographicCamera): void {
    if (!this._gridScene) return;

    const cam = orthoCamera;
    // OrbitControls는 ortho 줌 시 camera.zoom을 변경하므로 실제 가시 영역에 반영
    const zoom = cam.zoom || 1;
    const visibleWidth = (cam.right - cam.left) / zoom;
    const visibleHeight = (cam.top - cam.bottom) / zoom;
    const canvas = this._renderer.domElement;
    const pixelWidth = canvas.clientWidth || 1;

    // NICE_STEPS 기반 고정 간격 (drawGridLines 패턴)
    const scale = pixelWidth / visibleWidth;
    let minorSpacing = NICE_STEPS[NICE_STEPS.length - 1];
    for (const step of NICE_STEPS) {
      if (step * scale >= GRID_MIN_PIXEL_SPACING) {
        minorSpacing = step;
        break;
      }
    }
    const majorSpacing = minorSpacing * 5;

    // 기존 그리드 제거
    if (this._gridMajor) {
      this._gridScene.remove(this._gridMajor);
      this._gridMajor.geometry.dispose();
      (this._gridMajor.material as THREE.Material).dispose();
      this._gridMajor = null;
    }
    if (this._gridMinor) {
      this._gridScene.remove(this._gridMinor);
      this._gridMinor.geometry.dispose();
      (this._gridMinor.material as THREE.Material).dispose();
      this._gridMinor = null;
    }

    // 카메라 타겟 (스케치 평면 origin) 기준으로 그리드 범위 계산
    const cx = this._controls.target.x;
    const cy = this._controls.target.y;
    const cz = this._controls.target.z;
    const extent = Math.max(visibleWidth, visibleHeight) * 2.5;

    // 스케치 평면 법선/u/v 기준으로 그리드 라인 생성
    if (!this._sketchPlaneData) return;
    const { origin, u, v } = this._sketchPlaneData;

    // 카메라 중심을 평면 로컬 좌표로 변환
    const camCenter = new THREE.Vector3(cx, cy, cz);
    const d = camCenter.clone().sub(origin);
    const centerU = d.dot(u);
    const centerV = d.dot(v);

    // 보조 그리드 (minor) — 화면상 최소 크기 이상일 때만 표시
    const minorCellPx = minorSpacing * scale;
    if (minorCellPx >= GRID_MIN_PIXEL_SPACING * 0.5) {
      this._gridMinor = this._buildGridLines(
        origin,
        u,
        v,
        centerU,
        centerV,
        extent,
        minorSpacing,
        GRID_COLOR_MINOR,
        0.4,
      );
      this._gridScene.add(this._gridMinor);
    }

    // 주 그리드 (major)
    this._gridMajor = this._buildGridLines(
      origin,
      u,
      v,
      centerU,
      centerV,
      extent,
      majorSpacing,
      GRID_COLOR_MAJOR,
      0.7,
    );
    this._gridScene.add(this._gridMajor);

    // 원점 축선 + 마커
    if (this._originAxes) {
      this._gridScene.remove(this._originAxes);
      this._originAxes.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else (obj.material as THREE.Material).dispose();
        }
      });
      this._originAxes = null;
    }

    const axesGroup = new THREE.Group();
    const halfExt = extent / 2;
    const axisDepthOffset = 0.001; // 그리드 위에 렌더되도록 미세 오프셋

    // X축 (u 방향) — 빨강
    const xPositions = new Float32Array(6);
    const xA = origin.clone().addScaledVector(u, centerU - halfExt).addScaledVector(v, 0);
    const xB = origin.clone().addScaledVector(u, centerU + halfExt).addScaledVector(v, 0);
    const normal = u.clone().cross(v).normalize();
    xA.addScaledVector(normal, axisDepthOffset);
    xB.addScaledVector(normal, axisDepthOffset);
    xPositions.set([xA.x, xA.y, xA.z, xB.x, xB.y, xB.z]);
    const xGeom = new THREE.BufferGeometry();
    xGeom.setAttribute("position", new THREE.BufferAttribute(xPositions, 3));
    axesGroup.add(new THREE.LineSegments(xGeom, new THREE.LineBasicMaterial({
      color: GRID_COLOR_MAJOR, transparent: true, opacity: 0.6, depthTest: false,
    })));

    // Y축 (v 방향) — 초록
    const yPositions = new Float32Array(6);
    const yA = origin.clone().addScaledVector(u, 0).addScaledVector(v, centerV - halfExt);
    const yB = origin.clone().addScaledVector(u, 0).addScaledVector(v, centerV + halfExt);
    yA.addScaledVector(normal, axisDepthOffset);
    yB.addScaledVector(normal, axisDepthOffset);
    yPositions.set([yA.x, yA.y, yA.z, yB.x, yB.y, yB.z]);
    const yGeom = new THREE.BufferGeometry();
    yGeom.setAttribute("position", new THREE.BufferAttribute(yPositions, 3));
    axesGroup.add(new THREE.LineSegments(yGeom, new THREE.LineBasicMaterial({
      color: GRID_COLOR_MAJOR, transparent: true, opacity: 0.6, depthTest: false,
    })));

    // 원점 마커 — 주황 원
    const wpp = visibleWidth / pixelWidth; // world units per pixel
    const markerRadius = wpp * 3;
    const markerGeom = new THREE.CircleGeometry(markerRadius, 16);
    const markerMat = new THREE.MeshBasicMaterial({
      color: GRID_COLOR_MAJOR, transparent: true, opacity: 0.8, depthTest: false, side: THREE.DoubleSide,
    });
    const markerMesh = new THREE.Mesh(markerGeom, markerMat);
    const markerPos = origin.clone().addScaledVector(normal, axisDepthOffset * 2);
    markerMesh.position.copy(markerPos);
    // 스케치 평면에 정렬
    const lookTarget = markerPos.clone().add(normal);
    markerMesh.lookAt(lookTarget);
    axesGroup.add(markerMesh);

    this._originAxes = axesGroup;
    this._gridScene.add(axesGroup);

    // 좌표 라벨 (major spacing 위치 + 원점 "O")
    this._buildGridLabels(origin, u, v, normal, centerU, centerV, halfExt, majorSpacing, wpp);
  }

  /**
   * Major 격자 위치에 좌표 숫자 라벨 + 원점 "O" 라벨 표시 (problem-definition drawCanvas와 동등).
   * Sprite 텍스처 기반 (canvas 2D로 텍스트 렌더 → THREE.CanvasTexture).
   */
  private _buildGridLabels(
    origin: THREE.Vector3,
    u: THREE.Vector3,
    v: THREE.Vector3,
    normal: THREE.Vector3,
    centerU: number,
    centerV: number,
    halfExt: number,
    majorSpacing: number,
    wpp: number,
  ): void {
    if (!this._gridScene) return;

    // 기존 라벨 정리
    for (const sp of this._gridLabels) {
      this._gridScene.remove(sp);
      sp.material.map?.dispose();
      sp.material.dispose();
    }
    this._gridLabels = [];

    const labelHeightPx = 11; // 화면상 폰트 높이
    const labelWorldHeight = wpp * labelHeightPx;
    const offsetWorld = wpp * 6; // axis line으로부터 약간 떨어뜨려 가독성

    // x축 (u 방향) — v=0 라인 따라
    const uStart = Math.floor((centerU - halfExt) / majorSpacing) * majorSpacing;
    const uEnd = Math.ceil((centerU + halfExt) / majorSpacing) * majorSpacing;
    for (let uu = uStart; uu <= uEnd; uu += majorSpacing) {
      if (Math.abs(uu) < 1e-6) continue; // 원점은 별도 "O" 라벨
      const pos = origin.clone()
        .addScaledVector(u, uu)
        .addScaledVector(v, -offsetWorld) // axis 아래로
        .addScaledVector(normal, 0.002);
      const sp = this._makeLabelSprite(`${+uu.toFixed(6)}`, labelWorldHeight);
      sp.position.copy(pos);
      this._gridScene.add(sp);
      this._gridLabels.push(sp);
    }

    // y축 (v 방향) — u=0 라인 따라
    const vStart = Math.floor((centerV - halfExt) / majorSpacing) * majorSpacing;
    const vEnd = Math.ceil((centerV + halfExt) / majorSpacing) * majorSpacing;
    for (let vv = vStart; vv <= vEnd; vv += majorSpacing) {
      if (Math.abs(vv) < 1e-6) continue;
      const pos = origin.clone()
        .addScaledVector(u, -offsetWorld) // axis 왼쪽으로
        .addScaledVector(v, vv)
        .addScaledVector(normal, 0.002);
      const sp = this._makeLabelSprite(`${+vv.toFixed(6)}`, labelWorldHeight);
      sp.position.copy(pos);
      this._gridScene.add(sp);
      this._gridLabels.push(sp);
    }

    // 원점 라벨 "O" (오른쪽 위로 살짝 offset)
    const originPos = origin.clone()
      .addScaledVector(u, offsetWorld)
      .addScaledVector(v, offsetWorld)
      .addScaledVector(normal, 0.002);
    const oSp = this._makeLabelSprite("O", labelWorldHeight);
    oSp.position.copy(originPos);
    this._gridScene.add(oSp);
    this._gridLabels.push(oSp);
  }

  /** 텍스트를 canvas 2D로 렌더하여 Sprite로 만듦 (월드 높이 = labelHeight) */
  private _makeLabelSprite(text: string, labelHeight: number): THREE.Sprite {
    const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    const fontPx = 14 * dpr;
    const padX = 4 * dpr;
    const padY = 2 * dpr;
    const canvas = document.createElement("canvas");
    const tmpCtx = canvas.getContext("2d");
    if (!tmpCtx) {
      // fallback: 빈 sprite
      return new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true }));
    }
    tmpCtx.font = `${fontPx}px Arial, sans-serif`;
    const metrics = tmpCtx.measureText(text);
    const w = Math.ceil(metrics.width) + padX * 2;
    const h = fontPx + padY * 2;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, transparent: true }));
    ctx.font = `${fontPx}px Arial, sans-serif`;
    ctx.fillStyle = "#666";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(text, w / 2, h / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      transparent: true,
    });
    const sprite = new THREE.Sprite(mat);
    // 월드 크기: 높이 = labelHeight, 너비는 종횡비 유지
    const aspect = w / h;
    sprite.scale.set(labelHeight * aspect, labelHeight, 1);
    return sprite;
  }

  private _buildGridLines(
    origin: THREE.Vector3,
    uDir: THREE.Vector3,
    vDir: THREE.Vector3,
    centerU: number,
    centerV: number,
    extent: number,
    spacing: number,
    color: number,
    opacity: number,
  ): THREE.LineSegments {
    const halfExt = extent / 2;
    const positions: number[] = [];
    const a = this._gridTmpA;
    const b = this._gridTmpB;

    // u 방향 라인 (v를 따라 반복)
    const vStart = Math.floor((centerV - halfExt) / spacing) * spacing;
    const vEnd = Math.ceil((centerV + halfExt) / spacing) * spacing;
    for (let vv = vStart; vv <= vEnd; vv += spacing) {
      a.copy(origin)
        .addScaledVector(uDir, centerU - halfExt)
        .addScaledVector(vDir, vv);
      b.copy(origin)
        .addScaledVector(uDir, centerU + halfExt)
        .addScaledVector(vDir, vv);
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }

    // v 방향 라인 (u를 따라 반복)
    const uStart = Math.floor((centerU - halfExt) / spacing) * spacing;
    const uEnd = Math.ceil((centerU + halfExt) / spacing) * spacing;
    for (let uu = uStart; uu <= uEnd; uu += spacing) {
      a.copy(origin)
        .addScaledVector(uDir, uu)
        .addScaledVector(vDir, centerV - halfExt);
      b.copy(origin)
        .addScaledVector(uDir, uu)
        .addScaledVector(vDir, centerV + halfExt);
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
    });

    return new THREE.LineSegments(geom, mat);
  }

  private _disposeGridOverlay(): void {
    if (this._gridMajor) {
      this._gridMajor.geometry.dispose();
      (this._gridMajor.material as THREE.Material).dispose();
      this._gridMajor = null;
    }
    if (this._gridMinor) {
      this._gridMinor.geometry.dispose();
      (this._gridMinor.material as THREE.Material).dispose();
      this._gridMinor = null;
    }
    if (this._originAxes) {
      this._originAxes.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else (obj.material as THREE.Material).dispose();
        }
      });
      this._originAxes = null;
    }
    for (const sp of this._gridLabels) {
      sp.material.map?.dispose();
      sp.material.dispose();
    }
    this._gridLabels = [];
    this._gridScene = null;
  }

  // --- 기준 평면 (XY/YZ/ZX) ---

  private _createOriginPlanes(): void {
    for (const def of ORIGIN_PLANES) {
      // CATIA 식 wireframe 표현: face 는 invisible (raycast 용으로 visible 유지) + 모서리만 표시.
      const geom = new THREE.PlaneGeometry(
        ORIGIN_PLANE_SIZE,
        ORIGIN_PLANE_SIZE,
      );
      const mat = new THREE.MeshBasicMaterial({
        color: def.color,
        transparent: true,
        opacity: 0,         // 면 색깔 없음
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.name = `origin-plane-${def.name}`;
      mesh.rotation.copy(def.rotation);
      this._originPlanesGroup.add(mesh);
      this._originPlaneMeshes.push(mesh);

      // 테두리 라인 — wireframe 시각의 핵심
      const edgeGeom = new THREE.EdgesGeometry(geom);
      const edgeMat = new THREE.LineBasicMaterial({
        color: def.color,
        transparent: true,
        opacity: 0.7,
      });
      const edge = new THREE.LineSegments(edgeGeom, edgeMat);
      edge.rotation.copy(def.rotation);
      edge.name = `origin-plane-edge-${def.name}`;
      this._originPlanesGroup.add(edge);
    }
  }

  // 기준 평면 레이캐스팅 — 클릭된 평면의 인덱스 반환
  pickOriginPlane(
    mouseNDC: THREE.Vector2,
    activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  ): number | null {
    this._raycaster.setFromCamera(mouseNDC, activeCamera);
    const intersects = this._raycaster.intersectObjects(this._originPlaneMeshes);
    if (intersects.length === 0) return null;
    return this._originPlaneMeshes.indexOf(intersects[0].object as THREE.Mesh);
  }

  // 기준 평면 edge 색/opacity 갱신 — hover/select 둘 다 고려.
  // 같은 index 가 hover + select 인 경우 select 색 우선 (CATIA 와 유사한 동작).
  private _refreshOriginPlaneEdge(i: number): void {
    const def = ORIGIN_PLANES[i];
    const edge = this._originPlanesGroup.getObjectByName(
      `origin-plane-edge-${def.name}`,
    ) as THREE.LineSegments | null;
    if (!edge) return;
    const mat = edge.material as THREE.LineBasicMaterial;
    if (this._selectedOriginIndex === i) {
      mat.color.setHex(COLOR_SELECTED);
      mat.opacity = 1.0;
    } else if (this._hoveredOriginIndex === i) {
      mat.color.setHex(COLOR_HOVERED);
      mat.opacity = 1.0;
    } else {
      mat.color.setHex(def.color);
      mat.opacity = 0.7;
    }
  }

  /** hover 상태 set — 이전/현재 hover index 모두 edge 재계산. select state 영향 없음. */
  setOriginPlaneHover(index: number | null): void {
    const prev = this._hoveredOriginIndex;
    if (prev === index) return;
    this._hoveredOriginIndex = index;
    if (prev !== null) this._refreshOriginPlaneEdge(prev);
    if (index !== null) this._refreshOriginPlaneEdge(index);
    this._notifyChange();
  }

  /** select 상태 set — hover 보다 시각 우선. */
  setOriginPlaneSelect(index: number | null): void {
    const prev = this._selectedOriginIndex;
    if (prev === index) return;
    this._selectedOriginIndex = index;
    if (prev !== null) this._refreshOriginPlaneEdge(prev);
    if (index !== null) this._refreshOriginPlaneEdge(index);
    this._notifyChange();
  }

  /** 기존 호환용 alias — hover-only 설정. select 상태는 변경하지 않음. */
  highlightOriginPlane(index: number | null): void {
    this.setOriginPlaneHover(index);
  }

  // 기준 평면 인덱스 → SketchPlane 데이터 생성
  getOriginPlaneAsSketchPlane(index: number): SketchPlane {
    const def = ORIGIN_PLANES[index];
    // u, v: 평면 위의 local 좌표축
    const n = def.normal.clone();
    const upHint =
      Math.abs(n.y) < 0.9
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(upHint, n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u).normalize();

    return {
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: n.x, y: n.y, z: n.z },
      u: { x: u.x, y: u.y, z: u.z },
      v: { x: v.x, y: v.y, z: v.z },
    };
  }

  // 기준 평면 가시성 토글
  setOriginPlanesVisible(visible: boolean): void {
    this._originPlanesGroup.visible = visible;
    this._notifyChange();
  }

  // --- Reference Planes ---

  addReferencePlane(id: string, plane: SketchPlane, _name: string): void {
    this.removeReferencePlane(id);
    const { origin, normal, u: _u, v: _v } = plane;

    // CATIA 식 wireframe — face invisible (raycast 용으로 visible) + 모서리 표시.
    const geom = new THREE.PlaneGeometry(ORIGIN_PLANE_SIZE, ORIGIN_PLANE_SIZE);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x303336,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `ref-plane-${id}`;
    mesh.userData.refPlaneId = id;

    // Orient mesh to match plane
    const pos = new THREE.Vector3(origin.x, origin.y, origin.z);
    const norm = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
    mesh.position.copy(pos);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), norm);

    this._referencePlanesGroup.add(mesh);
    this._referencePlaneMeshes.set(id, mesh);
    this._referencePlaneData.set(id, plane);

    // Edge outline — 회색 실선 (origin plane 검정과 구분)
    const edgeGeom = new THREE.EdgesGeometry(geom);
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x9199a1, transparent: true, opacity: 0.8 });
    const edge = new THREE.LineSegments(edgeGeom, edgeMat);
    edge.position.copy(pos);
    edge.quaternion.copy(mesh.quaternion);
    edge.name = `ref-plane-edge-${id}`;
    this._referencePlanesGroup.add(edge);
    this._notifyChange();
  }

  removeReferencePlane(id: string): void {
    const mesh = this._referencePlaneMeshes.get(id);
    if (mesh) {
      this._referencePlanesGroup.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this._referencePlaneMeshes.delete(id);
    }
    const edge = this._referencePlanesGroup.getObjectByName(`ref-plane-edge-${id}`);
    if (edge) {
      this._referencePlanesGroup.remove(edge);
      (edge as THREE.LineSegments).geometry?.dispose();
      ((edge as THREE.LineSegments).material as THREE.Material)?.dispose();
    }
    this._referencePlaneData.delete(id);
    this._notifyChange();
  }

  pickReferencePlane(
    mouseNDC: THREE.Vector2,
    activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  ): string | null {
    this._raycaster.setFromCamera(mouseNDC, activeCamera);
    const meshes = [...this._referencePlaneMeshes.values()];
    const hits = this._raycaster.intersectObjects(meshes);
    if (hits.length === 0) return null;
    return (hits[0].object as THREE.Mesh).userData.refPlaneId ?? null;
  }

  /**
   * Ref Plane 생성 panel 의 실시간 preview — wireframe 회색 dashed line.
   * 확정된 ref plane (검정 실선) 과 시각적으로 구분.
   * plane null 이면 preview 제거.
   */
  setRefPlanePreview(plane: SketchPlane | null): void {
    if (this._refPlanePreview) {
      this._referencePlanesGroup.remove(this._refPlanePreview);
      this._refPlanePreview.geometry.dispose();
      (this._refPlanePreview.material as THREE.Material).dispose();
      this._refPlanePreview = null;
    }
    if (!plane) return;
    const geom = new THREE.PlaneGeometry(ORIGIN_PLANE_SIZE, ORIGIN_PLANE_SIZE);
    const edgeGeom = new THREE.EdgesGeometry(geom);
    const mat = new THREE.LineDashedMaterial({
      color: 0x9199a1, // 회색 — preview
      dashSize: 1.5,
      gapSize: 0.8,
      transparent: true,
      opacity: 0.9,
    });
    const lines = new THREE.LineSegments(edgeGeom, mat);
    lines.computeLineDistances();
    const pos = new THREE.Vector3(plane.origin.x, plane.origin.y, plane.origin.z);
    const norm = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z).normalize();
    lines.position.copy(pos);
    lines.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), norm);
    lines.name = "ref-plane-preview";
    this._referencePlanesGroup.add(lines);
    this._refPlanePreview = lines;
    geom.dispose(); // edges 만 사용
    this._notifyChange();
  }

  // Ref plane 기본 색 (생성 시 0x9199a1) — refresh 시 hover/select 없으면 복원.
  private static readonly _REF_PLANE_BASE_COLOR = 0x9199a1;

  private _refreshReferencePlaneEdge(id: string): void {
    const edge = this._referencePlanesGroup.getObjectByName(
      `ref-plane-edge-${id}`,
    ) as THREE.LineSegments | null;
    if (!edge) return;
    const mat = edge.material as THREE.LineBasicMaterial;
    if (this._selectedRefPlaneId === id) {
      mat.color.setHex(COLOR_SELECTED);
      mat.opacity = 1.0;
    } else if (this._hoveredRefPlaneId === id) {
      mat.color.setHex(COLOR_HOVERED);
      mat.opacity = 1.0;
    } else {
      mat.color.setHex(SketchPlaneManager._REF_PLANE_BASE_COLOR);
      mat.opacity = 0.8;
    }
  }

  setReferencePlaneHover(id: string | null): void {
    const prev = this._hoveredRefPlaneId;
    if (prev === id) return;
    this._hoveredRefPlaneId = id;
    if (prev) this._refreshReferencePlaneEdge(prev);
    if (id) this._refreshReferencePlaneEdge(id);
    this._notifyChange();
  }

  setReferencePlaneSelect(id: string | null): void {
    const prev = this._selectedRefPlaneId;
    if (prev === id) return;
    this._selectedRefPlaneId = id;
    if (prev) this._refreshReferencePlaneEdge(prev);
    if (id) this._refreshReferencePlaneEdge(id);
    this._notifyChange();
  }

  /** 기존 호환용 alias — hover-only 설정. select 상태는 변경하지 않음. */
  highlightReferencePlane(id: string | null): void {
    this.setReferencePlaneHover(id);
  }

  getReferencePlaneAsSketchPlane(id: string): SketchPlane | null {
    return this._referencePlaneData.get(id) ?? null;
  }

  /** 모든 reference plane SketchPlane 객체 — planeKey 역추적용. */
  getReferencePlanes(): SketchPlane[] {
    return [...this._referencePlaneData.values()];
  }

  setReferencePlanesVisible(visible: boolean): void {
    this._referencePlanesGroup.visible = visible;
    this._notifyChange();
  }

  dispose(): void {
    this.clearSketchPlane();
    // Reference planes 해제
    for (const [id] of this._referencePlaneMeshes) {
      this.removeReferencePlane(id);
    }
    this._scene.remove(this._referencePlanesGroup);
    this._scene.remove(this._originPlanesGroup);
  }

  get originPlanesGroup(): THREE.Group {
    return this._originPlanesGroup;
  }
}

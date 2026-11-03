// STEP 모델 관리 + 3D body 선택/호버/하이라이트 + 측정

import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { SelectionFilterMode, StepModelData, Vec3 } from "../Setup.type";
import { extractBRepEdgesNative } from "../step/BRepEdgeExtractorNative";
import { createBRepWireframe, disposeBRepWireframe } from "../step/BRepWireframe";
import {
  createStepModelGroup,
  highlightFace as highlightFaceMesh,
  highlightEdge as highlightEdgeMesh,
  highlightVertex as highlightVertexMesh,
  invalidateEdgeCacheForGroup,
  selectEdge as selectEdgeMesh,
  selectVertex as selectVertexMesh,
  pickFace,
  pickEdge,
  pickVertex,
  getVisibleBodyMeshes,
} from "../step/StepModelManager";

import { disposeObject3D, disposeGroupChildren } from "./disposeUtils";
import { COLOR_HOVERED_EMISSIVE, COLOR_SELECTED_EMISSIVE } from "./overlayConstants";
import type { EntityPicker, PickCtx, PickEntity } from "./picking/EntityPicker";
import { rayDepth } from "./picking/EntityPicker";

export class ModelManager implements EntityPicker {
  readonly source = "step" as const;

  private _stepModelGroups: Map<string, THREE.Group> = new Map();
  private _modelOffsets: Map<string, THREE.Vector3> = new Map();
  private _sectionPreviewGroup: THREE.Group = new THREE.Group();

  // 3D body 선택/호버 상태
  private _hoveredBody: { modelId: string; bodyIndex: number } | null = null;
  private _selectedBody: { modelId: string; bodyIndex: number } | null = null;
  private _selectedBodies: { modelId: string; bodyIndex: number }[] = [];

  // STEP mesh 반투명 상태 캐시 — sketch 모드 중 STEP import 시 새 model 에도 같은 opacity 적용 위함.
  private _transparentState: { transparent: boolean; opacity: number } = { transparent: false, opacity: 1.0 };

  // 3D body hover/select 변경 시 외부 알림 콜백
  onBodyHoverChanged:
    | ((modelId: string | null, bodyIndex: number | null) => void)
    | null = null;
  onBodySelectChanged:
    | ((modelId: string | null, bodyIndex: number | null) => void)
    | null = null;
  /** Phase 4 — scene mutation (model add/remove/visible/transform 등) 시 호출. SceneManager 가 requestRender 로 연결. */
  onSceneChanged: (() => void) | null = null;

  private _notifyChange(): void {
    this.onSceneChanged?.();
  }

  get stepModelGroups(): Map<string, THREE.Group> {
    return this._stepModelGroups;
  }

  get sectionPreviewGroup(): THREE.Group {
    return this._sectionPreviewGroup;
  }

  constructor(
    private _scene: THREE.Scene,
    private _controls: OrbitControls,
  ) {
    // 단면 프리뷰 그룹
    this._sectionPreviewGroup.name = "section-preview";
    this._scene.add(this._sectionPreviewGroup);
  }

  // --- STEP 모델 관리 ---

  addStepModel(model: StepModelData, perspCamera: THREE.PerspectiveCamera): THREE.Group {
    const group = createStepModelGroup(model);

    // bounding box 계산 후 XZ 중심은 원점, Y 바닥은 0으로 이동
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const offset = new THREE.Vector3(-center.x, -box.min.y, -center.z);
    group.position.copy(offset);

    this._scene.add(group);
    this._stepModelGroups.set(model.id, group);
    this._modelOffsets.set(model.id, offset);

    // sketch 모드 등으로 현재 STEP mesh 가 반투명 상태라면 새 group 도 같은 opacity 로 적용.
    // (기본 material 은 transparent:false, opacity:1 이라 sketch 모드 중 import 시 새 model 만 불투명으로 보이는 문제 방지)
    if (this._transparentState.transparent) {
      this._applyTransparencyToGroup(group, true, this._transparentState.opacity);
    }

    // 카메라를 모델 크기에 맞게 조정
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 2;
    perspCamera.position.set(dist * 0.6, dist * 0.5, dist * 0.6);
    perspCamera.near = maxDim * 0.01;
    perspCamera.far = maxDim * 100;
    perspCamera.updateProjectionMatrix();
    this._controls.target.set(0, 0, 0);
    this._controls.update();

    // BRep edge 기반 정확 wireframe 으로 EdgesGeometry 대체 (비동기, fire-and-forget).
    // 모델 즉시 표시 + 잠시 후 곡선 부분이 부드러워짐 (원/타원이 polygon 으로 보이던 문제 해결).
    if (model.nativeShapeHandle != null) {
      void this._enhanceWireframe(model);
    }

    this._notifyChange();
    return group;
  }

  /**
   * EdgesGeometry (mesh tessellation 기반 — 곡선이 polygon 으로 보임) 를 BRep edge 기반 wireframe
   * 으로 교체. body 별 sub-Group 으로 분리해 setBodyVisible 가 mesh 와 함께 wireframe 도 토글
   * 가능하게. 실패해도 기존 wireframe 유지 (fail-safe).
   */
  private async _enhanceWireframe(model: StepModelData): Promise<void> {
    const handle = model.nativeShapeHandle;
    if (handle == null) return;
    const bodyCount = model.bodies.length;
    if (bodyCount === 0) return;

    // body 별로 native 호출 — 다른 모든 solid 를 excluded 로 → 그 body 의 edge 만 받음.
    // (call N 번이지만 body 수는 보통 한 자릿수. multi-body 가 큰 어셈블리면 후속 최적화.)
    const bodyEdges: { bodyIndex: number; edges: Awaited<ReturnType<typeof extractBRepEdgesNative>> }[] = [];
    for (let i = 0; i < bodyCount; i++) {
      const excluded = Array.from({ length: bodyCount }, (_, k) => k).filter((k) => k !== i);
      try {
        const edges = await extractBRepEdgesNative(handle, excluded);
        bodyEdges.push({ bodyIndex: i, edges });
      } catch (err) {
        console.error("[ModelManager] BRep edge extraction failed for body", i, err);
      }
    }

    const group = this._stepModelGroups.get(model.id);
    if (!group) return; // 모델이 그 사이 제거됐으면 skip

    // 이전 BRep wireframe 이 있으면 (재호출) 제거
    const prev = group.children.find((c) => c.name === "brep-wireframe");
    if (prev) {
      group.remove(prev);
      disposeBRepWireframe(prev as THREE.Group);
    }

    // body 별 sub-Group 으로 wireframe 구성. setBodyVisible 가 userData.bodyIndex 매칭으로 토글.
    const wireframeRoot = new THREE.Group();
    wireframeRoot.name = "brep-wireframe";
    const meshes = group.children.filter((c) => c instanceof THREE.Mesh) as THREE.Mesh[];
    for (const { bodyIndex, edges } of bodyEdges) {
      const bodyWireframe = createBRepWireframe(edges);
      bodyWireframe.name = `brep-wireframe-body-${bodyIndex}`;
      bodyWireframe.userData.bodyIndex = bodyIndex;
      const mesh = meshes[bodyIndex];

      // 위치 검증 — assembly nested location 이 native edge_extractor 에서 누락되는 케이스 (cpp
      // 의 BRepAdaptor 가 누적 location 못 받는 경우) 가 있어 wireframe 가 mesh 와 다른 위치에
      // 그려질 수 있음. mesh bbox center 와 wireframe bbox center 거리가 mesh 크기에 비해 크면
      // 잘못된 좌표로 판정 → wireframe hide, EdgesGeometry fallback 살림.
      let wireValid = true;
      if (mesh) {
        const meshBox = new THREE.Box3().setFromObject(mesh);
        const wireBox = new THREE.Box3().setFromObject(bodyWireframe);
        if (!wireBox.isEmpty() && !meshBox.isEmpty()) {
          const meshCenter = meshBox.getCenter(new THREE.Vector3());
          const wireCenter = wireBox.getCenter(new THREE.Vector3());
          const meshSize = meshBox.getSize(new THREE.Vector3()).length();
          // center 거리 > mesh size 절반 → 별개 위치
          if (meshSize > 1e-6 && meshCenter.distanceTo(wireCenter) > meshSize * 0.5) {
            wireValid = false;
            console.error(
              `[ModelManager] BRep wireframe of body ${bodyIndex} mismatched mesh position — falling back to EdgesGeometry.`,
            );
          }
        }
      }

      // _enhanceWireframe await 도중 사용자가 hide 했을 수 있음 — mesh.visible 따름.
      bodyWireframe.visible = wireValid && (mesh?.visible ?? true);
      wireframeRoot.add(bodyWireframe);

      // wireframe 검증 통과: EdgesGeometry LineSegments hide (BRep 만 보임).
      // 실패: EdgesGeometry 유지 (polygon 이지만 정확 위치).
      if (wireValid && mesh) {
        const bodyName = mesh.name.replace(/^mesh-/, "");
        const edgesLine = group.children.find((c) => c.name === `edges-${bodyName}`);
        if (edgesLine) edgesLine.visible = false;
      }
    }
    group.add(wireframeRoot);

    // wireframe 추가 시 edge/vertex cache 가 stale — invalidate 해서 다음 hit test 가 재계산하도록.
    invalidateEdgeCacheForGroup(group);
    this._notifyChange();
  }

  removeStepModel(modelId: string): void {
    const group = this._stepModelGroups.get(modelId);
    if (!group) return;
    this._scene.remove(group);
    disposeObject3D(group);
    this._stepModelGroups.delete(modelId);
    this._modelOffsets.delete(modelId);
    this._notifyChange();
  }

  getStepModelGroup(modelId: string): THREE.Group | null {
    return this._stepModelGroups.get(modelId) ?? null;
  }

  getStepModelIds(): string[] {
    return [...this._stepModelGroups.keys()];
  }

  // --- STEP 모델 투명도/메시 가시성 ---

  setStepModelsTransparent(transparent: boolean, opacity = 0.15): void {
    this._transparentState = { transparent, opacity };
    for (const group of this._stepModelGroups.values()) {
      this._applyTransparencyToGroup(group, transparent, opacity);
    }
    this._notifyChange();
  }

  private _applyTransparencyToGroup(group: THREE.Group, transparent: boolean, opacity: number): void {
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of materials) {
        mat.transparent = transparent;
        mat.opacity = transparent ? opacity : 1.0;
        mat.depthWrite = !transparent;
        mat.needsUpdate = true;
      }
    });
  }

  setModelVisible(modelId: string, visible: boolean): void {
    const group = this._stepModelGroups.get(modelId);
    if (!group) return;
    group.visible = visible;
    this._notifyChange();
  }

  setBodyVisible(modelId: string, bodyIndex: number, visible: boolean): void {
    const group = this._stepModelGroups.get(modelId);
    if (!group) return;
    const meshes = group.children.filter((c) => c instanceof THREE.Mesh);
    if (bodyIndex < 0 || bodyIndex >= meshes.length) return;

    const mesh = meshes[bodyIndex];
    mesh.visible = visible;

    // BRep wireframe sub-Group (body 별 분리됨) — userData.bodyIndex 매칭으로 토글.
    const wireframe = group.children.find((c) => c.name === "brep-wireframe");
    if (wireframe instanceof THREE.Group) {
      const bodySub = wireframe.children.find((c) => c.userData.bodyIndex === bodyIndex);
      if (bodySub) bodySub.visible = visible;
    }

    // EdgesGeometry fallback LineSegments — native 추출 실패 시 남아있을 수 있음.
    // StepModelManager 가 `edges-${bodyData.name}` 으로 명명, mesh 이름은 `mesh-${bodyData.name}`.
    const bodyName = mesh.name.replace(/^mesh-/, "");
    const edgesLine = group.children.find((c) => c.name === `edges-${bodyName}`);
    if (edgesLine) edgesLine.visible = visible;
    this._notifyChange();
  }

  highlightBody(modelId: string, bodyIndex: number | null): void {
    const group = this._stepModelGroups.get(modelId);
    if (!group) return;
    const meshes = group.children.filter((c) => c instanceof THREE.Mesh);
    for (let i = 0; i < meshes.length; i++) {
      // 선택된 body의 emissive는 건드리지 않음
      if (this._isBodySelected(modelId, i)) continue;

      const mesh = meshes[i] as THREE.Mesh;
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const mat of materials) {
        if ("emissive" in mat) {
          (mat as THREE.MeshStandardMaterial).emissive.setHex(
            i === bodyIndex ? 0x335566 : 0x000000,
          );
        }
      }
    }
    this._notifyChange();
  }

  /** 모델 전체 body 하이라이트 (SpecTree 파일명 hover 시) */
  highlightModel(modelId: string, highlight: boolean): void {
    const group = this._stepModelGroups.get(modelId);
    if (!group) return;
    const meshes = group.children.filter((c) => c instanceof THREE.Mesh);
    for (let i = 0; i < meshes.length; i++) {
      if (this._isBodySelected(modelId, i)) continue;
      const mesh = meshes[i] as THREE.Mesh;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if ("emissive" in mat) {
          (mat as THREE.MeshStandardMaterial).emissive.setHex(highlight ? 0x335566 : 0x000000);
        }
      }
    }
    this._notifyChange();
  }

  // body name 조회 (mesh 인덱스 기준)
  private _getBodyBaseName(group: THREE.Group, bodyIndex: number): string | null {
    const meshes = group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    const mesh = meshes[bodyIndex];
    return mesh ? mesh.name.replace("mesh-", "") : null;
  }

  // body 개별 transform 적용 (linkage 시뮬레이션용)
  setBodyTransform(modelId: string, bodyIndex: number, matrix: THREE.Matrix4): void {
    const group = this._stepModelGroups.get(modelId);
    if (!group) return;
    const baseName = this._getBodyBaseName(group, bodyIndex);
    if (!baseName) return;

    for (const child of group.children) {
      if (child.name === `mesh-${baseName}` || child.name === `edges-${baseName}`) {
        child.matrixAutoUpdate = false;
        child.matrix.copy(matrix);
        child.matrixWorldNeedsUpdate = true;
      }
    }
    this._notifyChange();
  }

  // body transform 초기화 (시뮬레이션 종료 시)
  resetBodyTransform(modelId: string, bodyIndex: number): void {
    const group = this._stepModelGroups.get(modelId);
    if (!group) return;
    const baseName = this._getBodyBaseName(group, bodyIndex);
    if (!baseName) return;

    for (const child of group.children) {
      if (child.name === `mesh-${baseName}` || child.name === `edges-${baseName}`) {
        child.matrixAutoUpdate = true;
        child.position.set(0, 0, 0);
        child.rotation.set(0, 0, 0);
        child.scale.set(1, 1, 1);
        child.matrixWorldNeedsUpdate = true;
      }
    }
    this._notifyChange();
  }

  resetAllBodyTransforms(): void {
    for (const [modelId, group] of this._stepModelGroups) {
      const meshes = group.children.filter((c) => c instanceof THREE.Mesh);
      for (let i = 0; i < meshes.length; i++) {
        this.resetBodyTransform(modelId, i);
      }
    }
  }

  // 3D 모드 body 레이캐스팅 (SpecTree element 단위)
  pickBody(
    mouseNDC: THREE.Vector2,
    raycaster: THREE.Raycaster,
    activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  ): { modelId: string; bodyIndex: number } | null {
    raycaster.setFromCamera(mouseNDC, activeCamera);

    // 몸체 메시만 — group 에 붙는 꼭짓점 hover/선택 구슬(Mesh)은 빼고, 겹친 모델 중 가장 가까운 교차를 고른다
    const front = this._pickFrontStepModel(raycaster);
    return front ? { modelId: front.modelId, bodyIndex: front.hit.object.userData.bodyIndex } : null;
  }

  // 측정용 — 클릭 지점의 월드 좌표 + 면 법선을 포함한 raycast
  pickPointOnMesh(
    mouseNDC: THREE.Vector2,
    raycaster: THREE.Raycaster,
    activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    extrudedSolids: Map<string, THREE.Mesh | THREE.Group>,
  ): {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    modelId?: string;
    bodyIndex?: number;
    faceIndex?: number;
    mesh?: THREE.Mesh;
  } | null {
    raycaster.setFromCamera(mouseNDC, activeCamera);

    // STEP 모델 검사
    const allMeshes: THREE.Mesh[] = [];
    const meshModelMap = new Map<
      THREE.Mesh,
      { modelId: string; bodyIndex: number }
    >();

    for (const [modelId, group] of this._stepModelGroups) {
      if (!group.visible) continue;
      const meshes = group.children.filter(
        (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.visible,
      );
      for (let i = 0; i < meshes.length; i++) {
        allMeshes.push(meshes[i]);
        meshModelMap.set(meshes[i], { modelId, bodyIndex: i });
      }
    }

    // 돌출 솔리드 검사
    for (const [, mesh] of extrudedSolids) {
      if (mesh instanceof THREE.Group) {
        const children = mesh.children.filter(
          (c): c is THREE.Mesh => c instanceof THREE.Mesh,
        );
        allMeshes.push(...children);
      } else {
        allMeshes.push(mesh);
      }
    }

    const intersects = raycaster.intersectObjects(allMeshes, false);
    if (intersects.length === 0) return null;

    const hit = intersects[0];
    const normal = hit.face
      ? hit.face.normal
          .clone()
          .transformDirection(hit.object.matrixWorld)
          .normalize()
      : new THREE.Vector3(0, 1, 0);
    const info = meshModelMap.get(hit.object as THREE.Mesh);

    return {
      point: hit.point.clone(),
      normal,
      modelId: info?.modelId,
      bodyIndex: info?.bodyIndex,
      faceIndex: hit.faceIndex ?? undefined,
      mesh: hit.object as THREE.Mesh,
    };
  }

  /** hit 지점 주변 vertex들로 근사 곡률 반지름 계산 */
  estimateRadiusAtHit(
    mesh: THREE.Mesh,
    faceIndex: number,
    hitPoint: THREE.Vector3,
  ): number | null {
    const geometry = mesh.geometry;
    const posAttr = geometry.getAttribute("position");
    const indexAttr = geometry.index;
    if (!posAttr || !indexAttr) return null;

    // hit된 삼각형의 vertex 인덱스
    const i0 = indexAttr.getX(faceIndex * 3);
    const i1 = indexAttr.getX(faceIndex * 3 + 1);
    const i2 = indexAttr.getX(faceIndex * 3 + 2);

    // 1-ring 이웃 vertex 수집 (hit 삼각형 vertex를 공유하는 삼각형만)
    const seedVertices = new Set([i0, i1, i2]);
    const vertexSet = new Set(seedVertices);
    const triCount = indexAttr.count / 3;
    const MAX_TRI_SCAN = 50000; // 대형 메시 성능 보호
    const scanCount = Math.min(triCount, MAX_TRI_SCAN);
    for (let t = 0; t < scanCount; t++) {
      const a = indexAttr.getX(t * 3);
      const b = indexAttr.getX(t * 3 + 1);
      const c = indexAttr.getX(t * 3 + 2);
      if (seedVertices.has(a) || seedVertices.has(b) || seedVertices.has(c)) {
        vertexSet.add(a);
        vertexSet.add(b);
        vertexSet.add(c);
      }
    }

    // world 좌표로 변환
    const points: THREE.Vector3[] = [];
    const mat = mesh.matrixWorld;
    for (const vi of vertexSet) {
      const v = new THREE.Vector3(
        posAttr.getX(vi),
        posAttr.getY(vi),
        posAttr.getZ(vi),
      ).applyMatrix4(mat);
      points.push(v);
    }

    if (points.length < 4) return null;

    // 3점 원 피팅: 가장 가까운 3개 점으로 circumradius 계산
    const sorted = [...points].sort(
      (a, b) => a.distanceTo(hitPoint) - b.distanceTo(hitPoint),
    );
    const p1 = sorted[0];
    const p2 = sorted[1];
    const p3 = sorted[2];
    const sideA = p1.distanceTo(p2);
    const sideB = p2.distanceTo(p3);
    const sideC = p3.distanceTo(p1);
    const s = (sideA + sideB + sideC) / 2;
    const area = Math.sqrt(
      Math.max(0, s * (s - sideA) * (s - sideB) * (s - sideC)),
    );
    if (area > 1e-10) {
      const radius = (sideA * sideB * sideC) / (4 * area);
      if (radius > 0.1 && radius < 10000) {
        return Math.round(radius * 1000) / 1000;
      }
    }

    // fallback: 평균 거리
    const distances = points
      .map((p) => p.distanceTo(hitPoint))
      .sort((a, b) => a - b);
    const useCount = Math.max(3, Math.floor(distances.length * 0.6));
    const nearDistances = distances.slice(0, useCount);
    const avg =
      nearDistances.reduce((sum, d) => sum + d, 0) / nearDistances.length;
    return avg > 0.1 ? Math.round(avg * 1000) / 1000 : null;
  }

  // 3D body hover 하이라이트 (emissive 색상 변경)
  /** body가 다중 선택 목록에 포함되어 있는지 */
  private _isBodySelected(modelId: string, bodyIndex: number): boolean {
    return this._selectedBodies.some(
      (b) => b.modelId === modelId && b.bodyIndex === bodyIndex,
    );
  }

  hoverBody(modelId: string | null, bodyIndex: number | null): void {
    // 이전 hover 해제 — 선택된 body는 emissive 유지
    if (this._hoveredBody) {
      const { modelId: prevId, bodyIndex: prevIdx } = this._hoveredBody;
      if (!this._isBodySelected(prevId, prevIdx)) {
        this._setBodyEmissive(prevId, prevIdx, 0x000000);
      }
    }

    if (modelId !== null && bodyIndex !== null) {
      this._hoveredBody = { modelId, bodyIndex };
      if (!this._isBodySelected(modelId, bodyIndex)) {
        this._setBodyEmissive(modelId, bodyIndex, COLOR_HOVERED_EMISSIVE);
      }
      this.onBodyHoverChanged?.(modelId, bodyIndex);
    } else {
      this._hoveredBody = null;
      this.onBodyHoverChanged?.(null, null);
    }
  }

  // 3D body 선택
  selectBody(modelId: string, bodyIndex: number): void {
    // 이전 선택 해제
    this.deselectBody();

    // hover 클리어
    if (this._hoveredBody) {
      this._setBodyEmissive(
        this._hoveredBody.modelId,
        this._hoveredBody.bodyIndex,
        0x000000,
      );
      this._hoveredBody = null;
      this.onBodyHoverChanged?.(null, null);
    }

    this._selectedBody = { modelId, bodyIndex };
    this._selectedBodies = [{ modelId, bodyIndex }];
    this._setBodyEmissive(modelId, bodyIndex, COLOR_SELECTED_EMISSIVE);
    this.onBodySelectChanged?.(modelId, bodyIndex);
  }

  // 선택 해제
  deselectBody(): void {
    const hadSelection = this._selectedBody !== null || this._selectedBodies.length > 0;

    if (this._selectedBody) {
      this._setBodyEmissive(
        this._selectedBody.modelId,
        this._selectedBody.bodyIndex,
        0x000000,
      );
      this._selectedBody = null;
    }
    // 다중 선택 해제
    for (const b of this._selectedBodies) {
      this._setBodyEmissive(b.modelId, b.bodyIndex, 0x000000);
    }
    this._selectedBodies = [];

    // 모든 상태 클리어 후 콜백 (selectedBodies가 빈 상태에서 호출)
    if (hadSelection) {
      this.onBodySelectChanged?.(null, null);
    }
    this._notifyChange();
  }

  /** Ctrl+클릭: 다중 선택 토글 */
  toggleBodySelection(modelId: string, bodyIndex: number): void {
    const idx = this._selectedBodies.findIndex(
      (b) => b.modelId === modelId && b.bodyIndex === bodyIndex,
    );
    if (idx >= 0) {
      // 이미 선택됨 → 해제
      this._setBodyEmissive(modelId, bodyIndex, 0x000000);
      this._selectedBodies.splice(idx, 1);
    } else {
      // 추가 선택
      this._selectedBodies.push({ modelId, bodyIndex });
      this._setBodyEmissive(modelId, bodyIndex, COLOR_SELECTED_EMISSIVE);
    }
    // 단일 선택 호환: 첫 번째 선택을 _selectedBody로 유지
    if (this._selectedBodies.length > 0) {
      this._selectedBody = this._selectedBodies[0];
      this.onBodySelectChanged?.(this._selectedBody.modelId, this._selectedBody.bodyIndex);
    } else {
      this._selectedBody = null;
      this.onBodySelectChanged?.(null, null);
    }
    this._notifyChange();
  }

  /** 현재 다중 선택된 body 목록 */
  get selectedBodies(): { modelId: string; bodyIndex: number }[] {
    return this._selectedBodies;
  }

  // 현재 선택된 바디 정보
  getSelectedBody(): { modelId: string; bodyIndex: number } | null {
    return this._selectedBody;
  }

  private _setBodyEmissive(
    modelId: string,
    bodyIndex: number,
    hex: number,
  ): void {
    const group = this._stepModelGroups.get(modelId);
    if (!group) return;
    const meshes = group.children.filter(
      (c): c is THREE.Mesh => c instanceof THREE.Mesh,
    );
    if (bodyIndex < 0 || bodyIndex >= meshes.length) return;

    const mesh = meshes[bodyIndex];
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    for (const mat of materials) {
      if ("emissive" in mat) {
        (mat as THREE.MeshStandardMaterial).emissive.setHex(hex);
      }
    }
  }

  // face 하이라이트
  highlightFace(modelId: string, faceGroupId: number | null): void {
    const group = this._stepModelGroups.get(modelId);
    if (!group) return;
    highlightFaceMesh(group, faceGroupId);
    // highlightFaceMesh 는 mesh 내 모든 face material 의 emissive 를 일괄 reset → selected
    // body 의 emissive 가 함께 지워짐. selected body emissive 재적용.
    for (const sel of this._selectedBodies) {
      if (sel.modelId !== modelId) continue;
      this._setBodyEmissive(sel.modelId, sel.bodyIndex, COLOR_SELECTED_EMISSIVE);
    }
    if (this._hoveredBody && this._hoveredBody.modelId === modelId) {
      const { modelId: hid, bodyIndex: hidx } = this._hoveredBody;
      if (!this._isBodySelected(hid, hidx)) {
        this._setBodyEmissive(hid, hidx, COLOR_HOVERED_EMISSIVE);
      }
    }
    this._notifyChange();
  }

  /**
   * 광선이 가장 먼저 닿는 보이는 STEP 몸체와 그 모델. STEP 모델은 모두 XZ 중심·바닥 y=0 으로 옮겨 서로 겹치므로,
   * 모델을 추가 순서로 돌며 처음 맞힌 모델을 고르면 앞의 모델 대신 광선이 지나간 뒤쪽 모델이 잡혔다.
   * 모든 모델의 보이는 몸체 메시를 한 번에 레이캐스트해 가장 가까운 교차를 고른다 (숨긴 모델·몸체·구슬 제외).
   */
  private _pickFrontStepModel(
    raycaster: THREE.Raycaster,
  ): { modelId: string; group: THREE.Group; hit: THREE.Intersection } | null {
    const meshes: THREE.Mesh[] = [];
    for (const group of this._stepModelGroups.values()) meshes.push(...getVisibleBodyMeshes(group));
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const modelId: string = hit.object.userData.stepModelId;
    const group = this._stepModelGroups.get(modelId);
    return group ? { modelId, group, hit } : null;
  }

  // STEP 모델 face 레이캐스팅
  pickStepFace(
    mouseNDC: THREE.Vector2,
    raycaster: THREE.Raycaster,
    activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  ): { modelId: string; faceGroupId: number; point: THREE.Vector3 } | null {
    raycaster.setFromCamera(mouseNDC, activeCamera);

    // 앞 모델을 고른 교차를 그대로 넘긴다 — 같은 광선으로 그 모델을 다시 레이캐스트하지 않는다
    const front = this._pickFrontStepModel(raycaster);
    return front ? { modelId: front.modelId, ...pickFace(front.hit) } : null;
  }

  // STEP 모델 edge 피킹 (screen-space distance)
  pickStepEdge(
    mouseNDC: THREE.Vector2,
    mouseScreen: THREE.Vector2,
    raycaster: THREE.Raycaster,
    camera: THREE.Camera,
    screenWidth: number,
    screenHeight: number,
  ): { modelId: string; bodyIndex: number; edgeIndex: number; point: THREE.Vector3 } | null {
    raycaster.setFromCamera(mouseNDC, camera);
    const front = this._pickFrontStepModel(raycaster);
    if (!front) return null;
    const result = pickEdge(front.hit, front.group, camera, screenWidth, screenHeight, mouseScreen);
    return result ? { modelId: front.modelId, ...result } : null;
  }

  // STEP 모델 vertex 피킹 (screen-space distance)
  pickStepVertex(
    mouseNDC: THREE.Vector2,
    mouseScreen: THREE.Vector2,
    raycaster: THREE.Raycaster,
    camera: THREE.Camera,
    screenWidth: number,
    screenHeight: number,
  ): { modelId: string; bodyIndex: number; vertexIndex: number; point: THREE.Vector3 } | null {
    raycaster.setFromCamera(mouseNDC, camera);
    const front = this._pickFrontStepModel(raycaster);
    if (!front) return null;
    const result = pickVertex(front.hit, front.group, camera, screenWidth, screenHeight, mouseScreen);
    return result ? { modelId: front.modelId, ...result } : null;
  }

  // 통합 entity picker — filter 게이팅 + depth 계산까지 매니저 책임.
  // depth 는 rayDepth() 사용 — raycaster hit.distance 와 동등한 척도라 across-picker 정렬 일관.
  // CATIA 와 동일: face / volume 은 별도 필터. face 모드에서 volume 발행 X.
  pickEntities(ndc: THREE.Vector2, filter: SelectionFilterMode, ctx: PickCtx): PickEntity[] {
    const out: PickEntity[] = [];

    if (filter === "all" || filter === "vertex") {
      const v = this.pickStepVertex(ndc, ctx.mouseScreen, ctx.raycaster, ctx.camera, ctx.screenWidth, ctx.screenHeight);
      if (v) {
        out.push({
          source: "step", kind: "vertex",
          modelId: v.modelId, bodyIndex: v.bodyIndex, vertexIndex: v.vertexIndex,
          worldPos: v.point.clone(),
          depth: rayDepth(v.point, ctx),
        });
      }
    }

    if (filter === "all" || filter === "edge") {
      const e = this.pickStepEdge(ndc, ctx.mouseScreen, ctx.raycaster, ctx.camera, ctx.screenWidth, ctx.screenHeight);
      if (e) {
        out.push({
          source: "step", kind: "edge",
          modelId: e.modelId, bodyIndex: e.bodyIndex, edgeIndex: e.edgeIndex,
          worldPos: e.point.clone(),
          depth: rayDepth(e.point, ctx),
        });
      }
    }

    if (filter === "all" || filter === "face") {
      const f = this.pickStepFace(ndc, ctx.raycaster, ctx.camera);
      if (f) {
        out.push({
          source: "step", kind: "face",
          modelId: f.modelId, faceGroupId: f.faceGroupId,
          worldPos: f.point.clone(),
          depth: rayDepth(f.point, ctx),
        });
      }
    }

    if (filter === "all" || filter === "volume") {
      // volume picking 은 mesh body 단위 raycast. pickBody 는 worldPos 미반환 →
      // pickStepFace 를 보조로 호출해 face hit 의 point 로 worldPos/depth 채움.
      // face hit 이 미식별이면 depth Infinity (정렬 후순위).
      const b = this.pickBody(ndc, ctx.raycaster, ctx.camera);
      if (b) {
        const f = this.pickStepFace(ndc, ctx.raycaster, ctx.camera);
        const worldPos = f?.point.clone() ?? new THREE.Vector3();
        const depth = f ? rayDepth(f.point, ctx) : Number.POSITIVE_INFINITY;
        out.push({
          source: "step", kind: "volume",
          modelId: b.modelId, bodyIndex: b.bodyIndex,
          worldPos, depth,
        });
      }
    }

    return out;
  }

  // Edge/vertex highlight
  highlightEdge(modelId: string, bodyIndex: number, edgeIndex: number | null): void {
    // 다른 모델의 highlight 해제
    for (const [mid, group] of this._stepModelGroups) {
      if (mid !== modelId || edgeIndex === null) highlightEdgeMesh(group, 0, null);
    }
    if (edgeIndex !== null) {
      const group = this._stepModelGroups.get(modelId);
      if (group) highlightEdgeMesh(group, bodyIndex, edgeIndex);
    }
    this._notifyChange();
  }

  highlightVertex(modelId: string, bodyIndex: number, vertexIndex: number | null): void {
    for (const [mid, group] of this._stepModelGroups) {
      if (mid !== modelId || vertexIndex === null) highlightVertexMesh(group, 0, null);
    }
    if (vertexIndex !== null) {
      const group = this._stepModelGroups.get(modelId);
      if (group) highlightVertexMesh(group, bodyIndex, vertexIndex);
    }
    this._notifyChange();
  }

  clearEdgeHighlight(): void {
    for (const group of this._stepModelGroups.values()) highlightEdgeMesh(group, 0, null);
    this._notifyChange();
  }

  clearVertexHighlight(): void {
    for (const group of this._stepModelGroups.values()) highlightVertexMesh(group, 0, null);
    this._notifyChange();
  }

  selectEdge(modelId: string, bodyIndex: number, edgeIndex: number | null): void {
    for (const [mid, group] of this._stepModelGroups) {
      if (mid !== modelId || edgeIndex === null) selectEdgeMesh(group, 0, null);
    }
    if (edgeIndex !== null) {
      const group = this._stepModelGroups.get(modelId);
      if (group) selectEdgeMesh(group, bodyIndex, edgeIndex);
    }
    this._notifyChange();
  }

  selectVertex(modelId: string, bodyIndex: number, vertexIndex: number | null): void {
    for (const [mid, group] of this._stepModelGroups) {
      if (mid !== modelId || vertexIndex === null) selectVertexMesh(group, 0, null);
    }
    if (vertexIndex !== null) {
      const group = this._stepModelGroups.get(modelId);
      if (group) selectVertexMesh(group, bodyIndex, vertexIndex);
    }
    this._notifyChange();
  }

  /** Edge의 양 끝점을 world 좌표로 반환 (StepModelManager.getEdges 패턴 사용) */
  getEdgeEndpoints(
    modelId: string,
    bodyIndex: number,
    edgeIndex: number,
  ): { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } } | null {
    const group = this._stepModelGroups.get(modelId);
    if (!group) return null;

    // body mesh 수집 (이 파일의 다른 메서드와 동일한 children.filter 패턴)
    const meshes = group.children.filter(
      (c): c is THREE.Mesh => c instanceof THREE.Mesh,
    );
    if (bodyIndex >= meshes.length) return null;

    const mesh = meshes[bodyIndex];
    const edges = this._getEdgesFromMesh(mesh);
    if (edgeIndex >= edges.length) return null;

    const localEdge = edges[edgeIndex];
    // 로컬 좌표 → 현재 matrixWorld로 world 좌표 변환
    const mat = mesh.matrixWorld;
    const start = localEdge.start.clone().applyMatrix4(mat);
    const end = localEdge.end.clone().applyMatrix4(mat);
    return {
      start: { x: start.x, y: start.y, z: start.z },
      end: { x: end.x, y: end.y, z: end.z },
    };
  }

  /** EdgesGeometry 기반 edge 추출 (로컬 좌표 캐시, 호출 측에서 matrixWorld 적용) */
  private static _edgeCache = new WeakMap<THREE.BufferGeometry, { start: THREE.Vector3; end: THREE.Vector3 }[]>();
  private _getEdgesFromMesh(mesh: THREE.Mesh): { start: THREE.Vector3; end: THREE.Vector3 }[] {
    const geom = mesh.geometry;
    if (ModelManager._edgeCache.has(geom)) return ModelManager._edgeCache.get(geom)!;

    const edgesGeom = new THREE.EdgesGeometry(geom, 30);
    const pos = edgesGeom.getAttribute("position");
    const edges: { start: THREE.Vector3; end: THREE.Vector3 }[] = [];

    for (let i = 0; i < pos.count; i += 2) {
      const s = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      const e = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
      edges.push({ start: s, end: e });
    }

    edgesGeom.dispose();
    ModelManager._edgeCache.set(geom, edges);
    return edges;
  }

  clearEdgeSelection(): void {
    for (const group of this._stepModelGroups.values()) selectEdgeMesh(group, 0, null);
    this._notifyChange();
  }

  clearVertexSelection(): void {
    for (const group of this._stepModelGroups.values()) selectVertexMesh(group, 0, null);
    this._notifyChange();
  }

  // 모델 오프셋 조회
  getModelOffset(modelId: string): THREE.Vector3 {
    return this._modelOffsets.get(modelId) ?? new THREE.Vector3();
  }

  // 단면 프리뷰 라인 표시
  showSectionPreview(
    polylines: Vec3[][],
    modelId?: string,
    color = 0x00aaff,
  ): void {
    disposeGroupChildren(this._sectionPreviewGroup);

    const offset = modelId ? this.getModelOffset(modelId) : new THREE.Vector3();

    for (const polyline of polylines) {
      if (polyline.length < 2) continue;
      const points = polyline.map(
        (p) =>
          new THREE.Vector3(p.x + offset.x, p.y + offset.y, p.z + offset.z),
      );
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color, linewidth: 2 });
      const line = new THREE.Line(geometry, material);
      this._sectionPreviewGroup.add(line);
    }
    this._notifyChange();
  }

  hideSectionPreview(): void {
    disposeGroupChildren(this._sectionPreviewGroup);
    this._notifyChange();
  }

  /** 파일 전환 시 모든 모델 제거 (인스턴스 재사용) */
  clearAll(): void {
    for (const group of this._stepModelGroups.values()) {
      this._scene.remove(group);
      disposeObject3D(group);
    }
    this._stepModelGroups.clear();
    disposeGroupChildren(this._sectionPreviewGroup);
  }

  dispose(): void {
    this.clearAll();
  }
}

// CSG/돌출(Pad/Pocket, Revolve) + 솔리드 관리

import * as THREE from "three";
import { Brush, Evaluator, ADDITION, SUBTRACTION } from "three-bvh-csg";

import type { OcctFeatureTree } from "../core/OcctFeatureTree";
import type {
  OperationTreeEntry,
  PadPocketDirection,
  PadPocketOperation,
  RevolveDirection,
  RevolveOperation,
  SelectionFilterMode,
  SerializedGeometry,
  SerializedSketch,
} from "../Setup.type";
import type { SketchConstraint } from "../sketch/constraints/SketchConstraint.type";
import { detectClosedShapes } from "../sketch/shapeDetector";
import {
  buildPrismNative,
  buildRevolutionNative,
  performBooleanNative,
} from "../step/BooleanNative";
import type { NativeMeshResult } from "../step/BooleanNative";
import type { OcctTopologyPicker } from "../step/OcctTopologyPicker";
import { extractExtrudableShapes } from "../utils/profileToShape";



import { disposeObject3D } from "./disposeUtils";
import type { EntityPicker, PickCtx, PickEntity } from "./picking/EntityPicker";

// 솔리드 공통 — CATIA / Fusion 식 시각: 불투명 회색.
const SOLID_COLOR = 0x8899aa;
// Hover / select emissive overlay (CATIA 의 yellow-ish pre-select).
const HOVER_EMISSIVE = 0xfff5b8;
const SELECT_EMISSIVE = 0xfffaa3;
const HOVER_INTENSITY = 0.25;
const SELECT_INTENSITY = 0.45;

const createSolidMaterial = (): THREE.MeshStandardMaterial => {
  return new THREE.MeshStandardMaterial({
    color: SOLID_COLOR,
    metalness: 0.3,
    roughness: 0.6,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthWrite: true,
  });
};

/**
 * Native mesh result → THREE.Mesh. 단순 opaque mesh + BRep face boundary edge (LineSegments).
 */
function nativeMeshToThreeMesh(mesh: NativeMeshResult["mesh"]): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.normals, 3));
  geometry.setIndex(mesh.indices);
  geometry.computeBoundingSphere();
  const threeMesh = new THREE.Mesh(geometry, createSolidMaterial());
  // CATIA 식 — 모든 solid 의 BRep face boundary edge 표시 (LineSegments).
  // EdgesGeometry thresholdAngle 1° default — sharp edge (face boundary) 만 추출.
  const edgesGeom = new THREE.EdgesGeometry(geometry);
  const edgesMat = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
  const edges = new THREE.LineSegments(edgesGeom, edgesMat);
  threeMesh.add(edges);
  return threeMesh;
}

// shape handle storage per operation (native B-Rep chain)
const operationShapeHandles = new Map<string, number>();

/** Result 페이지 Export CAD — 가장 최근 (마지막에 set 된) operation 의 OCCT shape
 *  handle 반환. boolean fuse 누적이라 보통 mechanism 전체 geometry. 없으면 null. */
export function getLatestOperationShapeHandle(): number | null {
  if (operationShapeHandles.size === 0) return null;
  let last: number | null = null;
  for (const h of operationShapeHandles.values()) last = h;
  return last;
}

export class SolidOperationManager implements EntityPicker {
  readonly source = "feature" as const;

  // 돌출 솔리드 (Pad/Pocket 결과)
  private _extrudedSolids: Map<string, THREE.Mesh | THREE.Group> = new Map();
  // 돌출 프리뷰 (생성 중 라이브 표시)
  private _extrudePreview: THREE.Mesh | null = null;
  // 3D viewport hover / select 시 emissive overlay (atom SSOT — input/index.tsx 의 useEffect
  // 가 viewportHover / viewportSelection 변경마다 setSolidHovered / setSolidSelected 호출).
  private _hoveredOpId: string | null = null;
  private _selectedOpId: string | null = null;
  /** Phase 4 — scene mutation 시 호출. */
  onSceneChanged: (() => void) | null = null;
  /** solid label sprite 가 매 frame 참조하는 wpp provider. SetupScene 가 SceneManager
   *  .computeActiveWpp 로 inject — marker label 과 동일 wpp 소스 보장. */
  private _wppProvider: () => number = () => 1;
  setWppProvider(fn: () => number): void {
    this._wppProvider = fn;
  }

  private _notifyChange(): void {
    this.onSceneChanged?.();
  }

  get extrudedSolids(): Map<string, THREE.Mesh | THREE.Group> {
    return this._extrudedSolids;
  }

  // OCCT feature tree (Phase 6 — null이면 기존 BooleanNative fallback)
  private _featureTree: OcctFeatureTree | null;
  private _topologyPicker: OcctTopologyPicker | null;
  // operationId → occtFeatureId 매핑
  private _opToFeatureId: Map<string, string> = new Map();

  constructor(
    private _scene: THREE.Scene,
    private _getSavedSketch: (key: string) => SerializedSketch | null,
    featureTree?: OcctFeatureTree | null,
    topologyPicker?: OcctTopologyPicker | null,
  ) {
    this._featureTree = featureTree ?? null;
    this._topologyPicker = topologyPicker ?? null;
  }

  // --- Hover / Select highlight (3D viewport) ---

  setSolidHovered(opId: string | null): void {
    if (this._hoveredOpId === opId) return;
    this._hoveredOpId = opId;
    this._applyHoverSelectHighlight();
  }

  setSolidSelected(opId: string | null): void {
    if (this._selectedOpId === opId) return;
    this._selectedOpId = opId;
    this._applyHoverSelectHighlight();
  }

  // 모든 extruded solid 의 emissive 만 갱신 — base color/opacity 는 기본값 유지.
  private _applyHoverSelectHighlight(): void {
    for (const [opId, obj] of this._extrudedSolids) {
      const isSel = this._selectedOpId === opId;
      const isHov = this._hoveredOpId === opId;
      const emissive = isSel ? SELECT_EMISSIVE : isHov ? HOVER_EMISSIVE : 0x000000;
      const intensity = isSel ? SELECT_INTENSITY : isHov ? HOVER_INTENSITY : 0;
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
          child.material.emissive.setHex(emissive);
          child.material.emissiveIntensity = intensity;
          child.material.needsUpdate = true;
        }
      });
    }
    this.onSceneChanged?.();
  }

  // --- Pad/Pocket 돌출 ---

  async addExtrudedSolid(
    operation: PadPocketOperation,
    geometries: Map<string, SerializedGeometry>,
  ): Promise<void> {
    this.removeExtrudedSolid(operation.id);

    // Native 경로 시도
    const nativeResult = await this._tryNativeExtrude(operation, geometries);
    if (nativeResult) return;

    // Fallback: 기존 mesh-based CSG
    const toolMesh = this._createExtrudedMesh(operation, geometries);
    if (!toolMesh) return;

    if (operation.targetOperationId) {
      const sourceMesh = this._extrudedSolids.get(operation.targetOperationId);
      if (sourceMesh && sourceMesh instanceof THREE.Mesh) {
        const csgOp = operation.type === "pad" ? ADDITION : SUBTRACTION;
        const resultMesh = this._performCSGOperation(sourceMesh, toolMesh, csgOp);
        if (resultMesh) {
          sourceMesh.visible = false;
          toolMesh.geometry.dispose();
          if (toolMesh.material instanceof THREE.Material) toolMesh.material.dispose();
          resultMesh.name = `extruded-${operation.id}`;
          resultMesh.userData.sourceOperationId = operation.targetOperationId;
          this._scene.add(resultMesh);
          this._extrudedSolids.set(operation.id, resultMesh);
          return;
        }
        toolMesh.geometry.dispose();
        if (toolMesh.material instanceof THREE.Material) toolMesh.material.dispose();
        if (operation.type === "pocket") return;
      } else if (operation.type === "pocket") {
        toolMesh.geometry.dispose();
        if (toolMesh.material instanceof THREE.Material) toolMesh.material.dispose();
        return;
      }
    }

    toolMesh.name = `extruded-${operation.id}`;
    this._scene.add(toolMesh);
    this._extrudedSolids.set(operation.id, toolMesh);
    this._notifyChange();
  }

  private async _tryFeatureTreeExtrude(
    operation: PadPocketOperation,
    geometries: Map<string, SerializedGeometry>,
  ): Promise<boolean> {
    if (!this._featureTree) return false;
    try {
      const sketch = this._getSavedSketch(operation.sketchPlaneKey);
      if (!sketch) return false;

      // SketchShape 수집
      const geoMap = new Map<string, SerializedGeometry>();
      if (sketch.geometries) {
        for (const g of sketch.geometries) geoMap.set(g.id, g);
      }
      for (const [id, g] of geometries) geoMap.set(id, g);

      const constraintsMap = new Map<string, SketchConstraint>();
      if (sketch.constraints) {
        for (const c of sketch.constraints) constraintsMap.set(c.id, c);
      }
      const shapes = detectClosedShapes(geoMap, constraintsMap);
      const profileIds = operation.profileIds.length > 0 ? operation.profileIds : undefined;

      // 매칭되는 shape 찾기
      let targetShape = shapes[0];
      if (profileIds) {
        const match = shapes.find((s) =>
          profileIds.some((pid) => s.lineIds.includes(pid) || s.id === pid),
        );
        if (match) targetShape = match;
      }
      if (!targetShape) return false;

      // OCCT face handle 생성 + sketch feature 등록
      const { makeFaceFromShape } = await import("../step/OcctSketchNative");
      const faceHandle = await makeFaceFromShape(targetShape, geoMap, sketch.plane);
      // sketch feature는 handle 기반으로 직접 등록 (중복 face 생성 방지)
      const sketchFeature = await this._featureTree.addSketchFromHandle(faceHandle, targetShape.id);
      if (!sketchFeature) return false;

      // feature tree path 는 addPad 가 face offset parameter 를 받지 않아 "both" 를
      // single-prism + plane offset 으로 표현 불가. 두 Pad 호출로 합치면 sketch plane 위
      // coplanar internal face 가 남아 EdgesGeometry 가 mesh 중간에 검은 edge 를 그리는
      // 회귀 — native path (_tryNativeExtrude) 로 fallback 해 단일 prism + plane offset
      // 흐름으로 통일.
      if (operation.direction === "both") return false;

      const n = sketch.plane.normal;
      const dir = operation.direction === "reverse" ? -1 : 1;
      const depth = operation.depth;
      const normal = { x: n.x * dir, y: n.y * dir, z: n.z * dir };

      // Pad/Pocket feature
      const feature = operation.type === "pad"
        ? await this._featureTree.addPad(faceHandle, depth, normal)
        : await this._featureTree.addPocket(faceHandle, depth, normal);

      if (!feature?.mesh) return false;

      const finalFeature = feature;

      // mesh 생성 + 씬 추가
      const mesh = nativeMeshToThreeMesh(finalFeature.mesh!);
      mesh.name = `extruded-${operation.id}`;
      mesh.userData = { occtHandle: finalFeature.outputHandle };
      this._scene.add(mesh);
      this._extrudedSolids.set(operation.id, mesh);
      this._opToFeatureId.set(operation.id, finalFeature.id);
      this._notifyChange();

      // source solid 숨기기
      if (operation.targetOperationId) {
        const sourceMesh = this._extrudedSolids.get(operation.targetOperationId);
        if (sourceMesh) sourceMesh.visible = false;
        mesh.userData.sourceOperationId = operation.targetOperationId;
      }

      // topology picker에 형상 로드 (face/edge/vertex picking용)
      if (this._topologyPicker && finalFeature.outputHandle > 0) {
        this._topologyPicker.loadTopology(finalFeature.outputHandle).catch(() => {});
      }

      return true;
    } catch {
      return false;
    }
  }

  // Native Addon으로 Pad/Pocket 시도 (BooleanNative 직접 호출 — featureTree fallback)
  private async _tryNativeExtrude(
    operation: PadPocketOperation,
    geometries: Map<string, SerializedGeometry>,
  ): Promise<boolean> {
    // OcctFeatureTree 경로는 targetOperationId 가 있을 때만 시도. PartDocument 가 모든
    // feature 를 누적 fuse 하므로 independent pad (target 없음) 의 결과 mesh 가 직전 pad
    // 들까지 포함 → scene 에 양쪽 mesh 가 공존하면 시각 중첩으로 직전 mesh 가 가려짐.
    // independent pad 는 BooleanNative 직접 호출로 분리된 shape handle 생성.
    if (operation.targetOperationId) {
      const ftResult = await this._tryFeatureTreeExtrude(operation, geometries);
      if (ftResult) return true;
    }

    // fallback: 기존 BooleanNative 직접 호출
    try {
      const sketch = this._getSavedSketch(operation.sketchPlaneKey);
      if (!sketch) return false;

      const geoMap = new Map<string, SerializedGeometry>();
      if (sketch.geometries) {
        for (const g of sketch.geometries) geoMap.set(g.id, g);
      }
      for (const [id, g] of geometries) geoMap.set(id, g);

      const constraintsMap = new Map<string, SketchConstraint>();
      if (sketch.constraints) {
        for (const c of sketch.constraints) constraintsMap.set(c.id, c);
      }
      const shapes = detectClosedShapes(geoMap, constraintsMap);
      const profileIds = operation.profileIds.length > 0 ? operation.profileIds : undefined;

      // direction 별 (depth, dir, plane.origin) 결정. "both" 는 단일 prism + plane origin 을
      // normal × (-depth/2) 만큼 offset — 이전 두-prism + boolean fuse 흐름이 sketch plane
      // 위에 coplanar internal face 를 남겨 EdgesGeometry 가 mesh 중간에 검은 edge 두 줄
      // 추가하던 회귀. Three.js fallback _buildExtrudeMesh 와 동일 전략으로 통일.
      const depth = operation.depth;
      let dir = 1;
      let extrudePlane = sketch.plane;
      if (operation.direction === "reverse") {
        dir = -1;
      } else if (operation.direction === "both") {
        const n = sketch.plane.normal;
        const half = depth / 2;
        extrudePlane = {
          ...sketch.plane,
          origin: {
            x: sketch.plane.origin.x - n.x * half,
            y: sketch.plane.origin.y - n.y * half,
            z: sketch.plane.origin.z - n.z * half,
          },
        };
      }

      const profileGeoms: SerializedGeometry[] = [];
      if (profileIds) {
        for (const shape of shapes) {
          if (profileIds.some((pid) => shape.lineIds.includes(pid) || shape.id === pid)) {
            for (const lid of shape.lineIds) {
              const geom = geoMap.get(lid);
              if (geom) profileGeoms.push(geom);
            }
          }
        }
      } else {
        for (const shape of shapes) {
          for (const lid of shape.lineIds) {
            const geom = geoMap.get(lid);
            if (geom) profileGeoms.push(geom);
          }
        }
      }
      if (profileGeoms.length === 0) return false;

      const prismResult = await buildPrismNative(profileGeoms, extrudePlane, depth, dir);

      let finalResult: NativeMeshResult = prismResult;
      if (operation.targetOperationId) {
        const sourceHandle = operationShapeHandles.get(operation.targetOperationId);
        if (sourceHandle != null) {
          const boolOp = operation.type === "pad" ? "fuse" : "cut";
          const boolResult = await performBooleanNative(sourceHandle, prismResult.shapeHandle, boolOp);
          finalResult = boolResult;
          const sourceMesh = this._extrudedSolids.get(operation.targetOperationId);
          if (sourceMesh) sourceMesh.visible = false;
        } else if (operation.type === "pocket") {
          return false;
        }
      }

      const mesh = nativeMeshToThreeMesh(finalResult.mesh);
      mesh.name = `extruded-${operation.id}`;
      if (operation.targetOperationId) {
        mesh.userData.sourceOperationId = operation.targetOperationId;
      }
      this._scene.add(mesh);
      this._extrudedSolids.set(operation.id, mesh);
      operationShapeHandles.set(operation.id, finalResult.shapeHandle);
      this._notifyChange();

      return true;
    } catch {
      return false;
    }
  }

  // OcctFeatureTree 경유 Revolve
  private async _tryFeatureTreeRevolve(
    operation: RevolveOperation,
    geometries: Map<string, SerializedGeometry>,
  ): Promise<boolean> {
    if (!this._featureTree) return false;
    try {
      const sketch = this._getSavedSketch(operation.sketchPlaneKey);
      if (!sketch) return false;

      const geoMap = new Map<string, SerializedGeometry>();
      if (sketch.geometries) for (const g of sketch.geometries) geoMap.set(g.id, g);
      for (const [id, g] of geometries) geoMap.set(id, g);

      const constraintsMap = new Map<string, SketchConstraint>();
      if (sketch.constraints) {
        for (const c of sketch.constraints) constraintsMap.set(c.id, c);
      }
      const shapes = detectClosedShapes(geoMap, constraintsMap);
      const profileIds = operation.profileIds.length > 0 ? operation.profileIds : undefined;
      let targetShape = shapes[0];
      if (profileIds) {
        const match = shapes.find((s) =>
          profileIds.some((pid) => s.lineIds.includes(pid) || s.id === pid),
        );
        if (match) targetShape = match;
      }
      if (!targetShape) return false;

      const { makeFaceFromShape } = await import("../step/OcctSketchNative");
      const faceHandle = await makeFaceFromShape(targetShape, geoMap, sketch.plane);
      await this._featureTree.addSketchFromHandle(faceHandle, targetShape.id);

      // Axis 계산 (3D 좌표)
      const { origin, u, v } = sketch.plane;
      const to3D = (x: number, y: number) => ({
        x: origin.x + x * u.x + y * v.x,
        y: origin.y + x * u.y + y * v.y,
        z: origin.z + x * u.z + y * v.z,
      });

      let axOrigin = { x: 0, y: 0, z: 0 };
      let axDir = { x: 0, y: 1, z: 0 };
      if (operation.axisType === "x") {
        axOrigin = to3D(0, 0);
        axDir = { x: u.x, y: u.y, z: u.z };
      } else if (operation.axisType === "y") {
        axOrigin = to3D(0, 0);
        axDir = { x: v.x, y: v.y, z: v.z };
      } else if (operation.axisOrigin && operation.axisDirection) {
        axOrigin = to3D(operation.axisOrigin.x, operation.axisOrigin.y);
        const d = operation.axisDirection;
        axDir = { x: d.x * u.x + d.y * v.x, y: d.x * u.y + d.y * v.y, z: d.x * u.z + d.y * v.z };
      }

      let angle = operation.angle;
      if (operation.revolveDirection === "symmetric") angle = angle / 2;

      const feature = await this._featureTree.addRevolve(faceHandle, angle, axOrigin, axDir);
      if (!feature?.mesh) return false;

      let finalFeature = feature;
      if (operation.revolveDirection === "symmetric") {
        const negDir = { x: -axDir.x, y: -axDir.y, z: -axDir.z };
        const revFeature = await this._featureTree.addRevolve(faceHandle, angle, axOrigin, negDir);
        if (revFeature?.mesh) finalFeature = revFeature;
      }

      const mesh = nativeMeshToThreeMesh(finalFeature.mesh!);
      mesh.name = `revolved-${operation.id}`;
      mesh.userData = { occtHandle: finalFeature.outputHandle };
      this._scene.add(mesh);
      this._extrudedSolids.set(operation.id, mesh);
      this._opToFeatureId.set(operation.id, finalFeature.id);
      this._notifyChange();

      // topology picker에 형상 로드
      if (this._topologyPicker && finalFeature.outputHandle > 0) {
        this._topologyPicker.loadTopology(finalFeature.outputHandle).catch(() => {});
      }

      return true;
    } catch {
      return false;
    }
  }

  // Native Addon Revolve (featureTree fallback)
  private async _tryNativeRevolve(
    operation: RevolveOperation,
    geometries: Map<string, SerializedGeometry>,
  ): Promise<boolean> {
    // Pad/Pocket 과 동일하게 OcctFeatureTree 는 PartDocument 누적 → independent revolve 가
    // 이전 solid 까지 fuse 된 mesh 반환해 시각 중첩. RevolveOperation 은 targetOperationId 가
    // 없어 항상 independent → 항상 BooleanNative 직접 호출 경로 사용.
    void this._tryFeatureTreeRevolve; // unused (intentional skip — accumulation 회피)

    try {
      const sketch = this._getSavedSketch(operation.sketchPlaneKey);
      if (!sketch) return false;

      const geoMap = new Map<string, SerializedGeometry>();
      if (sketch.geometries) {
        for (const g of sketch.geometries) geoMap.set(g.id, g);
      }
      for (const [id, g] of geometries) geoMap.set(id, g);

      const constraintsMap = new Map<string, SketchConstraint>();
      if (sketch.constraints) {
        for (const c of sketch.constraints) constraintsMap.set(c.id, c);
      }
      const shapes = detectClosedShapes(geoMap, constraintsMap);
      const profileIds = operation.profileIds.length > 0 ? operation.profileIds : undefined;
      const profileGeoms: SerializedGeometry[] = [];
      for (const shape of shapes) {
        if (!profileIds || profileIds.some((pid) => shape.lineIds.includes(pid) || shape.id === pid)) {
          for (const lid of shape.lineIds) {
            const geom = geoMap.get(lid);
            if (geom) profileGeoms.push(geom);
          }
        }
      }
      if (profileGeoms.length === 0) return false;

      const { origin, u, v } = sketch.plane;
      const to3D = (x: number, y: number) => ({
        x: origin.x + x * u.x + y * v.x,
        y: origin.y + x * u.y + y * v.y,
        z: origin.z + x * u.z + y * v.z,
      });

      let axOrigin = { x: 0, y: 0, z: 0 };
      let axDir = { x: 0, y: 1, z: 0 };
      if (operation.axisType === "x") {
        axOrigin = to3D(0, 0);
        axDir = { x: u.x, y: u.y, z: u.z };
      } else if (operation.axisType === "y") {
        axOrigin = to3D(0, 0);
        axDir = { x: v.x, y: v.y, z: v.z };
      } else if (operation.axisOrigin && operation.axisDirection) {
        axOrigin = to3D(operation.axisOrigin.x, operation.axisOrigin.y);
        const d = operation.axisDirection;
        axDir = { x: d.x * u.x + d.y * v.x, y: d.x * u.y + d.y * v.y, z: d.x * u.z + d.y * v.z };
      }

      let angle = operation.angle;
      if (operation.revolveDirection === "symmetric") angle = angle / 2;

      const result = await buildRevolutionNative(profileGeoms, sketch.plane, axOrigin, axDir, angle);
      let finalResult: NativeMeshResult = result;

      if (operation.revolveDirection === "symmetric") {
        const negDir = { x: -axDir.x, y: -axDir.y, z: -axDir.z };
        const rev2 = await buildRevolutionNative(profileGeoms, sketch.plane, axOrigin, negDir, angle);
        finalResult = await performBooleanNative(result.shapeHandle, rev2.shapeHandle, "fuse");
      }

      const mesh = nativeMeshToThreeMesh(finalResult.mesh);
      mesh.name = `revolved-${operation.id}`;
      this._scene.add(mesh);
      this._extrudedSolids.set(operation.id, mesh);
      operationShapeHandles.set(operation.id, finalResult.shapeHandle);
      this._notifyChange();

      return true;
    } catch {
      return false;
    }
  }

  removeExtrudedSolid(operationId: string): void {
    const existing = this._extrudedSolids.get(operationId);
    if (existing) {
      this._scene.remove(existing);
      disposeObject3D(existing);
      this._extrudedSolids.delete(operationId);
      this._notifyChange();
    }
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
    this.clearExtrudePreview();

    const sketch = this._getSavedSketch(sketchPlaneKey);
    if (!sketch?.plane) return;
    const plane = sketch.plane;

    const constraintsMap = new Map<string, SketchConstraint>();
    if (sketch.constraints) {
      for (const c of sketch.constraints) constraintsMap.set(c.id, c);
    }
    const sketchShapes = detectClosedShapes(geometries, constraintsMap);
    const shapes = extractExtrudableShapes(
      geometries,
      profileIds.length > 0 ? profileIds : undefined,
      sketchShapes,
    );
    if (shapes.length === 0) return;

    const mesh = this._buildExtrudeMesh(shapes, plane, depth, direction, true, depth2, draftAngle);
    if (!mesh) return;

    this._scene.add(mesh);
    this._extrudePreview = mesh;
    this._notifyChange();
  }

  clearExtrudePreview(): void {
    if (this._extrudePreview) {
      this._scene.remove(this._extrudePreview);
      disposeObject3D(this._extrudePreview);
      this._extrudePreview = null;
      this._notifyChange();
    }
  }

  getLastVisibleSolidId(): string | undefined {
    let lastId: string | undefined;
    for (const [id, mesh] of this._extrudedSolids) {
      if (mesh.visible) lastId = id;
    }
    return lastId;
  }

  // 통합 entity picker — Phase A 는 Pad/Pocket 결과를 volume 단위로만 노출.
  // Phase C 에서 OCCT body 로 끌어올려 face/edge/vertex 분리 예정.
  pickEntities(ndc: THREE.Vector2, filter: SelectionFilterMode, ctx: PickCtx): PickEntity[] {
    const out: PickEntity[] = [];
    if (filter !== "all" && filter !== "volume") return out;

    ctx.raycaster.setFromCamera(ndc, ctx.camera);
    const allMeshes: THREE.Mesh[] = [];
    const meshToOpId = new Map<THREE.Mesh, string>();
    for (const [opId, obj] of this._extrudedSolids) {
      if (!obj.visible) continue;
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          allMeshes.push(child);
          meshToOpId.set(child, opId);
        }
      });
    }
    if (allMeshes.length === 0) return out;
    const intersects = ctx.raycaster.intersectObjects(allMeshes, false);
    if (intersects.length === 0) return out;
    const hit = intersects[0];
    const opId = meshToOpId.get(hit.object as THREE.Mesh);
    if (!opId) return out;
    out.push({
      source: "feature", kind: "volume",
      operationId: opId,
      worldPos: hit.point.clone(),
      depth: hit.distance,
    });
    return out;
  }

  // CSG 부울 연산 수행 (Brush 생성 → evaluate → Mesh 반환)
  private _performCSGOperation(
    sourceMesh: THREE.Mesh,
    toolMesh: THREE.Mesh,
    operation: number,
  ): THREE.Mesh | null {
    const sourceGeomClone = sourceMesh.geometry.clone();
    const toolGeomClone = toolMesh.geometry.clone();
    try {
      const sourceBrush = new Brush(
        sourceGeomClone,
        sourceMesh.material as THREE.Material,
      );
      sourceBrush.position.copy(sourceMesh.position);
      sourceBrush.updateMatrixWorld(true);

      const toolBrush = new Brush(
        toolGeomClone,
        toolMesh.material as THREE.Material,
      );
      toolBrush.position.copy(toolMesh.position);
      toolBrush.updateMatrixWorld(true);

      const evaluator = new Evaluator();
      const result = evaluator.evaluate(sourceBrush, toolBrush, operation);

      // 중간 클론 geometry 해제
      sourceGeomClone.dispose();
      toolGeomClone.dispose();

      const finalMesh = new THREE.Mesh(result.geometry, createSolidMaterial());
      return finalMesh;
    } catch {
      sourceGeomClone.dispose();
      toolGeomClone.dispose();
      return null;
    }
  }

  // 내부: 돌출 메시 생성
  private _createExtrudedMesh(
    operation: PadPocketOperation,
    geometries: Map<string, SerializedGeometry>,
  ): THREE.Mesh | null {
    const sketch = this._getSavedSketch(operation.sketchPlaneKey);
    if (!sketch) return null;

    const constraintsMap = new Map<string, SketchConstraint>();
    if (sketch.constraints) {
      for (const c of sketch.constraints) constraintsMap.set(c.id, c);
    }
    const sketchShapes = detectClosedShapes(geometries, constraintsMap);
    const shapes = extractExtrudableShapes(
      geometries,
      operation.profileIds.length > 0 ? operation.profileIds : undefined,
      sketchShapes,
    );
    if (shapes.length === 0) return null;

    return this._buildExtrudeMesh(
      shapes,
      sketch.plane,
      operation.depth,
      operation.direction,
      false,
      operation.depth2,
      operation.draftAngle,
    );
  }

  // 내부: Shape + 평면 + 깊이 → THREE.Mesh
  private _buildExtrudeMesh(
    shapes: THREE.Shape[],
    plane: { origin: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number }; u: { x: number; y: number; z: number }; v: { x: number; y: number; z: number } },
    depth: number,
    direction: PadPocketDirection,
    isPreview: boolean,
    depth2?: number,
    draftAngle?: number,
  ): THREE.Mesh | null {
    // 돌출 방향에 따른 실제 깊이 + 오프셋 계산
    let extrudeDepth = depth;
    let offset = 0;
    if (direction === "reverse") {
      offset = -depth;
      extrudeDepth = depth;
    } else if (direction === "both") {
      offset = -depth / 2;
      extrudeDepth = depth;
    } else if (direction === "two-dimensions") {
      const d2 = depth2 ?? depth;
      offset = -d2;
      extrudeDepth = depth + d2;
    }

    // draft angle이 있으면 steps를 늘려 중간 vertex ring 생성
    const hasDraft = draftAngle && draftAngle > 0;
    const steps = hasDraft ? 12 : 1;

    const extrudeSettings: THREE.ExtrudeGeometryOptions = {
      depth: extrudeDepth,
      bevelEnabled: true,
      bevelThickness: 0,
      bevelSize: 0,
      bevelSegments: 1,
      steps,
    };

    const geometry = new THREE.ExtrudeGeometry(shapes, extrudeSettings);

    // Draft angle: vertex를 z 기준으로 테이퍼 스케일링
    if (hasDraft) {
      const tanA = Math.tan((draftAngle! * Math.PI) / 180);
      // Shape centroid 계산 (2D)
      let cx = 0, cy = 0, count = 0;
      for (const shape of shapes) {
        const pts = shape.getPoints();
        for (const p of pts) { cx += p.x; cy += p.y; count++; }
      }
      if (count > 0) { cx /= count; cy /= count; }

      const posAttr = geometry.getAttribute("position");
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
        // z=0이 base, z=extrudeDepth이 top
        // 높이 z에서의 inset = z * tan(α), 스케일 = 1 - z*tan(α)/dist
        const t = z / extrudeDepth;
        const dist = Math.hypot(x - cx, y - cy);
        if (dist > 1e-6) {
          const s = Math.max(0.01, 1 - t * tanA * extrudeDepth / dist);
          posAttr.setX(i, cx + (x - cx) * s);
          posAttr.setY(i, cy + (y - cy) * s);
        }
      }
      posAttr.needsUpdate = true;
      geometry.computeVertexNormals();
    }

    // 2D 평면 좌표계 → 3D 월드 변환 행렬
    const u = new THREE.Vector3(plane.u.x, plane.u.y, plane.u.z);
    const v = new THREE.Vector3(plane.v.x, plane.v.y, plane.v.z);
    const n = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z);
    const o = new THREE.Vector3(plane.origin.x, plane.origin.y, plane.origin.z);
    const origin = o.clone().add(n.clone().multiplyScalar(offset));
    const matrix = new THREE.Matrix4().makeBasis(u, v, n);
    matrix.setPosition(origin);
    geometry.applyMatrix4(matrix);

    const material = isPreview
      ? new THREE.MeshStandardMaterial({ color: 0x4a90d9, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
      : createSolidMaterial();

    return new THREE.Mesh(geometry, material);
  }

  // --- Revolve (회전 돌출) ---

  async addRevolvedSolid(
    operation: RevolveOperation,
    geometries: Map<string, SerializedGeometry>,
  ): Promise<void> {
    this.removeExtrudedSolid(operation.id);

    // Native 경로 시도
    if (await this._tryNativeRevolve(operation, geometries)) return;

    // Fallback: mesh-based
    const mesh = this._createRevolvedMesh(operation, geometries, false);
    if (!mesh) return;

    mesh.name = `revolved-${operation.id}`;
    this._scene.add(mesh);
    this._extrudedSolids.set(operation.id, mesh);
    this._notifyChange();
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
    this.clearExtrudePreview();

    const sketch = this._getSavedSketch(sketchPlaneKey);
    if (!sketch) return;

    const op: RevolveOperation = {
      id: "preview",
      type: "revolve",
      sketchPlaneKey,
      profileIds,
      angle,
      angle2,
      axisType,
      axisOrigin,
      axisDirection,
      revolveDirection: revolveDirection ?? "normal",
      clockwise: clockwise ?? false,
    };

    const mesh = this._createRevolvedMesh(op, geometries, true);
    if (!mesh) return;

    this._scene.add(mesh);
    this._extrudePreview = mesh;
    this._notifyChange();
  }

  private _createRevolvedMesh(
    operation: RevolveOperation,
    geometries: Map<string, SerializedGeometry>,
    isPreview: boolean,
  ): THREE.Mesh | null {
    const sketch = this._getSavedSketch(operation.sketchPlaneKey);
    if (!sketch) return null;

    const constraintsMap = new Map<string, SketchConstraint>();
    if (sketch.constraints) {
      for (const c of sketch.constraints) constraintsMap.set(c.id, c);
    }
    const sketchShapes = detectClosedShapes(geometries, constraintsMap);
    const shapes = extractExtrudableShapes(
      geometries,
      operation.profileIds.length > 0 ? operation.profileIds : undefined,
      sketchShapes,
    );
    if (shapes.length === 0) return null;

    // Shape에서 포인트 추출 (첫 번째 Shape 사용)
    const shape = shapes[0];
    const pts = shape.getPoints(48);

    // custom 축: 축 원점/방향으로 좌표 변환
    const isCustom = operation.axisType === "custom" && operation.axisOrigin && operation.axisDirection;
    let axisAngle = 0; // 축의 2D 회전각
    let axisOx = 0, axisOy = 0;
    if (isCustom) {
      axisOx = operation.axisOrigin!.x;
      axisOy = operation.axisOrigin!.y;
      axisAngle = Math.atan2(operation.axisDirection!.y, operation.axisDirection!.x);
    }

    // 회전축에 따라 포인트를 LatheGeometry용 Vector2로 변환
    const lathePoints: THREE.Vector2[] = [];
    for (const pt of pts) {
      let dist: number, height: number;
      if (isCustom) {
        // custom 축: 축 원점 기준으로 이동 후 축 방향에 수직/평행 분해
        const dx = pt.x - axisOx, dy = pt.y - axisOy;
        const cosA = Math.cos(-axisAngle + Math.PI / 2), sinA = Math.sin(-axisAngle + Math.PI / 2);
        dist = dx * cosA - dy * sinA;
        height = dx * sinA + dy * cosA;
      } else if (operation.axisType === "y") {
        dist = pt.x; height = pt.y;
      } else {
        dist = pt.y; height = pt.x;
      }
      lathePoints.push(new THREE.Vector2(Math.max(0, dist), height));
    }

    // 방향별 phiStart/phiLength 계산
    const dir = operation.revolveDirection ?? "normal";
    const angleRad = (operation.angle * Math.PI) / 180;
    const angle2Rad = ((operation.angle2 ?? operation.angle) * Math.PI) / 180;
    let phiStart = 0, phiLength = angleRad;
    if (dir === "reverse") {
      phiStart = -angleRad;
      phiLength = angleRad;
    } else if (dir === "symmetric") {
      phiStart = -angleRad / 2;
      phiLength = angleRad;
    } else if (dir === "two-angles") {
      phiStart = -angle2Rad;
      phiLength = angleRad + angle2Rad;
    }
    // CW → phiStart 반전 (LatheGeometry는 양수 phiLength만 지원)
    if (operation.clockwise) {
      phiStart = -(phiStart + phiLength);
    }

    const segments = Math.max(12, Math.ceil((phiLength / (Math.PI * 2)) * 48));
    const geometry = new THREE.LatheGeometry(lathePoints, segments, phiStart, phiLength);

    // 스케치 평면 → 월드 변환
    const plane = sketch.plane;
    const uVec = new THREE.Vector3(plane.u.x, plane.u.y, plane.u.z);
    const vVec = new THREE.Vector3(plane.v.x, plane.v.y, plane.v.z);
    const n = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z);
    const o = new THREE.Vector3(plane.origin.x, plane.origin.y, plane.origin.z);

    let basisX: THREE.Vector3, basisY: THREE.Vector3;
    if (isCustom) {
      // custom 축: 축 원점으로 이동 + 축 방향으로 회전
      const cos = Math.cos(axisAngle - Math.PI / 2), sin = Math.sin(axisAngle - Math.PI / 2);
      basisX = uVec.clone().multiplyScalar(cos).add(vVec.clone().multiplyScalar(sin));
      basisY = uVec.clone().multiplyScalar(-sin).add(vVec.clone().multiplyScalar(cos));
      o.add(uVec.clone().multiplyScalar(axisOx)).add(vVec.clone().multiplyScalar(axisOy));
    } else if (operation.axisType === "y") {
      basisX = uVec; basisY = vVec;
    } else {
      basisX = vVec; basisY = uVec;
    }

    const matrix = new THREE.Matrix4().makeBasis(basisX, basisY, n);
    matrix.setPosition(o);
    geometry.applyMatrix4(matrix);

    const material = isPreview
      ? new THREE.MeshStandardMaterial({
          color: 0x4a90d9,
          transparent: true,
          opacity: 0.4,
          side: THREE.DoubleSide,
        })
      : createSolidMaterial();

    return new THREE.Mesh(geometry, material);
  }

  // --- (Sweep/Fillet/Chamfer/Shell/Pattern 제거됨 — UI 진입 경로 부재) ---
  // 필요 시 git history 의 이전 커밋 (PadPocket/Revolve 만 남기기 전) 참조.

  /** sketch 진입 시 모든 솔리드 가시성 일괄 토글. */
  setExtrudedSolidsVisible(visible: boolean): void {
    for (const obj of this._extrudedSolids.values()) {
      obj.visible = visible;
    }
    this._notifyChange();
  }

  /** 개별 솔리드 가시성 토글. */
  setExtrudedSolidVisible(operationId: string, visible: boolean): void {
    const obj = this._extrudedSolids.get(operationId);
    if (obj) { obj.visible = visible; this._notifyChange(); }
  }

  // Edit 시 source solid 다시 표시 (CreatePad/EditPadCommand 에서 사용)
  restoreSourceVisibility(operationId: string): void {
    const mesh = this._extrudedSolids.get(operationId);
    if (mesh) { mesh.visible = true; this._notifyChange(); }
  }


  // sourceLineIds 기반으로 변경된 profileIds를 재매핑
  remapProfileIds(
    profileIds: string[],
    sourceLineIds: string[][] | undefined,
    geoMap: Map<string, SerializedGeometry>,
  ): string[] {
    if (!sourceLineIds || sourceLineIds.length !== profileIds.length) return profileIds;

    return profileIds.map((pid, i) => {
      if (geoMap.has(pid)) return pid;

      const targetLineIds = sourceLineIds[i];
      if (targetLineIds.length === 0) return pid;
      const targetSet = new Set(targetLineIds);

      for (const [id, geom] of geoMap) {
        if (geom.type !== "polygon") continue;
        if (geom.lineIds.length !== targetSet.size) continue;
        if (geom.lineIds.every((lid) => targetSet.has(lid))) return id;
      }
      return pid;
    });
  }

  // 스케치 변경 후 해당 planeKey를 참조하는 솔리드 operations를 순서대로 rebuild
  rebuildOperationsForSketch(
    sketchPlaneKey: string,
    operations: OperationTreeEntry[],
  ): void {
    const sketch = this._getSavedSketch(sketchPlaneKey);
    if (!sketch) return;

    // 최신 스케치 geometry → Map 구성
    const geoMap = new Map<string, SerializedGeometry>();
    if (sketch.geometries) {
      for (const g of sketch.geometries) geoMap.set(g.id, g);
    }

    for (const entry of operations) {
      const op = entry.operation;
      if ("sketchPlaneKey" in op && op.sketchPlaneKey === sketchPlaneKey) {
        if (op.type === "pad" || op.type === "pocket") {
          const remappedProfileIds = this.remapProfileIds(op.profileIds, op.sourceLineIds, geoMap);
          const remappedOp = remappedProfileIds !== op.profileIds
            ? { ...op, profileIds: remappedProfileIds }
            : op;
          if (remappedOp.targetOperationId) {
            this.restoreSourceVisibility(remappedOp.targetOperationId);
          }
          this.addExtrudedSolid(remappedOp, geoMap);
          if (remappedProfileIds !== op.profileIds) {
            (op as PadPocketOperation).profileIds = remappedProfileIds;
          }
        } else if (op.type === "revolve") {
          const remappedProfileIds = this.remapProfileIds(op.profileIds, op.sourceLineIds, geoMap);
          const remappedOp = remappedProfileIds !== op.profileIds
            ? { ...op, profileIds: remappedProfileIds }
            : op;
          this.addRevolvedSolid(remappedOp, geoMap);
          if (remappedProfileIds !== op.profileIds) {
            (op as RevolveOperation).profileIds = remappedProfileIds;
          }
        }
      }
    }
  }

  /** 파일 전환 시 모든 솔리드 제거 (인스턴스 재사용) */
  clearAll(): void {
    for (const mesh of this._extrudedSolids.values()) {
      this._scene.remove(mesh);
      disposeObject3D(mesh);
    }
    this._extrudedSolids.clear();
    this.clearExtrudePreview();
    operationShapeHandles.clear();
    this._notifyChange();
    this._opToFeatureId.clear();
  }

  dispose(): void {
    this.clearAll();
  }
}

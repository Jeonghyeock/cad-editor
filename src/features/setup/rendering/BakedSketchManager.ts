// bakeSketch, 저장/로드, baked sketch face picking/highlight 관리

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";



import type {
  SelectionFilterMode,
  SerializedGeometry,
  SerializedSketch,
  SketchPlane,
} from "../Setup.type";
import type { SketchConstraint } from "../sketch/constraints/SketchConstraint.type";
import { nurbsEvaluate } from "../sketch/curveUtils";

import { disposeObject3D } from "./disposeUtils";
import type { EntityPicker, PickCtx, PickEntity } from "./picking/EntityPicker";

// role 없는 일반 sketch face — blue 톤, 낮은 opacity.
const FACE_ROLELESS_STYLE = { color: 0x2563eb, opacity: 0.06 };

export class BakedSketchManager implements EntityPicker {
  readonly source = "sketch" as const;

  // 평면별 스케치 데이터 (직렬화된 엔진 상태 + bake된 3D 지오메트리).
  // _savedSketches 는 source of truth. _onChange 콜백이 등록되면 mutation 마다 호출되어
  // 외부 (atom) 와 sync.
  private _savedSketches: Map<string, SerializedSketch> = new Map();
  private _bakedSketches: Map<string, THREE.Group> = new Map();
  private _bakedCircleGeom = new THREE.CircleGeometry(2, 24);
  private _onChange: ((snapshot: Record<string, SerializedSketch>) => void) | null = null;
  /** Phase 4 — scene mutation (bake / unbake / visible toggle) 시 호출. */
  onSceneChanged: (() => void) | null = null;
  /** baked role-shape label sprite 가 매 frame 참조하는 wpp provider. SetupScene 가
   *  SceneManager.computeActiveWpp 로 inject — marker / solid label 과 동일 wpp 소스. */
  private _wppProvider: () => number = () => 1;
  setWppProvider(fn: () => number): void {
    this._wppProvider = fn;
  }

  constructor(
    private _scene: THREE.Scene,
    private _renderer: THREE.WebGLRenderer,
    private _getPlaneKey: (plane?: SketchPlane) => string | null,
  ) {}

  get savedSketches(): Map<string, SerializedSketch> {
    return this._savedSketches;
  }

  get bakedSketches(): Map<string, THREE.Group> {
    return this._bakedSketches;
  }

  /** mutation 시 외부 (atom) 동기화 콜백 — SetupScene mount 시 등록. */
  setChangeCallback(cb: ((snapshot: Record<string, SerializedSketch>) => void) | null): void {
    this._onChange = cb;
  }

  private _notifyChange(): void {
    if (this._onChange) {
      const snapshot: Record<string, SerializedSketch> = {};
      for (const [k, v] of this._savedSketches) snapshot[k] = v;
      this._onChange(snapshot);
    }
    // rebake / restore / delete 후에도 hide state 가 새 mesh 에 적용되도록 매번 갱신.
    this._applyVisibility();
    this.onSceneChanged?.();
  }

  // 엔진 상태를 직렬화하여 평면별로 저장 + 3D 지오메트리 bake
  bakeSketch(
    plane: SketchPlane,
    geometries?: SerializedGeometry[],
    constraints?: SketchConstraint[],
    shapes?: SerializedSketch["shapes"],
    name?: string,
  ): void {
    const hasGeometries = geometries && geometries.length > 0;
    // 빈 sketch 도 entry 자체는 보존 (CATIA 방식: exit 후 empty 도 spec tree 에 잔존,
    // 재진입 시 같은 plane key/name 유지). 3D bake mesh 만 생략.

    const key = this._getPlaneKey(plane);
    if (!key) return;

    // 기존 bake 제거
    this._removeBakedGroup(key);

    // 키를 만든 plane 을 그대로 저장한다. 다시 열 때 저장 plane 으로 키를 다시 만들므로, 둘의 좌표계가
    // 다르면(예전 face 스케치: 키는 STEP 좌표, 저장은 오프셋을 더한 world) 그 스케치를 가리키는 Pad 를
    // 찾지 못한다. face 스케치 plane 은 useCrossSectionMode 가 world 좌표로 만든다.

    // 이름 보존: caller 가 전달 안 했으면 기존 saved sketch 의 name 유지 (rebake 케이스).
    //
    // ⚠️ undefined value key 회피 — `{ name: undefined }` 같은 형태가 globalData 에 들어가면
    // isModified 비교가 false positive (lodash isEqual 가 `{a:undefined}` 와 `{}` 를 다르게
    // 봄). 조건부로만 키 추가해 디스크 round-trip (JSON.stringify 가 undefined 제거) 결과와
    // 메모리 표현이 정합되도록.
    const existingName = this._savedSketches.get(key)?.name;
    const finalName = name ?? existingName;
    const serialized: SerializedSketch = { plane };
    if (finalName) serialized.name = finalName;
    if (hasGeometries && geometries) serialized.geometries = geometries;
    if (constraints && constraints.length > 0) serialized.constraints = constraints;
    // shape.planeKey 강제 부여 — shapeDetector 가 `""` 로 생성하므로 planeKey 가 빈 채
    // baked 되면 SpecTree 의 sketchGroup filter
    // (c.shape.planeKey === entry.planeKey) 에서 매칭 실패 → Shapes [Sketch N] 그룹에서 누락.
    // bake 시점에 이 sketch 의 planeKey 로 일괄 부여해 SSOT 보장.
    if (shapes && shapes.length > 0) {
      serialized.shapes = shapes.map((sh) => ({ ...sh, planeKey: key }));
    }
    this._savedSketches.set(key, serialized);

    // 3D 지오메트리 bake — geometry 있을 때만. 빈 sketch 는 entry 만 저장.
    if (hasGeometries || (shapes && shapes.length > 0)) {
      this._bakeGeometry(key, serialized);
    }
    this._notifyChange();
  }

  hasSavedSketch(plane: SketchPlane): boolean {
    const key = this._getPlaneKey(plane);
    return key !== null && this._savedSketches.has(key);
  }

  getSavedSketch(plane: SketchPlane): SerializedSketch | null {
    const key = this._getPlaneKey(plane);
    if (!key) return null;
    return this._savedSketches.get(key) ?? null;
  }

  getSavedSketchByKey(planeKey: string): SerializedSketch | null {
    return this._savedSketches.get(planeKey) ?? null;
  }

  removeBakedSketch(plane: SketchPlane): void {
    const key = this._getPlaneKey(plane);
    if (key) this._removeBakedGroup(key);
  }

  /**
   * Object3D 의 visibility 체인 검사 — Raycaster.intersectObjects 는 visible:false 인 mesh
   * 도 hit 하므로 (visible 은 render 에만 영향) hover/select 흐름에서 hidden mesh 가 잡히는
   * 문제. mesh 자신과 모든 parent (sketchGroup / definitionGroup / 최상위 group) 까지
   * visible 인 경우만 picking 대상.
   */
  private _isVisibleChain(obj: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (!cur.visible) return false;
      cur = cur.parent;
    }
    return true;
  }

  // 통합 entity picker — baked sketch face 만 발행 (sketch edge picking 은 추후).
  pickEntities(ndc: THREE.Vector2, filter: SelectionFilterMode, ctx: PickCtx): PickEntity[] {
    const out: PickEntity[] = [];
    if (filter !== "all" && filter !== "face") return out;

    ctx.raycaster.setFromCamera(ndc, ctx.camera);
    const faceMeshes: THREE.Mesh[] = [];
    const meshToKey = new Map<THREE.Mesh, string>();
    for (const [key, group] of this._bakedSketches) {
      if (!group.visible) continue;
      group.traverse((child) => {
        if (child instanceof THREE.Mesh && child.userData.isBakedFace) {
          // visibility chain 검사 — mesh 자신 또는 sub-group (sketchGroup /
          // definitionGroup) 또는 그 안 shape 별 hide 시 raycaster 가 hit 안 되도록.
          if (!this._isVisibleChain(child)) return;
          faceMeshes.push(child);
          meshToKey.set(child, key);
        }
      });
    }
    if (faceMeshes.length === 0) return out;
    const intersects = ctx.raycaster.intersectObjects(faceMeshes, false);
    if (intersects.length === 0) return out;
    // 같은 영역에 겹치는 모든 face 를 PickEntity 로 변환 — 가까운 순으로 정렬.
    const sorted = [...intersects].sort((a, b) => a.distance - b.distance);
    for (const hit of sorted) {
      const hitMesh = hit.object as THREE.Mesh;
      const planeKey = meshToKey.get(hitMesh);
      if (!planeKey || !this._savedSketches.has(planeKey)) continue;
      const profileId = (hitMesh.userData.geometryId as string) ?? null;
      const shapeId = hitMesh.userData.shapeId as string | undefined;
      out.push({
        source: "sketch",
        kind: "face",
        planeKey,
        profileId,
        shapeId,
        worldPos: hit.point.clone(),
        depth: hit.distance,
      });
    }
    return out;
  }

  // Legacy sketchPending/profile selection highlight. 현재 _bakeShapeFaces (data.shapes SSOT)
  // 가 만드는 face mesh 는 모두 shapeId 가 있고 _applyBakedShapeHighlight (atom 기반) 가 단독
  // 관리 — 그 mesh 는 skip. 두 시스템이 같은 mesh 의 opacity 를 다르게 set 하면 race + 깜빡.
  highlightBakedSketchFaces(targets: { planeKey: string; profileId: string | null }[]): void {
    for (const [key, group] of this._bakedSketches) {
      group.traverse((child) => {
        if (child instanceof THREE.Mesh && child.userData.isBakedFace && child.material instanceof THREE.MeshBasicMaterial) {
          if (child.userData.shapeId) return; // atom SSOT 관리 — skip.
          const geoId = (child.userData.geometryId as string) ?? null;
          const isHighlighted = targets.some(
            (t) => t.planeKey === key && (t.profileId === null || t.profileId === geoId),
          );
          child.material.opacity = isHighlighted ? 0.2 : 0.06;
        }
      });
    }
  }

  highlightBakedSketchFace(planeKey: string | null): void {
    if (planeKey === null) {
      this.highlightBakedSketchFaces([]);
    } else {
      this.highlightBakedSketchFaces([{ planeKey, profileId: null }]);
    }
  }

  // Shape hover/select highlight. SpecTree entry / canvas raycast 가 SSOT atom 으로 호출 —
  // atom 변경 시 SetupScene 이 이 메서드 invoke.
  private _bakedShapeHoveredId: string | null = null;
  private _bakedShapeSelectedId: string | null = null;
  setBakedShapeHovered(id: string | null): void {
    if (this._bakedShapeHoveredId === id) return;
    this._bakedShapeHoveredId = id;
    this._applyBakedShapeHighlight();
  }
  setBakedShapeSelected(id: string | null): void {
    if (this._bakedShapeSelectedId === id) return;
    this._bakedShapeSelectedId = id;
    this._applyBakedShapeHighlight();
  }
  private _applyBakedShapeHighlight(): void {
    for (const group of this._bakedSketches.values()) {
      group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const shapeId = child.userData.shapeId as string | undefined;
        if (!shapeId) return;
        const mat = child.material;
        if (!(mat instanceof THREE.MeshBasicMaterial)) return;
        // base 0.06 / hover 0.3 / select 0.5 (대비 비율 동일 톤).
        let next = 0.06;
        if (this._bakedShapeSelectedId === shapeId) next = 0.5;
        else if (this._bakedShapeHoveredId === shapeId) next = 0.3;
        if (mat.opacity !== next) {
          mat.opacity = next;
          mat.needsUpdate = true;
        }
      });
    }
    this.onSceneChanged?.();
  }

  setBakedSketchVisible(planeKey: string, visible: boolean): void {
    const group = this._bakedSketches.get(planeKey);
    if (group) { group.visible = visible; this.onSceneChanged?.(); }
  }

  // 개별 shape (Definition role-shape + 일반 shape) hide. shape.id 단위.
  private _hiddenShapeIds: Set<string> = new Set();
  // "Sketch" sub-entry hide — role-less shape + linkage 가 아닌 primitive geometry 숨김.
  private _hiddenSketchPortions: Set<string> = new Set();

  setHiddenShapeIds(ids: Set<string>): void {
    this._hiddenShapeIds = ids;
    this._applyVisibility();
  }

  setHiddenSketchPortions(planeKeys: Set<string>): void {
    this._hiddenSketchPortions = planeKeys;
    this._applyVisibility();
  }

  // baked sketch group 의 visibility 갱신. data 가 sketchGroup + definitionGroup 두 sub-group
  // 으로 분리되어 있어 토글 단순화:
  // - Sketch portion hidden → sketchGroup.visible = false (그 안의 모든 mesh 통째로).
  // - Definition shape hidden → definitionGroup 안에서 shapeId 매치 mesh 만 hide.
  //   (face + label 가 같은 shapeId. line 은 shape.lineIds 매칭 — userData.geometryId 검사.)
  private _applyVisibility(): void {
    const hiddenLineIds = new Set<string>();
    for (const sketch of this._savedSketches.values()) {
      if (!sketch.shapes) continue;
      for (const shape of sketch.shapes) {
        if (this._hiddenShapeIds.has(shape.id)) {
          for (const lid of shape.lineIds) hiddenLineIds.add(lid);
        }
      }
    }

    for (const [planeKey, group] of this._bakedSketches) {
      const sketchSub = group.getObjectByName("sketch-portion");
      const definitionSub = group.getObjectByName("definition-portion");
      const portionHidden = this._hiddenSketchPortions.has(planeKey);
      if (sketchSub) sketchSub.visible = !portionHidden;
      if (definitionSub) {
        definitionSub.visible = true;
        definitionSub.traverse((child) => {
          if (child === definitionSub) return;
          const ud = child.userData ?? {};
          const shapeId = ud.shapeId as string | undefined;
          if (shapeId) {
            child.visible = !this._hiddenShapeIds.has(shapeId);
            return;
          }
          const geometryId = ud.geometryId as string | undefined;
          if (geometryId) {
            child.visible = !hiddenLineIds.has(geometryId);
            return;
          }
          child.visible = true;
        });
      }
    }
    this.onSceneChanged?.();
  }

  deleteSavedSketch(planeKey: string): void {
    this._removeBakedGroup(planeKey);
    this._savedSketches.delete(planeKey);
    this._notifyChange();
  }

  restoreSavedSketch(planeKey: string, data: SerializedSketch): void {
    // bakeSketch 처럼 shape.planeKey 를 이 스케치의 키로 맞춘다. 예전 face 스케치 파일은 shape 에
    // STEP 좌표 키가 남아 있어, SpecTree 의 'Shapes [Sketch]' 묶음(shape.planeKey === entry.planeKey)에서 빠졌다.
    if (data.shapes?.some((sh) => sh.planeKey !== planeKey)) {
      data = { ...data, shapes: data.shapes.map((sh) => ({ ...sh, planeKey })) };
    }
    this._savedSketches.set(planeKey, data);
    // mesh 가 만들어질 컨텐츠가 있을 때만 group 생성.
    // 빈 sketch entry 는 _savedSketches 에만 저장 (CATIA 식 entry 보존). 빈 group 생성으로
    // Three.js scene 에 useless node 추가되는 것 회피.
    const hasMeshContent =
      (data.geometries && data.geometries.length > 0) || (data.shapes && data.shapes.length > 0);
    if (hasMeshContent) {
      this._bakeGeometry(planeKey, data);
    }
    this._notifyChange();
  }

  // 모든 baked sketch 가시성 설정
  setAllBakedSketchesVisible(visible: boolean, exceptKey?: string | null): void {
    for (const [key, group] of this._bakedSketches) {
      if (exceptKey !== undefined) {
        group.visible = key === exceptKey;
      } else {
        group.visible = visible;
      }
    }
    this.onSceneChanged?.();
  }

  private _removeBakedGroup(key: string): void {
    const existing = this._bakedSketches.get(key);
    if (existing) {
      this._scene.remove(existing);
      // 공유 _bakedCircleGeom은 dispose하지 않도록 guard
      const sharedGeom = this._bakedCircleGeom;
      existing.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          if (child.geometry && child.geometry !== sharedGeom) child.geometry.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
            else child.material.dispose();
          }
        } else if (child instanceof THREE.Line) {
          child.geometry?.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
            else (child.material as THREE.Material).dispose();
          }
        }
      });
      this._bakedSketches.delete(key);
    }
  }

  // 직렬화된 데이터 → 3D 지오메트리 생성
  private _bakeGeometry(key: string, data: SerializedSketch): void {
    const plane = data.plane;
    const origin = new THREE.Vector3(
      plane.origin.x,
      plane.origin.y,
      plane.origin.z,
    );
    const u = new THREE.Vector3(plane.u.x, plane.u.y, plane.u.z);
    const v = new THREE.Vector3(plane.v.x, plane.v.y, plane.v.z);
    const normal = new THREE.Vector3(
      plane.normal.x,
      plane.normal.y,
      plane.normal.z,
    );
    const planeQuat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      normal,
    );
    const canvas = this._renderer.domElement;
    const resolution = new THREE.Vector2(
      canvas.clientWidth,
      canvas.clientHeight,
    );

    const toWorld = (x: number, y: number): THREE.Vector3 =>
      origin.clone().addScaledVector(u, x).addScaledVector(v, y);

    const group = new THREE.Group();
    group.name = `baked-sketch-${key}`;
    // Sub-group 분리:
    // - sketchGroup: role-less sketch primitive + role-less shape face.
    //   Sketch sub-entry hide / Sketch 1 entry hide 시 toggle.
    // - definitionGroup: Definition shape face + label + Definition shape lineIds 에 속하는
    //   primitive. Definition entry hide / 개별 Shape hide 시 그 안의 mesh 별로.
    const sketchGroup = new THREE.Group();
    sketchGroup.name = "sketch-portion";
    const definitionGroup = new THREE.Group();
    definitionGroup.name = "definition-portion";
    group.add(sketchGroup);
    group.add(definitionGroup);

    // Definition group 은 role 제거 후 항상 비어있음 — 모든 primitive 는 sketchGroup 으로.
    const definitionLineIds = new Set<string>();

    // 기하 프리미티브 bake — Definition lineIds 매치 시 definitionGroup, 아니면 sketchGroup.
    if (data.geometries && data.geometries.length > 0) {
      this._bakeGeometries(
        sketchGroup,
        definitionGroup,
        definitionLineIds,
        data.geometries,
        toWorld,
        resolution,
        planeQuat,
        data.constraints,
      );
    }

    // 모든 shape 의 face mesh — data.shapes SSOT. 한 shape 당 mesh 하나 (sketchGroup).
    if (data.shapes && data.shapes.length > 0) {
      this._bakeShapeFaces(sketchGroup, data.shapes, toWorld);
    }

    this._scene.add(group);
    this._bakedSketches.set(key, group);
  }

  // 모든 sketch shape → face mesh. data.shapes SSOT.
  private _bakeShapeFaces(
    sketchGroup: THREE.Group,
    shapes: NonNullable<SerializedSketch["shapes"]>,
    toWorld: (x: number, y: number) => THREE.Vector3,
  ): void {
    for (const shape of shapes) {
      if (shape.vertices.length < 3) continue;
      const { color, opacity } = FACE_ROLELESS_STYLE;

      // face mesh — world space vertices 로 직접 triangulate.
      const localPts = shape.vertices.map((v) => new THREE.Vector2(v.x, v.y));
      const threeShape = new THREE.Shape(localPts);
      const shapeGeometry = new THREE.ShapeGeometry(threeShape);
      const posAttr = shapeGeometry.getAttribute("position");
      for (let vi = 0; vi < posAttr.count; vi++) {
        const lx = posAttr.getX(vi);
        const ly = posAttr.getY(vi);
        const wp = toWorld(lx, ly);
        posAttr.setXYZ(vi, wp.x, wp.y, wp.z);
      }
      posAttr.needsUpdate = true;
      shapeGeometry.computeBoundingSphere();

      const mat = new THREE.MeshBasicMaterial({
        color,
        opacity,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(shapeGeometry, mat);
      mesh.userData = {
        isBakedFace: true,
        shapeId: shape.id,
      };
      sketchGroup.add(mesh);
    }
  }

  // 기하 프리미티브 → 3D Line/Mesh. geometry id 가 Definition lineIds 에 속하면
  // definitionGroup, 아니면 sketchGroup 에 add.
  private _bakeGeometries(
    sketchGroup: THREE.Group,
    definitionGroup: THREE.Group,
    definitionLineIds: Set<string>,
    geometries: SerializedGeometry[],
    toWorld: (x: number, y: number) => THREE.Vector3,
    resolution: THREE.Vector2,
    planeQuat: THREE.Quaternion,
    _constraints?: SketchConstraint[],
  ): void {
    const color = 0x2563eb;
    const arcSegments = 48;
    const pickGroup = (gid: string): THREE.Group =>
      definitionLineIds.has(gid) ? definitionGroup : sketchGroup;

    for (const geom of geometries) {
      switch (geom.type) {
        case "point": {
          const mat = new THREE.MeshBasicMaterial({
            color,
            side: THREE.DoubleSide,
          });
          const mesh = new THREE.Mesh(this._bakedCircleGeom, mat);
          mesh.position.copy(toWorld(geom.x, geom.y));
          mesh.quaternion.copy(planeQuat);
          mesh.userData = { geometryId: geom.id };
          pickGroup(geom.id).add(mesh);
          break;
        }
        case "line": {
          const positions = [
            toWorld(geom.x1, geom.y1),
            toWorld(geom.x2, geom.y2),
          ];
          const posArr: number[] = [];
          for (const p of positions) posArr.push(p.x, p.y, p.z);
          const g = new LineGeometry();
          g.setPositions(posArr);
          const m = new LineMaterial({
            color,
            linewidth: 2,
            resolution,
            worldUnits: false,
          });
          const l = new Line2(g, m);
          l.computeLineDistances();
          l.userData = { geometryId: geom.id };
          pickGroup(geom.id).add(l);
          break;
        }
        case "circle": {
          const pts: number[] = [];
          for (let i = 0; i <= arcSegments; i++) {
            const a = (i / arcSegments) * Math.PI * 2;
            const wp = toWorld(
              geom.cx + Math.cos(a) * geom.r,
              geom.cy + Math.sin(a) * geom.r,
            );
            pts.push(wp.x, wp.y, wp.z);
          }
          const g = new LineGeometry();
          g.setPositions(pts);
          const m = new LineMaterial({
            color,
            linewidth: 2,
            resolution,
            worldUnits: false,
          });
          const l = new Line2(g, m);
          l.computeLineDistances();
          l.userData = { geometryId: geom.id };
          pickGroup(geom.id).add(l);
          break;
        }
        case "arc": {
          let sweep = geom.endAngle - geom.startAngle;
          if (sweep <= 0) sweep += Math.PI * 2;
          const segs = Math.max(
            8,
            Math.ceil((sweep / (Math.PI * 2)) * arcSegments),
          );
          const pts: number[] = [];
          for (let i = 0; i <= segs; i++) {
            const a = geom.startAngle + (i / segs) * sweep;
            const wp = toWorld(
              geom.cx + Math.cos(a) * geom.r,
              geom.cy + Math.sin(a) * geom.r,
            );
            pts.push(wp.x, wp.y, wp.z);
          }
          const g = new LineGeometry();
          g.setPositions(pts);
          const m = new LineMaterial({
            color,
            linewidth: 2,
            resolution,
            worldUnits: false,
          });
          const l = new Line2(g, m);
          l.computeLineDistances();
          l.userData = { geometryId: geom.id };
          pickGroup(geom.id).add(l);
          break;
        }
        case "curve": {
          if (geom.points.length < 2) break;
          const evaluated = nurbsEvaluate(
            geom.points,
            geom.degree,
            geom.knots,
            geom.weights,
          );
          const pts: number[] = [];
          for (const p of evaluated) {
            const wp = toWorld(p.x, p.y);
            pts.push(wp.x, wp.y, wp.z);
          }
          const g = new LineGeometry();
          g.setPositions(pts);
          const m = new LineMaterial({
            color,
            linewidth: 2,
            resolution,
            worldUnits: false,
          });
          const l = new Line2(g, m);
          l.computeLineDistances();
          l.userData = { geometryId: geom.id };
          pickGroup(geom.id).add(l);
          break;
        }
        case "ellipse": {
          const segments = 64;
          const cosR = Math.cos(geom.rotation);
          const sinR = Math.sin(geom.rotation);
          const pts: number[] = [];
          for (let i = 0; i <= segments; i++) {
            const t = (i / segments) * Math.PI * 2;
            const lx = geom.rx * Math.cos(t);
            const ly = geom.ry * Math.sin(t);
            const wp = toWorld(
              geom.cx + lx * cosR - ly * sinR,
              geom.cy + lx * sinR + ly * cosR,
            );
            pts.push(wp.x, wp.y, wp.z);
          }
          const g = new LineGeometry();
          g.setPositions(pts);
          const m = new LineMaterial({
            color,
            linewidth: 2,
            resolution,
            worldUnits: false,
          });
          const l = new Line2(g, m);
          l.computeLineDistances();
          l.userData = { geometryId: geom.id };
          pickGroup(geom.id).add(l);
          break;
        }
        case "polygon": {
          // polygon은 면만 bake (구성 line은 개별 bake됨)
          break;
        }
      }
    }

    // face mesh 는 _bakeShapeFaces (data.shapes SSOT) 에서 처리 — 한 shape 당 mesh 하나.
    // 이전 detectClosedShapes 기반 mesh 는 role-shape 와 중복되어 제거.
  }

  /** 파일 전환 시 모든 스케치 데이터 초기화 (dispose와 달리 인스턴스는 재사용) */
  clearAll(): void {
    for (const group of this._bakedSketches.values()) {
      this._scene.remove(group);
      disposeObject3D(group);
    }
    this._bakedSketches.clear();
    this._savedSketches.clear();
    this._notifyChange();
  }

  dispose(): void {
    // dispose 시점에는 callback 호출 안 함 (인스턴스 자체 폐기 — atom 보존 의도)
    this._onChange = null;
    for (const group of this._bakedSketches.values()) {
      this._scene.remove(group);
      disposeObject3D(group);
    }
    this._bakedSketches.clear();
    this._savedSketches.clear();
    this._bakedCircleGeom.dispose();
  }
}

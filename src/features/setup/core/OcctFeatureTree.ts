// OCCT Feature Tree — TS 측 파라메트릭 피처 관리
// PartDocument(C++)와 동기화하며, UI(SpecTree)에 피처 목록 제공

import * as THREE from "three";

import type { SerializedGeometry, SketchPlane } from "../Setup.type";
import type { SketchShape } from "../sketch/shapeDetector";
import {
  addChamferFeature,
  addFilletFeature,
  addPadFeature,
  addPocketFeature,
  addRevolveFeature,
  addSketchFeature,
  createDocument,
  getFeatureTree,
  makeFaceFromShape,
  releaseDocument,
  removeFeature,
  serializeDocument,
  deserializeDocument,
  tessellateShape,
  updateFeature,
} from "../step/OcctSketchNative";
import type { SerializedOcctDocument } from "../step/OcctSketchNative";

export type OcctFeature = {
  id: string;
  type: "sketch" | "pad" | "pocket" | "revolve" | "fillet" | "chamfer";
  outputHandle: number;
  params: Record<string, unknown>;
  mesh?: { positions: number[]; normals: number[]; indices: number[] };
};

/**
 * OCCT PartDocument를 관리하는 클래스.
 * 스케치 exit → face 생성 → pad/pocket/fillet/chamfer 피처 체인.
 */
export class OcctFeatureTree {
  private _docId: number | null = null;
  private _features: OcctFeature[] = [];
  private _listeners = new Set<() => void>();

  get features(): OcctFeature[] { return this._features; }
  get docId(): number | null { return this._docId; }

  /** document 초기화 */
  async init(): Promise<void> {
    if (this._docId != null) await this.dispose();
    this._docId = await createDocument();
    this._features = [];
    this._notify();
  }

  /** document 해제 */
  async dispose(): Promise<void> {
    if (this._docId != null) {
      await releaseDocument(this._docId);
      this._docId = null;
    }
    this._features = [];
    this._notify();
  }

  /** 리스너 등록 (UI 갱신용) */
  addListener(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  }

  private _notify(): void {
    for (const cb of this._listeners) cb();
  }

  /** 스케치 face → OCCT Face handle 등록 (SketchShape에서 face handle 생성) */
  async addSketchFromShape(
    shape: SketchShape,
    geometries: Map<string, SerializedGeometry>,
    plane: SketchPlane,
  ): Promise<OcctFeature | null> {
    if (this._docId == null) await this.init();
    try {
      const faceHandle = await makeFaceFromShape(shape, geometries, plane);
      return await this.addSketchFromHandle(faceHandle, shape.id);
    } catch (err) {
      console.error("[OcctFeatureTree] addSketchFromShape failed:", err);
      return null;
    }
  }

  /** 이미 생성된 OCCT face handle을 sketch feature로 등록 */
  async addSketchFromHandle(faceHandle: number, faceId?: string): Promise<OcctFeature | null> {
    if (this._docId == null) await this.init();
    try {
      const result = await addSketchFeature(this._docId!, faceHandle);
      const feature: OcctFeature = {
        id: result.featureId,
        type: "sketch",
        outputHandle: result.outputHandle,
        params: { faceId: faceId ?? `handle_${faceHandle}` },
      };
      this._features.push(feature);
      this._notify();
      return feature;
    } catch (err) {
      console.error("[OcctFeatureTree] addSketchFromHandle failed:", err);
      return null;
    }
  }

  /** Pad 피처 추가 */
  async addPad(
    faceHandle: number,
    depth: number,
    normal: { x: number; y: number; z: number },
  ): Promise<OcctFeature | null> {
    if (this._docId == null) return null;
    try {
      const result = await addPadFeature(this._docId, faceHandle, depth, normal);
      const mesh = await tessellateShape(result.outputHandle);
      const feature: OcctFeature = {
        id: result.featureId,
        type: "pad",
        outputHandle: result.outputHandle,
        params: { depth, normal },
        mesh,
      };
      this._features.push(feature);
      this._notify();
      return feature;
    } catch (err) {
      console.error("[OcctFeatureTree] addPad failed:", err);
      return null;
    }
  }

  /** Pocket 피처 추가 */
  async addPocket(
    faceHandle: number,
    depth: number,
    normal: { x: number; y: number; z: number },
  ): Promise<OcctFeature | null> {
    if (this._docId == null) return null;
    try {
      const result = await addPocketFeature(this._docId, faceHandle, depth, normal);
      const mesh = await tessellateShape(result.outputHandle);
      const feature: OcctFeature = {
        id: result.featureId,
        type: "pocket",
        outputHandle: result.outputHandle,
        params: { depth, normal },
        mesh,
      };
      this._features.push(feature);
      this._notify();
      return feature;
    } catch (err) {
      console.error("[OcctFeatureTree] addPocket failed:", err);
      return null;
    }
  }

  /** Fillet 피처 추가 */
  async addFillet(radius: number, edgeIndices: number[]): Promise<OcctFeature | null> {
    if (this._docId == null) return null;
    try {
      const result = await addFilletFeature(this._docId, radius, edgeIndices);
      const mesh = await tessellateShape(result.outputHandle);
      const feature: OcctFeature = {
        id: result.featureId,
        type: "fillet",
        outputHandle: result.outputHandle,
        params: { radius, edgeIndices },
        mesh,
      };
      this._features.push(feature);
      this._notify();
      return feature;
    } catch (err) {
      console.error("[OcctFeatureTree] addFillet failed:", err);
      return null;
    }
  }

  /** Chamfer 피처 추가 */
  async addChamfer(distance: number, edgeIndices: number[]): Promise<OcctFeature | null> {
    if (this._docId == null) return null;
    try {
      const result = await addChamferFeature(this._docId, distance, edgeIndices);
      const mesh = await tessellateShape(result.outputHandle);
      const feature: OcctFeature = {
        id: result.featureId,
        type: "chamfer",
        outputHandle: result.outputHandle,
        params: { distance, edgeIndices },
        mesh,
      };
      this._features.push(feature);
      this._notify();
      return feature;
    } catch (err) {
      console.error("[OcctFeatureTree] addChamfer failed:", err);
      return null;
    }
  }

  /** Revolve 피처 추가 */
  async addRevolve(
    faceHandle: number,
    angle: number,
    axisOrigin: { x: number; y: number; z: number },
    axisDir: { x: number; y: number; z: number },
  ): Promise<OcctFeature | null> {
    if (this._docId == null) return null;
    try {
      const result = await addRevolveFeature(this._docId, faceHandle, angle, axisOrigin, axisDir);
      const mesh = await tessellateShape(result.outputHandle);
      const feature: OcctFeature = {
        id: result.featureId,
        type: "revolve",
        outputHandle: result.outputHandle,
        params: { angle, axisOrigin, axisDir },
        mesh,
      };
      this._features.push(feature);
      this._notify();
      return feature;
    } catch (err) {
      console.error("[OcctFeatureTree] addRevolve failed:", err);
      return null;
    }
  }

  /** 피처 파라미터 업데이트 + 하위 피처 재계산 */
  async update(
    featureId: string,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    if (this._docId == null) return false;
    try {
      const result = await updateFeature(this._docId, featureId, params);
      // C++ 측에서 rebuild 완료 — TS 측 feature tree 동기화
      await this._syncFromCpp();
      // 변경된 피처부터 끝까지 tessellate 갱신
      const idx = this._features.findIndex((f) => f.id === featureId);
      if (idx >= 0) {
        for (let i = idx; i < this._features.length; i++) {
          if (this._features[i].outputHandle > 0) {
            try {
              this._features[i].mesh = await tessellateShape(this._features[i].outputHandle);
            } catch {
              this._features[i].mesh = undefined;
            }
          }
        }
      }
      this._notify();
      return result.outputHandle > 0;
    } catch (err) {
      console.error("[OcctFeatureTree] update failed:", err);
      return false;
    }
  }

  /** 피처 삭제 + 하위 피처 재계산 */
  async remove(featureId: string): Promise<boolean> {
    if (this._docId == null) return false;
    // 삭제 대상의 인덱스 기록 (rebuild 범위 파악)
    const removedIdx = this._features.findIndex((f) => f.id === featureId);
    try {
      await removeFeature(this._docId, featureId);
      await this._syncFromCpp();
      // 삭제된 위치부터 끝까지 모두 re-tessellate (downstream rebuild로 handle이 변경됨)
      const startIdx = removedIdx >= 0 ? removedIdx : 0;
      for (let i = startIdx; i < this._features.length; i++) {
        if (this._features[i].outputHandle > 0) {
          try {
            this._features[i].mesh = await tessellateShape(this._features[i].outputHandle);
          } catch {
            this._features[i].mesh = undefined;
          }
        }
      }
      this._notify();
      return true;
    } catch (err) {
      console.error("[OcctFeatureTree] remove failed:", err);
      return false;
    }
  }

  /** C++ feature tree에서 TS 측 동기화 */
  private async _syncFromCpp(): Promise<void> {
    if (this._docId == null) return;
    try {
      const tree = await getFeatureTree(this._docId);
      // 기존 mesh 보존하며 feature 목록 갱신
      const oldMeshes = new Map<string, OcctFeature["mesh"]>();
      for (const f of this._features) {
        if (f.mesh) oldMeshes.set(f.id, f.mesh);
      }
      this._features = tree.map((f) => ({
        id: f.id,
        type: f.type as OcctFeature["type"],
        outputHandle: f.outputHandle,
        params: {
          ...(f.depth != null && { depth: f.depth }),
          ...(f.radius != null && { radius: f.radius }),
          ...(f.distance != null && { distance: f.distance }),
          ...(f.angle != null && { angle: f.angle }),
          ...(f.direction != null && { direction: f.direction }),
          ...(f.axisOrigin != null && { axisOrigin: f.axisOrigin }),
          ...(f.axisDir != null && { axisDir: f.axisDir }),
          ...(f.edgeIndices != null && { edgeIndices: f.edgeIndices }),
        },
        mesh: oldMeshes.get(f.id),
      }));
    } catch (err) {
      console.error("[OcctFeatureTree] syncFromCpp failed:", err);
    }
  }

  /** 마지막 solid의 handle 반환 */
  getLastSolidHandle(): number | null {
    for (let i = this._features.length - 1; i >= 0; i--) {
      if (this._features[i].outputHandle > 0) return this._features[i].outputHandle;
    }
    return null;
  }

  /** 피처 ID로 피처 조회 */
  getFeature(featureId: string): OcctFeature | null {
    return this._features.find((f) => f.id === featureId) ?? null;
  }

  /** document 전체를 직렬화 (feature tree + BRep shapes) */
  async serialize(): Promise<SerializedOcctDocument | null> {
    if (this._docId == null) return null;
    try {
      return await serializeDocument(this._docId);
    } catch (err) {
      console.error("[OcctFeatureTree] serialize failed:", err);
      return null;
    }
  }

  /** 직렬화된 데이터에서 document 복원 */
  async deserialize(data: SerializedOcctDocument): Promise<boolean> {
    try {
      if (this._docId != null) await this.dispose();
      this._docId = await deserializeDocument(data);
      // TS feature tree 동기화 + tessellate
      await this._syncFromCpp();
      for (let i = 0; i < this._features.length; i++) {
        if (this._features[i].outputHandle > 0) {
          try {
            this._features[i].mesh = await tessellateShape(this._features[i].outputHandle);
          } catch {
            this._features[i].mesh = undefined;
          }
        }
      }
      this._notify();
      return true;
    } catch (err) {
      console.error("[OcctFeatureTree] deserialize failed:", err);
      return false;
    }
  }

  /** mesh 결과를 Three.js Mesh로 변환 */
  static meshToThreeJs(mesh: { positions: number[]; normals: number[]; indices: number[] }): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
    if (mesh.normals.length > 0) {
      geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.normals, 3));
    }
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));

    const material = new THREE.MeshPhongMaterial({
      color: 0xcccccc,
      specular: 0x111111,
      shininess: 30,
      side: THREE.DoubleSide,
    });

    return new THREE.Mesh(geometry, material);
  }
}

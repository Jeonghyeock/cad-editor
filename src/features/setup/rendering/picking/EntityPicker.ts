// 3D viewport 의 통합 pick entity 정의.
// CATIA 처럼 객체 종류(STEP / sketch / feature) 와 무관하게 같은 picker / 필터 /
// selection state 인터페이스를 공유하기 위한 토대.
//
// source-discriminated union 으로 type narrowing 을 강제 — consumer 는 entity.source 분기 후
// 추가 필드(modelId 등) 에 안전하게 접근.

import type * as THREE from "three";

import type { SelectionFilterMode } from "../../Setup.type";

// CATIA 용어와 일치: 닫힌 3D solid 는 "volume" (직육면체 자체), face / edge / vertex 는 그 하위 BRep entity.
export type PickEntityKind = "vertex" | "edge" | "face" | "volume";
export type PickEntitySource = "step" | "sketch" | "feature";

// 모든 PickEntity 가 공유하는 위치/깊이 정보.
// - worldPos: 후보 표시(pre-highlight) + sketch 영역 표시 등 시각화 공통 데이터
// - depth: 카메라로부터의 거리(작을수록 가까움). across-picker 정렬 키
interface PickEntityCommon {
  worldPos: THREE.Vector3;
  depth: number;
}

// STEP body 의 BRep entity. ModelManager 가 발행.
export type StepPickEntity = PickEntityCommon &
  (
    | { source: "step"; kind: "vertex"; modelId: string; bodyIndex: number; vertexIndex: number }
    | { source: "step"; kind: "edge"; modelId: string; bodyIndex: number; edgeIndex: number }
    | { source: "step"; kind: "face"; modelId: string; faceGroupId: number }
    | { source: "step"; kind: "volume"; modelId: string; bodyIndex: number }
  );

// Baked sketch profile face. BakedSketchManager 가 발행.
// Phase A 한정 — sketch edge 픽킹은 추후 추가.
// shapeId 는 닫힌 profile shape hit 시 채워짐 (shape hover/select SSOT 연동).
export type SketchPickEntity = PickEntityCommon & {
  source: "sketch";
  kind: "face";
  planeKey: string;
  profileId: string | null;
  shapeId?: string;
};

// Pad / Pocket 등 3D feature 결과. SolidOperationManager 가 발행.
// Phase A 한정: mesh face hit 을 volume 으로 fold. Phase C 에서 BRep 승격 시 face/edge/vertex 분리.
export type FeaturePickEntity = PickEntityCommon & {
  source: "feature";
  kind: "volume";
  operationId: string;
};

export type PickEntity =
  | StepPickEntity
  | SketchPickEntity
  | FeaturePickEntity;

// origin / reference plane 은 BRep entity 가 아니라 construction aid 라 PickEntity 와 별개.
// 같은 hover / select pipeline 에서 후보로 다루기 위해 sibling 타입으로 정의.
//   - origin plane: XY / YZ / ZX 의 3 면 (index 0/1/2)
//   - reference plane: 사용자 정의 plane (id)
export type PlaneHit =
  | { source: "originPlane"; index: number }
  | { source: "referencePlane"; id: string };

/**
 * 3D viewport pick 의 통합 후보 타입.
 * - PickEntity: STEP / sketch / feature BRep entity (worldPos + depth 보유)
 * - PlaneHit: origin / reference plane (construction aid, depth 없음)
 *
 * hover / select / preselection navigator 가 공유.
 */
export type Pick3DTarget = PickEntity | PlaneHit;

/** Narrow helper — PickEntity 와 PlaneHit 분리. */
export const isPickEntity = (t: Pick3DTarget): t is PickEntity =>
  t.source === "step" || t.source === "sketch" || t.source === "feature";

// 매니저별 picker 가 공유하는 raycast context.
// mouseScreen / screenWidth / screenHeight 은 screen-space pick (STEP edge/vertex) 전용 —
// face/body 만 다루는 picker (sketch/feature) 는 무시.
export interface PickCtx {
  raycaster: THREE.Raycaster;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  mouseScreen: THREE.Vector2;
  screenWidth: number;
  screenHeight: number;
}

// 각 source 매니저가 구현하는 통합 picker 계약.
// - filter 가 자기 도메인과 무관하면 즉시 [] 반환 (예: sketch picker 는 vertex/edge 필터일 때 [])
// - depth 계산은 매니저 책임. 모든 picker 는 rayDepth() 또는 동치인 raycaster hit.distance 를 사용
//   하여 across-picker 정렬이 같은 척도가 되도록 한다.
// - across-picker 정렬은 호출자(use3DPickHandler) 책임.
export interface EntityPicker {
  readonly source: PickEntitySource;
  pickEntities(ndc: THREE.Vector2, filter: SelectionFilterMode, ctx: PickCtx): PickEntity[];
}

/**
 * ndc + camera 로 setFromCamera 가 호출된 raycaster.ray 위에서 worldPos 의 t parameter.
 *
 * raycaster.intersectObjects 결과의 hit.distance 와 동등한 의미 (둘 다 ray.origin →
 * point 의 ray direction 투영 길이). screen-space pick (STEP edge/vertex) 처럼 raycaster
 * hit 이 아닌 경로의 worldPos 에 대해서도 across-picker 정렬을 위해 같은 척도로 환산.
 *
 * 직교 카메라에서 distanceTo(camera.position) 는 frustum 뒤쪽에 위치한 카메라 좌표로 인해
 * 부정확. 반면 ray.origin 은 ndc 가 차지하는 view plane 위 점이라 정확.
 */
export const rayDepth = (point: THREE.Vector3, ctx: PickCtx): number => {
  const ox = point.x - ctx.raycaster.ray.origin.x;
  const oy = point.y - ctx.raycaster.ray.origin.y;
  const oz = point.z - ctx.raycaster.ray.origin.z;
  const d = ctx.raycaster.ray.direction;
  return ox * d.x + oy * d.y + oz * d.z;
};

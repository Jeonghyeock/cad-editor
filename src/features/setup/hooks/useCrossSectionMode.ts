// 단면 적용 훅
// face/plane 단면을 계산하여 프로파일 저장 + 스케치 평면 설정

import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";

import type SetupScene from "../rendering/SetupScene";
import {
  setupModelsAtom,
  setupProfilesAtom,
  setupSketchPlaneAtom,
} from "../Setup.store";
import type {
  CrossSectionDef,
  ReferenceProfile,
  SketchPlane,
} from "../Setup.type";
import { computeCrossSection } from "../step/CrossSectionComputer";
import { buildPlaneCoordSystem, projectCrossSectionTo2D } from "../step/ProfileProjector";

type UseCrossSectionModeOptions = {
  getScene: () => SetupScene | null;
};

export const useCrossSectionMode = ({ getScene }: UseCrossSectionModeOptions) => {
  const models = useAtomValue(setupModelsAtom);
  const setProfiles = useSetAtom(setupProfilesAtom);
  const setSketchPlane = useSetAtom(setupSketchPlaneAtom);

  // 단면 적용 → 프로파일 저장 + 스케치 평면 설정 (SketchPlane 반환)
  const applyCrossSection = useCallback(
    (modelId: string, crossSection: CrossSectionDef): SketchPlane | null => {
      const model = models.find((m) => m.id === modelId);
      if (!model) {
        console.error("단면 적용 실패: 모델을 찾을 수 없습니다", modelId);
        return null;
      }

      const result = computeCrossSection(model, crossSection);
      const projected = projectCrossSectionTo2D(result);

      if (projected.length === 0) {
        console.error("단면 적용 실패: 투영 결과가 비어있습니다");
        return null;
      }

      const profile: ReferenceProfile = {
        id: window.crypto.randomUUID(),
        sourceModel: modelId,
        crossSection,
        segmentIds: projected.map(() => window.crypto.randomUUID()),
      };

      setProfiles((prev) => [...prev, profile]);

      // SketchPlane 구성 (CATIA 스타일: 글로벌 원점을 plane에 투영)
      // origin 은 world 좌표로 둔다. 이 plane 으로 planeKey 를 만들고(SpecTree entry·Pad 의
      // sketchPlaneKey·viewState) bake 도 이 plane 을 그대로 저장하므로, STEP 좌표로 되돌려 두면
      // 키(STEP 좌표)와 저장 plane(world)이 어긋나 파일을 다시 열 때 Pad 를 찾지 못한다.
      const { u, v } = buildPlaneCoordSystem(result.planeNormal);
      const n = result.planeNormal;
      const o = result.planeOrigin;
      const scene = getScene();
      const offset = scene ? scene.getModelOffset(modelId) : { x: 0, y: 0, z: 0 };
      // world 좌표계에서 투영: plane은 (o + offset) 을 지나므로
      const dWorld = (o.x + offset.x) * n.x + (o.y + offset.y) * n.y + (o.z + offset.z) * n.z;
      const projWorld = { x: dWorld * n.x, y: dWorld * n.y, z: dWorld * n.z };
      const sketchPlane: SketchPlane = {
        origin: projWorld,
        normal: result.planeNormal,
        u,
        v,
      };
      setSketchPlane(sketchPlane);
      if (scene) {
        scene.highlightFace(modelId, null);
        // 단면 프리뷰 라인 제거 (스케치 모드에서는 불필요)
        scene.hideSectionPreview();
        // 카메라 target 은 face centroid (world) — sketch origin 과 분리.
        // sketch origin 은 글로벌 원점 사영 (CATIA 스타일) 인데, face 가 글로벌 원점에서
        // 멀리 있으면 sketch origin ≠ face 중심 → 카메라가 face 가 아닌 빈 공간을
        // 정면으로 잡아 화면이 비어 보이는 문제 방지.
        const faceCentroidWorld = {
          x: result.planeOrigin.x + offset.x,
          y: result.planeOrigin.y + offset.y,
          z: result.planeOrigin.z + offset.z,
        };
        // 스케치 평면 설정 (invisible plane + overlay + 카메라 slerp). origin 이 이미 world 라
        // modelId 를 넘기지 않는다 — 넘기면 모델 오프셋을 한 번 더 더한다.
        scene.setupSketchPlane(sketchPlane, undefined, { cameraTargetWorld: faceCentroidWorld });
      }

        // viewMode/sketchPlaneKey 설정은 caller (handleFacePick) 가 enterSketchMode 로 일괄 처리.
      return sketchPlane;
    },
    [models, setProfiles, getScene, setSketchPlane],
  );

  /**
   * STEP face → SketchPlane 만 추출. profile / sketchPlane atom / 카메라 / 뷰모드 등
   * 부작용 없음. reference plane 생성 시 base plane 정보만 필요할 때 사용.
   *
   * applyCrossSection 과 다른 점:
   *  - origin 을 CATIA "글로벌 원점 plane 투영" 으로 변환하지 않고 face 의 원래 plane origin
   *    그대로 (model-local). world 좌표로는 + modelOffset.
   *  - profile 추가 / sketchPlane atom set / setupSketchPlane / setViewMode 안 함.
   */
  const extractFacePlane = useCallback(
    (modelId: string, crossSection: CrossSectionDef): SketchPlane | null => {
      const model = models.find((m) => m.id === modelId);
      if (!model) return null;
      const result = computeCrossSection(model, crossSection);
      const scene = getScene();
      const offset = scene ? scene.getModelOffset(modelId) : { x: 0, y: 0, z: 0 };
      const { u, v } = buildPlaneCoordSystem(result.planeNormal);
      // world 좌표 origin — face 의 원래 plane 위치 (centroid 근사). STEP 좌표로 변환은
      // 호출자가 setupSketchPlane 호출 시 다시 더하지 않으므로 여기서 + offset 적용해서
      // 즉시 world.
      return {
        origin: {
          x: result.planeOrigin.x + offset.x,
          y: result.planeOrigin.y + offset.y,
          z: result.planeOrigin.z + offset.z,
        },
        normal: result.planeNormal,
        u,
        v,
      };
    },
    [models, getScene],
  );

  return { applyCrossSection, extractFacePlane };
};

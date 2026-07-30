// Input 피처 데이터 직렬화/역직렬화

import { mergeWith } from "lodash";

import { INITIAL_SETUP_DATA } from "../Setup.constant";
import type {
  SetupData,
  SetupPersistentData,
  SerializedStepModelData,
  StepModelData,
} from "../Setup.type";

/**
 * SetupData 에서 디스크 저장용 SetupPersistentData 만 추출 (cameraState 등 메모리
 * 전용 필드 제거).
 *
 * 사용처:
 * - shared/utils/ExtractDataUtils.ts 의 extractPersistentData (디스크 저장)
 * - shared/utils/ExtractDataUtils.ts 의 extractComparableData (isModified 비교)
 */
export function extractSetupPersistentData(
  data: SetupData,
): SetupPersistentData {
  // 명시적 필드 복사 — 향후 메모리 필드 추가 시 자동 제외 (구조적 안전성).
  // projectMode 는 GlobalData root field — 여기서 extract 안 함.
  return {
    models: data.models,
    sketches: data.sketches,
    operations: data.operations,
    referencePlanes: data.referencePlanes,
    // currentScene 은 메모리 전용 — 디스크 저장 시 0 으로 reset (cameraState 와 동일 의도).
    // 새 파일을 열면 항상 첫 scene 부터 시작.
    viewState: { ...data.viewState, currentScene: 0 },
    visibility: data.visibility,
    // target marker 는 markers 의 link 빈 entry 로 통합 — 별도 필드 X.
    // dmuAnalysis / optimization / generativeDesign 은 GlobalData root 로 hoist 됨 —
    // PersistentData 의 root level field 로 별도 저장. 여기서 extract 안 함.
  };
}

// number[] | Float32Array ↔ base64 변환 유틸리티 (mesh 직렬화용)
const arrayToBase64 = (arr: number[] | Float32Array): string => {
  const f32 = arr instanceof Float32Array ? arr : new Float32Array(arr);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const base64ToArray = (b64: string): number[] => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return Array.from(new Float32Array(bytes.buffer));
};

// stepModels 직렬화: 각 body의 positions/normals를 base64로 변환. nativeShapeHandle 제거.
export const serializeStepModels = (
  models: StepModelData[],
): SerializedStepModelData[] => {
  if (models.length === 0) return [];
  return models.map((m) => {
    const { nativeShapeHandle: _unused, ...rest } = m;
    return {
      ...rest,
      bodies: m.bodies.map((body) => ({
        ...body,
        positions: arrayToBase64(body.positions),
        normals: arrayToBase64(body.normals),
      })),
    };
  });
};

// stepModels 역직렬화: base64를 positions/normals 의 number[] 로 변환.
export const deserializeStepModels = (
  models: SerializedStepModelData[],
): StepModelData[] => {
  if (!models || models.length === 0) return [];
  return models.map((m) => ({
    ...m,
    bodies: m.bodies.map((body) => ({
      ...body,
      positions: base64ToArray(body.positions),
      normals: base64ToArray(body.normals),
    })),
  }));
};

// --- Input Feature 전체 영속화 ---

/**
 * 직렬화된 데이터 → SetupData 복원.
 *
 * 두 호출 시나리오:
 *  1. **디스크 로드** — `data.cameraState` 없음 (extractSetupPersistentData 가 제외) → null.
 *  2. **메모리 파일 전환** — 직전 파일 떠나기 전 `globalData.setup.cameraState` 에 카메라 저장됨.
 *     이 경우 해당 값을 보존해야 사용자가 다른 탭 다녀와도 뷰포트 유지.
 *
 * 따라서 `data.cameraState` 가 있으면 보존, 없으면 null.
 */
export const deserializeSetupData = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
): SetupData => {
  if (!data) return INITIAL_SETUP_DATA;

  // DimensionConstraintType: legacy 약자 "h_distance" / "v_distance" → 풀어쓴 이름.
  const migrateConstraintType = (type: string | undefined): string | undefined => {
    if (type === "h_distance") return "horizontal_distance";
    if (type === "v_distance") return "vertical_distance";
    return type;
  };

  // 스케치 역직렬화 — constraint type 마이그레이션.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sketches = (data.sketches ?? []).map((s: any) => {
    const migrated = { ...s };
    // constraints[].type 마이그레이션 (DimensionConstraintType 약자 풀어쓰기).
    if (Array.isArray(migrated.constraints)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      migrated.constraints = migrated.constraints.map((c: any) => ({
        ...c,
        type: migrateConstraintType(c.type),
      }));
    }
    return migrated;
  });

  const operations = data.operations ?? INITIAL_SETUP_DATA.operations;

  // dmuAnalysis / optimization / generativeDesign 은 GlobalData root 로 hoist 됨 —
  // normalizeSetupData 의 책임에서 제외. file load 시 GlobalData 변환 (File.store) 에서 처리.

  // ── lodash mergeWith — INITIAL 의 default 위에 data 의 값 deep merge ──
  return mergeWith(
    {},
    INITIAL_SETUP_DATA,
    {
      ...data,
      // migration 처리된 값으로 override. projectMode 는 GlobalData root 라 여기서 무시.
      models: (data.models ?? []) as SerializedStepModelData[],
      sketches,
      operations,
    },
    (_objValue, srcValue) => {
      // array 는 통째 replace (index 단위 merge 회피).
      if (Array.isArray(srcValue)) return srcValue;
      return undefined; // 그 외엔 lodash default (deep merge).
    },
  ) as SetupData;
};

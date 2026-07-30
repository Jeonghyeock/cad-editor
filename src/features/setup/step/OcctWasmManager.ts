// OpenCascade.js WASM 싱글턴 관리
// STEP import, B-Rep edge 추출, Boolean 연산에서 공용

import initOpenCascade from "opencascade.js";
import type { OpenCascadeInstance } from "opencascade.js";
// eslint-disable-next-line
// @ts-ignore — Vite ?url import로 WASM 파일 런타임 URL 획득
import ocWasmUrl from "opencascade.js/dist/opencascade.full.wasm?url";

export type OcctModule = OpenCascadeInstance;

let modulePromise: Promise<OcctModule> | null = null;

/**
 * opencascade.js WASM 싱글턴 초기화
 * 최초 호출 시 WASM 로딩, 이후 캐시된 모듈 반환
 */
export const initOcct = async (): Promise<OcctModule> => {
  if (!modulePromise) {
    modulePromise = (async () => {
      const oc = await initOpenCascade({
        mainWasm: ocWasmUrl,
      });
      cachedModule = oc;
      return oc;
    })().catch((err) => {
      modulePromise = null; // 실패 시 재시도 허용
      throw err;
    });
  }
  return modulePromise;
};

// 이미 초기화된 모듈을 동기적으로 반환 (STEP import 후에만 유효)
let cachedModule: OcctModule | null = null;
export const getOcctSync = (): OcctModule | null => cachedModule;

// Phase 2에서 사용: 모델별 TopoDS_Shape 보관
const shapeStore = new Map<string, unknown>();

export const storeShape = (modelId: string, shape: unknown): void => {
  shapeStore.set(modelId, shape);
};

export const getShape = (modelId: string): unknown | null => {
  return shapeStore.get(modelId) ?? null;
};

export const releaseShape = (modelId: string): void => {
  const shape = shapeStore.get(modelId);
  if (shape && typeof (shape as { delete?: () => void }).delete === "function") {
    (shape as { delete: () => void }).delete();
  }
  shapeStore.delete(modelId);
};

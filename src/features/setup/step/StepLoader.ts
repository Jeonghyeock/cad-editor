// STEP 파일 로더
// occt-import-js: 빠른 tessellation + 색상/이름 (import 전용)
// opencascade.js: B-Rep shape 보관 (edge 추출/Boolean용, 백그라운드)

// eslint-disable-next-line
// @ts-ignore — Vite ?url import로 WASM 파일의 런타임 URL 획득
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

import type { StepModelData } from "../Setup.type";

import { initOcct as initOpenCascade, storeShape } from "./OcctWasmManager";

// --- occt-import-js 타입 ---
type OcctMesh = {
  name: string;
  color?: [number, number, number];
  brep_faces: {
    first: number;
    last: number;
    color?: [number, number, number];
  }[];
  attributes: {
    position: { array: number[] };
    normal?: { array: number[] };
  };
  index: { array: number[] };
};

type OcctImportResult = {
  success: boolean;
  meshes: OcctMesh[];
};

type OcctImportModule = {
  ReadStepFile: (buffer: Uint8Array, params: null) => OcctImportResult;
};

let occtImportPromise: Promise<OcctImportModule> | null = null;

const DEFAULT_COLOR: [number, number, number] = [0.8, 0.8, 0.8];

const rgbToHex = (color?: [number, number, number]): string | undefined => {
  if (!color) return undefined;
  const r = Math.round(color[0] * 255);
  const g = Math.round(color[1] * 255);
  const b = Math.round(color[2] * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
};

// occt-import-js WASM 싱글턴 초기화 (빠른 import용)
const initOcctImport = async (): Promise<OcctImportModule> => {
  if (!occtImportPromise) {
    occtImportPromise = (async () => {
      // eslint-disable-next-line
      const occtImport = await import("occt-import-js" as any);
      const init =
        typeof occtImport === "function"
          ? occtImport
          : typeof occtImport.default === "function"
            ? occtImport.default
            : typeof occtImport.default?.default === "function"
              ? occtImport.default.default
              : null;
      if (!init) throw new Error("occt-import-js 모듈 로드 실패");
      return await init({ locateFile: () => occtWasmUrl }) as OcctImportModule;
    })().catch((err) => {
      occtImportPromise = null;
      throw err;
    });
  }
  return occtImportPromise;
};

/**
 * STEP 파일 ArrayBuffer를 파싱하여 StepModelData로 변환
 * occt-import-js로 즉시 tessellation, opencascade.js로 B-Rep shape 백그라운드 로드
 */
export const loadStepFile = async (
  buffer: ArrayBuffer,
  fileName: string,
): Promise<StepModelData> => {
  const occt = await initOcctImport();
  const uint8 = new Uint8Array(buffer);
  const result = occt.ReadStepFile(uint8, null);

  if (!result.success || result.meshes.length === 0) {
    throw new Error("STEP 파일 파싱 실패");
  }

  const modelId = window.crypto.randomUUID();

  // 백그라운드: opencascade.js로 B-Rep shape 로드 (edge 추출용)
  loadBRepShapeBackground(uint8, modelId);

  return {
    id: modelId,
    fileName,
    bodies: result.meshes.map((mesh) => ({
      name: mesh.name,
      color: rgbToHex(mesh.color) ?? rgbToHex(DEFAULT_COLOR),
      positions: Array.from(mesh.attributes.position.array),
      normals: mesh.attributes.normal
        ? Array.from(mesh.attributes.normal.array)
        : [],
      indices: Array.from(mesh.index.array),
      brepFaces: mesh.brep_faces.map((face) => ({
        first: face.first,
        last: face.last,
        color: rgbToHex(face.color),
      })),
    })),
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: 1,
    },
  };
};

/**
 * 백그라운드: opencascade.js로 B-Rep shape 로드하여 보관
 * project 3D edges, Boolean 연산에서 사용
 */
async function loadBRepShapeBackground(uint8: Uint8Array, modelId: string): Promise<void> {
  try {
    // eslint-disable-next-line
    const oc: any = await initOpenCascade();
    const tmpPath = `/brep_${Date.now()}.step`;
    oc.FS.createDataFile("/", tmpPath.slice(1), uint8, true, true, true);

    try {
      const reader = new oc.STEPControl_Reader_1();
      // eslint-disable-next-line
      const readResult = reader.ReadFile(tmpPath as any);
      // eslint-disable-next-line
      if ((readResult as any).value !== 1) {
        reader.delete();
        return;
      }
      reader.TransferRoots(new oc.Message_ProgressRange_1());
      const shape = reader.OneShape();
      reader.delete();

      if (!shape.IsNull()) {
        storeShape(modelId, shape);
      }
    } finally {
      try { oc.FS.unlink(tmpPath); } catch { /* 무시 */ }
    }
  } catch {
    // B-Rep 로드 실패 시 조용히 무시 — 메시 기반 폴백 사용
    console.error("B-Rep shape 백그라운드 로드 실패 (메시 기반 폴백 사용)");
  }
}

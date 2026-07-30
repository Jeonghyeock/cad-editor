// STEP 파일 로더 (Native Addon 경유)
// Electron IPC를 통해 main process의 @cad-editor/occt-native 호출

import { OcctChannels } from "src/app/channels/occtChannels";

import type { StepModelData } from "../Setup.type";

// eslint-disable-next-line
const electron = (window as any).electron;

/**
 * Native Addon으로 STEP 파일 읽기
 * main process에서 C++ OCCT로 처리, IPC로 결과 수신
 * shapeHandle은 C++ 측에 보관되어 추후 edge 추출/Boolean에 사용
 */
export const loadStepFileNative = async (
  buffer: ArrayBuffer,
  fileName: string,
): Promise<StepModelData> => {
  const result = await electron.ipcRenderer.invoke(
    OcctChannels.READ_STEP_FILE,
    buffer,
  );

  if (!result || !result.bodies || result.bodies.length === 0) {
    throw new Error("Native STEP import failed");
  }

  return {
    id: window.crypto.randomUUID(),
    fileName,
    bodies: result.bodies.map((b: { name: string; color: string; positions: number[]; normals: number[]; indices: number[]; brepFaces: { first: number; last: number; color?: string }[] }) => ({
      name: b.name,
      color: b.color,
      positions: b.positions,
      normals: b.normals,
      indices: b.indices,
      brepFaces: b.brepFaces,
    })),
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: 1,
    },
    nativeShapeHandle: result.shapeHandle,
  };
};

/**
 * Native Addon 사용 가능 여부 확인
 */
export const isNativeAvailable = async (): Promise<boolean> => {
  try {
    const pong = await electron.ipcRenderer.invoke(OcctChannels.PING);
    return pong === "pong from OCCT native addon";
  } catch {
    return false;
  }
};

// @cad-editor/occt-native TypeScript API
// C++ Native Addon의 JS 바인딩 래퍼

import path from "path";

// .node 바이너리 로드
// eslint-disable-next-line @typescript-eslint/no-require-imports
const addon = require(path.join(__dirname, "../../build/Release/occt_native.node"));

// --- Phase 0: 통신 검증 ---

export function ping(): string {
  return addon.ping();
}

export function getOcctVersion(): string | undefined {
  return addon.getOcctVersion?.();
}

// --- Phase 1: STEP Import (추후 구현) ---

export type ShapeHandle = number;

export interface TessellatedBody {
  name: string;
  color: string | undefined;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  brepFaces: Array<{ first: number; last: number; color?: string }>;
}

export interface StepImportResult {
  shapeHandle: ShapeHandle;
  bodies: TessellatedBody[];
}

// Phase 1에서 구현
// export function readStepFile(buffer: Buffer): StepImportResult;

// --- Phase 2: Edge Extraction (추후 구현) ---

export interface Vec3 { x: number; y: number; z: number }

export type BRepEdgeCurve =
  | { type: "line"; start: Vec3; end: Vec3 }
  | { type: "circle"; center: Vec3; axis: Vec3; xDir: Vec3; radius: number; startParam: number; endParam: number }
  | { type: "ellipse"; center: Vec3; axis: Vec3; majorRadius: number; minorRadius: number; majorDir: Vec3; startParam: number; endParam: number }
  | { type: "bspline"; poles: Vec3[]; knots: number[]; multiplicities: number[]; degree: number; weights?: number[] }
  | { type: "other"; points: Vec3[] };

// Phase 2에서 구현
// export function extractEdges(handle: ShapeHandle, excludedSolidIndices?: number[]): BRepEdgeCurve[];

// --- Phase 3: Boolean (추후 구현) ---
// --- Phase 4: Advanced Ops (추후 구현) ---

// Shape handle 관리
export function releaseShape(handle: ShapeHandle): void {
  addon.releaseShape?.(handle);
}

export function releaseAllShapes(): void {
  addon.releaseAllShapes?.();
}

export function exportStep(handle: ShapeHandle, filePath: string): boolean {
  return addon.exportStep(handle, filePath);
}

export function exportIges(handle: ShapeHandle, filePath: string): boolean {
  return addon.exportIges(handle, filePath);
}

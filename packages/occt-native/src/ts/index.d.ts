export declare function ping(): string;
export declare function getOcctVersion(): string | undefined;

export declare type ShapeHandle = number;

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

export interface Vec3 { x: number; y: number; z: number }

export declare type BRepEdgeCurve =
  | { type: "line"; start: Vec3; end: Vec3 }
  | { type: "circle"; center: Vec3; axis: Vec3; xDir: Vec3; radius: number; startParam: number; endParam: number }
  | { type: "ellipse"; center: Vec3; axis: Vec3; majorRadius: number; minorRadius: number; majorDir: Vec3; startParam: number; endParam: number }
  | { type: "bspline"; poles: Vec3[]; knots: number[]; multiplicities: number[]; degree: number; weights?: number[] }
  | { type: "other"; points: Vec3[] };

export declare function releaseShape(handle: ShapeHandle): void;
export declare function releaseAllShapes(): void;
export declare function exportStep(handle: ShapeHandle, filePath: string): boolean;
export declare function exportIges(handle: ShapeHandle, filePath: string): boolean;

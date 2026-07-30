import type { HoverItem } from "../Setup.type";

/** HoverItem 값 동등성 비교 (참조가 달라도 내용이 같으면 true) */
export function hoverItemsEqual(a: HoverItem | null, b: HoverItem | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case "geometry": return a.geomId === (b as typeof a).geomId;
    case "vertex": return a.geomId === (b as typeof a).geomId && a.vertexIndex === (b as typeof a).vertexIndex;
    case "constraint": return a.constraintId === (b as typeof a).constraintId;
    case "face": return a.faceId === (b as typeof a).faceId;
  }
}

// 구버전 파일의 STEP face 스케치 planeKey 이전
//
// 예전에는 face 스케치의 planeKey 를 모델 오프셋을 더하기 전(STEP 좌표) origin 으로 만들고, 저장 plane 은
// 오프셋을 더한 world origin 으로 저장했다. 파일을 열면 스케치는 저장 plane(world)으로 키를 다시 만들므로,
// 그 스케치로 만든 Pad/Pocket/Revolve 의 sketchPlaneKey(STEP 좌표)가 가리킬 스케치가 없어 솔리드가 사라졌다.
// STEP 좌표 origin + 모델 오프셋 = world origin 이므로, 로드된 모델들의 오프셋으로 짝을 찾아 키를 옮긴다.

import type { OperationTreeEntry, SketchPlane, Vec3 } from "../Setup.type";

// planeKey 는 3자리 반올림이라 (반올림 오차 0.0005) + 부동소수 오차까지 받아 준다.
const TOLERANCE = 1e-3;

const parsePlaneKey = (key: string): { origin: Vec3; normal: Vec3 } | null => {
  const [o, n] = key.split("|").map((part) => part.split(",").map(Number));
  if (o?.length !== 3 || n?.length !== 3 || [...o, ...n].some((x) => !Number.isFinite(x))) return null;
  return { origin: { x: o[0], y: o[1], z: o[2] }, normal: { x: n[0], y: n[1], z: n[2] } };
};

const near = (a: Vec3, b: Vec3): boolean =>
  Math.abs(a.x - b.x) <= TOLERANCE && Math.abs(a.y - b.y) <= TOLERANCE && Math.abs(a.z - b.z) <= TOLERANCE;

// STEP 좌표 키 → (법선이 같고, origin + 어떤 모델 오프셋 = 저장 origin 인) 스케치 키. 짝이 하나일 때만.
const findWorldKey = (
  legacyKey: string,
  sketchPlanes: Map<string, SketchPlane>,
  modelOffsets: Vec3[],
): string | null => {
  const legacy = parsePlaneKey(legacyKey);
  if (!legacy) return null;
  const matches: string[] = [];
  for (const [key, plane] of sketchPlanes) {
    if (!near(plane.normal, legacy.normal)) continue;
    const shifted = modelOffsets.some((o) =>
      near(plane.origin, { x: legacy.origin.x + o.x, y: legacy.origin.y + o.y, z: legacy.origin.z + o.z }),
    );
    if (shifted) matches.push(key);
  }
  return matches.length === 1 ? matches[0] : null;
};

/**
 * 가리키는 스케치가 없는 operation 의 sketchPlaneKey 를 복원한 스케치의 키로 옮긴다.
 * 바꿀 것이 없으면 받은 배열을 그대로 돌려준다 (호출자가 저장 여부를 참조 비교로 정한다).
 *
 * @param sketchPlanes 파일에서 복원한 스케치 — 키 → 저장 plane
 * @param modelOffsets 로드된 STEP 모델들의 오프셋 (ModelManager.getModelOffset)
 */
export function migrateLegacyFacePlaneKeys(
  operations: OperationTreeEntry[],
  sketchPlanes: Map<string, SketchPlane>,
  modelOffsets: Vec3[],
): OperationTreeEntry[] {
  const resolved = new Map<string, string | null>();
  let changed = false;
  const next = operations.map((entry) => {
    const key = entry.operation.sketchPlaneKey;
    if (sketchPlanes.has(key)) return entry;
    if (!resolved.has(key)) resolved.set(key, findWorldKey(key, sketchPlanes, modelOffsets));
    const worldKey = resolved.get(key);
    if (!worldKey) return entry;
    changed = true;
    return { ...entry, operation: { ...entry.operation, sketchPlaneKey: worldKey } };
  });
  return changed ? next : operations;
}

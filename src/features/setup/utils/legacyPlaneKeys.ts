// 구버전 파일의 STEP face 스케치 planeKey 이전
//
// 예전에는 face 스케치의 planeKey 를 모델 오프셋을 더하기 전(STEP 좌표) origin 으로 만들고, 저장 plane 은
// 오프셋을 더한 world origin 으로 저장했다. 파일을 열면 스케치는 저장 plane(world)으로 키를 다시 만들므로,
// 그 키를 가리키던 데이터 — Pad/Pocket/Revolve 의 sketchPlaneKey, 스케치 모드 viewState.sketchPlaneKey,
// 스케치 숨김 목록 — 가 가리킬 스케치가 없었다(솔리드가 사라지고, 빈 스케치로 다시 들어가 중복 entry 가
// 생기고, 숨긴 스케치가 다시 보였다). STEP 좌표 origin + 모델 오프셋 = world origin 이므로, 로드된 모델들의
// 오프셋으로 짝을 찾아 키를 옮긴다.

import { parsePlaneKey } from "../rendering/SketchPlaneManager";
import type { SetupData, SketchPlane, Vec3 } from "../Setup.type";

// planeKey 는 3자리 반올림이라 (반올림 오차 0.0005) + 부동소수 오차까지 받아 준다.
const TOLERANCE = 1e-3;

const near = (a: Vec3, b: Vec3): boolean =>
  Math.abs(a.x - b.x) <= TOLERANCE && Math.abs(a.y - b.y) <= TOLERANCE && Math.abs(a.z - b.z) <= TOLERANCE;

/**
 * 예전 STEP 좌표 키 → (법선이 같고, origin + 어떤 모델 오프셋 = 저장 origin 인) 스케치의 키.
 * 이미 유효한 키이거나 짝이 하나가 아니면 null.
 */
export function resolveLegacyFacePlaneKey(
  key: string,
  sketchPlanes: Map<string, SketchPlane>,
  modelOffsets: Vec3[],
  isKnownKey: (key: string) => boolean = (k) => sketchPlanes.has(k),
): string | null {
  if (isKnownKey(key)) return null;
  const legacy = parsePlaneKey(key);
  if (!legacy) return null;
  const matches: string[] = [];
  for (const [sketchKey, plane] of sketchPlanes) {
    if (!near(plane.normal, legacy.normal)) continue;
    const shifted = modelOffsets.some((o) =>
      near(plane.origin, { x: legacy.origin.x + o.x, y: legacy.origin.y + o.y, z: legacy.origin.z + o.z }),
    );
    if (shifted) matches.push(sketchKey);
  }
  return matches.length === 1 ? matches[0] : null;
}

type PlaneKeyHolder = Pick<SetupData, "operations" | "viewState" | "visibility">;

/**
 * 파일 데이터에서 가리키는 스케치가 없는 planeKey 를 복원한 스케치의 키로 옮긴다 — 연산의
 * sketchPlaneKey, viewState.sketchPlaneKey, visibility.hiddenSketches·hiddenSketchPortions.
 * 바꿀 것이 없으면 받은 객체를 그대로 돌려준다 (호출자가 저장 여부를 참조 비교로 정하고, 이미 옮긴 데이터로
 * 다시 불러도 그대로라 모델이 늦게 올라왔을 때 다시 부를 수 있다).
 *
 * @param sketchPlanes 복원한 스케치 — 키 → 저장 plane
 * @param modelOffsets 로드된 STEP 모델들의 오프셋 (ModelManager.getModelOffset)
 * @param isKnownKey 스케치가 없어도 유효한 키인지 (원점·참조 평면 — 빈 스케치 재진입). 기본은 스케치 키만.
 */
export function migrateLegacyFacePlaneKeys<T extends PlaneKeyHolder>(
  data: T,
  sketchPlanes: Map<string, SketchPlane>,
  modelOffsets: Vec3[],
  isKnownKey?: (key: string) => boolean,
): T {
  const resolved = new Map<string, string>();
  const rename = (key: string): string => {
    if (!resolved.has(key)) {
      resolved.set(key, resolveLegacyFacePlaneKey(key, sketchPlanes, modelOffsets, isKnownKey) ?? key);
    }
    return resolved.get(key)!;
  };
  let changed = false;

  const operations = data.operations.map((entry) => {
    const key = rename(entry.operation.sketchPlaneKey);
    if (key === entry.operation.sketchPlaneKey) return entry;
    changed = true;
    return { ...entry, operation: { ...entry.operation, sketchPlaneKey: key } };
  });

  const renameList = (keys: string[] | undefined): string[] | undefined => {
    if (!keys) return keys;
    const next = [...new Set(keys.map(rename))];
    if (next.length === keys.length && next.every((k, i) => k === keys[i])) return keys;
    changed = true;
    return next;
  };
  const hiddenSketches = renameList(data.visibility?.hiddenSketches);
  const hiddenSketchPortions = renameList(data.visibility?.hiddenSketchPortions);

  const viewKey = data.viewState?.sketchPlaneKey;
  const sketchPlaneKey = viewKey === undefined ? undefined : rename(viewKey);
  if (sketchPlaneKey !== viewKey) changed = true;

  if (!changed) return data;
  return {
    ...data,
    operations,
    viewState: sketchPlaneKey === viewKey ? data.viewState : { ...data.viewState, sketchPlaneKey },
    visibility: { ...data.visibility, hiddenSketches, hiddenSketchPortions },
  };
}

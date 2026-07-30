// undefined value key 가 globalData 에 누적되면 isModified false positive 를 일으킴 — lodash
// isEqual 가 `{a: undefined}` 와 `{}` 를 다르게 보고, 디스크 round-trip (JSON.stringify) 는
// undefined key 를 제거하므로 메모리 표현과 디스크 표현이 어긋남.
//
// 직렬화 시점 (BakedSketchManager.bakeSketch / flushInputSync / shape clone 등) 에서
// undefined value key 를 제거해 isModified 가 disk-equivalent representation 으로 비교되도록.

/** 객체의 top-level undefined value key 를 제거한 새 객체 반환 (nested 객체는 그대로). */
export function omitUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

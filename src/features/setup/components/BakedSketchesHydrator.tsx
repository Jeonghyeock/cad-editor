// file open 시 setupAtom.sketches 가 있는데 setupBakedSketchesAtom 이 비어있으면
// 자동 bake. SetupCanvas mount 여부와 무관하게 App root level 에 mount 해
// 모든 페이지에서 file load 직후 baked sketch atom 이 자동으로 채워지도록 한다.
//
// SerializedSketch 자체가 baked 형식이라 별도 변환 X — plane key 만 계산해 record 로.

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

import { planeKeyFromSketchPlane } from "../rendering/SketchPlaneManager";
import { setupAtom, setupBakedSketchesAtom } from "../Setup.store";
import type { SerializedSketch } from "../Setup.type";

const BakedSketchesHydrator = () => {
  const sketches = useAtomValue(setupAtom).sketches;
  const baked = useAtomValue(setupBakedSketchesAtom);
  const setBaked = useSetAtom(setupBakedSketchesAtom);

  useEffect(() => {
    if (sketches.length === 0) return;
    if (Object.keys(baked).length > 0) return;
    const record: Record<string, SerializedSketch> = {};
    for (const sk of sketches) {
      const key = planeKeyFromSketchPlane(sk.plane);
      record[key] = sk;
    }
    setBaked(record);
  }, [sketches, baked, setBaked]);

  return null;
};

export default BakedSketchesHydrator;

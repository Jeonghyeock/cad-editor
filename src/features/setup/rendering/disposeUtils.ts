// 공유 Three.js 리소스 해제 유틸리티

import * as THREE from "three";

export function disposeGroupChildren(group: THREE.Group): void {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    disposeObject3D(child);
  }
}

export function disposeObject3D(obj: THREE.Object3D): void {
  while (obj.children.length > 0) {
    const child = obj.children[0];
    obj.remove(child);
    disposeObject3D(child);
  }

  if ("dispose" in obj && typeof obj.dispose === "function") {
    obj.dispose();
  }

  if (obj instanceof THREE.Sprite) {
    obj.material?.map?.dispose();
    obj.material?.dispose();
  } else if (
    obj instanceof THREE.Mesh ||
    obj instanceof THREE.LineSegments ||
    obj instanceof THREE.Line
  ) {
    obj.geometry?.dispose();
    if (obj.material) {
      const materials = Array.isArray(obj.material)
        ? obj.material
        : [obj.material];
      for (const mat of materials) {
        (mat as THREE.Material).dispose();
      }
    }
  }
}

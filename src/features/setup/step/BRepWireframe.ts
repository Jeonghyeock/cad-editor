// B-Rep 정확 edge (line / circle / ellipse / bspline / other) → Three.js 와이어프레임.
// EdgesGeometry (mesh tessellation 기반) 가 원/타원을 polygon 으로 보여주는 문제 해결.

import * as THREE from "three";

import type { Vec3 } from "../Setup.type";

import type { BRepEdgeCurve } from "./BRepEdgeExtractor";

const CIRCLE_SEGMENTS = 96; // 시각적으로 부드러운 원

function vec(p: Vec3): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.y, p.z);
}

/** axis 와 xDir 로부터 yDir = axis × xDir 의 단위 벡터. */
function deriveYDir(axis: Vec3, xDir: Vec3): THREE.Vector3 {
  const ax = vec(axis).normalize();
  const xd = vec(xDir).normalize();
  return new THREE.Vector3().crossVectors(ax, xd).normalize();
}

/** circle 의 [startParam, endParam] 구간을 N segment 로 sampling. */
function sampleCircleEdge(
  edge: BRepEdgeCurve & { type: "circle" },
  segments: number,
): THREE.Vector3[] {
  const xd = vec(edge.xDir).normalize();
  const yd = deriveYDir(edge.axis, edge.xDir);
  const center = vec(edge.center);
  const span = edge.endParam - edge.startParam;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = edge.startParam + (i / segments) * span;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    pts.push(
      center.clone()
        .addScaledVector(xd, edge.radius * cos)
        .addScaledVector(yd, edge.radius * sin),
    );
  }
  return pts;
}

/** ellipse 의 [startParam, endParam] 구간을 N segment 로 sampling. */
function sampleEllipseEdge(
  edge: BRepEdgeCurve & { type: "ellipse" },
  segments: number,
): THREE.Vector3[] {
  const xd = vec(edge.majorDir).normalize();
  const yd = deriveYDir(edge.axis, edge.majorDir);
  const center = vec(edge.center);
  const span = edge.endParam - edge.startParam;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = edge.startParam + (i / segments) * span;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    pts.push(
      center.clone()
        .addScaledVector(xd, edge.majorRadius * cos)
        .addScaledVector(yd, edge.minorRadius * sin),
    );
  }
  return pts;
}

/**
 * BRepEdgeCurve 배열을 Three.js wireframe (Group of Line) 으로 변환.
 * type 별로 정확한 parametric sampling — circle/ellipse 가 부드러운 곡선으로 그려짐.
 * line 은 두 점, bspline/other 는 stored points 그대로 polyline.
 */
export function createBRepWireframe(
  edges: BRepEdgeCurve[],
  color = 0x000000,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "brep-wireframe";
  // 모든 edge 가 같은 material 공유 — GPU 부담 줄이고 한 번에 색상 변경 가능.
  const mat = new THREE.LineBasicMaterial({ color, linewidth: 1 });

  for (const edge of edges) {
    let pts: THREE.Vector3[];
    if (edge.type === "line") {
      pts = [vec(edge.start), vec(edge.end)];
    } else if (edge.type === "circle") {
      pts = sampleCircleEdge(edge, CIRCLE_SEGMENTS);
    } else if (edge.type === "ellipse") {
      pts = sampleEllipseEdge(edge, CIRCLE_SEGMENTS);
    } else if (edge.type === "bspline") {
      // poles 자체는 control polygon 이라 곡선 모양과 다름. 정확하려면 NURBS evaluate 필요.
      // 일단 poles 로 rough polyline (시각적 indicator). 후속 작업에서 evaluate 적용.
      pts = edge.poles.map(vec);
    } else {
      // type === "other" — sample points 그대로
      pts = edge.points.map(vec);
    }
    if (pts.length < 2) continue;
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    group.add(new THREE.Line(geom, mat));
  }
  return group;
}

/** wireframe Group 의 모든 BufferGeometry / Material dispose. */
export function disposeBRepWireframe(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Line) {
      obj.geometry.dispose();
      const m = obj.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((mat) => mat.dispose());
      else m.dispose();
    }
  });
}

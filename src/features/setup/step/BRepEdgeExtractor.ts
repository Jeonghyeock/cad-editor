// B-Rep Edge 추출 — opencascade.js의 TopExp_Explorer + BRepAdaptor_Curve
// 삼각형 메시 역추출이 아닌 정확한 곡선 타입 제공

import type { Vec3 } from "../Setup.type";

// eslint-disable-next-line
type OcctModule = any; // opencascade.js API의 동적 특성상 any 사용

// 추출된 B-Rep edge 곡선 타입
export type BRepEdgeCurve =
  | { type: "line"; start: Vec3; end: Vec3 }
  | { type: "circle"; center: Vec3; axis: Vec3; xDir: Vec3; radius: number; startParam: number; endParam: number }
  | { type: "ellipse"; center: Vec3; axis: Vec3; majorRadius: number; minorRadius: number; majorDir: Vec3; startParam: number; endParam: number }
  | { type: "bspline"; poles: Vec3[]; knots: number[]; multiplicities: number[]; degree: number; weights?: number[] }
  | { type: "other"; points: Vec3[] }; // 알 수 없는 곡선 → 샘플링 폴백

/**
 * TopoDS_Shape에서 모든 고유 edge의 곡선 정보를 추출
 * @param excludedBodyIndices 제외할 body 인덱스 (삭제/숨김)
 */
export function extractBRepEdges(
  oc: OcctModule,
  shape: unknown,
  excludedBodyIndices?: Set<number>,
): BRepEdgeCurve[] {
  const result: BRepEdgeCurve[] = [];
  const processedEdges = new Set<number>(); // edge HashCode로 중복 방지

  // body 인덱스 추적을 위해 solid 단위 순회
  if (excludedBodyIndices && excludedBodyIndices.size > 0) {
    let solidIdx = 0;
    const solidExp = new oc.TopExp_Explorer_2(
      shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    while (solidExp.More()) {
      if (!excludedBodyIndices.has(solidIdx)) {
        extractEdgesFromShape(oc, solidExp.Current(), result, processedEdges);
      }
      solidIdx++;
      solidExp.Next();
    }
    solidExp.delete();
  } else {
    extractEdgesFromShape(oc, shape, result, processedEdges);
  }

  return result;
}

// eslint-disable-next-line
function extractEdgesFromShape(oc: OcctModule, shape: any, result: BRepEdgeCurve[], processedEdges: Set<number>): void {
  const edgeExp = new oc.TopExp_Explorer_2(
    shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );

  while (edgeExp.More()) {
    const edge = oc.TopoDS.Edge_1(edgeExp.Current());

    // 중복 edge 방지 (HashCode 기반)
    const hash = edge.HashCode(2147483647);
    if (processedEdges.has(hash)) {
      edgeExp.Next();
      continue;
    }
    processedEdges.add(hash);

    try {
      const curve = extractCurveFromEdge(oc, edge);
      if (curve) result.push(curve);
    } catch {
      // 추출 실패 시 건너뛰기
    }

    edgeExp.Next();
  }
  edgeExp.delete();
}

// eslint-disable-next-line
function extractCurveFromEdge(oc: OcctModule, edge: any): BRepEdgeCurve | null {
  const adaptor = new oc.BRepAdaptor_Curve_2(edge);
  const curveType = adaptor.GetType();
  const t0 = adaptor.FirstParameter();
  const t1 = adaptor.LastParameter();

  // 퇴화 edge (길이 0) 제외
  if (Math.abs(t1 - t0) < 1e-10) {
    adaptor.delete();
    return null;
  }

  let curve: BRepEdgeCurve | null = null;

  // eslint-disable-next-line
  const CurveType = oc.GeomAbs_CurveType;

  if (curveType.value === CurveType.GeomAbs_Line.value) {
    const p0 = adaptor.Value(t0);
    const p1 = adaptor.Value(t1);
    curve = {
      type: "line",
      start: { x: p0.X(), y: p0.Y(), z: p0.Z() },
      end: { x: p1.X(), y: p1.Y(), z: p1.Z() },
    };
    p0.delete();
    p1.delete();

  } else if (curveType.value === CurveType.GeomAbs_Circle.value) {
    const circ = adaptor.Circle();
    const center = circ.Location();
    const circAxis = circ.Axis();
    const axisDir = circAxis.Direction();
    const circXAxis = circ.XAxis();
    const xAxisDir = circXAxis.Direction();
    curve = {
      type: "circle",
      center: { x: center.X(), y: center.Y(), z: center.Z() },
      axis: { x: axisDir.X(), y: axisDir.Y(), z: axisDir.Z() },
      xDir: { x: xAxisDir.X(), y: xAxisDir.Y(), z: xAxisDir.Z() },
      radius: circ.Radius(),
      startParam: t0,
      endParam: t1,
    };
    xAxisDir.delete();
    circXAxis.delete();
    axisDir.delete();
    circAxis.delete();
    center.delete();
    circ.delete();

  } else if (curveType.value === CurveType.GeomAbs_Ellipse.value) {
    const elips = adaptor.Ellipse();
    const center = elips.Location();
    const elipsAxis = elips.Axis();
    const axisDir = elipsAxis.Direction();
    const elipsXAxis = elips.XAxis();
    const majorDir = elipsXAxis.Direction();
    curve = {
      type: "ellipse",
      center: { x: center.X(), y: center.Y(), z: center.Z() },
      axis: { x: axisDir.X(), y: axisDir.Y(), z: axisDir.Z() },
      majorRadius: elips.MajorRadius(),
      minorRadius: elips.MinorRadius(),
      majorDir: { x: majorDir.X(), y: majorDir.Y(), z: majorDir.Z() },
      startParam: t0,
      endParam: t1,
    };
    majorDir.delete();
    elipsXAxis.delete();
    axisDir.delete();
    elipsAxis.delete();
    center.delete();
    elips.delete();

  } else if (curveType.value === CurveType.GeomAbs_BSplineCurve.value) {
    const bspl = adaptor.BSpline().get();
    const nbPoles = bspl.NbPoles();
    const nbKnots = bspl.NbKnots();
    const degree = bspl.Degree();

    const poles: Vec3[] = [];
    for (let i = 1; i <= nbPoles; i++) {
      const p = bspl.Pole(i);
      poles.push({ x: p.X(), y: p.Y(), z: p.Z() });
      p.delete();
    }

    const knots: number[] = [];
    const multiplicities: number[] = [];
    for (let i = 1; i <= nbKnots; i++) {
      knots.push(bspl.Knot(i));
      multiplicities.push(bspl.Multiplicity(i));
    }

    const weights: number[] | undefined = bspl.IsRational()
      ? Array.from({ length: nbPoles }, (_, i) => bspl.Weight(i + 1))
      : undefined;

    curve = { type: "bspline", poles, knots, multiplicities, degree, weights };

  } else {
    // 기타 곡선 (Hyperbola, Parabola, BezierCurve 등) → 등간격 샘플링
    const N_SAMPLES = 30;
    const points: Vec3[] = [];
    for (let i = 0; i <= N_SAMPLES; i++) {
      const t = t0 + (i / N_SAMPLES) * (t1 - t0);
      const p = adaptor.Value(t);
      points.push({ x: p.X(), y: p.Y(), z: p.Z() });
      p.delete();
    }
    curve = { type: "other", points };
  }

  adaptor.delete();
  return curve;
}

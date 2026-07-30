// 모든 DrawTool을 ToolRegistry에 등록하는 사이드이펙트 모듈
// import 시 자동으로 등록이 수행됨

import { ArcDrawTool } from "./ArcDrawTool";
import { AxisDrawTool } from "./AxisDrawTool";
import { BisectingLineDrawTool } from "./BisectingLineDrawTool";
import { BiTangentLineDrawTool } from "./BiTangentLineDrawTool";
import { BreakDrawTool } from "./BreakDrawTool";
import { CenteredParallelogramDrawTool } from "./CenteredParallelogramDrawTool";
import { CenteredRectangleDrawTool } from "./CenteredRectangleDrawTool";
import { ChamferDrawTool } from "./ChamferDrawTool";
import { CircleDrawTool } from "./CircleDrawTool";
import { CloseDrawTool } from "./CloseDrawTool";
import { ComplementDrawTool } from "./ComplementDrawTool";
import { ConicDrawTool } from "./ConicDrawTool";
import { ConnectDrawTool } from "./ConnectDrawTool";
import { CornerDrawTool } from "./CornerDrawTool";
import { CurveDrawTool } from "./CurveDrawTool";
import { CylindricalElongatedHoleDrawTool } from "./CylindricalElongatedHoleDrawTool";
import { DimensionDrawTool } from "./DimensionDrawTool";
import { EllipseDrawTool } from "./EllipseDrawTool";
import { ElongatedHoleDrawTool } from "./ElongatedHoleDrawTool";
import { EquidistantPointsDrawTool } from "./EquidistantPointsDrawTool";
import { ExtendDrawTool } from "./ExtendDrawTool";
import { FilletDrawTool } from "./FilletDrawTool";
import { HexagonDrawTool } from "./HexagonDrawTool";
import { HyperbolaDrawTool } from "./HyperbolaDrawTool";
import { InfiniteLineDrawTool } from "./InfiniteLineDrawTool";
import { IntersectionPointDrawTool } from "./IntersectionPointDrawTool";
import { IsolateDrawTool } from "./IsolateDrawTool";
import { KeyholeDrawTool } from "./KeyholeDrawTool";
import { LineDrawTool } from "./LineDrawTool";
import { LineNormalToCurveDrawTool } from "./LineNormalToCurveDrawTool";
import { MirrorDrawTool } from "./MirrorDrawTool";
import { OblongDrawTool } from "./OblongDrawTool";
import { OffsetDrawTool } from "./OffsetDrawTool";
import { OrientedRectangleDrawTool } from "./OrientedRectangleDrawTool";
import { ParabolaDrawTool } from "./ParabolaDrawTool";
import { ParallelogramDrawTool } from "./ParallelogramDrawTool";
import { PointByCoordinatesDrawTool } from "./PointByCoordinatesDrawTool";
import { PointDrawTool } from "./PointDrawTool";
import { ProfileDrawTool } from "./ProfileDrawTool";
import { RectangleDrawTool } from "./RectangleDrawTool";
import { RotateDrawTool } from "./RotateDrawTool";
import { ScaleDrawTool } from "./ScaleDrawTool";
import { SymmetryMoveDrawTool } from "./SymmetryMoveDrawTool";
import { ThreePointArcDrawTool } from "./ThreePointArcDrawTool";
import { ThreePointCircleDrawTool } from "./ThreePointCircleDrawTool";
import { toolRegistry } from "./ToolRegistry";
import { TranslateDrawTool } from "./TranslateDrawTool";
import { TrapezoidDrawTool } from "./TrapezoidDrawTool";
import { TrimDrawTool } from "./TrimDrawTool";
import { TriTangentCircleDrawTool } from "./TriTangentCircleDrawTool";

// --- Profile ---
toolRegistry.register({ type: "profile", factory: () => new ProfileDrawTool(), group: "profile", label: "Profile" });

// --- Predefined Profile ---
toolRegistry.register({ type: "rectangle", factory: () => new RectangleDrawTool(), group: "predefined-profile", label: "Rectangle" });
toolRegistry.register({ type: "oriented-rectangle", factory: () => new OrientedRectangleDrawTool(), group: "predefined-profile", label: "Oriented Rectangle" });
toolRegistry.register({ type: "parallelogram", factory: () => new ParallelogramDrawTool(), group: "predefined-profile", label: "Parallelogram" });
toolRegistry.register({ type: "elongated-hole", factory: () => new ElongatedHoleDrawTool(), group: "predefined-profile", label: "Elongated Hole" });
toolRegistry.register({ type: "cylindrical-elongated-hole", factory: () => new CylindricalElongatedHoleDrawTool(), group: "predefined-profile", label: "Cylindrical Elongated Hole" });
toolRegistry.register({ type: "keyhole", factory: () => new KeyholeDrawTool(), group: "predefined-profile", label: "Keyhole" });
toolRegistry.register({ type: "hexagon", factory: () => new HexagonDrawTool(), group: "predefined-profile", label: "Hexagon" });
toolRegistry.register({ type: "centered-rectangle", factory: () => new CenteredRectangleDrawTool(), group: "predefined-profile", label: "Centered Rectangle" });
toolRegistry.register({ type: "centered-parallelogram", factory: () => new CenteredParallelogramDrawTool(), group: "predefined-profile", label: "Centered Parallelogram" });
toolRegistry.register({ type: "oblong", factory: () => new OblongDrawTool(), group: "predefined-profile", label: "Oblong" });
toolRegistry.register({ type: "trapezoid", factory: () => new TrapezoidDrawTool(), group: "predefined-profile", label: "Trapezoid" });

// --- Circle ---
toolRegistry.register({ type: "circle", factory: () => new CircleDrawTool(), group: "circle", label: "Circle" });
toolRegistry.register({ type: "three-point-circle", factory: () => new ThreePointCircleDrawTool(), group: "circle", label: "Three Point Circle" });
toolRegistry.register({ type: "arc", factory: () => new ArcDrawTool(), group: "circle", label: "Arc" });
toolRegistry.register({ type: "three-point-arc", factory: () => new ThreePointArcDrawTool(), group: "circle", label: "Three Point Arc" });
toolRegistry.register({ type: "tri-tangent-circle", factory: () => new TriTangentCircleDrawTool(), group: "circle", label: "Tri-Tangent Circle" });

// --- Spline ---
toolRegistry.register({ type: "curve", factory: () => new CurveDrawTool(), group: "spline", label: "Spline" });

// --- Conic ---
toolRegistry.register({ type: "ellipse", factory: () => new EllipseDrawTool(), group: "conic", label: "Ellipse" });
toolRegistry.register({ type: "hyperbola", factory: () => new HyperbolaDrawTool(), group: "conic", label: "Hyperbola" });
toolRegistry.register({ type: "parabola", factory: () => new ParabolaDrawTool(), group: "conic", label: "Parabola" });
toolRegistry.register({ type: "conic", factory: () => new ConicDrawTool(), group: "conic", label: "Conic" });

// --- Line ---
toolRegistry.register({ type: "line", factory: () => new LineDrawTool(), group: "line", label: "Line" });
toolRegistry.register({ type: "axis", factory: () => new AxisDrawTool(), group: "line", label: "Axis" });
toolRegistry.register({ type: "bisecting-line", factory: () => new BisectingLineDrawTool(), group: "line", label: "Bisecting Line" });
toolRegistry.register({ type: "connect", factory: () => new ConnectDrawTool(), group: "line", label: "Connect" });
toolRegistry.register({ type: "infinite-line", factory: () => new InfiniteLineDrawTool(), group: "line", label: "Infinite Line" });
toolRegistry.register({ type: "bi-tangent-line", factory: () => new BiTangentLineDrawTool(), group: "line", label: "Bi-Tangent Line" });
toolRegistry.register({ type: "line-normal", factory: () => new LineNormalToCurveDrawTool(), group: "line", label: "Line Normal to Curve" });

// --- Point ---
toolRegistry.register({ type: "point", factory: () => new PointDrawTool(), group: "point", label: "Point" });
toolRegistry.register({ type: "point-coordinates", factory: () => new PointByCoordinatesDrawTool(), group: "point", label: "Point by Coordinates" });
toolRegistry.register({ type: "equidistant-points", factory: () => new EquidistantPointsDrawTool(), group: "point", label: "Equidistant Points" });
toolRegistry.register({ type: "intersection-point", factory: () => new IntersectionPointDrawTool(), group: "point", label: "Intersection Point" });

// --- Corner ---
toolRegistry.register({ type: "fillet", factory: () => new FilletDrawTool(), group: "corner", label: "Fillet" });
toolRegistry.register({ type: "corner", factory: () => new CornerDrawTool(), group: "corner", label: "Corner" });

// --- Chamfer ---
toolRegistry.register({ type: "chamfer", factory: () => new ChamferDrawTool(), group: "chamfer", label: "Chamfer" });

// --- Relimit ---
toolRegistry.register({ type: "trim", factory: () => new TrimDrawTool(), group: "relimit", label: "Trim" });
toolRegistry.register({ type: "break", factory: () => new BreakDrawTool(), group: "relimit", label: "Break" });
toolRegistry.register({ type: "close", factory: () => new CloseDrawTool(), group: "relimit", label: "Close" });
toolRegistry.register({ type: "complement", factory: () => new ComplementDrawTool(), group: "relimit", label: "Complement" });
toolRegistry.register({ type: "extend", factory: () => new ExtendDrawTool(), group: "relimit", label: "Extend" });
toolRegistry.register({ type: "isolate", factory: () => new IsolateDrawTool(), group: "relimit", label: "Isolate" });

// --- Transform ---
toolRegistry.register({ type: "mirror", factory: () => new MirrorDrawTool(), group: "transform", label: "Mirror" });
toolRegistry.register({ type: "symmetry-move", factory: () => new SymmetryMoveDrawTool(), group: "transform", label: "Symmetry" });
toolRegistry.register({ type: "translate", factory: () => new TranslateDrawTool(), group: "transform", label: "Translate" });
toolRegistry.register({ type: "rotate", factory: () => new RotateDrawTool(), group: "transform", label: "Rotate" });
toolRegistry.register({ type: "scale", factory: () => new ScaleDrawTool(), group: "transform", label: "Scale" });
toolRegistry.register({ type: "offset", factory: () => new OffsetDrawTool(), group: "transform", label: "Offset" });

// --- Constraint ---
toolRegistry.register({ type: "dimension", factory: () => new DimensionDrawTool(), group: "constraint", label: "Dimension" });

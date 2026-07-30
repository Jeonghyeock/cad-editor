#include "boolean_ops.h"
#include "shape_store.h"

#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <TopTools_ListOfShape.hxx>
#include <gp_Ax1.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepLib.hxx>
#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <BRep_Tool.hxx>
#include <Poly_Triangulation.hxx>
#include <TopLoc_Location.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <GC_MakeCircle.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>
#include <gp_Ax2.hxx>
#include <gp_Circ.hxx>
#include <gp_Dir.hxx>
#include <Standard_Failure.hxx>
#include <Message_ProgressRange.hxx>

#include <vector>
#include <string>
#include <set>
#include <cmath>

// --- Helpers ---

static double computeDeflection(const TopoDS_Shape& shape) {
  Bnd_Box box;
  BRepBndLib::Add(shape, box);
  if (box.IsVoid()) return 0.1;
  double xmin, ymin, zmin, xmax, ymax, zmax;
  box.Get(xmin, ymin, zmin, xmax, ymax, zmax);
  double diag = std::sqrt(
    (xmax-xmin)*(xmax-xmin) + (ymax-ymin)*(ymax-ymin) + (zmax-zmin)*(zmax-zmin)
  );
  return std::max(diag * 0.001, 1e-5);
}

// Tessellate shape -> JS object { positions, normals, indices }
static Napi::Object tessellateToJs(Napi::Env env, const TopoDS_Shape& shape) {
  double deflection = computeDeflection(shape);
  BRepMesh_IncrementalMesh mesher(shape, deflection, Standard_False, 0.5);
  mesher.Perform();
  BRepLib::EnsureNormalConsistency(shape);

  std::vector<float> positions, normals;
  std::vector<uint32_t> indices;
  int vertexOffset = 0;

  for (TopExp_Explorer faceExp(shape, TopAbs_FACE); faceExp.More(); faceExp.Next()) {
    TopoDS_Face face = TopoDS::Face(faceExp.Current());
    TopLoc_Location location;
    Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, location);
    if (tri.IsNull()) continue;

    int nbNodes = tri->NbNodes();
    int nbTriangles = tri->NbTriangles();
    gp_Trsf trsf = location.Transformation();
    bool reversed = (face.Orientation() == TopAbs_REVERSED);

    for (int i = 1; i <= nbNodes; i++) {
      gp_Pnt pnt = tri->Node(i).Transformed(trsf);
      positions.push_back((float)pnt.X());
      positions.push_back((float)pnt.Y());
      positions.push_back((float)pnt.Z());

      bool gotNormal = false;
      if (tri->HasNormals()) {
        try {
          gp_Vec nv(tri->Normal(i));
          gp_Vec transformed = nv.Transformed(trsf);
          double len = transformed.Magnitude();
          float sign = reversed ? -1.0f : 1.0f;
          if (len > 1e-10) {
            normals.push_back((float)(transformed.X() / len) * sign);
            normals.push_back((float)(transformed.Y() / len) * sign);
            normals.push_back((float)(transformed.Z() / len) * sign);
          } else {
            normals.push_back(0.0f); normals.push_back(0.0f); normals.push_back(1.0f);
          }
          gotNormal = true;
        } catch (...) {}
      }
      if (!gotNormal) {
        normals.push_back(0.0f); normals.push_back(0.0f); normals.push_back(1.0f);
      }
    }

    for (int i = 1; i <= nbTriangles; i++) {
      int n1, n2, n3;
      tri->Triangle(i).Get(n1, n2, n3);
      n1 = n1 - 1 + vertexOffset;
      n2 = n2 - 1 + vertexOffset;
      n3 = n3 - 1 + vertexOffset;
      if (reversed) {
        indices.push_back(n1); indices.push_back(n3); indices.push_back(n2);
      } else {
        indices.push_back(n1); indices.push_back(n2); indices.push_back(n3);
      }
    }
    vertexOffset += nbNodes;
  }

  Napi::Object result = Napi::Object::New(env);
  {
    size_t byteLen = positions.size() * sizeof(float);
    auto buf = Napi::ArrayBuffer::New(env, byteLen);
    memcpy(buf.Data(), positions.data(), byteLen);
    result.Set("positions", Napi::Float32Array::New(env, positions.size(), buf, 0));
  }
  {
    size_t byteLen = normals.size() * sizeof(float);
    auto buf = Napi::ArrayBuffer::New(env, byteLen);
    memcpy(buf.Data(), normals.data(), byteLen);
    result.Set("normals", Napi::Float32Array::New(env, normals.size(), buf, 0));
  }
  {
    size_t byteLen = indices.size() * sizeof(uint32_t);
    auto buf = Napi::ArrayBuffer::New(env, byteLen);
    memcpy(buf.Data(), indices.data(), byteLen);
    result.Set("indices", Napi::Uint32Array::New(env, indices.size(), buf, 0));
  }
  return result;
}

// --- BuildPrism ---
// Args: profiles (array of edge data), plane {origin, u, v}, depth (number), direction (number)
// Each profile edge: { type: "line"|"arc"|"circle", ... }

Napi::Value BuildPrism(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 4) {
    Napi::TypeError::New(env, "BuildPrism requires: profiles, plane, depth, direction").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array profiles = info[0].As<Napi::Array>();
  Napi::Object planeObj = info[1].As<Napi::Object>();
  double depth = info[2].As<Napi::Number>().DoubleValue();
  double direction = info[3].As<Napi::Number>().DoubleValue();

  // Parse plane
  auto getVec3 = [](Napi::Object obj) -> gp_Pnt {
    return gp_Pnt(
      obj.Get("x").As<Napi::Number>().DoubleValue(),
      obj.Get("y").As<Napi::Number>().DoubleValue(),
      obj.Get("z").As<Napi::Number>().DoubleValue()
    );
  };

  Napi::Object originObj = planeObj.Get("origin").As<Napi::Object>();
  Napi::Object uObj = planeObj.Get("u").As<Napi::Object>();
  Napi::Object vObj = planeObj.Get("v").As<Napi::Object>();

  gp_Pnt origin = getVec3(originObj);
  gp_Pnt uPt = getVec3(uObj);
  gp_Pnt vPt = getVec3(vObj);
  gp_Vec uDir(uPt.X(), uPt.Y(), uPt.Z());
  gp_Vec vDir(vPt.X(), vPt.Y(), vPt.Z());

  // 2D -> 3D coordinate transform
  auto to3D = [&](double x, double y) -> gp_Pnt {
    return gp_Pnt(
      origin.X() + x * uDir.X() + y * vDir.X(),
      origin.Y() + x * uDir.Y() + y * vDir.Y(),
      origin.Z() + x * uDir.Z() + y * vDir.Z()
    );
  };

  try {
    // Build wire from profile edges
    BRepBuilderAPI_MakeWire wireMaker;

    for (uint32_t i = 0; i < profiles.Length(); i++) {
      Napi::Object edge = profiles.Get(i).As<Napi::Object>();
      std::string type = edge.Get("type").As<Napi::String>().Utf8Value();

      if (type == "line") {
        double x1 = edge.Get("x1").As<Napi::Number>().DoubleValue();
        double y1 = edge.Get("y1").As<Napi::Number>().DoubleValue();
        double x2 = edge.Get("x2").As<Napi::Number>().DoubleValue();
        double y2 = edge.Get("y2").As<Napi::Number>().DoubleValue();
        gp_Pnt p1 = to3D(x1, y1), p2 = to3D(x2, y2);
        BRepBuilderAPI_MakeEdge edgeMaker(p1, p2);
        if (edgeMaker.IsDone()) wireMaker.Add(edgeMaker.Edge());

      } else if (type == "arc") {
        double cx = edge.Get("cx").As<Napi::Number>().DoubleValue();
        double cy = edge.Get("cy").As<Napi::Number>().DoubleValue();
        double r = edge.Get("r").As<Napi::Number>().DoubleValue();
        double startAngle = edge.Get("startAngle").As<Napi::Number>().DoubleValue();
        double endAngle = edge.Get("endAngle").As<Napi::Number>().DoubleValue();

        double sweep = endAngle - startAngle;
        if (sweep <= 0) sweep += 2.0 * M_PI;
        double midA = startAngle + sweep / 2.0;

        gp_Pnt sp = to3D(cx + r * cos(startAngle), cy + r * sin(startAngle));
        gp_Pnt mp = to3D(cx + r * cos(midA), cy + r * sin(midA));
        gp_Pnt ep = to3D(cx + r * cos(endAngle), cy + r * sin(endAngle));

        GC_MakeArcOfCircle arcMaker(sp, mp, ep);
        if (arcMaker.IsDone()) {
          BRepBuilderAPI_MakeEdge edgeMaker(arcMaker.Value());
          if (edgeMaker.IsDone()) wireMaker.Add(edgeMaker.Edge());
        }

      } else if (type == "circle") {
        double cx = edge.Get("cx").As<Napi::Number>().DoubleValue();
        double cy = edge.Get("cy").As<Napi::Number>().DoubleValue();
        double r = edge.Get("r").As<Napi::Number>().DoubleValue();

        gp_Pnt center = to3D(cx, cy);
        // Normal = u x v
        gp_Vec normal = uDir.Crossed(vDir);
        if (normal.Magnitude() < 1e-10) {
          continue;
        }
        normal.Normalize();
        gp_Dir nDir(normal);
        gp_Ax2 ax(center, nDir);
        gp_Circ circ(ax, r);
        BRepBuilderAPI_MakeEdge edgeMaker(circ);
        if (edgeMaker.IsDone()) wireMaker.Add(edgeMaker.Edge());
      }
    }

    if (!wireMaker.IsDone()) {
      Napi::Error::New(env, "Wire construction failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    TopoDS_Wire wire = wireMaker.Wire();

    // Wire -> Face
    BRepBuilderAPI_MakeFace faceMaker(wire, true);
    if (!faceMaker.IsDone()) {
      Napi::Error::New(env, "Face construction failed").ThrowAsJavaScriptException();
      return env.Null();
    }
    TopoDS_Face face = faceMaker.Face();

    // Face -> Prism (extrusion)
    gp_Vec normalVec = uDir.Crossed(vDir);
    normalVec.Normalize();
    double d = depth * direction;
    gp_Vec extrudeDir(normalVec.X() * d, normalVec.Y() * d, normalVec.Z() * d);

    BRepPrimAPI_MakePrism prismMaker(face, extrudeDir, false, true);
    prismMaker.Build();
    if (!prismMaker.IsDone()) {
      Napi::Error::New(env, "Prism construction failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    TopoDS_Shape prismShape = prismMaker.Shape();
    int handle = ShapeStore::instance().store(prismShape);

    // Tessellate and return
    Napi::Object result = Napi::Object::New(env);
    result.Set("shapeHandle", handle);
    result.Set("mesh", tessellateToJs(env, prismShape));
    return result;

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("BuildPrism failed: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// --- PerformBoolean ---
// Args: shapeHandle1 (number), shapeHandle2 (number), operation ("fuse"|"cut")

Napi::Value PerformBoolean(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3) {
    Napi::TypeError::New(env, "PerformBoolean requires: handle1, handle2, operation").ThrowAsJavaScriptException();
    return env.Null();
  }

  int h1 = info[0].As<Napi::Number>().Int32Value();
  int h2 = info[1].As<Napi::Number>().Int32Value();
  std::string op = info[2].As<Napi::String>().Utf8Value();

  const TopoDS_Shape* shape1 = ShapeStore::instance().get(h1);
  const TopoDS_Shape* shape2 = ShapeStore::instance().get(h2);

  if (!shape1 || !shape2) {
    Napi::Error::New(env, "Shape handle not found").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    TopoDS_Shape resultShape;

    if (op == "fuse") {
      BRepAlgoAPI_Fuse fuse(*shape1, *shape2);
      fuse.Build();
      if (!fuse.IsDone()) {
        Napi::Error::New(env, "Boolean Fuse failed").ThrowAsJavaScriptException();
        return env.Null();
      }
      resultShape = fuse.Shape();
    } else if (op == "cut") {
      BRepAlgoAPI_Cut cut(*shape1, *shape2);
      cut.Build();
      if (!cut.IsDone()) {
        Napi::Error::New(env, "Boolean Cut failed").ThrowAsJavaScriptException();
        return env.Null();
      }
      resultShape = cut.Shape();
    } else {
      Napi::Error::New(env, "Unknown operation: use 'fuse' or 'cut'").ThrowAsJavaScriptException();
      return env.Null();
    }

    int handle = ShapeStore::instance().store(resultShape);

    Napi::Object result = Napi::Object::New(env);
    result.Set("shapeHandle", handle);
    result.Set("mesh", tessellateToJs(env, resultShape));
    return result;

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("Boolean failed: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// --- TessellateShape ---
// Args: shapeHandle (number)

Napi::Value TessellateShape(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "shapeHandle (number) required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int handle = info[0].As<Napi::Number>().Int32Value();
  const TopoDS_Shape* shape = ShapeStore::instance().get(handle);
  if (!shape) {
    Napi::Error::New(env, "Shape handle not found").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    return tessellateToJs(env, *shape);
  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("Tessellation failed: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// Tessellate with face-indexed groups — triangle index ranges per OCCT face
// NOTE: face iteration order must match GetShapeTopology (TopExp_Explorer without dedup)
// so that faceGroups[i] corresponds to topology.faces[i]
Napi::Value TessellateShapeWithTopology(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "shapeHandle (number) required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int handle = info[0].As<Napi::Number>().Int32Value();
  const TopoDS_Shape* shape = ShapeStore::instance().get(handle);
  if (!shape) {
    Napi::Error::New(env, "Shape handle not found").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    double deflection = computeDeflection(*shape);
    BRepMesh_IncrementalMesh mesher(*shape, deflection, Standard_False, 0.5);
    mesher.Perform();
    BRepLib::EnsureNormalConsistency(*shape);

    std::vector<float> positions, normals;
    std::vector<uint32_t> indices;
    // Per-face group: { firstTriangleIndex, triangleCount }
    std::vector<std::pair<int,int>> faceGroups;
    int vertexOffset = 0;
    int triangleOffset = 0;

    for (TopExp_Explorer faceExp(*shape, TopAbs_FACE); faceExp.More(); faceExp.Next()) {
      TopoDS_Face face = TopoDS::Face(faceExp.Current());
      TopLoc_Location location;
      Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, location);
      if (tri.IsNull()) {
        faceGroups.push_back({triangleOffset, 0});
        continue;
      }

      int nbNodes = tri->NbNodes();
      int nbTriangles = tri->NbTriangles();
      gp_Trsf trsf = location.Transformation();
      bool reversed = (face.Orientation() == TopAbs_REVERSED);

      for (int i = 1; i <= nbNodes; i++) {
        gp_Pnt pnt = tri->Node(i).Transformed(trsf);
        positions.push_back((float)pnt.X());
        positions.push_back((float)pnt.Y());
        positions.push_back((float)pnt.Z());

        bool gotNormal = false;
        if (tri->HasNormals()) {
          try {
            gp_Vec nv(tri->Normal(i));
            gp_Vec transformed = nv.Transformed(trsf);
            double len = transformed.Magnitude();
            float sign = reversed ? -1.0f : 1.0f;
            if (len > 1e-10) {
              normals.push_back((float)(transformed.X() / len) * sign);
              normals.push_back((float)(transformed.Y() / len) * sign);
              normals.push_back((float)(transformed.Z() / len) * sign);
            } else {
              normals.push_back(0.0f); normals.push_back(0.0f); normals.push_back(1.0f);
            }
            gotNormal = true;
          } catch (...) {}
        }
        if (!gotNormal) {
          normals.push_back(0.0f); normals.push_back(0.0f); normals.push_back(1.0f);
        }
      }

      for (int i = 1; i <= nbTriangles; i++) {
        int n1, n2, n3;
        tri->Triangle(i).Get(n1, n2, n3);
        n1 = n1 - 1 + vertexOffset;
        n2 = n2 - 1 + vertexOffset;
        n3 = n3 - 1 + vertexOffset;
        if (reversed) {
          indices.push_back(n1); indices.push_back(n3); indices.push_back(n2);
        } else {
          indices.push_back(n1); indices.push_back(n2); indices.push_back(n3);
        }
      }

      faceGroups.push_back({triangleOffset, nbTriangles});
      vertexOffset += nbNodes;
      triangleOffset += nbTriangles;
    }

    Napi::Object result = Napi::Object::New(env);
    {
      size_t byteLen = positions.size() * sizeof(float);
      auto buf = Napi::ArrayBuffer::New(env, byteLen);
      memcpy(buf.Data(), positions.data(), byteLen);
      result.Set("positions", Napi::Float32Array::New(env, positions.size(), buf, 0));
    }
    {
      size_t byteLen = normals.size() * sizeof(float);
      auto buf = Napi::ArrayBuffer::New(env, byteLen);
      memcpy(buf.Data(), normals.data(), byteLen);
      result.Set("normals", Napi::Float32Array::New(env, normals.size(), buf, 0));
    }
    {
      size_t byteLen = indices.size() * sizeof(uint32_t);
      auto buf = Napi::ArrayBuffer::New(env, byteLen);
      memcpy(buf.Data(), indices.data(), byteLen);
      result.Set("indices", Napi::Uint32Array::New(env, indices.size(), buf, 0));
    }
    // Face groups: array of {first, count} — triangle index ranges per OCCT face
    Napi::Array fgArr = Napi::Array::New(env, faceGroups.size());
    for (size_t i = 0; i < faceGroups.size(); i++) {
      Napi::Object fg = Napi::Object::New(env);
      fg.Set("first", faceGroups[i].first);
      fg.Set("count", faceGroups[i].second);
      fgArr.Set((uint32_t)i, fg);
    }
    result.Set("faceGroups", fgArr);
    return result;

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("Tessellation failed: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// --- BuildRevolution ---
// Args: profiles (array), plane {origin, u, v}, axisOrigin {x,y,z}, axisDir {x,y,z}, angle (degrees)

Napi::Value BuildRevolution(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 5) {
    Napi::TypeError::New(env, "BuildRevolution requires: profiles, plane, axisOrigin, axisDir, angle").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array profiles = info[0].As<Napi::Array>();
  Napi::Object planeObj = info[1].As<Napi::Object>();
  Napi::Object axisOriginObj = info[2].As<Napi::Object>();
  Napi::Object axisDirObj = info[3].As<Napi::Object>();
  double angleDeg = info[4].As<Napi::Number>().DoubleValue();

  auto getVec3 = [](Napi::Object obj) -> gp_Pnt {
    return gp_Pnt(obj.Get("x").As<Napi::Number>().DoubleValue(),
                  obj.Get("y").As<Napi::Number>().DoubleValue(),
                  obj.Get("z").As<Napi::Number>().DoubleValue());
  };

  gp_Pnt origin = getVec3(planeObj.Get("origin").As<Napi::Object>());
  gp_Pnt uPt = getVec3(planeObj.Get("u").As<Napi::Object>());
  gp_Pnt vPt = getVec3(planeObj.Get("v").As<Napi::Object>());
  gp_Vec uDir(uPt.X(), uPt.Y(), uPt.Z());
  gp_Vec vDir(vPt.X(), vPt.Y(), vPt.Z());

  gp_Pnt axOrigin = getVec3(axisOriginObj);
  gp_Pnt axDirPt = getVec3(axisDirObj);
  gp_Dir axDir(axDirPt.X(), axDirPt.Y(), axDirPt.Z());

  auto to3D = [&](double x, double y) -> gp_Pnt {
    return gp_Pnt(origin.X() + x * uDir.X() + y * vDir.X(),
                  origin.Y() + x * uDir.Y() + y * vDir.Y(),
                  origin.Z() + x * uDir.Z() + y * vDir.Z());
  };

  try {
    // Build wire (same as BuildPrism)
    BRepBuilderAPI_MakeWire wireMaker;
    for (uint32_t i = 0; i < profiles.Length(); i++) {
      Napi::Object edge = profiles.Get(i).As<Napi::Object>();
      std::string type = edge.Get("type").As<Napi::String>().Utf8Value();

      if (type == "line") {
        gp_Pnt p1 = to3D(edge.Get("x1").As<Napi::Number>().DoubleValue(), edge.Get("y1").As<Napi::Number>().DoubleValue());
        gp_Pnt p2 = to3D(edge.Get("x2").As<Napi::Number>().DoubleValue(), edge.Get("y2").As<Napi::Number>().DoubleValue());
        BRepBuilderAPI_MakeEdge em(p1, p2);
        if (em.IsDone()) wireMaker.Add(em.Edge());
      } else if (type == "arc") {
        double cx = edge.Get("cx").As<Napi::Number>().DoubleValue();
        double cy = edge.Get("cy").As<Napi::Number>().DoubleValue();
        double r = edge.Get("r").As<Napi::Number>().DoubleValue();
        double sa = edge.Get("startAngle").As<Napi::Number>().DoubleValue();
        double ea = edge.Get("endAngle").As<Napi::Number>().DoubleValue();
        double sweep = ea - sa; if (sweep <= 0) sweep += 2.0 * M_PI;
        double ma = sa + sweep / 2.0;
        GC_MakeArcOfCircle am(to3D(cx + r*cos(sa), cy + r*sin(sa)),
                              to3D(cx + r*cos(ma), cy + r*sin(ma)),
                              to3D(cx + r*cos(ea), cy + r*sin(ea)));
        if (am.IsDone()) { BRepBuilderAPI_MakeEdge em(am.Value()); if (em.IsDone()) wireMaker.Add(em.Edge()); }
      } else if (type == "circle") {
        double cx = edge.Get("cx").As<Napi::Number>().DoubleValue();
        double cy = edge.Get("cy").As<Napi::Number>().DoubleValue();
        double r = edge.Get("r").As<Napi::Number>().DoubleValue();
        gp_Vec normal = uDir.Crossed(vDir); normal.Normalize();
        gp_Circ circ(gp_Ax2(to3D(cx, cy), gp_Dir(normal)), r);
        BRepBuilderAPI_MakeEdge em(circ);
        if (em.IsDone()) wireMaker.Add(em.Edge());
      }
    }

    if (!wireMaker.IsDone()) {
      Napi::Error::New(env, "Revolution: Wire failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    BRepBuilderAPI_MakeFace faceMaker(wireMaker.Wire(), true);
    if (!faceMaker.IsDone()) {
      Napi::Error::New(env, "Revolution: Face failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    gp_Ax1 revolveAxis(axOrigin, axDir);
    double angleRad = angleDeg * M_PI / 180.0;

    BRepPrimAPI_MakeRevol revolMaker(faceMaker.Face(), revolveAxis, angleRad, true);
    revolMaker.Build();
    if (!revolMaker.IsDone()) {
      Napi::Error::New(env, "Revolution failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    TopoDS_Shape revolShape = revolMaker.Shape();
    int handle = ShapeStore::instance().store(revolShape);

    Napi::Object result = Napi::Object::New(env);
    result.Set("shapeHandle", handle);
    result.Set("mesh", tessellateToJs(env, revolShape));
    return result;

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("Revolution failed: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// --- ApplyFillet ---
// Args: shapeHandle (number), radius (number), edgeIndices (array of numbers)

Napi::Value ApplyFillet(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2) {
    Napi::TypeError::New(env, "ApplyFillet requires: shapeHandle, radius").ThrowAsJavaScriptException();
    return env.Null();
  }

  int handle = info[0].As<Napi::Number>().Int32Value();
  double radius = info[1].As<Napi::Number>().DoubleValue();

  const TopoDS_Shape* shape = ShapeStore::instance().get(handle);
  if (!shape) {
    Napi::Error::New(env, "Shape handle not found").ThrowAsJavaScriptException();
    return env.Null();
  }

  // Optional: specific edge indices to fillet
  std::set<int> edgeFilter;
  if (info.Length() >= 3 && info[2].IsArray()) {
    Napi::Array arr = info[2].As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length(); i++) {
      edgeFilter.insert(arr.Get(i).As<Napi::Number>().Int32Value());
    }
  }

  try {
    BRepFilletAPI_MakeFillet fillet(*shape);

    int edgeIdx = 0;
    for (TopExp_Explorer exp(*shape, TopAbs_EDGE); exp.More(); exp.Next()) {
      if (edgeFilter.empty() || edgeFilter.count(edgeIdx)) {
        fillet.Add(radius, TopoDS::Edge(exp.Current()));
      }
      edgeIdx++;
    }

    fillet.Build();
    if (!fillet.IsDone()) {
      Napi::Error::New(env, "Fillet failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    TopoDS_Shape result = fillet.Shape();
    int newHandle = ShapeStore::instance().store(result);

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("shapeHandle", newHandle);
    obj.Set("mesh", tessellateToJs(env, result));
    return obj;

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("Fillet failed: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// --- ApplyChamfer ---
// Args: shapeHandle (number), distance (number), edgeIndices (array of numbers)

Napi::Value ApplyChamfer(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2) {
    Napi::TypeError::New(env, "ApplyChamfer requires: shapeHandle, distance").ThrowAsJavaScriptException();
    return env.Null();
  }

  int handle = info[0].As<Napi::Number>().Int32Value();
  double distance = info[1].As<Napi::Number>().DoubleValue();

  const TopoDS_Shape* shape = ShapeStore::instance().get(handle);
  if (!shape) {
    Napi::Error::New(env, "Shape handle not found").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::set<int> edgeFilter;
  if (info.Length() >= 3 && info[2].IsArray()) {
    Napi::Array arr = info[2].As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length(); i++) {
      edgeFilter.insert(arr.Get(i).As<Napi::Number>().Int32Value());
    }
  }

  try {
    BRepFilletAPI_MakeChamfer chamfer(*shape);

    int edgeIdx = 0;
    for (TopExp_Explorer exp(*shape, TopAbs_EDGE); exp.More(); exp.Next()) {
      if (edgeFilter.empty() || edgeFilter.count(edgeIdx)) {
        chamfer.Add(distance, TopoDS::Edge(exp.Current()));
      }
      edgeIdx++;
    }

    chamfer.Build();
    if (!chamfer.IsDone()) {
      Napi::Error::New(env, "Chamfer failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    TopoDS_Shape result = chamfer.Shape();
    int newHandle = ShapeStore::instance().store(result);

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("shapeHandle", newHandle);
    obj.Set("mesh", tessellateToJs(env, result));
    return obj;

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("Chamfer failed: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// --- ApplyShell ---
// Args: shapeHandle (number), thickness (number), openFaceIndices? (array)

Napi::Value ApplyShell(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2) {
    Napi::TypeError::New(env, "ApplyShell requires: shapeHandle, thickness").ThrowAsJavaScriptException();
    return env.Null();
  }

  int handle = info[0].As<Napi::Number>().Int32Value();
  double thickness = info[1].As<Napi::Number>().DoubleValue();

  const TopoDS_Shape* shape = ShapeStore::instance().get(handle);
  if (!shape) {
    Napi::Error::New(env, "Shape handle not found").ThrowAsJavaScriptException();
    return env.Null();
  }

  // Open faces to remove
  std::set<int> openFaces;
  if (info.Length() >= 3 && info[2].IsArray()) {
    Napi::Array arr = info[2].As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length(); i++) {
      openFaces.insert(arr.Get(i).As<Napi::Number>().Int32Value());
    }
  }

  try {
    TopTools_ListOfShape facesToRemove;
    if (!openFaces.empty()) {
      int faceIdx = 0;
      for (TopExp_Explorer exp(*shape, TopAbs_FACE); exp.More(); exp.Next()) {
        if (openFaces.count(faceIdx)) {
          facesToRemove.Append(exp.Current());
        }
        faceIdx++;
      }
    }

    BRepOffsetAPI_MakeThickSolid shellMaker;
    shellMaker.MakeThickSolidByJoin(*shape, facesToRemove, -thickness, 1e-3);
    shellMaker.Build();

    if (!shellMaker.IsDone()) {
      Napi::Error::New(env, "Shell failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    TopoDS_Shape result = shellMaker.Shape();
    int newHandle = ShapeStore::instance().store(result);

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("shapeHandle", newHandle);
    obj.Set("mesh", tessellateToJs(env, result));
    return obj;

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("Shell failed: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

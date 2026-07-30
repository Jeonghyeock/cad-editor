// SketchBuilder: 2D sketch geometry to OCCT 3D Wire/Face

#ifdef HAVE_OCCT

#include "sketch_builder.h"
#include "shape_store.h"

#include <cmath>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>
#include <gp_Circ.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Wire.hxx>
#include <TopoDS_Face.hxx>

// 2D to 3D coordinate transform
static gp_Pnt toWorld3D(
  double x2d, double y2d,
  const gp_Pnt& origin, const gp_Vec& u, const gp_Vec& v
) {
  return gp_Pnt(
    origin.X() + x2d * u.X() + y2d * v.X(),
    origin.Y() + x2d * u.Y() + y2d * v.Y(),
    origin.Z() + x2d * u.Z() + y2d * v.Z()
  );
}

static gp_Pnt readPnt(Napi::Object obj) {
  return gp_Pnt(
    obj.Get("x").As<Napi::Number>().DoubleValue(),
    obj.Get("y").As<Napi::Number>().DoubleValue(),
    obj.Get("z").As<Napi::Number>().DoubleValue()
  );
}

static gp_Vec readVec(Napi::Object obj) {
  return gp_Vec(
    obj.Get("x").As<Napi::Number>().DoubleValue(),
    obj.Get("y").As<Napi::Number>().DoubleValue(),
    obj.Get("z").As<Napi::Number>().DoubleValue()
  );
}

static TopoDS_Edge buildEdge(
  Napi::Object edgeData,
  const gp_Pnt& origin, const gp_Vec& u, const gp_Vec& v
) {
  std::string type = edgeData.Get("type").As<Napi::String>().Utf8Value();

  if (type == "line") {
    double x1 = edgeData.Get("x1").As<Napi::Number>().DoubleValue();
    double y1 = edgeData.Get("y1").As<Napi::Number>().DoubleValue();
    double x2 = edgeData.Get("x2").As<Napi::Number>().DoubleValue();
    double y2 = edgeData.Get("y2").As<Napi::Number>().DoubleValue();
    gp_Pnt p1 = toWorld3D(x1, y1, origin, u, v);
    gp_Pnt p2 = toWorld3D(x2, y2, origin, u, v);
    return BRepBuilderAPI_MakeEdge(p1, p2).Edge();
  }

  if (type == "arc") {
    double cx = edgeData.Get("cx").As<Napi::Number>().DoubleValue();
    double cy = edgeData.Get("cy").As<Napi::Number>().DoubleValue();
    double r = edgeData.Get("r").As<Napi::Number>().DoubleValue();
    double sa = edgeData.Get("startAngle").As<Napi::Number>().DoubleValue();
    double ea = edgeData.Get("endAngle").As<Napi::Number>().DoubleValue();

    gp_Pnt start = toWorld3D(cx + r * std::cos(sa), cy + r * std::sin(sa), origin, u, v);
    gp_Pnt mid = toWorld3D(cx + r * std::cos((sa + ea) / 2), cy + r * std::sin((sa + ea) / 2), origin, u, v);
    gp_Pnt end = toWorld3D(cx + r * std::cos(ea), cy + r * std::sin(ea), origin, u, v);

    GC_MakeArcOfCircle arcMaker(start, mid, end);
    if (arcMaker.IsDone()) {
      return BRepBuilderAPI_MakeEdge(arcMaker.Value()).Edge();
    }
    return BRepBuilderAPI_MakeEdge(start, end).Edge();
  }

  if (type == "circle") {
    double cx = edgeData.Get("cx").As<Napi::Number>().DoubleValue();
    double cy = edgeData.Get("cy").As<Napi::Number>().DoubleValue();
    double r = edgeData.Get("r").As<Napi::Number>().DoubleValue();

    gp_Pnt center = toWorld3D(cx, cy, origin, u, v);
    gp_Vec normal = u.Crossed(v);
    if (normal.Magnitude() < 1e-10) normal = gp_Vec(0, 0, 1);
    normal.Normalize();

    gp_Ax2 axis(center, gp_Dir(normal));
    gp_Circ circ(axis, r);
    return BRepBuilderAPI_MakeEdge(circ).Edge();
  }

  return TopoDS_Edge();
}

// --- NAPI ---

Napi::Value MakeWireFromSketch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 4) {
    Napi::TypeError::New(env, "MakeWireFromSketch requires 4 args").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array edges = info[0].As<Napi::Array>();
  gp_Pnt origin = readPnt(info[1].As<Napi::Object>());
  gp_Vec u = readVec(info[2].As<Napi::Object>());
  gp_Vec v = readVec(info[3].As<Napi::Object>());

  BRepBuilderAPI_MakeWire wireMaker;

  for (uint32_t i = 0; i < edges.Length(); i++) {
    Napi::Object edgeData = edges.Get(i).As<Napi::Object>();
    try {
      TopoDS_Edge edge = buildEdge(edgeData, origin, u, v);
      if (!edge.IsNull()) {
        wireMaker.Add(edge);
      }
    } catch (...) {
      // skip failed edge
    }
  }

  if (!wireMaker.IsDone()) {
    Napi::Error::New(env, "Wire construction failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  int handle = ShapeStore::instance().store(wireMaker.Wire());
  return Napi::Number::New(env, handle);
}

Napi::Value MakeFaceFromWire(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "MakeFaceFromWire requires wireHandle").ThrowAsJavaScriptException();
    return env.Null();
  }

  int wireHandle = info[0].As<Napi::Number>().Int32Value();
  const TopoDS_Shape* wireShape = ShapeStore::instance().get(wireHandle);
  if (!wireShape || wireShape->ShapeType() != TopAbs_WIRE) {
    Napi::Error::New(env, "Invalid wire handle").ThrowAsJavaScriptException();
    return env.Null();
  }

  BRepBuilderAPI_MakeFace faceMaker(TopoDS::Wire(*wireShape));

  if (info.Length() >= 2 && info[1].IsArray()) {
    Napi::Array holeHandles = info[1].As<Napi::Array>();
    for (uint32_t i = 0; i < holeHandles.Length(); i++) {
      int holeHandle = holeHandles.Get(i).As<Napi::Number>().Int32Value();
      const TopoDS_Shape* holeShape = ShapeStore::instance().get(holeHandle);
      if (holeShape && holeShape->ShapeType() == TopAbs_WIRE) {
        faceMaker.Add(TopoDS::Wire(holeShape->Reversed()));
      }
    }
  }

  if (!faceMaker.IsDone()) {
    Napi::Error::New(env, "Face construction failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  int handle = ShapeStore::instance().store(faceMaker.Face());
  return Napi::Number::New(env, handle);
}

Napi::Value MakeEdge(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 4) {
    Napi::TypeError::New(env, "MakeEdge requires 4 args").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object edgeData = info[0].As<Napi::Object>();
  gp_Pnt origin = readPnt(info[1].As<Napi::Object>());
  gp_Vec u = readVec(info[2].As<Napi::Object>());
  gp_Vec v = readVec(info[3].As<Napi::Object>());

  try {
    TopoDS_Edge edge = buildEdge(edgeData, origin, u, v);
    if (edge.IsNull()) return env.Null();
    int handle = ShapeStore::instance().store(edge);
    return Napi::Number::New(env, handle);
  } catch (...) {
    Napi::Error::New(env, "Edge construction failed").ThrowAsJavaScriptException();
    return env.Null();
  }
}

#endif

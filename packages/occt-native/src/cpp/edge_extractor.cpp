#include "edge_extractor.h"
#include "shape_store.h"

#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <GeomAbs_CurveType.hxx>
#include <gp_Pnt.hxx>
#include <BRep_Tool.hxx>
#include <TopoDS_Face.hxx>
#include <Standard_Failure.hxx>
#include <TopTools_MapOfShape.hxx>

#include <vector>
#include <set>
#include <cmath>

// Degenerate edge threshold
static const double DEGEN_THRESHOLD = 1e-10;

// Number of sampling points for unsupported curve types
static const int N_SAMPLES = 32;


// Helper: gp_Pnt -> Napi object {x, y, z}
static Napi::Object vec3ToJs(Napi::Env env, double x, double y, double z) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("x", x);
  obj.Set("y", y);
  obj.Set("z", z);
  return obj;
}

static Napi::Object pntToJs(Napi::Env env, const gp_Pnt& p) {
  return vec3ToJs(env, p.X(), p.Y(), p.Z());
}

static Napi::Object dirToJs(Napi::Env env, const gp_Dir& d) {
  return vec3ToJs(env, d.X(), d.Y(), d.Z());
}

// Extract a single edge curve to JS object
static Napi::Value extractCurve(Napi::Env env, const TopoDS_Edge& edge) {
  BRepAdaptor_Curve adaptor(edge);
  GeomAbs_CurveType curveType = adaptor.GetType();
  double t0 = adaptor.FirstParameter();
  double t1 = adaptor.LastParameter();

  // Skip degenerate edges
  if (std::abs(t1 - t0) < DEGEN_THRESHOLD) {
    return env.Null();
  }


  Napi::Object result = Napi::Object::New(env);

  if (curveType == GeomAbs_Line) {
    gp_Pnt p0 = adaptor.Value(t0);
    gp_Pnt p1 = adaptor.Value(t1);
    result.Set("type", "line");
    result.Set("start", pntToJs(env, p0));
    result.Set("end", pntToJs(env, p1));

  } else {
    // All non-line curves: sample via adaptor.Value(t) + curveHint for downstream
    Napi::Array points = Napi::Array::New(env, N_SAMPLES + 1);
    for (int i = 0; i <= N_SAMPLES; i++) {
      double t = t0 + (double(i) / N_SAMPLES) * (t1 - t0);
      gp_Pnt p = adaptor.Value(t);
      points.Set((uint32_t)i, pntToJs(env, p));
    }
    result.Set("type", "other");
    result.Set("points", points);

    // Curve type hint for joint detection (circle = revolute joint candidate)
    if (curveType == GeomAbs_Circle) {
      result.Set("curveHint", "circle");
      // Reconstruct center/radius from 3 sampled points
      double sweep = t1 - t0;
      gp_Pnt pA = adaptor.Value(t0);
      gp_Pnt pB = adaptor.Value(t0 + sweep / 3.0);
      gp_Pnt pC = adaptor.Value(t0 + sweep * 2.0 / 3.0);
      gp_Vec AB(pA, pB), AC(pA, pC);
      gp_Vec norm = AB.Crossed(AC);
      double nLen = norm.Magnitude();
      if (nLen > 1e-10) {
        norm.Divide(nLen);
        gp_Pnt midAB((pA.X()+pB.X())/2, (pA.Y()+pB.Y())/2, (pA.Z()+pB.Z())/2);
        gp_Pnt midAC((pA.X()+pC.X())/2, (pA.Y()+pC.Y())/2, (pA.Z()+pC.Z())/2);
        gp_Vec bisAB = AB.Crossed(norm), bisAC = AC.Crossed(norm);
        gp_Vec diff(midAB, midAC);
        double d1 = bisAB.Dot(bisAB), d2 = bisAB.Dot(bisAC), d3 = bisAC.Dot(bisAC);
        double d4 = diff.Dot(bisAB), d5 = diff.Dot(bisAC);
        double denom = d1 * d3 - d2 * d2;
        if (std::abs(denom) > 1e-15) {
          double s = (d4 * d3 - d5 * d2) / denom;
          gp_Pnt center(midAB.X() + s*bisAB.X(), midAB.Y() + s*bisAB.Y(), midAB.Z() + s*bisAB.Z());
          result.Set("hintCenter", pntToJs(env, center));
          result.Set("hintRadius", center.Distance(pA));
          result.Set("hintAxis", vec3ToJs(env, norm.X(), norm.Y(), norm.Z()));
        }
      }
    } else if (curveType == GeomAbs_Ellipse) {
      result.Set("curveHint", "ellipse");
    } else if (curveType == GeomAbs_BSplineCurve) {
      result.Set("curveHint", "bspline");
    }
  }

  return result;
}

// --- Main API ---

Napi::Value ExtractEdges(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  // Args: shapeHandle (number), excludedSolidIndices (optional array of numbers)
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

  // Parse excluded solid indices
  std::set<int> excluded;
  if (info.Length() >= 2 && info[1].IsArray()) {
    Napi::Array arr = info[1].As<Napi::Array>();
    for (uint32_t i = 0; i < arr.Length(); i++) {
      Napi::Value v = arr.Get(i);
      if (v.IsNumber()) {
        excluded.insert(v.As<Napi::Number>().Int32Value());
      }
    }
  }

  // Collect edges, deduplicating by TopTools_MapOfShape
  TopTools_MapOfShape processedEdges;
  Napi::Array results = Napi::Array::New(env);
  uint32_t resultIdx = 0;

  auto processShape = [&](const TopoDS_Shape& s, int solidIndex) {
    // Detect seam edges: collect IsClosed edges per face
    TopTools_MapOfShape seamEdges;
    for (TopExp_Explorer faceExp(s, TopAbs_FACE); faceExp.More(); faceExp.Next()) {
      TopoDS_Face face = TopoDS::Face(faceExp.Current());
      for (TopExp_Explorer edgeExp(face, TopAbs_EDGE); edgeExp.More(); edgeExp.Next()) {
        TopoDS_Edge edge = TopoDS::Edge(edgeExp.Current());
        if (BRep_Tool::IsClosed(edge, face)) {
          seamEdges.Add(edge);
        }
      }
    }

    for (TopExp_Explorer edgeExp(s, TopAbs_EDGE); edgeExp.More(); edgeExp.Next()) {
      TopoDS_Edge edge = TopoDS::Edge(edgeExp.Current());
      if (!processedEdges.Add(edge)) continue;
      if (seamEdges.Contains(edge)) continue; // skip seam edges

      try {
        Napi::Value curve = extractCurve(env, edge);
        if (!curve.IsNull()) {
          Napi::Object obj = curve.As<Napi::Object>();
          obj.Set("solidIndex", solidIndex);
          results.Set(resultIdx++, curve);
        }
      } catch (...) {
        // Skip problematic edges
      }
    }
  };

  // Always iterate by solid to avoid assembly-level construction geometry
  int solidIdx = 0;
  for (TopExp_Explorer solidExp(*shape, TopAbs_SOLID); solidExp.More(); solidExp.Next()) {
    if (excluded.empty() || excluded.count(solidIdx) == 0) {
      processShape(solidExp.Current(), solidIdx);
    }
    solidIdx++;
  }

  return results;
}



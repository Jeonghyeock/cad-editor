// PartDocument: Parametric Feature Tree management
// Feature chain: Sketch -> Pad/Pocket -> Fillet/Chamfer -> ...
// Each feature maps input shape handle -> output shape handle

#ifdef HAVE_OCCT

#include "part_document.h"
#include "shape_store.h"
#include "boolean_ops.h"

#include <vector>
#include <string>
#include <set>
#include <unordered_map>
#include <mutex>

#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_MapOfShape.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRep_Tool.hxx>
#include <GeomAbs_CurveType.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <gp_Vec.hxx>
#include <gp_Dir.hxx>
#include <gp_Ax1.hxx>
#include <STEPControl_Writer.hxx>
#include <IGESControl_Writer.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>

#include <sstream>

// --- Feature data ---

struct Feature {
  std::string id;
  std::string type; // "sketch", "pad", "pocket", "revolve", "fillet", "chamfer"
  int inputHandle = 0;
  int outputHandle = 0;

  // Parameters (per type)
  double depth = 0;
  double angle = 0;   // revolve angle (radians)
  double radius = 0;
  double distance = 0;
  // direction vector (pad/pocket extrusion direction)
  double dirX = 0, dirY = 0, dirZ = 1;
  std::vector<int> edgeIndices; // fillet/chamfer target edges
  // axis (revolve)
  double axisOriginX = 0, axisOriginY = 0, axisOriginZ = 0;
  double axisDirX = 0, axisDirY = 1, axisDirZ = 0;
};

struct Document {
  std::vector<Feature> features;
  int nextFeatureId = 1;
};

// --- Document Store ---

static std::unordered_map<int, Document> s_documents;
static std::mutex s_docMutex;
static int s_nextDocId = 1;

// --- Helper: find last solid handle before given index ---

static int getLastSolidHandle(const Document& doc, int beforeIndex = -1) {
  int end = (beforeIndex < 0) ? (int)doc.features.size() - 1 : beforeIndex - 1;
  for (int i = end; i >= 0; i--) {
    // sketch feature 의 outputHandle 은 솔리드가 아니라 스케치 면(face) handle 이다.
    // 이를 솔리드로 잡으면 Pocket 이 Cut(스케치 면, prism) 으로 빈 결과가 되고, Pad 는 앞 솔리드 대신 면과 합쳐진다
    if (doc.features[i].type == "sketch") continue;
    if (doc.features[i].outputHandle > 0) return doc.features[i].outputHandle;
  }
  return 0;
}

// --- Helper: rebuild a single feature from its stored parameters ---
// Returns new outputHandle, or 0 on failure
static int rebuildSingleFeature(Feature& f, int prevSolidHandle) {
  if (f.type == "sketch") {
    // Sketch face handle is immutable seed - no rebuild needed
    return f.outputHandle;
  }

  if (f.type == "pad") {
    const TopoDS_Shape* faceShape = ShapeStore::instance().get(f.inputHandle);
    if (!faceShape) return 0;

    gp_Vec dir(f.dirX, f.dirY, f.dirZ);
    if (dir.Magnitude() < 1e-10) return 0;
    dir.Normalize();
    dir *= f.depth;

    try {
      BRepPrimAPI_MakePrism prism(*faceShape, dir);
      if (!prism.IsDone()) return 0;

      TopoDS_Shape solidShape = prism.Shape();
      if (prevSolidHandle > 0) {
        const TopoDS_Shape* existing = ShapeStore::instance().get(prevSolidHandle);
        if (existing) {
          BRepAlgoAPI_Fuse fuse(*existing, solidShape);
          if (fuse.IsDone()) return ShapeStore::instance().store(fuse.Shape());
        }
      }
      return ShapeStore::instance().store(solidShape);
    } catch (...) { return 0; }
  }

  if (f.type == "pocket") {
    const TopoDS_Shape* faceShape = ShapeStore::instance().get(f.inputHandle);
    if (!faceShape || prevSolidHandle <= 0) return 0;
    const TopoDS_Shape* existing = ShapeStore::instance().get(prevSolidHandle);
    if (!existing) return 0;

    gp_Vec dir(f.dirX, f.dirY, f.dirZ);
    if (dir.Magnitude() < 1e-10) return 0;
    dir.Normalize();
    dir *= f.depth;

    try {
      BRepPrimAPI_MakePrism prism(*faceShape, dir);
      if (!prism.IsDone()) return 0;
      BRepAlgoAPI_Cut cut(*existing, prism.Shape());
      if (!cut.IsDone()) return 0;
      return ShapeStore::instance().store(cut.Shape());
    } catch (...) { return 0; }
  }

  if (f.type == "revolve") {
    const TopoDS_Shape* faceShape = ShapeStore::instance().get(f.inputHandle);
    if (!faceShape) return 0;

    double adMag = std::sqrt(f.axisDirX*f.axisDirX + f.axisDirY*f.axisDirY + f.axisDirZ*f.axisDirZ);
    if (adMag < 1e-10) return 0;

    gp_Pnt axOrigin(f.axisOriginX, f.axisOriginY, f.axisOriginZ);
    gp_Dir axDir(f.axisDirX, f.axisDirY, f.axisDirZ);
    gp_Ax1 axis(axOrigin, axDir);

    try {
      BRepPrimAPI_MakeRevol revol(*faceShape, axis, f.angle);
      if (!revol.IsDone()) return 0;

      TopoDS_Shape revolShape = revol.Shape();
      if (prevSolidHandle > 0) {
        const TopoDS_Shape* existing = ShapeStore::instance().get(prevSolidHandle);
        if (existing) {
          BRepAlgoAPI_Fuse fuse(*existing, revolShape);
          if (fuse.IsDone()) return ShapeStore::instance().store(fuse.Shape());
        }
      }
      return ShapeStore::instance().store(revolShape);
    } catch (...) { return 0; }
  }

  if (f.type == "fillet") {
    if (prevSolidHandle <= 0) return 0;
    const TopoDS_Shape* solidShape = ShapeStore::instance().get(prevSolidHandle);
    if (!solidShape) return 0;

    try {
      BRepFilletAPI_MakeFillet fillet(TopoDS::Solid(*solidShape));
      std::vector<TopoDS_Edge> allEdges;
      for (TopExp_Explorer exp(*solidShape, TopAbs_EDGE); exp.More(); exp.Next()) {
        allEdges.push_back(TopoDS::Edge(exp.Current()));
      }
      for (int idx : f.edgeIndices) {
        if (idx >= 0 && idx < (int)allEdges.size()) {
          fillet.Add(f.radius, allEdges[idx]);
        }
      }
      fillet.Build();
      if (!fillet.IsDone()) return 0;
      return ShapeStore::instance().store(fillet.Shape());
    } catch (...) { return 0; }
  }

  if (f.type == "chamfer") {
    if (prevSolidHandle <= 0) return 0;
    const TopoDS_Shape* solidShape = ShapeStore::instance().get(prevSolidHandle);
    if (!solidShape) return 0;

    try {
      BRepFilletAPI_MakeChamfer chamfer(TopoDS::Solid(*solidShape));
      std::vector<TopoDS_Edge> allEdges;
      for (TopExp_Explorer exp(*solidShape, TopAbs_EDGE); exp.More(); exp.Next()) {
        allEdges.push_back(TopoDS::Edge(exp.Current()));
      }
      for (int idx : f.edgeIndices) {
        if (idx >= 0 && idx < (int)allEdges.size()) {
          chamfer.Add(f.distance, allEdges[idx]);
        }
      }
      chamfer.Build();
      if (!chamfer.IsDone()) return 0;
      return ShapeStore::instance().store(chamfer.Shape());
    } catch (...) { return 0; }
  }

  return 0;
}

// Rebuild all features from startIdx onwards, releasing old handles
static bool rebuildFromIndex(Document& doc, int startIdx) {
  for (int i = startIdx; i < (int)doc.features.size(); i++) {
    Feature& f = doc.features[i];
    int oldHandle = f.outputHandle;

    // Find previous solid for context
    int prevSolid = getLastSolidHandle(doc, i);
    int newHandle = rebuildSingleFeature(f, prevSolid);

    if (newHandle > 0 && newHandle != oldHandle) {
      // Release old handle (skip sketch seed handles)
      if (oldHandle > 0 && f.type != "sketch") {
        ShapeStore::instance().release(oldHandle);
      }
      f.outputHandle = newHandle;
    } else if (newHandle == 0 && f.type != "sketch") {
      // Rebuild failed - mark as invalid
      if (oldHandle > 0) ShapeStore::instance().release(oldHandle);
      f.outputHandle = 0;
    }
  }
  return true;
}

// --- NAPI functions ---

Napi::Value CreateDocument(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> lock(s_docMutex);
  int docId = s_nextDocId++;
  s_documents[docId] = Document{};
  return Napi::Number::New(env, docId);
}

Napi::Value ReleaseDocument(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) return env.Undefined();
  int docId = info[0].As<Napi::Number>().Int32Value();
  std::lock_guard<std::mutex> lock(s_docMutex);

  auto it = s_documents.find(docId);
  if (it != s_documents.end()) {
    // Release all feature shape handles (output + input for pad/pocket/revolve face handles)
    std::set<int> released;
    for (auto& f : it->second.features) {
      if (f.outputHandle > 0 && released.find(f.outputHandle) == released.end()) {
        ShapeStore::instance().release(f.outputHandle);
        released.insert(f.outputHandle);
      }
      // pad/pocket/revolve의 inputHandle은 sketch face handle — 별도 해제 필요
      if (f.inputHandle > 0 && released.find(f.inputHandle) == released.end()) {
        ShapeStore::instance().release(f.inputHandle);
        released.insert(f.inputHandle);
      }
    }
    s_documents.erase(it);
  }
  return env.Undefined();
}

// Register sketch face handle in document
// args: docId, faceHandle
Napi::Value AddSketchFeature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "AddSketchFeature: docId, faceHandle required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int docId = info[0].As<Napi::Number>().Int32Value();
  int faceHandle = info[1].As<Napi::Number>().Int32Value();

  std::lock_guard<std::mutex> lock(s_docMutex);
  auto it = s_documents.find(docId);
  if (it == s_documents.end()) {
    Napi::Error::New(env, "Invalid document ID").ThrowAsJavaScriptException();
    return env.Null();
  }

  Feature f;
  f.id = "sketch_" + std::to_string(it->second.nextFeatureId++);
  f.type = "sketch";
  f.inputHandle = 0;
  f.outputHandle = faceHandle;

  it->second.features.push_back(f);

  Napi::Object result = Napi::Object::New(env);
  result.Set("featureId", f.id);
  result.Set("outputHandle", faceHandle);
  return result;
}

// Pad: face -> extrude -> solid
// args: docId, faceHandle, depth, direction{x,y,z}
Napi::Value AddPadFeature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4) {
    Napi::TypeError::New(env, "AddPadFeature: docId, faceHandle, depth, direction required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int docId = info[0].As<Napi::Number>().Int32Value();
  int faceHandle = info[1].As<Napi::Number>().Int32Value();
  double depth = info[2].As<Napi::Number>().DoubleValue();
  Napi::Object dirObj = info[3].As<Napi::Object>();
  double dx = dirObj.Get("x").As<Napi::Number>().DoubleValue();
  double dy = dirObj.Get("y").As<Napi::Number>().DoubleValue();
  double dz = dirObj.Get("z").As<Napi::Number>().DoubleValue();

  gp_Vec dir(dx, dy, dz);
  if (dir.Magnitude() < 1e-10) {
    Napi::Error::New(env, "Invalid direction: zero vector").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::lock_guard<std::mutex> lock(s_docMutex);

  const TopoDS_Shape* faceShape = ShapeStore::instance().get(faceHandle);
  if (!faceShape) {
    Napi::Error::New(env, "Invalid face handle").ThrowAsJavaScriptException();
    return env.Null();
  }

  dir.Normalize();
  dir *= depth;

  try {
    BRepPrimAPI_MakePrism prism(*faceShape, dir);
    if (!prism.IsDone()) {
      Napi::Error::New(env, "Prism construction failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    TopoDS_Shape solidShape = prism.Shape();
    auto docIt = s_documents.find(docId);
    if (docIt == s_documents.end()) {
      Napi::Error::New(env, "Invalid document ID").ThrowAsJavaScriptException();
      return env.Null();
    }

    int lastHandle = getLastSolidHandle(docIt->second);
    int outputHandle;

    if (lastHandle > 0) {
      const TopoDS_Shape* existing = ShapeStore::instance().get(lastHandle);
      if (existing) {
        BRepAlgoAPI_Fuse fuse(*existing, solidShape);
        if (fuse.IsDone()) {
          outputHandle = ShapeStore::instance().store(fuse.Shape());
        } else {
          outputHandle = ShapeStore::instance().store(solidShape);
        }
      } else {
        outputHandle = ShapeStore::instance().store(solidShape);
      }
    } else {
      outputHandle = ShapeStore::instance().store(solidShape);
    }

    Feature f;
    f.id = "pad_" + std::to_string(docIt->second.nextFeatureId++);
    f.type = "pad";
    f.inputHandle = faceHandle;
    f.outputHandle = outputHandle;
    f.depth = depth;
    f.dirX = dx; f.dirY = dy; f.dirZ = dz;
    docIt->second.features.push_back(f);

    // tessellate
    Napi::Object result = Napi::Object::New(env);
    result.Set("featureId", f.id);
    result.Set("outputHandle", outputHandle);
    // Only return handle, tessellation via separate tessellateShape call
    
    return result;

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("OCCT error: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// Pocket: face -> extrude -> Boolean Cut
Napi::Value AddPocketFeature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4) {
    Napi::TypeError::New(env, "AddPocketFeature: docId, faceHandle, depth, direction required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int docId = info[0].As<Napi::Number>().Int32Value();
  int faceHandle = info[1].As<Napi::Number>().Int32Value();
  double depth = info[2].As<Napi::Number>().DoubleValue();
  Napi::Object dirObj = info[3].As<Napi::Object>();
  double dx = dirObj.Get("x").As<Napi::Number>().DoubleValue();
  double dy = dirObj.Get("y").As<Napi::Number>().DoubleValue();
  double dz = dirObj.Get("z").As<Napi::Number>().DoubleValue();

  gp_Vec dir(dx, dy, dz);
  if (dir.Magnitude() < 1e-10) {
    Napi::Error::New(env, "Invalid direction: zero vector").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::lock_guard<std::mutex> lock(s_docMutex);

  const TopoDS_Shape* faceShape = ShapeStore::instance().get(faceHandle);
  if (!faceShape) {
    Napi::Error::New(env, "Invalid face handle").ThrowAsJavaScriptException();
    return env.Null();
  }

  dir.Normalize();
  dir *= depth;

  try {
    BRepPrimAPI_MakePrism prism(*faceShape, dir);
    if (!prism.IsDone()) {
      Napi::Error::New(env, "Prism construction failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    auto docIt = s_documents.find(docId);
    if (docIt == s_documents.end()) {
      Napi::Error::New(env, "Invalid document ID").ThrowAsJavaScriptException();
      return env.Null();
    }

    int lastHandle = getLastSolidHandle(docIt->second);
    if (lastHandle <= 0) {
      Napi::Error::New(env, "No existing solid to cut from").ThrowAsJavaScriptException();
      return env.Null();
    }

    const TopoDS_Shape* existing = ShapeStore::instance().get(lastHandle);
    if (!existing) {
      Napi::Error::New(env, "Invalid existing solid handle").ThrowAsJavaScriptException();
      return env.Null();
    }

    BRepAlgoAPI_Cut cut(*existing, prism.Shape());
    if (!cut.IsDone()) {
      Napi::Error::New(env, "Boolean cut failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    int outputHandle = ShapeStore::instance().store(cut.Shape());

    Feature f;
    f.id = "pocket_" + std::to_string(docIt->second.nextFeatureId++);
    f.type = "pocket";
    f.inputHandle = faceHandle;
    f.outputHandle = outputHandle;
    f.depth = depth;
    f.dirX = dx; f.dirY = dy; f.dirZ = dz;
    docIt->second.features.push_back(f);

    Napi::Object result = Napi::Object::New(env);
    result.Set("featureId", f.id);
    result.Set("outputHandle", outputHandle);
    return result;

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("OCCT error: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// Fillet
Napi::Value AddFilletFeature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "AddFilletFeature: docId, radius, edgeIndices required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int docId = info[0].As<Napi::Number>().Int32Value();
  double radius = info[1].As<Napi::Number>().DoubleValue();
  Napi::Array edgeArr = info[2].As<Napi::Array>();

  std::lock_guard<std::mutex> lock(s_docMutex);
  auto docIt = s_documents.find(docId);
  if (docIt == s_documents.end()) {
    Napi::Error::New(env, "Invalid document ID").ThrowAsJavaScriptException();
    return env.Null();
  }

  int lastHandle = getLastSolidHandle(docIt->second);
  if (lastHandle <= 0) {
    Napi::Error::New(env, "No solid for fillet").ThrowAsJavaScriptException();
    return env.Null();
  }

  const TopoDS_Shape* solidShape = ShapeStore::instance().get(lastHandle);
  if (!solidShape) {
    Napi::Error::New(env, "Invalid solid handle").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    BRepFilletAPI_MakeFillet fillet(TopoDS::Solid(*solidShape));

    // Select edges by index
    std::vector<TopoDS_Edge> allEdges;
    for (TopExp_Explorer exp(*solidShape, TopAbs_EDGE); exp.More(); exp.Next()) {
      allEdges.push_back(TopoDS::Edge(exp.Current()));
    }

    for (uint32_t i = 0; i < edgeArr.Length(); i++) {
      int idx = edgeArr.Get(i).As<Napi::Number>().Int32Value();
      if (idx >= 0 && idx < (int)allEdges.size()) {
        fillet.Add(radius, allEdges[idx]);
      }
    }

    fillet.Build();
    if (!fillet.IsDone()) {
      Napi::Error::New(env, "Fillet construction failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    int outputHandle = ShapeStore::instance().store(fillet.Shape());

    Feature f;
    f.id = "fillet_" + std::to_string(docIt->second.nextFeatureId++);
    f.type = "fillet";
    f.inputHandle = lastHandle;
    f.outputHandle = outputHandle;
    f.radius = radius;
    docIt->second.features.push_back(f);

    Napi::Object result = Napi::Object::New(env);
    result.Set("featureId", f.id);
    result.Set("outputHandle", outputHandle);
    return result;

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("OCCT error: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// Chamfer (similar to fillet)
Napi::Value AddChamferFeature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "AddChamferFeature: docId, distance, edgeIndices required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int docId = info[0].As<Napi::Number>().Int32Value();
  double distance = info[1].As<Napi::Number>().DoubleValue();
  Napi::Array edgeArr = info[2].As<Napi::Array>();

  std::lock_guard<std::mutex> lock(s_docMutex);
  auto docIt = s_documents.find(docId);
  if (docIt == s_documents.end()) {
    Napi::Error::New(env, "Invalid document ID").ThrowAsJavaScriptException();
    return env.Null();
  }

  int lastHandle = getLastSolidHandle(docIt->second);
  const TopoDS_Shape* solidShape = ShapeStore::instance().get(lastHandle);
  if (!solidShape) {
    Napi::Error::New(env, "Invalid solid handle").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    BRepFilletAPI_MakeChamfer chamfer(TopoDS::Solid(*solidShape));

    std::vector<TopoDS_Edge> allEdges;
    for (TopExp_Explorer exp(*solidShape, TopAbs_EDGE); exp.More(); exp.Next()) {
      allEdges.push_back(TopoDS::Edge(exp.Current()));
    }

    for (uint32_t i = 0; i < edgeArr.Length(); i++) {
      int idx = edgeArr.Get(i).As<Napi::Number>().Int32Value();
      if (idx >= 0 && idx < (int)allEdges.size()) {
        chamfer.Add(distance, allEdges[idx]);
      }
    }

    chamfer.Build();
    if (!chamfer.IsDone()) {
      Napi::Error::New(env, "Chamfer construction failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    int outputHandle = ShapeStore::instance().store(chamfer.Shape());

    Feature f;
    f.id = "chamfer_" + std::to_string(docIt->second.nextFeatureId++);
    f.type = "chamfer";
    f.inputHandle = lastHandle;
    f.outputHandle = outputHandle;
    f.distance = distance;
    docIt->second.features.push_back(f);

    Napi::Object result = Napi::Object::New(env);
    result.Set("featureId", f.id);
    result.Set("outputHandle", outputHandle);
    return result;

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("OCCT error: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// Revolve: face -> revolve around axis -> solid
// args: docId, faceHandle, angle(radians), axisOrigin{x,y,z}, axisDir{x,y,z}
Napi::Value AddRevolveFeature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5) {
    Napi::TypeError::New(env, "AddRevolveFeature: docId, faceHandle, angle, axisOrigin, axisDir required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int docId = info[0].As<Napi::Number>().Int32Value();
  int faceHandle = info[1].As<Napi::Number>().Int32Value();
  double angle = info[2].As<Napi::Number>().DoubleValue();
  Napi::Object axOriginObj = info[3].As<Napi::Object>();
  Napi::Object axDirObj = info[4].As<Napi::Object>();

  double aox = axOriginObj.Get("x").As<Napi::Number>().DoubleValue();
  double aoy = axOriginObj.Get("y").As<Napi::Number>().DoubleValue();
  double aoz = axOriginObj.Get("z").As<Napi::Number>().DoubleValue();
  double adx = axDirObj.Get("x").As<Napi::Number>().DoubleValue();
  double ady = axDirObj.Get("y").As<Napi::Number>().DoubleValue();
  double adz = axDirObj.Get("z").As<Napi::Number>().DoubleValue();

  double adMag = std::sqrt(adx*adx + ady*ady + adz*adz);
  if (adMag < 1e-10) {
    Napi::Error::New(env, "Invalid axis direction: zero vector").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::lock_guard<std::mutex> lock(s_docMutex);

  const TopoDS_Shape* faceShape = ShapeStore::instance().get(faceHandle);
  if (!faceShape) {
    Napi::Error::New(env, "Invalid face handle").ThrowAsJavaScriptException();
    return env.Null();
  }

  gp_Pnt axOrigin(aox, aoy, aoz);
  gp_Dir axDir(adx, ady, adz);
  gp_Ax1 axis(axOrigin, axDir);

  try {
    BRepPrimAPI_MakeRevol revol(*faceShape, axis, angle);
    if (!revol.IsDone()) {
      Napi::Error::New(env, "Revolve construction failed").ThrowAsJavaScriptException();
      return env.Null();
    }

    TopoDS_Shape revolShape = revol.Shape();
    auto docIt = s_documents.find(docId);
    if (docIt == s_documents.end()) {
      Napi::Error::New(env, "Invalid document ID").ThrowAsJavaScriptException();
      return env.Null();
    }

    int lastHandle = getLastSolidHandle(docIt->second);
    int outputHandle;

    if (lastHandle > 0) {
      const TopoDS_Shape* existing = ShapeStore::instance().get(lastHandle);
      if (existing) {
        BRepAlgoAPI_Fuse fuse(*existing, revolShape);
        if (fuse.IsDone()) {
          outputHandle = ShapeStore::instance().store(fuse.Shape());
        } else {
          outputHandle = ShapeStore::instance().store(revolShape);
        }
      } else {
        outputHandle = ShapeStore::instance().store(revolShape);
      }
    } else {
      outputHandle = ShapeStore::instance().store(revolShape);
    }

    Feature f;
    f.id = "revolve_" + std::to_string(docIt->second.nextFeatureId++);
    f.type = "revolve";
    f.inputHandle = faceHandle;
    f.outputHandle = outputHandle;
    f.angle = angle;
    f.axisOriginX = aox; f.axisOriginY = aoy; f.axisOriginZ = aoz;
    f.axisDirX = adx; f.axisDirY = ady; f.axisDirZ = adz;
    docIt->second.features.push_back(f);

    Napi::Object result = Napi::Object::New(env);
    result.Set("featureId", f.id);
    result.Set("outputHandle", outputHandle);
    return result;

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("OCCT error: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// Get feature tree
Napi::Value GetFeatureTree(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) return env.Null();

  int docId = info[0].As<Napi::Number>().Int32Value();
  std::lock_guard<std::mutex> lock(s_docMutex);
  auto it = s_documents.find(docId);
  if (it == s_documents.end()) return env.Null();

  Napi::Array arr = Napi::Array::New(env, it->second.features.size());
  for (size_t i = 0; i < it->second.features.size(); i++) {
    const auto& f = it->second.features[i];
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("id", f.id);
    obj.Set("type", f.type);
    obj.Set("inputHandle", f.inputHandle);
    obj.Set("outputHandle", f.outputHandle);
    if (f.type == "pad" || f.type == "pocket") {
      obj.Set("depth", f.depth);
      Napi::Object dir = Napi::Object::New(env);
      dir.Set("x", f.dirX); dir.Set("y", f.dirY); dir.Set("z", f.dirZ);
      obj.Set("direction", dir);
    }
    if (f.type == "revolve") {
      obj.Set("angle", f.angle);
      Napi::Object axOrigin = Napi::Object::New(env);
      axOrigin.Set("x", f.axisOriginX); axOrigin.Set("y", f.axisOriginY); axOrigin.Set("z", f.axisOriginZ);
      obj.Set("axisOrigin", axOrigin);
      Napi::Object axDir = Napi::Object::New(env);
      axDir.Set("x", f.axisDirX); axDir.Set("y", f.axisDirY); axDir.Set("z", f.axisDirZ);
      obj.Set("axisDir", axDir);
    }
    if (f.type == "fillet") {
      obj.Set("radius", f.radius);
      Napi::Array ei = Napi::Array::New(env, f.edgeIndices.size());
      for (size_t j = 0; j < f.edgeIndices.size(); j++) ei.Set((uint32_t)j, f.edgeIndices[j]);
      obj.Set("edgeIndices", ei);
    }
    if (f.type == "chamfer") {
      obj.Set("distance", f.distance);
      Napi::Array ei = Napi::Array::New(env, f.edgeIndices.size());
      for (size_t j = 0; j < f.edgeIndices.size(); j++) ei.Set((uint32_t)j, f.edgeIndices[j]);
      obj.Set("edgeIndices", ei);
    }
    arr.Set((uint32_t)i, obj);
  }
  return arr;
}

// Remove feature + rebuild downstream
// args: docId, featureId
Napi::Value RemoveFeature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "RemoveFeature: docId, featureId required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int docId = info[0].As<Napi::Number>().Int32Value();
  std::string featureId = info[1].As<Napi::String>().Utf8Value();

  std::lock_guard<std::mutex> lock(s_docMutex);
  auto docIt = s_documents.find(docId);
  if (docIt == s_documents.end()) {
    Napi::Error::New(env, "Invalid document ID").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto& features = docIt->second.features;
  int targetIdx = -1;
  for (int i = 0; i < (int)features.size(); i++) {
    if (features[i].id == featureId) { targetIdx = i; break; }
  }

  if (targetIdx < 0) {
    Napi::Error::New(env, "Feature not found").ThrowAsJavaScriptException();
    return env.Null();
  }

  // Release the target feature's output handle
  if (features[targetIdx].outputHandle > 0) {
    ShapeStore::instance().release(features[targetIdx].outputHandle);
  }
  features.erase(features.begin() + targetIdx);

  // Rebuild all features from the removed index onwards
  if (targetIdx < (int)features.size()) {
    rebuildFromIndex(docIt->second, targetIdx);
  }

  // Return updated last solid handle
  int lastHandle = getLastSolidHandle(docIt->second);
  Napi::Object result = Napi::Object::New(env);
  result.Set("lastSolidHandle", lastHandle);
  return result;
}

// Update feature params + rebuild downstream
// args: docId, featureId, params{depth?, radius?, distance?, angle?, dirX?, dirY?, dirZ?}
Napi::Value UpdateFeature(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "UpdateFeature: docId, featureId, params required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int docId = info[0].As<Napi::Number>().Int32Value();
  std::string featureId = info[1].As<Napi::String>().Utf8Value();
  Napi::Object params = info[2].As<Napi::Object>();

  std::lock_guard<std::mutex> lock(s_docMutex);
  auto docIt = s_documents.find(docId);
  if (docIt == s_documents.end()) {
    Napi::Error::New(env, "Invalid document ID").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto& features = docIt->second.features;
  int targetIdx = -1;
  for (int i = 0; i < (int)features.size(); i++) {
    if (features[i].id == featureId) { targetIdx = i; break; }
  }

  if (targetIdx < 0) {
    Napi::Error::New(env, "Feature not found").ThrowAsJavaScriptException();
    return env.Null();
  }

  Feature& f = features[targetIdx];

  // Update parameters from the params object
  if (params.Has("depth")) f.depth = params.Get("depth").As<Napi::Number>().DoubleValue();
  if (params.Has("radius")) f.radius = params.Get("radius").As<Napi::Number>().DoubleValue();
  if (params.Has("distance")) f.distance = params.Get("distance").As<Napi::Number>().DoubleValue();
  if (params.Has("angle")) f.angle = params.Get("angle").As<Napi::Number>().DoubleValue();
  if (params.Has("dirX")) f.dirX = params.Get("dirX").As<Napi::Number>().DoubleValue();
  if (params.Has("dirY")) f.dirY = params.Get("dirY").As<Napi::Number>().DoubleValue();
  if (params.Has("dirZ")) f.dirZ = params.Get("dirZ").As<Napi::Number>().DoubleValue();

  if (params.Has("edgeIndices") && params.Get("edgeIndices").IsArray()) {
    Napi::Array arr = params.Get("edgeIndices").As<Napi::Array>();
    f.edgeIndices.clear();
    for (uint32_t i = 0; i < arr.Length(); i++) {
      f.edgeIndices.push_back(arr.Get(i).As<Napi::Number>().Int32Value());
    }
  }

  // Revolve axis parameters
  if (params.Has("axisOriginX")) f.axisOriginX = params.Get("axisOriginX").As<Napi::Number>().DoubleValue();
  if (params.Has("axisOriginY")) f.axisOriginY = params.Get("axisOriginY").As<Napi::Number>().DoubleValue();
  if (params.Has("axisOriginZ")) f.axisOriginZ = params.Get("axisOriginZ").As<Napi::Number>().DoubleValue();
  if (params.Has("axisDirX")) f.axisDirX = params.Get("axisDirX").As<Napi::Number>().DoubleValue();
  if (params.Has("axisDirY")) f.axisDirY = params.Get("axisDirY").As<Napi::Number>().DoubleValue();
  if (params.Has("axisDirZ")) f.axisDirZ = params.Get("axisDirZ").As<Napi::Number>().DoubleValue();

  // Rebuild from this feature onwards
  rebuildFromIndex(docIt->second, targetIdx);

  // Return the updated feature's output handle
  Napi::Object result = Napi::Object::New(env);
  result.Set("featureId", f.id);
  result.Set("outputHandle", f.outputHandle);
  result.Set("lastSolidHandle", getLastSolidHandle(docIt->second));
  return result;
}

// Shape topology query — detailed edge/face/vertex data for picking
Napi::Value GetShapeTopology(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) return env.Null();

  int handle = info[0].As<Napi::Number>().Int32Value();
  const TopoDS_Shape* shape = ShapeStore::instance().get(handle);
  if (!shape) return env.Null();

  Napi::Object result = Napi::Object::New(env);

  // Edges — with start/end/mid points and curve type
  Napi::Array edgesArr = Napi::Array::New(env);
  int edgeIdx = 0;
  TopTools_MapOfShape edgeMap; // dedup
  for (TopExp_Explorer exp(*shape, TopAbs_EDGE); exp.More(); exp.Next()) {
    TopoDS_Edge edge = TopoDS::Edge(exp.Current());
    if (edgeMap.Contains(edge)) continue;
    edgeMap.Add(edge);

    BRepAdaptor_Curve adaptor(edge);
    double t0 = adaptor.FirstParameter();
    double t1 = adaptor.LastParameter();
    gp_Pnt pStart = adaptor.Value(t0);
    gp_Pnt pEnd = adaptor.Value(t1);
    gp_Pnt pMid = adaptor.Value((t0 + t1) / 2.0);

    // Curve type string
    const char* curveType = "other";
    switch (adaptor.GetType()) {
      case GeomAbs_Line: curveType = "line"; break;
      case GeomAbs_Circle: curveType = "circle"; break;
      case GeomAbs_Ellipse: curveType = "ellipse"; break;
      case GeomAbs_BSplineCurve: curveType = "bspline"; break;
      default: break;
    }

    // Sample polyline (for screen-space distance picking)
    int numSamples = (adaptor.GetType() == GeomAbs_Line) ? 2 : 16;
    Napi::Array polyline = Napi::Array::New(env, numSamples);
    for (int s = 0; s < numSamples; s++) {
      double t = t0 + (t1 - t0) * s / (numSamples - 1);
      gp_Pnt p = adaptor.Value(t);
      Napi::Object pt = Napi::Object::New(env);
      pt.Set("x", p.X()); pt.Set("y", p.Y()); pt.Set("z", p.Z());
      polyline.Set((uint32_t)s, pt);
    }

    Napi::Object edgeObj = Napi::Object::New(env);
    edgeObj.Set("index", edgeIdx);
    edgeObj.Set("curveType", std::string(curveType));
    Napi::Object startPt = Napi::Object::New(env);
    startPt.Set("x", pStart.X()); startPt.Set("y", pStart.Y()); startPt.Set("z", pStart.Z());
    edgeObj.Set("start", startPt);
    Napi::Object endPt = Napi::Object::New(env);
    endPt.Set("x", pEnd.X()); endPt.Set("y", pEnd.Y()); endPt.Set("z", pEnd.Z());
    edgeObj.Set("end", endPt);
    Napi::Object midPt = Napi::Object::New(env);
    midPt.Set("x", pMid.X()); midPt.Set("y", pMid.Y()); midPt.Set("z", pMid.Z());
    edgeObj.Set("mid", midPt);
    edgeObj.Set("polyline", polyline);
    edgesArr.Set((uint32_t)edgeIdx, edgeObj);
    edgeIdx++;
  }
  result.Set("edges", edgesArr);
  result.Set("edgeCount", edgeIdx);

  // Faces — center point, normal, surface type
  // NOTE: no dedup — face order must match TessellateShapeWithTopology's faceGroups
  Napi::Array facesArr = Napi::Array::New(env);
  int faceIdx = 0;
  for (TopExp_Explorer exp(*shape, TopAbs_FACE); exp.More(); exp.Next()) {
    TopoDS_Face face = TopoDS::Face(exp.Current());
    BRepAdaptor_Surface surf(face);

    // Surface center point and normal at UV mid-point
    double uMid = (surf.FirstUParameter() + surf.LastUParameter()) / 2.0;
    double vMid = (surf.FirstVParameter() + surf.LastVParameter()) / 2.0;
    gp_Pnt center;
    gp_Vec du, dv;
    surf.D1(uMid, vMid, center, du, dv);
    gp_Vec normal = du.Crossed(dv);
    if (normal.Magnitude() > 1e-10) normal.Normalize();
    if (face.Orientation() == TopAbs_REVERSED) normal.Reverse();

    const char* surfType = "other";
    switch (surf.GetType()) {
      case GeomAbs_Plane: surfType = "plane"; break;
      case GeomAbs_Cylinder: surfType = "cylinder"; break;
      case GeomAbs_Cone: surfType = "cone"; break;
      case GeomAbs_Sphere: surfType = "sphere"; break;
      case GeomAbs_Torus: surfType = "torus"; break;
      case GeomAbs_BSplineSurface: surfType = "bspline"; break;
      default: break;
    }

    Napi::Object faceObj = Napi::Object::New(env);
    faceObj.Set("index", faceIdx);
    faceObj.Set("surfaceType", std::string(surfType));
    Napi::Object cPt = Napi::Object::New(env);
    cPt.Set("x", center.X()); cPt.Set("y", center.Y()); cPt.Set("z", center.Z());
    faceObj.Set("center", cPt);
    Napi::Object nPt = Napi::Object::New(env);
    nPt.Set("x", normal.X()); nPt.Set("y", normal.Y()); nPt.Set("z", normal.Z());
    faceObj.Set("normal", nPt);
    facesArr.Set((uint32_t)faceIdx, faceObj);
    faceIdx++;
  }
  result.Set("faces", facesArr);
  result.Set("faceCount", faceIdx);

  // Vertices — deduplicated 3D points
  Napi::Array verticesArr = Napi::Array::New(env);
  int vertIdx = 0;
  TopTools_MapOfShape vertMap;
  for (TopExp_Explorer exp(*shape, TopAbs_VERTEX); exp.More(); exp.Next()) {
    TopoDS_Vertex vtx = TopoDS::Vertex(exp.Current());
    if (vertMap.Contains(vtx)) continue;
    vertMap.Add(vtx);
    gp_Pnt p = BRep_Tool::Pnt(vtx);
    Napi::Object vPt = Napi::Object::New(env);
    vPt.Set("index", vertIdx);
    vPt.Set("x", p.X()); vPt.Set("y", p.Y()); vPt.Set("z", p.Z());
    verticesArr.Set((uint32_t)vertIdx, vPt);
    vertIdx++;
  }
  result.Set("vertices", verticesArr);
  result.Set("vertexCount", vertIdx);

  return result;
}

// STEP export
Napi::Value ExportStep(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "ExportStep: shapeHandle, filePath required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int handle = info[0].As<Napi::Number>().Int32Value();
  std::string filePath = info[1].As<Napi::String>().Utf8Value();

  const TopoDS_Shape* shape = ShapeStore::instance().get(handle);
  if (!shape) {
    Napi::Error::New(env, "Invalid shape handle").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    STEPControl_Writer writer;
    writer.Transfer(*shape, STEPControl_AsIs);
    IFSelect_ReturnStatus status = writer.Write(filePath.c_str());

    return Napi::Boolean::New(env, status == IFSelect_RetDone);

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("STEP export error: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// IGES export
Napi::Value ExportIges(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "ExportIges: shapeHandle, filePath required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int handle = info[0].As<Napi::Number>().Int32Value();
  std::string filePath = info[1].As<Napi::String>().Utf8Value();

  const TopoDS_Shape* shape = ShapeStore::instance().get(handle);
  if (!shape) {
    Napi::Error::New(env, "Invalid shape handle").ThrowAsJavaScriptException();
    return env.Null();
  }

  try {
    IGESControl_Writer writer("MM", 0);
    writer.AddShape(*shape);
    const Standard_Boolean ok = writer.Write(filePath.c_str());

    return Napi::Boolean::New(env, ok);

  } catch (const Standard_Failure& e) {
    Napi::Error::New(env, std::string("IGES export error: ") + e.GetMessageString()).ThrowAsJavaScriptException();
    return env.Null();
  }
}

// Serialize document: feature tree + BRep shapes → JSON string
// Returns: { features: [...], shapes: { "handle": "brep_string", ... } }
Napi::Value SerializeDocument(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "SerializeDocument: docId required").ThrowAsJavaScriptException();
    return env.Null();
  }

  int docId = info[0].As<Napi::Number>().Int32Value();
  std::lock_guard<std::mutex> lock(s_docMutex);
  auto it = s_documents.find(docId);
  if (it == s_documents.end()) {
    Napi::Error::New(env, "Invalid document ID").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object result = Napi::Object::New(env);

  // Serialize feature list
  Napi::Array featArr = Napi::Array::New(env, it->second.features.size());
  std::set<int> handleSet; // collect all handles to serialize
  for (size_t i = 0; i < it->second.features.size(); i++) {
    const auto& f = it->second.features[i];
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("id", f.id);
    obj.Set("type", f.type);
    obj.Set("inputHandle", f.inputHandle);
    obj.Set("outputHandle", f.outputHandle);
    obj.Set("depth", f.depth);
    obj.Set("angle", f.angle);
    obj.Set("radius", f.radius);
    obj.Set("distance", f.distance);
    obj.Set("dirX", f.dirX); obj.Set("dirY", f.dirY); obj.Set("dirZ", f.dirZ);
    obj.Set("axisOriginX", f.axisOriginX); obj.Set("axisOriginY", f.axisOriginY); obj.Set("axisOriginZ", f.axisOriginZ);
    obj.Set("axisDirX", f.axisDirX); obj.Set("axisDirY", f.axisDirY); obj.Set("axisDirZ", f.axisDirZ);
    // edgeIndices
    Napi::Array ei = Napi::Array::New(env, f.edgeIndices.size());
    for (size_t j = 0; j < f.edgeIndices.size(); j++) ei.Set((uint32_t)j, f.edgeIndices[j]);
    obj.Set("edgeIndices", ei);
    featArr.Set((uint32_t)i, obj);
    if (f.inputHandle > 0) handleSet.insert(f.inputHandle);
    if (f.outputHandle > 0) handleSet.insert(f.outputHandle);
  }
  result.Set("features", featArr);
  result.Set("nextFeatureId", it->second.nextFeatureId);

  // Serialize BRep shapes via BRepTools::Write → string
  Napi::Object shapesObj = Napi::Object::New(env);
  for (int h : handleSet) {
    const TopoDS_Shape* shape = ShapeStore::instance().get(h);
    if (!shape) continue;
    std::ostringstream oss;
    BRepTools::Write(*shape, oss);
    shapesObj.Set(std::to_string(h), oss.str());
  }
  result.Set("shapes", shapesObj);

  return result;
}

// Deserialize document: restore feature tree + BRep shapes from serialized data
// Args: serializedData { features, nextFeatureId, shapes }
// Returns: docId
Napi::Value DeserializeDocument(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "DeserializeDocument: data object required").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object data = info[0].As<Napi::Object>();
  Napi::Array featArr = data.Get("features").As<Napi::Array>();
  int nextFeatureId = data.Get("nextFeatureId").As<Napi::Number>().Int32Value();
  Napi::Object shapesObj = data.Get("shapes").As<Napi::Object>();

  // Restore BRep shapes: old handle string → new handle mapping
  std::unordered_map<int, int> handleMap;
  Napi::Array shapeKeys = shapesObj.GetPropertyNames();
  for (uint32_t i = 0; i < shapeKeys.Length(); i++) {
    std::string key = shapeKeys.Get(i).As<Napi::String>().Utf8Value();
    int oldHandle = std::stoi(key);
    std::string brepStr = shapesObj.Get(key).As<Napi::String>().Utf8Value();

    std::istringstream iss(brepStr);
    TopoDS_Shape shape;
    BRep_Builder builder;
    BRepTools::Read(shape, iss, builder);

    if (!shape.IsNull()) {
      int newHandle = ShapeStore::instance().store(shape);
      handleMap[oldHandle] = newHandle;
    }
  }

  // Create document and restore features with remapped handles
  std::lock_guard<std::mutex> lock(s_docMutex);
  int docId = s_nextDocId++;
  Document& doc = s_documents[docId];
  doc.nextFeatureId = nextFeatureId;

  for (uint32_t i = 0; i < featArr.Length(); i++) {
    Napi::Object obj = featArr.Get(i).As<Napi::Object>();
    Feature f;
    f.id = obj.Get("id").As<Napi::String>().Utf8Value();
    f.type = obj.Get("type").As<Napi::String>().Utf8Value();
    int oldInput = obj.Get("inputHandle").As<Napi::Number>().Int32Value();
    int oldOutput = obj.Get("outputHandle").As<Napi::Number>().Int32Value();
    f.inputHandle = handleMap.count(oldInput) ? handleMap[oldInput] : 0;
    f.outputHandle = handleMap.count(oldOutput) ? handleMap[oldOutput] : 0;
    f.depth = obj.Get("depth").As<Napi::Number>().DoubleValue();
    f.angle = obj.Get("angle").As<Napi::Number>().DoubleValue();
    f.radius = obj.Get("radius").As<Napi::Number>().DoubleValue();
    f.distance = obj.Get("distance").As<Napi::Number>().DoubleValue();
    f.dirX = obj.Get("dirX").As<Napi::Number>().DoubleValue();
    f.dirY = obj.Get("dirY").As<Napi::Number>().DoubleValue();
    f.dirZ = obj.Get("dirZ").As<Napi::Number>().DoubleValue();
    f.axisOriginX = obj.Get("axisOriginX").As<Napi::Number>().DoubleValue();
    f.axisOriginY = obj.Get("axisOriginY").As<Napi::Number>().DoubleValue();
    f.axisOriginZ = obj.Get("axisOriginZ").As<Napi::Number>().DoubleValue();
    f.axisDirX = obj.Get("axisDirX").As<Napi::Number>().DoubleValue();
    f.axisDirY = obj.Get("axisDirY").As<Napi::Number>().DoubleValue();
    f.axisDirZ = obj.Get("axisDirZ").As<Napi::Number>().DoubleValue();
    if (obj.Has("edgeIndices") && obj.Get("edgeIndices").IsArray()) {
      Napi::Array ei = obj.Get("edgeIndices").As<Napi::Array>();
      for (uint32_t j = 0; j < ei.Length(); j++) {
        f.edgeIndices.push_back(ei.Get(j).As<Napi::Number>().Int32Value());
      }
    }
    doc.features.push_back(f);
  }

  return Napi::Number::New(env, docId);
}

#endif // HAVE_OCCT

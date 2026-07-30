// @cad-editor/occt-native - N-API entry point

#include <napi.h>
#include "shape_store.h"

#ifdef HAVE_OCCT
#include "step_reader.h"
#include "edge_extractor.h"
#include "boolean_ops.h"
#include "sketch_builder.h"
#include "part_document.h"
#include <Standard_Version.hxx>
#endif

Napi::String Ping(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "pong from OCCT native addon");
}

#ifdef HAVE_OCCT
Napi::String GetOcctVersion(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), OCC_VERSION_COMPLETE);
}
#endif

Napi::Value ReleaseShape(const Napi::CallbackInfo& info) {
  if (info.Length() >= 1 && info[0].IsNumber()) {
    ShapeStore::instance().release(info[0].As<Napi::Number>().Int32Value());
  }
  return info.Env().Undefined();
}

Napi::Value ReleaseAllShapes(const Napi::CallbackInfo& info) {
  ShapeStore::instance().releaseAll();
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("ping", Napi::Function::New(env, Ping));
  exports.Set("releaseShape", Napi::Function::New(env, ReleaseShape));
  exports.Set("releaseAllShapes", Napi::Function::New(env, ReleaseAllShapes));

#ifdef HAVE_OCCT
  exports.Set("getOcctVersion", Napi::Function::New(env, GetOcctVersion));
  exports.Set("readStepFile", Napi::Function::New(env, ReadStepFile));
  exports.Set("extractEdges", Napi::Function::New(env, ExtractEdges));
  exports.Set("buildPrism", Napi::Function::New(env, BuildPrism));
  exports.Set("buildRevolution", Napi::Function::New(env, BuildRevolution));
  exports.Set("performBoolean", Napi::Function::New(env, PerformBoolean));
  exports.Set("applyFillet", Napi::Function::New(env, ApplyFillet));
  exports.Set("applyChamfer", Napi::Function::New(env, ApplyChamfer));
  exports.Set("applyShell", Napi::Function::New(env, ApplyShell));
  exports.Set("tessellateShape", Napi::Function::New(env, TessellateShape));
  // Phase 1: Sketch → Wire/Face
  exports.Set("makeWireFromSketch", Napi::Function::New(env, MakeWireFromSketch));
  exports.Set("makeFaceFromWire", Napi::Function::New(env, MakeFaceFromWire));
  exports.Set("makeEdge", Napi::Function::New(env, MakeEdge));
  // Phase 1: PartDocument + Feature Tree
  exports.Set("createDocument", Napi::Function::New(env, CreateDocument));
  exports.Set("releaseDocument", Napi::Function::New(env, ReleaseDocument));
  exports.Set("addSketchFeature", Napi::Function::New(env, AddSketchFeature));
  exports.Set("addPadFeature", Napi::Function::New(env, AddPadFeature));
  exports.Set("addPocketFeature", Napi::Function::New(env, AddPocketFeature));
  exports.Set("addRevolveFeature", Napi::Function::New(env, AddRevolveFeature));
  exports.Set("addFilletFeature", Napi::Function::New(env, AddFilletFeature));
  exports.Set("addChamferFeature", Napi::Function::New(env, AddChamferFeature));
  exports.Set("getFeatureTree", Napi::Function::New(env, GetFeatureTree));
  exports.Set("updateFeature", Napi::Function::New(env, UpdateFeature));
  exports.Set("removeFeature", Napi::Function::New(env, RemoveFeature));
  exports.Set("getShapeTopology", Napi::Function::New(env, GetShapeTopology));
  exports.Set("exportStep", Napi::Function::New(env, ExportStep));
  exports.Set("exportIges", Napi::Function::New(env, ExportIges));
  // Phase 4: Topology picking
  exports.Set("tessellateShapeWithTopology", Napi::Function::New(env, TessellateShapeWithTopology));
  // Phase 5: Document serialization
  exports.Set("serializeDocument", Napi::Function::New(env, SerializeDocument));
  exports.Set("deserializeDocument", Napi::Function::New(env, DeserializeDocument));
#endif

  return exports;
}

NODE_API_MODULE(occt_native, Init)

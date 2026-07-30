#pragma once
// PartDocument: OCCT feature tree management

#include <napi.h>

#ifdef HAVE_OCCT
Napi::Value CreateDocument(const Napi::CallbackInfo& info);
Napi::Value ReleaseDocument(const Napi::CallbackInfo& info);
Napi::Value AddSketchFeature(const Napi::CallbackInfo& info);
Napi::Value AddPadFeature(const Napi::CallbackInfo& info);
Napi::Value AddPocketFeature(const Napi::CallbackInfo& info);
Napi::Value AddRevolveFeature(const Napi::CallbackInfo& info);
Napi::Value AddFilletFeature(const Napi::CallbackInfo& info);
Napi::Value AddChamferFeature(const Napi::CallbackInfo& info);
Napi::Value GetFeatureTree(const Napi::CallbackInfo& info);
Napi::Value UpdateFeature(const Napi::CallbackInfo& info);
Napi::Value RemoveFeature(const Napi::CallbackInfo& info);
Napi::Value GetShapeTopology(const Napi::CallbackInfo& info);
Napi::Value ExportStep(const Napi::CallbackInfo& info);
Napi::Value ExportIges(const Napi::CallbackInfo& info);
Napi::Value SerializeDocument(const Napi::CallbackInfo& info);
Napi::Value DeserializeDocument(const Napi::CallbackInfo& info);
#endif

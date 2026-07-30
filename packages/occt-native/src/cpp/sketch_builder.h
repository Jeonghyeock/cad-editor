#pragma once
// SketchBuilder: 2D sketch geometry to OCCT Wire/Face

#include <napi.h>

#ifdef HAVE_OCCT
Napi::Value MakeWireFromSketch(const Napi::CallbackInfo& info);
Napi::Value MakeFaceFromWire(const Napi::CallbackInfo& info);
Napi::Value MakeEdge(const Napi::CallbackInfo& info);
#endif

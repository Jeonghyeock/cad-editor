#pragma once
// B-Rep edge extraction from stored TopoDS_Shape

#include <napi.h>

Napi::Value ExtractEdges(const Napi::CallbackInfo& info);

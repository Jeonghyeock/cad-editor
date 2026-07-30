#pragma once
// STEP file reader - STEPCAFControl_Reader with XDE color/name extraction
// Returns tessellated body data + retained shape handle

#include <napi.h>

Napi::Value ReadStepFile(const Napi::CallbackInfo& info);

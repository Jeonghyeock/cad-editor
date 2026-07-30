#pragma once
// Phase 3: Boolean operations + shape building + tessellation

#include <napi.h>

// 2D sketch profiles -> Wire -> Face -> Prism (extrusion)
Napi::Value BuildPrism(const Napi::CallbackInfo& info);

// Boolean: Fuse (pad) or Cut (pocket) two shapes
Napi::Value PerformBoolean(const Napi::CallbackInfo& info);

// 2D sketch profiles -> Wire -> Face -> Revolution
Napi::Value BuildRevolution(const Napi::CallbackInfo& info);

// Fillet edges on a shape
Napi::Value ApplyFillet(const Napi::CallbackInfo& info);

// Chamfer edges on a shape
Napi::Value ApplyChamfer(const Napi::CallbackInfo& info);

// Shell (hollow) a shape
Napi::Value ApplyShell(const Napi::CallbackInfo& info);

// Tessellate a shape handle -> positions/normals/indices
Napi::Value TessellateShape(const Napi::CallbackInfo& info);

// Tessellate with face-indexed groups for topology picking
// Returns { positions, normals, indices, faceGroups: [{first, count}] }
Napi::Value TessellateShapeWithTopology(const Napi::CallbackInfo& info);

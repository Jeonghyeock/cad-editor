#include "step_reader.h"
#include "shape_store.h"

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

#include <STEPCAFControl_Reader.hxx>
#include <STEPControl_Reader.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <TDocStd_Document.hxx>
#include <TDataStd_Name.hxx>
#include <TCollection_ExtendedString.hxx>
#include <Quantity_Color.hxx>
#include <XCAFDoc_ColorType.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Face.hxx>
#include <BRep_Tool.hxx>
#include <gp_Vec3f.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepLib.hxx>
#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <Poly_Triangulation.hxx>
#include <TopLoc_Location.hxx>
#include <TDF_LabelSequence.hxx>
#include <Message_ProgressRange.hxx>

#include <BRep_Builder.hxx>
#include <TopoDS_Compound.hxx>
#include <Standard_Failure.hxx>

#include <vector>
#include <string>
#include <sstream>
#include <cmath>
#include <algorithm>
#include <cstdio>

// --- Helpers ---

static std::string rgbToHex(double r, double g, double b) {
  char buf[8];
  int ri = std::clamp((int)(r * 255 + 0.5), 0, 255);
  int gi = std::clamp((int)(g * 255 + 0.5), 0, 255);
  int bi = std::clamp((int)(b * 255 + 0.5), 0, 255);
  snprintf(buf, sizeof(buf), "#%02x%02x%02x", ri, gi, bi);
  return std::string(buf);
}

static const char* DEFAULT_COLOR = "#cccccc"; // occt-import-js default: rgb(0.8, 0.8, 0.8)

static double computeDeflection(const TopoDS_Shape& shape) {
  Bnd_Box box;
  BRepBndLib::Add(shape, box);
  if (box.IsVoid()) return 0.1;
  double xmin, ymin, zmin, xmax, ymax, zmax;
  box.Get(xmin, ymin, zmin, xmax, ymax, zmax);
  double diag = std::sqrt(
    (xmax-xmin)*(xmax-xmin) +
    (ymax-ymin)*(ymax-ymin) +
    (zmax-zmin)*(zmax-zmin)
  );
  return std::max(diag * 0.001, 1e-5);
}

// Get color from XDE ColorTool for a shape
static bool getShapeColor(
  const Handle(XCAFDoc_ColorTool)& colorTool,
  const TopoDS_Shape& shape,
  std::string& outHex
) {
  Quantity_Color color;
  if (colorTool->GetColor(shape, XCAFDoc_ColorSurf, color)) {
    outHex = rgbToHex(color.Red(), color.Green(), color.Blue());
    return true;
  }
  if (colorTool->GetColor(shape, XCAFDoc_ColorGen, color)) {
    outHex = rgbToHex(color.Red(), color.Green(), color.Blue());
    return true;
  }
  if (colorTool->GetColor(shape, XCAFDoc_ColorCurv, color)) {
    outHex = rgbToHex(color.Red(), color.Green(), color.Blue());
    return true;
  }
  return false;
}

// Get name from XDE label
static std::string getLabelName(const TDF_Label& label) {
  Handle(TDataStd_Name) nameAttr;
  if (label.FindAttribute(TDataStd_Name::GetID(), nameAttr)) {
    TCollection_ExtendedString extStr = nameAttr->Get();
    Standard_Integer len = extStr.Length();
    if (len > 0) {
      std::string result;
      result.reserve(len);
      for (Standard_Integer i = 1; i <= len; i++) {
        result.push_back((char)extStr.Value(i));
      }
      return result;
    }
  }
  return "";
}

// --- Body tessellation data ---

struct BrepFace {
  int first;
  int last;
  std::string color; // empty if no face-specific color
};

struct TessellatedBody {
  std::string name;
  std::string color;
  std::vector<float> positions;
  std::vector<float> normals;
  std::vector<uint32_t> indices;
  std::vector<BrepFace> brepFaces;
};

static TessellatedBody extractBody(
  const TopoDS_Shape& solid,
  const std::string& bodyName,
  const std::string& bodyColor,
  const Handle(XCAFDoc_ColorTool)& colorTool
) {
  TessellatedBody body;
  body.name = bodyName;
  body.color = bodyColor;

  int vertexOffset = 0;
  int triangleIndex = 0;

  for (TopExp_Explorer faceExp(solid, TopAbs_FACE); faceExp.More(); faceExp.Next()) {
    TopoDS_Face face = TopoDS::Face(faceExp.Current());
    TopLoc_Location location;
    Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, location);

    if (tri.IsNull()) continue;

    int nbNodes = tri->NbNodes();
    int nbTriangles = tri->NbTriangles();
    gp_Trsf trsf = location.Transformation();
    bool reversed = (face.Orientation() == TopAbs_REVERSED);

    int faceFirst = triangleIndex;

    // Vertices + Normals
    for (int i = 1; i <= nbNodes; i++) {
      gp_Pnt pnt = tri->Node(i).Transformed(trsf);
      body.positions.push_back((float)pnt.X());
      body.positions.push_back((float)pnt.Y());
      body.positions.push_back((float)pnt.Z());

      // Normal extraction: tri->Normal(i) returns gp_Dir which throws on zero norm
      // Wrap in try-catch for safe handling
      bool gotNormal = false;
      if (tri->HasNormals()) {
        try {
          gp_Vec nv(tri->Normal(i));
          gp_Vec transformed = nv.Transformed(trsf);
          double len = transformed.Magnitude();
          float sign = reversed ? -1.0f : 1.0f;
          if (len > 1e-10) {
            body.normals.push_back((float)(transformed.X() / len) * sign);
            body.normals.push_back((float)(transformed.Y() / len) * sign);
            body.normals.push_back((float)(transformed.Z() / len) * sign);
          } else {
            body.normals.push_back(0.0f);
            body.normals.push_back(0.0f);
            body.normals.push_back(0.0f);
          }
          gotNormal = true;
        } catch (...) {
          // zero norm - computed in cross-product fallback
        }
      }
      if (!gotNormal) {
        body.normals.push_back(0.0f);
        body.normals.push_back(0.0f);
        body.normals.push_back(0.0f);
      }
    }

    // Triangles
    for (int i = 1; i <= nbTriangles; i++) {
      int n1, n2, n3;
      tri->Triangle(i).Get(n1, n2, n3);
      n1 = n1 - 1 + vertexOffset;
      n2 = n2 - 1 + vertexOffset;
      n3 = n3 - 1 + vertexOffset;
      if (reversed) {
        body.indices.push_back(n1);
        body.indices.push_back(n3);
        body.indices.push_back(n2);
      } else {
        body.indices.push_back(n1);
        body.indices.push_back(n2);
        body.indices.push_back(n3);
      }
      triangleIndex++;
    }

    // Face color
    std::string faceColor;
    if (!colorTool.IsNull()) {
      getShapeColor(colorTool, face, faceColor);
    }

    BrepFace bf;
    bf.first = faceFirst;
    bf.last = triangleIndex - 1;
    bf.color = (faceColor != bodyColor) ? faceColor : "";
    body.brepFaces.push_back(bf);

    vertexOffset += nbNodes;
  }

  // If normals were not available, compute from triangle cross products
  bool hasZeroNormals = false;
  for (size_t i = 0; i < body.normals.size(); i += 3) {
    if (body.normals[i] == 0.0f && body.normals[i+1] == 0.0f && body.normals[i+2] == 0.0f) {
      hasZeroNormals = true;
      break;
    }
  }
  if (hasZeroNormals && !body.indices.empty()) {
    // Reset all normals to zero, accumulate from triangles
    std::fill(body.normals.begin(), body.normals.end(), 0.0f);
    for (size_t t = 0; t < body.indices.size(); t += 3) {
      uint32_t i0 = body.indices[t], i1 = body.indices[t+1], i2 = body.indices[t+2];
      float ax = body.positions[i1*3] - body.positions[i0*3];
      float ay = body.positions[i1*3+1] - body.positions[i0*3+1];
      float az = body.positions[i1*3+2] - body.positions[i0*3+2];
      float bx = body.positions[i2*3] - body.positions[i0*3];
      float by = body.positions[i2*3+1] - body.positions[i0*3+1];
      float bz = body.positions[i2*3+2] - body.positions[i0*3+2];
      float nx = ay*bz - az*by, ny = az*bx - ax*bz, nz = ax*by - ay*bx;
      // Accumulate (area-weighted smooth normals)
      body.normals[i0*3] += nx; body.normals[i0*3+1] += ny; body.normals[i0*3+2] += nz;
      body.normals[i1*3] += nx; body.normals[i1*3+1] += ny; body.normals[i1*3+2] += nz;
      body.normals[i2*3] += nx; body.normals[i2*3+1] += ny; body.normals[i2*3+2] += nz;
    }
    // Normalize
    for (size_t i = 0; i < body.normals.size(); i += 3) {
      float len = std::sqrt(body.normals[i]*body.normals[i] + body.normals[i+1]*body.normals[i+1] + body.normals[i+2]*body.normals[i+2]);
      if (len > 1e-10f) {
        body.normals[i] /= len; body.normals[i+1] /= len; body.normals[i+2] /= len;
      }
    }
  }

  return body;
}

// Convert TessellatedBody to Napi::Object
static Napi::Object bodyToJs(Napi::Env env, const TessellatedBody& body) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("name", body.name);
  obj.Set("color", body.color);

  // Zero-copy Float32Array for positions
  {
    size_t byteLen = body.positions.size() * sizeof(float);
    auto buf = Napi::ArrayBuffer::New(env, byteLen);
    memcpy(buf.Data(), body.positions.data(), byteLen);
    obj.Set("positions", Napi::Float32Array::New(env, body.positions.size(), buf, 0));
  }
  // Normals
  {
    size_t byteLen = body.normals.size() * sizeof(float);
    auto buf = Napi::ArrayBuffer::New(env, byteLen);
    memcpy(buf.Data(), body.normals.data(), byteLen);
    obj.Set("normals", Napi::Float32Array::New(env, body.normals.size(), buf, 0));
  }
  // Indices
  {
    size_t byteLen = body.indices.size() * sizeof(uint32_t);
    auto buf = Napi::ArrayBuffer::New(env, byteLen);
    memcpy(buf.Data(), body.indices.data(), byteLen);
    obj.Set("indices", Napi::Uint32Array::New(env, body.indices.size(), buf, 0));
  }
  // BrepFaces
  {
    Napi::Array faces = Napi::Array::New(env, body.brepFaces.size());
    for (size_t i = 0; i < body.brepFaces.size(); i++) {
      Napi::Object f = Napi::Object::New(env);
      f.Set("first", body.brepFaces[i].first);
      f.Set("last", body.brepFaces[i].last);
      if (!body.brepFaces[i].color.empty()) {
        f.Set("color", body.brepFaces[i].color);
      }
      faces.Set((uint32_t)i, f);
    }
    obj.Set("brepFaces", faces);
  }

  return obj;
}

// --- Main API ---

Napi::Value ReadStepFile(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Buffer argument required").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto buffer = info[0].As<Napi::Buffer<uint8_t>>();
  const uint8_t* data = buffer.Data();
  size_t length = buffer.Length();

  // Write buffer to OS temp file (unique name to avoid race conditions)
  std::string tmpPath;
  {
#ifdef _WIN32
    char tmpDir[MAX_PATH];
    GetTempPathA(MAX_PATH, tmpDir);
    tmpPath = std::string(tmpDir) + "cad_step_" + std::to_string(GetCurrentProcessId()) + "_" + std::to_string(reinterpret_cast<uintptr_t>(data)) + ".step";
#else
    tmpPath = "/tmp/cad_step_" + std::to_string(getpid()) + "_" + std::to_string(reinterpret_cast<uintptr_t>(data)) + ".step";
#endif
    FILE* f = fopen(tmpPath.c_str(), "wb");
    if (!f) {
      Napi::Error::New(env, "Cannot create temp file for STEP").ThrowAsJavaScriptException();
      return env.Null();
    }
    fwrite(data, 1, length, f);
    fclose(f);
  }

  // RAII guard: auto-delete temp file on all exit paths
  struct TmpFileGuard {
    std::string path;
    ~TmpFileGuard() { std::remove(path.c_str()); }
  } tmpGuard{tmpPath};

  // Try XDE path first, fallback to simple reader
  std::vector<TessellatedBody> bodies;
  TopoDS_Shape finalShape;
  bool xdeOk = false;
  int totalFailCount = 0;
  std::vector<std::string> totalFailReasons;

  try {
    // XDE path: STEPCAFControl_Reader
    Handle(XCAFApp_Application) app = XCAFApp_Application::GetApplication();
    Handle(TDocStd_Document) doc;
    app->NewDocument("MDTV-XCAF", doc);

    STEPCAFControl_Reader cafReader;
    cafReader.SetColorMode(true);
    cafReader.SetNameMode(true);

    IFSelect_ReturnStatus status = cafReader.ReadFile(tmpPath.c_str());
    if (status == IFSelect_RetDone) {
      cafReader.Transfer(doc);

      // Get all shapes from XDE document (assembly-aware)
      Handle(XCAFDoc_ShapeTool) st = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
      TDF_LabelSequence freeShapes;
      st->GetFreeShapes(freeShapes);
      printf("[OCCT Native] Free shapes in XDE: %d\n", freeShapes.Length()); fflush(stdout);

      if (freeShapes.Length() == 1) {
        finalShape = st->GetShape(freeShapes.Value(1));
      } else if (freeShapes.Length() > 1) {
        TopoDS_Compound compound;
        BRep_Builder builder;
        builder.MakeCompound(compound);
        for (int i = 1; i <= freeShapes.Length(); i++) {
          TopoDS_Shape s = st->GetShape(freeShapes.Value(i));
          if (!s.IsNull()) builder.Add(compound, s);
        }
        finalShape = compound;
      }

      if (!finalShape.IsNull()) {
        // Tessellation
        double deflection = computeDeflection(finalShape);
        BRepMesh_IncrementalMesh mesher(finalShape, deflection, Standard_False, 0.5);
        mesher.Perform();
        // Ensure normals are computed on all faces
        BRepLib::EnsureNormalConsistency(finalShape);

        // XDE tools
        Handle(XCAFDoc_ColorTool) colorTool =
          XCAFDoc_DocumentTool::ColorTool(doc->Main());
        Handle(XCAFDoc_ShapeTool) shapeTool =
          XCAFDoc_DocumentTool::ShapeTool(doc->Main());

        // Helper: resolve color and name for a shape from XDE
        auto resolveColorName = [&](const TopoDS_Shape& shape, int idx, const char* prefix) -> std::pair<std::string, std::string> {
          std::string color;
          std::string name;
          TDF_Label label;
          bool found = shapeTool->FindShape(shape, label);
          if (found) {
            Quantity_Color lc;
            if (colorTool->GetColor(label, XCAFDoc_ColorSurf, lc))
              color = rgbToHex(lc.Red(), lc.Green(), lc.Blue());
            else if (colorTool->GetColor(label, XCAFDoc_ColorGen, lc))
              color = rgbToHex(lc.Red(), lc.Green(), lc.Blue());
            name = getLabelName(label);
          }
          if (color.empty()) getShapeColor(colorTool, shape, color);
          if (color.empty() && found) {
            TDF_Label parent = label.Father();
            if (!parent.IsNull()) {
              Quantity_Color pc;
              if (colorTool->GetColor(parent, XCAFDoc_ColorSurf, pc))
                color = rgbToHex(pc.Red(), pc.Green(), pc.Blue());
              else if (colorTool->GetColor(parent, XCAFDoc_ColorGen, pc))
                color = rgbToHex(pc.Red(), pc.Green(), pc.Blue());
            }
          }
          if (color.empty()) color = DEFAULT_COLOR;
          if (name.empty()) name = std::string(prefix) + " " + std::to_string(idx + 1);
          return {color, name};
        };

        // Count shapes for diagnostics
        int nSolids = 0, nShells = 0, nFaces = 0;
        for (TopExp_Explorer c(finalShape, TopAbs_SOLID); c.More(); c.Next()) nSolids++;
        for (TopExp_Explorer c(finalShape, TopAbs_SHELL, TopAbs_SOLID); c.More(); c.Next()) nShells++;
        for (TopExp_Explorer c(finalShape, TopAbs_FACE, TopAbs_SHELL); c.More(); c.Next()) nFaces++;
        printf("[OCCT Native] Solids: %d, Free shells: %d, Free faces: %d\n", nSolids, nShells, nFaces); fflush(stdout);

        // Extract bodies: solid -> free shell -> free face
        // Each extraction wrapped in try-catch to isolate failures
        int bodyIdx = 0;
        int failCount = 0;
        std::vector<std::string> failReasons;

        auto tryExtract = [&](const TopoDS_Shape& shape, const char* prefix) {
          try {
            auto [color, name] = resolveColorName(shape, bodyIdx, prefix);
            TessellatedBody tb = extractBody(shape, name, color, colorTool);
            if (!tb.indices.empty()) bodies.push_back(std::move(tb));
          } catch (const Standard_Failure& e) {
            failCount++;
            std::string msg = std::string(prefix) + " #" + std::to_string(bodyIdx) + ": OCCT " + e.GetMessageString();
            failReasons.push_back(msg);
          } catch (const std::exception& e) {
            failCount++;
            std::string msg = std::string(prefix) + " #" + std::to_string(bodyIdx) + ": " + e.what();
            failReasons.push_back(msg);
          } catch (...) {
            failCount++;
            std::string msg = std::string(prefix) + " #" + std::to_string(bodyIdx) + ": unknown exception";
            failReasons.push_back(msg);
          }
          bodyIdx++;
        };

        for (TopExp_Explorer exp(finalShape, TopAbs_SOLID); exp.More(); exp.Next())
          tryExtract(exp.Current(), "Body");
        for (TopExp_Explorer exp(finalShape, TopAbs_SHELL, TopAbs_SOLID); exp.More(); exp.Next())
          tryExtract(exp.Current(), "Shell");
        for (TopExp_Explorer exp(finalShape, TopAbs_FACE, TopAbs_SHELL); exp.More(); exp.Next())
          tryExtract(exp.Current(), "Face");

        totalFailCount = failCount;
        totalFailReasons = failReasons;
        xdeOk = !bodies.empty();
      }
    }

    doc->Close();
  } catch (...) {
    // XDE failed, try fallback
  }

  // Fallback: STEPControl_Reader (no colors/names)
  if (!xdeOk) {
    bodies.clear();
    try {
      STEPControl_Reader reader;
      IFSelect_ReturnStatus status = reader.ReadFile(tmpPath.c_str());
      if (status == IFSelect_RetDone) {
        reader.TransferRoots();
        finalShape = reader.OneShape();

        if (!finalShape.IsNull()) {
          double deflection = computeDeflection(finalShape);
          BRepMesh_IncrementalMesh mesher(finalShape, deflection, Standard_False, 0.5);
          mesher.Perform();
          BRepLib::EnsureNormalConsistency(finalShape);

          Handle(XCAFDoc_ColorTool) nullColorTool;
          int bodyIdx = 0;
          // Solids
          for (TopExp_Explorer exp(finalShape, TopAbs_SOLID); exp.More(); exp.Next()) {
            std::string name = "Body " + std::to_string(bodyIdx + 1);
            TessellatedBody tb = extractBody(exp.Current(), name, DEFAULT_COLOR, nullColorTool);
            if (!tb.indices.empty()) bodies.push_back(std::move(tb));
            bodyIdx++;
          }
          // Free shells
          for (TopExp_Explorer exp(finalShape, TopAbs_SHELL, TopAbs_SOLID); exp.More(); exp.Next()) {
            std::string name = "Shell " + std::to_string(bodyIdx + 1);
            TessellatedBody tb = extractBody(exp.Current(), name, DEFAULT_COLOR, nullColorTool);
            if (!tb.indices.empty()) bodies.push_back(std::move(tb));
            bodyIdx++;
          }
          // Free faces
          for (TopExp_Explorer exp(finalShape, TopAbs_FACE, TopAbs_SHELL); exp.More(); exp.Next()) {
            std::string name = "Face " + std::to_string(bodyIdx + 1);
            TessellatedBody tb = extractBody(exp.Current(), name, DEFAULT_COLOR, nullColorTool);
            if (!tb.indices.empty()) bodies.push_back(std::move(tb));
            bodyIdx++;
          }
        }
      }
    } catch (...) {
      // Both paths failed
    }
  }

  // temp file auto-deleted by TmpFileGuard destructor

  if (bodies.empty()) {
    Napi::Error::New(env, "Failed to extract mesh from STEP file").ThrowAsJavaScriptException();
    return env.Null();
  }

  // Store shape for later B-Rep operations
  int shapeHandle = 0;
  if (!finalShape.IsNull()) {
    shapeHandle = ShapeStore::instance().store(finalShape);
  }

  // Build result
  Napi::Object result = Napi::Object::New(env);
  result.Set("shapeHandle", shapeHandle);

  Napi::Array bodiesArr = Napi::Array::New(env, bodies.size());
  for (size_t i = 0; i < bodies.size(); i++) {
    bodiesArr.Set((uint32_t)i, bodyToJs(env, bodies[i]));
  }
  result.Set("bodies", bodiesArr);

  // Diagnostics for JS-side logging
  Napi::Object diag = Napi::Object::New(env);
  int totalSolids = 0, totalShells = 0, totalFaces = 0;
  int emptyBodies = 0;
  if (!finalShape.IsNull()) {
    for (TopExp_Explorer c(finalShape, TopAbs_SOLID); c.More(); c.Next()) totalSolids++;
    for (TopExp_Explorer c(finalShape, TopAbs_SHELL, TopAbs_SOLID); c.More(); c.Next()) totalShells++;
    for (TopExp_Explorer c(finalShape, TopAbs_FACE, TopAbs_SHELL); c.More(); c.Next()) totalFaces++;

    // Count solids with/without triangulation
    for (TopExp_Explorer exp(finalShape, TopAbs_SOLID); exp.More(); exp.Next()) {
      bool hasTri = false;
      for (TopExp_Explorer fExp(exp.Current(), TopAbs_FACE); fExp.More(); fExp.Next()) {
        TopLoc_Location loc;
        Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(TopoDS::Face(fExp.Current()), loc);
        if (!tri.IsNull()) { hasTri = true; break; }
      }
      if (!hasTri) emptyBodies++;
    }
  }
  diag.Set("solids", totalSolids);
  diag.Set("freeShells", totalShells);
  diag.Set("freeFaces", totalFaces);
  diag.Set("emptyBodies", emptyBodies);
  diag.Set("extractedBodies", (int)bodies.size());
  diag.Set("failedBodies", totalFailCount);
  if (!totalFailReasons.empty()) {
    Napi::Array reasons = Napi::Array::New(env, totalFailReasons.size());
    for (size_t i = 0; i < totalFailReasons.size(); i++) {
      reasons.Set((uint32_t)i, totalFailReasons[i]);
    }
    diag.Set("failReasons", reasons);
  }
  result.Set("_diag", diag);

  return result;
}

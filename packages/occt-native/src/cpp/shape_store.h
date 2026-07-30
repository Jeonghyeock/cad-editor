#pragma once
// Shape handle store - manages TopoDS_Shape lifetime
// JS receives opaque integer handles, C++ owns the shapes

#include <TopoDS_Shape.hxx>
#include <unordered_map>
#include <mutex>

class ShapeStore {
public:
  static ShapeStore& instance() {
    static ShapeStore inst;
    return inst;
  }

  int store(const TopoDS_Shape& shape) {
    std::lock_guard<std::mutex> lock(mutex_);
    int id = nextId_++;
    shapes_[id] = shape;
    return id;
  }

  const TopoDS_Shape* get(int id) const {
    auto it = shapes_.find(id);
    return it != shapes_.end() ? &it->second : nullptr;
  }

  bool release(int id) {
    std::lock_guard<std::mutex> lock(mutex_);
    return shapes_.erase(id) > 0;
  }

  void releaseAll() {
    std::lock_guard<std::mutex> lock(mutex_);
    shapes_.clear();
    nextId_ = 1;
  }

private:
  ShapeStore() = default;
  std::unordered_map<int, TopoDS_Shape> shapes_;
  std::mutex mutex_;
  int nextId_ = 1;
};

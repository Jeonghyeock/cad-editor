// 중앙화된 ID 생성 유틸
// 모든 기하, 구속, obstacle 등의 ID를 여기서 생성

export function generateGeometryId(): string {
  return `geom_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function generateConstraintId(prefix = "cst"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateObstacleId(): string {
  return `obstacle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateProjectionId(): string {
  return `__proj_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function generateMeasurementId(): string {
  return `meas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateOperationId(): string {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

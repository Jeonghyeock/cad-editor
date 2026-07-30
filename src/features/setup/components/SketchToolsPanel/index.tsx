// Sketch Tools 입력 패널 — CATIA 스타일 동적 입력 필드
// 도구 활성 중 하단에 표시, 도구/단계별로 필드가 변경
// Tab으로 필드 이동, Enter로 확정

import { useAtom, useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLengthUnit } from "src/shared/hooks/useLengthUnit";

import type { ProfileMode } from "../../Setup.store";
import {
  setupDrawToolAtom,
  setupProfileModeAtom,
  setupSketchWorldPosAtom,
} from "../../Setup.store";
import type { DrawTool, SketchInputField, SketchInputFieldType } from "../../sketch/tools/DrawTool";
import type { ProfileDrawTool } from "../../sketch/tools/ProfileDrawTool";

type SketchToolsPanelProps = {
  getDrawTool: () => DrawTool | null;
  onConfirm: (values: Partial<Record<SketchInputFieldType, number>>) => void;
};

// Profile 모드 버튼 정의
const PROFILE_MODES: { mode: ProfileMode; label: string; title: string }[] = [
  { mode: "line", label: "Line", title: "Line mode (straight segments)" },
  { mode: "tangent-arc", label: "Arc", title: "Tangent Arc mode" },
  { mode: "three-point-arc", label: "3Pt", title: "Three Point Arc mode" },
];

const SketchToolsPanel = ({ getDrawTool, onConfirm }: SketchToolsPanelProps) => {
  const drawToolType = useAtomValue(setupDrawToolAtom);
  const worldPos = useAtomValue(setupSketchWorldPosAtom);
  const lu = useLengthUnit();
  const [profileMode, setProfileMode] = useAtom(setupProfileModeAtom);
  const [isEditing, setIsEditing] = useState(false);
  const isEditingRef = useRef(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const editValuesRef = useRef<Record<string, string>>({});
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const [fields, setFields] = useState<SketchInputField[]>([]);

  // 드래그 상태
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // dimension 도구는 좌표 입력 방식이 아닌 click-on-geometry 방식 (CATIA 와 동일).
  // 다른 일반 draw 도구는 H/V 좌표 입력으로 위치 지정 가능 → 패널 표시.
  const isVisible = drawToolType !== "select" && drawToolType !== "dimension";
  const isProfile = drawToolType === "profile";

  // 도구 변경 시 편집 상태 초기화 + 첫 필드 자동 포커스
  // fields는 의도적으로 제외 — drawToolType 변경 시에만 실행
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    setIsEditing(false);
    isEditingRef.current = false;
    if (drawToolType !== "select") {
      requestAnimationFrame(() => {
        // 다른 input/textarea/contentEditable 에 사용자가 focus 잡고 있으면 auto-focus skip —
        // typing 중인 input 의 focus 를 빼앗는 회귀 방지. SketchToolsPanel 의 input 이
        // 이미 focus 면 그대로 둠 (재진입 시 새 focus 불필요).
        const active = document.activeElement as HTMLElement | null;
        if (active && (
          active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable
        )) {
          return;
        }
        const firstType = fields[0]?.type;
        const firstInput = firstType ? inputRefs.current.get(firstType) : undefined;
        if (firstInput) firstInput.focus();
      });
    }
    // Profile 도구가 아닌 도구로 전환 시 모드 초기화
    if (drawToolType !== "profile") {
      setProfileMode("line");
    }
  }, [drawToolType, setProfileMode]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Profile 모드 변경 시 도구에 동기화
  useEffect(() => {
    const t = getDrawTool();
    if (t && t.type === "profile") {
      (t as ProfileDrawTool).profileMode = profileMode;
    }
  }, [profileMode, getDrawTool, drawToolType]);

  // 마우스 이동마다 필드 갱신 (도구 내부 단계 변경 + 값 갱신)
  const tool = getDrawTool();
  const currentFields = useMemo(() => tool?.getInputFields(worldPos ?? undefined) ?? [
    { type: "H" as const, label: "H", value: worldPos?.x },
    { type: "V" as const, label: "V", value: worldPos?.y },
  ], [tool, worldPos]);
  // 필드 구성 변경 감지 → state 업데이트 (편집 중이 아닐 때만)
  const currentKey = currentFields.map((f) => f.type).join(",");
  const prevKeyRef = useRef("");
  useEffect(() => {
    if (currentKey !== prevKeyRef.current && !isEditingRef.current) {
      prevKeyRef.current = currentKey;
      const t = getDrawTool();
      const cf = t?.getInputFields(worldPos ?? undefined) ?? [];
      setFields(cf);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, worldPos, getDrawTool, fields]);

  // 필드 타입별 기본 표시 값 (편집 중이 아닐 때는 도구에서 계산된 값 사용).
  // type "A" 는 각도 — 환산 X. 그 외 (H/V/X/Y/L/R 등) 는 length — display unit 환산.
  const getDisplayValue = useCallback((field: SketchInputField): string => {
    if (isEditing) return editValues[field.type] ?? "";
    if (field.value !== undefined) {
      if (field.type === "A") return field.value.toFixed(1);
      return lu.toDisplay(field.value).toFixed(2);
    }
    return "0.00";
  }, [isEditing, editValues, lu]);

  const handleFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    // focus만으로 editing 모드 진입 안 함 — 실시간 좌표 업데이트 유지
    // 타이핑(onChange) 시에만 editing 모드로 전환
    requestAnimationFrame(() => e.target.select());
  }, []);

  const handleChange = useCallback((fieldType: string, value: string) => {
    // 첫 타이핑 시 editing 모드 진입 + 현재 값을 초기값으로 복사
    if (!isEditingRef.current) {
      isEditingRef.current = true;
      setIsEditing(true);
      const initVals: Record<string, string> = {};
      for (const f of currentFields) {
        if (f.value !== undefined) {
          initVals[f.type] = f.type === "A"
            ? f.value.toFixed(1)
            : lu.toDisplay(f.value).toFixed(2);
        } else {
          initVals[f.type] = "0.00";
        }
      }
      initVals[fieldType] = value; // 방금 입력한 값 반영
      setEditValues(initVals);
      editValuesRef.current = initVals;
      setFields(currentFields);
      return;
    }
    setEditValues((prev) => {
      const next = { ...prev, [fieldType]: value };
      editValuesRef.current = next;
      return next;
    });
  }, [currentFields, lu]);

  const exitEditing = useCallback(() => {
    isEditingRef.current = false;
    setIsEditing(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>, fieldType: string) => {
    if (e.key === "Tab") {
      e.preventDefault();
      // 다음 필드로 이동 (순환)
      const fieldTypes = fields.map((f) => f.type);
      const idx = fieldTypes.indexOf(fieldType as SketchInputFieldType);
      const nextIdx = (idx + 1) % fieldTypes.length;
      const nextInput = inputRefs.current.get(fieldTypes[nextIdx]);
      nextInput?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result: Partial<Record<SketchInputFieldType, number>> = {};
      for (const [key, val] of Object.entries(editValuesRef.current)) {
        const num = parseFloat(val);
        if (isNaN(num)) continue;
        // length type 은 display unit 입력 → mm 로 역환산 후 commit. angle (A) 그대로.
        result[key as SketchInputFieldType] = key === "A" ? num : lu.fromDisplay(num);
      }
      onConfirm(result);
      exitEditing();
      (e.currentTarget as HTMLElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitEditing();
      (e.currentTarget as HTMLElement).blur();
    }
    e.stopPropagation();
  }, [fields, onConfirm, exitEditing, lu]);

  const setInputRef = useCallback((fieldType: string, el: HTMLInputElement | null) => {
    if (el) inputRefs.current.set(fieldType, el);
    else inputRefs.current.delete(fieldType);
  }, []);

  // 타이틀바 드래그 핸들러
  const handleTitlebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.parentElement?.getBoundingClientRect() ?? rect;
    // 현재 위치 계산 (position이 없으면 현재 렌더 위치 사용)
    const curX = position?.x ?? (rect.left - parentRect.left);
    const curY = position?.y ?? (rect.top - parentRect.top);
    dragOffsetRef.current = {
      x: e.clientX - curX,
      y: e.clientY - curY,
    };

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragOffsetRef.current) return;
      const p = panelRef.current;
      if (!p) return;
      const parentR = p.parentElement?.getBoundingClientRect();
      const panelR = p.getBoundingClientRect();
      const rawX = ev.clientX - dragOffsetRef.current.x;
      const rawY = ev.clientY - dragOffsetRef.current.y;
      if (!parentR) {
        setPosition({ x: rawX, y: rawY });
        return;
      }
      // 캔버스 영역 내부로 클램프 (parent = .input-canvas 가정)
      const PAD = 4;
      const maxX = Math.max(PAD, parentR.width - panelR.width - PAD);
      const maxY = Math.max(PAD, parentR.height - panelR.height - PAD);
      setPosition({
        x: Math.min(Math.max(rawX, PAD), maxX),
        y: Math.min(Math.max(rawY, PAD), maxY),
      });
    };

    const handleMouseUp = () => {
      dragOffsetRef.current = null;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [position]);

  if (!isVisible) return null;

  // 드래그된 위치가 있으면 절대 위치로, 없으면 기본 하단 중앙 위치
  const panelStyle: React.CSSProperties = position
    ? { position: "absolute", left: position.x, top: position.y, transform: "none", bottom: "auto" }
    : {};

  return (
    <div
      ref={panelRef}
      className="input__sketch-tools-panel input__sketch-tools-panel--draggable"
      style={panelStyle}
    >
      <div
        className="input__sketch-tools-panel__titlebar"
        onMouseDown={handleTitlebarMouseDown}
      >
        <span className="input__sketch-tools-panel__titlebar-handle">&#8942;&#8942;</span>
      </div>
      <div className="input__sketch-tools-panel__body">
        {/* Profile 도구 모드 버튼 (Line / Tangent Arc / 3-Point Arc) */}
        {isProfile && (
          <>
            <div className="input__sketch-tools-panel__mode-group">
              {PROFILE_MODES.map(({ mode, label, title }) => (
                <button
                  key={mode}
                  type="button"
                  className={`input__sketch-tools-panel__mode-btn${profileMode === mode ? " input__sketch-tools-panel__mode-btn--active" : ""}`}
                  title={title}
                  onClick={() => setProfileMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="input__sketch-tools-panel__divider" />
          </>
        )}
        {(isEditing ? fields : currentFields).map((field) => (
          <label key={field.type} className="input__sketch-tools-panel__field">
            <span className="input__sketch-tools-panel__label">{field.label}</span>
            <input
              ref={(el) => setInputRef(field.type, el)}
              type="text"
              className="input__sketch-tools-panel__input"
              value={getDisplayValue(field)}
              onChange={(e) => handleChange(field.type, e.target.value)}
              onFocus={handleFocus}
              onKeyDown={(e) => handleKeyDown(e, field.type)}
              readOnly={false}
            />
          </label>
        ))}
      </div>
    </div>
  );
};

export default memo(SketchToolsPanel);

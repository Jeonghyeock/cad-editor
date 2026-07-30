// Over-constrained 시 참조(driven) dimension 생성 확인 프롬프트
// CATIA V5 스타일: "이 치수는 스케치를 과구속합니다. 참조 치수로 생성하시겠습니까?"

import React from "react";
import { useTranslation } from "react-i18next";

type DrivenDimensionPromptProps = {
  visible: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

const DrivenDimensionPrompt: React.FC<DrivenDimensionPromptProps> = ({
  visible,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  if (!visible) return null;

  // \n 줄바꿈 처리 — 메시지 카탈로그에서 한 key 로 받아 <br /> 두 번째 줄로 분할.
  // 카탈로그가 한 줄로 바뀌어도 line2 = "" fallback 으로 렌더 안전.
  const [line1, line2 = ""] = t("dialog.driven.message").split("\n");

  return (
    <div className="driven-dimension-prompt">
      <div className="driven-dimension-prompt__backdrop" onClick={onCancel} />
      <div className="driven-dimension-prompt__dialog">
        <p className="driven-dimension-prompt__message">
          {line1}
          <br />
          {line2}
        </p>
        <div className="driven-dimension-prompt__actions">
          <button
            className="driven-dimension-prompt__btn driven-dimension-prompt__btn--confirm"
            onClick={onConfirm}
          >
            {t("dialog.driven.confirm")}
          </button>
          <button
            className="driven-dimension-prompt__btn driven-dimension-prompt__btn--cancel"
            onClick={onCancel}
          >
            {t("dialog.driven.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DrivenDimensionPrompt;

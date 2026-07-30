import React, { useEffect } from "react";

import Logo from "./logo.svg?react";

// 앱 실행 시 잠깐 뜨는 splash — 아이콘만 크게, 배경 없이 로고만.
// splash 는 별도 window/DOM 이라 html/body/#root 배경을 투명 처리해도 메인 창엔 영향 없음.
const Splash = () => {
  useEffect(() => {
    const targets = [
      document.documentElement,
      document.body,
      document.getElementById("root"),
    ];
    const prev = targets.map((el) => el?.style.background ?? "");
    targets.forEach((el) => {
      if (el) el.style.background = "transparent";
    });
    return () => {
      targets.forEach((el, i) => {
        if (el) el.style.background = prev[i];
      });
    };
  }, []);

  return (
    <div className="splash">
      <Logo className="splash__logo" />
    </div>
  );
};

export default Splash;

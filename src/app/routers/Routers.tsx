import React from "react";
import { HashRouter, Route, Routes } from "react-router-dom";

import AppContainer from "src/app/components/AppContainer";
import AppHeader from "src/app/components/AppHeader";
import AppStatusbar from "src/app/components/AppStatusbar";
import AppTitlebar from "src/app/components/AppTitlebar";
import PageProvider from "src/app/providers/PageProvider";

import Setup from "src/features/setup";
import Splash from "src/features/splash";

// React Router v7 future flag opt-in.
const ROUTER_FUTURE_FLAGS = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
} as const;

const MainRoute = () => (
  <AppContainer>
    <AppTitlebar />
    <AppHeader />
    <PageProvider pageId="setup">
      <Setup />
    </PageProvider>
    <AppStatusbar />
  </AppContainer>
);

const Routers = () => {
  return (
    <HashRouter future={ROUTER_FUTURE_FLAGS}>
      <Routes>
        <Route path="/splash" element={<Splash />} />
        <Route path="*" element={<MainRoute />} />
      </Routes>
    </HashRouter>
  );
};

export default Routers;

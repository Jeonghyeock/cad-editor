import React from "react";

import RootProvider from "src/app/providers/RootProvider";
import Routers from "src/app/routers/Routers";

import ContextMenu from "src/components/ContextMenu";
import ErrorBoundary from "src/components/ErrorBoundary";
import Toast from "src/components/Toast";

import BakedSketchesHydrator from "src/features/setup/components/BakedSketchesHydrator";

const App = () => {
  return (
    <RootProvider>
      <ErrorBoundary>
        <Routers />
      </ErrorBoundary>
      <ContextMenu />
      <Toast />
      <BakedSketchesHydrator />
    </RootProvider>
  );
};

export default App;

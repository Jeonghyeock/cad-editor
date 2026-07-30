import React from "react";

import StoreProvider from "./StoreProvider";

const RootProvider = ({
  children,
}: Readonly<{ children: React.ReactNode }>) => {
  return <StoreProvider>{children}</StoreProvider>;
};

export default RootProvider;

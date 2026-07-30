import React from "react";
import { createRoot } from "react-dom/client";

import "src/shared/i18n";
import "src/shared/styles/index.scss";

import App from "./App";

const container = document.getElementById("root") as HTMLDivElement;
const root = createRoot(container);

root.render(<App />);

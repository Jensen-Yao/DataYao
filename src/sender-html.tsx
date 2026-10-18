import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SenderHtmlApp } from "./SenderHtmlApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SenderHtmlApp />
  </StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import FloatingApp from "./FloatingApp";

const isFloating =
  window.location.hash.startsWith("#floating/") ||
  ((window as any).__TAURI_INTERNALS__?.webview?.label || "").startsWith("float-");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isFloating ? <FloatingApp /> : <App />}
  </React.StrictMode>
);

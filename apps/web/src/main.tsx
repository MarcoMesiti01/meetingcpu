import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "./api/client";
import App from "./App";
import { BrowserUploadChunker } from "./audio/uploadChunker";
import { BrowserAudioRecorder } from "./audio/recorder";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found.");
}

createRoot(root).render(
  <StrictMode>
    <App api={createApiClient()} recorder={new BrowserAudioRecorder()} uploadChunker={new BrowserUploadChunker()} />
  </StrictMode>
);

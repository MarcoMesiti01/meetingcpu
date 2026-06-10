import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(() => {
  const serverPort = process.env.MEETINGCPU_SERVER_PORT ?? process.env.PORT ?? "5174";

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": `http://127.0.0.1:${serverPort}`
      }
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: []
    }
  };
});

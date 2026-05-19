import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { createRoutes, type RouteDependencies } from "./routes.js";

export function createApp(dependencies: RouteDependencies) {
  const app = express();
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());
  app.use("/api", createRoutes(dependencies));
  app.use(errorHandler);
  return app;
}

function corsOrigin(origin: string | undefined, callback: (error: Error | null, origin?: boolean | string) => void): void {
  if (!origin) {
    callback(null, true);
    return;
  }

  callback(null, isAllowedLocalOrigin(origin) ? origin : false);
}

function isAllowedLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function errorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (isMulterFileSizeError(error)) {
    response.status(413).json({
      code: "AUDIO_TOO_LARGE",
      message: "Audio uploads must be 500 MB or smaller."
    });
    return;
  }

  next(error);
}

function isMulterFileSizeError(error: unknown): error is { code: "LIMIT_FILE_SIZE" } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "LIMIT_FILE_SIZE";
}

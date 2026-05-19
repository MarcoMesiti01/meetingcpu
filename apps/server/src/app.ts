import cors from "cors";
import express from "express";
import { createRoutes, type RouteDependencies } from "./routes.js";

export function createApp(dependencies: RouteDependencies) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api", createRoutes(dependencies));
  return app;
}

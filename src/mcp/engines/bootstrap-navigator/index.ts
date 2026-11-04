import type { ToolDefinition } from "../../tool.ts";
import { nyxProjectBootstrapTool } from "./bootstrap.ts";
import { nyxDnaExtractTool, nyxDnaGetTool } from "./dna.ts";
import { detectInstalledHosts, nyxEnvDoctorTool, resolveRipgrepBinary } from "./env-doctor.ts";
import { computeFileSkeleton, nyxSymbolSkeletonTool } from "./skeleton.ts";
import { nyxTraceSymbolTool } from "./trace.ts";

export {
  nyxEnvDoctorTool,
  detectInstalledHosts,
  resolveRipgrepBinary,
  nyxProjectBootstrapTool,
  nyxDnaExtractTool,
  nyxDnaGetTool,
  nyxSymbolSkeletonTool,
  computeFileSkeleton,
  nyxTraceSymbolTool,
};

export const bootstrapNavigatorEngineTools: ToolDefinition[] = [
  nyxEnvDoctorTool,
  nyxProjectBootstrapTool,
  nyxDnaExtractTool,
  nyxDnaGetTool,
  nyxSymbolSkeletonTool,
  nyxTraceSymbolTool,
];

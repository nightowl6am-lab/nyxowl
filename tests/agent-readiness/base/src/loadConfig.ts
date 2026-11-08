export interface Config {
  databaseUrl: string;
  apiKey: string;
  featureY: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? "",
    apiKey: env.API_KEY ?? "",
    featureY: env.FEATURE_Y ?? "",
  };
}

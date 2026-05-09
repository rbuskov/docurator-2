import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { getDb } from "./db/index.js";
import { migrate } from "./db/migrate.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(moduleDir, "./db/migrations");

mkdirSync(dirname(resolve(config.dbPath)), { recursive: true });
migrate(getDb(), migrationsDir);

// In production, serve the built client from `dist/client` (sibling of
// `dist/server`). In dev, leave it unset so requests to `/` fall through —
// developers should load the UI from Vite at :5173, which proxies the API.
const staticDir =
    process.env.NODE_ENV === "production"
        ? resolve(moduleDir, "../client")
        : undefined;

const app = createApp({ staticDir });

serve(
    {
        fetch: app.fetch,
        port: config.port,
        hostname: "0.0.0.0",
    },
    (info) => {
        console.log(`Docurator listening on http://localhost:${info.port}`);
    },
);

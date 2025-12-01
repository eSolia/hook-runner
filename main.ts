// --- main.ts (Updated for Correct Deno Deploy Log Endpoint) ---

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { Cron } from "https://deno.land/x/croner@8.1.2/dist/croner.js";

interface Webhook {
  id: string; // UUID for unique identification
  name: string;
  url: string;
  schedule: string; // Cron schedule string
  headers?: Record<string, string>; // Optional custom headers (e.g., Authorization)
  createdAt: string;
}

// Deno Deploy API type definitions (simplified for relevant fields)
interface DenoDeployDeployment {
  id: string;
  createdAt: string; // ISO 8601 string
  // ... other fields like projectId, url, etc.
}

interface DenoDeployLogEntry {
    message: string;
    level: string; // e.g., "info", "error", "warning"
    region: string;
    timestamp: string; // ISO 8601 string
    // ... potentially other fields
}


const kv = await Deno.openKv(); // Open Deno KV database

// --- SINGLE TOP-LEVEL CRON JOB FOR DYNAMIC SCHEDULING ---
console.log("Registering a single top-level Deno cron job to manage dynamic webhooks...");
Deno.cron("webhook-kv-scheduler", "* * * * *", async () => { // Runs every minute in UTC
  console.log(`[webhook-kv-scheduler] Running at ${new Date().toISOString()}`);
  const now = new Date(); // Current time for schedule comparison (in UTC)
  const oneMinute = 60 * 1000; // One minute in milliseconds
  const minuteAgo = new Date(now.getTime() - oneMinute);

  const iter = kv.list<Webhook>({ prefix: ["webhooks"] });
  for await (const entry of iter) {
    const hook = entry.value;
    try {
      const cron = new Cron(hook.schedule);

      const nextFromMinuteAgo = cron.nextRun(minuteAgo);

      if (nextFromMinuteAgo && Math.abs(now.getTime() - nextFromMinuteAgo.getTime()) < 5 * 1000) {
        const lastTriggeredKey = ["last_triggered", hook.id];
        const lastTriggeredEntry = await kv.get<string>(lastTriggeredKey);

        let hasTriggeredThisMinute = false;
        if (lastTriggeredEntry.value) {
            const lastTriggeredDate = new Date(lastTriggeredEntry.value);
            if (lastTriggeredDate.getUTCFullYear() === now.getUTCFullYear() &&
                lastTriggeredDate.getUTCMonth() === now.getUTCMonth() &&
                lastTriggeredDate.getUTCDate() === now.getUTCDate() &&
                lastTriggeredDate.getUTCHours() === now.getUTCHours() &&
                lastTriggeredDate.getUTCMinutes() === now.getUTCMinutes()) {
                hasTriggeredThisMinute = true;
            }
        }

        if (!hasTriggeredThisMinute) {
          console.log(`[webhook-kv-scheduler] Triggering scheduled webhook: ${hook.name} (ID: ${hook.id}) due at ${nextFromMinuteAgo.toISOString()}`);
          await pingWebhook(hook.url, hook.name, hook.headers);
          await kv.set(lastTriggeredKey, now.toISOString()); // Mark as triggered now (in UTC)
        } else {
          console.log(`[webhook-kv-scheduler] Webhook ${hook.name} (ID: ${hook.id}) already triggered this minute.`);
        }
      }

    } catch (parseError) {
      console.error(`[webhook-kv-scheduler] Error parsing cron schedule for ${hook.name} (ID: ${hook.id}): ${parseError.message}`);
    }
  }
  console.log(`[webhook-kv-scheduler] Finished run.`);
});

// --- Configuration from Environment Variables ---
const ADMIN_USERNAME = Deno.env.get("WEBHOOK_ADMIN_USERNAME");
const ADMIN_PASSWORD = Deno.env.get("WEBHOOK_ADMIN_PASSWORD");
const DD_PROJECT_ID = Deno.env.get("DD_PROJECT_ID");
const DD_ACCESS_TOKEN = Deno.env.get("DD_ACCESS_TOKEN");

// --- Global variables for asset metadata ---
const ENTRY_POINT_URL = `main.ts`; // Relative to the project root in Deno Deploy
const REPO_RAW_BASE_URL = `https://raw.githubusercontent.com/eSolia/hook-runner/refs/heads/main/`; // Assuming a 'main' branch
const INDEX_HTML_RAW_URL = `${REPO_RAW_BASE_URL}static/index.html`;

// --- Environment Variable Warnings ---
if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.warn("WARNING: WEBHOOK_ADMIN_USERNAME or WEBHOOK_ADMIN_PASSWORD environment variables are not set. The UI will not be password protected!");
}

if (!DD_PROJECT_ID || !DD_ACCESS_TOKEN) {
    console.warn("WARNING: DD_PROJECT_ID or DD_ACCESS_TOKEN environment variables are not set. Automated redeployments and log fetching will not work!");
}


// --- Generic Webhook Pinger Function ---
async function pingWebhook(webhookUrl: string, name: string, headers?: Record<string, string>) {
  if (!webhookUrl) {
    console.warn(`Skipping webhook "${name}": URL not provided.`);
    return;
  }
  console.log(`Attempting to ping webhook: "${name}" at ${new Date().toISOString()}`);
  try {
    const fetchOptions: RequestInit = {
      method: 'POST',
    };

    // Add custom headers if provided
    if (headers && Object.keys(headers).length > 0) {
      fetchOptions.headers = headers;
      console.log(`  with custom headers: ${Object.keys(headers).join(', ')}`);
    }

    const response = await fetch(webhookUrl, fetchOptions);

    if (response.ok) {
      console.log(`Successfully pinged "${name}" webhook. Status: ${response.status}`);
    } else {
      console.error(`Failed to ping "${name}" webhook. Status: ${response.status}, Response: ${await response.text()}`);
    }
  } catch (error) {
    console.error(`Error pinging "${name}" webhook:`, error);
  }
}

// --- HTTP Basic Authentication Middleware ---
function basicAuth(req: Request): Response | null {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    return null;
  }

  const authHeader = req.headers.get("Authorization");

  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Webhook Scheduler"',
      },
    });
  }

  const encodedCreds = authHeader.substring(6);
  const decodedCreds = atob(encodedCreds);
  const [username, password] = decodedCreds.split(":");

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return null;
  } else {
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Webhook Scheduler"',
      },
    });
  }
}

// --- Function to trigger Deno Deploy redeploy ---
async function triggerDenoDeployRedeploy(): Promise<boolean> {
    if (!DD_PROJECT_ID || !DD_ACCESS_TOKEN) {
        console.error("Cannot trigger redeploy: Project ID or Access Token is missing.");
        return false;
    }

    let indexHtmlContent: string;
    try {
        console.log(`Fetching index.html content from: ${INDEX_HTML_RAW_URL}`);
        const response = await fetch(INDEX_HTML_RAW_URL);
        if (!response.ok) {
            throw new Error(`Failed to fetch index.html: ${response.statusText}`);
        }
        indexHtmlContent = await response.text();
        console.log("index.html content fetched successfully.");
    } catch (error) {
        console.error("Error fetching index.html for redeploy:", error);
        return false;
    }

    const deployUrl = `https://api.deno.com/v1/projects/${DD_PROJECT_ID}/deployments`;
    console.log(`Attempting to trigger redeploy for project ID: ${DD_PROJECT_ID}`);

    try {
        const response = await fetch(deployUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${DD_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                entryPointUrl: ENTRY_POINT_URL,
                assets: {
                    "static/index.html": {
                        kind: "file",
                        content: indexHtmlContent,
                        encoding: "utf-8",
                    },
                },
                envVars: {},
            }),
        });

        if (response.ok) {
            console.log("Deno Deploy redeploy request sent successfully.");
            return true;
        } else {
            const errorText = await response.text();
            console.error(`Failed to trigger Deno Deploy redeploy. Status: ${response.status}, Response: ${errorText}`);
            return false;
        }
    } catch (error) {
        console.error("Error during Deno Deploy redeploy API call:", error);
        return false;
    }
}

// --- Function to fetch Deno Deploy Logs ---
async function fetchDenoDeployLogs(): Promise<DenoDeployLogEntry[]> {
    if (!DD_PROJECT_ID || !DD_ACCESS_TOKEN) {
        throw new Error("Deno Deploy Project ID or Access Token is missing. Cannot fetch logs.");
    }

    // 1. Get current deployment ID
    const deploymentsUrl = `https://api.deno.com/v1/projects/${DD_PROJECT_ID}/deployments`;
    let deploymentId: string | null = null;
    try {
        const deploymentsResponse = await fetch(deploymentsUrl, {
            headers: {
                'Authorization': `Bearer ${DD_ACCESS_TOKEN}`,
            },
        });
        if (!deploymentsResponse.ok) {
            throw new Error(`Failed to fetch deployments: ${deploymentsResponse.status} - ${await deploymentsResponse.text()}`);
        }
        const deployments: DenoDeployDeployment[] = await deploymentsResponse.json();

        // Sort by creation date to get the latest deployment
        const latestDeployment = deployments.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

        if (latestDeployment) {
            deploymentId = latestDeployment.id;
            console.log(`Fetching logs for latest deployment ID: ${deploymentId}`);
        } else {
            console.warn("No deployments found for this project.");
            return [];
        }
    } catch (error) {
        console.error("Error fetching deployments for log retrieval:", error);
        throw error;
    }

    // 2. Fetch logs for the latest deployment
    // Use the correct app_logs endpoint and specify JSON format
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago
    const sinceParam = twentyFourHoursAgo.toISOString();
    const untilParam = now.toISOString();

    const logsUrl = `https://api.deno.com/v1/deployments/${deploymentId}/app_logs?since=${sinceParam}&until=${untilParam}`;
    try {
        const logsResponse = await fetch(logsUrl, {
            headers: {
                'Authorization': `Bearer ${DD_ACCESS_TOKEN}`,
                'Accept': 'application/json', // Request JSON array format
            },
        });

        if (!logsResponse.ok) {
            throw new Error(`Failed to fetch logs: ${logsResponse.status} - ${await logsResponse.text()}`);
        }

        const parsedLogs: DenoDeployLogEntry[] = await logsResponse.json();
        return parsedLogs;

    } catch (error) {
        console.error("Error fetching logs from Deno Deploy API:", error);
        throw error;
    }
}


// --- Function to update a webhook ---
async function updateWebhook(id: string, updatedData: Partial<Webhook>): Promise<Webhook | null> {
    const key = ["webhooks", id];
    const entry = await kv.get<Webhook>(key);

    if (!entry.value) {
        return null; // Webhook not found
    }

    const currentHook = entry.value;
    const newHook: Webhook = {
        ...currentHook,
        ...updatedData,
        id: currentHook.id,
        createdAt: currentHook.createdAt,
    };

    // Handle headers: if empty object was passed, remove headers entirely
    if (updatedData.headers && Object.keys(updatedData.headers).length === 0) {
        delete newHook.headers;
    }

    await kv.set(key, newHook);
    return newHook;
}

// --- HTTP Server for UI and KV Management ---
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Apply basic authentication to all routes
  const authResponse = basicAuth(req);
  if (authResponse) {
    return authResponse;
  }

  // Serve static HTML file
  if (url.pathname === "/") {
    const filePath = join(Deno.cwd(), "static", "index.html");
    try {
      const file = await Deno.readFile(filePath);
      return new Response(file, {
        headers: { "Content-Type": "text/html" },
      });
    } catch (error) {
      console.error("Error serving index.html:", error);
      return new Response("Internal Server Error: Could not load UI.", { status: 500 });
    }
  }

  // API to list all webhooks
  if (url.pathname === "/hooks" && req.method === "GET") {
    const hooks: Webhook[] = [];
    const iter = kv.list<Webhook>({ prefix: ["webhooks"] });
    for await (const entry of iter) {
      hooks.push(entry.value);
    }
    return new Response(JSON.stringify(hooks), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // API to add a new webhook
  if (url.pathname === "/hooks" && req.method === "POST") {
    try {
      const data = await req.json();
      const { name, url, schedule, headers } = data;

      if (!name || !url || !schedule) {
        return new Response("Missing required fields: name, url, schedule", { status: 400 });
      }

      const id = crypto.randomUUID();
      const newHook: Webhook = {
        id,
        name: String(name),
        url: String(url),
        schedule: String(schedule),
        createdAt: new Date().toISOString(),
      };

      // Add optional headers if provided
      if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
        newHook.headers = headers as Record<string, string>;
      }

      await kv.set(["webhooks", id], newHook);

      return new Response(JSON.stringify(newHook), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error adding webhook:", error);
      return new Response(`Failed to add webhook: ${error.message}`, { status: 500 });
    }
  }

  // API to update a webhook
  if (url.pathname.startsWith("/hooks/") && req.method === "PUT") {
    const id = url.pathname.split("/").pop();
    if (!id) {
      return new Response("Webhook ID missing", { status: 400 });
    }

    try {
      const data = await req.json();
      const updatedHook = await updateWebhook(id, data);

      if (!updatedHook) {
        return new Response("Webhook not found", { status: 404 });
      }

      return new Response(JSON.stringify(updatedHook), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error updating webhook:", error);
      return new Response(`Failed to update webhook: ${error.message}`, { status: 500 });
    }
  }

  // API to delete a webhook
  if (url.pathname.startsWith("/hooks/") && req.method === "DELETE") {
    const id = url.pathname.split("/").pop();
    if (!id) {
      return new Response("Webhook ID missing", { status: 400 });
    }

    try {
      await kv.delete(["webhooks", id]);
      return new Response(null, { status: 204 });
    } catch (error) {
      console.error("Error deleting webhook:", error);
      return new Response(`Failed to delete webhook: ${error.message}`, { status: 500 });
    }
  }

  // API endpoint to trigger redeploy
  if (url.pathname === "/redeploy" && req.method === "POST") {
    console.log("Redeploy endpoint hit.");
    const success = await triggerDenoDeployRedeploy();
    if (success) {
        return new Response("Redeploy triggered successfully.", { status: 200 });
    } else {
        return new Response("Failed to trigger redeploy.", { status: 500 });
    }
  }

  // NEW: API endpoint to fetch logs
  if (url.pathname === "/logs" && req.method === "GET") {
    try {
        const logs = await fetchDenoDeployLogs();
        return new Response(JSON.stringify(logs), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        console.error("Error fetching logs for UI:", error);
        return new Response(`Failed to fetch logs: ${error.message}`, { status: 500 });
    }
  }

  // Fallback for unknown routes
  return new Response("Not Found", { status: 404 });
}

console.log("HTTP server starting...");
serve(handler);
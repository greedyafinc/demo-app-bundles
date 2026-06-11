import { Hono } from 'hono';
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming'
import { describeRoute, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import z from 'zod';
import path from 'path';
import fsp from 'fs/promises';
import { glob } from 'node:fs/promises';
import container from './di/container.js';
import { executeTool, listServers, listTools } from "./mcp/mcp.js";
import { ListToolsResponse, McpServerDefinition, McpServerList } from "./mcp/schema.js";
import { IMcpConfigRepo } from './mcp/repo.js';
import { IModelConfigRepo } from './models/repo.js';
import { ModelConfig, Provider } from "./models/models.js";
import { IAgentsRepo } from "./agents/repo.js";
import { Agent } from "./agents/agents.js";
import { AskHumanResponsePayload, authorizePermission, createMessage, createRun, replyToHumanInputRequest, Run, stop, ToolPermissionAuthorizePayload } from './runs/runs.js';
import { IRunsRepo, CreateRunOptions, ListRunsResponse } from './runs/repo.js';
import { IBus } from './application/lib/bus.js';
import { cors } from 'hono/cors';
import { WorkDir } from './config/config.js';
import { getUnifiedSdk } from './unified/sdk.js';

// Resolve a user-supplied file name inside a workspace dir, rejecting any
// path that escapes it (the ?file= params are attacker-controllable inputs).
function safeJoin(base: string, name: string | undefined): string | null {
    if (!name || name.includes("\0") || path.isAbsolute(name)) return null;
    const resolvedBase = path.resolve(base);
    const resolved = path.resolve(resolvedBase, name);
    if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) return null;
    return resolved;
}

// Shared SSE handler — exposed at both /stream (TUI, CLI) and /api/stream
// (the dashboard's EventSource, which is page-origin-relative).
async function streamRunEvents(c: any) {
    return streamSSE(c, async (stream: any) => {
        const bus = container.resolve<IBus>('bus');

        let id = 0;
        let unsub: (() => void) | null = null;
        let aborted = false;

        stream.onAbort(() => {
            aborted = true;
            if (unsub) {
                unsub();
            }
        });

        // Subscribe to your bus
        unsub = await bus.subscribe('*', async (event: unknown) => {
            if (aborted) return;

            await stream.writeSSE({
                data: JSON.stringify(event),
                event: "message",
                id: String(id++),
            });
        });

        // Keep the function alive until the client disconnects
        while (!aborted) {
            await stream.sleep(1000); // any interval is fine
        }
    });
}

const routes = new Hono()
    .get(
        '/health',
        describeRoute({
            summary: 'Health check',
            description: 'Service liveness probe',
        }),
        (c) => c.json({ status: "ok" as const })
    )
    .post(
        '/runs/new',
        describeRoute({
            summary: 'Create a new run',
            description: 'Create a new run for an agent',
        }),
        validator('json', CreateRunOptions),
        async (c) => {
            const run = await createRun(c.req.valid('json'));
            return c.json(run);
        }
    )
    .get(
        '/runs',
        describeRoute({
            summary: 'List runs',
            description: 'List runs, newest first',
        }),
        async (c) => {
            const repo = container.resolve<IRunsRepo>('runsRepo');
            const result = await repo.list(c.req.query('cursor'));
            return c.json(result);
        }
    )
    .get(
        '/runs/:runId',
        describeRoute({
            summary: 'Fetch run',
            description: 'Fetch a run including its event log',
        }),
        validator('param', z.object({
            runId: z.string(),
        })),
        async (c) => {
            const repo = container.resolve<IRunsRepo>('runsRepo');
            try {
                return c.json(await repo.fetch(c.req.valid('param').runId));
            } catch {
                return c.json({ error: "run not found" }, 404);
            }
        }
    )
    .post(
        '/runs/:runId/messages/new',
        describeRoute({
            summary: 'Create a new message',
            description: 'Create a new message',
            responses: {
                200: {
                    description: 'Message created',
                    content: {
                        'application/json': {
                            schema: resolver(z.object({
                                messageId: z.string(),
                            })),
                        },
                    },
                },
            },
        }),
        validator('param', z.object({
            runId: z.string(),
        })),
        validator('json', z.object({
            message: z.string(),
        })),
        async (c) => {
            const messageId = await createMessage(c.req.valid('param').runId, c.req.valid('json').message);
            return c.json({
                messageId,
            });
        }
    )
    .post(
        '/runs/:runId/permissions/authorize',
        describeRoute({
            summary: 'Authorize permission',
            description: 'Authorize a permission',
            responses: {
                200: {
                    description: 'Permission authorized',
                    content: {
                        'application/json': {
                            schema: resolver(z.object({
                                success: z.literal(true),
                            })),
                        },
                    }
                },
            },
        }),
        validator('param', z.object({
            runId: z.string(),
        })),
        validator('json', ToolPermissionAuthorizePayload),
        async (c) => {
            const response = await authorizePermission(
                c.req.valid('param').runId,
                c.req.valid('json')
            );
            return c.json({
                success: true,
            });
        }
    )
    .post(
        '/runs/:runId/human-input-requests/:requestId/reply',
        describeRoute({
            summary: 'Reply to human input request',
            description: 'Reply to a human input request',
            responses: {
                200: {
                    description: 'Human input request replied',
                },
            },
        }),
        validator('param', z.object({
            runId: z.string(),
        })),
        validator('json', AskHumanResponsePayload),
        async (c) => {
            const response = await replyToHumanInputRequest(
                c.req.valid('param').runId,
                c.req.valid('json')
            );
            return c.json({
                success: true,
            });
        }
    )
    .post(
        '/runs/:runId/stop',
        describeRoute({
            summary: 'Stop run',
            description: 'Stop a run',
            responses: {
                200: {
                    description: 'Run stopped',
                },
            },
        }),
        validator('param', z.object({
            runId: z.string(),
        })),
        async (c) => {
            const response = await stop(c.req.valid('param').runId);
            return c.json({
                success: true,
            });
        }
    )
    .get(
        '/agents',
        describeRoute({
            summary: 'List agents',
            description: 'List all agents in the workspace',
        }),
        async (c) => {
            const repo = container.resolve<IAgentsRepo>('agentsRepo');
            return c.json(await repo.list());
        }
    )
    .get(
        '/agents/:id',
        describeRoute({
            summary: 'Fetch agent',
            description: 'Fetch a single agent by id',
        }),
        validator('param', z.object({
            id: z.string(),
        })),
        async (c) => {
            const repo = container.resolve<IAgentsRepo>('agentsRepo');
            try {
                return c.json(await repo.fetch(c.req.valid('param').id));
            } catch {
                return c.json({ error: "agent not found" }, 404);
            }
        }
    )
    .put(
        '/agents/:id',
        describeRoute({
            summary: 'Update agent',
            description: 'Update a single agent by id',
        }),
        validator('param', z.object({
            id: z.string(),
        })),
        async (c) => {
            const id = c.req.valid('param').id;
            const body = await c.req.json();
            const agent = Agent.parse({ ...body, name: id });
            const repo = container.resolve<IAgentsRepo>('agentsRepo');
            await repo.update(id, agent);
            return c.json({ success: true });
        }
    )
    .get(
        '/mcp',
        describeRoute({
            summary: 'Get MCP config',
            description: 'Get the MCP server configuration',
        }),
        async (c) => {
            const repo = container.resolve<IMcpConfigRepo>('mcpConfigRepo');
            return c.json(await repo.getConfig());
        }
    )
    .put(
        '/mcp/:name',
        describeRoute({
            summary: 'Upsert MCP server',
            description: 'Create or update an MCP server definition',
        }),
        validator('param', z.object({
            name: z.string(),
        })),
        validator('json', McpServerDefinition),
        async (c) => {
            const repo = container.resolve<IMcpConfigRepo>('mcpConfigRepo');
            await repo.upsert(c.req.valid('param').name, c.req.valid('json'));
            return c.json({ success: true });
        }
    )
    .delete(
        '/mcp/:name',
        describeRoute({
            summary: 'Delete MCP server',
            description: 'Delete an MCP server definition',
        }),
        validator('param', z.object({
            name: z.string(),
        })),
        async (c) => {
            const repo = container.resolve<IMcpConfigRepo>('mcpConfigRepo');
            await repo.delete(c.req.valid('param').name);
            return c.json({ success: true });
        }
    )
    .get(
        '/models',
        describeRoute({
            summary: 'Get model config',
            description: 'Get the model provider configuration',
        }),
        async (c) => {
            const repo = container.resolve<IModelConfigRepo>('modelConfigRepo');
            return c.json(await repo.getConfig());
        }
    )
    .put(
        '/models/providers/:name',
        describeRoute({
            summary: 'Upsert model provider',
            description: 'Create or update a model provider',
        }),
        validator('param', z.object({
            name: z.string(),
        })),
        validator('json', Provider),
        async (c) => {
            const repo = container.resolve<IModelConfigRepo>('modelConfigRepo');
            await repo.upsert(c.req.valid('param').name, c.req.valid('json'));
            return c.json({ success: true });
        }
    )
    .delete(
        '/models/providers/:name',
        describeRoute({
            summary: 'Delete model provider',
            description: 'Delete a model provider',
        }),
        validator('param', z.object({
            name: z.string(),
        })),
        async (c) => {
            const repo = container.resolve<IModelConfigRepo>('modelConfigRepo');
            await repo.delete(c.req.valid('param').name);
            return c.json({ success: true });
        }
    )
    .put(
        '/models/default',
        describeRoute({
            summary: 'Set default model',
            description: 'Set the default provider + model',
        }),
        validator('json', z.object({
            provider: z.string(),
            model: z.string(),
        })),
        async (c) => {
            const { provider, model } = c.req.valid('json');
            const repo = container.resolve<IModelConfigRepo>('modelConfigRepo');
            await repo.setDefault(provider, model);
            return c.json({ success: true });
        }
    )
    .get(
        '/config/:name',
        describeRoute({
            summary: 'Read config file',
            description: 'Read a JSON config file from the workspace config dir',
        }),
        validator('param', z.object({
            name: z.string(),
        })),
        async (c) => {
            const file = safeJoin(path.join(WorkDir, "config"), c.req.valid('param').name);
            if (!file) return c.json({ error: "invalid file name" }, 400);
            try {
                return c.json(JSON.parse(await fsp.readFile(file, "utf8")));
            } catch {
                return c.json({ error: "config not found" }, 404);
            }
        }
    )
    .get(
        '/unified/models',
        describeRoute({
            summary: 'List UnifiedAI catalog models',
            description: 'List the models served by the UnifiedAI gateway (via @unifiedai/sdk), with author metadata. 503 when running outside the UnifiedApp desktop host.',
        }),
        async (c) => {
            const sdk = getUnifiedSdk();
            if (!sdk) {
                return c.json({ error: "UnifiedAI is not configured (not running inside the UnifiedApp desktop host)" }, 503);
            }
            try {
                return c.json(await sdk.models.list({ include: ["author"] }));
            } catch (err) {
                return c.json({ error: err instanceof Error ? err.message : "gateway models fetch failed" }, 502);
            }
        }
    )
    .get(
        '/stream',
        describeRoute({
            summary: 'Subscribe to run events',
            description: 'Subscribe to run events',
        }),
        streamRunEvents
    )
    ;

// ── Dashboard-origin routes ──────────────────────────────────────────────────
// The static rowboatx dashboard fetches these relative to its own origin (not
// the configurable apiBase): the SSE stream alias plus light file-level access
// to the workspace (sidebar summary, markdown agent/config editors, run logs).
const dashboardRoutes = new Hono()
    .get('/api/stream', streamRunEvents)
    .get('/api/rowboat/summary', async (c) => {
        const list = async (dir: string, pattern: string) => {
            try {
                return (await Array.fromAsync(glob(pattern, { cwd: dir }))).sort();
            } catch {
                return [];
            }
        };
        const [agents, config, runs] = await Promise.all([
            list(path.join(WorkDir, "agents"), "**/*.md"),
            list(path.join(WorkDir, "config"), "*"),
            list(path.join(WorkDir, "runs"), "*.jsonl"),
        ]);
        // Newest runs first (ids are monotonically increasing).
        runs.reverse();
        return c.json({ agents, config, runs });
    })
    .get('/api/rowboat/agent', async (c) => {
        const file = safeJoin(path.join(WorkDir, "agents"), c.req.query('file'));
        if (!file) return c.json({ error: "invalid file name" }, 400);
        try {
            return c.json({ content: await fsp.readFile(file, "utf8") });
        } catch {
            return c.json({ error: "agent file not found" }, 404);
        }
    })
    .put('/api/rowboat/agent', async (c) => {
        const file = safeJoin(path.join(WorkDir, "agents"), c.req.query('file'));
        if (!file || !/\.(md|markdown)$/i.test(file)) return c.json({ error: "invalid file name" }, 400);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, await c.req.text());
        return c.json({ success: true });
    })
    .get('/api/rowboat/config', async (c) => {
        const file = safeJoin(path.join(WorkDir, "config"), c.req.query('file'));
        if (!file) return c.json({ error: "invalid file name" }, 400);
        try {
            return c.json({ content: await fsp.readFile(file, "utf8") });
        } catch {
            return c.json({ error: "config file not found" }, 404);
        }
    })
    .put('/api/rowboat/config', async (c) => {
        const file = safeJoin(path.join(WorkDir, "config"), c.req.query('file'));
        if (!file || !/\.(md|markdown)$/i.test(file)) return c.json({ error: "invalid file name" }, 400);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, await c.req.text());
        return c.json({ success: true });
    })
    .get('/api/rowboat/run', async (c) => {
        const file = safeJoin(path.join(WorkDir, "runs"), c.req.query('file'));
        if (!file) return c.json({ error: "invalid file name" }, 400);
        try {
            return c.json({ raw: await fsp.readFile(file, "utf8") });
        } catch {
            return c.json({ error: "run log not found" }, 404);
        }
    })
    ;

const app = new Hono()
    .use("/*", cors())
    .route("/", routes)
    .route("/", dashboardRoutes)
    .get(
        "/openapi.json",
        openAPIRouteHandler(routes, {
            documentation: {
                info: {
                    title: "Hono",
                    version: "1.0.0",
                    description: "RowboatX API",
                },
            },
        }),
    );

// Serve the static rowboatx dashboard (Next.js export) when present —
// ROWBOAT_UI_DIR is a path RELATIVE to the process working directory (the
// marketplace bundle root sets "ui/out"). API routes above take precedence;
// this only answers GETs that match exported files.
const uiDir = process.env.ROWBOAT_UI_DIR;
if (uiDir) {
    app.use("/*", serveStatic({ root: uiDir }));
}

// export default app;

serve({
    fetch: app.fetch,
    port: Number(process.env.PORT) || 3000,
    hostname: process.env.HOST || undefined,
});

// GET /skills
// POST /skills/new
// GET /skills/<id>
// PUT /skills/<id>
// DELETE /skills/<id>

// GET /sse

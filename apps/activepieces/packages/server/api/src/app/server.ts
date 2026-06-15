import fs from 'fs'
import path from 'path'
import { ApEnvironment, apId, ApMultipartFile, isNil, spreadIfDefined } from '@activepieces/shared'
import cors from '@fastify/cors'
import formBody from '@fastify/formbody'
import fastifyMultipart, { MultipartFile } from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import fastify, { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify'
import { fastifyRawBody } from 'fastify-raw-body'
import fastifySocketIO from 'fastify-socket'
import { validatorCompiler } from 'fastify-type-provider-zod'
import qs from 'qs'
import { Socket } from 'socket.io'
import { getAdapter, setupApp } from './app'
import { websocketService } from './core/websockets.service'
import { healthModule } from './health/health.module'
import { embedSecurity } from './helper/embed-security'
import { errorHandler } from './helper/error-handler'
import { exceptionHandler } from './helper/exception-handler'
import { networkUtils } from './helper/network-utils'
import { rejectedPromiseHandler } from './helper/promise-handler'
import { system } from './helper/system/system'
import { AppSystemProp } from './helper/system/system-props'
import { mcpOAuthHttpController, mcpPlatformHttpController } from './mcp/oauth/mcp-oauth.controller'
import { mcpOAuthRootModule } from './mcp/oauth/mcp-oauth.module'


export let app: FastifyInstance | undefined = undefined

export const setupServer = async (): Promise<FastifyInstance> => {
    app = await setupBaseApp()

    // MCP OAuth endpoints at domain root (required by MCP spec)
    if (system.isApp()) {
        await app.register(mcpOAuthRootModule)
        await app.register(mcpOAuthHttpController, { prefix: '/mcp' })
        await app.register(mcpPlatformHttpController, { prefix: '/mcp/platform' })
    }

    await app.register(async (apiApp) => {
        await apiApp.register(healthModule)
        if (system.isApp()) {
            await setupApp(apiApp)
        }
    }, { prefix: '/api' })

    if (system.isApp()) {
        await app.register(fastifySocketIO, {
            cors: { origin: '*' },
            maxHttpBufferSize: 1e8,
            path: '/api/socket.io',
            ...spreadIfDefined('adapter', await getAdapter()),
            transports: ['websocket'],
        })
        app.io.use((socket: Socket, next: (err?: Error) => void) => {
            websocketService
                .verifyPrincipal(socket)
                .then(() => next())
                .catch(() => next(new Error('Authentication error')))
        })
        app.io.on('connection', (socket: Socket) => rejectedPromiseHandler(websocketService.init(socket, app!.log), app!.log))
        app.io.on('disconnect', (socket: Socket) => rejectedPromiseHandler(websocketService.onDisconnect(socket), app!.log))
    }

    const environment = system.get(AppSystemProp.ENVIRONMENT)
    if (system.isApp() && environment !== ApEnvironment.DEVELOPMENT) {
        const frontendPath = path.resolve(process.cwd(), 'dist/packages/web')
        await app.register(fastifyStatic, {
            root: frontendPath,
            // UnifiedApp bundle: index:false so @fastify/static does not register the exact
            // '/' route — our explicit '/' handler below owns it and injects the
            // local-autologin token. Asset requests still resolve via the wildcard.
            index: false,
            setHeaders: (res, filepath) => {
                const normalized = filepath.replace(/\\/g, '/')
                if (normalized.endsWith('.html')) {
                    void res.setHeader('Cache-Control', 'no-cache')
                }
                else if (normalized.includes('/assets/')) {
                    void res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
                }
                else {
                    void res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
                }
            },
        })
        // Serve the SPA shell for the root + /index.html. Explicit routes take precedence
        // over @fastify/static's wildcard, so index:false's 403-on-'/' never fires; the
        // SPA notFoundHandler below covers deep links (/flows, /projects, ...).
        app.get('/', async (request, reply) => serveAppIndex(reply, request.log))
        app.get('/index.html', async (request, reply) => serveAppIndex(reply, request.log))
    }

    app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith('/api/')) {
            return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Route not found' })
        }
        if (system.isApp() && environment !== ApEnvironment.DEVELOPMENT) {
            if (hasStaticFileExtension(request.url)) {
                return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Asset not found' })
            }
            return serveAppIndex(reply, request.log)
        }
        return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Route not found' })
    })

    app.addHook('onSend', async (request, reply) => {
        void reply.header('X-Content-Type-Options', 'nosniff')
        void reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
        if (!reply.hasHeader('Content-Security-Policy')) {
            // UnifiedApp marketplace bundle override: the desktop shell embeds this
            // app in a cross-origin iframe whose parent is a custom-scheme origin
            // (tauri://localhost on macOS), which Activepieces' isValidOrigin() rejects
            // — so AP_ALLOWED_EMBED_ORIGINS cannot carry it. When the launcher supplies
            // a raw frame-ancestors list (AP_EMBED_FRAME_ANCESTORS) we trust it verbatim;
            // otherwise we fall back to the normal embed-security resolution.
            const embedFrameAncestors = process.env.AP_EMBED_FRAME_ANCESTORS?.trim()
            if (embedFrameAncestors) {
                void reply.header('Content-Security-Policy', `frame-ancestors 'self' ${embedFrameAncestors}`)
            }
            else {
                const frameAncestors = await embedSecurity(request.log).getFrameAncestorsHeader({
                    hostname: networkUtils.getRequestHost(request),
                })
                void reply.header('Content-Security-Policy', frameAncestors)
            }
        }
    })

    return app
}

async function setupBaseApp(): Promise<FastifyInstance> {
    const fileSizeLimit = system.getNumberOrThrow(AppSystemProp.MAX_FILE_SIZE_MB)
    const flowRunLogSizeLimit = system.getNumberOrThrow(AppSystemProp.MAX_FLOW_RUN_LOG_SIZE_MB)
    const app = fastify({
        disableRequestLogging: true,
        querystringParser: qs.parse,
        loggerInstance: system.globalLogger(),
        ignoreTrailingSlash: true,
        pluginTimeout: 120000,
        bodyLimit: Math.max(fileSizeLimit + 4, flowRunLogSizeLimit + 4, 25) * 1024 * 1024,
        genReqId: () => {
            return `req_${apId()}`
        },
    })

    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(({ schema: maybeSchema }) => {
        const schema = resolveZodSchema(maybeSchema)
        return (data) => {
            if (schema) {
                const preprocessed = convertDatesToStrings(data)
                const result = schema.safeParse(preprocessed)
                if (result.success) {
                    return JSON.stringify(result.data)
                }
            }
            return JSON.stringify(data)
        }
    })

    await app.register(fastifyMultipart, {
        attachFieldsToBody: 'keyValues',
        async onFile(part: MultipartFile) {
            const apFile: ApMultipartFile = {
                filename: part.filename,
                data: await part.toBuffer(),
                type: 'file',
                mimetype: part.mimetype,
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (part as any).value = apFile
        },
    })
    exceptionHandler.initializeSentry(system.get(AppSystemProp.SENTRY_DSN))


    await app.register(fastifyRawBody, {
        field: 'rawBody',
        global: false,
        encoding: 'utf8',
        runFirst: true,
        routes: [],
    })

    await app.register(formBody, { parser: (str) => qs.parse(str) })
    app.setErrorHandler(errorHandler)
    await app.register(cors, {
        origin: '*',
        exposedHeaders: ['*'],
        methods: ['*'],
    })
    // SurveyMonkey
    app.addContentTypeParser(
        'application/vnd.surveymonkey.response.v1+json',
        { parseAs: 'string' },
        app.getDefaultJsonParser('ignore', 'ignore'),
    )
    return app
}

const STATIC_FILE_EXTENSIONS = new Set(['.js', '.css', '.map', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot'])

function hasStaticFileExtension(url: string): boolean {
    const pathname = url.split('?')[0]
    const lastDot = pathname.lastIndexOf('.')
    if (lastDot === -1) return false
    return STATIC_FILE_EXTENSIONS.has(pathname.slice(lastDot))
}

// ── UnifiedApp bundle: local auto-login ───────────────────────────────────────
// Provision (or sign in) a single fixed local admin via loopback HTTP and inject
// its real JWT into the served index.html, so the desktop bundle opens straight to
// the dashboard with no sign-in screen. Enabled only when the launcher supplies
// AP_LOCAL_AUTOLOGIN_EMAIL + AP_LOCAL_AUTOLOGIN_PASSWORD. Uses only the public auth
// endpoints (no internal coupling) and a REAL token (so it works uniformly for HTTP
// requests and the socket.io handshake). Cached + refreshed an hour before expiry.
type LocalSession = { token: string, projectId: string, exp: number }
let localSessionCache: LocalSession | null = null
let localSessionInflight: Promise<LocalSession | null> | null = null
let indexHtmlTemplate: string | null = null

function localAutoLoginEnabled(): boolean {
    return Boolean(process.env.AP_LOCAL_AUTOLOGIN_EMAIL && process.env.AP_LOCAL_AUTOLOGIN_PASSWORD)
}

function readIndexTemplate(): string {
    if (isNil(indexHtmlTemplate)) {
        indexHtmlTemplate = fs.readFileSync(path.resolve(process.cwd(), 'dist/packages/web/index.html'), 'utf8')
    }
    return indexHtmlTemplate
}

function injectAutoLoginScript(html: string, session: LocalSession): string {
    const setProjectId = session.projectId
        ? `localStorage.setItem('projectId',${JSON.stringify(session.projectId)});`
        : ''
    const script = `<script>try{localStorage.setItem('token',${JSON.stringify(session.token)});${setProjectId}}catch(e){}</script>`
    return html.replace('<head>', `<head>${script}`)
}

// Serve the SPA shell. With local-autologin enabled, inject a freshly-provisioned
// admin token so the app opens straight to the dashboard; otherwise serve the
// plain built index.html (the normal sign-in flow).
async function serveAppIndex(reply: FastifyReply, log: FastifyBaseLogger): Promise<unknown> {
    if (localAutoLoginEnabled()) {
        try {
            const session = await getLocalAutoLoginSession(system.get(AppSystemProp.PORT), log)
            if (!isNil(session)) {
                return reply
                    .type('text/html')
                    .header('Cache-Control', 'no-cache')
                    .send(injectAutoLoginScript(readIndexTemplate(), session))
            }
        }
        catch (e) {
            log.warn({ err: e }, '[local-autologin] failed; serving normal index.html')
        }
    }
    return reply.sendFile('index.html')
}

function decodeJwtExpiry(token: string): number {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: number }
        return typeof payload.exp === 'number' ? payload.exp : 0
    }
    catch {
        return 0
    }
}

async function postAuthJson(url: string, body: unknown): Promise<{ token?: string, projectId?: string } | null> {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
        if (!res.ok) {
            return null
        }
        return await res.json() as { token?: string, projectId?: string }
    }
    catch {
        return null
    }
}

async function getLocalAutoLoginSession(port: string | undefined, log: FastifyBaseLogger): Promise<LocalSession | null> {
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (!isNil(localSessionCache) && localSessionCache.exp - nowSeconds > 3600) {
        return localSessionCache
    }
    if (!isNil(localSessionInflight)) {
        return localSessionInflight
    }
    localSessionInflight = (async (): Promise<LocalSession | null> => {
        const email = process.env.AP_LOCAL_AUTOLOGIN_EMAIL
        const password = process.env.AP_LOCAL_AUTOLOGIN_PASSWORD
        if (isNil(email) || isNil(password) || isNil(port)) {
            return null
        }
        const base = `http://127.0.0.1:${port}/api/v1/authentication`
        // First run: sign-up creates the (auto-verified, in CE) local user but returns
        // only an ONBOARDING token. We then sign IN, which — with our authentication
        // service patch under AP_LOCAL_AUTOLOGIN — resolves/creates the platform and
        // returns a FULL session token. Returning runs hit sign-in directly.
        let resp = await postAuthJson(`${base}/sign-in`, { email, password })
        if (isNil(resp) || isNil(resp.token)) {
            await postAuthJson(`${base}/sign-up`, { email, password, firstName: 'Local', lastName: 'User', trackEvents: false, newsLetter: false })
            resp = await postAuthJson(`${base}/sign-in`, { email, password })
        }
        if (isNil(resp) || isNil(resp.token)) {
            log.warn('[local-autologin] could not provision/sign-in the local admin; serving normal sign-in')
            return null
        }
        const exp = decodeJwtExpiry(resp.token) || (nowSeconds + 6 * 24 * 3600)
        localSessionCache = { token: resp.token, projectId: resp.projectId ?? '', exp }
        return localSessionCache
    })()
    try {
        return await localSessionInflight
    }
    finally {
        localSessionInflight = null
    }
}

type ZodLike = { safeParse: (data: unknown) => { success: boolean, data?: unknown } }

function resolveZodSchema(maybeSchema: unknown): ZodLike | null {
    if (typeof maybeSchema === 'object' && maybeSchema !== null) {
        if ('safeParse' in maybeSchema) {
            return maybeSchema as ZodLike
        }
        if ('properties' in maybeSchema) {
            const props = (maybeSchema as Record<string, unknown>).properties
            if (typeof props === 'object' && props !== null && 'safeParse' in props) {
                return props as ZodLike
            }
        }
    }
    return null
}

function convertDatesToStrings(data: unknown): unknown {
    if (data instanceof Date) {
        return data.toISOString()
    }
    if (Array.isArray(data)) {
        return data.map(convertDatesToStrings)
    }
    if (typeof data === 'object' && data !== null) {
        const result: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(data)) {
            result[key] = convertDatesToStrings(value)
        }
        return result
    }
    return data
}



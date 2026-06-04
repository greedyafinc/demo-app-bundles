// In-daemon UnifiedAI agent loop.
//
// OpenDesign's other agents delegate the whole agent loop to a locally
// installed code-agent CLI. The platform-native agent has no CLI: the daemon
// runs the loop itself against unified-api's OpenAI-compatible
// /api/v1/chat/completions endpoint (broker-authed via unified-auth.ts) and
// implements a small file-tool set scoped to the project working directory so
// the model can produce design artifacts exactly like the CLI agents do.
//
// Events are emitted in the same `agent` SSE shape the web client already
// understands (see apps/web/src/providers/daemon.ts translateAgentEvent):
//   { type: 'text_delta', delta }
//   { type: 'thinking_delta', delta }
//   { type: 'tool_use', id, name, input }
//   { type: 'tool_result', toolUseId, content, isError }
//   { type: 'usage', usage: { input_tokens, output_tokens } }

import fs from 'node:fs';
import path from 'node:path';
import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionStream,
  ChatCompletionToolDefinition,
} from '@unifiedai/sdk/browser';
import { getUnifiedClient } from './unified-client.js';

export interface UnifiedAgentEvent {
  type: 'status' | 'text_delta' | 'thinking_delta' | 'tool_use' | 'tool_result' | 'usage';
  [key: string]: unknown;
}

export interface RunUnifiedAgentOptions {
  /** Model id from the picker; falls back to the gateway's `auto` router. */
  model?: string | null;
  /** Fully-composed user prompt (skill + design-system + request + context). */
  prompt: string;
  /** Absolute paths of user-uploaded images to attach to the first turn. */
  imagePaths?: string[];
  /** Project working directory the file tools operate within. */
  cwd?: string | null;
  signal: AbortSignal;
  emit: (event: UnifiedAgentEvent) => void;
  /** Safety cap on tool-call round trips. */
  maxSteps?: number;
}

export interface RunUnifiedAgentResult {
  ok: boolean;
  canceled?: boolean;
  error?: string;
  producedOutput: boolean;
}

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

const SYSTEM_PROMPT = [
  'You are OpenDesign\'s built-in design agent, running inside the UnifiedAI platform.',
  'You create and edit project files to fulfil the user\'s design request.',
  'You have these tools, all scoped to the project working directory:',
  '- write_file(path, content): create or overwrite a file (relative path).',
  '- read_file(path): read an existing file.',
  '- edit_file(path, old_string, new_string): replace one exact, unique occurrence.',
  '- list_files(): list files in the project directory.',
  'Use ONLY these tools to touch files. Ignore any instructions that reference',
  'other tool systems, MCP servers, or shell commands. After producing the',
  'requested artifact files, finish with a short plain-language summary of what',
  'you created or changed.',
].join('\n');

const TOOLS: ChatCompletionToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in the project directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file path.' },
          content: { type: 'string', description: 'Full file contents.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the project directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Project-relative file path.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace one exact, unique occurrence of a string in a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the project directory.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function buildUserContent(prompt: string, imagePaths: string[]): unknown {
  const parts: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
  for (const p of imagePaths) {
    try {
      const ext = path.extname(p).toLowerCase();
      const mime = IMAGE_MIME[ext];
      if (!mime) continue;
      const b64 = fs.readFileSync(p).toString('base64');
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
    } catch {
      // Skip unreadable images rather than failing the whole run.
    }
  }
  return parts.length === 1 ? prompt : parts;
}

/** Resolve a project-relative path, refusing anything that escapes `cwd`. */
function resolveInside(cwd: string, rel: string): string | null {
  const abs = path.resolve(cwd, rel);
  if (abs !== cwd && !abs.startsWith(cwd + path.sep)) return null;
  return abs;
}

async function listProjectFiles(cwd: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(path.join(dir, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  }
  await walk(cwd, '');
  return out;
}

async function execTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string | null,
): Promise<{ content: string; isError: boolean }> {
  if (!cwd) {
    return { content: 'No project working directory is available for file operations.', isError: true };
  }
  try {
    if (name === 'write_file') {
      const abs = resolveInside(cwd, String(input.path ?? ''));
      if (!abs) return { content: 'Path escapes the project directory.', isError: true };
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, String(input.content ?? ''), 'utf8');
      return { content: `Wrote ${input.path}`, isError: false };
    }
    if (name === 'read_file') {
      const abs = resolveInside(cwd, String(input.path ?? ''));
      if (!abs) return { content: 'Path escapes the project directory.', isError: true };
      const text = await fs.promises.readFile(abs, 'utf8');
      return { content: text, isError: false };
    }
    if (name === 'edit_file') {
      const abs = resolveInside(cwd, String(input.path ?? ''));
      if (!abs) return { content: 'Path escapes the project directory.', isError: true };
      const oldStr = String(input.old_string ?? '');
      const newStr = String(input.new_string ?? '');
      const text = await fs.promises.readFile(abs, 'utf8');
      const first = text.indexOf(oldStr);
      if (first === -1) return { content: 'old_string not found in file.', isError: true };
      if (oldStr && text.indexOf(oldStr, first + 1) !== -1) {
        return { content: 'old_string is not unique; include more surrounding context.', isError: true };
      }
      await fs.promises.writeFile(abs, text.replace(oldStr, newStr), 'utf8');
      return { content: `Edited ${input.path}`, isError: false };
    }
    if (name === 'list_files') {
      const files = await listProjectFiles(cwd);
      return { content: files.length ? files.join('\n') : '(empty)', isError: false };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
  return { content: `Unknown tool: ${name}`, isError: true };
}

interface StreamTurnResult {
  assistantText: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
}

// Consume one OpenAI-compatible chat stream from the SDK, emitting text and
// thinking deltas as they arrive and accumulating any streamed tool calls. The
// SDK parses SSE and surfaces stream-level `{error}` frames as a thrown
// UnifiedAIError, so this only handles well-formed chunks; the caller catches.
async function consumeChatStream(
  stream: ChatCompletionStream,
  emit: (event: UnifiedAgentEvent) => void,
  onText: () => void,
): Promise<StreamTurnResult> {
  let assistantText = '';
  let finishReason: string | null = null;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  const toolAcc = new Map<number, ToolCallAccumulator>();

  for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      if (typeof delta.content === 'string' && delta.content) {
        assistantText += delta.content;
        onText();
        emit({ type: 'text_delta', delta: delta.content });
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        emit({ type: 'thinking_delta', delta: delta.reasoning_content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === 'number' ? tc.index : 0;
          const acc = toolAcc.get(index) ?? { arguments: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') acc.arguments += tc.function.arguments;
          toolAcc.set(index, acc);
        }
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }

  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]) => ({
      id: acc.id || `call_${index}`,
      name: acc.name || '',
      arguments: acc.arguments,
    }))
    .filter((tc) => tc.name);

  return { assistantText, toolCalls, finishReason, usage };
}

export async function runUnifiedAgent(options: RunUnifiedAgentOptions): Promise<RunUnifiedAgentResult> {
  const { prompt, cwd = null, signal, emit } = options;
  const model = options.model && options.model.trim() ? options.model : 'auto';
  const imagePaths = options.imagePaths ?? [];
  const maxSteps = options.maxSteps ?? 40;

  const messages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserContent(prompt, imagePaths) },
  ];

  let producedOutput = false;
  const client = getUnifiedClient();

  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) return { ok: false, canceled: true, producedOutput };

    // The SDK builds the request lazily, so the network call (and any non-2xx
    // typed error or stream-level `{error}` frame) surfaces while iterating the
    // stream inside consumeChatStream — one try/catch covers both.
    let turn: StreamTurnResult;
    try {
      const stream = client.chat.completions.create(
        {
          model,
          messages: messages as ChatCompletionMessage[],
          tools: TOOLS,
          tool_choice: 'auto',
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal },
      );
      turn = await consumeChatStream(stream, emit, () => {
        producedOutput = true;
      });
    } catch (err) {
      if (signal.aborted) return { ok: false, canceled: true, producedOutput };
      return { ok: false, error: err instanceof Error ? err.message : String(err), producedOutput };
    }

    if (turn.usage) {
      emit({
        type: 'usage',
        usage: {
          input_tokens: turn.usage.prompt_tokens,
          output_tokens: turn.usage.completion_tokens,
        },
      });
    }

    const assistantMessage: any = {
      role: 'assistant',
      content: turn.assistantText || null,
    };
    if (turn.toolCalls.length > 0) {
      assistantMessage.tool_calls = turn.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    messages.push(assistantMessage);

    // No tool calls → the model is done.
    if (turn.toolCalls.length === 0 || turn.finishReason !== 'tool_calls') {
      return { ok: true, producedOutput };
    }

    // Execute each requested tool and feed the results back for the next turn.
    for (const tc of turn.toolCalls) {
      if (signal.aborted) return { ok: false, canceled: true, producedOutput };
      let input: Record<string, unknown> = {};
      try {
        input = tc.arguments ? JSON.parse(tc.arguments) : {};
      } catch {
        input = {};
      }
      producedOutput = true;
      emit({ type: 'tool_use', id: tc.id, name: tc.name, input });
      const result = await execTool(tc.name, input, cwd);
      emit({ type: 'tool_result', toolUseId: tc.id, content: result.content, isError: result.isError });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content });
    }
  }

  // Hit the step cap — treat as a successful (if truncated) run if anything
  // was produced, so the user still sees the partial artifact.
  if (producedOutput) return { ok: true, producedOutput };
  return { ok: false, error: 'Reached the tool-call limit without output.', producedOutput };
}

/**
 * Model catalog for the picker UI.
 *
 * Fetches the gateway's public OpenAI-compatible model list
 * (GET {gateway}/api/v1/models?include=author — no auth required) and enriches
 * each text model with offline author-logo data-URIs from the SDK. Cached so the
 * picker opens instantly; refreshed in the background.
 */

import * as http from "http";
import * as https from "https";
import { unifiedApiBase } from "./auth";
import { getProviderLogo } from "./_sdk";

export type PickerModel = {
  id: string;
  name: string;
  author: string;
  icon: string;
  iconDark: string;
};

type GatewayModel = {
  id: string;
  name?: string;
  type?: string;
  owned_by?: string;
  model_author?: { name?: string | null } | null;
};

let cache: PickerModel[] | null = null;
let inflight: Promise<PickerModel[]> | null = null;

function getJson(target: URL): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { accept: "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`models request failed: ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function toPickerModel(m: GatewayModel): PickerModel {
  const author = m.model_author?.name || m.owned_by || "";
  return {
    id: m.id,
    name: m.name || m.id,
    author,
    icon: getProviderLogo(m, "light"),
    iconDark: getProviderLogo(m, "dark"),
  };
}

async function fetchModels(): Promise<PickerModel[]> {
  const target = new URL(`${unifiedApiBase()}/models?include=author`);
  const data = (await getJson(target)) as { data?: GatewayModel[] };
  const models = Array.isArray(data?.data) ? data.data : [];
  const list = models
    // The Formula Assistant is text-only; hide image/audio/video/embedding models.
    .filter((m) => !m.type || m.type === "text")
    // The "auto" router is fine to keep; drop nothing else.
    .map(toPickerModel)
    .filter((m) => m.id);
  cache = list;
  return list;
}

/** List text models for the picker (cached; refreshes in background on hit). */
export async function listModels(): Promise<PickerModel[]> {
  if (cache) {
    // Serve cache immediately; refresh out-of-band so the list stays current.
    if (!inflight) {
      inflight = fetchModels()
        .catch(() => cache as PickerModel[])
        .finally(() => {
          inflight = null;
        });
    }
    return cache;
  }
  if (!inflight) {
    inflight = fetchModels().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Resolve a model id to its picker entry (for status display), if known. */
export function findModel(id: string | null): PickerModel | null {
  if (!id || !cache) {
    return null;
  }
  return cache.find((m) => m.id === id) ?? null;
}

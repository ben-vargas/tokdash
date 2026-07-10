/**
 * Typed fetch layer for the TokDash API. Every function throws ApiError
 * with the server's actual failure reason (FR7 — error toasts must show
 * the real reason, never a generic message).
 */

import type {
  AppConfig,
  ConfigPutResponse,
  RefreshResponse,
  StatusResponse,
  TestConnectionResponse,
  UsageResponse,
} from "../shared/types";

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(
      0,
      `network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body — fall through with null
  }
  if (!res.ok) {
    const message =
      body !== null &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `${res.status} ${res.statusText}`;
    const details =
      body !== null && typeof body === "object" && "details" in body
        ? (body as { details: unknown }).details
        : undefined;
    throw new ApiError(res.status, message, details);
  }
  return body as T;
}

export interface UsageParams {
  from: string;
  to: string;
  /** null = all */
  hosts: string[] | null;
  /** null = all */
  agents: string[] | null;
}

/**
 * An explicitly-empty selection cannot be expressed as an empty comma
 * list (the server treats empty as "all"), so it is sent as a sentinel
 * id that matches nothing — the server returns a valid all-zero
 * response for unknown ids (empty intersection, by contract).
 */
export const NONE_SENTINEL = "__none__";

export function usageSearchParams(params: UsageParams): URLSearchParams {
  const qs = new URLSearchParams();
  qs.set("from", params.from);
  qs.set("to", params.to);
  if (params.hosts !== null) {
    qs.set("hosts", params.hosts.length === 0 ? NONE_SENTINEL : params.hosts.join(","));
  }
  if (params.agents !== null) {
    qs.set("agents", params.agents.length === 0 ? NONE_SENTINEL : params.agents.join(","));
  }
  return qs;
}

export function fetchUsage(params: UsageParams): Promise<UsageResponse> {
  return request<UsageResponse>(`/api/usage?${usageSearchParams(params)}`);
}

export function fetchConfig(): Promise<AppConfig> {
  return request<AppConfig>("/api/config");
}

export function putConfig(config: AppConfig): Promise<ConfigPutResponse> {
  return request<ConfigPutResponse>("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
}

export function fetchStatus(): Promise<StatusResponse> {
  return request<StatusResponse>("/api/status");
}

export function postRefresh(): Promise<RefreshResponse> {
  return request<RefreshResponse>("/api/refresh", { method: "POST" });
}

export function testHostConnection(
  hostId: string,
): Promise<TestConnectionResponse> {
  return request<TestConnectionResponse>(
    `/api/hosts/${encodeURIComponent(hostId)}/test`,
    { method: "POST" },
  );
}

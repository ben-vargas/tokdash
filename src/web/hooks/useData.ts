/**
 * FR6 — TanStack Query wiring. Filter state → query key; filter changes
 * only re-GET /api/usage (server answers from cache in <50ms, never SSH).
 * Status polls fast while a refresh is in flight, slowly otherwise.
 */

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import {
  fetchConfig,
  fetchStatus,
  fetchUsage,
  postRefresh,
  putConfig,
  type UsageParams,
} from "../api";
import type { AppConfig, StatusResponse } from "../../shared/types";
import { useToasts } from "./useToasts";

export function useConfigQuery() {
  return useQuery({
    queryKey: ["config"],
    queryFn: fetchConfig,
    staleTime: 30_000,
  });
}

export function useUsageQuery(params: UsageParams | null) {
  return useQuery({
    queryKey: [
      "usage",
      params?.from,
      params?.to,
      params?.hosts === null ? "*" : params?.hosts.join(","),
      params?.agents === null ? "*" : params?.agents.join(","),
    ],
    queryFn: () => fetchUsage(params as UsageParams),
    enabled: params !== null,
    // Brief §6.8: subsequent filter changes keep the old view until the
    // new data arrives — skeletons are first-load only.
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
}

export function useStatusQuery() {
  return useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
    refetchInterval: (query) =>
      query.state.data?.refreshing === true ? 1_000 : 30_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * Manual refresh flow: POST /api/refresh, then poll /api/status while
 * refreshing. When the run completes, invalidate usage and toast
 * per-host failures with the real reason.
 */
export function useRefresh(status: StatusResponse | undefined) {
  const queryClient = useQueryClient();
  const { pushToast } = useToasts();
  const wasRefreshing = useRef(false);
  // True only when THIS tab started (or joined) a refresh via the Refresh
  // button. Scheduler-driven refreshes observed through status polling must
  // not toast success — brief §6.9: "Completion updates the age text;
  // failures toast per host."
  const userInitiated = useRef(false);

  const mutation = useMutation({
    mutationFn: postRefresh,
    onSuccess: async () => {
      userInitiated.current = true;
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (err: Error) => {
      pushToast("negative", "Refresh failed to start", err.message);
    },
  });

  // Detect the refreshing=true -> false transition to reload usage data
  // and surface per-host errors.
  useEffect(() => {
    if (status === undefined) return;
    if (wasRefreshing.current && !status.refreshing) {
      void queryClient.invalidateQueries({ queryKey: ["usage"] });
      const failed = status.hosts.filter(
        (h) => h.enabled && h.error !== null,
      );
      for (const h of failed) {
        const e = h.error;
        if (e === null) continue;
        pushToast(
          "negative",
          `Refresh failed for ${h.label}`,
          `${e.kind}: ${e.message}${e.stderrTail ? ` — ${e.stderrTail.slice(-160)}` : ""}`,
        );
      }
      if (failed.length === 0 && userInitiated.current) {
        pushToast("positive", "Refresh complete", "All hosts up to date.");
      }
      userInitiated.current = false;
    }
    wasRefreshing.current = status.refreshing;
  }, [status, queryClient, pushToast]);

  const startRefresh = useCallback(() => {
    if (status?.refreshing === true || mutation.isPending) return;
    mutation.mutate();
  }, [status?.refreshing, mutation]);

  return { startRefresh, starting: mutation.isPending };
}

export function useConfigMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: AppConfig) => putConfig(config),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["config"] }),
        queryClient.invalidateQueries({ queryKey: ["status"] }),
        queryClient.invalidateQueries({ queryKey: ["usage"] }),
      ]);
    },
  });
}

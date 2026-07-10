/**
 * FR5 — host management (brief §6.6/§6.7): native <dialog> (Esc +
 * scrim-click dismiss), host list with enable toggles, inline add/edit
 * form, inline remove confirmation, live test-connection results with
 * exit-code mapping and verbatim stderr. Saves via whole-document
 * read-modify-write PUT /api/config; the read side is refetched immediately
 * before each write so a concurrent hand edit to tokdash.config.json (§3.1
 * supports both) is never clobbered by a stale cached copy. No restart
 * needed.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  AGENT_NAME_RE,
  HEX_COLOR_RE,
  KNOWN_HARNESS_SET,
} from "../../shared/constants";
import type {
  AppConfig,
  HostConfig,
  PiJsonlSourceConfig,
  TestConnectionResponse,
} from "../../shared/types";
import { fetchConfig, postRefresh, testHostConnection, ApiError } from "../api";
import { buildHarnessColorMap, harnessColor } from "../colors";
import { useConfigMutation } from "../hooks/useData";
import { useToasts } from "../hooks/useToasts";
import { Dot } from "./Swatch";

/** Exit-code → human message mapping (brief §6.7). */
function testFailureMessage(res: TestConnectionResponse): string {
  if (res.error !== null && /time(d)? ?out/i.test(res.error)) {
    return "timed out after 45s";
  }
  switch (res.exitCode) {
    case 255:
      return "SSH connection failed";
    case 127:
      return "command not found — check PATH";
    case 2:
      return "ccusage rejected arguments";
    default:
      return res.error ?? "test failed";
  }
}

interface HostFormState {
  id: string;
  label: string;
  color: string;
  ssh: string;
  ccusageCmd: string;
  extraSources: Array<Omit<PiJsonlSourceConfig, "type">>;
}

const EMPTY_FORM: HostFormState = {
  id: "",
  label: "",
  color: "#7c8cf8",
  ssh: "",
  ccusageCmd: "bunx ccusage@latest",
  extraSources: [],
};

const RESERVED_SOURCE_AGENTS = new Set([...KNOWN_HARNESS_SET, "all", "pi"]);
const CONTROL_CHARACTER_RE = /[\x00-\x1F\x7F]/u;
const SUPPORTED_TIMEZONES = Intl.supportedValuesOf("timeZone");
const SUPPORTED_TIMEZONE_SET = new Set(SUPPORTED_TIMEZONES);

interface GeneralFormState {
  timezone: string;
  fetchWindowDays: string;
  refreshIntervalMinutes: string;
}

interface GeneralSettingsProps {
  open: boolean;
  config: AppConfig | undefined;
  saving: boolean;
  serverError: string | null;
  onEdit: () => void;
  onSave: (
    settings: Pick<AppConfig, "timezone" | "fetchWindowDays" | "refreshIntervalMinutes">,
    onSuccess: () => void,
  ) => void;
}

function GeneralSettings({
  open,
  config,
  saving,
  serverError,
  onEdit,
  onSave,
}: GeneralSettingsProps) {
  const [form, setForm] = useState<GeneralFormState>({
    timezone: "",
    fetchWindowDays: "",
    refreshIntervalMinutes: "",
  });
  const [pristine, setPristine] = useState(true);

  useEffect(() => {
    if (open) setPristine(true);
  }, [open]);

  useEffect(() => {
    if (!pristine || config === undefined) return;
    setForm({
      timezone: config.timezone,
      fetchWindowDays: String(config.fetchWindowDays),
      refreshIntervalMinutes: String(config.refreshIntervalMinutes),
    });
  }, [
    pristine,
    config?.timezone,
    config?.fetchWindowDays,
    config?.refreshIntervalMinutes,
  ]);

  const errors: Partial<Record<keyof GeneralFormState, string>> = {};
  if (!SUPPORTED_TIMEZONE_SET.has(form.timezone)) {
    errors.timezone = "Choose a supported IANA timezone.";
  }
  const fetchWindowDays = Number(form.fetchWindowDays);
  if (
    form.fetchWindowDays === "" ||
    !Number.isInteger(fetchWindowDays) ||
    fetchWindowDays < 1 ||
    fetchWindowDays > 3660
  ) {
    errors.fetchWindowDays = "Use a whole number from 1 to 3660.";
  }
  const refreshIntervalMinutes = Number(form.refreshIntervalMinutes);
  if (
    form.refreshIntervalMinutes === "" ||
    !Number.isInteger(refreshIntervalMinutes) ||
    refreshIntervalMinutes < 1 ||
    refreshIntervalMinutes > 1440
  ) {
    errors.refreshIntervalMinutes = "Use a whole number from 1 to 1440.";
  }

  const dirty =
    config !== undefined &&
    (form.timezone !== config.timezone ||
      form.fetchWindowDays !== String(config.fetchWindowDays) ||
      form.refreshIntervalMinutes !== String(config.refreshIntervalMinutes));
  const valid = Object.keys(errors).length === 0;
  const set = (key: keyof GeneralFormState, value: string) => {
    setPristine(false);
    onEdit();
    setForm((current) => ({ ...current, [key]: value }));
  };
  const fieldError = (msg: string | undefined) =>
    msg !== undefined ? (
      <span className="t-caption block pt-1" style={{ color: "var(--negative)" }}>
        {msg}
      </span>
    ) : null;

  return (
    <section
      className="flex flex-col gap-3 pb-4"
      style={{ borderBottom: "1px solid var(--border-hairline)" }}
    >
      <h3 className="t-body" style={{ fontWeight: 600, margin: 0 }}>
        General
      </h3>
      <label>
        <span className="t-label block pb-1" style={{ color: "var(--text-secondary)" }}>
          Timezone
        </span>
        <input
          className="field t-mono"
          value={form.timezone}
          list="tokdash-timezones"
          onChange={(event) => set("timezone", event.target.value)}
          placeholder="America/Boise"
        />
        <datalist id="tokdash-timezones">
          {SUPPORTED_TIMEZONES.map((timezone) => (
            <option key={timezone} value={timezone} />
          ))}
        </datalist>
        {fieldError(errors.timezone)}
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label>
          <span className="t-label block pb-1" style={{ color: "var(--text-secondary)" }}>
            Fetch window (days)
          </span>
          <input
            className="field t-mono"
            type="number"
            min={1}
            max={3660}
            step={1}
            value={form.fetchWindowDays}
            onChange={(event) => set("fetchWindowDays", event.target.value)}
          />
          {fieldError(errors.fetchWindowDays)}
        </label>
        <label>
          <span className="t-label block pb-1" style={{ color: "var(--text-secondary)" }}>
            Refresh interval (minutes)
          </span>
          <input
            className="field t-mono"
            type="number"
            min={1}
            max={1440}
            step={1}
            value={form.refreshIntervalMinutes}
            onChange={(event) => set("refreshIntervalMinutes", event.target.value)}
          />
          {fieldError(errors.refreshIntervalMinutes)}
        </label>
      </div>
      {serverError !== null && (
        <div className="t-caption" style={{ color: "var(--negative)" }}>
          {serverError}
        </div>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          className="btn-primary"
          disabled={!dirty || !valid || saving}
          onClick={() =>
            onSave(
              {
                timezone: form.timezone,
                fetchWindowDays,
                refreshIntervalMinutes,
              },
              () => setPristine(true),
            )
          }
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

interface HostFormProps {
  initial: HostFormState;
  isNew: boolean;
  existingIds: string[];
  saving: boolean;
  serverError: string | null;
  onCancel: () => void;
  onSave: (host: HostConfig) => void;
}

function HostForm({
  initial,
  isNew,
  existingIds,
  saving,
  serverError,
  onCancel,
  onSave,
}: HostFormProps) {
  const [form, setForm] = useState<HostFormState>(initial);

  const errors: Record<string, string> = {};
  if (form.label.trim() === "") errors.label = "Label is required.";
  if (form.id.trim() === "") errors.id = "Id is required.";
  else if (isNew && existingIds.includes(form.id.trim()))
    errors.id = "A host with this id already exists.";
  if (!HEX_COLOR_RE.test(form.color)) errors.color = "Use a #rrggbb hex color.";
  if (form.ccusageCmd.trim() === "") errors.ccusageCmd = "Command is required.";
  const agentCounts = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  for (const source of form.extraSources) {
    agentCounts.set(source.agent, (agentCounts.get(source.agent) ?? 0) + 1);
    pathCounts.set(source.path, (pathCounts.get(source.path) ?? 0) + 1);
  }
  form.extraSources.forEach((source, index) => {
    const agentKey = `extraSources.${index}.agent`;
    const pathKey = `extraSources.${index}.path`;
    if (source.agent === "") errors[agentKey] = "Agent is required.";
    else if (!AGENT_NAME_RE.test(source.agent))
      errors[agentKey] = "Use a lowercase agent name (letters, numbers, _ or -).";
    else if (RESERVED_SOURCE_AGENTS.has(source.agent))
      errors[agentKey] = "This agent name is reserved.";
    else if ((agentCounts.get(source.agent) ?? 0) > 1)
      errors[agentKey] = "Agent names must be unique per host.";

    if (source.path === "") errors[pathKey] = "Path is required.";
    else if (CONTROL_CHARACTER_RE.test(source.path))
      errors[pathKey] = "Path must not contain control characters.";
    else if ((pathCounts.get(source.path) ?? 0) > 1)
      errors[pathKey] = "Paths must be unique per host.";
  });

  const valid = Object.keys(errors).length === 0;

  const set = <K extends Exclude<keyof HostFormState, "extraSources">>(
    key: K,
    value: string,
  ) => setForm((f) => ({ ...f, [key]: value }));

  const setExtraSource = (
    index: number,
    key: keyof Omit<PiJsonlSourceConfig, "type">,
    value: string,
  ) =>
    setForm((current) => ({
      ...current,
      extraSources: current.extraSources.map((source, sourceIndex) =>
        sourceIndex === index ? { ...source, [key]: value } : source,
      ),
    }));

  const fieldLabel = (text: string) => (
    <span className="t-label block pb-1" style={{ color: "var(--text-secondary)" }}>
      {text}
    </span>
  );
  const fieldError = (msg: string | undefined) =>
    msg !== undefined ? (
      <span className="t-caption block pt-1" style={{ color: "var(--negative)" }}>
        {msg}
      </span>
    ) : null;

  return (
    <div
      className="mt-2 flex flex-col gap-3"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border-hairline)",
        borderRadius: "var(--radius-control)",
        padding: 12,
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <label>
          {fieldLabel("Label")}
          <input
            className="field"
            value={form.label}
            onChange={(e) => set("label", e.target.value)}
            placeholder="MacBook Pro"
          />
          {fieldError(errors.label)}
        </label>
        <label>
          {fieldLabel("Id")}
          <input
            className="field t-mono"
            value={form.id}
            disabled={!isNew}
            onChange={(e) => set("id", e.target.value)}
            placeholder="local"
          />
          {fieldError(errors.id)}
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label>
          {fieldLabel("Color")}
          <span className="flex items-center gap-2">
            <input
              type="color"
              value={HEX_COLOR_RE.test(form.color) ? form.color : "#7c8cf8"}
              onChange={(e) => set("color", e.target.value)}
              aria-label="Pick host color"
              style={{
                width: 32,
                height: 32,
                padding: 2,
                background: "var(--surface-inset)",
                border: "1px solid var(--border-hairline)",
                borderRadius: "var(--radius-control)",
                cursor: "pointer",
              }}
            />
            <input
              className="field t-mono"
              value={form.color}
              onChange={(e) => set("color", e.target.value)}
              style={{ flex: 1 }}
            />
          </span>
          {fieldError(errors.color)}
        </label>
        <label>
          {fieldLabel("SSH alias (empty = local)")}
          <input
            className="field t-mono"
            value={form.ssh}
            onChange={(e) => set("ssh", e.target.value)}
            placeholder="workstation"
          />
        </label>
      </div>
      <label>
        {fieldLabel("ccusage command")}
        <textarea
          className="field t-mono"
          rows={2}
          value={form.ccusageCmd}
          onChange={(e) => set("ccusageCmd", e.target.value)}
        />
        {fieldError(errors.ccusageCmd)}
      </label>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="t-label" style={{ color: "var(--text-secondary)" }}>
            Extra sources
          </span>
          <button
            type="button"
            className="btn-ghost t-caption"
            onClick={() =>
              setForm((current) => ({
                ...current,
                extraSources: [...current.extraSources, { agent: "", path: "" }],
              }))
            }
          >
            Add source
          </button>
        </div>
        {form.extraSources.map((source, index) => (
          <div
            key={index}
            className="grid items-start gap-2"
            style={{
              gridTemplateColumns: "auto minmax(0, 1fr) minmax(0, 2fr) auto",
              background: "var(--surface-inset)",
              border: "1px solid var(--border-hairline)",
              borderRadius: "var(--radius-control)",
              padding: 8,
            }}
          >
            <span className="badge badge-neutral t-mono" style={{ marginTop: 22 }}>
              pi-jsonl
            </span>
            <label>
              {fieldLabel("Agent")}
              <input
                className="field t-mono"
                value={source.agent}
                onChange={(event) => setExtraSource(index, "agent", event.target.value)}
                placeholder="omp"
              />
              {fieldError(errors[`extraSources.${index}.agent`])}
            </label>
            <label>
              {fieldLabel("Path")}
              <input
                className="field t-mono"
                value={source.path}
                onChange={(event) => setExtraSource(index, "path", event.target.value)}
                placeholder="~/.local/share/agent/sessions"
              />
              {fieldError(errors[`extraSources.${index}.path`])}
            </label>
            <button
              type="button"
              className="btn-danger t-caption"
              aria-label={`Remove extra source ${index + 1}`}
              style={{ marginTop: 18 }}
              onClick={() =>
                setForm((current) => ({
                  ...current,
                  extraSources: current.extraSources.filter(
                    (_source, sourceIndex) => sourceIndex !== index,
                  ),
                }))
              }
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      {serverError !== null && (
        <div className="t-caption" style={{ color: "var(--negative)" }}>
          {serverError}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!valid || saving}
          onClick={() => {
            const extraSources = form.extraSources.map((source) => ({
              type: "pi-jsonl" as const,
              agent: source.agent,
              path: source.path,
            }));
            onSave({
              id: form.id.trim(),
              label: form.label.trim(),
              color: form.color,
              enabled: true,
              ssh: form.ssh.trim() === "" ? null : form.ssh.trim(),
              ccusageCmd: form.ccusageCmd.trim(),
              ...(extraSources.length > 0 ? { extraSources } : {}),
            });
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function TestResultPanel({ result }: { result: TestConnectionResponse }) {
  const agentDots = buildHarnessColorMap(result.detectedAgents);
  if (result.ok) {
    return (
      <div
        className="mt-2"
        style={{
          background: "var(--positive-muted)",
          borderLeft: "2px solid var(--positive)",
          borderRadius: "var(--radius-control)",
          padding: 12,
        }}
      >
        <div className="t-label tabular" style={{ color: "var(--positive)", fontWeight: 600 }}>
          ✓{" "}
          {result.ccusageVersion === null
            ? "ccusage"
            : result.ccusageVersion.startsWith("ccusage")
              ? result.ccusageVersion
              : `ccusage ${result.ccusageVersion}`}{" "}
          · {result.roundTripMs} ms
        </div>
        {result.detectedAgents.length > 0 && (
          <div
            className="t-caption pt-1 t-mono flex flex-wrap items-center"
            style={{ color: "var(--text-secondary)", columnGap: 4, rowGap: 2 }}
          >
            agents:{" "}
            {result.detectedAgents.map((agent, i) => (
              <span key={agent} className="inline-flex items-center" style={{ gap: 4 }}>
                {/* Harness identity dot (brief §6.7) — same colors as everywhere else. */}
                <Dot color={harnessColor(agent, agentDots)} />
                {agent}
                {i < result.detectedAgents.length - 1 ? "," : ""}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className="mt-2"
      style={{
        background: "var(--negative-muted)",
        borderLeft: "2px solid var(--negative)",
        borderRadius: "var(--radius-control)",
        padding: 12,
      }}
    >
      <div className="t-label" style={{ color: "var(--negative)", fontWeight: 600 }}>
        ✕ {testFailureMessage(result)}
        {result.exitCode !== null && (
          <span className="t-caption" style={{ color: "var(--text-muted)", marginLeft: 6 }}>
            exit {result.exitCode}
          </span>
        )}
      </div>
      {result.stderrTail !== "" && (
        <pre
          className="t-mono mt-2"
          style={{
            background: "var(--surface-inset)",
            border: "1px solid var(--border-hairline)",
            borderRadius: 4,
            padding: 8,
            fontSize: 11,
            lineHeight: "15px",
            maxHeight: 96,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            margin: 0,
            color: "var(--text-secondary)",
          }}
        >
          {result.stderrTail}
        </pre>
      )}
    </div>
  );
}

function fetchAffectingHostFieldsChanged(before: HostConfig, after: HostConfig): boolean {
  const canonicalExtraSources = (host: HostConfig) =>
    (host.extraSources ?? [])
      .map(({ type, agent, path }) => ({ type, agent, path }))
      .sort((left, right) => left.agent.localeCompare(right.agent));

  return (
    before.ssh !== after.ssh ||
    before.ccusageCmd !== after.ccusageCmd ||
    JSON.stringify(canonicalExtraSources(before)) !==
      JSON.stringify(canonicalExtraSources(after))
  );
}

function replaceHostFromForm(existing: HostConfig, updated: HostConfig): HostConfig {
  const preserved = { ...existing };
  delete preserved.extraSources;
  return { ...preserved, ...updated, enabled: existing.enabled };
}

interface SaveConfigOptions {
  setError?: (message: string | null) => void;
  shouldRefresh?: (before: AppConfig, after: AppConfig) => boolean;
  resetHostState?: boolean;
  onSuccess?: () => void;
}

interface SettingsDialogProps {
  open: boolean;
  config: AppConfig | undefined;
  /** When opened from the onboarding CTA, pre-expand the add-host form. */
  autoAddHost?: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, config, autoAddHost = false, onClose }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState<string | null>(null); // host id or "__new__"
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Map<string, TestConnectionResponse>>(
    new Map(),
  );
  const [serverError, setServerError] = useState<string | null>(null);
  const [generalServerError, setGeneralServerError] = useState<string | null>(null);
  const mutation = useConfigMutation();
  const queryClient = useQueryClient();
  const { pushToast } = useToasts();

  useEffect(() => {
    const dlg = dialogRef.current;
    if (dlg === null) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  // Onboarding CTA → land directly in the add-host form (FR7 polish);
  // closing resets transient edit state so the next open starts clean.
  useEffect(() => {
    if (open && autoAddHost) {
      setEditing("__new__");
      setServerError(null);
    }
    if (!open) {
      setEditing(null);
      setConfirmingRemove(null);
      setServerError(null);
      setGeneralServerError(null);
    }
  }, [open, autoAddHost]);

  // Scrim click dismisses (click on the dialog element itself = backdrop).
  const onDialogClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) onClose();
  };

  const saveConfig = async (
    mutate: (config: AppConfig) => AppConfig,
    successMsg: string,
    {
      setError = setServerError,
      shouldRefresh = () => false,
      resetHostState = true,
      onSuccess = () => {},
    }: SaveConfigOptions = {},
  ) => {
    if (config === undefined) return;
    setError(null);
    // PUT /api/config replaces the WHOLE document, so the read side of this
    // read-modify-write must be fresh — the cached config prop can be
    // arbitrarily stale (no polling), and building the body from it would
    // silently revert any concurrent hand edit to tokdash.config.json
    // (§3.1 explicitly supports hand edits). Refetch right before writing.
    let fresh: AppConfig;
    try {
      fresh = await queryClient.fetchQuery({
        queryKey: ["config"],
        queryFn: fetchConfig,
        staleTime: 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      pushToast("negative", "Config update failed", msg);
      return;
    }
    const next = mutate(fresh);
    mutation.mutate(
      next,
      {
        onSuccess: () => {
          if (resetHostState) {
            setEditing(null);
            setConfirmingRemove(null);
          }
          onSuccess();
          pushToast("positive", successMsg);
          if (shouldRefresh(fresh, next)) {
            void postRefresh().catch((err: unknown) => {
              console.error("Failed to start refresh after config save", err);
            });
            void queryClient.invalidateQueries({ queryKey: ["status"] });
          }
        },
        onError: (err) => {
          const msg =
            err instanceof ApiError
              ? `${err.message}${err.details !== undefined ? ` — ${JSON.stringify(err.details)}` : ""}`
              : err.message;
          setError(msg);
          pushToast("negative", "Config update failed", msg);
        },
      },
    );
  };

  const saveHosts = (
    mutate: (hosts: HostConfig[]) => HostConfig[],
    successMsg: string,
    shouldRefresh: (before: AppConfig, after: AppConfig) => boolean = () => false,
  ) =>
    saveConfig(
      (fresh) => ({ ...fresh, hosts: mutate(fresh.hosts) }),
      successMsg,
      { setError: setServerError, shouldRefresh },
    );

  const runTest = async (hostId: string) => {
    setTesting((prev) => new Set(prev).add(hostId));
    try {
      const result = await testHostConnection(hostId);
      setTestResults((prev) => new Map(prev).set(hostId, result));
    } catch (err) {
      pushToast(
        "negative",
        `Test failed for ${hostId}`,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setTesting((prev) => {
        const next = new Set(prev);
        next.delete(hostId);
        return next;
      });
    }
  };

  const hosts = config?.hosts ?? [];
  const existingIds = hosts.map((h) => h.id);

  return (
    <dialog
      ref={dialogRef}
      className="dlg"
      onClose={onClose}
      onClick={onDialogClick}
      aria-label="Settings"
    >
      <div className="flex items-center justify-between pb-3">
        <h2 className="t-title" style={{ margin: 0 }}>
          Settings
        </h2>
        <button type="button" className="btn-ghost" onClick={onClose} aria-label="Close settings">
          ×
        </button>
      </div>

      <div className="flex flex-col gap-4" style={{ maxHeight: "60vh", overflowY: "auto" }}>
        <GeneralSettings
          open={open}
          config={config}
          saving={mutation.isPending}
          serverError={generalServerError}
          onEdit={() => setGeneralServerError(null)}
          onSave={(settings, onSuccess) =>
            void saveConfig(
              (fresh) => ({ ...fresh, ...settings }),
              "General settings saved",
              {
                setError: setGeneralServerError,
                resetHostState: false,
                onSuccess,
              },
            )
          }
        />
        <section>
          <h3 className="t-body" style={{ fontWeight: 600, margin: 0 }}>
            Hosts
          </h3>
          {hosts.map((host) => {
            const isEditing = editing === host.id;
            const isConfirming = confirmingRemove === host.id;
            const isTesting = testing.has(host.id);
            const testResult = testResults.get(host.id);
            return (
              <div
                key={host.id}
                style={{
                  borderBottom: "1px solid var(--border-hairline)",
                  padding: "10px 0",
                  opacity: host.enabled ? 1 : 0.6,
                  ...(isConfirming
                    ? {
                        background: "var(--negative-muted)",
                        borderRadius: "var(--radius-control)",
                        padding: 10,
                      }
                    : {}),
                }}
              >
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 3,
                      background: host.color,
                      flex: "none",
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="t-body" style={{ fontWeight: 600 }}>
                      {host.label}
                    </span>
                    <span
                      className="t-mono"
                      style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8 }}
                    >
                      {host.id}
                    </span>
                  </div>
                  <span className="badge badge-neutral t-mono" style={{ fontWeight: 450 }}>
                    {host.ssh ?? "local"}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={host.enabled}
                    aria-label={`${host.enabled ? "Disable" : "Enable"} ${host.label}`}
                    className="switch"
                    onClick={() =>
                      void saveHosts(
                        (hs) =>
                          hs.map((h) =>
                            h.id === host.id ? { ...h, enabled: !h.enabled } : h,
                          ),
                        `${host.label} ${host.enabled ? "disabled" : "enabled"}`,
                        // A host is skipped by refreshes while disabled, so its
                        // snapshot is stale by the time it is re-enabled.
                        (before, after) =>
                          before.hosts.find((h) => h.id === host.id)?.enabled === false &&
                          after.hosts.find((h) => h.id === host.id)?.enabled === true,
                      )
                    }
                  />
                </div>

                {isConfirming ? (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="t-body" style={{ color: "var(--text-primary)" }}>
                      Remove {host.label}? Its cached data will stop being shown.
                    </span>
                    <span className="flex gap-2">
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setConfirmingRemove(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() =>
                          void saveHosts(
                            (hs) => hs.filter((h) => h.id !== host.id),
                            `${host.label} removed`,
                          )
                        }
                      >
                        Confirm
                      </button>
                    </span>
                  </div>
                ) : (
                  !isEditing && (
                    <div className="mt-1.5 flex gap-1" style={{ marginLeft: 24 }}>
                      <button
                        type="button"
                        className="btn-ghost t-caption"
                        onClick={() => {
                          setEditing(host.id);
                          setServerError(null);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-ghost t-caption"
                        disabled={isTesting}
                        onClick={() => void runTest(host.id)}
                      >
                        {isTesting ? (
                          <>
                            <svg
                              className="spin"
                              width="12"
                              height="12"
                              viewBox="0 0 16 16"
                              fill="none"
                              aria-hidden
                              style={{ color: "var(--accent)" }}
                            >
                              <path
                                d="M13.5 8a5.5 5.5 0 1 1-5.5-5.5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                              />
                            </svg>
                            Testing…
                          </>
                        ) : (
                          "Test connection"
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost t-caption"
                        style={{ color: "var(--negative)" }}
                        onClick={() => setConfirmingRemove(host.id)}
                      >
                        Remove
                      </button>
                    </div>
                  )
                )}

                {isEditing && (
                  <HostForm
                    initial={{
                      id: host.id,
                      label: host.label,
                      color: host.color,
                      ssh: host.ssh ?? "",
                      ccusageCmd: host.ccusageCmd,
                      extraSources: (host.extraSources ?? []).map((source) => ({
                        agent: source.agent,
                        path: source.path,
                      })),
                    }}
                    isNew={false}
                    existingIds={existingIds}
                    saving={mutation.isPending}
                    serverError={serverError}
                    onCancel={() => setEditing(null)}
                    onSave={(updated) =>
                      void saveHosts(
                        (hs) =>
                          hs.map((h) =>
                            h.id === host.id ? replaceHostFromForm(h, updated) : h,
                          ),
                        `${updated.label} saved`,
                        (before, after) => {
                          const oldHost = before.hosts.find((candidate) => candidate.id === host.id);
                          const newHost = after.hosts.find((candidate) => candidate.id === host.id);
                          return (
                            oldHost !== undefined &&
                            newHost !== undefined &&
                            fetchAffectingHostFieldsChanged(oldHost, newHost)
                          );
                        },
                      )
                    }
                  />
                )}

                {testResult !== undefined && !isEditing && (
                  <TestResultPanel result={testResult} />
                )}
              </div>
            );
          })}
        </section>
      </div>

      {editing === "__new__" ? (
        <HostForm
          initial={EMPTY_FORM}
          isNew
          existingIds={existingIds}
          saving={mutation.isPending}
          serverError={serverError}
          onCancel={() => setEditing(null)}
          onSave={(host) =>
            void saveHosts(
              (hs) => [...hs, host],
              `${host.label} added`,
              (before, after) => after.hosts.length > before.hosts.length,
            )
          }
        />
      ) : (
        <div className="pt-3">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setEditing("__new__");
              setServerError(null);
            }}
          >
            Add host
          </button>
        </div>
      )}
    </dialog>
  );
}

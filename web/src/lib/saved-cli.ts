export const CONFIG_KEY = "career-ops:config";

// Mirror the selected CLI/model onto the server (/api/config) so the BOSS直聘
// extension can reuse it without re-asking. Best-effort — the local store is
// still authoritative for the web UI; a failed post must never block the save.
function pushServerConfig(patch: Record<string, string>) {
  void fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

export function readSavedCliId(): string | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const id = raw ? JSON.parse(raw).cliId : "";
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export function persistCliId(cliId: string) {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({ ...prev, mode: prev.mode || "cli", cliId }),
    );
    pushServerConfig({ cliId });
  } catch {
    /* quota / private mode */
  }
}

export function readSavedModel(): string | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const model = raw ? JSON.parse(raw).model : "";
    return typeof model === "string" && model ? model : null;
  } catch {
    return null;
  }
}

export function persistModel(model: string) {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...prev, mode: prev.mode || "cli", model }));
    pushServerConfig({ model });
  } catch {
    /* quota / private mode */
  }
}

export function pickSoleInstalled(
  clis: { id: string; installed?: boolean }[] | undefined,
): string | null {
  const installed = (clis || []).filter((c) => c.installed);
  return installed.length === 1 ? installed[0].id : null;
}

/** Saved Config cliId, or the only installed CLI (and persist that pick). */
export async function resolveCliId(): Promise<string | null> {
  const saved = readSavedCliId();
  if (saved) return saved;
  try {
    const r = await fetch("/api/clis");
    const d = (await r.json()) as { clis?: { id: string; installed?: boolean }[] };
    const sole = pickSoleInstalled(d.clis);
    if (!sole) return null;
    persistCliId(sole);
    return sole;
  } catch {
    return null;
  }
}

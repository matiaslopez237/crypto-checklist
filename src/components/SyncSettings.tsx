import { useState } from "react";
import type { GitHubSyncConfig } from "../lib/storage";

export type SyncStatus = { kind: "idle" } | { kind: "syncing" } | { kind: "ok"; at: number } | { kind: "error"; message: string };

export function SyncSettings({
  config,
  onSave,
  onClear,
  status,
  onSyncNow,
}: {
  config: GitHubSyncConfig | null;
  onSave: (config: GitHubSyncConfig) => void;
  onClear: () => void;
  status: SyncStatus;
  onSyncNow: () => void;
}) {
  const [open, setOpen] = useState(!config);
  const [token, setToken] = useState(config?.token ?? "");
  const [owner, setOwner] = useState(config?.owner ?? "matiaslopez237");
  const [repo, setRepo] = useState(config?.repo ?? "crypto-checklist");

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !owner || !repo) return;
    onSave({ token, owner, repo });
    setOpen(false);
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200"
      >
        <span>Sincronización con el monitor 24/7</span>
        <span className="text-xs font-normal text-slate-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <form onSubmit={handleSave} className="flex flex-col gap-2 border-t border-slate-200 p-3 dark:border-slate-800">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Cada compra/venta que cargues acá se sube automáticamente a{" "}
            <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">monitor/positions.json</code> en GitHub, así el
            monitor en la nube manda alertas con tu posición real. Necesitás un token de acceso personal de GitHub con
            permiso de escritura sobre ese repo (creá uno en github.com/settings/tokens, tipo "fine-grained", limitado a
            este repo, con permiso "Contents: Read and write"). El token se guarda solo en esta compu, nunca sale de acá
            salvo hacia la API de GitHub.
          </p>
          <label className="text-sm text-slate-600 dark:text-slate-300">
            Token de GitHub
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="github_pat_..."
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
            />
          </label>
          <div className="flex gap-2">
            <label className="flex-1 text-sm text-slate-600 dark:text-slate-300">
              Usuario/Org
              <input
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
              />
            </label>
            <label className="flex-1 text-sm text-slate-600 dark:text-slate-300">
              Repo
              <input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800"
              />
            </label>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
            >
              Guardar
            </button>
            {config && (
              <button
                type="button"
                onClick={onClear}
                className="rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-600 dark:border-rose-700 dark:text-rose-400"
              >
                Desconectar
              </button>
            )}
          </div>
        </form>
      )}

      {config && (
        <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-3 py-2 text-xs dark:border-slate-800">
          <StatusLabel status={status} />
          <button type="button" onClick={onSyncNow} className="font-medium text-slate-500 underline hover:text-slate-900 dark:text-slate-400 dark:hover:text-white">
            Sincronizar ahora
          </button>
        </div>
      )}
    </section>
  );
}

function StatusLabel({ status }: { status: SyncStatus }) {
  if (status.kind === "syncing") return <span className="text-slate-500 dark:text-slate-400">Sincronizando…</span>;
  if (status.kind === "ok") {
    const time = new Date(status.at).toLocaleTimeString();
    return <span className="text-emerald-600 dark:text-emerald-400">Sincronizado {time}</span>;
  }
  if (status.kind === "error") return <span className="text-rose-600 dark:text-rose-400">Error: {status.message}</span>;
  return <span className="text-slate-400 dark:text-slate-500">Sin sincronizar todavía</span>;
}

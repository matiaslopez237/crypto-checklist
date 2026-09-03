export interface GitHubRepoConfig {
  token: string;
  owner: string;
  repo: string;
}

export interface GitHubFile {
  content: string;
  sha: string;
}

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function headersFor(config: GitHubRepoConfig) {
  return {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // Required by GitHub's API (returns 403 without it). Browsers refuse to let scripts
    // set this header and silently send their own default instead, so this only matters
    // in non-browser environments like the Cloudflare Worker — harmless either way.
    "User-Agent": "crypto-checklist-app",
  };
}

// Returns null if the file doesn't exist yet (404). Throws on auth/other errors.
export async function getGitHubFile(config: GitHubRepoConfig, path: string): Promise<GitHubFile | null> {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}`;
  const res = await fetch(url, { headers: headersFor(config) });

  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new Error("Token inválido o sin permiso de escritura sobre el repo.");
  }
  if (!res.ok) {
    throw new Error(`Error de GitHub (${res.status}) al leer ${path}.`);
  }

  const data = (await res.json()) as { content: string; sha: string };
  return { content: fromBase64(data.content), sha: data.sha };
}

export async function putGitHubFile(
  config: GitHubRepoConfig,
  path: string,
  content: string,
  sha: string | undefined,
  message: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headersFor(config), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: toBase64(content), sha }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Error de GitHub (${res.status}) al actualizar ${path}. ${body}`);
  }
}

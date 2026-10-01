import { execFileSync } from "node:child_process";

export const ONECLI_CONNECTION_HEADER = "x-onecli-connection-id: d26cdfbb-fa91-458f-b76f-1556918c427e";

export function githubApiArgs(endpoint, { method = "GET", paginate = false } = {}) {
  return [
    "api",
    "--method",
    method,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    ONECLI_CONNECTION_HEADER,
    ...(paginate ? ["--paginate"] : []),
    endpoint,
  ];
}

export function githubApi(endpoint, { method = "GET", paginate = false, allow = [], exec = execFileSync } = {}) {
  try {
    const stdout = exec("gh", githubApiArgs(endpoint, { method, paginate }), {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      status: method === "GET" && endpoint.endsWith("/vulnerability-alerts") ? 204 : 200,
      data: stdout.trim() ? JSON.parse(stdout) : null,
    };
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    const match = stderr.match(/HTTP (\d{3})/);
    const status = match ? Number(match[1]) : 0;
    if (allow.includes(status)) return { status, data: null };
    throw new Error(`GitHub API ${endpoint} failed (${status || "runtime"})`);
  }
}

export function listInstalledRepositories({ exec = execFileSync } = {}) {
  const response = githubApi("/installation/repositories?per_page=100", { exec });
  return (response.data?.repositories ?? []).map((repo) => ({
    repository: repo.full_name,
    owner: repo.owner.login,
    default_branch: repo.default_branch,
    html_url: repo.html_url,
  })).sort((a, b) => a.repository.localeCompare(b.repository));
}

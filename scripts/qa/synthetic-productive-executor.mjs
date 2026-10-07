#!/usr/bin/env node

/**
 * Deterministic, staging-only process-adapter fixture for timer provenance QA.
 *
 * Configure an isolated synthetic agent with:
 *   command: process.execPath
 *   args: ["scripts/qa/synthetic-productive-executor.mjs", "<synthetic-issue-id>"]
 *
 * The first run writes one run-attributed progress comment and exits cleanly
 * while the issue remains in progress. A continuation run observes that marker,
 * marks the same synthetic issue done, and exits. It never discovers or mutates
 * any issue other than the explicit UUID passed in adapter configuration.
 */

const issueId = process.argv[2]?.trim();
const apiUrl = process.env.PAPERCLIP_API_URL?.replace(/\/$/, "");
const apiKey = process.env.PAPERCLIP_API_KEY;
const runId = process.env.PAPERCLIP_RUN_ID;
const marker = "[synthetic-timer-provenance] productive terminal marker";

if (!issueId || !/^[0-9a-f-]{36}$/i.test(issueId)) {
  throw new Error("Expected one explicit synthetic issue UUID argument");
}
if (!apiUrl || !apiKey || !runId) {
  throw new Error("Paperclip runtime API URL, run token, and run ID are required");
}

async function request(path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "x-paperclip-run-id": runId,
      ...init.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${body.slice(0, 200)}`);
  }
  return body ? JSON.parse(body) : null;
}

const issue = await request(`/api/issues/${issueId}`);
if (issue.status === "done") {
  process.stdout.write("synthetic issue already complete\n");
  process.exit(0);
}
if (issue.status !== "in_progress") {
  throw new Error(`Synthetic issue must be in_progress, received ${String(issue.status)}`);
}

const comments = await request(`/api/issues/${issueId}/comments`);
const hasProductiveMarker = Array.isArray(comments)
  && comments.some((comment) => typeof comment?.body === "string" && comment.body.includes(marker));

if (!hasProductiveMarker) {
  await request(`/api/issues/${issueId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: `${marker}\nrun: ${runId}` }),
  });
  process.stdout.write("productive marker recorded; leaving issue in progress for continuation recovery\n");
} else {
  await request(`/api/issues/${issueId}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "done",
      comment: `Synthetic continuation completed by run ${runId}.`,
    }),
  });
  process.stdout.write("synthetic continuation completed\n");
}

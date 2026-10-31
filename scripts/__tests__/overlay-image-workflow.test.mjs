import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/overlay-image.yml"), "utf8");
const dockerWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");
const overlay = readFileSync(path.join(repoRoot, "docker/Dockerfile.overlay"), "utf8");

const SOURCE_SHA = "c4d7eb21d89b9e8772fa99e86e928ac4e3a26fd3";
const OTHER_REPO_REVISION = "9107e43c29d2f99f4f31486e63c59d724c16ff27";
const OWN_IMAGE = "ghcr.io/misterbusiness1/occ-custom-paperclip";

function stepBlock(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `overlay-image.yml must have a "${name}" step`);
  const next = workflow.indexOf("\n      - name: ", start + 1);
  return workflow.slice(start, next === -1 ? undefined : next + 1);
}

function stepRun(name) {
  const run = stepBlock(name).match(/        run: \|\n((?:          .*\n|\n)+)/)?.[1];
  assert.ok(run, `the "${name}" step must have a run script`);
  return run.split("\n").map((line) => (line.startsWith("          ") ? line.slice(10) : line)).join("\n");
}

function tempRoot(t, prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Runs a workflow step's bash script with a fake `docker` on PATH. The fake
// records every invocation and answers `image inspect` from the fixture.
function runStep(t, name, env, fixture = {}) {
  const root = tempRoot(t, "paperclip-overlay-workflow-");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "fixture.json"), JSON.stringify(fixture));
  writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.json"), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify(args) + "\\n");
if (args[0] === "pull") process.exit(fixture.pullFails ? 1 : 0);
if (args[0] === "image" && args[1] === "inspect") {
  const format = args[args.indexOf("--format") + 1];
  if (format.includes("org.opencontainers.image.revision")) process.stdout.write((fixture.revision ?? "") + "\\n");
  if (format.includes("RepoDigests")) process.stdout.write((fixture.repoDigests ?? []).map((d) => d + "\\n").join("") + "\\n");
}
process.exit(0);
`, { mode: 0o755 });
  const outputFile = path.join(root, "github-output");
  writeFileSync(outputFile, "");
  const result = spawnSync("bash", ["-c", stepRun(name)], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: outputFile, ...env },
  });
  const outputs = Object.fromEntries(
    readFileSync(outputFile, "utf8").split("\n").filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
  let calls = [];
  try {
    calls = readFileSync(path.join(bin, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {}
  return { ...result, outputs, calls };
}

test("docker.yml still publishes the short-sha tag the overlay resolves by default", () => {
  assert.match(dockerWorkflow, /images: ghcr\.io\/\$\{\{ github\.repository \}\}\n/);
  assert.match(dockerWorkflow, /^ +type=sha$/m);
  assert.doesNotMatch(dockerWorkflow, /DOCKER_METADATA_SHORT_SHA_LENGTH|type=sha,/);
});

test("the default base image is this repository's own lowercase image for source_sha", (t) => {
  const upstreamInput = workflow.match(/^      upstream_image:\n((?:        .*\n)+)/m)?.[1];
  assert.ok(upstreamInput, "overlay-image.yml must keep the upstream_image input");
  assert.match(upstreamInput, /^        default: ''$/m);
  assert.doesNotMatch(workflow, /misterbusiness1\/paperclip:latest/);

  const result = runStep(t, "Resolve base image", {
    GITHUB_REPOSITORY: "misterbusiness1/OCC-Custom-Paperclip",
    SOURCE_SHA,
    UPSTREAM_IMAGE: "",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs.image, `${OWN_IMAGE}:sha-c4d7eb2`);
});

test("an explicit upstream_image is used as given", (t) => {
  const result = runStep(t, "Resolve base image", {
    GITHUB_REPOSITORY: "misterbusiness1/OCC-Custom-Paperclip",
    SOURCE_SHA,
    UPSTREAM_IMAGE: "ghcr.io/example/custom:tag",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs.image, "ghcr.io/example/custom:tag");
});

test("the base image is pinned by digest once its revision label equals source_sha", (t) => {
  const result = runStep(
    t,
    "Verify base image revision",
    { BASE_IMAGE: `${OWN_IMAGE}:sha-c4d7eb2`, SOURCE_SHA },
    {
      revision: SOURCE_SHA,
      repoDigests: [`${OWN_IMAGE}-other@sha256:${"0".repeat(64)}`, `${OWN_IMAGE}@sha256:${"a".repeat(64)}`],
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs.image, `${OWN_IMAGE}@sha256:${"a".repeat(64)}`);
  assert.deepEqual(result.calls[0], ["pull", `${OWN_IMAGE}:sha-c4d7eb2`]);
});

test("a digest reference is kept as the pinned base image", (t) => {
  const ref = `ghcr.io/example/custom@sha256:${"b".repeat(64)}`;
  const result = runStep(t, "Verify base image revision", { BASE_IMAGE: ref, SOURCE_SHA }, { revision: SOURCE_SHA });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs.image, ref);
});

test("a base image built from another revision is rejected before building", (t) => {
  const result = runStep(
    t,
    "Verify base image revision",
    { BASE_IMAGE: "ghcr.io/misterbusiness1/paperclip:latest", SOURCE_SHA },
    { revision: OTHER_REPO_REVISION, repoDigests: [`ghcr.io/misterbusiness1/paperclip@sha256:${"c".repeat(64)}`] },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`revision mismatch.*${OTHER_REPO_REVISION}.*expected ${SOURCE_SHA}`));
  assert.equal(result.outputs.image, undefined);
});

test("a base image without a revision label is rejected", (t) => {
  const result = runStep(t, "Verify base image revision", { BASE_IMAGE: `${OWN_IMAGE}:sha-c4d7eb2`, SOURCE_SHA }, { revision: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /revision mismatch/);
  assert.equal(result.outputs.image, undefined);
});

test("a missing base image fails with a pointer to docker.yml", (t) => {
  const result = runStep(t, "Verify base image revision", { BASE_IMAGE: `${OWN_IMAGE}:sha-c4d7eb2`, SOURCE_SHA }, { pullFails: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Base image not found.*docker\.yml/);
  assert.equal(result.outputs.image, undefined);
});

test("a base image without a matching repository digest is rejected", (t) => {
  const result = runStep(
    t,
    "Verify base image revision",
    { BASE_IMAGE: `${OWN_IMAGE}:sha-c4d7eb2`, SOURCE_SHA },
    { revision: SOURCE_SHA, repoDigests: [`ghcr.io/example/other@sha256:${"d".repeat(64)}`] },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /digest unknown/);
});

test("both build steps use the verified base image, after the revision check", () => {
  const verifyAt = workflow.indexOf("      - name: Verify base image revision\n");
  assert.notEqual(verifyAt, -1);
  for (const name of ["Build and push overlay image with cache", "Build and push overlay image without cache"]) {
    assert.ok(workflow.indexOf(`      - name: ${name}\n`) > verifyAt, `${name} must run after the revision check`);
    assert.match(stepBlock(name), /UPSTREAM_IMAGE=\$\{\{ steps\.base-verified\.outputs\.image \}\}\n/);
  }
  // The raw input reaches only the resolver; everything else uses the verified digest.
  assert.equal(workflow.match(/inputs\.upstream_image/g)?.length, 1);
  assert.match(stepBlock("Resolve base image"), /inputs\.upstream_image/);
});

test("the smoke test launches Chromium with an unseeded volume at /paperclip, as compose does", (t) => {
  const image = `ghcr.io/misterbusiness1/paperclip-prod@sha256:${"e".repeat(64)}`;
  const result = runStep(t, "Smoke-test immutable overlay image", { IMMUTABLE_IMAGE: image, PLAYWRIGHT_VERSION: "1.61.1" });
  assert.equal(result.status, 0, result.stderr);
  const runs = result.calls.filter((args) => args[0] === "run");
  const launch = runs.find((args) => args.includes("node") && args.some((arg) => arg.includes("chromium.launch")));
  assert.ok(launch, "the smoke test must launch Chromium");
  const beforeImage = launch.slice(0, launch.indexOf(image));
  assert.ok(
    beforeImage.some((arg, i) => arg === "-v" && /^paperclip-smoke:\/paperclip:nocopy$/.test(beforeImage[i + 1] ?? "")),
    `the Chromium launch must mount an unseeded volume at /paperclip: ${JSON.stringify(launch)}`,
  );
  assert.ok(runs.indexOf(launch) > 0, "the volume must be prepared before the launch");
});

function overlayVerifyScript() {
  const script = overlay.match(/^RUN <<'EOF'\n([\s\S]*?)\nEOF$/m)?.[1];
  assert.ok(script, "Dockerfile.overlay must verify the base image's browsers in a RUN heredoc");
  return script;
}

// Builds a fake image filesystem: Playwright browsers plus the pnpm-installed
// playwright package whose chromium.executablePath() points into them.
function browserFixture(t, { browsersUnder = "", chromium = true, headlessShell = true } = {}) {
  const root = tempRoot(t, "paperclip-overlay-browsers-");
  const browsers = path.join(root, browsersUnder, "ms-playwright");
  const chromiumPath = path.join(browsers, "chromium-1234", "chrome-linux", "chrome");
  if (chromium) {
    mkdirSync(path.dirname(chromiumPath), { recursive: true });
    writeFileSync(chromiumPath, "", { mode: 0o755 });
  }
  if (headlessShell) {
    const shell = path.join(browsers, "chromium_headless_shell-1234", "chrome-headless-shell-linux64", "chrome-headless-shell");
    mkdirSync(path.dirname(shell), { recursive: true });
    writeFileSync(shell, "", { mode: 0o755 });
  }
  mkdirSync(browsers, { recursive: true });
  const pkg = path.join(root, "app/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, "index.js"), `module.exports = { chromium: { executablePath: () => ${JSON.stringify(chromiumPath)} } };\n`);
  return { root, browsers };
}

function runOverlayVerify(root, env) {
  const script = overlayVerifyScript().replaceAll("/app/", `${root}/app/`);
  return spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: "/paperclip", PLAYWRIGHT_VERSION: "1.61.1", ...env },
  });
}

test("Dockerfile.overlay keeps the base image's browsers instead of reinstalling them into HOME", () => {
  assert.doesNotMatch(overlay, /^ENV\s+PLAYWRIGHT_BROWSERS_PATH/m);
  assert.doesNotMatch(overlay, /playwright@\$\{PLAYWRIGHT_VERSION\}"?\s+install/);
  assert.doesNotMatch(overlay, /^USER\s/m);
  assert.doesNotMatch(overlay, /pending upstream PR/i);
  assert.match(overlay, /^ARG UPSTREAM_IMAGE$/m);
});

test("the overlay verification accepts browsers outside the /paperclip volume", (t) => {
  const { root, browsers } = browserFixture(t);
  const result = runOverlayVerify(root, { PLAYWRIGHT_BROWSERS_PATH: browsers });
  assert.equal(result.status, 0, result.stderr);
});

test("the overlay verification rejects browsers under /paperclip, where the volume hides them", (t) => {
  const { root } = browserFixture(t);
  const result = runOverlayVerify(root, { PLAYWRIGHT_BROWSERS_PATH: "/paperclip/.cache/ms-playwright" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /under the \/paperclip volume/);
});

test("the overlay verification rejects browsers under HOME", (t) => {
  const { root, browsers } = browserFixture(t, { browsersUnder: "home/.cache" });
  const result = runOverlayVerify(root, { HOME: path.join(root, "home"), PLAYWRIGHT_BROWSERS_PATH: browsers });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /under HOME=/);
});

test("the overlay verification fails when the base image provides no browsers", (t) => {
  const unset = browserFixture(t);
  const noPath = runOverlayVerify(unset.root, {});
  assert.notEqual(noPath.status, 0);
  assert.match(noPath.stderr, /does not set PLAYWRIGHT_BROWSERS_PATH/);

  const noChromium = browserFixture(t, { chromium: false });
  const missingChromium = runOverlayVerify(noChromium.root, { PLAYWRIGHT_BROWSERS_PATH: noChromium.browsers });
  assert.notEqual(missingChromium.status, 0);
  assert.match(missingChromium.stderr, /Chromium for playwright@1\.61\.1 is missing/);

  const noShell = browserFixture(t, { headlessShell: false });
  const missingShell = runOverlayVerify(noShell.root, { PLAYWRIGHT_BROWSERS_PATH: noShell.browsers });
  assert.notEqual(missingShell.status, 0);
  assert.match(missingShell.stderr, /no Chromium headless shell/);
});

test("the overlay verification fails when PLAYWRIGHT_VERSION does not match the installed playwright", (t) => {
  const { root, browsers } = browserFixture(t);
  const result = runOverlayVerify(root, { PLAYWRIGHT_BROWSERS_PATH: browsers, PLAYWRIGHT_VERSION: "9.9.9" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /playwright@9\.9\.9 is not installed/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { githubApiArgs, listInstalledRepositories, ONECLI_CONNECTION_HEADER, ONECLI_GH_TOKEN_PLACEHOLDER } from "../src/github.mjs";

test("every GitHub API argument vector selects the governed connection", () => {
  const args = githubApiArgs("/repos/acme/widget");
  assert.deepEqual(args.slice(args.indexOf(ONECLI_CONNECTION_HEADER) - 1, args.indexOf(ONECLI_CONNECTION_HEADER) + 1), ["-H", ONECLI_CONNECTION_HEADER]);
});

test("repository enumeration uses the selected GitHub API connection", () => {
  let invoked;
  const exec = (command, args, options) => {
    invoked = { command, args, options };
    return JSON.stringify({ repositories: [{ full_name: "misterbusiness1/widget", owner: { login: "misterbusiness1" }, default_branch: "main", html_url: "https://github.com/misterbusiness1/widget" }] });
  };
  assert.equal(listInstalledRepositories({ exec })[0].repository, "misterbusiness1/widget");
  assert.equal(invoked.command, "gh");
  assert.ok(invoked.args.includes(ONECLI_CONNECTION_HEADER));
  assert.ok(invoked.args.includes("/installation/repositories?per_page=100"));
  assert.equal(invoked.options.env.GH_TOKEN, ONECLI_GH_TOKEN_PLACEHOLDER);
});

test("GitHub CLI receives only the value-free OneCLI auth placeholder", () => {
  let invoked;
  const exec = (command, args, options) => {
    invoked = { command, args, options };
    return JSON.stringify({ repositories: [] });
  };

  listInstalledRepositories({ exec });

  assert.equal(invoked.options.env.GH_TOKEN, "onecli-managed");
  assert.ok(invoked.args.includes(ONECLI_CONNECTION_HEADER));
});

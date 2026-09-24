import assert from "node:assert/strict";
import test from "node:test";
import { githubApiArgs, listInstalledRepositories, ONECLI_CONNECTION_HEADER } from "../src/github.mjs";

test("every GitHub API argument vector selects the governed connection", () => {
  const args = githubApiArgs("/repos/acme/widget");
  assert.deepEqual(args.slice(args.indexOf(ONECLI_CONNECTION_HEADER) - 1, args.indexOf(ONECLI_CONNECTION_HEADER) + 1), ["-H", ONECLI_CONNECTION_HEADER]);
});

test("repository enumeration uses the selected GitHub API connection", () => {
  let invoked;
  const exec = (command, args) => {
    invoked = { command, args };
    return JSON.stringify({ repositories: [{ full_name: "misterbusiness1/widget", owner: { login: "misterbusiness1" }, default_branch: "main", html_url: "https://github.com/misterbusiness1/widget" }] });
  };
  assert.equal(listInstalledRepositories({ exec })[0].repository, "misterbusiness1/widget");
  assert.equal(invoked.command, "gh");
  assert.ok(invoked.args.includes(ONECLI_CONNECTION_HEADER));
  assert.ok(invoked.args.includes("/installation/repositories?per_page=100"));
});

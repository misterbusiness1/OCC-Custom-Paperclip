import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EXPECTED_REPOSITORIES,
  EXPECTED_REPOSITORY_COUNT,
  validateInstallationInventory,
} from "../src/inventory.mjs";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"))
    .map((repository) => ({ owner: repository.split("/")[0], repository }));
}

test("accepts the governed pinned 51-repository installation inventory", () => {
  assert.equal(EXPECTED_REPOSITORY_COUNT, 51);
  assert.doesNotThrow(() => validateInstallationInventory(fixture("inventory-51.json"), "misterbusiness1"));
});

test("pins the deliberately reviewed installation additions", () => {
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/ironcraft-app"));
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/origineos-engineering"));
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/Remote-LLM-Qwen-Splash"));
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/occ-email-delivery-guard"));
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/occ-login-guard"));
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/pulse-app"));
});

test("fails closed when the installation falls back to the former 49-repository inventory", () => {
  const installed = fixture("inventory-51.json").filter(({ repository }) => ![
    "misterbusiness1/ironcraft-app",
    "misterbusiness1/origineos-engineering",
  ].includes(repository));
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /expected 51, received 49; added \[\]; missing \[misterbusiness1\/ironcraft-app, misterbusiness1\/origineos-engineering\]/,
  );
});

for (const repository of ["misterbusiness1/ironcraft-app", "misterbusiness1/origineos-engineering"]) {
  test(`reports the named delta when ${repository} is replaced at the same count`, () => {
    const installed = fixture("inventory-51.json").filter((entry) => entry.repository !== repository);
    installed.push({ owner: "misterbusiness1", repository: "misterbusiness1/unexpected-repository" });
    assert.throws(
      () => validateInstallationInventory(installed, "misterbusiness1"),
      (error) => error.message.includes("expected 51, received 51; added [misterbusiness1/unexpected-repository]")
        && error.message.includes(`missing [${repository}]`),
    );
  });
}

test("pins the renamed OCC Custom Paperclip repository without retaining its former name", () => {
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/OCC-Custom-Paperclip"));
  assert.ok(!EXPECTED_REPOSITORIES.includes("misterbusiness1/paperclip"));
});

test("reports the named missing repository delta", () => {
  const installed = fixture("inventory-51.json").slice(1);
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /added \[\]; missing \[misterbusiness1\/aficionado-trackerchain\]/,
  );
});

test("reports the named unexpected-added repository delta", () => {
  const installed = [
    ...fixture("inventory-51.json"),
    ...fixture("inventory-unexpected-added.json"),
  ];
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /added \[misterbusiness1\/unexpected-repository\]; missing \[\]/,
  );
});

test("continues to reject duplicate repositories", () => {
  const installed = fixture("inventory-51.json");
  installed[48] = { ...installed[0] };
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /duplicate repositories returned by installation inventory/,
  );
});

test("continues to reject repositories outside the governed owner", () => {
  const installed = fixture("inventory-51.json");
  installed[48] = { owner: "unexpected-owner", repository: "unexpected-owner/repository-49" };
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /installation inventory contains repositories outside misterbusiness1/,
  );
});

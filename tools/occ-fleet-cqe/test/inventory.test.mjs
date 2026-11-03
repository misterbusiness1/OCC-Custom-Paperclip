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

test("accepts the governed pinned 57-repository installation inventory", () => {
  assert.equal(EXPECTED_REPOSITORY_COUNT, 57);
  assert.doesNotThrow(() => validateInstallationInventory(fixture("inventory-57.json"), "misterbusiness1"));
});

test("pins the deliberately reviewed installation additions", () => {
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/ironcraft-app"));
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/origineos-engineering"));
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/Remote-LLM-Qwen-Splash"));
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/occ-email-delivery-guard"));
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/occ-login-guard"));
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/pulse-app"));
});

test("fails closed when the installation falls back to the 55-repository inventory", () => {
  const installed = fixture("inventory-57.json").filter(({ repository }) => ![
    "misterbusiness1/ironcraft-app",
    "misterbusiness1/origineos-engineering",
  ].includes(repository));
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /expected 57, received 55; added \[\]; missing \[misterbusiness1\/ironcraft-app, misterbusiness1\/origineos-engineering\]/,
  );
});

for (const repository of ["misterbusiness1/ironcraft-app", "misterbusiness1/origineos-engineering"]) {
  test(`reports the named delta when ${repository} is replaced at the same count`, () => {
    const installed = fixture("inventory-57.json").filter((entry) => entry.repository !== repository);
    installed.push({ owner: "misterbusiness1", repository: "misterbusiness1/unexpected-repository" });
    assert.throws(
      () => validateInstallationInventory(installed, "misterbusiness1"),
      (error) => error.message.includes("expected 57, received 57; added [misterbusiness1/unexpected-repository]")
        && error.message.includes(`missing [${repository}]`),
    );
  });
}

test("pins the renamed OCC Custom Paperclip repository without retaining its former name", () => {
  assert.ok(EXPECTED_REPOSITORIES.includes("misterbusiness1/OCC-Custom-Paperclip"));
  assert.ok(!EXPECTED_REPOSITORIES.includes("misterbusiness1/paperclip"));
});

test("reports the named missing repository delta", () => {
  const installed = fixture("inventory-57.json").slice(1);
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /added \[\]; missing \[misterbusiness1\/aficionado-trackerchain\]/,
  );
});

test("reports the named unexpected-added repository delta", () => {
  const installed = [
    ...fixture("inventory-57.json"),
    ...fixture("inventory-unexpected-added.json"),
  ];
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /added \[misterbusiness1\/unexpected-repository\]; missing \[\]/,
  );
});

test("continues to reject duplicate repositories", () => {
  const installed = fixture("inventory-57.json");
  installed[48] = { ...installed[0] };
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /duplicate repositories returned by installation inventory/,
  );
});

test("continues to reject repositories outside the governed owner", () => {
  const installed = fixture("inventory-57.json");
  installed[48] = { owner: "unexpected-owner", repository: "unexpected-owner/repository-49" };
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /installation inventory contains repositories outside misterbusiness1/,
  );
});

const novemberAdditions = [
  "misterbusiness1/getaway-manhunt",
  "misterbusiness1/iencrypt-message",
  "misterbusiness1/occ-refund-tracker",
  "misterbusiness1/onecli-public-history-20261028",
  "misterbusiness1/pepti-ai",
  "misterbusiness1/phone-swipe-media"
];

test("fails closed on the previous 51-repository inventory with all six named missing additions", () => {
  assert.throws(
    () => validateInstallationInventory(fixture("inventory-51.json"), "misterbusiness1"),
    (error) => error.message === `installation inventory does not match pinned manifest: expected 57, received 51; added []; missing [${novemberAdditions.join(", ")}]`,
  );
});

for (const repository of novemberAdditions) {
  test(`pins ${repository} and rejects same-count substitution`, () => {
    assert.ok(EXPECTED_REPOSITORIES.includes(repository));
    const installed = fixture("inventory-57.json").filter((entry) => entry.repository !== repository);
    installed.push({ owner: "misterbusiness1", repository: "misterbusiness1/unexpected-repository" });
    assert.throws(
      () => validateInstallationInventory(installed, "misterbusiness1"),
      (error) => error.message.includes("expected 57, received 57; added [misterbusiness1/unexpected-repository]")
        && error.message.includes(`missing [${repository}]`),
    );
  });
}

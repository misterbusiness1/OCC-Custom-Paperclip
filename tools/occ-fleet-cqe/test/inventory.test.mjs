import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EXPECTED_REPOSITORY_COUNT, validateInstallationInventory } from "../src/inventory.mjs";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"))
    .map((repository) => ({ owner: repository.split("/")[0], repository }));
}

test("accepts the governed pinned 45-repository installation inventory", () => {
  assert.equal(EXPECTED_REPOSITORY_COUNT, 45);
  assert.doesNotThrow(() => validateInstallationInventory(fixture("inventory-45.json"), "misterbusiness1"));
});

test("reports the named missing repository delta", () => {
  const installed = fixture("inventory-45.json").slice(1);
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /added \[\]; missing \[misterbusiness1\/aficionado-trackerchain\]/,
  );
});

test("reports the named unexpected-added repository delta", () => {
  const installed = [
    ...fixture("inventory-45.json"),
    ...fixture("inventory-unexpected-added.json"),
  ];
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /added \[misterbusiness1\/unexpected-repository\]; missing \[\]/,
  );
});

test("continues to reject duplicate repositories", () => {
  const installed = fixture("inventory-45.json");
  installed[44] = { ...installed[0] };
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /duplicate repositories returned by installation inventory/,
  );
});

test("continues to reject repositories outside the governed owner", () => {
  const installed = fixture("inventory-45.json");
  installed[44] = { owner: "unexpected-owner", repository: "unexpected-owner/repository-45" };
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /installation inventory contains repositories outside misterbusiness1/,
  );
});

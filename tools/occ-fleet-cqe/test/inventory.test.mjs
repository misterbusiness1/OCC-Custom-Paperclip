import assert from "node:assert/strict";
import test from "node:test";
import { EXPECTED_REPOSITORY_COUNT, validateInstallationInventory } from "../src/inventory.mjs";

function inventory(count = EXPECTED_REPOSITORY_COUNT) {
  return Array.from({ length: count }, (_, index) => ({
    owner: "misterbusiness1",
    repository: `misterbusiness1/repository-${String(index + 1).padStart(2, "0")}`,
  }));
}

test("accepts the governed 39-repository fleet expansion", () => {
  assert.equal(EXPECTED_REPOSITORY_COUNT, 39);
  assert.doesNotThrow(() => validateInstallationInventory(inventory(), "misterbusiness1"));
});

test("fails closed when the installation inventory is incomplete", () => {
  assert.throws(
    () => validateInstallationInventory(inventory(38), "misterbusiness1"),
    /incomplete installation inventory: expected 39, received 38/,
  );
});

test("continues to reject duplicate repositories", () => {
  const installed = inventory();
  installed[38] = { ...installed[0] };
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /duplicate repositories returned by installation inventory/,
  );
});

test("continues to reject repositories outside the governed owner", () => {
  const installed = inventory();
  installed[38] = { owner: "unexpected-owner", repository: "unexpected-owner/repository-39" };
  assert.throws(
    () => validateInstallationInventory(installed, "misterbusiness1"),
    /installation inventory contains repositories outside misterbusiness1/,
  );
});

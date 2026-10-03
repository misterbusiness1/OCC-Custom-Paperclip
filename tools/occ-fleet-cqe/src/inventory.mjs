import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../repository-manifest.v1.json", import.meta.url), "utf8"),
);

export const EXPECTED_REPOSITORIES = Object.freeze([...manifest.repositories]);
export const EXPECTED_REPOSITORY_COUNT = EXPECTED_REPOSITORIES.length;

export function validateInstallationInventory(installed, repositoryOwner) {
  if (installed.some((repo) => repo.owner !== repositoryOwner)) {
    throw new Error(`installation inventory contains repositories outside ${repositoryOwner}`);
  }

  const unique = new Set(installed.map((repo) => repo.repository));
  if (unique.size !== installed.length) {
    throw new Error("duplicate repositories returned by installation inventory");
  }

  if (manifest.repository_owner !== repositoryOwner) {
    throw new Error(
      `repository owner ${repositoryOwner} does not match pinned manifest owner ${manifest.repository_owner}`,
    );
  }

  const expected = new Set(EXPECTED_REPOSITORIES);
  const added = [...unique].filter((repository) => !expected.has(repository)).sort();
  const missing = EXPECTED_REPOSITORIES.filter((repository) => !unique.has(repository)).sort();
  if (added.length || missing.length) {
    throw new Error(
      `installation inventory does not match pinned manifest: expected ${EXPECTED_REPOSITORY_COUNT}, received ${installed.length}; added [${added.join(", ")}]; missing [${missing.join(", ")}]`,
    );
  }
}

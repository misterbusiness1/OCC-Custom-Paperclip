export const EXPECTED_REPOSITORY_COUNT = 39;

export function validateInstallationInventory(installed, repositoryOwner) {
  if (installed.some((repo) => repo.owner !== repositoryOwner)) {
    throw new Error(`installation inventory contains repositories outside ${repositoryOwner}`);
  }

  const unique = new Set(installed.map((repo) => repo.repository));
  if (unique.size !== installed.length) {
    throw new Error("duplicate repositories returned by installation inventory");
  }

  if (installed.length !== EXPECTED_REPOSITORY_COUNT) {
    throw new Error(
      `incomplete installation inventory: expected ${EXPECTED_REPOSITORY_COUNT}, received ${installed.length}`,
    );
  }
}

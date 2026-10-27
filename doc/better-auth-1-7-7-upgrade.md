# Better Auth 1.7.7 upgrade

The exact 1.7.7 dependency fixes the high and critical advisories affecting 1.7.2. Better Auth 1.7.3+ identifies accounts by `provider_id` and `account_id` and no longer writes `issuer`. Follow the [upstream 1.7 upgrade guide](https://www.better-auth.com/docs/guides/1-7-upgrade-guide#account-identity-keeps-the-provider-key).

Migration 9009 preserves the legacy issuer column and every account value, drops its obsolete unique index, and permits NULL issuer values for new accounts. Its preflight refuses duplicate `(provider_id, account_id)` keys before changing constraints. It never merges or deletes accounts; operators must reconcile ambiguous identities with their owners before retrying.

The schema and package must deploy in a coordinated maintenance window. Take a verified database backup and validate existing credential sign-in, new sign-up, sessions, managed loopback sign-in and workspace handoff on the exact candidate. Historical 1.7.2 password hashes remain valid; tests exercise an actual synthetic hash produced by 1.7.2.

A package-only rollback to 1.7.2 is unsafe after new NULL issuer accounts exist. Preserving legacy values is not rollback qualification. Recovery requires a separately reviewed coordinated database/application plan, with the verified backup restored only when approved and accounting for writes made after backup. Never invent issuer values or silently discard accounts to make rollback pass.

This source change does not authorize or apply any production migration and does not qualify the separate managed-worker rollout.

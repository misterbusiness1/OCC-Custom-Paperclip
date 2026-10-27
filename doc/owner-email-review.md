# Owner email review link

The approval page can link approved email cards to a separate owner service.
The link provides navigation only. Paperclip approval status does not grant email
send authority. The owner service must re-read the card and require a verified
owner passkey for the exact recipients and message.

Set these build-time UI variables together:

- `VITE_OWNER_EMAIL_ORIGIN`: the HTTPS origin of the protected owner service.
- `VITE_OWNER_EMAIL_COMPANY_ID`: the one company served by that service.
- `VITE_OWNER_EMAIL_REQUESTER_IDS`: comma-separated served agent UUIDs.

With missing configuration, no link appears. Cards from other companies or
requesters, non-email cards, and undecided cards have no link. Only the approval
UUID is passed to the service; credentials and email content are not in the URL.
The service must enforce these checks independently.

Use a separate hostname for production. Cookies are shared across ports on the
same hostname. Keep owner enrollment, credentials, and the authorization ledger
outside all agent mounts and environments. A link must never point to a service
that accepts ordinary Paperclip approval status as owner authorization.

The companion executor candidate is tracked in
https://github.com/misterbusiness1/occ-gate-b-executor/pull/4 . It remains in draft:
real owner enrollment, production isolation, client protocol rollout, and CI
qualification must finish before enabling production delivery. Do not promote
staging authorization records into production.

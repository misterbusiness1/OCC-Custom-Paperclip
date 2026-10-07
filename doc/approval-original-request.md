# Approval original-request snapshots

Board approval payloads may include an `originalRequest` object so the decision surface can show the source request separately from the recommendation, rationale, and proposed outbound draft.

```json
{
  "originalRequest": {
    "text": "Exact source wording, including\nline breaks.",
    "source": {
      "kind": "external",
      "channel": "email",
      "sender": "Known sender, when available",
      "sentAt": "2026-10-03T12:00:00.000Z",
      "reference": "provider message or thread reference",
      "snapshotOrigin": "requester"
    }
  }
}
```

`text` is an immutable plain-text snapshot. UI clients render it as escaped text, never Markdown or HTML. They must not derive it from `summary`, `reasoning`, `recommendedAction`, an issue description, or an outgoing email `body`.

For an existing Paperclip issue comment, set `source.kind` to `paperclip_comment` and provide its real `commentId`. The approval create/resubmit route retrieves the non-deleted comment inside the approval company and replaces the text and provenance with a server snapshot (`snapshotOrigin: "server"`). A missing or cross-company comment is rejected. For external sources, the requester supplies the exact retrieved text and any actually known provenance; Paperclip labels the snapshot requester-provided and does not claim independent verification.

Resubmitting decision fields without an `originalRequest` preserves the prior snapshot. Supplying a new `originalRequest` is an explicit source change and is recorded in approval activity. Existing approvals are not backfilled; absent snapshots render a clear missing-source state.

Approval detail, shared approval cards, and both inbox presentations place the original request between Recommendation and Why. Inbox decisions follow the shared decision summary. Compact summaries show the first lines of a long request and let the reader expand it; the retained text is never shortened. The provenance line names the channel of an external source and links a Paperclip source back to its comment.

`originalRequest` is optional, so an approval can have no source: an older record, or a request the agent raised by itself. The interface does not guess which. The card and the inbox row add "No original request attached" to their header line and show no empty source section. The approval detail page keeps the **Original request** section and states that no original request was attached. A request that also has no pros and no risks says so once in a single line instead of empty fields.

## Decision surfaces

The shared decision summary also shows what the board is about to approve:

- An email-reply approval (an outgoing `body` with `subject`, `recipient`, or `channel`) shows the draft under a **Draft reply** label, after the decision brief and before the decision buttons. The draft is never used as the original request.
- Long recommendation and rationale text, and pros and risks beyond the first two, expand in place.
- `nextActionOnApproval` appears as **If approved**.

Hire and strategy approvals carry no recommendation, pros, or risks, so they have their own summary on the card, in the inbox row, and on the detail page:

- A `hire_agent` approval shows the role, job title, manager, adapter and model, monthly budget, the described work, and the skills. It states what each decision does: approval activates the pending agent (or creates it when none exists) and sets the monthly budget when one is given; rejection terminates a pending agent. Only the model name is read from the adapter configuration.
- An `approve_ceo_strategy` approval shows the plan under a **Plan** label with its line breaks, numbering, and bullets. A long plan shows its first lines and expands in place; the detail page shows it in full.

The approval card, the approval detail page, and Board, hire, and strategy approvals in both inbox presentations use the same decision buttons:

- **Approve** sends at once. **Add a note** attaches an optional `decisionNote`.
- **Request changes** is available while the approval is `pending` and requires a `decisionNote`, so the requester knows what to revise.
- **Reject** asks for confirmation and accepts an optional reason as the `decisionNote`.

Board approvals decided on the Approvals page or in the inbox are decided in place. The Approvals page lists the longest-waiting request first, marks requests that have waited seven days or more, shows linked tasks on each card, and filters by kind. With keyboard shortcuts enabled, `J`/`K` move between cards, and `Shift+A`, `Shift+C`, and `Shift+X` approve, request changes, and reject for the focused card.

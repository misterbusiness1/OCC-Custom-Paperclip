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

Approval detail, shared approval cards, and both inbox presentations place the original request between Recommendation and Why. Inbox decisions follow the shared decision summary, including the missing-source state for historical approvals. Compact summaries let the reader expand long requests without shortening their retained text.

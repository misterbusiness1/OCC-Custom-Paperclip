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

Approval detail, shared approval cards, and both inbox presentations place the original request between Recommendation and Why. Inbox decisions follow the shared decision summary. Compact summaries (the card and the inbox row) show the first lines of a long request, more than 480 characters or more than 16 lines, behind a **Show full request (N characters)** button; the retained text is never shortened. The approval detail page shows the whole request. No surface puts the request, or the proposed reply, in a box with its own scrollbar: the text is either shown whole or behind that announced preview. The provenance line names the channel of an external source and links a Paperclip source back to its comment.

`originalRequest` is optional, so an approval can have no source: an older record, or a request the agent raised by itself. The interface does not guess which. The card and the inbox row add "No original request attached" to their header line and show no empty source section. The approval detail page keeps the **Original request** section and states that no original request was attached. A request that also has no pros and no risks says so once in a single line instead of empty fields.

## Decision surfaces

One shared decision summary is used by the approval card, both inbox presentations, and the approval detail page. It shows what the board is about to approve:

- An email-reply approval (an outgoing `body` with `subject`, `recipient`, or `channel`) shows the draft under a **Draft reply** label, after the decision brief and before the decision buttons. The draft is never used as the original request.
- The draft body is shown whole when it is at most 1,500 characters (blank space at its end is not counted). A longer body is shown whole on the approval detail page. The card and the inbox row show about its first 1,500 characters, cut at a line or word boundary and ending in `…`, with a **Show full reply (N characters)** button. The body is never clamped to a number of lines.
- `nextActionOnApproval` appears as **If approved**.
- Each pro and each risk sits beside one bullet. One leading list marker of its own (`- `, `* `, `• `, `1. `, `1) `) is dropped, so a numbered risk does not show a bullet and a number. An item that is itself a list of several lines keeps its markers.

The summary has two modes:

- **Compact** (card and inbox row). Recommendation, rationale, and next action show their first lines (about three lines, or 180 characters for the recommendation and 220 for the others) with **Show more**. Line breaks are kept, also when nothing is hidden. Pros and risks beyond the first two, a draft of more than 1,500 characters, and a long original request expand in place.
- **Full** (approval detail page). Nothing is shortened and nothing needs expanding: the whole recommendation, rationale, next action, every pro and risk, the whole draft, and the whole original request are shown above the decision buttons. A Board approval states **Not supplied.** for a recommendation or rationale its request leaves empty; empty pros and risks are stated as on the card. The page heading carries the whole title.

The detail page uses the full summary for Board, hire, and strategy approvals. A budget override, which is resolved in Costs and has no decision buttons here, shows its scope, window, metric, limit, observed amount, and guidance instead. **Full request** below the decision buttons repeats the request with its technical fields; nothing in it is height-capped either, apart from the raw payload.

Hire and strategy approvals carry no recommendation, pros, or risks, so they have their own summary on the card, in the inbox row, and on the detail page:

- A `hire_agent` approval is headed by the agent's name. It shows the role, job title, manager, adapter and model, monthly budget, the described work, and the skills. A manager is shown by name, never by id. While the decision is open, it states what each decision does: approval activates the agent the request names (or creates one when it names none) and sets the monthly budget when one is given; rejection terminates the named agent. If the request names an existing agent other than the one being hired, the summary says so instead. Only the model name is read from the adapter configuration.
- An `approve_ceo_strategy` approval shows the plan under a **Plan** label with its line breaks, numbering, bullets, and indentation. A long plan shows its first lines and expands in place; the detail page shows it in full. A recommendation, pros, risks, and next action are shown when the request carries them. A request with no plan field shows its rationale as the plan.

On the detail page a hire also lists every skill.

Agent-written text on these summaries is shown as plain text, never rendered as Markdown. Only markup is removed: heading marks, `**bold**` pairs, backtick pairs, rule lines, and link syntax (a link becomes `label (target)`; an image becomes its alternative text). A `-` or `*` list marker is shown as a bullet. Everything else is kept as written: underscores, tildes, single asterisks, a leading `>` or `+`, identifiers, paths, line breaks, numbering, and bullets. One-line titles and subjects use the same conversion with line breaks folded into spaces, cut at a word boundary where a surface has a length limit.

**Request changes** is offered only when the approval has a requesting agent to receive it.

The approval card, the approval detail page, and Board, hire, and strategy approvals in both inbox presentations use the same decision buttons:

- **Approve** sends at once, with one exception: an outgoing email is never approved while part of it is cut. On the card and in the inbox row, while a long draft is cut, the first **Approve** (a click or `Shift+A`) sends nothing. It opens the whole draft, moves keyboard focus to the draft, scrolls it into view, and shows **Read the full reply, then approve.** beside the buttons. The next **Approve** sends. When the board has already opened the draft with **Show full reply**, **Approve** sends at once; cutting the draft again with **Show less** holds **Approve** back again. In short, **Approve** sends only while the whole draft is on the page. The detail page always shows the whole draft, so **Approve** sends at once there.
- **Add a note** attaches an optional `decisionNote`. A note typed before **Approve** was held back is kept and sent with the decision.
- **Request changes** is available while the approval is `pending` and requires a `decisionNote`, so the requester knows what to revise.
- **Reject** asks for confirmation and accepts an optional reason as the `decisionNote`.
- **Request changes** and **Reject** are never held back by a cut draft.

Board approvals decided on the Approvals page or in the inbox are decided in place. The Approvals page lists the longest-waiting request first, marks requests that have waited seven days or more, shows linked tasks on each card, and filters by kind. With keyboard shortcuts enabled, `J`/`K` move between cards, and `Shift+A`, `Shift+C`, and `Shift+X` approve, request changes, and reject for the focused card.

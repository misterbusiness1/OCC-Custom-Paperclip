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

The note, change-request, and reject panels work from the keyboard:

- Opening a panel puts the cursor in its field. `Escape` or **Cancel** closes the panel, discards what was typed, and returns focus to the button that opened it.
- `Ctrl+Enter` or `Cmd+Enter` in the field sends the open confirmation: the change request (only when a note is written) or the rejection. There is no such key for **Approve**.
- The panel is a group named by its prompt. **Reject this request?** is also read out with the reason field.

Feedback for a decision stays with the request it belongs to:

- While a decision is being sent, only that request's buttons are disabled. The pressed button shows its busy label (**Approving...**, **Sending...**, **Rejecting...**) and the control is marked busy for assistive technology. Other cards and inbox rows stay usable, and a second decision for a request that is still sending is not sent.
- A decision that comes back as an error is reported on that request, directly above its buttons, as an alert: **Error while approving: _message_** (or **rejecting**, **requesting changes**). The typed note is kept. The error is removed when the board edits the note or sends the decision again. An inbox row with the plain **Approve** / **Reject** buttons shows the same line under them.
- The error does not say the request is still undecided. The server stores a decision before it runs what follows from it (activating a hire, writing the activity log, waking the requester), so an error can come back for a decision that was stored. The Approvals page and the detail page therefore reload after an error and show the status the server holds; the request stays listed with its error even when it can no longer be decided. The inbox does not reload on an error.
- The Approvals page has one visually hidden live region that announces each outcome: **Approved: _title_**, **Rejected: _title_**, **Changes requested: _title_**, or **Error while approving _title_: _message_**.
- The line at the top of the Approvals page is only for a failure to load the list. The line at the top of the inbox is for failures that do not belong to an approval row (join requests, archiving). On the detail page, a comment or delete failure is shown beside its own button.
- Approval cards on a task page still report a failed decision as a toast.

Board approvals decided on the Approvals page or in the inbox are decided in place. The Approvals page lists the longest-waiting request first, marks requests that have waited seven days or more, shows linked tasks on each card, and filters by kind. With keyboard shortcuts enabled, `J`/`K` move between cards, and `Shift+A`, `Shift+C`, and `Shift+X` approve, request changes, and reject for the focused card.

### Requests sent back for changes

**Request changes** sets the approval to `revision_requested` and stores the board's note as its `decisionNote`. The requester has the request from then on: it returns to `pending` only when it is resubmitted, and a resubmission may replace the payload and clears the note. The server still accepts **Approve** and **Reject** for a `revision_requested` approval, so the interface decides where those are offered:

- **To decide** on the Approvals page lists only `pending` approvals, and its badge counts only those. A request decided or sent back during the visit keeps its place as a compact row, as before. When a request sent back during the visit is resubmitted, its card returns in the same place.
- Below the queue, **Waiting on the requester (N)** lists the other `revision_requested` approvals. The section is folded away until its button is pressed, and it is not shown when there are none. Each row shows the status, the subject, **Sent back _time ago_** (from `decidedAt`, or from `updatedAt` when no decision time is recorded), the note under **Changes you asked for**, and **View details**. The rows carry no decision buttons, are not part of `J`/`K`, and are not affected by the kind filter or the sort. They are listed longest-waiting first.
- The approval card (Approvals page, task page, **All decisions**) and the inbox row, in both inbox presentations, offer no decision for a `revision_requested` approval: no buttons, no note field, and no `Shift+A`, `Shift+C`, or `Shift+X`. In their place stands **Waiting on _requester name_ to revise** (**Waiting on the requester to revise** when the name is not known), **Sent back _time ago_**, and the note under **Changes you asked for**. The card does not show a **Waiting N days** clock for it. **View details** stays.
- The approval detail page keeps **Approve** and **Reject** for a `revision_requested` approval, and labels the note **Changes you asked for**. It is the one place where the version the board asked to change can still be decided, with the whole request on the page.
- The inbox still lists `revision_requested` approvals and counts them in its badge.

A closed approval says when it was closed: the card shows **Approved _time ago_**, **Rejected _time ago_**, or **Cancelled _time ago_** from `decidedAt`, in place of **Created _time ago_**. Without a `decidedAt` it shows the creation time. Who decided is not shown; the record holds only a user id.

### Requests that change while open

The server does not check which version of a request the board read. The interface therefore watches for a revision arriving under the reader:

- The card, the inbox row in both presentations, and the detail page remember the `updatedAt` and payload first shown for an approval. If the same approval arrives later while it is `pending`, with a newer `updatedAt` and a payload that is not the same (compared by value; key order does not count), it was revised while open. A newer `updatedAt` with the same payload raises nothing, and neither does a decision, which changes the status.
- A notice then appears above the summary: **The requester revised this request while it was open. Review it before you decide.** with the button **I have reviewed it**. The new content is already on the page. Sections the reader had expanded stay as they are, and a note being typed is kept.
- Until that button is pressed, **Approve** (a click or `Shift+A`) sends nothing. It moves focus to the notice and shows **Confirm that you have reviewed the revised request, then approve.** beside the buttons. **Reject** and **Request changes** are not held back. An inbox row with the plain **Approve** / **Reject** buttons is held back the same way.
- Pressing **I have reviewed it** makes the version on the page the remembered one and leaves a quiet line saying the request was revised and marked as reviewed. A later revision raises the notice again.
- This check comes before the check on a cut draft: the first **Approve** after a revision is held back for the revision only, and once it is confirmed a cut draft is still opened before anything is sent.
- The check is made in the browser, per open card, row, or page. A request that leaves the screen and comes back, for example one sent back and resubmitted while its card was replaced by the compact row, is shown as a new card without the notice.

The detail page follows live updates: an approval event reloads that approval, its discussion, and its linked tasks as well as the list, so a resubmission, another member's decision, or a new comment appears without a reload of the page.

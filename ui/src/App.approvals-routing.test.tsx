// @vitest-environment jsdom

// Regression guard for OXFA-31188: a bare `/approvals` or `/approvals/:id`
// deep link (e.g. from a notification or bookmark) had no unprefixed
// redirect route registered in App.tsx. Without one, the router fell through
// to the `:companyPrefix` route and treated "approvals" itself as an
// (invalid) company prefix, rendering the 404 page instead of the approvals
// queue. This drives the real <App> route table so removing the redirect
// registration fails loudly, the same way App.activity-routing.test.tsx does
// for the analogous `/audit` regression.

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// jsdom's CSS parser rejects the custom-property marker rule stitches inserts
// (`--sxs{--sxs:N}`), pulled into <App>'s eager import graph transitively via
// @codesandbox/sandpack-react. Substitute a benign, valid rule on parse failure
// so stitches' index bookkeeping stays intact and the module graph evaluates.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __papApprovalsRoutingPatched?: boolean;
  };
  if (!sheetProto.__papApprovalsRoutingPatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".oxfa31188-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__papApprovalsRoutingPatched = true;
  }
});

// Real Layout renders the full authenticated shell (sidebar, data queries) and
// owns the "No company matches prefix" NotFound. For routing we only need it to
// resolve the :companyPrefix segment and render its nested routes.
vi.mock("./components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { Layout: () => <Outlet /> };
});

// Rendered by <App> outside <Routes> and needs DialogProvider; irrelevant here.
vi.mock("./components/OnboardingWizardVariant", () => ({
  OnboardingWizardVariant: () => null,
}));

// Cloud access is unrelated to the route-table regression. Let it fall through
// synchronously so this test does not poll its query transitions.
vi.mock("./components/CloudAccessGate", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CloudAccessGate: () => <Outlet /> };
});

vi.mock("./pages/Approvals", () => ({
  Approvals: () => {
    const location = useLocation();
    return <div>{`APPROVALS_PAGE@${location.pathname}${location.search}`}</div>;
  },
}));

vi.mock("./pages/ApprovalDetail", () => ({
  ApprovalDetail: () => {
    const { approvalId } = useParams<{ approvalId: string }>();
    return <div>{`APPROVAL_DETAIL_PAGE@${approvalId}`}</div>;
  },
}));

const PAP_COMPANY = {
  id: "company-1",
  name: "Paperclip",
  issuePrefix: "PAP",
  status: "active",
};

let companyState = {
  companies: [PAP_COMPANY] as Array<typeof PAP_COMPANY>,
  selected: PAP_COMPANY as typeof PAP_COMPANY | null,
};
vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: companyState.companies,
    selectedCompanyId: companyState.selected?.id ?? null,
    selectedCompany: companyState.selected,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function renderAppAt(container: HTMLElement, path: string) {
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  return root;
}

async function waitForRoute(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  expect(container.textContent).toContain(text);
}

describe("App Approvals routing (OXFA-31188)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    companyState = { companies: [PAP_COMPANY], selected: PAP_COMPANY };
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("serves the Approvals queue at /:company/approvals/pending", async () => {
    const root = renderAppAt(container, "/PAP/approvals/pending");
    await waitForRoute(container, "APPROVALS_PAGE@/PAP/approvals/pending");
    expect(container.textContent).not.toContain("No company matches prefix");
    flushSync(() => root.unmount());
  });

  // The queue page is served on the short address too and corrects the address itself (it is
  // mocked here, so the address stays as it is). A redirect route in its place would unmount the
  // queue when a link to /approvals is followed from it: see App.approvals-queue-mounted.test.tsx,
  // which drives the real page and checks the corrected address.
  it("redirects the bare /approvals deep link through to the prefixed queue page", async () => {
    const root = renderAppAt(container, "/approvals");
    await waitForRoute(container, "APPROVALS_PAGE@/PAP/approvals");
    expect(container.textContent).not.toContain("APPROVAL_DETAIL_PAGE");
    expect(container.textContent).not.toContain("No company matches prefix");
    flushSync(() => root.unmount());
  });

  it("serves the Approvals queue at /:company/approvals, with whatever follows the path", async () => {
    const root = renderAppAt(container, "/PAP/approvals?from=mail");
    await waitForRoute(container, "APPROVALS_PAGE@/PAP/approvals?from=mail");
    expect(container.textContent).not.toContain("No company matches prefix");
    flushSync(() => root.unmount());
  });

  it("redirects the bare /approvals/all deep link through to the prefixed page", async () => {
    const root = renderAppAt(container, "/approvals/all");
    await waitForRoute(container, "APPROVALS_PAGE@/PAP/approvals/all");
    expect(container.textContent).not.toContain("No company matches prefix");
    flushSync(() => root.unmount());
  });

  it("redirects a bare /approvals/:approvalId deep link to the prefixed detail page", async () => {
    const root = renderAppAt(container, "/approvals/approval-123");
    await waitForRoute(container, "APPROVAL_DETAIL_PAGE@approval-123");
    expect(container.textContent).not.toContain("No company matches prefix");
    flushSync(() => root.unmount());
  });
});

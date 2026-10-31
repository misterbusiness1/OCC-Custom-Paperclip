// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPROVAL_DRAFT_UNREAD_APPROVE_LABEL,
  ApprovalDecisionSummary,
  useApprovalDraftGate,
} from "./ApprovalDecisionSummary";
import {
  ApprovalPayloadRenderer,
  OriginalRequestBlock,
  approvalDraftTranslation,
  approvalOriginalRequestTranslation,
  approvalTranslation,
  isMostlyNonLatinScript,
} from "./ApprovalPayload";
import { ThemeProvider } from "../context/ThemeContext";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Synthetic text only.
const CHINESE_EMAIL = "您好，\n我想询问批发价格和最低起订量。\n请问可以寄样品到上海吗？\n谢谢！";
const CHINESE_EMAIL_EN = "Hello,\nI would like to ask about wholesale prices and the minimum order.\nCan you send samples to Shanghai?\nThank you!";
const CHINESE_DRAFT = "您好，\n感谢您的来信。我们的批发价目表已附上。\n样品可以寄到上海。";
const CHINESE_DRAFT_EN = "Hello,\nThank you for your message. Our wholesale price list is attached.\nSamples can be sent to Shanghai.";
const RUSSIAN_DRAFT = "Здравствуйте! Спасибо за ваше письмо. Мы отправим образцы на следующей неделе.";
const SPANISH_TEXT = "Hola, quisiera saber el precio al por mayor y el pedido mínimo. ¿Pueden enviar muestras a Madrid? Gracias.";

function emailPayload(overrides: Record<string, unknown> = {}, originalOverrides: Record<string, unknown> = {}) {
  return {
    recommendedAction: "Send the reply.",
    pros: ["Answers the buyer"],
    risks: ["Price list may change"],
    channel: "email from info@",
    recipient: "buyer@example.test",
    subject: "Re: 批发询价",
    body: CHINESE_DRAFT,
    bodyTranslation: { language: "Chinese (Simplified)", text: CHINESE_DRAFT_EN },
    originalRequest: {
      text: CHINESE_EMAIL,
      source: { kind: "external", channel: "email", sender: "buyer@example.test", snapshotOrigin: "requester" },
      translation: { language: "Chinese (Simplified)", text: CHINESE_EMAIL_EN },
      ...originalOverrides,
    },
    ...overrides,
  };
}

describe("approvalTranslation", () => {
  it("reads an object with its language, or a plain string with no language", () => {
    expect(approvalTranslation({ language: " Chinese (Simplified) ", text: "Hello\n  there " })).toEqual({
      language: "Chinese (Simplified)",
      text: "Hello\n  there ",
    });
    expect(approvalTranslation("Hello")).toEqual({ language: null, text: "Hello" });
    expect(approvalTranslation({ text: "Hello", language: 7 })).toEqual({ language: null, text: "Hello" });
  });

  it("ignores empty, white-space and non-string text", () => {
    for (const value of ["", "   \n ", { text: "" }, { text: "  " }, { text: 42 }, { language: "German" }, ["Hello"], null, 0]) {
      expect(approvalTranslation(value)).toBeNull();
    }
  });

  it("reads the received email's translation and the draft's from their own fields only", () => {
    const payload = emailPayload();
    expect(approvalOriginalRequestTranslation(payload)?.text).toBe(CHINESE_EMAIL_EN);
    expect(approvalDraftTranslation(payload)?.text).toBe(CHINESE_DRAFT_EN);
    expect(approvalOriginalRequestTranslation({ translation: "Hello" })).toBeNull();
    expect(approvalDraftTranslation({ originalRequest: { translation: "Hello" } })).toBeNull();
    expect(approvalDraftTranslation({ bodyTranslation: "The draft in English." })).toEqual({
      language: null,
      text: "The draft in English.",
    });
  });
});

describe("isMostlyNonLatinScript", () => {
  it.each([
    ["Chinese", CHINESE_EMAIL],
    ["Japanese kana and kanji", "お問い合わせありがとうございます。サンプルを送ります。"],
    ["Korean", "안녕하세요. 도매 가격을 알고 싶습니다."],
    ["Russian", RUSSIAN_DRAFT],
    ["Arabic", "مرحبا، أود معرفة سعر الجملة والحد الأدنى للطلب."],
    ["Hebrew", "שלום, אני רוצה לדעת את מחיר הסיטונאי."],
    ["Thai", "สวัสดีครับ ผมอยากทราบราคาขายส่ง"],
    ["Hindi", "नमस्ते, मैं थोक मूल्य जानना चाहता हूँ।"],
    ["Chinese with an English signature, a link and an address", `${CHINESE_EMAIL}\n--\nJohn Li\nhttps://shop.example.test/orders/123?ref=abc\njohn.li@shop.example.test`],
    ["Chinese running on into an address with no space", "我的邮箱是buyer@example.test请尽快回复我谢谢"],
  ])("flags %s", (_name, text) => {
    expect(isMostlyNonLatinScript(text)).toBe(true);
  });

  it.each([
    ["English", "Hello, I would like to know your wholesale price and minimum order. Thanks!"],
    ["Spanish", SPANISH_TEXT],
    ["German", "Guten Tag, ich möchte den Großhandelspreis wissen. Danke schön."],
    ["English that names a Chinese city", "Please ship the samples to 上海 by Friday. Thanks a lot for the quick help."],
    ["a short greeting", "你好"],
    ["digits and punctuation", "12345 678 — 9/10 !!! ???"],
    ["an empty text", ""],
    ["links and addresses", "https://shop.example.test/orders/12 info@example.test 1234"],
  ])("does not flag %s", (_name, text) => {
    expect(isMostlyNonLatinScript(text)).toBe(false);
  });
});

describe("translations on email approval cards", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // The Full request view renders pros and risks as Markdown, which reads the theme.
  const renderFullRequest = (payload: Record<string, unknown>) =>
    act(() =>
      root.render(
        <ThemeProvider>
          <ApprovalPayloadRenderer type="request_board_approval" payload={payload} />
        </ThemeProvider>,
      ),
    );

  const button = (scope: ParentNode, label: string) =>
    Array.from(scope.querySelectorAll("button")).find((element) => element.textContent === label);
  const originalTranslation = () => container.querySelector<HTMLElement>("[data-approval-translation='original']");
  const draftTranslation = () => container.querySelector<HTMLElement>("[data-approval-translation='draft']");
  const missing = (of: "original" | "draft") => container.querySelector(`[data-approval-translation-missing='${of}']`);

  it("shows both translations on the queue card: under the original email and under the draft, with the draft's language", () => {
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={emailPayload()} />));
    const original = container.querySelector<HTMLElement>("[data-approval-original-request='email']")!;
    const translated = originalTranslation()!;
    expect(original.contains(translated)).toBe(true);
    expect(translated.textContent).toContain("English translation · from Chinese (Simplified)");
    expect(translated.textContent).toContain("Translated by the requesting agent. Check it against the original before approving.");
    expect(translated.querySelector("pre")!.textContent).toBe(CHINESE_EMAIL_EN);
    // The same six-line preview as the email it translates.
    expect(translated.querySelector("pre")!.className).toMatch(/line-clamp-6/);
    expect(original.querySelector("pre")!.textContent).toBe(CHINESE_EMAIL);

    const draft = container.querySelector<HTMLElement>("[data-approval-draft]")!;
    const draftTranslated = draftTranslation()!;
    expect(draft.contains(draftTranslated)).toBe(true);
    expect(draftTranslated.textContent).toContain("English translation of the draft · written in Chinese (Simplified)");
    expect(draftTranslated.querySelector("[data-approval-draft-translation-body]")!.textContent).toBe(CHINESE_DRAFT_EN);
    // The draft's own body box holds the draft only.
    expect(draft.querySelector("[data-approval-draft-body]")!.textContent).toBe(CHINESE_DRAFT);
    const chip = draft.querySelector("[data-approval-draft-language]")!;
    expect(chip.textContent).toBe("Written in Chinese (Simplified)");
    // The group keeps its plain name; the chip sits beside the label, not in it.
    const labelId = draft.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelId)!.textContent).toBe("Draft reply");

    const text = container.textContent ?? "";
    expect(text.indexOf(CHINESE_EMAIL)).toBeLessThan(text.indexOf(CHINESE_EMAIL_EN));
    expect(text.indexOf(CHINESE_EMAIL_EN)).toBeLessThan(text.indexOf("Draft reply"));
    expect(text.indexOf(CHINESE_DRAFT)).toBeLessThan(text.indexOf(CHINESE_DRAFT_EN));
    expect(missing("original")).toBeNull();
    expect(missing("draft")).toBeNull();
  });

  it("previews a long translation of the email behind its own Show more, and starts collapsed again when it is revised", () => {
    const long = Array.from({ length: 12 }, (_, index) => `Translated line ${index + 1}.`).join("\n");
    const payload = emailPayload({}, { translation: { language: "Chinese (Simplified)", text: long } });
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={payload} />));
    const more = button(originalTranslation()!, "Show more")!;
    expect(more).toBeDefined();
    expect(more.getAttribute("aria-label")).toBe("Show more: English translation of the original email");
    expect(more.className).toMatch(/min-h-11/);
    act(() => more.click());
    expect(originalTranslation()!.querySelector("pre")!.className).not.toMatch(/line-clamp/);
    expect(button(originalTranslation()!, "Show less")).toBeDefined();

    const revised = emailPayload({}, { translation: { language: "Chinese (Simplified)", text: `${long}\nRevised.` } });
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={revised} />));
    expect(originalTranslation()!.querySelector("pre")!.className).toMatch(/line-clamp-6/);
    expect(button(originalTranslation()!, "Show more")).toBeDefined();
  });

  it("cuts a long translation of the draft like the draft, and Approve opens it before it may send", () => {
    const longTranslation = `${"Our wholesale price list is attached. ".repeat(60)}Last translated line.`;
    expect(longTranslation.length).toBeGreaterThan(1500);
    const payload = emailPayload({ bodyTranslation: { language: "Chinese (Simplified)", text: longTranslation } });
    const gateRef: { current: ReturnType<typeof useApprovalDraftGate> | null } = { current: null };
    function Harness() {
      const gate = useApprovalDraftGate("request_board_approval", payload);
      gateRef.current = gate;
      return <ApprovalDecisionSummary type="request_board_approval" payload={payload} draftControl={gate.draftControl} />;
    }
    const gate = () => gateRef.current!;
    act(() => root.render(<Harness />));
    const body = () => draftTranslation()!.querySelector("[data-approval-draft-translation-body]")!.textContent ?? "";
    expect(body()).not.toContain("Last translated line.");
    expect(draftTranslation()!.querySelector("[data-approval-draft-translation-continues]")).not.toBeNull();
    // The short draft itself is whole; the control names what is cut.
    expect(container.querySelector("[data-approval-draft-continues]")).toBeNull();
    const draft = container.querySelector<HTMLElement>("[data-approval-draft]")!;
    expect(button(draft, `Show full translation (${longTranslation.length.toLocaleString()} characters)`)).toBeDefined();
    expect(gate().approveLabel).toBe(APPROVAL_DRAFT_UNREAD_APPROVE_LABEL);
    let held: string | null = null;
    act(() => {
      held = gate().approveGuard();
    });
    expect(held).not.toBeNull();
    expect(body()).toBe(longTranslation);
    expect(gate().approveLabel).toBeUndefined();
    expect(button(draft, "Show less")).toBeDefined();
  });

  it("shows both translations whole on the request page, in the summary and in Full request", () => {
    const long = Array.from({ length: 12 }, (_, index) => `Translated line ${index + 1}.`).join("\n");
    const longDraft = `${"Our wholesale price list is attached. ".repeat(60)}Last translated line.`;
    const payload = emailPayload(
      { bodyTranslation: { language: "Chinese (Simplified)", text: longDraft } },
      { translation: { language: "Chinese (Simplified)", text: long } },
    );
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={payload} full />));
    expect(originalTranslation()!.querySelector("pre")!.className).not.toMatch(/line-clamp/);
    expect(originalTranslation()!.querySelector("pre")!.textContent).toBe(long);
    expect(draftTranslation()!.querySelector("[data-approval-draft-translation-body]")!.textContent).toBe(longDraft);
    expect(container.querySelector("button")).toBeNull();

    renderFullRequest(payload);
    expect(originalTranslation()!.textContent).toContain("English translation · from Chinese (Simplified)");
    expect(originalTranslation()!.querySelector("pre")!.textContent).toBe(long);
    expect(originalTranslation()!.querySelector("pre")!.className).not.toMatch(/line-clamp/);
    expect(draftTranslation()!.textContent).toContain("English translation of the draft · written in Chinese (Simplified)");
    expect(draftTranslation()!.querySelector("pre")!.textContent).toBe(longDraft);
    expect(container.querySelector("[data-approval-draft-language]")!.textContent).toBe("Written in Chinese (Simplified)");
    expect(container.querySelector("button")).toBeNull();
    const text = container.textContent ?? "";
    expect(text.indexOf("Draft reply")).toBeLessThan(text.indexOf(CHINESE_DRAFT));
    expect(text.indexOf(CHINESE_DRAFT)).toBeLessThan(text.indexOf(longDraft));
  });

  it("takes a plain string as a translation with no language: no 'from', no chip", () => {
    const payload = emailPayload({ bodyTranslation: CHINESE_DRAFT_EN }, { translation: CHINESE_EMAIL_EN });
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={payload} />));
    expect(originalTranslation()!.querySelector("p")!.textContent).toBe("English translation");
    expect(originalTranslation()!.querySelector("pre")!.textContent).toBe(CHINESE_EMAIL_EN);
    expect(draftTranslation()!.querySelector("p")!.textContent).toBe("English translation of the draft");
    expect(draftTranslation()!.textContent).toContain(CHINESE_DRAFT_EN);
    expect(container.querySelector("[data-approval-draft-language]")).toBeNull();
    expect(container.textContent).not.toContain("written in");
  });

  it("ignores an empty translation, and warns under each Chinese or Russian text that has none", () => {
    const payload = emailPayload({ body: RUSSIAN_DRAFT, bodyTranslation: "   " }, { translation: { language: "Chinese", text: "\n " } });
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={payload} />));
    expect(originalTranslation()).toBeNull();
    expect(draftTranslation()).toBeNull();
    expect(container.querySelector("[data-approval-draft-language]")).toBeNull();
    const warning = "Not in English and no translation attached. Request a revision to get one.";
    expect(missing("original")?.textContent).toBe(warning);
    expect(missing("draft")?.textContent).toBe(warning);
    // Each warning sits under the text it is about.
    const original = container.querySelector("[data-approval-original-request='email']")!;
    expect(original.contains(missing("original"))).toBe(true);
    expect(container.querySelector("[data-approval-draft]")!.contains(missing("draft"))).toBe(true);

    renderFullRequest(payload);
    expect(missing("original")?.textContent).toBe(warning);
    expect(missing("draft")?.textContent).toBe(warning);
  });

  it("does not warn for English or Spanish, nor when a translation is attached", () => {
    const english = emailPayload(
      { body: "Hello, thanks for your message. The samples ship on Monday.", bodyTranslation: undefined },
      { text: "Hello, can you ship samples to Madrid? Thank you.", translation: undefined },
    );
    const spanish = emailPayload(
      { body: SPANISH_TEXT, bodyTranslation: undefined },
      { text: SPANISH_TEXT, translation: undefined },
    );
    for (const payload of [english, spanish, emailPayload()]) {
      act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={payload} />));
      expect(missing("original")).toBeNull();
      expect(missing("draft")).toBeNull();
      renderFullRequest(payload);
      expect(missing("original")).toBeNull();
      expect(missing("draft")).toBeNull();
    }
  });

  it("shows a translation as literal text, never as HTML", () => {
    const hostile = "<script>alert('x')</script><img src=x onerror=alert(1)><b>bold</b>";
    const payload = emailPayload(
      { bodyTranslation: { language: "<i>Chinese</i>", text: hostile } },
      { translation: { language: "<img src=y onerror=alert(2)>", text: hostile } },
    );
    for (const element of [
      <ApprovalDecisionSummary type="request_board_approval" payload={payload} />,
      <ApprovalDecisionSummary type="request_board_approval" payload={payload} full />,
      <ThemeProvider>
        <ApprovalPayloadRenderer type="request_board_approval" payload={payload} />
      </ThemeProvider>,
    ]) {
      act(() => root.render(element));
      expect(container.querySelector("script, img, b, i")).toBeNull();
      expect(originalTranslation()!.querySelector("pre")!.textContent).toBe(hostile);
      expect(originalTranslation()!.textContent).toContain("from <img src=y onerror=alert(2)>");
      expect(draftTranslation()!.textContent).toContain(hostile);
      expect(container.querySelector("[data-approval-draft-language]")!.textContent).toBe("Written in <i>Chinese</i>");
    }
  });

  it("shows a translation on a Board approval that answers an outside message", () => {
    const payload = {
      recommendedAction: "Approve the refund.",
      originalRequest: {
        text: "Здравствуйте! Прошу вернуть деньги за заказ номер 1234.",
        source: { kind: "external", sender: "buyer@example.test" },
        translation: { language: "Russian", text: "Hello! Please refund order number 1234." },
      },
    };
    act(() => root.render(<OriginalRequestBlock payload={payload} compact />));
    expect(originalTranslation()!.textContent).toContain("English translation · from Russian");
    expect(originalTranslation()!.querySelector("pre")!.textContent).toBe("Hello! Please refund order number 1234.");
    expect(missing("original")).toBeNull();
    act(() => root.render(<OriginalRequestBlock payload={{ ...payload, originalRequest: { ...payload.originalRequest, translation: undefined } }} />));
    expect(originalTranslation()).toBeNull();
    expect(missing("original")).not.toBeNull();
  });
});

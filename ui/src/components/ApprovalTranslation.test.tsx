// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPROVAL_TRANSLATION_UNREAD_APPROVE_LABEL,
  APPROVAL_TRANSLATION_UNREAD_MESSAGE,
  ApprovalDecisionSummary,
  useApprovalDraftGate,
} from "./ApprovalDecisionSummary";
import {
  ApprovalPayloadRenderer,
  OriginalRequestBlock,
  approvalDraftTranslation,
  approvalOriginalRequestTranslation,
  approvalTranslation,
  approvalTranslationFor,
  approvalTranslationLooksShort,
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
const CN_COMPLAINT = "您好，我的订单一直没有收到。\n我要求全额退款。\n否则我会投诉到平台。\n请尽快回复。";
const CN_FIELDS = "问题：订单没有收到\n要求：全额退款\n期限：本周五\n备注：不接受部分退款";
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

  it("ignores empty, white-space, invisible and non-string text", () => {
    for (const value of [
      "",
      "   \n ",
      "\u200b",
      { text: "\u200b \u2060\ufeff\n" },
      { text: "" },
      { text: "  " },
      { text: 42 },
      { language: "German" },
      ["Hello"],
      null,
      0,
    ]) {
      expect(approvalTranslation(value)).toBeNull();
    }
  });

  it("keeps a language only when it names one the interface knows, in English", () => {
    for (const language of [
      "Chinese (Simplified)",
      "Chinese (Traditional, Hong Kong)",
      "Serbo-Croatian",
      "Serbian (Latin)",
      "Portuguese (Brazil)",
      "Simplified Chinese",
      "Cantonese",
      "Filipino",
    ]) {
      expect(approvalTranslation({ text: "Hello", language })?.language).toBe(language);
    }
    // Written in its own language, as a tag or in other cases: shown as the English name.
    for (const [language, name] of [
      ["Русский", "Russian"],
      ["日本語", "Japanese"],
      ["中文", "Chinese"],
      ["zh-CN", "Chinese (China)"],
      ["zh-Hans", "Simplified Chinese"],
      ["ru", "Russian"],
      ["en", "English"],
      ["chinese (simplified)", "Chinese (Simplified)"],
    ]) {
      expect(approvalTranslation({ text: "Hello", language })?.language).toBe(name);
    }
    expect(approvalTranslation({ text: "Hello", language: "  Chinese\n (Simplified) " })?.language).toBe("Chinese (Simplified)");
    // Bidi controls are dropped, not shown reversed.
    expect(approvalTranslation({ text: "Hello", language: "\u202eArabic" })?.language).toBe("Arabic");
    expect(approvalTranslation({ text: "Hello", language: "\u202ecibarA" })?.language).toBeNull();
    // Real places only: no placeholder, pseudo-locale or grouping passes for a region.
    expect(approvalTranslation({ text: "Hello", language: "Chinese (Taiwan)" })?.language).toBe("Chinese (Taiwan)");
    expect(approvalTranslation({ text: "Hello", language: "Albanian (Kosovo)" })?.language).toBe("Albanian (Kosovo)");
    for (const region of ["Unknown Region", "Pseudo-Accents", "Pseudo-Bidi", "United Nations", "European Union", "Eurozone"]) {
      expect(approvalTranslation({ text: "Hello", language: `Chinese (${region})` })?.language).toBeNull();
    }
    for (const language of [
      // Placeholders and claims: never a chip beside "Draft reply".
      "Unknown",
      "None",
      "Same as original",
      "auto-detected",
      "OK to send",
      "Board approved",
      "Verified safe",
      "Verified translation",
      "Approved",
      "Safe to send",
      "Draft reply",
      "Chinese (Board approved)",
      "Chinese (verified, accurate)",
      "Chinese (checked)",
      "no",
      "ok",
      "xx-YY",
      "英语",
      "English — checked by the Board, OK to send",
      "English checked by the Board OK to send",
      "Chinese".padEnd(41, "Z"),
      "Z".repeat(5600),
      "<i>Chinese</i>",
      "Chinese: approved",
      "https://example.test",
      "123",
      "",
    ]) {
      expect(approvalTranslation({ text: "Hello", language })?.language).toBeNull();
    }
  });

  it("drops bidi controls and marks from the translation text", () => {
    expect(approvalTranslation("Hello, thanks. \u202e10% refund\u202c approved.")?.text).toBe("Hello, thanks. 10% refund approved.");
    // An Arabic letter mark before a range shows it reversed ("500-100"); right-to-left and left-to-right marks go too.
    expect(approvalTranslation({ text: "We refund \u061c100-500 USD. \u200fok \u200e!" })?.text).toBe("We refund 100-500 USD. ok !");
  });

  it("drops a Latin-script language named for a text in another script", () => {
    const named = (language: string) => ({ text: "Hello", language });
    expect(approvalTranslationFor(named("English"), CHINESE_DRAFT)?.language).toBeNull();
    // Agents often name the translation's own language there: "English" is dropped without a note.
    expect(approvalTranslationFor(named("English"), CHINESE_DRAFT)?.mismatchedLanguage).toBeUndefined();
    expect(approvalTranslationFor(named("Spanish"), RUSSIAN_DRAFT)).toEqual({
      text: "Hello",
      language: null,
      mismatchedLanguage: "Spanish",
    });
    expect(approvalTranslationFor(named("Chinese"), CHINESE_DRAFT)?.language).toBe("Chinese");
    expect(approvalTranslationFor(named("Spanish"), SPANISH_TEXT)?.language).toBe("Spanish");
    expect(approvalTranslationFor(null, CHINESE_DRAFT)).toBeNull();
  });

  it("drops a language in another script named for a text in Latin letters, and 'English' always", () => {
    const named = (language: string) => ({ text: "Hello", language });
    const english = "Hello, we will ship the samples on Monday. Thanks.";
    expect(approvalTranslationFor(named("Japanese"), english)?.language).toBeNull();
    expect(approvalTranslationFor(named("Chinese (Simplified)"), english)?.language).toBeNull();
    expect(approvalTranslationFor(named("Japanese"), english)?.mismatchedLanguage).toBe("Japanese");
    expect(approvalTranslationFor(named("Chinese (Simplified)"), english)?.mismatchedLanguage).toBe("Chinese (Simplified)");
    for (const language of ["English", "en", "en-US", "en-GB", "British English", "American English", "English (United States)"]) {
      expect(approvalTranslationFor(named(language), english)).toEqual({ text: "Hello", language: null });
      expect(approvalTranslationFor(named(language), SPANISH_TEXT)?.language).toBeNull();
    }
    expect(approvalTranslationFor(named("Serbian (Latin)"), english)?.language).toBe("Serbian (Latin)");
    // Too short to tell: the name stands.
    expect(approvalTranslationFor(named("Chinese"), "好的")?.language).toBe("Chinese");
    // The translation itself is kept: only the claim about its source goes.
    expect(approvalTranslationFor(named("Japanese"), english)?.text).toBe("Hello");
    // A language also written in Latin letters every day says nothing about the script.
    expect(approvalTranslationFor(named("Serbian"), "Zdravo, hvala na porudžbini. Šaljemo uzorke u ponedeljak.")?.language).toBe("Serbian");
    expect(approvalTranslationFor(named("Hindi"), "Namaste, aapka order kal bhej denge. Dhanyavaad.")?.language).toBe("Hindi");
  });

  it("drops a language in another script than the text's, and keeps one that fits", () => {
    const named = (language: string) => ({ text: "Hello", language });
    const japanese = "お問い合わせありがとうございます。サンプルを明日送ります。";
    expect(approvalTranslationFor(named("Korean"), japanese)).toEqual({ text: "Hello", language: null, mismatchedLanguage: "Korean" });
    expect(approvalTranslationFor(named("Chinese"), japanese)?.mismatchedLanguage).toBe("Chinese");
    expect(approvalTranslationFor(named("Chinese"), RUSSIAN_DRAFT)?.mismatchedLanguage).toBe("Chinese");
    expect(approvalTranslationFor(named("Russian"), "مرحبا، أود معرفة سعر الجملة والحد الأدنى للطلب.")?.mismatchedLanguage).toBe("Russian");
    expect(approvalTranslationFor(named("Japanese"), japanese)?.language).toBe("Japanese");
    // Japanese may be written in kanji alone; Chinese in either form.
    expect(approvalTranslationFor(named("Japanese"), "株式会社東京商事営業部長殿")?.language).toBe("Japanese");
    expect(approvalTranslationFor(named("Chinese (Traditional)"), "您好，我想詢問批發價格和最低訂購量。")?.language).toBe("Chinese (Traditional)");
    expect(approvalTranslationFor(named("Korean"), "안녕하세요. 도매 가격을 알고 싶습니다.")?.language).toBe("Korean");
    expect(approvalTranslationFor(named("Ukrainian"), RUSSIAN_DRAFT)?.language).toBe("Ukrainian");
    expect(approvalTranslationFor(named("Serbian (Cyrillic)"), RUSSIAN_DRAFT)?.language).toBe("Serbian (Cyrillic)");
    expect(approvalTranslationFor(named("Serbian (Latin)"), RUSSIAN_DRAFT)?.mismatchedLanguage).toBe("Serbian (Latin)");
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
    [
      "a Chinese reply above a quoted English thread",
      "好的，谢谢。我们下周付款。\n\n> On Mon, Oct 27, info@shop.example wrote:\n> Hello, thank you for your order. The invoice is attached and payment is due within thirty days.",
    ],
    [
      "a Chinese reply above an unquoted 'On … wrote:' thread",
      "您好，我们同意价格，请尽快发货。\n\nOn Tue, Oct 28, 2026 support@example.test wrote:\nHello, thank you for your interest in our wholesale programme. Our price list for this season is attached, and samples can ship within a week.",
    ],
    [
      "a reply above a two-line 'On … wrote:' header",
      "好的，谢谢。请把价格改成每箱一百元，否则我们取消订单。\nOn Tue, Oct 28, 2026 at 10:00 AM Support <\nsupport@example.test> wrote:\nHello, please confirm the price per case for the next order and the delivery date.",
    ],
    ["Chinese that names English products", "我们想订购 Premium Wholesale Starter Kit 和 Deluxe Sample Box，请报价。"],
    [
      "a Russian reply above a quoted English thread",
      "Спасибо, оплатим завтра.\n\n> Hello, please find attached the invoice for your last order and the delivery schedule.",
    ],
    [
      "a Russian reply above an Original Message",
      "Спасибо, оплатим завтра.\n-----Original Message-----\nFrom: Support\nHello, please find attached the invoice for your last order and the delivery schedule.",
    ],
    ["a Chinese email with a Chinese signature", "您好，\n我们同意价格，请尽快发货。\n\n王伟\n上海宏达贸易有限公司"],
    ["a Chinese email with no sentence ends", "您好\n价格可以\n请尽快发货谢谢"],
    // A header or "--" at the very top starts a message pasted whole: what follows is the message.
    ["a received email pasted with its 'On … wrote:' header on top", `On Tue, Oct 28, 2026 buyer@example.test wrote:\n${CHINESE_EMAIL}`],
    ["a forwarded email pasted whole", "-----Original Message-----\n您好，\n我想询问批发价格和最低起订量。\n请问可以寄样品到上海吗？"],
    ["Chinese under a '--' line on top", "--\n您好，我想询问批发价格和最低起订量。请问可以寄样品到上海吗？"],
    ["a text that is all quote", "> Здравствуйте! Спасибо за ваше письмо. Мы отправим образцы на следующей неделе."],
    ["an Outlook header at the top of a forwarded email", "From: Wang Wei\nSent: Tuesday, October 28, 2026 9:00 AM\nTo: Support\nSubject: Wholesale\n\n您好，我想询问批发价格和最低起订量。请问可以寄样品到上海吗？"],
    // Short lines under an English first line are the message, not a signature.
    ["Chinese lines under an English first line", "Dear Mr. Wang, thank you for your order.\n我们已经安排发货\n预计三天内到达\n如有问题请随时联系我们\n李明"],
    ["Russian lines under an English first line", "Order 4521 shipped today.\nЗдравствуйте\nСпасибо за заказ\nМы отправили посылку\nС уважением\nИван"],
    [
      "a Chinese draft after an English first line",
      "Dear Mr. Wang, thank you for your order and for your patience.\n我们会在三天内发货\n请确认收货地址\n如有问题请随时联系我们\n客服团队",
    ],
    [
      "a Russian draft after an English first line",
      "Dear Olga, thank you for your message and your order.\nМы отправим заказ в течение трёх дней\nПожалуйста подтвердите адрес доставки\nС уважением\nКоманда поддержки",
    ],
    ["Chinese under a short English greeting", "Hello Oxford team!\n我们想订购五百盒雪茄\n请报价并告知运费\n如果可以请先寄样品\n谢谢\n王伟"],
    ["Chinese under a one-sentence English line", "Dear Mr. Smith.\n我们同意全额退款\n请提供您的银行卡号和密码\n三天内处理"],
    ["Russian under a short English line", "Hi, thanks for your email.\nМы согласны на возврат денег\nПришлите номер карты и пароль\nСпасибо"],
    ["Chinese under a blank line and an English greeting", "Dear Mr. Wang, thank you.\n\n我们已经安排发货\n预计三天内到达\n如有问题请随时联系我们\n李明"],
    [
      "a Chinese reply above an Outlook-quoted English thread",
      "您好，我们同意价格，请尽快发货。\n________________________________\nFrom: Support <support@example.test>\nSent: Tuesday, October 28, 2026 9:00 AM\nTo: Buyer <buyer@example.test>\nSubject: Re: wholesale\n\nHello, thank you for your interest in our wholesale programme. Our price list for this season is attached, and samples can ship within a week.",
    ],
    [
      "a Chinese reply above a From:/Sent: thread with no rule",
      "好的，谢谢。我们下周付款。\nFrom: Support\nSent: Monday\nHello, please find attached the invoice for your last order and the delivery schedule for the next shipment.",
    ],
    [
      "a Chinese reply above a Gmail (zh-CN) header",
      "您好，我们同意价格，请尽快发货。\nSupport <support@example.test> 于2026年10月28日周二 09:00写道：\nHello, thank you for your interest in our wholesale programme. Our price list for this season is attached.",
    ],
    ["Chinese after a long English start", `${"a ".repeat(10_001)}${"我们同意全额退款并赔偿五百美元。".repeat(200)}`],
    // Chinese order details in field lines and short lines under one English sentence (a Chinese character counts
    // as a short word everywhere, so the Chinese part is never weighed as the smaller one).
    ["Chinese field lines under an English line", "Please quote for the following items.\n品名：不锈钢螺丝\n数量：五千个\n交货：下个月\n付款：月结三十天"],
    ["Chinese short lines under an English line and a blank line", "Hi, please see my question below and reply soon.\n\n请问这个产品还有货吗\n需要一百个\n价格多少"],
    ["a Chinese order under an English greeting", "Hello, I want to order cigars for my shop now.\n\n我们需要五百盒雪茄\n请报价并告知运费\n请先寄样品"],
    [
      "Chinese demands under a long English sentence",
      "Hello, I am writing about my order 12345, which has not arrived yet; I would like an update please.\n\n我要求全额退款\n否则我会投诉到平台\n本周五是最后期限\n请尽快回复我们\n不接受部分退款",
    ],
    ["Chinese 'label: value' lines under an English line", `Customer complaint, details below.\n${CN_FIELDS}`],
    // A short reply in Chinese is a whole sentence that will be sent: its characters count as words.
    ["a short Chinese reply", "可以，明天发货。"],
    // A forwarded or quoted email in another script under a short English note: the whole text is read too.
    [
      "a Chinese email forwarded (Gmail) under a short English note",
      `Please see below.\n\n---------- Forwarded message ---------\nFrom: 王伟 <wang@example.test>\nDate: Tue, Oct 28, 2026 at 9:00 AM\nSubject: 询价\nTo: <sales@example.test>\n\n${CN_COMPLAINT}`,
    ],
    ["a Russian email forwarded (Outlook) under a short English note", `FYI, see the customer message below:\nFrom: Ivan\nSent: Monday\n${RUSSIAN_DRAFT} Мы хотим заказать пятьсот коробок.`],
    [
      "a Chinese email under an Outlook rule and a short English note",
      `FYI, see below from the buyer.\n${"_".repeat(32)}\nFrom: Buyer\nSent: Monday\n${CN_COMPLAINT}`,
    ],
    ["a Chinese email quoted under 'The buyer wrote:'", `Hello team, the buyer's message is below.\nThe buyer wrote:\n${CN_COMPLAINT}`],
    // A translation that leaves the source standing under a line of English is not one.
    ["a 'translation' that quotes the source", `Translation of the email.\nThe customer wrote:\n${CN_COMPLAINT}`],
    ["a 'translation' that puts the source under '--'", `Here is the translation\n--\n${CN_COMPLAINT}`],
    // Text in another script beside English tips it over. That costs the board one revision request when the
    // English was enough; a missed warning would cost it a translation by hand. The earlier trimming of
    // signatures, field lines and quotes let these pass.
    ["English with a Chinese signature under a sentence", "Please confirm the order.\nWang Wei\n上海宏达贸易有限公司 采购部\n上海市浦东新区张江路"],
    [
      "English with a Chinese company signature",
      "Hi, please send the quote for 500 units.\nThanks,\nLi\n上海宏达贸易有限公司\n上海市浦东新区张江路123号",
    ],
    ["English with a Japanese signature", "Thank you for the samples, they arrived today.\n\n田中太郎\n株式会社サンプル商事 営業部"],
    [
      "an English reply that quotes the customer's Chinese email",
      "Thank you, the samples ship on Monday. The price list is attached.\n\n> 您好，\n> 我想询问批发价格和最低起订量。\n> 请问可以寄样品到上海吗？\n> 您好，我想询问批发价格。",
    ],
    [
      "an English reply above a Chinese 'On … wrote:' thread",
      "Thank you, the samples ship on Monday.\n\nOn Tue, Oct 28, 2026 buyer@example.test wrote:\n您好，\n我想询问批发价格和最低起订量。\n请问可以寄样品到上海吗？",
    ],
    ["English above a Chinese signature after '--'", "Thanks, the order is confirmed.\n--\n王伟\n上海宏达贸易有限公司\n上海市浦东新区张江路"],
    ["a short Chinese line", "好的谢谢您"],
    [
      "English with a Chinese shipping address in the middle",
      "Hi, please ship the order to the address below.\n收货地址：上海市浦东新区张江路123号\n收货人：王伟\nThanks.",
    ],
    [
      "an English reply above an Outlook-quoted Chinese email",
      "Thank you, the samples ship on Monday.\n________________________________\nFrom: Buyer\nSent: Monday\n您好，我想询问批发价格和最低起订量。请问可以寄样品到上海吗？谢谢！我们想订购五百盒。",
    ],
    [
      "an English reply above a Gmail (zh-CN) header",
      "Thank you, the samples ship on Monday.\nBuyer <buyer@example.test> 于2026年10月28日周二 09:00写道：\n您好，我想询问批发价格和最低起订量。请问可以寄样品到上海吗？",
    ],
    ["English with a Chinese signature after 'Thanks!'", "Hi, please send the quote for 500 units by Friday.\nThanks!\n王伟\n上海宏达贸易有限公司"],

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

  // Judged on every render of every queue row, on text an outside sender writes.
  it.each([
    ["one 20,000-letter word", "a".repeat(20_000)],
    ["a 20,000-character hex string", "0123456789abcdef".repeat(1_250)],
    ["Chinese running on into a long word", `${"您好".repeat(500)}${"x".repeat(19_000)}`],
    ["dots and plus signs", "a.+-".repeat(5_000)],
    ["many at signs", "a@b".repeat(7_000)],
    ["a long domain with no dot", `a@${"b".repeat(20_000)}`],
    ["many 'On' lines", "On a\n".repeat(5_000)],
    ["many quote headers", "在 a\n".repeat(5_000)],
    ["many From: lines", "From: a\n".repeat(5_000)],
    ["many short lines", "短\n".repeat(10_000)],
  ])("judges %s in linear time", (_name, text) => {
    const started = performance.now();
    isMostlyNonLatinScript(text);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("approvalTranslationLooksShort", () => {
  const longChinese = "我们已经收到您的订单，并会在三天内安排发货。如有任何问题，请随时与我们联系。".repeat(8);

  it("flags a translation far shorter than its source in another script", () => {
    expect(approvalTranslationLooksShort({ text: "Thank you, we will ship Monday.", language: null }, longChinese)).toBe(true);
    // The first paragraph only.
    expect(
      approvalTranslationLooksShort(
        { text: "We have received your order and will ship it within three days. ".repeat(2), language: null },
        longChinese,
      ),
    ).toBe(true);
  });

  it("does not flag a full translation, a short source, or a source in Latin letters", () => {
    const full = "We have received your order and will ship it within three days. If you have any questions, please contact us at any time. ".repeat(8);
    expect(approvalTranslationLooksShort({ text: full, language: null }, longChinese)).toBe(false);
    expect(approvalTranslationLooksShort({ text: CHINESE_EMAIL_EN, language: null }, CHINESE_EMAIL)).toBe(false);
    expect(approvalTranslationLooksShort({ text: CHINESE_DRAFT_EN, language: null }, CHINESE_DRAFT)).toBe(false);
    expect(approvalTranslationLooksShort({ text: "OK", language: null }, "好的，谢谢。")).toBe(false);
    expect(approvalTranslationLooksShort({ text: "Hi", language: null }, SPANISH_TEXT.repeat(5))).toBe(false);
  });

  it("weighs a forwarded email in another script, not only the English note above it", () => {
    const forwarded = `Hi Support,\n\nPlease see the message from my customer below.\n\n---------- Forwarded message ---------\nFrom: 王伟 <wang@example.cn>\nDate: Mon, 26 Oct 2026 at 09:12\nSubject: 订单\nTo: <sales@example.test>\n\n${CN_COMPLAINT.repeat(3)}`;
    const noteOnly = { text: "Hi Support, please see the message from my customer below.", language: null };
    expect(approvalTranslationLooksShort(noteOnly, forwarded)).toBe(true);
    // A Chinese reply translated whole is not short against the English thread quoted under it.
    const reply = `${longChinese}\n\n> On Mon, Oct 27, info@shop.example wrote:\n> ${"Hello, thank you for your order. ".repeat(40)}`;
    const full = "We have received your order and will ship it within three days. If you have any questions, please contact us at any time. ".repeat(8);
    expect(approvalTranslationLooksShort({ text: full, language: null }, reply)).toBe(false);
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
    const sent = () => container.querySelector("[data-approval-draft-body]")!.textContent;
    // The email that is sent is never hidden behind its translation's cut.
    expect(sent()).toBe(CHINESE_DRAFT);
    expect(body()).not.toContain("Last translated line.");
    expect(draftTranslation()!.querySelector("[data-approval-draft-translation-continues]")).not.toBeNull();
    // The short draft itself is whole; the control names what is cut.
    expect(container.querySelector("[data-approval-draft-continues]")).toBeNull();
    const draft = container.querySelector<HTMLElement>("[data-approval-draft]")!;
    const more = button(draft, `Show full translation (${longTranslation.length.toLocaleString()} characters)`)!;
    expect(more).toBeDefined();
    // A 44px touch target on phones.
    expect(more.className).toMatch(/min-h-11/);
    // Only the translation is cut, so Approve says so.
    expect(gate().approveLabel).toBe(APPROVAL_TRANSLATION_UNREAD_APPROVE_LABEL);
    let held: string | null = null;
    act(() => {
      held = gate().approveGuard();
    });
    expect(held).toBe(APPROVAL_TRANSLATION_UNREAD_MESSAGE);
    expect(body()).toBe(longTranslation);
    expect(sent()).toBe(CHINESE_DRAFT);
    expect(gate().approveLabel).toBeUndefined();
    expect(button(draft, "Show less")!.getAttribute("aria-label")).toBe("Show less: English translation of the draft");
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

  it("never shows a claim or a placeholder as the draft's language", () => {
    for (const language of ["Chinese (verified, accurate)", "Board approved", "Same as original", "Unknown"]) {
      const payload = emailPayload({ bodyTranslation: { language, text: CHINESE_DRAFT_EN } });
      act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={payload} />));
      expect(container.querySelector("[data-approval-draft-language]")).toBeNull();
      expect(draftTranslation()!.querySelector("p")!.textContent).toBe("English translation of the draft");
      expect(container.textContent).not.toContain(language);
    }
    // A known language named for an English draft is a contradiction: no chip either.
    const english = emailPayload({
      body: "Hello, we will ship the samples on Monday. Thanks.",
      bodyTranslation: { language: "Japanese", text: "Hello, we will ship the samples on Monday. Thanks." },
    });
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={english} />));
    expect(container.querySelector("[data-approval-draft-language]")).toBeNull();
  });

  it("notes under each translation that looks much shorter than its source, on every surface", () => {
    const longChinese = "我们已经收到您的订单，并会在三天内安排发货。如有任何问题，请随时与我们联系。".repeat(8);
    const payload = emailPayload(
      { body: longChinese, bodyTranslation: { language: "Chinese", text: "Thank you, we will ship Monday." } },
      { text: longChinese, translation: { language: "Chinese", text: "We got your order." } },
    );
    const short = (of: string) => container.querySelector(`[data-approval-translation-short='${of}']`);
    const note = "The translation looks much shorter than the original. Request a revision if parts are missing.";
    for (const element of [
      <ApprovalDecisionSummary type="request_board_approval" payload={payload} />,
      <ApprovalDecisionSummary type="request_board_approval" payload={payload} full />,
      <ThemeProvider>
        <ApprovalPayloadRenderer type="request_board_approval" payload={payload} />
      </ThemeProvider>,
    ]) {
      act(() => root.render(element));
      expect(originalTranslation()!.contains(short("original"))).toBe(true);
      expect(draftTranslation()!.contains(short("draft"))).toBe(true);
      expect(short("original")!.textContent).toBe(note);
      expect(short("draft")!.textContent).toBe(note);
    }
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={emailPayload()} />));
    expect(container.querySelector("[data-approval-translation-short]")).toBeNull();
  });

  it("warns under a Chinese draft written in short lines under an English greeting, on the queue and the request page", () => {
    const payload = emailPayload({
      body: "Dear Mr. Wang, thank you for your order and for your patience.\n我们会在三天内发货\n请确认收货地址\n如有问题请随时联系我们\n客服团队",
      bodyTranslation: undefined,
    });
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={payload} />));
    expect(missing("draft")).not.toBeNull();
    renderFullRequest(payload);
    expect(missing("draft")).not.toBeNull();
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
      expect(draftTranslation()!.textContent).toContain(hostile);
      // Markup is no language name: not shown at all, so not as markup either.
      expect(container.textContent).not.toContain("onerror=alert(2)");
      expect(container.querySelector("[data-approval-draft-language]")).toBeNull();
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

  it("names the translation's own expand control on a Board approval, apart from the request's", () => {
    const original = "Здравствуйте! ".repeat(48);
    const translated = "Hello there! ".repeat(49);
    const payload = {
      recommendedAction: "Approve the refund.",
      originalRequest: { text: original, source: { kind: "external" }, translation: { language: "Russian", text: translated } },
    };
    act(() => root.render(<OriginalRequestBlock payload={payload} compact />));
    const label = `Show full translation (${translated.length.toLocaleString()} characters)`;
    const more = button(originalTranslation()!, label)!;
    expect(more).toBeDefined();
    expect(more.getAttribute("aria-label")).toBe(`${label}: English translation of the original request`);
    const request = Array.from(container.querySelectorAll("button")).filter((element) => !originalTranslation()!.contains(element));
    expect(request.map((element) => element.textContent)).toEqual([`Show full request (${original.length.toLocaleString()} characters)`]);
  });

  it("does not ask for a revision that cannot add a translation to a Paperclip comment", () => {
    const payload = emailPayload(
      { bodyTranslation: undefined, body: "Thank you, the samples ship on Monday." },
      {
        text: "您好，我们同意价格，请尽快发货。谢谢您的支持。",
        // No comment link here: it needs the router.
        source: { kind: "paperclip_comment", snapshotOrigin: "server" },
        translation: undefined,
      },
    );
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={payload} />));
    expect(missing("original")?.textContent).toBe(
      "Not in English. A Paperclip comment is saved as posted, so no translation can be attached.",
    );
    expect(missing("original")?.textContent).not.toContain("Request a revision");
    expect(missing("draft")).toBeNull();
  });

  it("does not repeat a Latin-script language named for a draft or email in another script", () => {
    const payload = emailPayload(
      { bodyTranslation: { language: "English", text: CHINESE_DRAFT_EN } },
      { translation: { language: "Spanish", text: CHINESE_EMAIL_EN } },
    );
    for (const element of [
      <ApprovalDecisionSummary type="request_board_approval" payload={payload} />,
      <ThemeProvider>
        <ApprovalPayloadRenderer type="request_board_approval" payload={payload} />
      </ThemeProvider>,
    ]) {
      act(() => root.render(element));
      expect(container.querySelector("[data-approval-draft-language]")).toBeNull();
      expect(draftTranslation()!.querySelector("p")!.textContent).toBe("English translation of the draft");
      expect(originalTranslation()!.querySelector("p")!.textContent).toBe("English translation");
      // "English" is often the translation's own language: dropped quietly. "Spanish" for a Chinese email is a contradiction.
      expect(container.querySelector("[data-approval-translation-mismatch='draft']")).toBeNull();
      expect(originalTranslation()!.querySelector("[data-approval-translation-mismatch='original']")!.textContent).toBe(
        "The agent says the original email is in Spanish, but it is not. The translation may not match it. Request a revision.",
      );
    }
  });

  it("notes a translation whose language the draft is not in, keeps it shown, and does not hold Approve for it", () => {
    // The reply was rewritten in English after the revision; the old translation of the Chinese one stayed.
    const english = "Hello, we agree to refund the full $5,000 and to cover all return shipping.";
    const stale = `Hello, we can offer a $50 store credit. ${"Our wholesale price list is attached. ".repeat(60)}`;
    const payload = emailPayload({ body: english, bodyTranslation: { language: "Chinese (Simplified)", text: stale } });
    const gateRef: { current: ReturnType<typeof useApprovalDraftGate> | null } = { current: null };
    function Harness() {
      const gate = useApprovalDraftGate("request_board_approval", payload);
      gateRef.current = gate;
      return <ApprovalDecisionSummary type="request_board_approval" payload={payload} draftControl={gate.draftControl} />;
    }
    act(() => root.render(<Harness />));
    const note = "The agent says the draft is in Chinese (Simplified), but it is not. The translation may not match it. Request a revision.";
    expect(draftTranslation()!.querySelector("[data-approval-translation-mismatch='draft']")!.textContent).toBe(note);
    expect(draftTranslation()!.textContent).toContain("Hello, we can offer a $50 store credit.");
    expect(container.querySelector("[data-approval-draft-language]")).toBeNull();
    expect(gateRef.current!.approveLabel).toBeUndefined();
    let held: string | null = "not run";
    act(() => {
      held = gateRef.current!.approveGuard();
    });
    expect(held).toBeNull();

    for (const element of [
      <ApprovalDecisionSummary type="request_board_approval" payload={payload} full />,
      <ThemeProvider>
        <ApprovalPayloadRenderer type="request_board_approval" payload={payload} />
      </ThemeProvider>,
    ]) {
      act(() => root.render(element));
      expect(draftTranslation()!.querySelector("[data-approval-translation-mismatch='draft']")!.textContent).toBe(note);
    }

    // The same for the received email's translation.
    const original = emailPayload({}, { text: "Hello, can you ship samples to Madrid? Thank you.", translation: { language: "Japanese", text: "Hello." } });
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={original} />));
    expect(originalTranslation()!.querySelector("[data-approval-translation-mismatch='original']")!.textContent).toBe(
      "The agent says the original email is in Japanese, but it is not. The translation may not match it. Request a revision.",
    );
  });

  it("takes the reader to the start of the draft that is sent when Approve opens it, never into its translation", () => {
    const longDraft = `${"我们的批发价目表已附上。".repeat(140)}最后一行。`;
    const longTranslation = `${"Our wholesale price list is attached. ".repeat(60)}Last translated line.`;
    const payload = emailPayload({ body: longDraft, bodyTranslation: { language: "Chinese (Simplified)", text: longTranslation } });
    const scrolled: Array<{ target: Element; options: unknown }> = [];
    const original = HTMLElement.prototype.scrollIntoView;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: boolean | ScrollIntoViewOptions) {
      scrolled.push({ target: this, options });
    };
    // The opened reply and its translation are taller than the screen.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.hasAttribute("data-approval-draft") ? DOMRect.fromRect({ x: 0, y: 900, width: 390, height: 4000 }) : originalRect.call(this);
    };
    try {
      const gateRef: { current: ReturnType<typeof useApprovalDraftGate> | null } = { current: null };
      function Harness() {
        const gate = useApprovalDraftGate("request_board_approval", payload);
        gateRef.current = gate;
        return <ApprovalDecisionSummary type="request_board_approval" payload={payload} draftControl={gate.draftControl} />;
      }
      act(() => root.render(<Harness />));
      act(() => {
        gateRef.current!.approveGuard();
      });
      const draft = container.querySelector<HTMLElement>("[data-approval-draft]")!;
      expect(scrolled).toEqual([{ target: draft, options: { block: "start" } }]);
      // Its start is the "Draft reply" label, then the email that is sent; clear of the sticky header.
      expect(draft.firstElementChild!.textContent).toContain("Draft reply");
      expect(draft.className).toMatch(/scroll-mt-20/);
      expect(document.activeElement).toBe(draft);
      expect(draftTranslation()!.contains(document.activeElement)).toBe(false);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  it("treats an invisible translation as none, and flags one that is not in English", () => {
    act(() =>
      root.render(
        <ApprovalDecisionSummary
          type="request_board_approval"
          payload={emailPayload({ bodyTranslation: { text: "\u200b" } }, { translation: "\u200b" })}
        />,
      ),
    );
    expect(originalTranslation()).toBeNull();
    expect(draftTranslation()).toBeNull();
    expect(missing("original")).not.toBeNull();
    expect(missing("draft")).not.toBeNull();

    // The Chinese pasted again is no English translation.
    const pasted = emailPayload(
      { bodyTranslation: { language: "Chinese", text: CHINESE_DRAFT } },
      { translation: { language: "Chinese", text: CHINESE_EMAIL } },
    );
    const notEnglish = (of: string) => container.querySelector(`[data-approval-translation-not-english='${of}']`);
    const warning = "The attached translation is not in English. Request a revision to get one.";
    for (const element of [
      <ApprovalDecisionSummary type="request_board_approval" payload={pasted} />,
      <ThemeProvider>
        <ApprovalPayloadRenderer type="request_board_approval" payload={pasted} />
      </ThemeProvider>,
    ]) {
      act(() => root.render(element));
      expect(originalTranslation()!.contains(notEnglish("original"))).toBe(true);
      expect(draftTranslation()!.contains(notEnglish("draft"))).toBe(true);
      expect(notEnglish("original")!.textContent).toBe(warning);
      expect(notEnglish("draft")!.textContent).toBe(warning);
    }
    // A line of English over the source pasted again is no translation either.
    const quoted = emailPayload({ bodyTranslation: `Translation of the email.\nThe customer wrote:\n${CHINESE_DRAFT}` });
    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={quoted} />));
    expect(notEnglish("draft")!.textContent).toBe(warning);

    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={emailPayload()} />));
    expect(container.querySelector("[data-approval-translation-not-english]")).toBeNull();
  });

  it("frames the draft's translation apart from the draft that is sent, and marks it inside its box", () => {
    renderFullRequest(emailPayload());
    const translated = draftTranslation()!;
    const box = translated.querySelector("pre")!.parentElement!;
    expect(box.className).toMatch(/border-dashed/);
    expect(box.querySelector("[data-approval-draft-translation-marker]")!.textContent).toBe("Translation · not sent");
    // The marker is outside the translated text: copying the translation copies the translation only.
    expect(translated.querySelector("pre")!.textContent).toBe(CHINESE_DRAFT_EN);
    const sent = Array.from(container.querySelectorAll("pre")).find((element) => element.textContent === CHINESE_DRAFT)!;
    expect(sent.className).toMatch(/\bborder\b/);
    expect(sent.className).not.toMatch(/border-dashed/);

    act(() => root.render(<ApprovalDecisionSummary type="request_board_approval" payload={emailPayload()} />));
    expect(draftTranslation()!.querySelector("[data-approval-draft-translation-marker]")).not.toBeNull();
    expect(draftTranslation()!.querySelector("[data-approval-draft-translation-body]")!.textContent).toBe(CHINESE_DRAFT_EN);
  });
});

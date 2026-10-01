// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { getByRole } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingCompanyNameField } from "./OnboardingCompanyNameField";

describe("OnboardingCompanyNameField", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("associates the Company name label with its textbox", () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <OnboardingCompanyNameField
          value=""
          onChange={vi.fn()}
          onKeyDown={vi.fn()}
        />,
      );
    });

    const textbox = getByRole(container, "textbox", { name: "Company name" });
    const label = container.querySelector("label");

    expect(label?.htmlFor).toBe(textbox.id);
  });
});

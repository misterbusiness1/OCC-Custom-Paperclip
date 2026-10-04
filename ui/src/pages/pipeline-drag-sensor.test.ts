// @vitest-environment jsdom

import { PointerSensor } from "@dnd-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";

type SensorProps = ConstructorParameters<typeof PointerSensor>[0];

function startDrag(id: string) {
  const source = document.createElement("button");
  document.body.append(source);
  const event = new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 });
  source.dispatchEvent(event);
  const sensor = new PointerSensor({
    active: id,
    activeNode: {} as SensorProps["activeNode"],
    context: { current: {} as SensorProps["context"]["current"] },
    event,
    options: {},
    onAbort: vi.fn(),
    onPending: vi.fn(),
    onStart: vi.fn(),
    onCancel: vi.fn(),
    onMove: vi.fn(),
    onEnd: vi.fn(),
  });
  return { source, sensor };
}

function finishDrag(eventName: "pointerup" | "pointercancel" = "pointerup") {
  document.dispatchEvent(new MouseEvent(eventName, { bubbles: true }));
}

function makeConfirmation() {
  const button = document.createElement("button");
  document.body.append(button);
  const onClick = vi.fn();
  button.addEventListener("click", onClick);
  return { button, onClick };
}

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("patched dnd-kit pointer sensor click lifecycle", () => {
  it("suppresses the drag click and accepts a fresh pointer activation", () => {
    vi.useFakeTimers();
    startDrag("first");
    finishDrag();
    const { button, onClick } = makeConfirmation();

    button.click();
    expect(onClick).not.toHaveBeenCalled();

    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it.each(["Enter", "Space"])("accepts a fresh %s keyboard activation after the drag", (code) => {
    vi.useFakeTimers();
    startDrag("first");
    finishDrag();
    const { button, onClick } = makeConfirmation();

    button.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code }));
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps suppressing the drag click after an unrelated key", () => {
    vi.useFakeTimers();
    startDrag("first");
    finishDrag();
    const { button, onClick } = makeConfirmation();

    button.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "ShiftLeft" }));
    button.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("cleans up after cancellation when the dragged node has unmounted", () => {
    vi.useFakeTimers();
    const { source } = startDrag("first");
    source.remove();
    finishDrag("pointercancel");
    const { button, onClick } = makeConfirmation();

    button.click();
    expect(onClick).not.toHaveBeenCalled();
    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not let an older cleanup timer remove a newer sensor's click blocker", () => {
    vi.useFakeTimers();
    startDrag("first");
    finishDrag();
    startDrag("second");
    vi.advanceTimersByTime(50);
    const { button, onClick } = makeConfirmation();

    button.click();
    expect(onClick).not.toHaveBeenCalled();
    finishDrag();
  });
});

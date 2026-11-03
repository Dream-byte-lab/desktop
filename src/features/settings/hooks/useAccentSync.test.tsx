import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAccentSync } from "./useAccentSync";
import { useAccentStore } from "../store/accentStore";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The wiring proof for the accent system: the store's choice is
// what the document wears. Default (sweep) sets nothing at all —
// an untouched install's styling is exactly the theme blocks'.

function Harness() {
  useAccentSync();
  return null;
}

describe("useAccentSync", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useAccentStore.setState({ choice: "sweep", customHex: null });
    document.documentElement.removeAttribute("data-accent");
    document.getElementById("linerave-accent-custom")?.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.documentElement.removeAttribute("data-accent");
    document.getElementById("linerave-accent-custom")?.remove();
  });

  const render = () => {
    act(() => {
      root.render(<Harness />);
    });
  };

  it("the default sweep sets no attribute and no style element", () => {
    render();
    expect(document.documentElement.getAttribute("data-accent")).toBeNull();
    expect(document.getElementById("linerave-accent-custom")).toBeNull();
  });

  it("a curated family sets only the data-accent attribute", () => {
    render();
    act(() => {
      useAccentStore.setState({ choice: "lagoon" });
    });
    expect(document.documentElement.getAttribute("data-accent")).toBe("lagoon");
    expect(document.getElementById("linerave-accent-custom")).toBeNull();
  });

  it("returning to sweep removes the attribute again (parity restored)", () => {
    render();
    act(() => {
      useAccentStore.setState({ choice: "ember" });
    });
    expect(document.documentElement.getAttribute("data-accent")).toBe("ember");
    act(() => {
      useAccentStore.setState({ choice: "sweep" });
    });
    expect(document.documentElement.getAttribute("data-accent")).toBeNull();
  });

  it("custom injects one style element carrying the guarded springs", () => {
    render();
    act(() => {
      useAccentStore.setState({ choice: "custom", customHex: "#fde68a" });
    });
    expect(document.documentElement.getAttribute("data-accent")).toBe("custom");
    const style = document.getElementById("linerave-accent-custom");
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('data-accent="custom"');
    expect(style!.textContent).toContain("--sweep-spring:");
    // The pale pick IS its own dark-mode spring (it passes dark
    // unadjusted) but cannot be its own light-mode spring — so the
    // first rule (the light base) carries an adjusted spring, while
    // the dark rules keep the pick itself.
    const lightRule = style!.textContent.split("\n")[0];
    expect(lightRule).toContain("--sweep-spring:");
    expect(lightRule).not.toContain("#fde68a");
    expect(style!.textContent).toContain("--sweep-spring: #fde68a;");
  });

  it("a custom choice with no stored colour applies nothing", () => {
    render();
    act(() => {
      useAccentStore.setState({ choice: "custom", customHex: null });
    });
    expect(document.documentElement.getAttribute("data-accent")).toBeNull();
    expect(document.getElementById("linerave-accent-custom")).toBeNull();
  });
});

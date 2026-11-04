import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@/languages/locales/en.json";
import type { ConnectionIssue } from "../lib/classify";

// Pin for the Note 30 F1 copy split: the unreachable verdict
// renders its own title/desc keys, not the server-error pair.
// The translator is the identity, so the rendered text IS the
// locale key the modal chose. Shell furniture (dialog, buttons,
// icons) is stubbed — only the copy wiring is under test.

vi.mock("@/languages", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    locale: "en",
  }),
  createTranslatorSync: () => (key: string) => key,
  getStoredLocale: () => "en",
}));

vi.mock("@/shared/ui/Toast", () => ({ showToast: vi.fn() }));

vi.mock("@/shared/ui", async () => {
  const React = await import("react");
  return {
    DialogActions: (props: { children?: React.ReactNode }) =>
      React.createElement("div", null, props.children),
    DialogButton: (props: {
      children?: React.ReactNode;
      onClick?: () => void;
    }) =>
      React.createElement("button", { onClick: props.onClick }, props.children),
  };
});

vi.mock("@/shared/ui/Dialog", async () => {
  const React = await import("react");
  return {
    default: (props: { open?: boolean; children?: React.ReactNode }) =>
      props.open ? React.createElement("div", null, props.children) : null,
  };
});

vi.mock("@mingcute/react", () => ({
  ServerLine: () => null,
  WifiOffLine: () => null,
  YoutubeLine: () => null,
}));

vi.mock("@/shared/lib", () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(" "),
}));

async function renderModal(issue: ConnectionIssue) {
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { useOfflineModeStore } = await import("../store/offlineModeStore");
  const { default: ConnectionIssueModal } =
    await import("./ConnectionIssueModal");
  useOfflineModeStore.setState({ issue, country: null });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ConnectionIssueModal />);
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      useOfflineModeStore.setState({ issue: null });
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ConnectionIssueModal copy", () => {
  it("renders the unreachable title and desc keys for an unreachable verdict", async () => {
    const { container, cleanup } = await renderModal("server_unreachable");
    expect(container.querySelector("h2")?.textContent).toBe(
      "offline.issue_server_unreachable_title",
    );
    expect(container.querySelector("p")?.textContent).toBe(
      "offline.issue_server_unreachable_desc",
    );
    await cleanup();
  });

  it("keeps the server title and desc keys for a 5xx verdict", async () => {
    const { container, cleanup } = await renderModal("server");
    expect(container.querySelector("h2")?.textContent).toBe(
      "offline.issue_server_title",
    );
    expect(container.querySelector("p")?.textContent).toBe(
      "offline.issue_server_desc",
    );
    await cleanup();
  });
});

describe("offline unreachable copy (en)", () => {
  it("exists and claims only that no answer arrived", () => {
    const offline = (en as { offline: Record<string, string> }).offline;
    expect(offline.issue_server_unreachable_title).toBe(
      "No answer from Linerave's servers",
    );
    expect(offline.issue_server_unreachable_desc).toContain(
      "didn't answer this time",
    );
    expect(offline.issue_server_unreachable_title).not.toBe(
      offline.issue_server_title,
    );
  });
});

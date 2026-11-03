import { describe, expect, it } from "vitest";
import en from "@/languages/locales/en.json";

// The locales sweep (Interface Build 2): every `common.sidebar.*` key
// the sidebar components look up through the `t(key) || fallback`
// idiom must exist in en.json with exactly the string the fallback
// used to carry, so the key — not the fallback — is now the text of
// record. Other locales fall back to English by design.
//
// Keys of record, from the components:
// - item ids (SidebarNavItems: t(`common.sidebar.${item.id}`)):
//   home, for_you, search, library, favorites, downloads
// - SidebarSettingsButton: settings
// - Sidebar: expand, collapse
// - SidebarAccountStatus: signed_in, guest
// - section ids (SidebarNavItems: t(`common.sidebar.section_${id}`)):
//   section_discover, section_collection
const SIDEBAR_KEYS: Record<string, string> = {
  home: "Home",
  for_you: "For You",
  search: "Search",
  library: "Library",
  settings: "Settings",
  favorites: "Favorites",
  downloads: "Downloads",
  expand: "Expand",
  collapse: "Collapse",
  signed_in: "Signed in",
  guest: "Guest",
  section_discover: "Discover",
  section_collection: "Your Collection",
};

describe("common.sidebar locales (en)", () => {
  it.each(Object.entries(SIDEBAR_KEYS))(
    "common.sidebar.%s is present and carries the fallback's text",
    (key, expected) => {
      const sidebar = (en as { common: { sidebar: Record<string, string> } })
        .common.sidebar;
      expect(sidebar[key]).toBe(expected);
    },
  );
});

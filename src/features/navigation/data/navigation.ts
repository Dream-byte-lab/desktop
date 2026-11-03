import type { ComponentType } from "react";
import {
  Home7Fill,
  Search3Fill,
  BookmarksFill,
  Settings4Fill,
  HeartFill,
  Download2Fill,
  CompassFill,
} from "@mingcute/react";

export interface NavItem {
  id: string;
  label: string;
  href?: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
}

export const sidebarNavItems: NavItem[] = [
  { id: "home", label: "Home", href: "/", Icon: Home7Fill },
  { id: "search", label: "Search", Icon: Search3Fill },
  { id: "library", label: "Library", href: "/library", Icon: BookmarksFill },
  { id: "settings", label: "Settings", Icon: Settings4Fill },
];

/**
 * Full ref-18 sidebar structure (structure of record):
 *
 *   Discover        { Home, For You, Discover, Search, Radio }
 *   Your Collection { Recently Played, Songs, Albums, Artists, Playlists,
 *                     Favorites, Downloads }
 *   Your Space      { Your Mixes, Listening History, Personal Playlists }
 *   Foot            { Profile, Settings, Account status }
 *
 * NAV HONESTY: an entry appears in the rendered nav ONLY if its
 * destination exists today. The following entries are therefore
 * OMITTED pending pages (documentation only — no dead UI):
 *   - discover           (no Discover page)
 *   - radio              (no Radio page)
 *   - recently-played    (no standalone page; Library tabs are not routes)
 *   - songs              (no standalone page)
 *   - albums             (no standalone page)
 *   - artists            (no standalone page)
 *   - playlists          (no standalone page)
 *   - your-mixes         (no page yet)
 *   - listening-history  (no page yet)
 *   - personal-playlists (no page yet)
 *   - profile            (no page yet; account lives in the settings modal,
 *                         surfaced via SidebarAccountStatus in the foot)
 *
 * Library itself is kept: it routes to "/library", whose internal
 * tabs (all/playlists/albums/artists) are component state, not routes.
 */

export const forYouNavItem: NavItem = {
  id: "for_you",
  label: "For You",
  href: "/for-you",
  Icon: CompassFill,
};

export const favoritesNavItem: NavItem = {
  id: "favorites",
  label: "Favorites",
  href: "/library/saved",
  Icon: HeartFill,
};

export const downloadsNavItem: NavItem = {
  id: "downloads",
  label: "Downloads",
  href: "/library/cached",
  Icon: Download2Fill,
};

/** Every sidebar item by id, including the section-only entries. */
const byId = (id: string): NavItem =>
  sidebarNavItems.find((item) => item.id === id)!;

export const sidebarAllItems: Record<string, NavItem> = {
  home: byId("home"),
  for_you: forYouNavItem,
  search: byId("search"),
  library: byId("library"),
  settings: byId("settings"),
  favorites: favoritesNavItem,
  downloads: downloadsNavItem,
};

export function getSidebarItem(id: string): NavItem | undefined {
  return sidebarAllItems[id];
}

export interface SidebarSection {
  id: string;
  label: string;
  itemIds: string[];
}

export const sidebarSections: SidebarSection[] = [
  {
    id: "discover",
    label: "Discover",
    itemIds: ["home", "for_you", "search"],
  },
  {
    id: "collection",
    label: "Your Collection",
    itemIds: ["library", "favorites", "downloads"],
  },
];

/**
 * The Pinned section (Interface Build 6; the Wave 3 playlist
 * identity pack's sidebar companion, cut there and assigned to this
 * stream). It is deliberately NOT part of sidebarSections: its rows
 * are not navigation items but the user's pinned playlists —
 * dynamic content owned by the library's identity store
 * (features/library/lib/playlistIdentity), rendered by
 * widgets/sidebar's SidebarPinnedPlaylists under the nav sections.
 * It exists only while at least one pin resolves to a real
 * playlist; this descriptor keeps the shell's data model naming it,
 * in the order it renders (after Your Collection).
 */
export const pinnedSidebarSection: SidebarSection = {
  id: "pinned",
  label: "Pinned",
  itemIds: [],
};

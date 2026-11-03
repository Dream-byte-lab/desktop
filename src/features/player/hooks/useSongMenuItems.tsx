import { useCallback } from "react";
import {
  LuRadio,
  LuStepForward,
  LuListPlus,
  LuHeart,
  LuPlus,
  LuTrash2,
  LuFolderPlus,
  LuListMusic,
} from "react-icons/lu";
import { ShareForwardLine } from "@mingcute/react";
import type { DropdownMenuItem } from "@/shared/ui/DropdownMenu";
import { ApiError } from "@/shared/api";
import { playerEngine } from "../engine/playerEngine";
import {
  usePlaylistsList,
  useAddPlaylistTracks,
  useLikeTrack,
  useUnlikeTrack,
  useIsTrackLiked,
  useModalStore,
} from "@/features/library";
import { useTranslation } from "@/languages";
import { showToast } from "@/shared/ui";
import { buildShareUrl } from "@/shared/utils/share";
import { isLocalTrackId } from "@/shared/media/local";

const CLOUD_ONLY_ITEMS = new Set([
  "start-radio",
  "like-track",
  "unlike-track",
  "add-to-playlist",
  "remove-from-playlist",
  "share",
]);

/** quick-add entries carry their playlist id in the item id */
const QUICK_ADD_PREFIX = "quick-add-to-playlist:";

/** how many one-click playlist entries sit under "Add to playlist" */
const QUICK_ADD_LIMIT = 4;

export interface SongMenuContext {
  id?: string;
  title: string;
  artists: string;
  coverUrl: string;
  duration?: string;
  durationMs?: number;
  searchType?: "track" | "album" | "artist" | "playlist";
  totalTracks?: number;
  playlistId?: string;
  playlistItemId?: string;
  playlistTitle?: string;
  /** play queue rows: adds "Remove from queue" (the queue animates the row out) */
  onRemoveFromQueue?: () => void;
  onRemoveFromDevice?: () => void;
}

export function useSongMenuItems(ctx: SongMenuContext): DropdownMenuItem[] {
  const { t } = useTranslation();
  const {
    id,
    title,
    artists,
    coverUrl,
    duration,
    durationMs,
    searchType,
    totalTracks,
    playlistId,
    playlistItemId,
    playlistTitle,
    onRemoveFromQueue,
    onRemoveFromDevice,
  } = ctx;

  const { data: playlistsData } = usePlaylistsList();

  const addPlaylistTrack = useAddPlaylistTracks();

  const likeMutation = useLikeTrack();
  const unlikeMutation = useUnlikeTrack();

  const liked = useIsTrackLiked(id);

  const handleLike = useCallback(async () => {
    if (!id) return;
    if (liked) {
      unlikeMutation.mutate(id);
    } else {
      likeMutation.mutate(id);
    }
  }, [id, liked, likeMutation, unlikeMutation]);

  const handleShare = useCallback(() => {
    if (!id) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      const type =
        (searchType as "track" | "album" | "artist" | "playlist") || "track";
      void navigator.clipboard.writeText(buildShareUrl(type, id));
      showToast(t("common.link_copied"), "checkmark", {
        description: artists ? `${title} — ${artists}` : title,
      });
    }
  }, [id, searchType, title, artists, t]);

  // One-click add with exactly the AddToPlaylist modal's feedback: success
  // names the playlist, a 409 names the track, anything else is the plain
  // failure toast. Uses the same mutation the modal uses.
  const handleQuickAddToPlaylist = useCallback(
    async (playlistId: string, playlistTitle: string) => {
      if (!id) return;
      try {
        await addPlaylistTrack.mutateAsync({ playlistId, trackId: id });
        showToast(t("common.added_to_playlist"), "checkmark", {
          description: playlistTitle,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          showToast(t("common.track_already_in_playlist"), "error", {
            description: title,
          });
        } else {
          showToast(t("common.failed_add_playlist"), "error");
        }
      }
    },
    [id, title, addPlaylistTrack, t],
  );

  // Quick-add: the most recently updated playlists, one click, no modal
  // round-trip. LibraryPlaylistSummary.updatedAt is a real recency signal,
  // so a copy is sorted by it (stable: equal or unparseable timestamps keep
  // the server list's order). While the list is loading playlistsData is
  // still the empty list, and with no track id there is nothing to add —
  // both yield no entries. `excludePlaylistId` drops one playlist from the
  // candidates before the cap is applied (the playlist-context branch uses
  // it for the playlist the track already sits in, whose add is a
  // guaranteed 409); the non-playlist branch passes nothing and excludes
  // nothing.
  const buildQuickAddItems = useCallback(
    (excludePlaylistId?: string): DropdownMenuItem[] => {
      if (!id) return [];
      return [...(playlistsData?.playlists ?? [])]
        .filter((playlist) => playlist.id !== excludePlaylistId)
        .sort(
          (a, b) =>
            (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
        )
        .slice(0, QUICK_ADD_LIMIT)
        .map((playlist) => ({
          id: `${QUICK_ADD_PREFIX}${playlist.id}`,
          label: playlist.title,
          icon: <LuListMusic size={15} />,
          onClick: () => handleQuickAddToPlaylist(playlist.id, playlist.title),
        }));
    },
    [id, playlistsData, handleQuickAddToPlaylist],
  );

  const buildMenu = useCallback((): DropdownMenuItem[] => {
    const isTrack = searchType === "track" || !searchType;

    if (isTrack) {
      if (playlistId) {
        return [
          {
            id: "start-radio",
            label: t("common.start_radio"),
            icon: <LuRadio size={15} />,
            onClick: () => {
              if (!id) return;
              void playerEngine.startRadioStation({
                id,
                title,
                artists,
                coverUrl,
                durationMs: durationMs ?? 0,
                playCount: 0,
              });
            },
          },
          {
            id: "play-next",
            label: t("common.play_next"),
            icon: <LuStepForward size={15} />,
            onClick: () => {
              if (!id) return;
              playerEngine.playNext({
                id,
                title,
                artists,
                coverUrl,
                durationMs: durationMs ?? 0,
                playCount: 0,
              });
            },
          },
          {
            id: "add-to-queue",
            label: t("common.add_to_queue"),
            icon: <LuListPlus size={15} />,
            onClick: () => {
              if (!id) return;
              playerEngine.addToQueue({
                id,
                title,
                artists,
                coverUrl,
                durationMs: durationMs ?? 0,
                playCount: 0,
              });
              showToast(t("common.added_to_queue"), "checkmark", {
                description: artists ? `${title} — ${artists}` : title,
              });
            },
          },
          {
            id: liked ? "unlike-track" : "like-track",
            label: liked ? t("common.unlike") : t("common.like"),
            icon: (
              <LuHeart
                size={15}
                className={
                  liked ? "fill-red-500 text-red-500" : "text-text-secondary"
                }
              />
            ),
            onClick: handleLike,
          },
          {
            id: "share",
            label: t("common.share"),
            icon: <ShareForwardLine size={15} />,
            onClick: handleShare,
          },
          // Quick-add sits where the modal item would conceptually sit:
          // adds grouped together, the destructive remove stays last. The
          // containing playlist is excluded — the track is already in it.
          ...buildQuickAddItems(playlistId),
          {
            id: "remove-from-playlist",
            label: t("common.remove_from_playlist"),
            icon: <LuTrash2 size={15} />,
            danger: true,
            onClick: () => {
              if (!id) return;
              useModalStore.getState().openRemoveFromPlaylist({
                trackId: id,
                playlistItemId,
                trackTitle: title,
                trackArtists: artists,
                trackCoverUrl: coverUrl,
                playlistId,
                playlistTitle,
              });
            },
          },
        ];
      }

      return [
        {
          id: "start-radio",
          label: t("common.start_radio"),
          icon: <LuRadio size={15} />,
          onClick: () => {
            if (!id) return;
            void playerEngine.startRadioStation({
              id,
              title,
              artists,
              coverUrl,
              durationMs: durationMs ?? 0,
              playCount: 0,
            });
          },
        },
        {
          id: "play-next",
          label: t("common.play_next"),
          icon: <LuStepForward size={15} />,
          onClick: () => {
            if (!id) return;
            playerEngine.playNext({
              id,
              title,
              artists,
              coverUrl,
              durationMs: durationMs ?? 0,
              playCount: 0,
            });
          },
        },
        {
          id: "add-to-queue",
          label: t("common.add_to_queue"),
          icon: <LuListPlus size={15} />,
          onClick: () => {
            if (!id) return;
            playerEngine.addToQueue({
              id,
              title,
              artists,
              coverUrl,
              durationMs: durationMs ?? 0,
              playCount: 0,
            });
            showToast(t("common.added_to_queue"), "checkmark", {
              description: artists ? `${title} — ${artists}` : title,
            });
          },
        },
        {
          id: liked ? "unlike-track" : "like-track",
          label: liked ? t("common.unlike") : t("common.like"),
          icon: (
            <LuHeart
              size={15}
              className={
                liked ? "fill-red-500 text-red-500" : "text-text-secondary"
              }
            />
          ),
          onClick: handleLike,
        },
        {
          id: "add-to-playlist",
          label: t("common.add_to_playlist"),
          icon: <LuPlus size={15} />,
          onClick: () => {
            if (!id) return;
            useModalStore.getState().openAddToPlaylist({
              id,
              title,
              artists,
              coverUrl,
              duration,
              playlists: playlistsData?.playlists ?? [],
            });
          },
        },
        ...buildQuickAddItems(),
        {
          id: "share",
          label: t("common.share"),
          icon: <ShareForwardLine size={15} />,
          onClick: handleShare,
        },
        ...(onRemoveFromQueue
          ? [
              {
                id: "remove-from-queue",
                label: t("common.remove_from_queue"),
                icon: <LuTrash2 size={15} />,
                danger: true,
                onClick: onRemoveFromQueue,
              },
            ]
          : []),
      ];
    }

    return [
      {
        id: "add-to-library",
        label: t("common.add_to_library"),
        icon: <LuFolderPlus size={15} />,
        onClick: () => {
          if (!id) return;
          useModalStore.getState().openAddToLibrary({
            id,
            title,
            coverUrl,
            type: (searchType as "album" | "artist" | "playlist") || "album",
            subtitle: artists,
            totalTracks,
          });
        },
      },
      {
        id: "share",
        label: t("common.share"),
        icon: <ShareForwardLine size={15} />,
        onClick: handleShare,
      },
    ];
  }, [
    id,
    title,
    artists,
    coverUrl,
    duration,
    durationMs,
    searchType,
    totalTracks,
    playlistId,
    playlistItemId,
    playlistTitle,
    onRemoveFromQueue,
    liked,
    handleLike,
    handleShare,
    handleQuickAddToPlaylist,
    buildQuickAddItems,
    playlistsData,
    t,
  ]);

  const items = buildMenu();
  if (!isLocalTrackId(id)) return items;
  const deviceItems = items.filter(
    (item) =>
      !CLOUD_ONLY_ITEMS.has(item.id) && !item.id.startsWith(QUICK_ADD_PREFIX),
  );
  if (!onRemoveFromDevice) return deviceItems;
  return [
    ...deviceItems,
    {
      id: "remove-from-device",
      label: t("library.local.remove"),
      icon: <LuTrash2 size={15} />,
      danger: true,
      onClick: onRemoveFromDevice,
    },
  ];
}

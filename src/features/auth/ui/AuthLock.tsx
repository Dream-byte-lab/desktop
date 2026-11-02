import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { getAuthSession } from "@/shared/api";
import AppFrame from "@/features/navigation/ui/AppFrame";
import { useWindowState } from "@/features/navigation/hooks/useWindowState";

export function AuthLock({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const status = useAuthStore((state) => state.status);
  const initialize = useAuthStore((state) => state.initialize);
  // keeps the body's outer padding in step with maximize / fullscreen on every screen,
  // including login and the startup spinner (the app frame mounts its own copy too)
  const { isEdgeToEdge } = useWindowState();

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const syncExpiredSession = () => {
      if (!getAuthSession()) void initialize();
    };
    window.addEventListener("auth:changed", syncExpiredSession);
    return () => window.removeEventListener("auth:changed", syncExpiredSession);
  }, [initialize]);

  // Linerave is usable without an account: guests (and the legacy "anonymous"
  // state) go straight into the app. Signing in is optional — it only adds
  // sync (likes, history, cloud playlists). The login page stays reachable
  // for guests who want it, and signed-in users are bounced off it.
  useEffect(() => {
    if (status === "authenticated" && pathname === "/login") {
      navigate("/", { replace: true });
    }
  }, [pathname, navigate, status]);

  if (
    status === "initializing" ||
    (status === "authenticated" && pathname === "/login")
  ) {
    return (
      <div
        className={`h-full w-full bg-bg-canvas ${isEdgeToEdge ? "rounded-none" : "rounded-item"}`}
      />
    );
  }

  return pathname === "/login" ? children : <AppFrame>{children}</AppFrame>;
}

export default AuthLock;

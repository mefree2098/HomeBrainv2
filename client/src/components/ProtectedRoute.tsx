import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

export function ProtectedRoute({
  children,
  adminOnly = false
}: {
  children: React.ReactNode;
  adminOnly?: boolean;
}) {
  const { currentUser, hasHomeBrainAccess, isAuthenticated, isAdmin, isLoading } = useAuth();
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}${location.hash}`;

  useEffect(() => {
    if (!isLoading && isAuthenticated && !hasHomeBrainAccess && currentUser?.defaultRedirectUrl) {
      window.location.assign(currentUser.defaultRedirectUrl);
    }
  }, [currentUser?.defaultRedirectUrl, hasHomeBrainAccess, isAuthenticated, isLoading]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center px-6">
        <div className="glass-panel glass-panel-strong rounded-[2rem] px-8 py-7 text-center">
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-2 border-white/20 border-t-cyan-400" />
          <p className="mt-4 section-kicker">Checking access</p>
          <p className="mt-2 text-sm text-muted-foreground">Refreshing your HomeBrain session.</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} state={{ from: location }} replace />;
  }

  if (!hasHomeBrainAccess) {
    return (
      <div className="flex h-screen items-center justify-center px-6">
        <div className="glass-panel glass-panel-strong max-w-md rounded-[2rem] px-8 py-7 text-center">
          <p className="section-kicker">Platform Redirect</p>
          <p className="mt-3 text-lg font-semibold text-foreground">
            This account does not have HomeBrain access.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {currentUser?.defaultRedirectUrl
              ? "Redirecting you to Axiom."
              : "Ask an admin to enable the HomeBrain platform for this user."}
          </p>
        </div>
      </div>
    );
  }

  if (adminOnly && !isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

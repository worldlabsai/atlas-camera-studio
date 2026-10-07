import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ClerkProvider, UserButton, useAuth, useClerk } from "@clerk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CameraTrajectoryPage } from "./trajectory/Editor";
import { authFetchJson, type GetToken } from "./trajectory/client";
import type { Config } from "./types";
import "./styles.css";

type Auth = {
  signedIn: boolean;
  getToken: GetToken;
  openSignIn(): void;
  openProfile(): void;
};
type Account = { credits: number; phoneVerified: boolean };
const localAuth: Auth = {
  signedIn: true,
  getToken: Object.assign(async () => null, { storageScope: "local" }),
  openSignIn() {},
  openProfile() {},
};
class EditorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="loading-screen">
        <p>The editor could not load. Reload to try again.</p>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function Studio({ config, auth }: { config: Config; auth: Auth }) {
  const [queryClient] = useState(() => new QueryClient());
  const [account, setAccount] = useState<Account | null>(null);
  const [message, setMessage] = useState(() =>
    new URLSearchParams(location.search).get("checkout") === "success"
      ? "Payment submitted. Your credits will appear once payment is confirmed. You can return to your editor tab."
      : "",
  );
  const [buying, setBuying] = useState(false);
  const refreshAccount = useCallback(async () => {
    if (!auth.signedIn || config.mode !== "hosted") return;
    try {
      setAccount(await authFetchJson<Account>(auth.getToken, "/api/account"));
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not refresh your credits.",
      );
    }
  }, [auth.signedIn, auth.getToken, config.mode]);
  useEffect(() => {
    void refreshAccount();
    window.addEventListener("focus", refreshAccount);
    window.addEventListener("studio-account-refresh", refreshAccount);
    const timer = window.setInterval(refreshAccount, 15000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshAccount);
      window.removeEventListener("studio-account-refresh", refreshAccount);
    };
  }, [refreshAccount]);
  const ensureAccess = () => {
    if (!config.apiConfigured) {
      setMessage("Add your Marble API key to the server to prepare a scene.");
      return false;
    }
    if (config.mode === "local") return true;
    if (!auth.signedIn) {
      auth.openSignIn();
      return false;
    }
    if (!account) {
      setMessage("Loading your account. Try again in a moment.");
      void refreshAccount();
      return false;
    }
    if (!account.phoneVerified) {
      setMessage(
        "Add and verify a phone number in your account to get started.",
      );
      auth.openProfile();
      return false;
    }
    return true;
  };
  const beforeGenerate = () => {
    if (!ensureAccess()) return false;
    if (config.mode === "hosted" && (account?.credits ?? 0) < 1) {
      setMessage(
        "You have used your free generations. Add 3 generations for $5 to continue.",
      );
      return false;
    }
    setMessage("");
    return true;
  };
  const checkout = async () => {
    if (!ensureAccess() || buying) return;
    const checkoutTab = window.open("about:blank", "_blank");
    if (!checkoutTab) {
      setMessage(
        "Allow pop-ups to open Stripe checkout and keep your scene here.",
      );
      return;
    }
    checkoutTab.opener = null;
    setBuying(true);
    try {
      const result = await authFetchJson<{ url: string }>(
        auth.getToken,
        "/api/checkout",
        { method: "POST", body: "{}" },
      );
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com")
        throw new Error("Checkout returned an unexpected address.");
      checkoutTab.location.href = url.href;
    } catch (error) {
      checkoutTab.close();
      setMessage(
        error instanceof Error ? error.message : "Could not open checkout.",
      );
    } finally {
      setBuying(false);
    }
  };
  return (
    <div className="studio-shell">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#080b12] px-4 py-2 text-xs text-white/60">
        <div className="flex items-center gap-4">
          <span className="font-medium text-white/90">
            Marble Camera Studio
          </span>
          {config.repoUrl && (
            <a
              href={config.repoUrl}
              target="_blank"
              rel="noreferrer"
              className="hover:text-white"
            >
              Source
            </a>
          )}
          <a
            href="https://atlas-beta.worldlabs.ai/docs/quickstart"
            target="_blank"
            rel="noreferrer"
            className="hover:text-white"
          >
            API docs
          </a>
          <a
            href="https://form.typeform.com/to/zHFR4r3A"
            target="_blank"
            rel="noreferrer"
            className="hover:text-white"
          >
            Get API access
          </a>
        </div>
        {config.mode === "hosted" ? (
          <div className="flex items-center gap-3">
            {auth.signedIn ? (
              <>
                <button
                  onClick={() => void refreshAccount()}
                  title="Refresh credits"
                >
                  {account
                    ? `${account.credits} generation${account.credits === 1 ? "" : "s"}`
                    : "Loading account…"}
                </button>
                {account && !account.phoneVerified && (
                  <button className="text-amber-200" onClick={auth.openProfile}>
                    Verify phone
                  </button>
                )}
                <button
                  className="rounded-lg border border-white/20 px-3 py-1.5 text-white hover:bg-white/10 disabled:opacity-50"
                  disabled={buying}
                  onClick={() => void checkout()}
                >
                  {buying ? "Opening Stripe…" : "3 generations · $5"}
                </button>
                <UserButton />
              </>
            ) : (
              <button
                className="rounded-lg border border-white/20 px-3 py-1.5 text-white"
                onClick={auth.openSignIn}
              >
                Sign in · 3 free generations
              </button>
            )}
          </div>
        ) : (
          <span>Using your API key</span>
        )}
      </header>
      {message && (
        <div
          role="status"
          className="flex items-center justify-between gap-4 border-b border-amber-200/20 bg-amber-100/10 px-4 py-2 text-sm text-amber-100"
        >
          <span>{message}</span>
          <button aria-label="Dismiss notice" onClick={() => setMessage("")}>
            ×
          </button>
        </div>
      )}
      <main className="studio-editor">
        <EditorBoundary>
          <QueryClientProvider client={queryClient}>
            <CameraTrajectoryPage
              getToken={auth.getToken}
              beforePrepare={ensureAccess}
              beforeGenerate={beforeGenerate}
            />
          </QueryClientProvider>
        </EditorBoundary>
      </main>
    </div>
  );
}
function HostedStudio({ config }: { config: Config }) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const clerk = useClerk();
  const scopedGetToken = useMemo(
    () =>
      Object.assign(() => getToken(), { storageScope: userId || "signed-out" }),
    [getToken, userId],
  );
  if (!isLoaded)
    return <div className="loading-screen">Loading your account…</div>;
  return (
    <Studio
      key={userId || "signed-out"}
      config={config}
      auth={{
        signedIn: !!isSignedIn,
        getToken: scopedGetToken,
        openSignIn: () => clerk.openSignIn(),
        openProfile: () => clerk.openUserProfile(),
      }}
    />
  );
}
export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/config")
      .then((response) => {
        if (!response.ok) throw new Error("Could not load app settings.");
        return response.json();
      })
      .then(setConfig)
      .catch((error) => setError(error.message));
  }, []);
  if (!config)
    return (
      <div className="loading-screen">{error || "Loading Camera Studio…"}</div>
    );
  if (config.mode === "local")
    return <Studio config={config} auth={localAuth} />;
  if (!config.clerkPublishableKey)
    return <div className="loading-screen">Sign-in is not configured.</div>;
  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey}>
      <HostedStudio config={config} />
    </ClerkProvider>
  );
}

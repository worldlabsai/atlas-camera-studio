import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  Aperture,
  ArrowDownToLine,
  Check,
  CloudUpload,
  Code2,
  CreditCard,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  ClerkProvider,
  SignInButton,
  UserButton,
  useAuth,
  useClerk,
  useUser,
} from "@clerk/react";
import { Vector3 } from "three";
import {
  aimAt,
  cameraPose,
  interpolateCameras,
  toCamera,
  type Pose,
} from "./camera";
import { Scene } from "./scene";
import type { Camera, Config, Job } from "./types";
import { decodePointCloud, type PointCloudData } from "./pointcloud";
import "./styles.css";

declare global {
  interface Window {
    Clerk?: { session?: { getToken: () => Promise<string | null> } };
  }
}
const initial = (): Pose => ({
  position: new Vector3(0, 0.3, 4),
  quaternion: aimAt(new Vector3(0, 0.3, 4), new Vector3(0, 0.8, 0)),
});
async function req(
  path: string,
  init?: RequestInit,
  tokenOverride?: string | null,
) {
  const token =
    tokenOverride === undefined
      ? await window.Clerk?.session?.getToken().catch(() => null)
      : tokenOverride;
  const headers = {
    ...((init?.headers as Record<string, string>) || {}),
    ...(token ? { Authorization: "Bearer " + token } : {}),
  };
  const r = await fetch(path, { ...init, headers });
  if (!r.ok)
    throw new Error(
      (await r.json().catch(() => ({}))).error ||
        "Request failed (" + r.status + ")",
    );
  return r;
}
class SceneBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  render() {
    return this.state.failed ? (
      <div className="scene-fallback">
        <Aperture />
        <span>3D preview is unavailable</span>
        <button onClick={() => this.setState({ failed: false })}>
          Reload preview
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
type StudioAuth = {
  isSignedIn?: boolean;
  userId?: string | null;
  phoneStamp?: string;
  getToken: () => Promise<string | null>;
  openSignIn: () => void;
  openUserProfile: () => void;
};
const StudioAuthContext = createContext<StudioAuth>({
  getToken: async () => null,
  openSignIn: () => {},
  openUserProfile: () => {},
});
function Editor({ config }: { config: Config }) {
  const auth = useContext(StudioAuthContext),
    apiReq = async (path: string, init?: RequestInit) =>
      req(path, init, config.mode === "hosted" ? await auth.getToken() : null);
  const identityRef = useRef(auth.userId);
  identityRef.current = auth.userId;
  const selectedPreset = useRef<string | null>(null);
  const [image, setImage] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [cams, setCams] = useState<Camera[]>([toCamera(initial())]),
    [sel, setSel] = useState(0),
    [prompt, setPrompt] = useState(
      "A gentle cinematic camera move, revealing the space with natural parallax.",
    ),
    [seed, setSeed] = useState(Math.floor(Math.random() * 1e9)),
    [jobs, setJobs] = useState<Job[]>([]),
    [poseId, setPoseId] = useState(
      localStorage.getItem("marble-camera-pose-job") || "",
    ),
    [credits, setCredits] = useState(0),
    [verified, setVerified] = useState(false),
    [accountLoaded, setAccountLoaded] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [play, setPlay] = useState(false),
    [progress, setProgress] = useState(0),
    [amount, setAmount] = useState(52),
    [checkoutMessage, setCheckoutMessage] = useState(""),
    [sourceCamera, setSourceCamera] = useState<Camera | null>(null);
  const pose = useMemo(
    () => (cams[sel] ? cameraPose(cams[sel]) : initial()),
    [cams, sel],
  );
  const [pointCloud, setPointCloud] = useState<PointCloudData | null>(null),
    [cloudStatus, setCloudStatus] = useState(""),
    [cloudRetry, setCloudRetry] = useState(0);
  const cloudController = useRef<AbortController | null>(null),
    cloudStarted = useRef(""),
    cameraTouched = useRef(false),
    lastUser = useRef(auth.userId),
    creditsRef = useRef(0);
  const poseReady =
    !!poseId &&
    !!pointCloud &&
    jobs.some(
      (j) => j.id === poseId && j.kind === "pose" && j.status === "succeeded",
    );
  const generationActive = jobs.some(
    (j) =>
      j.kind === "generate" &&
      (j.status === "queued" || j.status === "running"),
  );
  const canGenerate =
    poseReady && !generationActive && !busy && config.apiConfigured !== false;
  const refreshAccount = useCallback(async () => {
    const owner = auth.userId;
    try {
      const a = await (await apiReq("/api/account")).json();
      if (identityRef.current !== owner) return null;
      setCredits(a.credits);
      creditsRef.current = a.credits;
      setVerified(a.phoneVerified);
      setAccountLoaded(true);
      return a.credits as number;
    } catch {
      return null;
    }
  }, [auth.userId, config.mode]);
  const refresh = useCallback(() => {
    const owner = auth.userId;
    return apiReq("/api/jobs")
      .then((r) => r.json())
      .then((items: Job[]) => {
        if (identityRef.current === owner) setJobs(items);
      })
      .catch(() => {});
  }, [auth.userId, config.mode]);
  const ensureAccess = () => {
    if (config.apiConfigured === false) {
      setError(
        "Marble API is not configured yet. See setup or contact the team.",
      );
      return false;
    }
    if (config.mode === "hosted" && !auth.isSignedIn) {
      auth.openSignIn();
      return false;
    }
    if (config.mode === "hosted" && !verified) {
      setError(
        "Verify your phone number before using a generation. Add and verify a number in your account.",
      );
      auth.openUserProfile();
      return false;
    }
    return true;
  };
  useEffect(() => {
    if (lastUser.current !== auth.userId) {
      lastUser.current = auth.userId;
      cloudController.current?.abort();
      cloudStarted.current = "";
      if (image.startsWith("blob:")) URL.revokeObjectURL(image);
      setImage("");
      setFile(null);
      setCams([toCamera(initial())]);
      setSel(0);
      setJobs([]);
      setPoseId("");
      localStorage.removeItem("marble-camera-pose-job");
      localStorage.removeItem("marble-camera-credits-before-checkout");
      setPointCloud(null);
      setCloudStatus("");
      setSourceCamera(null);
      setCredits(0);
      creditsRef.current = 0;
      setVerified(false);
      setAccountLoaded(false);
      setBusy("");
      setError("");
      cameraTouched.current = false;
    }
    if (config.mode === "hosted" && !auth.isSignedIn) {
      cloudController.current?.abort();
      cloudStarted.current = "";
      if (image.startsWith("blob:")) URL.revokeObjectURL(image);
      setImage("");
      setFile(null);
      setCams([toCamera(initial())]);
      setSel(0);
      setJobs([]);
      setPoseId("");
      localStorage.removeItem("marble-camera-pose-job");
      localStorage.removeItem("marble-camera-credits-before-checkout");
      setPointCloud(null);
      setCloudStatus("");
      setSourceCamera(null);
      setCredits(0);
      creditsRef.current = 0;
      setVerified(false);
      setAccountLoaded(false);
      setBusy("");
      setPlay(false);
      cameraTouched.current = false;
      return;
    }
    if (config.mode === "local" || auth.isSignedIn) {
      void refreshAccount();
      refresh();
    }
  }, [auth.userId, auth.isSignedIn, auth.phoneStamp, config.mode]);
  useEffect(() => {
    if (config.mode === "hosted" && !auth.isSignedIn) return;
    const focus = () => {
      void refreshAccount();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [auth.userId, auth.isSignedIn, config.mode, refreshAccount]);
  useEffect(() => {
    if (!window.location.search.includes("checkout=success")) return;
    let checks = 0,
      finished = false;
    const startingCredits = Number(
      localStorage.getItem("marble-camera-credits-before-checkout") ??
        creditsRef.current,
    );
    setCheckoutMessage(
      "Checking payment. Credits appear after payment is confirmed…",
    );
    const poll = window.setInterval(async () => {
      checks++;
      const creditsNow = await refreshAccount();
      if (creditsNow !== null && creditsNow > startingCredits) {
        finished = true;
        localStorage.removeItem("marble-camera-credits-before-checkout");
        setCheckoutMessage("Credits updated.");
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname + window.location.hash,
        );
        window.setTimeout(() => setCheckoutMessage(""), 5000);
        window.clearInterval(poll);
      } else if (checks >= 10) {
        window.clearInterval(poll);
        setCheckoutMessage(
          "Credits have not arrived yet. Refresh your balance in a moment, or contact support if your payment completed.",
        );
      }
    }, 3000);
    return () => {
      if (!finished) window.clearInterval(poll);
    };
  }, [auth.userId, refreshAccount]);
  useEffect(() => {
    if (!jobs.some((j) => j.status === "queued" || j.status === "running"))
      return;
    const id = window.setInterval(() => {
      jobs
        .filter((j) => j.status === "queued" || j.status === "running")
        .forEach((j) =>
          apiReq("/api/jobs/" + j.id)
            .then((r) => r.json())
            .then((x) => {
              if (identityRef.current !== auth.userId) return;
              setJobs((a) => a.map((y) => (y.id === x.id ? x : y)));
              if (x.status === "succeeded" || x.status === "failed")
                void refreshAccount();
              if (x.kind === "pose" && x.status === "succeeded") {
                setPoseId(x.id);
                localStorage.setItem("marble-camera-pose-job", x.id);
              }
              if (
                x.kind === "pose" &&
                (x.status === "queued" || x.status === "running")
              )
                setCloudStatus("Scene depth is processing…");
              if (x.status === "failed") {
                setCloudStatus(
                  "Scene depth failed: " + (x.error || "Job failed"),
                );
                setError(x.error || "Job failed");
              }
            })
            .catch((e) => setError(e.message)),
        );
    }, 3000);
    return () => clearInterval(id);
  }, [jobs, refreshAccount]);
  useEffect(() => {
    const job = jobs.find((j) => j.id === poseId && j.kind === "pose");
    if (!job || job.status !== "succeeded" || cloudStarted.current === poseId)
      return;
    const frame = job.result?.frames?.[0],
      camera = frame?.camera as Camera | undefined;
    if (!camera) {
      setCloudStatus("Pose job finished, but camera metadata is unavailable.");
      return;
    }
    cloudStarted.current = poseId;
    const controller = new AbortController();
    cloudController.current?.abort();
    cloudController.current = controller;
    setCloudStatus("Loading source image and depth…");
    Promise.all([
      apiReq("/api/jobs/" + poseId + "/media?kind=image&frame=0", {
        signal: controller.signal,
      }),
      apiReq("/api/jobs/" + poseId + "/media?kind=depth&frame=0", {
        signal: controller.signal,
      }),
    ])
      .then(async ([rgb, depth]) => {
        const previewBlob = await rgb.clone().blob();
        return decodePointCloud(rgb, depth, camera, controller.signal).then(
          (data) => ({ data, previewBlob }),
        );
      })
      .then(({ data, previewBlob }) => {
        if (controller.signal.aborted) return;
        const previewUrl = URL.createObjectURL(previewBlob);
        setImage(previewUrl);
        setFile(
          new File([previewBlob], "Recovered source image", {
            type: previewBlob.type || "image/jpeg",
          }),
        );
        setPointCloud(data);
        setSourceCamera(camera);
        setCloudStatus(
          "Depth scene ready · " + data.positions.length / 3 + " points",
        );
        if (!cameraTouched.current) {
          const p = cameraPose(camera);
          setCams([toCamera(p, camera.intrinsics)]);
          setSel(0);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setCloudStatus("Couldn’t load depth preview: " + e.message);
      });
  }, [poseId, jobs, cloudRetry]);
  useEffect(() => () => cloudController.current?.abort(), [poseId]);
  useEffect(
    () => () => {
      cloudController.current?.abort();
      if (image.startsWith("blob:")) URL.revokeObjectURL(image);
    },
    [image],
  );
  useEffect(() => {
    if (!play) return;
    const id = window.setInterval(
      () => setProgress((p) => (p >= 1 ? (setPlay(false), 0) : p + 0.012)),
      50,
    );
    return () => clearInterval(id);
  }, [play]);
  const pick = (f: File) => {
    selectedPreset.current = null;
    cloudController.current?.abort();
    cloudStarted.current = "";
    setPointCloud(null);
    setSourceCamera(null);
    setCloudStatus("");
    cameraTouched.current = false;
    setFile(f);
    setImage(URL.createObjectURL(f));
    setPoseId("");
    localStorage.removeItem("marble-camera-pose-job");
    setCams([toCamera(initial())]);
    setSel(0);
    setError("");
  };
  const buildDepth = async () => {
    if (!ensureAccess()) return;
    if (!file) return;
    const owner = auth.userId;
    setBusy("pose");
    setError("");
    try {
      const img = new Image(),
        tempUrl = URL.createObjectURL(file);
      img.src = tempUrl;
      try {
        await img.decode();
      } finally {
        URL.revokeObjectURL(tempUrl);
      }
      const c = document.createElement("canvas");
      c.width = 1280;
      c.height = 720;
      const ctx = c.getContext("2d")!,
        scale = Math.max(1280 / img.width, 720 / img.height);
      ctx.drawImage(
        img,
        (1280 - img.width * scale) / 2,
        (720 - img.height * scale) / 2,
        img.width * scale,
        img.height * scale,
      );
      const blob = await new Promise<Blob>((resolve) =>
        c.toBlob((b) => resolve(b!), "image/jpeg", 0.88),
      );
      const base64 = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.readAsDataURL(blob);
      });
      const j = await (
        await apiReq("/api/jobs/pose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: crypto.randomUUID(),
            image: { base64, mimeType: "image/jpeg" },
          }),
        })
      ).json();
      if (identityRef.current !== owner) return;
      setPoseId(j.id);
      localStorage.setItem("marble-camera-pose-job", j.id);
      setCloudStatus("Scene depth is processing…");
      refresh();
      void refreshAccount();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const generate = async () => {
    if (!ensureAccess()) return;
    if (!canGenerate) {
      setError(
        "Wait for the scene depth to finish loading and any active generation to complete.",
      );
      return;
    }
    if (!poseId) {
      setError("Build scene depth before generating.");
      return;
    }
    if (config.mode === "hosted" && !auth.isSignedIn) {
      auth.openSignIn();
      return;
    }
    if (config.mode === "hosted" && !verified) {
      setError("Verify your phone number to generate.");
      auth.openUserProfile();
      return;
    }
    setBusy("generate");
    setError("");
    try {
      await apiReq("/api/jobs/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: crypto.randomUUID(),
          poseJobId: poseId,
          cameras: interpolateCameras(
            cams.map(cameraPose),
            config.frames || 48,
            cams[0]?.intrinsics,
          ),
          prompt,
          seed,
        }),
      });
      refresh();
      void refreshAccount();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const preset = (name: string, strength = amount) => {
    cameraTouched.current = true;
    selectedPreset.current = name;
    const base = sourceCamera ? cameraPose(sourceCamera) : initial();
    const target = pointCloud
      ? new Vector3(...pointCloud.focus)
      : new Vector3(0, 0.8, 0);
    const depth = pointCloud?.medianDepth ?? 4;
    const amplitude = strength / 100;
    const right = new Vector3(1, 0, 0).applyQuaternion(base.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(base.quaternion);
    const forward = new Vector3(0, 0, -1).applyQuaternion(base.quaternion);
    let positions: Vector3[];
    if (name === "Orbit") {
      const radius = base.position.clone().sub(target);
      positions = [0, 0.5, 1].map((t) =>
        target
          .clone()
          .add(
            radius.clone().applyAxisAngle(up, (t * amplitude * Math.PI) / 6),
          ),
      );
    } else {
      const direction =
        name === "Dolly in" ? forward : name === "Truck right" ? right : up;
      const distance = depth * amplitude * (name === "Dolly in" ? 0.3 : 0.18);
      positions = [
        base.position.clone(),
        base.position.clone().addScaledVector(direction, distance),
      ];
    }
    setCams(
      positions.map((position, i) =>
        toCamera(
          {
            position,
            quaternion:
              i === 0 ? base.quaternion.clone() : aimAt(position, target),
          },
          sourceCamera?.intrinsics ?? cams[0]?.intrinsics,
        ),
      ),
    );
    setSel(0);
  };
  const edit = (axis: "x" | "y" | "z", v: number) => {
    selectedPreset.current = null;
    cameraTouched.current = true;
    const a = [...cams],
      p = cameraPose(a[sel]);
    p.position[axis] = Number.isFinite(v) ? v : 0;
    p.quaternion = aimAt(
      p.position,
      pointCloud ? new Vector3(...pointCloud.focus) : new Vector3(0, 0.8, 0),
    );
    a[sel] = toCamera(p, a[sel]?.intrinsics);
    setCams(a);
  };
  const buyCredits = async () => {
    if (!ensureAccess()) return;
    if (config.mode !== "hosted") {
      setError("Credit packs are available in the hosted studio.");
      return;
    }
    setBusy("checkout");
    setError("");
    localStorage.setItem(
      "marble-camera-credits-before-checkout",
      String(creditsRef.current),
    );
    try {
      const result = await (
        await apiReq("/api/checkout", { method: "POST" })
      ).json();
      if (!result.url)
        throw new Error("Checkout did not return a payment link.");
      window.location.assign(result.url);
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  };
  const resetPath = () => {
    selectedPreset.current = null;
    cameraTouched.current = !!sourceCamera;
    const p = sourceCamera ? cameraPose(sourceCamera) : initial();
    setCams([toCamera(p, sourceCamera?.intrinsics || cams[0]?.intrinsics)]);
    setSel(0);
  };
  const download = async (j: Job) => {
    try {
      const r = await apiReq("/api/jobs/" + j.id + "/video"),
        url = URL.createObjectURL(await r.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = "marble-" + j.id + ".mp4";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Aperture />
          <span>
            MARBLE <i>/</i> CAMERA STUDIO
          </span>
        </div>
        <div className="header-actions">
          {config.repoUrl && (
            <a href={config.repoUrl}>
              <Code2 />
            </a>
          )}
          {config.mode === "hosted" && (
            <span className="credit-pill">
              <Sparkles size={14} />
              {credits} credits
            </span>
          )}
          {config.mode === "hosted" && (
            <button
              className="buy-credits"
              disabled={busy === "checkout" || config.apiConfigured === false}
              onClick={buyCredits}
            >
              {busy === "checkout" ? (
                <LoaderCircle className="spin" />
              ) : (
                <CreditCard size={14} />
              )}
              Buy {config.packCredits} credits ·{" "}
              <span>{"$" + (config.packPriceCents / 100).toFixed(2)}</span>
            </button>
          )}
          {config.mode === "hosted" ? (
            auth.isSignedIn ? (
              <UserButton />
            ) : (
              <SignInButton mode="modal">
                <button className="sign-in">Sign in</button>
              </SignInButton>
            )
          ) : (
            <span className="local-badge">LOCAL</span>
          )}
        </div>
      </header>
      <main>
        <section className="intro">
          <div className="eyebrow">
            <span /> FRAME THE MOMENT
          </div>
          <h1>
            Give your image
            <br />a <em>camera move.</em>
          </h1>
          <p>
            Turn a single frame into a cinematic shot. Shape the camera, find
            the motion, make it yours.
          </p>
        </section>
        {config.mode === "hosted" && (
          <div className="access-notice">
            {!auth.isSignedIn ? (
              <>
                <span>
                  Sign in to prepare a scene and use your {config.freeCredits}{" "}
                  free generations.
                </span>
                <button onClick={() => auth.openSignIn()}>Sign in</button>
              </>
            ) : !accountLoaded ? (
              <span>Checking your account…</span>
            ) : !verified ? (
              <>
                <span>
                  Verify your phone number to prepare a scene and use your free
                  generations.
                </span>
                <button onClick={() => auth.openUserProfile()}>
                  Verify phone
                </button>
              </>
            ) : (
              <span>
                Phone verified · {config.freeCredits} free generations included
              </span>
            )}
          </div>
        )}
        {config.apiConfigured === false && config.mode === "local" && (
          <div className="alert setup-alert">
            Marble API isn’t configured for this local studio yet.{" "}
            <a
              href={
                config.repoUrl
                  ? config.repoUrl + "#run-locally"
                  : "https://atlas-beta.worldlabs.ai/docs/quickstart"
              }
            >
              {config.repoUrl ? "View setup" : "API key setup guide"}
            </a>
          </div>
        )}
        <section className="editor-grid">
          <aside className="panel source-panel">
            <div className="panel-heading">
              <b>
                <span className="step">01</span> Your source
              </b>
              <button
                className="tiny-btn"
                aria-label="Upload source image"
                onClick={() => document.getElementById("file")?.click()}
              >
                <Upload size={15} />
              </button>
            </div>
            <input
              id="file"
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])}
            />
            <div
              className={"source-frame " + (image ? "has-image" : "")}
              onClick={() => !image && document.getElementById("file")?.click()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]);
              }}
              onDragOver={(e) => e.preventDefault()}
            >
              {image ? (
                <>
                  <img src={image} alt="Source image preview" />
                  <span className="image-tag">16:9 PREVIEW</span>
                </>
              ) : (
                <div className="drop-copy">
                  <CloudUpload size={24} />
                  <strong>Drop your image here</strong>
                  <span>or browse from your device</span>
                  <small>JPG, PNG or WebP · cropped to 16:9</small>
                </div>
              )}
            </div>
            <div className="source-meta">
              {file ? "✓ " + file.name : "Start with a single image"}
            </div>
            <button
              className="secondary-button depth-button"
              disabled={!file || !!busy || config.apiConfigured === false}
              onClick={buildDepth}
            >
              {busy === "pose" ? (
                <LoaderCircle className="spin" />
              ) : (
                <Sparkles size={15} />
              )}
              Build scene depth
            </button>
            <div className="cloud-status">
              {cloudStatus ||
                "Depth preview appears here when the scene is ready."}
              {cloudStatus.startsWith("Couldn’t") && (
                <button
                  onClick={() => {
                    cloudStarted.current = "";
                    setCloudRetry((n) => n + 1);
                  }}
                >
                  Retry
                </button>
              )}
            </div>
            <div className="hint-card">
              A clear subject and a little space around it give your camera more
              room to move.
            </div>
          </aside>
          <section className="panel viewport-panel">
            <div className="viewport-head">
              <b>
                <span className="step">02</span> Camera path
              </b>
              <span className="view-controls">
                ● 3D VIEW{" "}
                <button onClick={resetPath} aria-label="Reset camera path">
                  <RotateCcw size={14} />
                </button>
              </span>
            </div>
            <div className="viewport">
              <SceneBoundary>
                <Scene
                  cameras={cams}
                  playing={play}
                  progress={progress}
                  pointCloud={pointCloud}
                />
              </SceneBoundary>
              <div className="scene-caption">
                SCENE PREVIEW{" "}
                <span>
                  {cloudStatus ||
                    String(cams.length) +
                      " WAYPOINT" +
                      (cams.length === 1 ? "" : "S")}
                </span>
              </div>
              <button
                className="play-control"
                aria-label={
                  play ? "Pause camera preview" : "Play camera preview"
                }
                onClick={() => {
                  setProgress(0);
                  setPlay(!play);
                }}
              >
                {play ? <Pause /> : <Play />}
              </button>
              <div className="timeline">
                <div className="timeline-track">
                  <span style={{ width: progress * 100 + "%" }} />
                </div>
                <span>00:0{Math.round(progress * 4)}</span>
                <span>00:04</span>
              </div>
            </div>
            <div className="waypoint-strip">
              {cams.map((_, i) => (
                <button
                  key={i}
                  className={i === sel ? "waypoint selected" : "waypoint"}
                  onClick={() => setSel(i)}
                >
                  ● {String(i + 1).padStart(2, "0")}
                </button>
              ))}
              <button
                className="add-waypoint"
                onClick={() => {
                  const p = cameraPose(cams[sel]);
                  cameraTouched.current = true;
                  setCams((a) => [
                    ...a.slice(0, sel + 1),
                    toCamera(
                      {
                        position: p.position
                          .clone()
                          .add(new Vector3(0.6, 0, -0.2)),
                        quaternion: p.quaternion.clone(),
                      },
                      cams[sel]?.intrinsics,
                    ),
                    ...a.slice(sel + 1),
                  ]);
                  setSel(sel + 1);
                }}
              >
                <Plus size={15} /> Add point
              </button>
            </div>
          </section>
          <aside className="panel motion-panel">
            <div className="panel-heading">
              <b>
                <span className="step">03</span> Shape the move
              </b>
              <span className="optional">OPTIONAL</span>
            </div>
            <div className="preset-grid">
              {["Orbit", "Dolly in", "Truck right", "Rise"].map((p, i) => (
                <button className="preset" onClick={() => preset(p)} key={p}>
                  <span className={"preset-glyph glyph-" + i}>
                    {["◌", "↗", "↔", "↟"][i]}
                  </span>
                  {p}
                </button>
              ))}
            </div>
            <div className="control-divider" />
            <div className="slider-head">
              Movement amount <span>{amount}%</span>
            </div>
            <input
              type="range"
              min="15"
              max="100"
              value={amount}
              onChange={(e) => {
                const amount = +e.target.value;
                setAmount(amount);
                if (selectedPreset.current)
                  preset(selectedPreset.current, amount);
              }}
            />
            <div className="range-labels">
              <span>SUBTLE</span>
              <span>BOLD</span>
            </div>
            <div className="control-divider" />
            <div className="waypoint-head">
              Waypoint {String(sel + 1).padStart(2, "0")}
              <button
                disabled={cams.length < 2}
                aria-label="Delete selected waypoint"
                onClick={() => {
                  cameraTouched.current = true;
                  setCams((a) => a.filter((_, i) => i !== sel));
                  setSel(Math.max(0, sel - 1));
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="axis-fields">
              {(["x", "y", "z"] as const).map((axis) => (
                <label key={axis}>
                  {axis.toUpperCase()}
                  <input
                    type="number"
                    step=".1"
                    value={pose.position[axis].toFixed(2)}
                    onChange={(e) => edit(axis, +e.target.value)}
                  />
                </label>
              ))}
            </div>
            <p className="drag-note">
              Select a waypoint to adjust its position.
            </p>
          </aside>
        </section>
        <section className="generation">
          <div className="generation-top">
            <b>
              <span className="step">04</span> Make it move
            </b>
            <span className="duration">4 SEC · 48 FRAMES · 12 FPS</span>
          </div>
          <div className="generate-row">
            <div className="prompt-wrap">
              <Sparkles />
              <textarea
                aria-label="Shot description"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            <div className="seed-wrap">
              <label>SEED</label>
              <input
                aria-label="Seed"
                type="number"
                value={seed}
                onChange={(e) => setSeed(+e.target.value)}
              />
              <button
                aria-label="Randomize seed"
                onClick={() => setSeed(Math.floor(Math.random() * 1e9))}
              >
                ↻
              </button>
            </div>
            <button
              className="generate-button"
              disabled={!canGenerate}
              onClick={generate}
            >
              {busy === "generate" ? (
                <LoaderCircle className="spin" />
              ) : (
                <Sparkles />
              )}
              Generate {config.mode === "hosted" && <span>{credits} left</span>}
            </button>
          </div>
          <div className="generation-foot">
            {config.mode === "hosted" && !verified
              ? "Verify your phone number before preparing or generating."
              : poseReady
                ? "Your source stays yours. Generated with your camera path and prompt."
                : cloudStatus || "Prepare a scene depth map before generating."}
            {generationActive && " A generation is already in progress."}
          </div>
        </section>
        {checkoutMessage && (
          <div className="alert success">{checkoutMessage}</div>
        )}
        {error && (
          <div className="alert error">
            {error}
            <button onClick={() => setError("")}>
              <X />
            </button>
          </div>
        )}
        <section className="results">
          <div className="results-heading">
            <div>
              <h2>Your films</h2>
              <p>Finished shots land here, ready to download.</p>
            </div>
            <button onClick={refresh}>
              Refresh <RotateCcw size={13} />
            </button>
          </div>
          {jobs.filter((j) => j.kind === "generate").length ? (
            <div className="film-list">
              {jobs
                .filter((j) => j.kind === "generate")
                .map((j) => (
                  <article className="film-card" key={j.id}>
                    <div className="film-thumb">
                      <Aperture />
                      {j.status === "queued" || j.status === "running" ? (
                        <span className="processing">
                          <LoaderCircle className="spin" /> Rendering
                        </span>
                      ) : j.status === "succeeded" ? (
                        <span className="ready-tag">
                          <Check /> Ready
                        </span>
                      ) : (
                        <span>Failed</span>
                      )}
                    </div>
                    <div className="film-info">
                      <strong>Camera move</strong>
                      <span>{new Date(j.createdAt).toLocaleString()}</span>
                    </div>
                    {j.status === "succeeded" && (
                      <button
                        className="download-btn"
                        onClick={() => download(j)}
                      >
                        <ArrowDownToLine /> MP4
                      </button>
                    )}
                  </article>
                ))}
            </div>
          ) : (
            <div className="empty-results">
              <Aperture /> Your first film is waiting to be made.
            </div>
          )}
        </section>
      </main>
      <footer>
        <span>MARBLE CAMERA STUDIO</span>
        <span>Move through the moment.</span>
        <nav className="legal-links">
          <a
            href="https://www.worldlabs.ai/terms-of-service"
            target="_blank"
            rel="noreferrer"
          >
            Terms
          </a>
          <a
            href="https://www.worldlabs.ai/privacy-policy"
            target="_blank"
            rel="noreferrer"
          >
            Privacy
          </a>
          <a href="mailto:support@worldlabs.ai">Need a hand?</a>
        </nav>
      </footer>
    </div>
  );
}
function HostedEditor({ config }: { config: Config }) {
  const auth = useAuth(),
    clerk = useClerk(),
    user = useUser();
  if (!auth.isLoaded)
    return <div className="loading-screen">Loading your account…</div>;
  const value: StudioAuth = {
    isSignedIn: auth.isSignedIn,
    userId: auth.userId,
    phoneStamp: user.user?.phoneNumbers
      .map((p) => p.id + ":" + p.verification?.status)
      .join(","),
    getToken: () => auth.getToken(),
    openSignIn: () => clerk.openSignIn(),
    openUserProfile: () => clerk.openUserProfile(),
  };
  return (
    <StudioAuthContext.Provider value={value}>
      <Editor key={auth.userId || "signed-out"} config={config} />
    </StudioAuthContext.Provider>
  );
}
export default function App() {
  const [config, setConfig] = useState<Config | null>(null),
    [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error("config");
        return r.json();
      })
      .then(setConfig)
      .catch(() => setFailed(true));
  };
  useEffect(load, []);
  if (!config)
    return (
      <div className="loading-screen">
        <Aperture />
        {failed ? (
          <>
            <span>Camera Studio couldn’t connect.</span>
            <button className="sign-in" onClick={load}>
              Try again
            </button>
          </>
        ) : (
          "Preparing your studio…"
        )}
      </div>
    );
  return config.mode === "hosted" && config.clerkPublishableKey ? (
    <ClerkProvider publishableKey={config.clerkPublishableKey}>
      <HostedEditor config={config} />
    </ClerkProvider>
  ) : (
    <StudioAuthContext.Provider
      value={{
        isSignedIn: false,
        getToken: async () => null,
        openSignIn: () => {},
        openUserProfile: () => {},
      }}
    >
      <Editor config={config} />
    </StudioAuthContext.Provider>
  );
}

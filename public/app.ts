import { token } from "./session.js";
import { api } from "./api.js";
import type { ApiResponses } from "./api.js";
import type { Snapshot, Ref, Content, BytePage, Field } from "../lib/types.js";
import type {
  UiElement,
  Point,
  Position,
  Edge,
  Inspector,
} from "./ui-types.js";
import { errorMessage } from "./errors.js";
import { translations } from "./i18n.js";

type InputId = "file-search" | "scrubber";
type SelectId = "speed" | "diff-parent";
type ButtonId = "tree-up";
function $<K extends string>(
  id: K,
): K extends InputId
  ? HTMLInputElement
  : K extends SelectId
    ? HTMLSelectElement
    : K extends ButtonId
      ? HTMLButtonElement
      : UiElement {
  // Static controls are guaranteed by index.html; dynamic callers check presence.
  return document.getElementById(id) as K extends InputId
    ? HTMLInputElement
    : K extends SelectId
      ? HTMLSelectElement
      : K extends ButtonId
        ? HTMLButtonElement
        : UiElement;
}
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const short = (oid?: string | null) => oid?.slice(0, 7) || "—";
const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
let language: "zh" | "en" =
  localStorage.getItem("gitv-language") === "en" ? "en" : "zh";
const t = (key: string) =>
  (translations[language] as Record<string, string>)[key] || key;
let snapshot: Snapshot,
  latest: Snapshot | undefined,
  history: ApiResponses["history"] = [],
  live = true,
  classroom = false,
  selected: string | null | undefined,
  treeStack: { name: string; oid: string }[] = [],
  treeData: ApiResponses["tree"] | null = null,
  treeRequest = 0;
let transform = { x: 0, y: 0, scale: 1 },
  positions = new Map<string, Position>(),
  edges: Edge[] = [],
  graphBounds = { width: 600, height: 300 };
let inspector: Inspector | null = null,
  playback: number | undefined,
  returnFocus: Element | null = null,
  fileFilter = "";
let toastTimer: number | undefined;
const revealed = new Set<string>(),
  objectContexts = new Map<string, { hidden: boolean; name: string }>();
function toast(message: string) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ($("toast").hidden = true), 4500);
}
function action<A extends unknown[]>(fn: (...args: A) => unknown) {
  return (...args: A) =>
    Promise.resolve()
      .then(() => fn(...args))
      .catch((e) => toast(errorMessage(e)));
}
function localize() {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document
    .querySelectorAll<UiElement>("[data-i18n]")
    .forEach((el) => (el.textContent = t(el.dataset.i18n || "")));
  $("language").textContent = language === "zh" ? "EN" : "中文";
  if (snapshot) {
    render(snapshot, false);
    renderTimeline();
    if (inspector) renderInspector();
  }
}
$("language").onclick = () => {
  language = language === "zh" ? "en" : "zh";
  localStorage.setItem("gitv-language", language);
  localize();
};
$("fullscreen").onclick = action(() =>
  document.fullscreenElement
    ? document.exitFullscreen()
    : document.documentElement.requestFullscreen(),
);
$("classroom").onclick = () => {
  classroom = !classroom;
  $("classroom").classList.toggle("active", classroom);
  renderGraph(false);
  renderFiles();
  if (treeData) renderTree();
};
document.querySelectorAll<UiElement>("[data-tab]").forEach(
  (button) =>
    (button.onclick = () => {
      document
        .querySelectorAll<UiElement>("[data-tab]")
        .forEach((b) => b.classList.toggle("active", b === button));
      document
        .querySelectorAll<UiElement>(".tab-page")
        .forEach((p) => (p.hidden = p.id !== button.dataset.tab));
    }),
);

function render(s: Snapshot, animate = true) {
  const followHead = !snapshot || selected === snapshot.head?.oid;
  snapshot = s;
  if (followHead) selected = s.head?.oid;
  document.title = `gitv · ${s.name}`;
  $("repo-name").textContent = s.name;
  $("repo-path").textContent = s.root;
  $("branch").textContent =
    s.head?.target?.replace("refs/heads/", "") || `HEAD ${short(s.head?.oid)}`;
  $("commit-count").textContent = String(s.commits.length);
  $("file-count").textContent = String(s.fileCount);
  $("reflog-count").textContent = String(s.reflog.length);
  if (s.warnings.length) {
    $("warning").hidden = false;
    $("warning").textContent = s.warnings.join(" · ");
  } else $("warning").hidden = true;
  if (!selected || !s.commits.some((c) => c.oid === selected))
    selected = s.head?.oid || s.commits[0]?.oid;
  renderGraph(animate);
  renderFiles(animate);
  renderOperation();
  renderReflog();
  renderStorage();
  for (const f of s.files)
    for (const entry of f.stages)
      objectContexts.set(entry.oid, { hidden: f.hidden, name: f.path });
  const rootTree = s.commits.find((c) => c.oid === selected)?.tree;
  if (rootTree && (!treeStack.length || treeStack[0].oid !== rootTree)) {
    treeStack = [{ name: "/", oid: rootTree }];
    loadTree();
  }
  if (!rootTree) {
    treeStack = [];
    treeData = null;
    $("tree-cards").innerHTML = `<p class="subtle">${t("empty")}</p>`;
  }
}
function graphLayout() {
  const byId = new Map(snapshot.commits.map((c) => [c.oid, c])),
    depth = new Map<string, number>(),
    lanes = new Map<string, number>();
  const rank = (oid: string, visited = new Set<string>()): number => {
    if (depth.has(oid)) return depth.get(oid)!;
    if (visited.has(oid)) return 0;
    const c = byId.get(oid);
    if (!c) return -1;
    const n =
      Math.max(
        -1,
        ...c.parents.map((p) => rank(p, new Set(visited).add(oid))),
      ) + 1;
    depth.set(oid, n);
    return n;
  };
  let lane = 0;
  const assign = (start?: string | null) => {
    let oid = start,
      did = false;
    while (oid && byId.has(oid) && !lanes.has(oid)) {
      lanes.set(oid, lane);
      did = true;
      oid = byId.get(oid)!.parents[0];
    }
    if (did) lane++;
  };
  assign(snapshot.head?.oid);
  for (const ref of snapshot.refs) assign(ref.oid);
  for (const c of snapshot.commits) assign(c.oid);
  for (const c of snapshot.commits)
    if (!positions.has(c.oid) || !positions.get(c.oid)!.manual)
      positions.set(c.oid, {
        x: 65 + rank(c.oid) * 238,
        y: 83 + (lanes.get(c.oid) || 0) * 142,
        manual: false,
      });
  for (const [index, tag] of (snapshot.tags || []).entries()) {
    const parent = positions.get(tag.object)!;
    if (parent && !positions.get(tag.oid)?.manual)
      positions.set(tag.oid, {
        x: parent.x + 105,
        y: 92 + (lane + index) * 100,
        manual: false,
      });
  }
  const visible = [
    ...snapshot.commits.map((c) => ({ ...positions.get(c.oid)!, height: 120 })),
    ...(snapshot.tags || [])
      .filter((c) => positions.has(c.oid))
      .map((c) => ({ ...positions.get(c.oid)!, height: 82 })),
  ];
  graphBounds = {
    width: Math.max(500, ...visible.map((p) => p.x + 250)),
    height: Math.max(280, ...visible.map((p) => p.y + p.height)),
  };
}
function refHtml(ref: Ref) {
  return `<button class="ref ${ref.name === "HEAD" ? "head" : ref.name.startsWith("refs/tags/") ? "tag" : ""}" data-meta="${esc(ref.source)}">${esc(ref.name.replace(/^refs\/(heads|remotes|tags)\//, ""))}</button>`;
}
function renderGraph(animate = false) {
  const oldRefs = new Map(
    [...$("nodes").querySelectorAll<UiElement>("[data-meta]")].map((b) => [
      b.textContent,
      b.getBoundingClientRect(),
    ]),
  );
  graphLayout();
  const container = $("nodes"),
    existing = new Map(
      [...container.querySelectorAll<UiElement>(":scope > *")].map((n) => [
        n.dataset.oid!,
        n,
      ]),
    ),
    present = new Set();
  for (const c of snapshot.commits) {
    present.add(c.oid);
    let node = existing.get(c.oid),
      fresh = !node;
    if (!node) {
      node = document.createElement("article");
      node.dataset.oid! = c.oid;
      node.tabIndex = 0;
      node.setAttribute("role", "button");
      container.append(node);
    }
    const pending = classroom && !revealed.has(c.oid),
      point = positions.get(c.oid)!,
      refs = snapshot.refs.filter((r) => r.oid === c.oid);
    node.className = `node ${selected === c.oid ? "selected" : ""} ${fresh && animate ? "enter" : ""} ${pending ? "reveal-pending" : ""} ${!refs.length && snapshot.mappings.some((m) => m.old === c.oid) ? "ghost" : ""}`;
    node.style.left = `${point.x}px`;
    node.style.top = `${point.y}px`;
    node.innerHTML = `<div class="refs">${refs.map(refHtml).join("")}</div><div class="oid">${short(c.oid)}</div><button class="node-bytes">bytes ↗</button><div class="subject">${pending ? t("pending") : esc(c.subject || "(empty)")}</div>`;
    node.setAttribute("aria-label", `${c.subject || c.oid}`);
    node.querySelectorAll<UiElement>("[data-meta]").forEach(
      (b) =>
        (b.onclick = action((e) => {
          e.stopPropagation();
          return openMeta(b.dataset.meta!);
        })),
    );
    node.querySelector<UiElement>(".node-bytes")!.onclick = action((e) => {
      e.stopPropagation();
      return openObject(c.oid);
    });
    node.onclick = action(async (e) => {
      if (node.dragged || (e.target as Element).closest("button")) return;
      selected = c.oid;
      renderGraph(false);
      treeStack = [{ name: "/", oid: c.tree }];
      await loadTree();
      if (pending) await openObject(c.oid);
    });
    node.onkeydown = (e) => {
      if (e.key === "Enter") node.click();
    };
    enableNodeDrag(node, c.oid);
  }
  for (const tag of snapshot.tags || []) {
    const point = positions.get(tag.oid)!;
    if (!point) continue;
    present.add(tag.oid);
    let node = existing.get(tag.oid);
    if (!node) {
      node = document.createElement("article");
      node.dataset.oid != tag.oid;
      container.append(node);
    }
    node.className = "node tag-node";
    node.style.left = `${point.x}px`;
    node.style.top = `${point.y}px`;
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", tag.name);
    node.innerHTML = `<div class="oid">tag · ${short(tag.oid)}</div><div class="subject">${esc(tag.name.replace("refs/tags/", ""))}</div><button class="node-bytes">bytes ↗</button>`;
    node.onclick = action(() => {
      if (!node.dragged) return openObject(tag.oid);
    });
    node.onkeydown = (e) => {
      if (e.key === "Enter") node.click();
    };
    enableNodeDrag(node, tag.oid);
  }
  for (const [oid, node] of existing)
    if (!present.has(oid)) {
      node.classList.add("leaving");
      window.setTimeout(() => node.remove(), 700);
    }
  edges = snapshot.commits.flatMap((c) =>
    c.parents
      .filter((p) => positions.has(p))
      .map((p) => ({ from: p, to: c.oid, selected: c.oid === selected })),
  );
  for (const tag of snapshot.tags || [])
    if (positions.has(tag.oid) && positions.has(tag.object))
      edges.push({ from: tag.oid, to: tag.object, tag: true });
  for (const m of snapshot.mappings)
    if (positions.has(m.old) && positions.has(m.oid))
      edges.push({ from: m.old, to: m.oid, mapping: true, exact: m.exact });
  renderEdges();
  $("empty").hidden = !!snapshot.commits.length;
  applyTransform();
  $("mapping-evidence")?.remove();
  if (snapshot.mappings.length) {
    const button = document.createElement("button");
    button.id = "mapping-evidence";
    button.className = "mapping-evidence";
    button.textContent = `rebase · ${snapshot.mappings.length} ↗`;
    button.onclick = () =>
      showInspector("rebase", t("observed"), {
        kind: "custom",
        html: `<table class="fields">${snapshot.mappings.map((m) => `<tr><td>${short(m.old)}</td><td>→</td><td>${short(m.oid)}</td><td>${t(m.exact ? "exact" : "inferred")}</td></tr>`).join("")}</table>`,
      });
    $("viewport").append(button);
  }
  if (animate)
    for (const b of container.querySelectorAll<UiElement>("[data-meta]")) {
      const old = oldRefs.get(b.textContent),
        now = b.getBoundingClientRect();
      if (old && (old.x !== now.x || old.y !== now.y)) {
        b.style.setProperty(
          "--move-x",
          `${(old.x - now.x) / transform.scale}px`,
        );
        b.style.setProperty(
          "--move-y",
          `${(old.y - now.y) / transform.scale}px`,
        );
        b.classList.add("ref-moving");
      }
    }
}
function renderEdges() {
  $("connections").innerHTML =
    '<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1 1 L7 4 L1 7" fill="none" stroke="#9cad99"/></marker></defs>' +
    edges
      .map((e) => {
        const a = positions.get(e.from)!,
          b = positions.get(e.to)!;
        const x1 = a.x + 196,
          y1 = a.y + 44,
          x2 = b.x,
          y2 = b.y + 44,
          mid = (x1 + x2) / 2;
        return `<path ${e.mapping || e.tag ? "marker-end" : "marker-start"}="url(#arrow)" class="edge ${e.selected ? "selected" : ""} ${e.mapping ? "mapping" : ""} ${e.exact ? "exact" : ""}" d="${e.tag ? `M ${a.x + 86} ${a.y} L ${b.x + 98} ${b.y + 88}` : `M ${x1} ${y1} C ${mid} ${y1},${mid} ${y2},${x2} ${y2}`}"/>`;
      })
      .join("");
}
function applyTransform() {
  $("world").style.transform =
    `translate(${transform.x}px,${transform.y}px) scale(${transform.scale})`;
  $("zoom-label").textContent = `${Math.round(transform.scale * 100)}%`;
}
function fit() {
  const v = $("viewport");
  transform.scale = Math.min(
    1,
    (v.clientWidth - 35) / graphBounds.width,
    (v.clientHeight - 20) / graphBounds.height,
  );
  transform.scale = Math.max(0.22, transform.scale);
  transform.x = Math.max(
    0,
    (v.clientWidth - graphBounds.width * transform.scale) / 2,
  );
  transform.y = 5;
  applyTransform();
}
function zoom(
  factor: number,
  x = $("viewport").clientWidth / 2,
  y = $("viewport").clientHeight / 2,
) {
  const old = transform.scale;
  transform.scale = Math.max(0.15, Math.min(2.4, old * factor));
  const ratio = transform.scale / old;
  transform.x = x - (x - transform.x) * ratio;
  transform.y = y - (y - transform.y) * ratio;
  applyTransform();
}
$("fit").onclick = fit;
$("zoom-in").onclick = () => zoom(1.2);
$("zoom-out").onclick = () => zoom(1 / 1.2);
$("viewport").addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const r = $("viewport").getBoundingClientRect();
    zoom(Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
  },
  { passive: false },
);
$("viewport").onpointerdown = (e) => {
  if ((e.target as Element).closest(".node") || e.button !== 0) return;
  const x = e.clientX,
    y = e.clientY,
    origin = { ...transform };
  $("viewport").setPointerCapture(e.pointerId);
  const move = (event: PointerEvent) => {
    transform.x = origin.x + event.clientX - x;
    transform.y = origin.y + event.clientY - y;
    applyTransform();
  };
  const end = () => {
    $("viewport").removeEventListener("pointermove", move);
    $("viewport").removeEventListener("pointerup", end);
  };
  $("viewport").addEventListener("pointermove", move);
  $("viewport").addEventListener("pointerup", end);
};
function enableNodeDrag(node: UiElement, oid: string) {
  node.onpointerdown = (e) => {
    if ((e.target as Element).closest("button") || e.button !== 0) return;
    e.stopPropagation();
    node.dragged = false;
    const start = { x: e.clientX, y: e.clientY },
      origin = { ...positions.get(oid)! };
    node.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => {
      const dx = (event.clientX - start.x) / transform.scale,
        dy = (event.clientY - start.y) / transform.scale;
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      node.dragged = true;
      node.classList.add("dragging");
      positions.set(oid, { x: origin.x + dx, y: origin.y + dy, manual: true });
      node.style.left = `${origin.x + dx}px`;
      node.style.top = `${origin.y + dy}px`;
      renderEdges();
    };
    const end = () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", end);
      node.classList.remove("dragging");
      window.setTimeout(() => (node.dragged = false), 100);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", end);
  };
}

const cardOffsets = new Map<string, Point>();
function enableCardDrag(card: UiElement, key: string) {
  const saved = cardOffsets.get(key);
  if (saved) card.style.transform = `translate(${saved.x}px,${saved.y}px)`;
  card.onpointerdown = (e) => {
    if (e.button !== 0 || (e.target as Element).closest("input,button")) return;
    const start = { x: e.clientX, y: e.clientY },
      origin = cardOffsets.get(key) || { x: 0, y: 0 };
    card.dragged = false;
    card.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => {
      const dx = event.clientX - start.x,
        dy = event.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) < 5) return;
      card.dragged = true;
      card.style.zIndex = "5";
      const p = { x: origin.x + dx, y: origin.y + dy };
      cardOffsets.set(key, p);
      card.style.transform = `translate(${p.x}px,${p.y}px)`;
    };
    const end = () => {
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", end);
      card.style.zIndex = "";
      setTimeout(() => (card.dragged = false), 100);
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", end);
  };
}

async function loadTree(offset = 0) {
  if (!treeStack.length) return;
  const request = ++treeRequest;
  try {
    const data = await api("tree", { oid: treeStack.at(-1)!.oid, offset });
    if (request !== treeRequest) return;
    treeData = data;
    renderTree();
  } catch (e) {
    $("tree-cards").innerHTML = `<p class="subtle">${esc(errorMessage(e))}</p>`;
  }
}
function previewHtml(c?: Content | null) {
  if (!c) return "<pre>—</pre>";
  if (c.image) return `<img src="${c.image}" alt="">`;
  if (c.binary) {
    const max = Math.max(...c.histogram, 1);
    return `<div class="histogram">${c.histogram.map((n) => `<i style="height:${Math.max(3, (n / max) * 100)}%"></i>`).join("")}</div><div class="binary-label">${t("binary")} · ${size(c.total)}</div>`;
  }
  return `<pre>${esc(c.text)}</pre>`;
}
function renderTree() {
  if (!treeData) return;
  $("tree-count").textContent = String(treeData.total);
  $("tree-breadcrumb").innerHTML =
    treeStack
      .map((item, i) => `<button data-depth="${i}">${esc(item.name)}</button>`)
      .join("<span>/</span>") + `<span>· ${short(treeData.oid)}</span>`;
  $("tree-breadcrumb")
    .querySelectorAll<UiElement>("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          treeStack = treeStack.slice(0, Number(b.dataset.depth) + 1);
          loadTree();
        }),
    );
  $("tree-up").disabled = treeStack.length < 2;
  const groups = new Map<string, ApiResponses["tree"]["entries"]>();
  for (const e of treeData.entries) {
    if (!groups.has(e.oid)) groups.set(e.oid, []);
    groups.get(e.oid)!.push(e);
  }
  $("tree-cards").innerHTML =
    [...groups]
      .map(([oid, entries]) => {
        const e = entries[0],
          pending = classroom && !revealed.has(oid);
        objectContexts.set(oid, { hidden: e.hidden, name: e.name });
        return `<article class="object-card ${e.type}" tabindex="0" role="button" data-oid="${oid}" data-name="${esc(e.name)}" data-type="${e.type}"><header><span class="name"><span class="file-icon">${e.type === "tree" ? "▱" : e.type === "gitlink" ? "↗" : "▤"}</span>${esc(entries.map((e) => e.name).join(" · "))}</span><span class="muted">${e.type === "tree" ? "↳" : "↗"}</span></header>${pending ? `<pre>${t("pending")}</pre>` : e.hidden ? `<pre>${t("hidden")}</pre>` : e.type === "tree" ? "<pre>tree →</pre>" : previewHtml(e.preview)}<footer><span>${short(oid)}</span><span>${e.mode} · ${e.size ? size(e.size) : e.type}</span></footer></article>`;
      })
      .join("") +
    (treeData.offset + treeData.entries.length < treeData.total
      ? `<button id="more-tree">${t("more")} →</button>`
      : "");
  $("tree-cards")
    .querySelectorAll<UiElement>("[data-oid]")
    .forEach((card) => {
      card.onclick = action(async () => {
        if (card.dragged) return;
        const { oid, type, name } = card.dataset;
        if (!oid || !name) return;
        if (type === "tree" && (!classroom || revealed.has(oid))) {
          treeStack.push({ name, oid });
          await loadTree();
        } else await openObject(oid);
      });
      card.onkeydown = (e) => {
        if (e.key === "Enter") card.click();
      };
      enableCardDrag(card, card.dataset.oid!);
    });
  if ($("more-tree"))
    $("more-tree").onclick = () => loadTree((treeData?.offset || 0) + 60);
}
$("tree-up").onclick = () => {
  if (treeStack.length > 1) {
    treeStack.pop();
    loadTree();
  }
};
$("tree-inspect").onclick = action(() => treeData && openObject(treeData.oid));
function statusBadge(letter: string) {
  const classes: Record<string, string> = {
    M: "modified",
    A: "added",
    "?": "added",
    D: "deleted",
    U: "conflict",
    R: "modified",
    C: "added",
  };
  return `<span class="status ${classes[letter] || ""}">${esc(letter === " " ? "·" : letter || "·")}</span>`;
}
function renderFiles(animate = false) {
  const visible = snapshot.files.filter((f) =>
    f.path.toLowerCase().includes(fileFilter.toLowerCase()),
  );
  $("file-list").innerHTML =
    `<div class="file-filter"><input id="file-search" placeholder="${t("search")}" value="${esc(fileFilter)}"></div><div class="file-table-head"><span>${t("file")}</span><span>index</span><span>worktree</span><span>bytes</span></div>` +
    visible
      .map(
        (f) =>
          `<div class="file-row ${animate && snapshot.changes.files.includes(f.path) ? "changed" : ""}" role="button" tabindex="0" data-path="${esc(f.path)}"><span class="file-name">${f.hidden ? "◈ " : ""}${esc(f.path)}</span>${statusBadge(f.status[0])}${statusBadge(f.status[1])}<span class="size">${size(f.size)}</span></div>`,
      )
      .join("") +
    (!visible.length
      ? `<p class="subtle" style="padding:14px">${t("noFiles")}</p>`
      : "") +
    (snapshot.fileCount > snapshot.files.length
      ? `<button id="more-files">${t("more")} (${snapshot.fileCount - snapshot.files.length})</button>`
      : "");
  $("file-search").oninput = (e) => {
    const at = (e.target as HTMLInputElement).selectionStart;
    fileFilter = (e.target as HTMLInputElement).value;
    renderFiles();
    $("file-search").focus();
    $("file-search").setSelectionRange(at, at);
  };
  $("file-list")
    .querySelectorAll<UiElement>("[data-path]")
    .forEach((row) => {
      row.onclick = action(() => {
        if (!row.dragged) return openFile(row.dataset.path!);
      });
      row.onkeydown = (e) => {
        if (e.key === "Enter") row.click();
      };
      enableCardDrag(row, `file:${row.dataset.path!}`);
    });
  if ($("more-files")) $("more-files").onclick = $("more").onclick;
}
$("more").onclick = action(async () => {
  const s = await api("more");
  if (live) render(s);
});
async function openIgnored(prefix = "", offset = 0) {
  const files = await api("ignored", { prefix, offset });
  showInspector(t("ignored"), "working tree", {
    kind: "custom",
    html: `<div class="lens-buttons">${files.map((p) => `<button data-ignored="${esc(p)}">${esc(p)} ${p.endsWith("/") ? "↳" : "↗"}</button>`).join("") || "∅"}</div>${files.length === 300 ? `<button id="ignored-more">${t("more")} →</button>` : ""}`,
  });
  $("inspector-body")
    .querySelectorAll<UiElement>("[data-ignored]")
    .forEach(
      (b) =>
        (b.onclick = action(() =>
          b.dataset.ignored!.endsWith("/")
            ? openIgnored(b.dataset.ignored!)
            : openFile(b.dataset.ignored!),
        )),
    );
  if ($("ignored-more"))
    $("ignored-more").onclick = action(() => openIgnored(prefix, offset + 300));
}
$("ignored").onclick = action(() => openIgnored());
function renderOperation() {
  const o = snapshot.operation,
    merge = snapshot.refs.find((r) => r.name === "MERGE_HEAD");
  $("operation").hidden = !o && !merge;
  if (!o && !merge) return;
  if (!o) {
    $("operation").innerHTML =
      `<span class="pill coral">merge</span> ${short(snapshot.head?.oid)} ← ${short(merge?.oid)}`;
    return;
  }
  const files = o.files,
    step = files.msgnum || files.next || "",
    total = files.end || files.last || "";
  $("operation").innerHTML =
    `<details><summary><span class="pill coral">${o.type}</span><span>${esc(files["head-name"]?.trim().replace("refs/heads/", "") || "")}</span><span>${short(files["orig-head"]?.trim())} → ${short(files.onto?.trim())}</span><span>${esc(step.trim())} / ${esc(total.trim())}</span><span>⌄</span></summary><div class="lens-buttons">${Object.keys(
      files,
    )
      .map(
        (name) =>
          `<button data-meta="${esc(o.directory + "/" + name)}">${esc(name)} ↗</button>`,
      )
      .join(
        "",
      )}</div><pre>${esc((files.done || "") + (files["git-rebase-todo"] || files.todo || ""))}</pre></details>`;
  $("operation")
    .querySelectorAll<UiElement>("[data-meta]")
    .forEach((b) => (b.onclick = action(() => openMeta(b.dataset.meta!))));
}
function renderReflog() {
  $("reflog").innerHTML =
    `<div class="canvas-heading"><span>HEAD reflog</span><button id="reflog-bytes" class="mono">logs/HEAD · bytes ↗</button></div>` +
    snapshot.reflog
      .map(
        (r, i) =>
          `<div class="log-row"><span class="index-number">@{${i}}</span><button data-oid="${r.oid || ""}"><code>${short(r.oid)}</code></button><span>${esc(r.message)}</span><button data-oid="${r.old || ""}" class="muted">← ${short(r.old)}</button></div>`,
      )
      .join("") +
    (!snapshot.reflog.length ? `<p class="subtle">${t("noReflog")}</p>` : "");
  $("reflog-bytes").onclick = action(() => openMeta("logs/HEAD"));
  $("reflog")
    .querySelectorAll<UiElement>("[data-oid]")
    .forEach((b) => (b.onclick = action(() => openObject(b.dataset.oid!))));
}
function renderStorage() {
  $("storage").innerHTML =
    `<h1 style="margin-top:28px">${t("introStorage")}</h1><div class="storage-grid"><button class="storage-card" data-meta="HEAD"><h3>HEAD</h3><p>${esc(snapshot.head?.target || short(snapshot.head?.oid))}</p><span class="mono">bytes ↗</span></button><button class="storage-card" data-meta="index"><h3>index · DIRC</h3><div class="large-count">${snapshot.index.count}</div><p>v${snapshot.index.version || "—"} · ${t("indexEntries")}</p></button><button class="storage-card" data-meta="packed-refs"><h3>packed-refs</h3><p>${snapshot.refs.filter((r) => r.source === "packed-refs").length} refs</p><span class="mono">bytes ↗</span></button>${snapshot.refs
      .filter((r) => r.name !== "HEAD")
      .map(
        (r) =>
          `<button class="storage-card" data-meta="${esc(r.source)}"><h3>${esc(r.name)}</h3><p>${esc(r.oid || r.target)}</p><span class="mono">bytes ↗</span></button>`,
      )
      .join(
        "",
      )}${snapshot.packs.map((p) => `<article class="storage-card"><h3>PACK / .idx</h3><div class="large-count">${p.count}</div><p>${esc(p.name)}</p><p>${t("packed")}</p></article>`).join("")}</div>`;
  $("storage")
    .querySelectorAll<UiElement>("[data-meta]")
    .forEach((b) => (b.onclick = action(() => openMeta(b.dataset.meta!))));
}

const fieldColor = (f: Field) =>
  /oid|object|parent|tree/.test(f.name)
    ? 2
    : /mode|type|signature/.test(f.name)
      ? 0
      : /name|path|size|version/.test(f.name)
        ? 1
        : /flag|NUL|stage/.test(f.name)
          ? 3
          : 4;
function hexView(
  p: Pick<BytePage, "hex" | "offset">,
  fields: Field[] = [],
  max = 512,
) {
  if (!p) return "";
  const bytes = p.hex.match(/../g) || [];
  let rows = "";
  for (let i = 0; i < Math.min(bytes.length, max); i += 16) {
    const group = bytes.slice(i, i + 16);
    rows += `<div class="hex-row"><span class="hex-offset">${(p.offset + i).toString(16).padStart(8, "0")}</span><span class="hex-bytes">${group
      .map((byte, j) => {
        const pos = p.offset + i + j,
          field = fields.findIndex((f) => pos >= f.start && pos < f.end);
        return `<span class="hex-byte ${field >= 0 ? `field-${fieldColor(fields[field])}` : ""}" data-byte="${pos}" data-field="${field}">${byte}</span>`;
      })
      .join(
        "",
      )}${'<span class="hex-byte">  </span>'.repeat(16 - group.length)}</span><span class="hex-ascii">${esc(
      group
        .map((x) => {
          const n = parseInt(x, 16);
          return n >= 32 && n < 127 ? String.fromCharCode(n) : "·";
        })
        .join(""),
    )}</span></div>`;
  }
  return `<div class="hex">${rows || '<span class="muted">∅</span>'}</div>`;
}
function fieldTable(fields: Field[]) {
  return `<table class="fields"><thead><tr><th>${t("range")}</th><th>field</th><th>value</th></tr></thead><tbody>${fields.map((f, i) => `<tr data-field="${i}"><td>${f.start.toString(16)}…${f.end.toString(16)}</td><td><span class="field-label field-${fieldColor(f)}">${esc(f.name)}</span></td><td>${esc(f.value)}</td></tr>`).join("")}</tbody></table>`;
}
function diffHtml(diff?: string | null) {
  if (!diff) return `<p class="subtle">${t("unchanged")}</p>`;
  return `<div class="diff-view">${diff
    .split("\n")
    .map(
      (line) =>
        `<span class="diff-line ${line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : ""}">${esc(line)}</span>`,
    )
    .join("")}</div>`;
}
function contentHtml(c?: Content | null) {
  if (!c) return "∅";
  if (c.image) return `<img class="image-preview" src="${c.image}" alt="">`;
  return c.binary
    ? previewHtml(c) + hexView(c)
    : `<pre class="content-pre">${esc(c.text)}</pre>`;
}
function showInspector(title: string, kind: string, state: Inspector) {
  clearInterval(playback);
  playback = undefined;
  returnFocus = document.activeElement;
  inspector = state;
  $("overlay").hidden = false;
  $("overlay").classList.toggle("file-modal", state.kind === "file");
  $("inspector-title").textContent = title;
  $("inspector-kind").textContent = kind;
  renderInspector();
  $("close-inspector").focus();
}
function closeInspector() {
  clearInterval(playback);
  playback = undefined;
  inspector = null;
  $("overlay").hidden = true;
  if (returnFocus instanceof HTMLElement) returnFocus.focus();
}
$("close-inspector").onclick = closeInspector;
$("overlay").onclick = (e) => {
  if (e.target === $("overlay")) closeInspector();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeInspector();
  if (e.key === "Tab" && inspector) {
    const focusable = [
      ...$("overlay").querySelectorAll<UiElement>(
        'button:not(:disabled),a,input,select,[tabindex="0"]',
      ),
    ].filter((e) => e.offsetParent);
    const first = focusable[0],
      last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      last?.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first?.focus();
      e.preventDefault();
    }
  }
});
async function openObject(oid: string, allow = false) {
  const context = objectContexts.get(oid);
  if (context?.hidden && !allow) {
    showInspector(context.name, "blob", {
      kind: "custom",
      html: `<p class="subtle">${t("sensitiveObject")}</p><button id="reveal-object">${t("reveal")}</button>`,
    });
    $("reveal-object").onclick = action(() => openObject(oid, true));
    return;
  }
  const object = await api("object", { oid });
  showInspector(
    short(oid),
    `${object.type} · ${size(object.size)} · ${object.storage}`,
    { kind: "object", object, step: 0, maxStep: 0, offset: 0, part: "body" },
  );
}
async function openMeta(name: string, offset = 0) {
  const data = await api("meta", { name, id: snapshot.id, offset });
  showInspector(name, t("metadata"), {
    kind: "meta",
    data,
    step: 0,
    maxStep: 0,
  });
}
async function openFile(path: string, offset = 0, reveal = false) {
  const data = await api("file", {
    path,
    id: snapshot.id,
    offset,
    reveal: reveal ? 1 : 0,
  });
  if (
    classroom &&
    !data.hidden &&
    !revealed.has(`file:${path}`) &&
    data.versions.at(-1)?.content
  ) {
    openWorkBytes(data, reveal);
    return;
  }
  showInspector(
    path,
    snapshot.id !== latest?.id ? t("snapshot") : "HEAD → index → working tree",
    { kind: "file", data, offset, reveal },
  );
}
function openWorkBytes(data: ApiResponses["file"], reveal = false) {
  const work = data.versions.at(-1),
    c = work?.content;
  if (!c || !work) return;
  const fields = [
    {
      name: work.symlink
        ? "symlink target"
        : c.binary
          ? "binary bytes"
          : "UTF-8",
      value: `${c.total} bytes`,
      start: c.offset,
      end: c.offset + c.hex.length / 2,
    },
  ];
  showInspector(data.path, "working tree · bytes", {
    kind: "meta",
    step: 0,
    maxStep: 0,
    isWork: true,
    fileData: data,
    reveal,
    data: {
      name: data.path,
      source: work.source || data.path,
      raw: c,
      parsed: { text: c.binary ? c.hex : c.text, fields, links: [] },
    },
  });
}
function renderInspector() {
  if (!inspector) return;
  const state = inspector,
    body = $("inspector-body");
  if (state.kind === "custom") {
    body.innerHTML = state.html;
    return;
  }
  if (state.kind === "file") {
    renderFileInspector();
    return;
  }
  const steps = ["source", "raw", "decode", "parse", "result"];
  body.innerHTML = `<nav class="steps">${steps.map((key, i) => `<button data-step="${i}" class="${state.step === i ? "active" : ""}" ${classroom && i > state.maxStep + 1 ? "disabled" : ""}><span>0${i + 1}</span>${t(key)}</button>`).join("")}</nav><div class="inspect-section" id="inspect-section"></div><div class="inspect-controls"><button id="inspect-back" ${!state.step ? "disabled" : ""}>← ${t("previous")}</button><button id="inspect-play">${playback ? t("stop") : t("play")}</button><select id="speed" aria-label="Playback speed"><option value="2500">1×</option><option value="1200">2×</option><option value="5000">0.5×</option></select><button id="inspect-next">${state.step === 4 ? t("closed") : t("next") + " →"}</button></div>`;
  body
    .querySelectorAll<UiElement>("[data-step]")
    .forEach((b) => (b.onclick = () => setStep(Number(b.dataset.step))));
  $("inspect-back").onclick = () => setStep(Math.max(0, state.step - 1));
  $("inspect-next").onclick = () =>
    state.step === 4 ? closeInspector() : setStep(state.step + 1);
  $("inspect-play").onclick = () => {
    if (playback) {
      clearInterval(playback);
      playback = undefined;
      renderInspector();
    } else {
      const speed = Number($("speed").value);
      playback = window.setInterval(() => {
        if (!inspector || !("step" in inspector) || inspector.step === 4) {
          clearInterval(playback);
          playback = undefined;
          if (inspector) renderInspector();
        } else setStep(inspector.step + 1);
      }, speed);
      $("inspect-play").textContent = t("stop");
    }
  };
  if (state.kind === "object") renderObjectStep();
  else renderMetaStep();
  bindFields();
}
async function setStep(step: number) {
  const state = inspector;
  if (!state || !("step" in state)) return;
  if (state.kind === "object" && step === 3 && state.object.part !== "body") {
    try {
      state.object = await api("object", {
        oid: state.object.oid,
        part: "body",
      });
      state.part = "body";
      state.offset = 0;
    } catch (error) {
      toast(errorMessage(error));
      return;
    }
    if (inspector !== state) return;
  }
  state.step = step;
  state.maxStep = Math.max(step, state.maxStep);
  if (step === 4 && state.kind === "meta" && state.isWork)
    revealed.add(`file:${state.data.name}`);
  if (step === 4 && state.kind === "object") {
    revealed.add(state.object.oid);
    renderGraph(false);
    renderTree();
  }
  renderInspector();
}
function renderObjectStep() {
  const state = inspector;
  if (!state || state.kind !== "object") return;
  const { object: o, step } = state,
    section = $("inspect-section"),
    fields = o.parsed.fields;
  if (step === 0) {
    section.innerHTML = `${o.retained ? `<p class="snapshot-badge">${t("captured")}</p>` : ""}<div class="source-path">${esc(o.source)}</div><div class="source-flow"><span class="pill">${o.storage}</span><span>→</span><span class="pill blue">${t("offset")} ${o.offset}</span><span class="pill">${size(o.raw.total)}</span></div>${o.indexSource ? `<h3>.idx → .pack</h3><div class="source-path">${esc(o.indexSource)}</div>${(o.indexEvidence || []).map((p) => `<h3>${p.label}</h3>${hexView(p)}`).join("")}` : `<h3>.git / objects / ${o.oid.slice(0, 2)} / ${o.oid.slice(2)}</h3>`}`;
  } else if (step === 1) {
    const rawPage = o.part === "raw" ? o.bytes : o.raw;
    section.innerHTML = `${
      o.packHeader
        ? `<h3>PACK · version · object count</h3>${hexView(
            { hex: o.packHeader, offset: 0 },
            [
              { name: "signature", start: 0, end: 4 },
              { name: "version", start: 4, end: 8 },
              { name: "count", start: 8, end: 12 },
            ],
          )}`
        : ""
    }<h3>${t("raw")} · ${o.storage}</h3>${hexView(rawPage)}<div class="byte-pages"><span>${rawPage.offset} / ${o.raw.total} B</span><button id="raw-more">${t("more")} →</button></div>`;
    $("raw-more").onclick = action(() => byteRange("raw"));
  } else if (step === 2) {
    const packedHeader =
      o.storage !== "loose"
        ? `<h3>pack entry → type / size</h3>${hexView({ hex: o.raw.hex.slice(0, o.compressedOffset * 2), offset: o.offset })}<div class="source-flow"><span class="pill">${parseInt(o.raw.hex.slice(0, 2), 16).toString(2).padStart(8, "0")}</span><span>→</span><span class="pill blue">type = ${o.typeCode}</span><span class="pill green">size = ${o.encodedSize}</span><span class="pill">zlib @ ${o.offset + o.compressedOffset}</span></div>`
        : "";
    const delta = o.baseOid
      ? `<h3>${o.storage} → ${t("base")} <button class="pill blue" id="delta-base">${short(o.baseOid)} ↗</button></h3>${hexView(o.delta!)}<h3>${t("instructions")}</h3><table class="fields"><tr><th>delta offset</th><th>op</th><th>source + length</th><th>output offset</th></tr>${(o.instructions || []).map((x) => `<tr><td>${x.start.toString(16)}</td><td>${x.op}</td><td>${x.offset ?? "literal"} + ${x.length}</td><td>→ ${x.output}</td></tr>`).join("")}</table>`
      : "";
    section.innerHTML = `${packedHeader}<h3>${t(o.storage === "loose" ? "decodeLoose" : "decodePack")}</h3>${delta}<div class="source-flow"><span class="pill">${size(o.raw.total)} zlib</span><span>→</span><span class="pill green">${size(o.size)} ${o.type}</span></div>${o.storage !== "loose" ? `<p class="subtle">${t("canonical")}</p>` : ""}${hexView(
      o.canonical,
      [
        { start: 0, end: o.header.indexOf(" "), name: "type" },
        {
          start: o.header.indexOf(" ") + 1,
          end: o.header.length,
          name: "size",
        },
        { start: o.header.length, end: o.header.length + 1, name: "NUL" },
      ],
    )}<div class="verify">${o.algorithm.toUpperCase()}( ${esc(o.header)} ␀ body )<br> = ${o.computed}<br>✓ ${t("match")}</div>`;
    if ($("delta-base"))
      $("delta-base").onclick = action(() => openObject(o.baseOid!));
  } else if (step === 3) {
    section.innerHTML = `<div class="source-flow"><span class="pill">${o.type}</span>${o.type === "tree" ? '<span class="pill green">mode</span><span>20</span><span class="pill amber">name</span><span>00</span><span class="pill blue">raw oid bytes</span>' : ""}</div>${hexView(o.bytes, fields)}<div class="byte-pages"><span>${o.bytes.offset} / ${o.bytes.total} B</span><button id="bytes-more">${t("more")} →</button></div>${fieldTable(fields.slice(0, 90))}`;
    $("bytes-more").onclick = action(() => byteRange("body"));
  } else {
    const links = [
      ...(o.parsed.tree ? [{ name: "tree", oid: o.parsed.tree }] : []),
      ...(o.parsed.parents || []).map((oid) => ({ name: "parent", oid })),
      ...(o.parsed.object ? [{ name: "object", oid: o.parsed.object }] : []),
      ...(o.parsed.entries || []).map((e) => ({ name: e.name, oid: e.oid })),
    ];
    section.innerHTML = `<div class="verify">✓ ${o.type} · ${size(o.size)} · ${short(o.oid)}</div>${o.content ? contentHtml(o.content) : `<pre class="content-pre">${esc(o.parsed.message || "")}</pre>`}<div class="lens-buttons">${links.map((l) => `<button data-link="${l.oid}">${esc(l.name)} · ${short(l.oid)} ↗</button>`).join("")}</div>${o.type === "commit" ? `<h3>${t("diff")} <select id="diff-parent">${(o.parsed.parents?.length ? o.parsed.parents : [""]).map((p) => `<option value="${p}">${short(p)}</option>`).join("")}</select></h3><div id="commit-diff"></div>` : ""}${o.content?.next ? `<button id="content-more">${t("more")} →</button>` : ""}`;
    section
      .querySelectorAll<UiElement>("[data-link]")
      .forEach((b) => (b.onclick = action(() => openObject(b.dataset.link!))));
    if ($("diff-parent")) {
      const getDiff = action(async () => {
        const d = await api("diff", {
          oid: o.oid,
          parent: $("diff-parent").value,
        });
        if ($("commit-diff")) $("commit-diff").innerHTML = diffHtml(d.diff);
      });
      $("diff-parent").onchange = getDiff;
      getDiff();
    }
    if ($("content-more"))
      $("content-more").onclick = action(async () => {
        const next = await api("object", {
          oid: o.oid,
          offset: o.content?.next,
        });
        if (inspector !== state) return;
        state.object = next;
        renderInspector();
      });
  }
}
async function byteRange(part: string) {
  const state = inspector;
  if (!state || state.kind !== "object") return;
  let offset = state.part === part ? (state.offset || 0) + 512 : 512;
  if (offset >= (part === "raw" ? state.object.raw.total : state.object.size))
    offset = 0;
  const object = await api("object", { oid: state.object.oid, part, offset });
  if (inspector !== state) return;
  state.object = object;
  state.part = part;
  state.offset = offset;
  renderInspector();
}
function renderMetaStep() {
  const state = inspector;
  if (!state || state.kind !== "meta") return;
  const { data: d, step } = state,
    section = $("inspect-section");
  if (step === 0)
    section.innerHTML = `<div class="source-path">${esc(d.source)}</div><div class="large-count">${size(d.raw.total)}</div>`;
  else if (step === 1)
    section.innerHTML =
      hexView(d.raw) +
      `<div class="byte-pages"><span>${d.raw.offset} / ${d.raw.total} B</span><button id="meta-next">${t("more")} →</button></div>`;
  else if (step === 2)
    section.innerHTML =
      "entries" in d.parsed
        ? `<div class="source-flow"><span class="pill">DIRC</span><span class="pill blue">v${d.parsed.version ?? "?"}</span><span class="pill green">${d.parsed.count ?? "?"} entries</span><span class="pill">big-endian</span></div>${hexView(d.raw, d.parsed.fields)}<div class="verify">${d.parsed.checksum ? "✓ checksum" : t("unavailable")}</div>`
        : `<h3>bytes → ${state.isWork && state.fileData?.versions.at(-1)?.content?.binary ? "hex" : "UTF-8"}</h3><pre class="content-pre">${esc("text" in d.parsed ? d.parsed.text : "")}</pre>`;
  else if (step === 3)
    section.innerHTML =
      hexView(d.raw, d.parsed.fields) +
      fieldTable(d.parsed.fields.slice(0, 100));
  else if (state.isWork)
    section.innerHTML =
      contentHtml(state.fileData?.versions.at(-1)?.content) +
      `<button id="work-compare" class="pill">HEAD → index → working tree ↗</button>`;
  else if ("entries" in d.parsed)
    section.innerHTML = `<table class="fields"><tr><th>mode</th><th>path</th><th>stage</th><th>blob</th></tr>${d.parsed.entries.map((e) => `<tr><td>${e.mode}</td><td>${esc(e.path)}</td><td>${e.stage}</td><td><button data-link="${e.oid}">${short(e.oid)} ↗</button></td></tr>`).join("")}</table>`;
  else
    section.innerHTML = `<pre class="content-pre">${esc("text" in d.parsed ? d.parsed.text : "")}</pre><div class="lens-buttons">${[
      ...new Set(
        (("text" in d.parsed ? d.parsed.text : "") || "").match(
          /\b[a-f0-9]{40,64}\b/g,
        ) || [],
      ),
    ]
      .slice(0, 80)
      .map((oid) => `<button data-link="${oid}">${short(oid)} ↗</button>`)
      .join("")}</div>`;
  section
    .querySelectorAll<UiElement>("[data-link]")
    .forEach((b) => (b.onclick = action(() => openObject(b.dataset.link!))));
  if ($("work-compare"))
    $("work-compare").onclick = action(() => openFile(d.name, 0, state.reveal));
  if ($("meta-next"))
    $("meta-next").onclick = action(async () => {
      if (state.isWork) {
        const file = await api("file", {
          path: d.name,
          id: snapshot.id,
          offset: d.raw.next || 0,
          reveal: state.reveal ? 1 : 0,
        });
        if (inspector !== state) return;
        state.fileData = file;
        const bytes = file.versions.at(-1)?.content;
        if (bytes) state.data.raw = bytes;
      } else
        state.data = await api("meta", {
          name: d.name,
          id: snapshot.id,
          offset: d.raw.next || 0,
        });
      renderInspector();
    });
}
function bindFields() {
  document.querySelectorAll<UiElement>("tr[data-field]").forEach((row) => {
    row.onmouseenter = () =>
      document
        .querySelectorAll<UiElement>(
          `.hex-byte[data-field="${row.dataset.field}"]`,
        )
        .forEach((b) => b.classList.add("field-active"));
    row.onmouseleave = () =>
      document
        .querySelectorAll<UiElement>(".field-active")
        .forEach((b) => b.classList.remove("field-active"));
  });
}
function renderFileInspector() {
  if (!inspector || inspector.kind !== "file") return;
  const { data: d, offset, reveal } = inspector,
    body = $("inspector-body");
  if (d.hidden) {
    body.innerHTML = `<p class="subtle">${t("hidden")}</p><button id="reveal-file">${t("reveal")}</button>`;
    $("reveal-file").onclick = action(() => openFile(d.path, 0, true));
    return;
  }
  body.innerHTML = `${d.historical ? `<p class="snapshot-badge">${t("captured")}</p>` : ""}${d.versions.length > 3 ? `<div class="source-flow"><span class="pill coral">${d.operation?.type || "merge"}</span><span class="pill">ours = ${short(d.sides?.ours)}</span><span class="pill">theirs = ${short(d.sides?.theirs)}</span></div>` : ""}<div class="versions ${d.versions.length > 3 ? "conflicted" : ""}">${d.versions.map((v) => `<article class="version"><h3>${v.label}</h3>${v.oid ? `<button class="pill blue" data-link="${v.oid}">${short(v.oid)} · bytes ↗</button>` : ""}${v.absent ? `<pre class="content-pre muted">${t("absent")}</pre>` : v.error ? `<pre class="content-pre">${esc(v.error)}</pre>` : contentHtml(v.content)}<small>${v.content ? `${offset} / ${size(v.content.total)}` : ""}</small></article>`).join("")}</div><div class="byte-pages"><button id="file-prev" ${!offset ? "disabled" : ""}>← ${t("previous")}</button><button id="file-next" ${d.versions.some((v) => v.content?.next) ? "" : "disabled"}>${t("more")} →</button></div>${d.historical ? `<p class="subtle">${t("historyDiff")}</p>` : `<h3>${t("staged")} · HEAD → index</h3>${diffHtml(d.staged)}<h3>${t("unstaged")} · index → working tree</h3>${diffHtml(d.diff)}`}`;
  body
    .querySelectorAll<UiElement>("[data-link]")
    .forEach(
      (b) => (b.onclick = action(() => openObject(b.dataset.link!, reveal))),
    );
  const work = d.versions.at(-1);
  if (work?.content) {
    const workHeader = body.querySelector<UiElement>(".version:last-child h3"),
      button = document.createElement("button");
    button.className = "pill";
    button.textContent = "bytes ↗";
    button.onclick = () => openWorkBytes(d, reveal);
    workHeader?.after(button);
  }
  if (classroom)
    for (const version of body.querySelectorAll<UiElement>(".version")) {
      const oid =
        version.querySelector<UiElement>("[data-link]")?.dataset.link!;
      if (oid && !revealed.has(oid)) {
        version
          .querySelectorAll<UiElement>(
            ".content-pre,.hex,.histogram,.image-preview",
          )
          .forEach((el) => {
            el.replaceWith(
              Object.assign(document.createElement("pre"), {
                className: "content-pre muted",
                textContent: t("pending"),
              }),
            );
          });
      }
    }
  $("file-prev").onclick = action(() =>
    openFile(d.path, Math.max(0, offset - 8192), reveal),
  );
  $("file-next").onclick = action(() =>
    openFile(d.path, offset + 8192, reveal),
  );
}

async function refreshHistory() {
  history = await api("history");
  renderTimeline();
}
function renderTimeline() {
  $("scrubber").max = String(Math.max(0, history.length - 1));
  $("scrubber").value = String(
    Math.max(
      0,
      history.findIndex((s) => s.id === snapshot?.id),
    ),
  );
  $("pause").textContent = live ? "Ⅱ" : "▶";
  $("live-button").classList.toggle("active", live);
  const s = history.find((s) => s.id === snapshot?.id);
  $("timeline-label").textContent = s
    ? `${new Date(s.time).toLocaleTimeString()} · ${s.label} · ${history.length} ${t("retained")}`
    : "—";
  $("connection").querySelector<UiElement>("span")!.textContent = live
    ? t("live")
    : t("paused");
}
async function goSnapshot(index: number) {
  const item = history[index];
  if (!item) return;
  live = false;
  render(await api("snapshot", { id: item.id }));
  renderTimeline();
}
$("scrubber").oninput = action((e) =>
  goSnapshot(Number((e.target as HTMLInputElement).value)),
);
$("previous").onclick = action(() =>
  goSnapshot(Math.max(0, history.findIndex((s) => s.id === snapshot?.id) - 1)),
);
$("next").onclick = action(() =>
  goSnapshot(
    Math.min(
      history.length - 1,
      history.findIndex((s) => s.id === snapshot?.id) + 1,
    ),
  ),
);
$("pause").onclick = () => {
  live = !live;
  if (live && latest) render(latest);
  renderTimeline();
};
$("live-button").onclick = () => {
  live = true;
  if (latest) render(latest);
  renderTimeline();
};

localize();
const events = new EventSource(
  `/api/events?token=${encodeURIComponent(token)}`,
);
events.addEventListener(
  "snapshot",
  action(async (event) => {
    // SSE shares the same Snapshot contract as the HTTP snapshot endpoint.
    const s: Snapshot = JSON.parse(event.data);
    const first = !snapshot;
    latest = s;
    if (live) {
      render(s);
      if (first) fit();
    }
    await refreshHistory();
  }),
);
events.addEventListener("warning", (event) => {
  $("warning").hidden = false;
  $("warning").textContent = JSON.parse(event.data).message;
});
events.onerror = () =>
  ($("connection").querySelector<UiElement>("span")!.textContent =
    t("reconnect"));

import { Plugin, TFile, WorkspaceLeaf } from "obsidian";

// Obsidian's graph view rejects color-group queries for non-markdown
// (attachment) nodes — `q.match(typFile)` returns null even when the
// path matches. We work around this by:
//
//   1. Patching each searchQuery's `match()` to also accept .typ files
//      via the (still-public) `matchFilepath(path)` prototype method.
//   2. Patching the renderer's `setData()` to inject color into the
//      node data for .typ files that one of the color groups matches.
//      The renderer hands that data to its worker for paint, so it has
//      to be applied here before crossing the worker boundary.
//
// Discovered via runtime probing — not a documented Obsidian API.
// Resilient to graph view re-mounts; reattaches on every leaf open.

interface ColorGroup {
  query: { match: (file: any) => any; matchFilepath?: (path: string) => any };
  color: { a: number; rgb: number };
}

const SENTINEL_QUERY = "_typstGraphPatched";
const SENTINEL_RENDERER = "_typstGraphRendererPatched";
const TARGET_EXT = "typ";

// Process tags override the file's category (tags[0]) for color routing.
// Order is precedence: needs_review wins over agent_drafted if both
// appear on the same note. needs_review is intentionally loud (red)
// because it represents an actionable triage state; agent_drafted is
// a quieter provenance flag (purple) that stays on the note forever.
const PROCESS_TAGS = ["needs_review", "agent_drafted"];
const DEFAULT_PROCESS_COLORS: Record<string, string> = {
  needs_review: "#e74c3c",
  agent_drafted: "#9b59b6",
};

export class GraphColoringPatch {
  private plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  register(): void {
    this.plugin.app.workspace.onLayoutReady(() => {
      this.patchAll();
    });
    // Cover every event that can spawn a new graph leaf:
    //   - layout-change: pane added/removed
    //   - active-leaf-change: tab switched (re-opened graph tab)
    //   - file-open: less direct but sometimes the only one that fires
    // The patch checks a sentinel so re-running is a no-op for already-
    // patched renderers; tryPatchLeaf is cheap.
    const schedule = () => {
      // Delay slightly so the new view's renderer/dataEngine have time
      // to be assigned to the view before we try to grab them.
      window.setTimeout(() => this.patchAll(), 50);
    };
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("layout-change", schedule),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", schedule),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("file-open", schedule),
    );
  }

  private patchAll(): void {
    const leaves = [
      ...this.plugin.app.workspace.getLeavesOfType("graph"),
      ...this.plugin.app.workspace.getLeavesOfType("localgraph"),
    ];
    for (const leaf of leaves) {
      this.tryPatchLeaf(leaf);
    }
  }

  private tryPatchLeaf(leaf: WorkspaceLeaf): void {
    const view = (leaf as any).view;
    if (!view) return;
    const eng = view.dataEngine;
    const renderer = view.renderer;
    if (!eng || !renderer) return;
    // Sentinel on each object prevents double-wrapping. Safe to call
    // repeatedly on the same leaf or on fresh leaves from re-opens.
    this.patchSearchQueries(eng);
    this.patchRenderer(renderer, eng);
  }

  // Wrap each searchQuery's `match()` so it falls back to matchFilepath
  // for .typ files. Re-patches new queries as the user adds groups.
  // The fallback is gated by the user's setting at call time.
  private patchSearchQueries(eng: any): void {
    if (!eng.searchQueries) return;
    const plugin = this.plugin as any;
    for (const sq of eng.searchQueries) {
      const q = sq.query;
      if (!q || (q as any)[SENTINEL_QUERY]) continue;
      const original = q.match.bind(q);
      q.match = function (file: any) {
        const r = original(file);
        if (r) return r;
        if (!plugin.settings?.enableTypstGraphColoring) return null;
        if (
          file?.extension === TARGET_EXT &&
          typeof q.matchFilepath === "function"
        ) {
          const fp = q.matchFilepath(file.path);
          if (fp) return { filepath: Array.isArray(fp) ? fp : [fp] };
        }
        return null;
      };
      (q as any)[SENTINEL_QUERY] = true;
    }
  }

  // Wrap `renderer.setData({nodes, numLinks})` so that, for each entry
  // keyed by a .typ file path, we inject a color field matching the
  // first color group whose query accepts that file. The exact field
  // name for color in Obsidian's worker-bound node data is not public;
  // we set several plausible candidates so at least one takes effect.
  private patchRenderer(renderer: any, eng: any): void {
    if ((renderer as any)[SENTINEL_RENDERER]) return;
    (renderer as any)[SENTINEL_RENDERER] = true;
    const origSetData = renderer.setData.bind(renderer);
    const self = this;
    const plugin = this.plugin as any;

    // Build a stable click wrapper. We keep a reference to whatever
    // function Obsidian currently uses as `onNodeClick` so we can
    // forward to it; Obsidian may reset onNodeClick (e.g., re-bind
    // on certain transitions), so the setData wrapper below also
    // re-installs us if it sees the property has changed back.
    let lastNativeClick: (
      event: any,
      nodeId: any,
      nodeType: any,
    ) => any = renderer.onNodeClick?.bind(renderer);
    const ourClickWrapper = function (
      this: any,
      event: any,
      nodeId: any,
      nodeType: any,
    ) {
      try {
        const indexer = plugin.metadataIndexer;
        if (
          indexer?.bibKeyToPath &&
          typeof nodeId === "string" &&
          indexer.bibKeyToPath.has(nodeId)
        ) {
          void openOrCreateBibNote(plugin, nodeId);
          return;
        }
      } catch (e) {
        console.error("[typst-graph-color] bib-node click failed:", e);
      }
      return lastNativeClick.call(this, event, nodeId, nodeType);
    };
    renderer.onNodeClick = ourClickWrapper;

    renderer.setData = function (data: any) {
      // Defensive: if Obsidian has reset onNodeClick (e.g., by re-
      // binding it during some internal transition), capture the new
      // version as the fallback and re-install our wrapper.
      if (renderer.onNodeClick !== ourClickWrapper) {
        lastNativeClick = renderer.onNodeClick.bind(renderer);
        renderer.onNodeClick = ourClickWrapper;
      }
      try {
        self.injectAttachmentColors(data, eng);
      } catch (e) {
        console.error("[typst-graph-color] inject failed:", e);
      }
      return origSetData(data);
    };
    // The view's first setData() fires during view construction, before
    // we get a chance to wrap. Force a re-render now that our wrapper
    // is in place so the current graph state passes through it.
    if (typeof eng.render === "function") {
      try {
        eng.render();
      } catch {}
    }
  }

  private injectAttachmentColors(data: any, eng: any): void {
    if (!(this.plugin as any).settings?.enableTypstGraphColoring) return;
    const nodes = data?.nodes;
    if (!nodes || typeof nodes !== "object") return;
    const groups: ColorGroup[] = eng.searchQueries || [];
    const settings = (this.plugin as any).settings;
    const autoColor: boolean = !!settings?.enableAutoCategoryColor;
    const overrides: Record<string, string> = settings?.categoryColors || {};
    const indexer = (this.plugin as any).metadataIndexer;

    // First pass: drop hidden nodes (paths with any `_`-prefixed
    // segment). The indexer already skips them when building edges,
    // but Obsidian's data engine also surfaces vault files as orphan
    // nodes, so we strip them here regardless of how they arrived.
    if (indexer?.isHidden) {
      for (const path of Object.keys(nodes)) {
        if (indexer.isHidden(path)) delete nodes[path];
      }
    }

    // If there are zero user-defined color groups AND auto-color is off,
    // there's nothing for us to do. Otherwise we still need to iterate
    // because auto-color can apply even without any user groups.
    if (groups.length === 0 && !autoColor) return;

    for (const path of Object.keys(nodes)) {
      if (!path.endsWith(`.${TARGET_EXT}`)) continue;
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;

      const entry = nodes[path];
      if (!entry || typeof entry !== "object") continue;

      // Resolution chain:
      //   1. user-defined color group whose query matches the file.
      //   2. auto-color from the file's category (first meta tag, or
      //      parent folder name as a fallback when no meta block).
      let rgb: number | null = null;
      const matched = this.firstMatchingGroup(file, groups);
      if (matched && typeof matched.color?.rgb === "number") {
        rgb = matched.color.rgb;
      } else if (autoColor) {
        const category = this.deriveCategory(path);
        if (category) rgb = colorForCategory(category, overrides);
      }
      if (rgb === null) continue;

      // The renderer's worker treats nodes with `type: ""` as ordinary
      // notes (eligible for group color); `type: "attachment"` forces
      // the global "fillAttachment" color and ignores group queries.
      // We override the type so the worker picks up our chosen color.
      // Save the original in case any other code path needs it.
      (entry as any)._origType = (entry as any).type;
      (entry as any).type = "";
      (entry as any).color = { a: 1, rgb };
    }
  }

  private firstMatchingGroup(
    file: TFile,
    groups: ColorGroup[],
  ): ColorGroup | null {
    for (const group of groups) {
      try {
        if (group.query?.match?.(file)) return group;
      } catch {
        // Skip queries that error on .typ files
      }
    }
    return null;
  }

  // Pick a category string for a .typ path. Resolution order:
  //   1. PROCESS_TAGS appearing anywhere in the tag list (in priority
  //      order). These override the category because they're transient
  //      states (needs_review) or sticky provenance (agent_drafted)
  //      that the user wants to surface visually regardless of where
  //      the note sits in the topic taxonomy.
  //   2. tags[0] from the parsed `#let meta = (...)` block — the
  //      "category" tag by convention.
  //   3. Parent folder's basename (since folder ≈ category by the
  //      knowledge-base convention) as a fallback for legacy notes
  //      without a meta block.
  // Returns null when nothing applies (file at vault root, no meta).
  private deriveCategory(path: string): string | null {
    const indexer = (this.plugin as any).metadataIndexer;
    const tags: string[] | undefined = indexer?.tagsByPath?.get(path);
    if (tags && tags.length > 0) {
      for (const pt of PROCESS_TAGS) {
        if (tags.includes(pt)) return pt;
      }
      if (tags[0]) return tags[0];
    }

    const slash = path.lastIndexOf("/");
    if (slash < 0) return null;
    const dir = path.slice(0, slash);
    const lastSeg = dir.slice(dir.lastIndexOf("/") + 1);
    return lastSeg || null;
  }
}

// Resolve a category name to a 24-bit packed RGB number suitable for
// Obsidian's renderer worker. Resolution order:
//   1. User-pinned override from the `categoryColors` setting.
//   2. Plugin-built-in default (currently only process tags like
//      needs_review/agent_drafted).
//   3. Deterministic hash-derived HSL palette so the same category
//      always lands the same color across sessions and machines.
function colorForCategory(
  category: string,
  overrides: Record<string, string>,
): number {
  const pinned = overrides[category];
  if (typeof pinned === "string") {
    const rgb = parseHexRgb(pinned);
    if (rgb !== null) return rgb;
  }
  const builtIn = DEFAULT_PROCESS_COLORS[category];
  if (typeof builtIn === "string") {
    const rgb = parseHexRgb(builtIn);
    if (rgb !== null) return rgb;
  }
  // Fixed S/L keeps the palette visually consistent (no garish
  // max-saturation oranges next to washed-out pastels).
  const hue = hashString(category) % 360;
  return hslToRgb(hue, 0.55, 0.55);
}

// Parse "#rrggbb" or "rrggbb" into a packed 24-bit RGB number. Returns
// null on malformed input so the caller can fall through to the hash.
function parseHexRgb(hex: string): number | null {
  const s = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return parseInt(s, 16);
}

// FNV-1a 32-bit hash. Returns an unsigned int.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// Convert HSL (h in [0,360), s and l in [0,1]) to a packed 24-bit RGB.
function hslToRgb(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const R = Math.round((r + m) * 255);
  const G = Math.round((g + m) * 255);
  const B = Math.round((b + m) * 255);
  return (R << 16) | (G << 8) | B;
}

// Open or create a paper-note .typ for a citation key. Idempotent: if
// the file already exists it just opens it; otherwise it creates the
// file (and any missing parent folders) with a minimal seed body.
async function openOrCreateBibNote(plugin: any, key: string): Promise<void> {
  const folder: string = (plugin.settings?.bibNotesFolder || "papers").trim();
  const dir = folder.replace(/^\/+|\/+$/g, "");
  const path = dir ? `${dir}/${key}.typ` : `${key}.typ`;
  const vault = plugin.app.vault;
  let file = vault.getAbstractFileByPath(path);
  if (!file) {
    if (dir && !vault.getAbstractFileByPath(dir)) {
      try {
        await vault.createFolder(dir);
      } catch {
        // Race: another path created it. Ignore.
      }
    }
    const seed = `= ${key}\n\nNotes on the @${key} reference.\n`;
    try {
      file = await vault.create(path, seed);
    } catch (e) {
      console.error("[typst-graph-color] could not create bib note:", path, e);
      return;
    }
  }
  if (file && (file as any).path) {
    await plugin.app.workspace.getLeaf().openFile(file);
  }
}

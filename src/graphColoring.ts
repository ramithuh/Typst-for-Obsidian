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
const SENTINEL_CLICK = "_typstGraphClickPatched";
const TARGET_EXT = "typ";

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
    this.patchNodeClick(renderer);
  }

  // Intercept clicks on bib-entry nodes. Obsidian's default action is
  // "create a new .md file named after the link," which is wrong for
  // citation keys — they belong as .typ notes in the user's chosen
  // bibNotesFolder. Falls through to the original click handler for
  // any node that isn't a known bib key.
  private patchNodeClick(renderer: any): void {
    if ((renderer as any)[SENTINEL_CLICK]) return;
    if (typeof renderer.onNodeClick !== "function") return;
    (renderer as any)[SENTINEL_CLICK] = true;
    const plugin = this.plugin as any;
    const origOnNodeClick = renderer.onNodeClick.bind(renderer);

    renderer.onNodeClick = function (event: any, nodeId: any, ...rest: any[]) {
      // nodeId could be the second arg or the first depending on
      // Obsidian's internal signature; check both.
      const id = typeof nodeId === "string" ? nodeId : event;
      try {
        const indexer = plugin.metadataIndexer;
        if (
          indexer?.bibKeyToPath &&
          typeof id === "string" &&
          indexer.bibKeyToPath.has(id)
        ) {
          void openOrCreateBibNote(plugin, id);
          return;
        }
      } catch (e) {
        console.error("[typst-graph-color] bib-node click failed:", e);
      }
      return origOnNodeClick(event, nodeId, ...rest);
    };
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

    renderer.setData = function (data: any) {
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
    if (groups.length === 0) return;

    for (const path of Object.keys(nodes)) {
      if (!path.endsWith(`.${TARGET_EXT}`)) continue;
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;

      const matched = this.firstMatchingGroup(file, groups);
      if (!matched) continue;
      const rgb = matched.color?.rgb;
      if (typeof rgb !== "number") continue;

      const entry = nodes[path];
      if (!entry || typeof entry !== "object") continue;

      // The renderer's worker treats nodes with `type: ""` as ordinary
      // notes (eligible for group color); `type: "attachment"` forces
      // the global "fillAttachment" color and ignores group queries.
      // We override the type so the worker picks up our group color.
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

import { Plugin, TFile } from "obsidian";
import type { NoteMeta } from "./metadataIndexer";

// Custom hover-link popover for .typ files in the graph view.
//
// Obsidian fires `workspace.on("hover-link", ...)` whenever the user
// holds Cmd (or the user's configured "Page preview" modifier) over a
// link-like element. Its built-in page-preview plugin listens for this
// event too and tries to render the target as Markdown; for .typ files
// the result is an empty/minimal popover because Obsidian has no idea
// how to read Typst source.
//
// We hook the same event and, when the source is the graph view and
// the target is a .typ file, we attach a richer popover to the
// `hoverParent` element. The built-in popover's empty body may still
// flash briefly because we can't cancel Obsidian's listener; that's
// the cost of working alongside the stock event system. Our content
// renders on top with absolute positioning so it dominates visually.

interface HoverLinkParams {
  event: MouseEvent;
  source: string;
  hoverParent: any;
  targetEl: HTMLElement | null;
  linktext: string;
  sourcePath?: string;
}

// How long the cursor must dwell on a node before we kick off a real
// Typst compile for the rendered preview. Brushing past nodes shouldn't
// fire ~50 compiles; deliberately pausing on one should.
const RENDER_DEBOUNCE_MS = 400;

// Container clip for the rendered section. Bigger than this gets a
// scrollbar; smaller is shown flush. Same width as the popover.
const RENDER_MAX_HEIGHT = 320;

export class TypstHoverPopover {
  private plugin: Plugin;
  // Currently visible popover and the linktext it was opened for. We
  // track these so successive hover-link events on the same node don't
  // tear down + rebuild the popover (would flicker), and moving to a
  // different node smoothly swaps content rather than stacking.
  private currentPopover: HTMLElement | null = null;
  private currentLinktext: string | null = null;
  private dismissCleanup: (() => void) | null = null;
  // MutationObserver that watches for Obsidian's stock empty popover
  // (created by the "Page preview" core plugin's listener on the same
  // hover-link event) and removes it. Only active while one of our
  // popovers is on screen.
  private suppressObserver: MutationObserver | null = null;
  // Stabilization timer for the rendered preview. Cancelled whenever
  // the popover is dismissed or replaced with a different node's
  // popover; only fires if the user really has paused on a node.
  private renderTimer: number | null = null;
  // Cache: vault path -> { hash of source, rendered SVG markup pages }.
  // Invalidated when the file is modified (see register()).
  private renderedCache: Map<string, { hash: number; svgs: string[] }> =
    new Map();

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  register(): void {
    this.plugin.registerEvent(
      (this.plugin.app.workspace as any).on(
        "hover-link",
        (params: HoverLinkParams) => this.onHoverLink(params),
      ),
    );
    // Drop cached renderings whenever a .typ file is modified so the
    // next hover compiles afresh against the new source.
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (f) => {
        if (f && (f as any).extension === "typ") {
          this.renderedCache.delete(f.path);
        }
      }),
    );
  }

  private onHoverLink(params: HoverLinkParams): void {
    if (!params || params.source !== "graph") return;
    const linktext = params.linktext;
    if (!linktext || !linktext.endsWith(".typ")) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(linktext);
    if (!(file instanceof TFile)) return;

    // Same node we're already showing — leave the popover alone.
    if (this.currentLinktext === linktext && this.currentPopover) return;

    this.removeCurrent();
    const meta = this.lookupMeta(linktext);
    this.showPopover(params, file, meta, linktext);
  }

  private removeCurrent(): void {
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.dismissCleanup) {
      this.dismissCleanup();
      this.dismissCleanup = null;
    }
    if (this.suppressObserver) {
      this.suppressObserver.disconnect();
      this.suppressObserver = null;
    }
    if (this.currentPopover) {
      this.currentPopover.remove();
      this.currentPopover = null;
    }
    this.currentLinktext = null;
  }

  // Start watching the document for Obsidian's stock hover-popover
  // element (any node with the `hover-popover` class that isn't ours)
  // and remove it on sight. Page preview's listener also fires on the
  // same hover-link event we consume, so without this we get a double
  // popover when the user holds the page-preview modifier (Cmd).
  private startSuppressingNativePopover(): void {
    if (this.suppressObserver) this.suppressObserver.disconnect();
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          if (node === this.currentPopover) continue;
          if (
            node.classList.contains("hover-popover") &&
            !node.classList.contains("typst-hover-popover")
          ) {
            node.remove();
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    this.suppressObserver = observer;
  }

  private lookupMeta(path: string): NoteMeta | undefined {
    const indexer = (this.plugin as any).metadataIndexer;
    return indexer?.metaByPath?.get(path);
  }

  // Build and position the popover. Graph nodes are canvas pixels (no
  // DOM target to anchor to), so we position relative to the cursor
  // from the event's clientX/clientY. Dismissal: another hover-link
  // for a different file replaces the popover; click outside it
  // dismisses; if the cursor moves away from both the popover and the
  // approximate node area, an idle timer eventually hides it.
  private showPopover(
    params: HoverLinkParams,
    file: TFile,
    meta: NoteMeta | undefined,
    linktext: string,
  ): void {
    const popover = document.body.createDiv("typst-hover-popover");
    Object.assign(popover.style, {
      position: "absolute",
      zIndex: "9999",
      maxWidth: "360px",
      padding: "10px 12px",
      background: "var(--background-primary)",
      border: "1px solid var(--background-modifier-border)",
      borderRadius: "6px",
      boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
      fontSize: "12px",
      lineHeight: "1.45",
      color: "var(--text-normal)",
      pointerEvents: "auto",
    });

    this.renderBody(popover, file, meta);
    this.positionAtCursor(popover, params.event);
    this.dismissCleanup = this.attachDismiss(popover, params.event);
    this.currentPopover = popover;
    this.currentLinktext = linktext;
    // Suppress Obsidian's stock empty hover popover (fired by the
    // "Page preview" core plugin on the same event) while ours is up.
    this.startSuppressingNativePopover();

    // Kick off async content snippet load. Vault.cachedRead resolves
    // synchronously when the file is already in memory and from disk
    // otherwise; either way we don't block the popover's initial paint.
    // If the user moves away before the snippet arrives, we drop it.
    void this.loadSnippetInto(popover, file);

    // Schedule a stabilization-timed compile. If the cursor lingers
    // long enough on this node, we'll render the actual Typst output
    // and swap it in for the text snippet.
    this.scheduleRender(popover, file, linktext);
  }

  // Schedule a Typst compile after the user pauses on a node. Cached
  // results render instantly; cold compiles take ~100-500ms but the
  // worker doesn't block the UI. The timer is cancelled in
  // removeCurrent() so brushing across nodes never fires a compile.
  private scheduleRender(
    popover: HTMLElement,
    file: TFile,
    linktext: string,
  ): void {
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
    }
    // Cache hit: render immediately, no debounce needed. (We still
    // need the hash check inside renderInto to validate freshness.)
    if (this.renderedCache.has(linktext)) {
      void this.renderInto(popover, file, linktext);
      return;
    }
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (this.currentPopover !== popover) return;
      void this.renderInto(popover, file, linktext);
    }, RENDER_DEBOUNCE_MS);
  }

  // Read source, hash it, check cache, compile if cold, then swap the
  // text snippet for a scrollable rendered preview. Bails at every
  // await boundary if the popover has been dismissed or replaced.
  private async renderInto(
    popover: HTMLElement,
    file: TFile,
    linktext: string,
  ): Promise<void> {
    let source: string;
    try {
      source = await this.plugin.app.vault.cachedRead(file);
    } catch {
      return;
    }
    if (this.currentPopover !== popover) return;

    const hash = hashString(source);
    let svgs: string[] | null = null;
    const cached = this.renderedCache.get(linktext);
    if (cached && cached.hash === hash) {
      svgs = cached.svgs;
    } else {
      try {
        svgs = await (this.plugin as any).compileToSvgs(source, file.path);
      } catch {
        svgs = null;
      }
      if (this.currentPopover !== popover) return;
      if (svgs && svgs.length > 0) {
        this.renderedCache.set(linktext, { hash, svgs });
      }
    }
    if (!svgs || svgs.length === 0) return;
    this.replaceSnippetWithRender(popover, svgs);
  }

  // Replace any existing snippet div with a scrollable container that
  // holds the rendered SVGs. SVGs auto-fit the popover width (340px
  // max via popover style) and scroll vertically past RENDER_MAX_HEIGHT.
  // Path footer stays at the bottom.
  private replaceSnippetWithRender(
    popover: HTMLElement,
    svgs: string[],
  ): void {
    const existing = popover.querySelector(
      ".typst-hover-snippet, .typst-hover-render",
    );
    if (existing) existing.remove();

    const container = document.createElement("div");
    container.className = "typst-hover-render";
    Object.assign(container.style, {
      marginTop: "10px",
      maxHeight: `${RENDER_MAX_HEIGHT}px`,
      overflowY: "auto",
      overflowX: "hidden",
      borderLeft: "2px solid var(--background-modifier-border)",
      paddingLeft: "8px",
      background: "var(--background-primary)",
    });

    for (const svgMarkup of svgs) {
      const wrap = document.createElement("div");
      wrap.style.marginBottom = "6px";
      wrap.innerHTML = svgMarkup;
      const svg = wrap.querySelector("svg") as SVGSVGElement | null;
      if (svg) {
        // Width-fit; height tracks natural aspect via viewBox.
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        svg.style.width = "100%";
        svg.style.height = "auto";
        svg.style.display = "block";
      }
      container.appendChild(wrap);
    }

    // Insert before the path footer (last child) so the path remains
    // pinned at the bottom of the popover for reference.
    const pathEl = popover.lastElementChild;
    if (pathEl) popover.insertBefore(container, pathEl);
    else popover.appendChild(container);

    // Nudge the popover back into view if the growth pushed it past
    // the viewport bottom edge.
    const rect = popover.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) {
      const newTop = Math.max(
        8,
        window.innerHeight - rect.height - 8,
      );
      popover.style.top = `${newTop + window.scrollY}px`;
    }
  }

  private renderBody(
    container: HTMLElement,
    file: TFile,
    meta: NoteMeta | undefined,
  ): void {
    const title = meta?.title || file.basename;
    const titleEl = container.createEl("div", { text: title });
    Object.assign(titleEl.style, {
      fontWeight: "600",
      fontSize: "13px",
      marginBottom: "6px",
    });

    if (meta?.status) {
      const statusEl = container.createEl("span", {
        text: meta.status.toUpperCase(),
      });
      Object.assign(statusEl.style, {
        display: "inline-block",
        padding: "1px 6px",
        marginRight: "8px",
        borderRadius: "3px",
        background: statusBackground(meta.status),
        color: "white",
        fontSize: "10px",
        fontWeight: "700",
        letterSpacing: "0.5px",
      });
    }
    if (meta?.modified) {
      const modEl = container.createEl("span", {
        text: `modified ${meta.modified}`,
      });
      Object.assign(modEl.style, {
        fontSize: "11px",
        color: "var(--text-muted)",
      });
    }

    if (meta?.tags && meta.tags.length > 0) {
      const tagsRow = container.createDiv();
      Object.assign(tagsRow.style, {
        marginTop: "6px",
        display: "flex",
        flexWrap: "wrap",
        gap: "4px",
      });
      for (const tag of meta.tags) {
        const chip = tagsRow.createEl("span", { text: tag });
        Object.assign(chip.style, {
          background: "var(--background-modifier-hover)",
          padding: "1px 6px",
          borderRadius: "10px",
          fontSize: "10px",
          color: "var(--text-muted)",
        });
      }
    }

    if (meta?.origin) {
      const origin = container.createEl("div", {
        text: truncate(meta.origin, 240),
      });
      Object.assign(origin.style, {
        marginTop: "8px",
        fontSize: "11px",
        color: "var(--text-muted)",
        fontStyle: "italic",
        whiteSpace: "normal",
      });
    }

    const pathEl = container.createEl("div", { text: file.path });
    Object.assign(pathEl.style, {
      marginTop: "8px",
      fontSize: "10px",
      color: "var(--text-faint)",
      fontFamily: "var(--font-monospace)",
      wordBreak: "break-all",
    });
  }

  // Position popover relative to the cursor from the hover event.
  // We offset by a few pixels so the popover doesn't sit under the
  // cursor (which would block interaction and trigger immediate
  // leave/re-enter loops). Mirror to the opposite side if we would
  // overflow the viewport.
  private positionAtCursor(popover: HTMLElement, event?: MouseEvent): void {
    const margin = 12;
    // Reasonable fallback in case event is missing (defensive).
    const cx = event?.clientX ?? window.innerWidth / 2;
    const cy = event?.clientY ?? window.innerHeight / 2;

    // Force layout so we can read width/height before final placement.
    popover.style.visibility = "hidden";
    popover.style.left = "0px";
    popover.style.top = "0px";
    const pw = popover.offsetWidth;
    const ph = popover.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = cx + margin;
    let top = cy + margin;
    if (left + pw > vw) left = Math.max(margin, cx - pw - margin);
    if (top + ph > vh) top = Math.max(margin, cy - ph - margin);

    popover.style.left = `${left + window.scrollX}px`;
    popover.style.top = `${top + window.scrollY}px`;
    popover.style.visibility = "visible";
  }

  // Dismiss policy (canvas-rendered nodes have no DOM mouseleave):
  //   - mousedown outside the popover → dismiss immediately
  //   - mousemove that's > DISMISS_RADIUS from the original cursor
  //     position AND not over the popover itself → dismiss after a
  //     short grace period
  //   - 30s safety timeout in case the cursor goes idle
  // Anchoring to the original cursor position (rather than the
  // popover's bounding rect) keeps the dismiss zone size-independent,
  // so small popovers (e.g. files without meta blocks) get the same
  // grace period as content-rich ones.
  //
  // The cursor entering the popover pauses dismissal so the user can
  // read longer fields (e.g. origin) without it vanishing.
  private attachDismiss(
    popover: HTMLElement,
    event?: MouseEvent,
  ): () => void {
    const DISMISS_RADIUS = 120;
    const anchorX = event?.clientX ?? 0;
    const anchorY = event?.clientY ?? 0;

    let insidePopover = false;
    let dismissTimer: number | null = null;

    const dismiss = () => {
      popover.remove();
      if (this.currentPopover === popover) {
        this.currentPopover = null;
        this.currentLinktext = null;
      }
      cleanup();
    };

    const scheduleDismiss = (delay: number) => {
      if (insidePopover) return;
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
      dismissTimer = window.setTimeout(dismiss, delay);
    };

    const cancelDismiss = () => {
      if (dismissTimer !== null) {
        window.clearTimeout(dismissTimer);
        dismissTimer = null;
      }
    };

    const onEnter = () => {
      insidePopover = true;
      cancelDismiss();
    };
    const onLeave = () => {
      insidePopover = false;
      scheduleDismiss(120);
    };
    const onMousemove = (e: MouseEvent) => {
      if (insidePopover) return;
      // If the cursor is over the popover, treat as "still hovering."
      // Avoids racing the mouseenter handler if events arrive in an
      // unexpected order.
      const rect = popover.getBoundingClientRect();
      if (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      ) {
        cancelDismiss();
        return;
      }
      // Otherwise gauge distance from the *original* hover anchor.
      const dist = Math.hypot(e.clientX - anchorX, e.clientY - anchorY);
      if (dist > DISMISS_RADIUS) scheduleDismiss(250);
      else cancelDismiss();
    };
    const onMousedown = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node)) dismiss();
    };

    popover.addEventListener("mouseenter", onEnter);
    popover.addEventListener("mouseleave", onLeave);
    document.addEventListener("mousemove", onMousemove, true);
    document.addEventListener("mousedown", onMousedown, true);
    const safety = window.setTimeout(dismiss, 30000);

    const cleanup = () => {
      popover.removeEventListener("mouseenter", onEnter);
      popover.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("mousemove", onMousemove, true);
      document.removeEventListener("mousedown", onMousedown, true);
      window.clearTimeout(safety);
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
    };

    return cleanup;
  }

  // Read the file, extract a short prose snippet from past the meta
  // boilerplate, and append it to the popover ABOVE the path footer.
  // Bails out if the popover has already been dismissed by the time
  // the async read resolves (currentPopover is the source of truth).
  private async loadSnippetInto(
    popover: HTMLElement,
    file: TFile,
  ): Promise<void> {
    let content: string;
    try {
      content = await this.plugin.app.vault.cachedRead(file);
    } catch {
      return;
    }
    if (this.currentPopover !== popover || !popover.isConnected) return;
    // If the rendered preview already landed, don't backfill text.
    if (popover.querySelector(".typst-hover-render")) return;

    const snippet = extractSnippet(content);
    if (!snippet) return;

    const snippetEl = document.createElement("div");
    snippetEl.className = "typst-hover-snippet";
    Object.assign(snippetEl.style, {
      marginTop: "10px",
      paddingLeft: "8px",
      borderLeft: "2px solid var(--background-modifier-border)",
      fontSize: "12px",
      color: "var(--text-normal)",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      maxHeight: "160px",
      overflow: "hidden",
    });
    snippetEl.textContent = snippet;

    // Insert before the path footer (always the last child after
    // renderBody finishes). If popover layout changed, fall back to
    // appending — better than throwing.
    const pathEl = popover.lastElementChild;
    if (pathEl) popover.insertBefore(snippetEl, pathEl);
    else popover.appendChild(snippetEl);
  }
}

// Pull a short prose preview out of a .typ note's source. Strips:
//   - the `#let meta = (...)` block, if present
//   - the immediate `#note-header(meta)` call
//   - the H1 line (`= Title <slug>`) — we already render the title above
//   - lone Typst directive lines (#import, #set, #show) that aren't
//     part of the visible prose
// Then takes up to MAX_LINES non-empty lines or MAX_CHARS, whichever
// comes first. Returns null when nothing usable is left.
function extractSnippet(content: string): string | null {
  const MAX_LINES = 6;
  const MAX_CHARS = 360;

  // 1. Skip past `#let meta = ( ... )` block if present.
  let body = stripMetaBlock(content);

  // 2. Drop `#note-header(meta)` invocation.
  body = body.replace(/^\s*#note-header\([^)]*\)\s*$/m, "");

  // 3. Drop the first H1 line (and a possible label `<slug>` on it).
  body = body.replace(/^\s*=\s+[^\n]*\n/, "");

  // 4. Walk lines and collect prose.
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let chars = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      if (out.length === 0) continue; // skip leading blanks
      out.push("");
      continue;
    }
    // Skip Typst configuration / import / show directives — these are
    // boilerplate, not the content the user wants to preview.
    if (/^#(?:import|set|show|let|include)\b/.test(line)) continue;
    if (/^\/\//.test(line)) continue; // comments

    out.push(line);
    chars += line.length + 1;
    if (out.length >= MAX_LINES || chars >= MAX_CHARS) break;
  }

  // Trim trailing blank lines.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  if (out.length === 0) return null;

  let snippet = out.join("\n");
  if (snippet.length > MAX_CHARS) snippet = snippet.slice(0, MAX_CHARS - 1) + "…";
  return snippet;
}

// Find the `#let meta = (...)` block and return content with that
// block removed. Tracks paren / brace / string depth so the meta
// block's commas don't confuse the trimming.
function stripMetaBlock(content: string): string {
  const re = /#let\s+meta\s*=\s*\(/;
  const m = re.exec(content);
  if (!m) return content;
  const headStart = m.index;
  const valueStart = m.index + m[0].length;

  let depth = 1;
  let inString = false;
  let stringQuote = '"';
  let escape = false;
  for (let i = valueStart; i < content.length; i++) {
    const c = content[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === stringQuote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringQuote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        // Include trailing newline (and any whitespace) after the
        // closing paren so we don't leave a blank line in its place.
        let end = i + 1;
        while (end < content.length && /[ \t]/.test(content[end])) end++;
        if (end < content.length && content[end] === "\n") end++;
        return content.slice(0, headStart) + content.slice(end);
      }
    }
  }
  return content; // unbalanced — leave as-is
}

// FNV-1a 32-bit hash. Used to key the rendered-preview cache so we
// re-compile when source changes (and bypass the cache silently when
// the file is edited between hovers).
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function statusBackground(status: string): string {
  switch (status) {
    case "draft":
      return "#e67e22";
    case "active":
      return "#27ae60";
    case "superseded":
    case "archived":
      return "#95a5a6";
    default:
      return "#7f8c8d";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

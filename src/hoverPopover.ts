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

export class TypstHoverPopover {
  private plugin: Plugin;
  // Currently visible popover and the linktext it was opened for. We
  // track these so successive hover-link events on the same node don't
  // tear down + rebuild the popover (would flicker), and moving to a
  // different node smoothly swaps content rather than stacking.
  private currentPopover: HTMLElement | null = null;
  private currentLinktext: string | null = null;
  private dismissCleanup: (() => void) | null = null;

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
    if (this.dismissCleanup) {
      this.dismissCleanup();
      this.dismissCleanup = null;
    }
    if (this.currentPopover) {
      this.currentPopover.remove();
      this.currentPopover = null;
    }
    this.currentLinktext = null;
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

    // Kick off async content snippet load. Vault.cachedRead resolves
    // synchronously when the file is already in memory and from disk
    // otherwise; either way we don't block the popover's initial paint.
    // If the user moves away before the snippet arrives, we drop it.
    void this.loadSnippetInto(popover, file);
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

    const snippet = extractSnippet(content);
    if (!snippet) return;

    const snippetEl = document.createElement("div");
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

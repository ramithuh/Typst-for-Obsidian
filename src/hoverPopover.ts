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

    const meta = this.lookupMeta(linktext);
    const targetEl = params.targetEl || params.hoverParent?.containerEl;
    if (!targetEl) return;

    this.showPopover(targetEl, file, meta);
  }

  private lookupMeta(path: string): NoteMeta | undefined {
    const indexer = (this.plugin as any).metadataIndexer;
    return indexer?.metaByPath?.get(path);
  }

  // Build and position the popover. Anchored to the target element's
  // bounding rect; we offset enough to not occlude the cursor. The
  // popover is removed when the pointer leaves both the popover and
  // the target (handled by the dismiss helper) so it doesn't linger
  // after the user moves away.
  private showPopover(
    targetEl: HTMLElement,
    file: TFile,
    meta: NoteMeta | undefined,
  ): void {
    const existing = document.querySelector(".typst-hover-popover");
    if (existing) existing.remove();

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
    this.positionNear(popover, targetEl);
    this.attachDismiss(popover, targetEl);
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

  // Place the popover near the target without spilling off-screen.
  // Default: below the target, slight horizontal offset. If that would
  // overflow the viewport, mirror to above or the opposite side.
  private positionNear(popover: HTMLElement, targetEl: HTMLElement): void {
    const rect = targetEl.getBoundingClientRect();
    const margin = 8;
    // Force layout so we can read offsetWidth/Height before placement.
    popover.style.visibility = "hidden";
    popover.style.left = "0px";
    popover.style.top = "0px";
    const pw = popover.offsetWidth;
    const ph = popover.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.right + margin;
    let top = rect.top;
    if (left + pw > vw) left = Math.max(margin, rect.left - pw - margin);
    if (top + ph > vh) top = Math.max(margin, vh - ph - margin);

    popover.style.left = `${left + window.scrollX}px`;
    popover.style.top = `${top + window.scrollY}px`;
    popover.style.visibility = "visible";
  }

  // Dismiss when the pointer leaves both popover and target, or on
  // mousedown elsewhere. We also self-destruct after 30s as a safety
  // net so a stuck popover doesn't survive forever if event listeners
  // get torn down by Obsidian transitions.
  private attachDismiss(popover: HTMLElement, targetEl: HTMLElement): void {
    let hovering = true;
    const dismiss = () => {
      if (!hovering) {
        popover.remove();
        cleanup();
      }
    };
    const onLeavePopover = () => {
      hovering = false;
      setTimeout(dismiss, 80);
    };
    const onLeaveTarget = () => {
      hovering = false;
      setTimeout(dismiss, 80);
    };
    const onEnter = () => {
      hovering = true;
    };
    const onMousedown = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node)) {
        popover.remove();
        cleanup();
      }
    };

    popover.addEventListener("mouseenter", onEnter);
    popover.addEventListener("mouseleave", onLeavePopover);
    targetEl.addEventListener("mouseleave", onLeaveTarget);
    document.addEventListener("mousedown", onMousedown, true);
    const safety = window.setTimeout(() => {
      popover.remove();
      cleanup();
    }, 30000);

    const cleanup = () => {
      popover.removeEventListener("mouseenter", onEnter);
      popover.removeEventListener("mouseleave", onLeavePopover);
      targetEl.removeEventListener("mouseleave", onLeaveTarget);
      document.removeEventListener("mousedown", onMousedown, true);
      window.clearTimeout(safety);
    };
  }
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

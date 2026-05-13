import { PDF_RENDER_SCALE } from "./pdfRenderer";

// Renders a Typst document into the reading-mode container by inserting
// one `<svg>` per page directly into the DOM. The browser handles all
// zoom/scale operations natively — pinch-to-zoom is GPU-smooth because
// SVG is vector, not raster. No PDFium dependency on this path.
//
// Click-to-source is still routed through the WASM compiler's
// `jump_from_click(page, x, y)` API: the caller hands us a callback,
// we attach a click listener per page that converts the SVG-local
// pointer coordinates back into PDF user-space points (typst-svg
// uses the same point unit, scaled by the SVG's viewBox).

export type SvgBacklinkClickHandler = (
  linkTarget: string,
  newTab: boolean,
) => void;

export type SvgJumpFromClickHandler = (
  page: number,
  x: number,
  y: number,
) => void;

const BACKLINK_PREFIX = "https://obsidian-backlink.invalid/open?";

export class SvgRenderer {
  // Insert/refresh per-page SVGs in `container`. Reuses existing page
  // containers when the count matches the new page count (preserves
  // scroll position + zoom across recompiles).
  renderSvgs(
    svgs: string[],
    container: HTMLElement,
    onBacklinkClick?: SvgBacklinkClickHandler,
    onJumpFromClick?: SvgJumpFromClickHandler,
  ): void {
    const existing = Array.from(
      container.querySelectorAll(":scope > .typst-pdf-page"),
    ) as HTMLElement[];
    const canReuse = existing.length === svgs.length;
    if (!canReuse) container.empty();

    svgs.forEach((svgMarkup, pageIndex) => {
      const pageContainer = canReuse
        ? existing[pageIndex]
        : container.createDiv("typst-pdf-page");
      this.renderPage(
        svgMarkup,
        pageContainer,
        pageIndex,
        canReuse,
        onBacklinkClick,
        onJumpFromClick,
      );
    });
  }

  private renderPage(
    svgMarkup: string,
    pageContainer: HTMLElement,
    pageIndex: number,
    isReuse: boolean,
    onBacklinkClick?: SvgBacklinkClickHandler,
    onJumpFromClick?: SvgJumpFromClickHandler,
  ): void {
    if (!isReuse) {
      pageContainer.style.position = "relative";
      pageContainer.style.marginBottom = "20px";
      pageContainer.style.cursor = "text";
    }
    pageContainer.innerHTML = svgMarkup;
    const svg = pageContainer.querySelector(":scope > svg") as
      | SVGSVGElement
      | null;
    if (!svg) return;
    // Force the SVG to a CSS-pixel size matching the PDF point size *
    // PDF_RENDER_SCALE, so SVG output occupies the same on-screen area
    // as our PDFium canvases did at the default zoom. Also stash the
    // base dimensions as data attributes so the zoom commit can read
    // them back and re-rasterize the SVG crisply at any committed
    // zoom level (browser re-paints vector at new CSS dimensions).
    const viewBox = svg.viewBox?.baseVal;
    if (viewBox) {
      const baseW = viewBox.width * PDF_RENDER_SCALE;
      const baseH = viewBox.height * PDF_RENDER_SCALE;
      svg.style.width = `${baseW}px`;
      svg.style.height = `${baseH}px`;
      svg.style.display = "block";
      svg.dataset.baseW = String(baseW);
      svg.dataset.baseH = String(baseH);
    }
    if (!isReuse) {
      this.attachLinkHandlers(svg, onBacklinkClick);
      this.attachJumpHandler(svg, pageIndex, onJumpFromClick);
    }
  }

  // Intercept clicks on `<a>` elements inside the SVG. typst-svg emits
  // these as <a xlink:href="..."> for #link() calls. We route the
  // ones with our backlink scheme through the Obsidian file-open
  // callback; everything else falls through to the browser default
  // (window.open in a new tab).
  private attachLinkHandlers(
    svg: SVGSVGElement,
    onBacklinkClick?: SvgBacklinkClickHandler,
  ): void {
    if (!onBacklinkClick) return;
    svg.addEventListener("click", (e) => {
      let el: Element | null = e.target as Element | null;
      while (el && el !== svg) {
        if (el.tagName.toLowerCase() === "a") {
          const href =
            el.getAttribute("href") ||
            el.getAttribute("xlink:href") ||
            (el as any).href?.baseVal ||
            "";
          if (href.startsWith(BACKLINK_PREFIX)) {
            e.preventDefault();
            const params = new URLSearchParams(
              href.slice(BACKLINK_PREFIX.length),
            );
            const path = params.get("file") || "";
            const subpath = params.get("subpath") || "";
            const newTab = e.ctrlKey || e.metaKey;
            onBacklinkClick(path + subpath, newTab);
            return;
          }
          // Non-backlink external link — let the browser default fire
          return;
        }
        el = el.parentElement;
      }
    });
  }

  // Convert pointer coordinates within the SVG element back to PDF
  // user-space points and forward to the click-to-source callback.
  // typst-svg's viewBox is sized in PDF points, so we just need a
  // proportional mapping from the rendered DOM-pixel size.
  private attachJumpHandler(
    svg: SVGSVGElement,
    pageIndex: number,
    onJumpFromClick?: SvgJumpFromClickHandler,
  ): void {
    if (!onJumpFromClick) return;
    svg.addEventListener("click", (e) => {
      // Skip clicks that landed on an <a>; the link handler took them
      let el: Element | null = e.target as Element | null;
      while (el && el !== svg) {
        if (el.tagName.toLowerCase() === "a") return;
        el = el.parentElement;
      }
      const rect = svg.getBoundingClientRect();
      const viewBox = svg.viewBox.baseVal;
      const pdfX = ((e.clientX - rect.left) / rect.width) * viewBox.width;
      const pdfY = ((e.clientY - rect.top) / rect.height) * viewBox.height;
      onJumpFromClick(pageIndex, pdfX, pdfY);
    });
  }
}

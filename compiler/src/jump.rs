// Adapted from Myriad-Dreamin/tinymist:
//   crates/tinymist-query/src/jump.rs  (`jump_from_click`)
// Licensed under Apache-2.0.  See
//   https://github.com/Myriad-Dreamin/tinymist
// Trimmed to what we need: walk a Typst Frame at a click point and
// return the source span + byte offset under the cursor.  No
// dependency on tinymist or reflexo; uses stock typst APIs only.

use typst::{
    layout::{Frame, FrameItem, PagedDocument, Point, Size},
    syntax::{LinkedNode, Side, Span, SyntaxKind, VirtualPath, FileId},
    visualize::Geometry,
    World,
};

use crate::world::SystemWorld;

pub fn jump_from_click(
    world: &SystemWorld,
    frame: &Frame,
    click: Point,
) -> Option<(Span, usize)> {
    // Bail on link items — the existing PDF link layer handles those.
    for (pos, item) in frame.items() {
        if let FrameItem::Link(_dest, size) = item {
            if is_in_rect(*pos, *size, click) {
                return None;
            }
        }
    }

    // Search top-most-first.
    for &(mut pos, ref item) in frame.items().collect::<Vec<_>>().iter().rev() {
        match item {
            FrameItem::Group(group) => {
                if let Some(hit) =
                    jump_from_click(world, &group.frame, click - pos)
                {
                    return Some(hit);
                }
            }

            FrameItem::Text(text) => {
                for glyph in &text.glyphs {
                    let width = glyph.x_advance.at(text.size);
                    if is_in_rect(
                        Point::new(pos.x, pos.y - text.size),
                        Size::new(width, text.size),
                        click,
                    ) {
                        let (span, span_offset) = glyph.span;
                        let mut span_offset = span_offset as usize;
                        let id = span.id()?;
                        let source = world_source(world, id)?;
                        if let Some(node) = source.find(span) {
                            if matches!(
                                node.kind(),
                                SyntaxKind::Text | SyntaxKind::MathText
                            ) && (click.x - pos.x) > width / 2.0
                            {
                                span_offset += glyph.range().len();
                            }
                        }
                        return Some((span, span_offset));
                    }
                    pos.x += width;
                }
            }

            FrameItem::Shape(shape, span) => {
                if let Geometry::Rect(size) = shape.geometry {
                    if is_in_rect(pos, size, click) {
                        return Some((*span, 0));
                    }
                }
            }

            FrameItem::Image(_, size, span) if is_in_rect(pos, *size, click) => {
                return Some((*span, 0));
            }

            _ => {}
        }
    }

    None
}

fn world_source(world: &SystemWorld, id: FileId) -> Option<typst::syntax::Source> {
    world.source(id).ok()
}

// Source → preview: given a cursor position in a source file, find
// the (page, point) in the rendered document that the cursor maps
// to.  Adapted from Myriad-Dreamin/tinymist
// crates/tinymist-query/src/jump.rs::jump_from_cursor + find_in_frame
// (Apache-2.0), trimmed: we return the first match rather than a Vec
// of all matches, and skip the "closest span" fallback for now.
pub fn cursor_to_preview(
    world: &SystemWorld,
    document: &PagedDocument,
    path: &str,
    line: usize,
    column: usize,
) -> Option<(usize, f64, f64)> {
    let file_id = FileId::new(None, VirtualPath::new(path));
    let source = world_source(world, file_id)?;
    let byte = source.lines().line_column_to_byte(line, column)?;
    let node = LinkedNode::new(source.root()).leaf_at(byte, Side::Before)?;
    let span = node.span();

    // Two-pass: first scan all pages for an exact span match; if none,
    // fall back to the closest span in the same source file by raw
    // span-id distance. The fallback handles cursors on Typst markup
    // markers (`=`, `#`, `$`) where the cursor token has no matching
    // rendered glyph but a nearby text glyph does.
    let mut closest: Option<(usize, Point, u64)> = None;
    for (idx, page) in document.pages.iter().enumerate() {
        if let Some(point) = find_span_in_frame(&page.frame, span, &mut closest, idx) {
            return Some((idx, point.x.to_pt(), point.y.to_pt()));
        }
    }
    closest.map(|(idx, point, _)| (idx, point.x.to_pt(), point.y.to_pt()))
}

fn find_span_in_frame(
    frame: &Frame,
    target: Span,
    closest: &mut Option<(usize, Point, u64)>,
    page_idx: usize,
) -> Option<Point> {
    for (pos, item) in frame.items() {
        match item {
            FrameItem::Group(group) => {
                if let Some(inner) =
                    find_span_in_frame(&group.frame, target, closest, page_idx)
                {
                    return Some(*pos + inner);
                }
            }
            FrameItem::Text(text) => {
                let mut glyph_pos = *pos;
                for glyph in &text.glyphs {
                    if glyph.span.0 == target {
                        return Some(glyph_pos);
                    }
                    // Closest-span fallback (adapted from tinymist's
                    // find_in_frame). Span IDs are roughly source-ordered,
                    // so |a - b| approximates source-position distance.
                    if glyph.span.0.id() == target.id() {
                        let a = glyph.span.0.into_raw().get();
                        let b = target.into_raw().get();
                        let dis = a.abs_diff(b);
                        match closest {
                            Some((_, _, best)) if dis >= *best => {}
                            _ => *closest = Some((page_idx, glyph_pos, dis)),
                        }
                    }
                    glyph_pos.x += glyph.x_advance.at(text.size);
                }
            }
            FrameItem::Shape(_, span) | FrameItem::Image(_, _, span) => {
                if *span == target {
                    return Some(*pos);
                }
            }
            _ => {}
        }
    }
    None
}

fn is_in_rect(pos: Point, size: Size, click: Point) -> bool {
    pos.x <= click.x
        && click.x <= pos.x + size.x
        && pos.y <= click.y
        && click.y <= pos.y + size.y
}

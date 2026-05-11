// Adapted from Myriad-Dreamin/tinymist:
//   crates/tinymist-query/src/jump.rs  (`jump_from_click`)
// Licensed under Apache-2.0.  See
//   https://github.com/Myriad-Dreamin/tinymist
// Trimmed to what we need: walk a Typst Frame at a click point and
// return the source span + byte offset under the cursor.  No
// dependency on tinymist or reflexo; uses stock typst APIs only.

use typst::{
    layout::{Frame, FrameItem, Point, Size},
    syntax::{Span, SyntaxKind},
    visualize::Geometry,
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

fn world_source(world: &SystemWorld, id: typst::syntax::FileId) -> Option<typst::syntax::Source> {
    use typst::World;
    world.source(id).ok()
}

fn is_in_rect(pos: Point, size: Size, click: Point) -> bool {
    pos.x <= click.x
        && click.x <= pos.x + size.x
        && pos.y <= click.y
        && click.y <= pos.y + size.y
}

//! Screen edge detection and cursor transition logic.
//!
//! Detects when the cursor reaches a screen boundary and determines
//! whether to transition input to a remote peer.

use kami_bridge::{ScreenEdge, ScreenGeometry};

/// Margin in pixels from screen edge that triggers a transition check.
const EDGE_MARGIN: f64 = 1.0;

/// Result of an edge detection check.
#[derive(Debug)]
pub struct EdgeTransition {
    /// Which edge the cursor hit.
    pub edge: ScreenEdge,
    /// Cursor position along the edge (0.0 = start, 1.0 = end).
    /// Used to compute entry position on the remote screen.
    pub edge_ratio: f64,
}

/// Check if cursor position is at a screen edge.
///
/// Returns `Some(EdgeTransition)` if the cursor is within [`EDGE_MARGIN`]
/// of a screen boundary, `None` otherwise.
pub fn detect_edge(cursor_x: f64, cursor_y: f64, screen: &ScreenGeometry) -> Option<EdgeTransition> {
    let sx = screen.x as f64;
    let sy = screen.y as f64;
    let sw = screen.width as f64;
    let sh = screen.height as f64;

    if cursor_x <= sx + EDGE_MARGIN {
        Some(EdgeTransition {
            edge: ScreenEdge::Left,
            edge_ratio: (cursor_y - sy) / sh,
        })
    } else if cursor_x >= sx + sw - EDGE_MARGIN {
        Some(EdgeTransition {
            edge: ScreenEdge::Right,
            edge_ratio: (cursor_y - sy) / sh,
        })
    } else if cursor_y <= sy + EDGE_MARGIN {
        Some(EdgeTransition {
            edge: ScreenEdge::Top,
            edge_ratio: (cursor_x - sx) / sw,
        })
    } else if cursor_y >= sy + sh - EDGE_MARGIN {
        Some(EdgeTransition {
            edge: ScreenEdge::Bottom,
            edge_ratio: (cursor_x - sx) / sw,
        })
    } else {
        None
    }
}

/// Compute the entry position on a remote screen given the transition edge and ratio.
///
/// The cursor enters from the opposite edge of the remote screen.
pub fn compute_entry_position(
    transition: &EdgeTransition,
    remote_screen: &ScreenGeometry,
) -> (f64, f64) {
    let rx = remote_screen.x as f64;
    let ry = remote_screen.y as f64;
    let rw = remote_screen.width as f64;
    let rh = remote_screen.height as f64;

    match transition.edge {
        // Cursor left our right edge → enters remote's left edge
        ScreenEdge::Right => (rx + EDGE_MARGIN + 1.0, ry + rh * transition.edge_ratio),
        // Cursor left our left edge → enters remote's right edge
        ScreenEdge::Left => (rx + rw - EDGE_MARGIN - 1.0, ry + rh * transition.edge_ratio),
        // Cursor left our bottom edge → enters remote's top edge
        ScreenEdge::Bottom => (rx + rw * transition.edge_ratio, ry + EDGE_MARGIN + 1.0),
        // Cursor left our top edge → enters remote's bottom edge
        ScreenEdge::Top => (rx + rw * transition.edge_ratio, ry + rh - EDGE_MARGIN - 1.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen() -> ScreenGeometry {
        ScreenGeometry {
            id: 0,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale_factor: 1.0,
        }
    }

    #[test]
    fn detect_right_edge() {
        let s = screen();
        let result = detect_edge(1919.5, 540.0, &s);
        assert!(result.is_some());
        let t = result.unwrap();
        assert_eq!(t.edge, ScreenEdge::Right);
        assert!((t.edge_ratio - 0.5).abs() < 0.01);
    }

    #[test]
    fn detect_left_edge() {
        let s = screen();
        let result = detect_edge(0.5, 270.0, &s);
        assert!(result.is_some());
        assert_eq!(result.unwrap().edge, ScreenEdge::Left);
    }

    #[test]
    fn no_edge_center() {
        let s = screen();
        assert!(detect_edge(960.0, 540.0, &s).is_none());
    }

    #[test]
    fn entry_position_right_to_left() {
        let remote = ScreenGeometry {
            id: 1,
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
            scale_factor: 1.0,
        };
        let t = EdgeTransition {
            edge: ScreenEdge::Right,
            edge_ratio: 0.5,
        };
        let (x, y) = compute_entry_position(&t, &remote);
        assert!(x < 10.0); // enters near left edge
        assert!((y - 720.0).abs() < 1.0); // middle of remote screen
    }
}

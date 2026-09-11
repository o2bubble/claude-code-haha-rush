// Data layer lives in the shared crate so both the GUI and the server refer to
// the same schema/models. This module re-exports it — `crate::db::X` call sites
// are unchanged.
pub use claude_gui_shared::db::*;

//! Shared data layer for the GUI and its server process: SQLite schema,
//! serializable data models, and the CRUD functions that operate on them.
//!
//! Extracted so the GUI (`claude-code-gui`) and the upcoming server daemon both
//! reference the same definitions — no drift between two copies of the schema.

pub mod db;
pub mod note;
pub mod presence;

pub use db::*;
pub use note::*;
pub use presence::*;

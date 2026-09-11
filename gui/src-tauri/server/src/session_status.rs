//! Session open/working-status registry reducer (pure). Mirrors `guard.rs`:
//! all state transitions live in a pure function under `cfg(test)`, so the RPC
//! layer in `main.rs` is a thin side-effecting wrapper.
//!
//! Registry is keyed by **owner client id** (a GUI has one active session at a
//! time). Keying by client — rather than `(workspace, session_id)` — lets two
//! GUIs hold the *same* session (the soft-warn-path allows a second holder)
//! without one leaving erasing the other. Workspace isolation is preserved via
//! the `workspace` field and the per-workspace `get_session_statuses` query.

use std::collections::HashMap;

use claude_gui_shared::presence::SessionStatus;

#[derive(Debug, Clone)]
pub enum SessionStatusEvent {
    /// Upsert the client's current session + binary agent state.
    Report(SessionStatus),
    /// The GUI instance deregistered (closed/crashed): drop all its entries.
    ClientLeft { client_id: String },
}

pub type SessionRegistry = HashMap<String, SessionStatus>;

pub fn session_status_reduce(reg: &mut SessionRegistry, ev: &SessionStatusEvent) {
    match ev {
        SessionStatusEvent::Report(st) => {
            reg.insert(st.client_id.clone(), st.clone());
        }
        SessionStatusEvent::ClientLeft { client_id } => {
            reg.remove(client_id);
        }
    }
}

/// Sessions a workspace currently has open, keyed for the frontend marker.
pub fn sessions_for_workspace(reg: &SessionRegistry, workspace: &str) -> Vec<SessionStatus> {
    let mut out: Vec<SessionStatus> = reg
        .values()
        .filter(|s| s.workspace == workspace)
        .cloned()
        .collect();
    out.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use claude_gui_shared::presence::SessionState;

    fn st(client: &str, ws: &str, sid: &str, state: SessionState) -> SessionStatus {
        SessionStatus {
            workspace: ws.into(),
            session_id: sid.into(),
            state,
            client_id: client.into(),
        }
    }

    #[test]
    fn report_upserts_by_client() {
        let mut reg = SessionRegistry::new();
        session_status_reduce(&mut reg, &SessionStatusEvent::Report(st("A", "w1", "S1", SessionState::Working)));
        assert_eq!(reg.len(), 1);
        assert_eq!(reg["A"].state, SessionState::Working);
        // Re-report (idle → working flip) updates the same client entry.
        session_status_reduce(&mut reg, &SessionStatusEvent::Report(st("A", "w1", "S1", SessionState::Idle)));
        assert_eq!(reg.len(), 1);
        assert_eq!(reg["A"].state, SessionState::Idle);
    }

    #[test]
    fn switch_session_replaces_previous_within_client() {
        let mut reg = SessionRegistry::new();
        session_status_reduce(&mut reg, &SessionStatusEvent::Report(st("A", "w1", "S1", SessionState::Working)));
        // Client switches to S2 → its old entry (S1) replaced, registry still has 1.
        session_status_reduce(&mut reg, &SessionStatusEvent::Report(st("A", "w1", "S2", SessionState::Working)));
        assert_eq!(reg.len(), 1);
        assert_eq!(reg["A"].session_id, "S2");
    }

    #[test]
    fn client_left_removes_only_that_client() {
        let mut reg = SessionRegistry::new();
        session_status_reduce(&mut reg, &SessionStatusEvent::Report(st("A", "w1", "S1", SessionState::Working)));
        session_status_reduce(&mut reg, &SessionStatusEvent::Report(st("B", "w1", "S2", SessionState::Idle)));
        session_status_reduce(&mut reg, &SessionStatusEvent::ClientLeft { client_id: "A".into() });
        assert_eq!(reg.len(), 1);
        assert!(reg.contains_key("B"));
        assert!(!reg.contains_key("A"));
    }

    #[test]
    fn two_clients_can_hold_same_session_without_erasing_each_other() {
        let mut reg = SessionRegistry::new();
        session_status_reduce(&mut reg, &SessionStatusEvent::Report(st("A", "w1", "S1", SessionState::Working)));
        session_status_reduce(&mut reg, &SessionStatusEvent::Report(st("B", "w1", "S1", SessionState::Idle)));
        assert_eq!(reg.len(), 2);
        // A leaves → B's "S1 open" entry survives.
        session_status_reduce(&mut reg, &SessionStatusEvent::ClientLeft { client_id: "A".into() });
        assert_eq!(reg.len(), 1);
        assert_eq!(reg["B"].session_id, "S1");
    }

    #[test]
    fn sessions_for_workspace_isolates_by_workspace() {
        let mut reg = SessionRegistry::new();
        // Same session id in two different workspaces must not cross-link.
        session_status_reduce(&mut reg, &SessionStatusEvent::Report(st("A", "w1", "S1", SessionState::Working)));
        session_status_reduce(&mut reg, &SessionStatusEvent::Report(st("B", "w2", "S1", SessionState::Idle)));
        let w1 = sessions_for_workspace(&reg, "w1");
        assert_eq!(w1.len(), 1);
        assert_eq!(w1[0].workspace, "w1");
        assert_eq!(w1[0].session_id, "S1");
        let w2 = sessions_for_workspace(&reg, "w2");
        assert_eq!(w2.len(), 1);
        assert_eq!(w2[0].client_id, "B");
    }
}

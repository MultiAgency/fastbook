//! Endorsement support types used by profile update (EndorsementCascade).
//! Endorse/unendorse handlers have migrated to direct FastData writes.

use crate::types::*;
use crate::validation::*;
use std::collections::{HashMap, HashSet};

pub fn collect_endorsable(
    tags: Option<&[String]>,
    caps: Option<&serde_json::Value>,
) -> HashSet<(String, String)> {
    let mut set = HashSet::new();
    if let Some(tags) = tags {
        set.extend(tags.iter().map(|t| ("tags".to_string(), t.to_lowercase())));
    }
    if let Some(caps) = caps.filter(|c| !c.is_null()) {
        set.extend(extract_capability_pairs(caps));
    }
    set
}

pub(crate) struct EndorsementCascade {
    removals: HashMap<String, Vec<String>>,
}

impl EndorsementCascade {
    pub fn from_diff(old: &HashSet<(String, String)>, new: &HashSet<(String, String)>) -> Self {
        let mut removals: HashMap<String, Vec<String>> = HashMap::new();
        for (ns, val) in old.difference(new) {
            removals.entry(ns.clone()).or_default().push(val.clone());
        }
        Self { removals }
    }

    pub fn empty() -> Self {
        Self {
            removals: HashMap::new(),
        }
    }

    pub fn apply_counts(&self, agent: &mut AgentRecord) {
        for (ns, vals) in &self.removals {
            agent.endorsements.clear_values(ns, vals);
        }
        agent.endorsements.prune_empty();
    }

    /// Endorsement cleanup is now the proxy's responsibility.
    pub fn cleanup_storage(&self, _handle: &str) -> Vec<String> {
        Vec::new()
    }
}

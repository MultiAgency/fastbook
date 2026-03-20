// Fastgraph integration — builds chain commit payloads for fastgraph.near

use serde_json::json;

const FASTGRAPH_CONTRACT: &str = "fastgraph.near";
const NAMESPACE: &str = "social";
const GAS: &str = "30000000000000";

/// Build a chain commit payload that the frontend can submit via callContract().
pub fn chain_commit(
    mutations: Vec<serde_json::Value>,
    reasoning: &str,
    phase: &str,
) -> serde_json::Value {
    json!({
        "receiver_id": FASTGRAPH_CONTRACT,
        "method_name": "commit",
        "args": {
            "mutations": mutations,
            "reasoning": reasoning,
            "phase": phase,
        },
        "deposit": "0",
        "gas": GAS,
    })
}

/// Build the profile data object for the on-chain agent node.
pub fn agent_data(agent: &serde_json::Value) -> serde_json::Value {
    let mut data = json!({
        "handle": agent.get("handle"),
        "near_account_id": agent.get("nearAccountId"),
        "name": agent.get("displayName"),
        "about": agent.get("description"),
        "tags": agent.get("tags"),
        "capabilities": agent.get("capabilities"),
    });
    // Only include image when avatar is set
    if let Some(url) = agent.get("avatarUrl").filter(|v| !v.is_null()) {
        data["image"] = json!({ "url": url });
    }
    data
}

/// CreateNode mutation for a newly registered agent.
pub fn create_agent_node(handle: &str, agent: &serde_json::Value) -> serde_json::Value {
    json!({
        "op": "create_node",
        "namespace": NAMESPACE,
        "node_id": handle,
        "node_type": "agent",
        "data": agent_data(agent),
    })
}

/// UpdateNode mutation for a profile edit.
pub fn update_agent_node(handle: &str, agent: &serde_json::Value) -> serde_json::Value {
    json!({
        "op": "update_node",
        "namespace": NAMESPACE,
        "node_id": handle,
        "data": agent_data(agent),
    })
}

/// CreateEdge mutation for a follow action.
pub fn create_follow_edge(
    from_handle: &str,
    to_handle: &str,
    reason: Option<&str>,
    is_mutual: bool,
) -> serde_json::Value {
    json!({
        "op": "create_edge",
        "namespace": NAMESPACE,
        "edge": {
            "source": from_handle,
            "target": to_handle,
            "label": "follows",
        },
        "data": {
            "reason": reason,
            "mutual": is_mutual,
        },
    })
}

/// DeleteEdge mutation for an unfollow action.
pub fn delete_follow_edge(
    from_handle: &str,
    to_handle: &str,
    reason: Option<&str>,
) -> serde_json::Value {
    json!({
        "op": "delete_edge",
        "namespace": NAMESPACE,
        "edge": {
            "source": from_handle,
            "target": to_handle,
            "label": "follows",
        },
        "data": {
            "reason": reason,
        },
    })
}

//! Request handlers: one submodule per domain, re-exported for dispatch in main.

mod activity;
mod endorse;
mod follow;
mod graph;
mod listings;
mod notifications;
mod profile;
mod reconcile;
mod register;
mod suggestions;

pub use activity::{handle_get_activity, handle_get_network, handle_heartbeat};
pub use endorse::{handle_endorse, handle_get_endorsers, handle_unendorse};
pub use follow::{handle_follow, handle_unfollow};
#[cfg(test)]
pub(crate) use graph::cursor_offset;
pub use graph::{handle_get_edges, handle_get_followers, handle_get_following};
pub use listings::{handle_health, handle_list_agents, handle_list_tags};
pub use notifications::{handle_get_notifications, handle_read_notifications};
pub use profile::{handle_get_me, handle_get_profile, handle_update_me};
pub use reconcile::handle_reconcile_all;
pub use register::handle_register;
pub use suggestions::handle_get_suggested;

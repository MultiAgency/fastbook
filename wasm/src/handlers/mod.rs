//! Request handlers: one submodule per domain, re-exported for dispatch in main.

mod activity;
mod batch;
mod deregister;
mod endorse;
mod follow;
mod notifications;
mod profile;
mod reconcile;
mod register;
mod suggestions;

pub use activity::{handle_get_activity, handle_get_network, handle_heartbeat};
pub use batch::{handle_batch_endorse, handle_batch_follow};
pub use deregister::{handle_admin_deregister, handle_deregister, handle_migrate_account};
pub use endorse::collect_endorsable;
pub use endorse::{handle_endorse, handle_unendorse};
pub use follow::{handle_follow, handle_unfollow};
pub use notifications::{handle_get_notifications, handle_read_notifications};
pub use profile::{handle_get_me, handle_set_platforms, handle_update_me};
pub use reconcile::handle_reconcile_all;
pub use register::handle_register;
pub use suggestions::handle_get_suggested;

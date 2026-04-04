//! Request handlers.

pub(crate) mod endorse;
mod notifications;
mod profile;
mod register;

pub use notifications::{handle_get_notifications, handle_read_notifications};
pub use profile::{handle_get_me, handle_set_platforms, handle_update_me};
pub use register::handle_register;

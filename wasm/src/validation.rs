//! Input validation: handles, tags, descriptions, capabilities, and avatar URLs.

use crate::types::*;
use std::collections::HashSet;

pub(crate) fn validate_handle(handle: &str) -> Result<String, AppError> {
    let lower = handle.to_lowercase();
    if lower.len() < MIN_HANDLE_LEN || lower.len() > MAX_HANDLE_LEN {
        return Err(AppError::Validation(format!(
            "Handle must be {MIN_HANDLE_LEN}-{MAX_HANDLE_LEN} characters"
        )));
    }
    if !lower.starts_with(|c: char| c.is_ascii_lowercase()) {
        return Err(AppError::Validation(
            "Handle must start with a letter".into(),
        ));
    }
    if !lower.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(AppError::Validation(
            "Handle must be alphanumeric or underscore".into(),
        ));
    }
    if RESERVED_HANDLES.contains(&lower.as_str()) {
        return Err(AppError::Validation("Handle is reserved".into()));
    }
    Ok(lower)
}

fn reject_unsafe_unicode(s: &str, allow_newline: bool) -> Result<(), AppError> {
    for c in s.chars() {
        if c.is_control() && !(allow_newline && c == '\n') {
            return Err(AppError::Validation(format!(
                "Text contains invalid control character U+{:04X}",
                c as u32
            )));
        }
        if matches!(c,
            '\u{200B}'..='\u{200F}' |
            '\u{202A}'..='\u{202E}' |
            '\u{2066}'..='\u{2069}' |
            '\u{FEFF}'
        ) {
            return Err(AppError::Validation(format!(
                "Text contains disallowed Unicode character U+{:04X}",
                c as u32
            )));
        }
    }
    Ok(())
}

pub(crate) fn validate_description(desc: &str) -> Result<(), AppError> {
    if desc.len() > MAX_DESCRIPTION_LEN {
        return Err(AppError::Validation(format!(
            "Description max {MAX_DESCRIPTION_LEN} bytes"
        )));
    }
    reject_unsafe_unicode(desc, true)?;
    Ok(())
}

pub(crate) fn validate_display_name(name: &str) -> Result<(), AppError> {
    if name.len() > MAX_DISPLAY_NAME_LEN {
        return Err(AppError::Validation(format!(
            "Display name max {MAX_DISPLAY_NAME_LEN} bytes"
        )));
    }
    reject_unsafe_unicode(name, false)?;
    Ok(())
}

fn is_ipv6_loopback_or_unspecified(host: &str) -> bool {
    if !host.contains(':') {
        return false;
    }
    let stripped: String = host.chars().filter(|&c| c != ':' && c != '0').collect();
    stripped.is_empty() || stripped == "1"
}

fn is_rfc1918_172(host: &str) -> bool {
    if let Some(rest) = host.strip_prefix("172.") {
        if let Some(second_octet) = rest.split('.').next().and_then(|s| s.parse::<u8>().ok()) {
            return (16..=31).contains(&second_octet);
        }
    }
    false
}

fn is_private_host(host: &str) -> bool {
    // Loopback and unspecified
    host == "localhost"
        || host == "127.0.0.1"
        || host == "0.0.0.0"
        || host == "::"
        || host == "::1"
        || is_ipv6_loopback_or_unspecified(host)
        // Link-local and RFC-1918
        || host.starts_with("169.254.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || is_rfc1918_172(host)
        // mDNS / internal TLDs
        || host.ends_with(".local")
        || host.ends_with(".internal")
        // IPv6 private ranges
        || host.starts_with("fe80:")
        || host.starts_with("fc00:")
        || (host.starts_with("fd") && host.contains(':'))
        // IPv4-mapped IPv6
        || host.starts_with("::ffff:10.")
        || host.starts_with("::ffff:127.")
        || host.starts_with("::ffff:169.254.")
        || host.starts_with("::ffff:192.168.")
        || (host.starts_with("::ffff:172.") && is_rfc1918_172(&host[7..]))
        // Bare decimal / hex / octal IP obfuscation
        || host.chars().all(|c| c.is_ascii_digit())
        || (host.starts_with("0x") && host[2..].chars().all(|c| c.is_ascii_hexdigit()))
        || (host.contains('.')
            && host
                .split('.')
                .all(|seg| !seg.is_empty() && seg.chars().all(|c| matches!(c, '0'..='7')))
            && host
                .split('.')
                .any(|seg| seg.len() > 1 && seg.starts_with('0')))
}

pub(crate) fn validate_avatar_url(url: &str) -> Result<(), AppError> {
    if url.len() > MAX_AVATAR_URL_LEN {
        return Err(AppError::Validation(format!(
            "Avatar URL max {MAX_AVATAR_URL_LEN} bytes"
        )));
    }
    if !url.starts_with("https://") {
        return Err(AppError::Validation("Avatar URL must use https://".into()));
    }
    let after_scheme = &url["https://".len()..];
    let authority = after_scheme.split('/').next().unwrap_or("");
    if authority.contains('@') {
        return Err(AppError::Validation(
            "Avatar URL must not contain credentials".into(),
        ));
    }
    let hostname = if authority.starts_with('[') {
        authority
            .split(']')
            .next()
            .unwrap_or("")
            .trim_start_matches('[')
    } else {
        authority.split(':').next().unwrap_or("")
    };
    if hostname.is_empty() {
        return Err(AppError::Validation(
            "Avatar URL must have a valid host".into(),
        ));
    }
    let lower_host = hostname.to_lowercase();
    if is_private_host(&lower_host) {
        return Err(AppError::Validation(
            "Avatar URL must not point to local or internal hosts".into(),
        ));
    }
    reject_unsafe_unicode(url, false)?;
    Ok(())
}

pub(crate) fn validate_reason(reason: &str) -> Result<(), AppError> {
    if reason.len() > MAX_REASON_LEN {
        return Err(AppError::Validation(format!(
            "Reason max {MAX_REASON_LEN} bytes"
        )));
    }
    reject_unsafe_unicode(reason, true)?;
    Ok(())
}

pub(crate) fn validate_agent_fields(req: &Request) -> Result<Vec<String>, Response> {
    let warnings = Vec::new();
    if let Some(desc) = &req.description {
        validate_description(desc).map_err(Response::from)?;
    }
    if let Some(dn) = &req.display_name {
        validate_display_name(dn).map_err(Response::from)?;
    }
    if let Some(Some(url)) = &req.avatar_url {
        validate_avatar_url(url).map_err(Response::from)?;
    }
    if let Some(caps) = &req.capabilities {
        validate_capabilities(caps).map_err(Response::from)?;
    }
    Ok(warnings)
}

fn walk_capabilities(
    val: &serde_json::Value,
    prefix: &str,
    depth: usize,
    out: &mut Vec<(String, String)>,
) {
    if depth > MAX_CAPABILITY_DEPTH {
        return;
    }
    match val {
        serde_json::Value::String(s) if !prefix.is_empty() => {
            out.push((prefix.to_string(), s.to_lowercase()));
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                if let Some(s) = item.as_str() {
                    out.push((prefix.to_string(), s.to_lowercase()));
                }
            }
        }
        serde_json::Value::Object(obj) => {
            for (key, child) in obj {
                let ns = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                walk_capabilities(child, &ns, depth + 1, out);
            }
        }
        _ => {}
    }
}

pub(crate) fn extract_capability_pairs(caps: &serde_json::Value) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    walk_capabilities(caps, "", 0, &mut pairs);
    pairs
}

pub(crate) fn validate_capabilities(caps: &serde_json::Value) -> Result<(), AppError> {
    let serialized = serde_json::to_string(caps)
        .map_err(|e| AppError::Validation(format!("Invalid capabilities: {e}")))?;
    if serialized.len() > MAX_CAPABILITIES_LEN {
        return Err(AppError::Validation(format!(
            "Capabilities JSON max {MAX_CAPABILITIES_LEN} bytes"
        )));
    }
    validate_capabilities_content(caps, 0)?;
    Ok(())
}

fn validate_capabilities_content(val: &serde_json::Value, depth: usize) -> Result<(), AppError> {
    if depth > MAX_CAPABILITY_DEPTH {
        return Err(AppError::Validation(format!(
            "Capabilities exceed maximum nesting depth of {MAX_CAPABILITY_DEPTH}"
        )));
    }
    match val {
        serde_json::Value::Object(obj) => {
            for (key, child) in obj {
                reject_unsafe_unicode(key, false)
                    .map_err(|e| AppError::Validation(format!("Capability key: {e}")))?;
                if key.contains(':') {
                    return Err(AppError::Validation(
                        "Capability key must not contain colons".into(),
                    ));
                }
                validate_capabilities_content(child, depth + 1)?;
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                validate_capabilities_content(item, depth + 1)?;
            }
        }
        serde_json::Value::String(s) => {
            reject_unsafe_unicode(s, false)
                .map_err(|e| AppError::Validation(format!("Capability value: {e}")))?;
            if s.contains(':') {
                return Err(AppError::Validation(
                    "Capability value must not contain colons".into(),
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn validate_tags(tags: &[String]) -> Result<Vec<String>, AppError> {
    if tags.len() > MAX_TAGS {
        return Err(AppError::Validation(format!("Maximum {MAX_TAGS} tags")));
    }
    let mut seen = HashSet::new();
    let mut validated = Vec::new();
    for tag in tags {
        let t = tag.to_lowercase();
        if t.is_empty() {
            return Err(AppError::Validation("Tag must not be empty".into()));
        }
        if t.len() > MAX_TAG_LEN {
            return Err(AppError::Validation(format!(
                "Tag must be at most {MAX_TAG_LEN} characters"
            )));
        }
        if !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(AppError::Validation(
                "Tags must be lowercase alphanumeric with hyphens".into(),
            ));
        }
        if seen.insert(t.clone()) {
            validated.push(t);
        }
    }
    Ok(validated)
}

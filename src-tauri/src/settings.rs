use crate::{
    error::{AppError, Result},
    model::PersistedState,
};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

pub fn defaults() -> Value {
    json!({
        "theme":"dark","detailPosition":"inline","diffView":"unified","graphStyle":"curved",
        "dateFormat":"local","dateSource":"author","pageSize":300,"initialLoad":300,"loadMore":100,
        "order":"date","rowHeight":28,"fontSize":13,
        "graphColors":["#80b8e5","#d4a5d9","#9bc487","#d9b678","#74c2bd","#e09696","#9caced","#c4c787"],
        "showRemotes":true,"showTags":true,"showStashes":true,"showRemoteHeads":false,
        "showUncommitted":true,"showUntracked":true,"includeTagOnly":true,"collapseStashAuxiliary":true,
        "firstParent":false,"includeReflog":false,"autoLoad":true,"compactFolders":true,"fileView":"tree",
        "avatars":false,"mailmap":false,"encoding":"utf-8","gitPath":"","editorPath":"","terminalPath":"",
        "editorArgs":["{file}"],"terminalArgs":[],"issueUrl":"","pullRequestUrl":"","issueRules":[],
        "pullRequestProviders":[],"markdown":false,"emoji":true,"customEmoji":{},"branchGroups":[],
        "startupScope":{"kind":"all"},"scrollToHead":false,"autoCenterDetails":true,
        "muteMerges":true,"muteNonAncestors":false,"labelAlignment":"normal","combineLabels":true,
        "uncommittedStyle":"open","signatureDisplay":false,"commitSigning":"git","tagSigning":"git",
        "repositorySort":"recent","discoveryDepth":0,"referenceSpace":"none",
        "shortcuts":{"find":"Ctrl+F","refresh":"Ctrl+R","head":"Ctrl+H","stash":"Ctrl+S"},
        "dialogDefaults":{"tagType":"annotated","tagPush":false,"reinstateIndex":false,"recordOrigin":false,
            "noCommit":false,"checkoutAfterCreate":false,"forceDelete":false,"forceFetch":false,
            "fetchPrune":false,"fetchPruneTags":false,"mergeNoFastForward":true,"mergeNoCommit":false,
            "mergeSquash":false,"pullMode":"merge","pullNoFastForward":false,"pullSquash":false,
            "squashMessage":"default","rebaseIgnoreDate":true,"rebaseInteractive":false,
            "rebasePreserveMerges":false,"resetMode":"mixed","worktreeResetMode":"mixed","stashIncludeUntracked":true},
        "contextActions":{},"columns":{"date":true,"author":true,"commit":true},
        "columnWidths":{"graph":144,"date":154,"author":150,"commit":92},
        "hiddenActions":[],"defaultRemote":"origin","confirmCheckout":true
    })
}

fn invalid(path: &str, message: &str) -> AppError {
    AppError::new("SETTINGS", format!("{path}: {message}"))
}
fn text(value: &Value, path: &str, limit: usize) -> Result<()> {
    let s = value
        .as_str()
        .ok_or_else(|| invalid(path, "expected a string"))?;
    if s.len() > limit || s.contains('\0') {
        return Err(invalid(path, "text exceeds its limit or contains NUL"));
    }
    Ok(())
}
fn enum_value(value: &Value, path: &str, allowed: &[&str]) -> Result<()> {
    if !value.as_str().is_some_and(|v| allowed.contains(&v)) {
        return Err(invalid(path, "invalid selection"));
    }
    Ok(())
}
fn number(value: &Value, path: &str, min: u64, max: u64) -> Result<()> {
    if !value.as_u64().is_some_and(|v| v >= min && v <= max) {
        return Err(invalid(
            path,
            &format!("expected an integer from {min} to {max}"),
        ));
    }
    Ok(())
}
fn strings(value: &Value, path: &str, count: usize, length: usize) -> Result<()> {
    let items = value
        .as_array()
        .ok_or_else(|| invalid(path, "expected an array"))?;
    if items.len() > count {
        return Err(invalid(path, "too many entries"));
    }
    for item in items {
        text(item, path, length)?;
    }
    Ok(())
}
fn object(value: &Value, path: &str) -> Result<()> {
    if !value.is_object() {
        return Err(invalid(path, "expected an object"));
    }
    Ok(())
}
fn validate_like(value: &Value, default: &Value, path: &str) -> Result<()> {
    if let Some(object) = value.as_object() {
        let shape = default
            .as_object()
            .ok_or_else(|| invalid(path, "unexpected object"))?;
        for (key, item) in object {
            let expected = shape
                .get(key)
                .ok_or_else(|| invalid(&format!("{path}.{key}"), "unknown setting"))?;
            validate_like(item, expected, &format!("{path}.{key}"))?;
        }
        return Ok(());
    }
    match default {
        Value::Bool(_) if value.is_boolean() => Ok(()),
        Value::Number(_) => number(value, path, 0, 1000000),
        Value::String(_) => text(value, path, 32768),
        Value::Array(_) if value.is_array() => Ok(()),
        _ => Err(invalid(path, "incorrect setting type")),
    }
}

pub fn validate_scope(value: &Value, path: &str) -> Result<()> {
    object(value, path)?;
    enum_value(
        value.get("kind").unwrap_or(&Value::Null),
        path,
        &["all", "head", "refs", "glob"],
    )?;
    for name in ["refs", "include", "exclude"] {
        if let Some(values) = value.get(name) {
            strings(values, path, 2048, 1024)?;
        }
    }
    if value
        .as_object()
        .unwrap()
        .keys()
        .any(|k| !["kind", "refs", "include", "exclude"].contains(&k.as_str()))
    {
        return Err(invalid(path, "unknown range field"));
    }
    Ok(())
}

pub fn validate_settings(value: &Value, partial: bool, shareable: bool) -> Result<()> {
    object(value, "settings")?;
    let shape = defaults();
    let shape = shape.as_object().unwrap();
    for (key, item) in value.as_object().unwrap() {
        let path = format!("settings.{key}");
        let default = shape
            .get(key)
            .ok_or_else(|| invalid(&path, "unknown setting"))?;
        if shareable && !is_shareable(key) {
            return Err(invalid(&path, "not allowed in shared configuration"));
        }
        match key.as_str() {
            "branchGroups" => {
                let groups = item
                    .as_array()
                    .ok_or_else(|| invalid(&path, "expected an array"))?;
                if groups.len() > 100 {
                    return Err(invalid(&path, "too many branch groups"));
                }
                let mut names = HashSet::new();
                for group in groups {
                    object(group, &path)?;
                    let name = group
                        .get("name")
                        .ok_or_else(|| invalid(&path, "missing group name"))?;
                    text(name, &path, 120)?;
                    if name.as_str().unwrap().trim().is_empty()
                        || !names.insert(name.as_str().unwrap())
                    {
                        return Err(invalid(&path, "group names must be nonempty and unique"));
                    }
                    strings(group.get("include").unwrap_or(&json!([])), &path, 100, 1024)?;
                    strings(group.get("exclude").unwrap_or(&json!([])), &path, 100, 1024)?;
                }
            }
            "startupScope" => validate_scope(item, &path)?,
            "customEmoji" => {
                object(item, &path)?;
                if item.as_object().unwrap().len() > 1000 {
                    return Err(invalid(&path, "too many mappings"));
                }
                for (name, value) in item.as_object().unwrap() {
                    if name.is_empty()
                        || name.len() > 80
                        || !name
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_+-".contains(&b))
                    {
                        return Err(invalid(&path, "invalid emoji shortcode"));
                    }
                    text(value, &path, 100)?;
                }
            }
            "contextActions" => {
                object(item, &path)?;
                if item.as_object().unwrap().len() > 20 {
                    return Err(invalid(&path, "too many contexts"));
                }
                for (context, actions) in item.as_object().unwrap() {
                    if ![
                        "branch",
                        "remote",
                        "remoteBranch",
                        "commit",
                        "tag",
                        "stash",
                        "worktree",
                    ]
                    .contains(&context.as_str())
                    {
                        return Err(invalid(&path, "unknown menu context"));
                    }
                    strings(actions, &path, 100, 80)?;
                }
            }
            "issueRules" => {
                let items = item
                    .as_array()
                    .ok_or_else(|| invalid(&path, "expected an array"))?;
                if items.len() > 30 {
                    return Err(invalid(&path, "too many issue rules"));
                }
                for item in items {
                    object(item, &path)?;
                    let pattern = item.get("pattern").unwrap_or(&Value::Null);
                    text(pattern, &path, 128)?;
                    validate_issue_pattern(pattern.as_str().unwrap())?;
                    validate_url_template(item.get("url").unwrap_or(&Value::Null), &path)?;
                }
            }
            "pullRequestProviders" => {
                let items = item
                    .as_array()
                    .ok_or_else(|| invalid(&path, "expected an array"))?;
                if items.len() > 30 {
                    return Err(invalid(&path, "too many providers"));
                }
                for item in items {
                    object(item, &path)?;
                    text(item.get("name").unwrap_or(&Value::Null), &path, 120)?;
                    text(item.get("host").unwrap_or(&Value::Null), &path, 255)?;
                    validate_url_template(item.get("url").unwrap_or(&Value::Null), &path)?;
                }
            }
            "graphColors" => {
                strings(item, &path, 32, 9)?;
                if item.as_array().unwrap().is_empty()
                    || item.as_array().unwrap().iter().any(|v| {
                        let s = v.as_str().unwrap();
                        !(s.starts_with('#')
                            && matches!(s.len(), 4 | 7)
                            && s[1..].bytes().all(|c| c.is_ascii_hexdigit()))
                    })
                {
                    return Err(invalid(&path, "use hexadecimal graph colors"));
                }
            }
            "editorArgs" | "terminalArgs" => {
                strings(item, &path, 32, 4096)?;
                for v in item.as_array().unwrap() {
                    if v.as_str().unwrap().chars().any(char::is_control) {
                        return Err(invalid(
                            &path,
                            "tool arguments cannot contain control characters",
                        ));
                    }
                }
            }
            "hiddenActions" => strings(item, &path, 100, 80)?,
            _ => validate_like(item, default, &path)?,
        }
        match key.as_str() {
            "theme" => enum_value(item, &path, &["dark", "light", "system"])?,
            "detailPosition" => enum_value(item, &path, &["inline", "bottom", "right"])?,
            "diffView" => enum_value(item, &path, &["unified", "split"])?,
            "graphStyle" => enum_value(item, &path, &["curved", "angular"])?,
            "dateFormat" => enum_value(
                item,
                &path,
                &["relative", "iso", "local", "date", "iso-date"],
            )?,
            "dateSource" => enum_value(item, &path, &["author", "committer"])?,
            "order" => enum_value(item, &path, &["topo", "date", "author-date"])?,
            "fileView" => enum_value(item, &path, &["tree", "list"])?,
            "commitSigning" | "tagSigning" => enum_value(item, &path, &["git", "sign", "no-sign"])?,
            "repositorySort" => enum_value(item, &path, &["recent", "name", "path"])?,
            "referenceSpace" => enum_value(item, &path, &["none", "hyphen", "underscore"])?,
            "labelAlignment" => enum_value(item, &path, &["normal", "branches", "right"])?,
            "uncommittedStyle" => enum_value(item, &path, &["open", "filled"])?,
            "pageSize" | "initialLoad" | "loadMore" => number(item, &path, 10, 1000)?,
            "rowHeight" => number(item, &path, 22, 60)?,
            "fontSize" => number(item, &path, 11, 20)?,
            "discoveryDepth" => number(item, &path, 0, 5)?,
            "issueUrl" | "pullRequestUrl" => {
                if item.as_str() != Some("") {
                    validate_url_template(item, &path)?;
                }
            }
            "shortcuts" => {
                for (_, value) in item.as_object().unwrap() {
                    text(value, &path, 80)?;
                }
            }
            "columnWidths" => {
                for (name, value) in item.as_object().unwrap() {
                    number(value, &path, 60, if name == "graph" { 640 } else { 400 })?;
                }
            }
            "dialogDefaults" => {
                for (name, choices) in [
                    ("tagType", vec!["lightweight", "annotated"]),
                    ("pullMode", vec!["ff-only", "merge", "rebase"]),
                    ("squashMessage", vec!["default", "summary"]),
                    ("resetMode", vec!["soft", "mixed", "hard", "keep"]),
                    ("worktreeResetMode", vec!["mixed", "hard"]),
                ] {
                    if let Some(value) = item.get(name) {
                        enum_value(value, &path, &choices)?;
                    }
                }
            }
            _ => {}
        }
    }
    if !partial {
        for key in shape.keys() {
            if !value.as_object().unwrap().contains_key(key) {
                return Err(invalid(key, "required default setting is missing"));
            }
        }
    }
    Ok(())
}
fn validate_issue_pattern(pattern: &str) -> Result<()> {
    if pattern.is_empty() || pattern.len() > 128 || pattern.chars().any(char::is_control) {
        return Err(invalid("issueRules.pattern", "invalid pattern"));
    }
    let mut value = pattern;
    if let Some(stripped) = value.strip_prefix('^') {
        value = stripped;
    }
    if let Some(stripped) = value.strip_prefix("\\b") {
        value = stripped;
    }
    if value.ends_with('$') && !value.ends_with("\\$") {
        value = &value[..value.len() - 1];
    }
    if let Some(stripped) = value.strip_suffix("\\b") {
        value = stripped;
    }
    let markers = ["(\\d+)", "([0-9]+)"];
    let Some(marker) = markers.into_iter().find(|marker| value.contains(marker)) else {
        return Err(invalid(
            "issueRules.pattern",
            "expected one numeric capture",
        ));
    };
    let (prefix, suffix) = value.split_once(marker).unwrap();
    if prefix.is_empty() && suffix.is_empty() {
        return Err(invalid(
            "issueRules.pattern",
            "a literal issue prefix or suffix is required",
        ));
    }
    for literal in [prefix, suffix] {
        let mut chars = literal.chars();
        while let Some(character) = chars.next() {
            if character == '\\' {
                if !chars
                    .next()
                    .is_some_and(|next| "\\.^$|?*+()[]{}#-".contains(next))
                {
                    return Err(invalid("issueRules.pattern", "invalid literal escape"));
                }
            } else if ".^$|?*+()[]{}".contains(character) {
                return Err(invalid(
                    "issueRules.pattern",
                    "only literal prefix/suffix and one numeric capture are supported",
                ));
            }
        }
    }
    Ok(())
}
fn validate_url_template(value: &Value, path: &str) -> Result<()> {
    text(value, path, 4096)?;
    let value = value.as_str().unwrap();
    let mut url = value.to_owned();
    for key in ["baseUrl", "remoteWebBase", "remote"] {
        url = url.replace(&format!("{{{key}}}"), "https://example.invalid/owner/repo");
    }
    for key in [
        "id", "commit", "branch", "source", "target", "owner", "repo", "host", "base", "head",
        "match",
    ] {
        url = url.replace(&format!("{{{key}}}"), "example");
    }
    let parsed = url::Url::parse(&url).map_err(|_| invalid(path, "invalid URL template"))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(invalid(path, "expected HTTP(S) without credentials"));
    }
    Ok(())
}

pub fn merge(base: &Value, patch: &Value) -> Value {
    if let (Some(base), Some(patch)) = (base.as_object(), patch.as_object()) {
        let mut values = base.clone();
        for (key, value) in patch {
            let next = values
                .get(key)
                .map(|old| merge(old, value))
                .unwrap_or_else(|| value.clone());
            values.insert(key.clone(), next);
        }
        Value::Object(values)
    } else {
        patch.clone()
    }
}
pub fn effective(state: &PersistedState, repo_id: Option<&str>) -> Value {
    let value = merge(&defaults(), &state.settings);
    repo_id
        .and_then(|id| state.repo_settings.get(id))
        .map(|patch| merge(&value, patch))
        .unwrap_or(value)
}
pub fn migrate(mut state: PersistedState) -> Result<PersistedState> {
    if !matches!(state.version, 1 | 2) {
        return Err(invalid("version", "unsupported state version"));
    }
    if state.version == 1 {
        if let Some(size) = state.settings.get("pageSize").cloned() {
            state
                .settings
                .as_object_mut()
                .ok_or_else(|| invalid("settings", "expected object"))?
                .entry("initialLoad")
                .or_insert(size.clone());
            state
                .settings
                .as_object_mut()
                .unwrap()
                .entry("loadMore")
                .or_insert(size);
        }
        for patch in state.repo_settings.values_mut() {
            if let Some(size) = patch.get("pageSize").cloned() {
                if let Some(obj) = patch.as_object_mut() {
                    obj.entry("initialLoad").or_insert(size.clone());
                    obj.entry("loadMore").or_insert(size);
                }
            }
            if let Some(obj) = patch.as_object_mut() {
                obj.remove("gitPath");
            }
        }
        state.version = 2;
    }
    validate_settings(&state.settings, true, false)?;
    for (repo, patch) in &state.repo_settings {
        validate_settings(patch, true, false)?;
        if patch.get("gitPath").is_some() {
            return Err(invalid(
                repo,
                "Git executable is global-only; move this value to global settings",
            ));
        }
    }
    state.settings = merge(&defaults(), &state.settings);
    validate_state(&state)?;
    Ok(state)
}
pub fn validate_state(state: &PersistedState) -> Result<()> {
    if state.version != 2
        || state.recent.len() > 100
        || state.repo_settings.len() > 1000
        || state.reviews.len() > 500
        || state.views.len() > 1000
    {
        return Err(invalid("state", "unsupported version or too many entries"));
    }
    validate_settings(&state.settings, true, false)?;
    for patch in state.repo_settings.values() {
        validate_settings(patch, true, false)?;
        if patch.get("gitPath").is_some() {
            return Err(invalid(
                "gitPath",
                "Git executable can only be configured globally",
            ));
        }
    }
    for value in [&state.layout] {
        object(value, "layout")?;
        for key in ["detailSize", "fileSize"] {
            if let Some(v) = value.get(key) {
                number(v, "layout", 100, 2000)?;
            }
        }
    }
    for review in &state.reviews {
        object(review, "review")?;
        for field in ["key", "repoId"] {
            text(review.get(field).unwrap_or(&Value::Null), "review", 32768)?;
        }
        strings(
            review.get("paths").unwrap_or(&Value::Null),
            "review.paths",
            20000,
            32768,
        )?;
        if !review.get("updatedAt").is_some_and(Value::is_number) {
            return Err(invalid("review.updatedAt", "expected timestamp"));
        }
    }
    for view in state.views.values() {
        object(view, "view")?;
        if let Some(scope) = view.get("scope") {
            validate_scope(scope, "view.scope")?;
        }
    }
    if serde_json::to_vec(state).map_err(AppError::io)?.len() > 4 * 1024 * 1024 {
        return Err(invalid("state", "application state exceeds 4 MiB"));
    }
    Ok(())
}
pub fn is_shareable(key: &str) -> bool {
    ![
        "gitPath",
        "editorPath",
        "terminalPath",
        "editorArgs",
        "terminalArgs",
        "avatars",
    ]
    .contains(&key)
}
pub fn shared_settings(value: &Value) -> Result<(Value, Vec<String>)> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("import", "expected an object"))?;
    let mut settings = Map::new();
    let mut warnings = Vec::new();
    let shape = defaults();
    for (key, value) in object {
        if shape.get(key).is_none() || !is_shareable(key) {
            warnings.push(format!("Skipped private or unknown field: {key}"));
            continue;
        }
        settings.insert(key.clone(), value.clone());
    }
    let value = Value::Object(settings);
    validate_settings(&value, true, true)?;
    Ok((value, warnings))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_schema_is_valid() {
        validate_settings(&defaults(), false, false).unwrap();
    }
    #[test]
    fn preserves_v1_preferences_and_leaf_inheritance() {
        let state = PersistedState {
            version: 1,
            settings: json!({"mailmap":true,"detailPosition":"right","pageSize":200}),
            ..PersistedState::default()
        };
        let state = migrate(state).unwrap();
        assert_eq!(state.settings["loadMore"], 200);
        assert_eq!(state.settings["mailmap"], true);
        assert_eq!(state.settings["detailPosition"], "right");
        assert_eq!(
            merge(&defaults(), &json!({"columns":{"date":false}}))["columns"]["author"],
            true
        );
    }
    #[test]
    fn shared_config_cannot_smuggle_private_fields() {
        let (value, warnings) = shared_settings(
            &json!({"gitPath":"bad.exe","avatars":true,"theme":"light","trusted":["x"]}),
        )
        .unwrap();
        assert_eq!(value, json!({"theme":"light"}));
        assert_eq!(warnings.len(), 3);
    }
    #[test]
    fn rejects_invalid_nested_parameters() {
        assert!(
            validate_settings(&json!({"dialogDefaults":{"pullMode":"shell"}}), true, false)
                .is_err()
        );
        assert!(validate_settings(&json!({"rowHeight":0}), true, false).is_err());
        assert!(validate_settings(&json!({"showTags":"yes"}), true, false).is_err());
    }
}

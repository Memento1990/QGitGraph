use crate::{
    error::{AppError, Result},
    model::PersistedState,
};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

pub(crate) fn write_native_json(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("state", "invalid native storage path"))?;
    std::fs::create_dir_all(parent).map_err(AppError::io)?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(AppError::io)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                0x1 | 0x8,
            )
        } == 0
        {
            return Err(AppError::io(std::io::Error::last_os_error()));
        }
    }
    #[cfg(not(windows))]
    std::fs::rename(&temporary, path).map_err(AppError::io)?;
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) enum DialogTitle {
    Repository,
    Directory,
    Import,
    Export,
    Archive,
}

fn is_chinese_locale(locale: &str) -> bool {
    locale
        .split(['-', '_', '.', '@'])
        .next()
        .is_some_and(|language| language.eq_ignore_ascii_case("zh"))
}

fn system_uses_chinese() -> bool {
    #[cfg(windows)]
    {
        let mut locale = [0_u16; 85];
        let length = unsafe {
            windows_sys::Win32::Globalization::GetUserDefaultLocaleName(
                locale.as_mut_ptr(),
                locale.len() as i32,
            )
        };
        length > 1 && is_chinese_locale(&String::from_utf16_lossy(&locale[..length as usize - 1]))
    }
    #[cfg(not(windows))]
    {
        ["LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .filter_map(|name| std::env::var(name).ok())
            .find(|locale| !locale.is_empty())
            .is_some_and(|locale| is_chinese_locale(&locale))
    }
}

fn title_for_language(language: &str, chinese_system: bool, title: DialogTitle) -> &'static str {
    let chinese = language == "zh-CN" || (language == "system" && chinese_system);
    match (chinese, title) {
        (false, DialogTitle::Repository) => "Open a Git repository",
        (false, DialogTitle::Directory) => "Open a directory of Git repositories",
        (false, DialogTitle::Import) => "Import shareable QGitGraph configuration",
        (false, DialogTitle::Export) => "Export shareable QGitGraph configuration",
        (false, DialogTitle::Archive) => "Export repository archive",
        (true, DialogTitle::Repository) => "打开 Git 仓库",
        (true, DialogTitle::Directory) => "打开 Git 仓库所在目录",
        (true, DialogTitle::Import) => "导入可共享的 QGitGraph 配置",
        (true, DialogTitle::Export) => "导出可共享的 QGitGraph 配置",
        (true, DialogTitle::Archive) => "导出仓库归档",
    }
}

pub(crate) fn dialog_title(state: &crate::state::AppState, title: DialogTitle) -> &'static str {
    let persisted = state.persisted.lock().unwrap();
    let language = persisted
        .settings
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("system");
    title_for_language(
        language,
        language == "system" && system_uses_chinese(),
        title,
    )
}

pub fn defaults() -> Value {
    json!({
        "theme":"dark","language":"system","detailPosition":"right","localChangesPosition":"middle","diffView":"unified","graphStyle":"curved",
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
            "language" => enum_value(item, &path, &["system", "en", "zh-CN"])?,
            "detailPosition" => enum_value(item, &path, &["inline", "bottom", "right"])?,
            "localChangesPosition" => enum_value(item, &path, &["middle", "inline"])?,
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
                obj.remove("language");
            }
        }
        state.version = 2;
    }
    validate_settings(&state.settings, true, false)?;
    for (repo, patch) in &state.repo_settings {
        validate_settings(patch, true, false)?;
        for (key, label) in [("gitPath", "Git executable"), ("language", "Language")] {
            if patch.get(key).is_some() {
                return Err(invalid(
                    repo,
                    &format!("{label} is global-only; move this value to global settings"),
                ));
            }
        }
    }
    state.settings = merge(&defaults(), &state.settings);
    state.layout = merge(&layout_defaults(), &state.layout);
    validate_state(&state)?;
    Ok(state)
}
fn valid_collapsed_component(component: &str) -> bool {
    if matches!(component, "" | "." | "..") {
        return false;
    }
    fn unescaped(byte: u8) -> bool {
        byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte)
    }
    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    // Match encodeURIComponent(decodeURIComponent(component)) === component,
    // including uppercase escapes, UTF-8 validity, and unescaped safe ASCII.
    // Decoding here only validates a UI key; it is never a filesystem path.
    let bytes = component.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' && index + 2 < bytes.len() {
            let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) else {
                return false;
            };
            let byte = high * 16 + low;
            if unescaped(byte) {
                return false;
            }
            decoded.push(byte);
            index += 3;
        } else {
            if !unescaped(byte) {
                return false;
            }
            decoded.push(byte);
            index += 1;
        }
    }
    std::str::from_utf8(&decoded).is_ok()
}

pub fn validate_directory_scope(scope: &crate::model::DirectoryScopeState) -> Result<()> {
    crate::discovery::validate_native_path(&scope.root)
        .map_err(|_| invalid("directoryScope.root", "invalid native directory path"))?;
    if !std::path::Path::new(&scope.root).is_absolute() {
        return Err(invalid(
            "directoryScope.root",
            "expected an absolute native directory path",
        ));
    }
    if scope.depth > 5 || !(180..=640).contains(&scope.width) {
        return Err(invalid(
            "directoryScope",
            "depth must be 0..5 and width must be 180..640",
        ));
    }
    if scope.collapsed_paths.len() > 256 {
        return Err(invalid(
            "directoryScope.collapsedPaths",
            "too many collapsed directory keys",
        ));
    }
    for key in &scope.collapsed_paths {
        // Opaque UI-only, canonically percent-encoded relative component keys.
        // Validation must never turn them into filesystem paths.
        if key.len() > 32768 || (!key.is_empty() && !key.split('/').all(valid_collapsed_component))
        {
            return Err(invalid(
                "directoryScope.collapsedPaths",
                "expected a bounded relative directory key",
            ));
        }
    }
    Ok(())
}

fn layout_defaults() -> Value {
    json!({"detailSize":320,"fileSize":260,"localWidth":390,"localListSize":230,"detailRatio":0.55})
}

fn known_fields(value: &Value, path: &str, allowed: &[&str]) -> Result<()> {
    object(value, path)?;
    if let Some(key) = value
        .as_object()
        .unwrap()
        .keys()
        .find(|key| !allowed.contains(&key.as_str()))
    {
        return Err(invalid(&format!("{path}.{key}"), "unknown field"));
    }
    Ok(())
}

fn finite_number(value: &Value, path: &str, min: f64, max: f64) -> Result<()> {
    if !value
        .as_f64()
        .is_some_and(|value| value.is_finite() && value >= min && value <= max)
    {
        return Err(invalid(
            path,
            &format!("expected a finite number from {min} to {max}"),
        ));
    }
    Ok(())
}

fn validate_layout(value: &Value) -> Result<()> {
    known_fields(
        value,
        "layout",
        &[
            "detailSize",
            "fileSize",
            "localWidth",
            "localListSize",
            "detailRatio",
        ],
    )?;
    // Retain the legacy accepted pixel range, including fractional CSS pixel values.
    for key in ["detailSize", "fileSize"] {
        if let Some(item) = value.get(key) {
            finite_number(item, &format!("layout.{key}"), 100.0, 2000.0)?;
        }
    }
    for (key, min, max) in [("localWidth", 240, 960), ("localListSize", 100, 1200)] {
        if let Some(item) = value.get(key) {
            number(item, &format!("layout.{key}"), min, max)?;
        }
    }
    if let Some(item) = value.get("detailRatio") {
        finite_number(item, "layout.detailRatio", 0.2, 0.8)?;
    }
    Ok(())
}

fn validate_view_target(value: &Value) -> Result<()> {
    let oid = |value: Option<&Value>| {
        value.and_then(Value::as_str).is_some_and(|value| {
            matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    };
    let path = "view.detail.selection";
    match value.get("kind").and_then(Value::as_str) {
        Some("working") => known_fields(value, path, &["kind"]),
        Some("commit") => {
            known_fields(value, path, &["kind", "oid", "parent", "base"])?;
            if !oid(value.get("oid"))
                || value.get("parent").is_some_and(|parent| !oid(Some(parent)))
                || value
                    .get("base")
                    .is_some_and(|base| base.as_str() != Some("ROOT") && !oid(Some(base)))
                || matches!((value.get("parent"), value.get("base")), (Some(parent), Some(base)) if parent != base)
            {
                return Err(invalid(
                    path,
                    "expected immutable commit and parent object IDs",
                ));
            }
            Ok(())
        }
        Some("compare") => {
            known_fields(value, path, &["kind", "base", "target"])?;
            if !oid(value.get("base")) || !oid(value.get("target")) {
                return Err(invalid(path, "expected immutable comparison object IDs"));
            }
            Ok(())
        }
        _ => Err(invalid(path, "unknown selection")),
    }
}

fn view_text(value: &Value, path: &str, limit: usize) -> Result<()> {
    let value = value
        .as_str()
        .ok_or_else(|| invalid(path, "expected a string"))?;
    // Match the frontend string.length budget (UTF-16 units), not UTF-8 bytes.
    if value.encode_utf16().count() > limit
        || value
            .chars()
            .any(|character| character <= '\u{1f}' || character == '\u{7f}')
    {
        return Err(invalid(
            path,
            "text exceeds its limit or contains control characters",
        ));
    }
    Ok(())
}

fn validate_view(value: &Value) -> Result<()> {
    known_fields(
        value,
        "view",
        &[
            "scope",
            "search",
            "searchMode",
            "queryMode",
            "order",
            "scrollTop",
            "scrollLeft",
            "selected",
            "detail",
            "filter",
            "collapsed",
        ],
    )?;
    if let Some(scope) = value.get("scope") {
        validate_scope(scope, "view.scope")?;
    }
    if let Some(search) = value.get("search") {
        if search
            .as_str()
            .is_none_or(|value| value.encode_utf16().count() > 32768)
        {
            return Err(invalid("view.search", "expected bounded search text"));
        }
    }
    for (key, choices) in [
        (
            "searchMode",
            &["all", "message", "author", "hash", "date", "refs"][..],
        ),
        ("queryMode", &["filter", "search"][..]),
        ("order", &["topo", "date", "author-date"][..]),
    ] {
        if let Some(item) = value.get(key) {
            enum_value(item, &format!("view.{key}"), choices)?;
        }
    }
    for key in ["scrollTop", "scrollLeft"] {
        if let Some(item) = value.get(key) {
            finite_number(item, &format!("view.{key}"), 0.0, 1_000_000_000.0)?;
        }
    }
    if let Some(item) = value.get("selected").filter(|item| !item.is_null()) {
        view_text(item, "view.selected", 4096)?;
    }
    if let Some(detail) = value.get("detail") {
        known_fields(
            detail,
            "view.detail",
            &[
                "selection",
                "path",
                "scrollTop",
                "filesScrollTop",
                "filesScrollLeft",
                "fullMessage",
                "inlineSide",
            ],
        )?;
        validate_view_target(detail.get("selection").unwrap_or(&Value::Null))?;
        if let Some(path) = detail.get("path") {
            view_text(path, "view.detail.path", 4096)?;
        }
        for key in ["scrollTop", "filesScrollTop", "filesScrollLeft"] {
            if let Some(item) = detail.get(key) {
                finite_number(item, &format!("view.detail.{key}"), 0.0, 1_000_000_000.0)?;
            }
        }
        if detail
            .get("fullMessage")
            .is_some_and(|item| !item.is_boolean())
        {
            return Err(invalid("view.detail.fullMessage", "expected a boolean"));
        }
        if let Some(item) = detail.get("inlineSide") {
            enum_value(item, "view.detail.inlineSide", &["above", "below"])?;
        }
    }
    if let Some(filter) = value.get("filter") {
        object(filter, "view.filter")?;
        if filter.as_object().unwrap().len() > 64 {
            return Err(invalid("view.filter", "too many entries"));
        }
        for (key, item) in filter.as_object().unwrap() {
            if key.is_empty()
                || key.encode_utf16().count() > 4096
                || ["__proto__", "prototype", "constructor"].contains(&key.as_str())
                || key
                    .chars()
                    .any(|character| character <= '\u{1f}' || character == '\u{7f}')
            {
                return Err(invalid("view.filter", "invalid field name"));
            }
            view_text(item, "view.filter", 4096)?;
        }
    }
    if let Some(collapsed) = value.get("collapsed") {
        let items = collapsed
            .as_array()
            .ok_or_else(|| invalid("view.collapsed", "expected an array"))?;
        if items.len() > 10000 {
            return Err(invalid("view.collapsed", "too many entries"));
        }
        for item in items {
            view_text(item, "view.collapsed", 4096)?;
        }
    }
    Ok(())
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
        for (key, label) in [("gitPath", "Git executable"), ("language", "Language")] {
            if patch.get(key).is_some() {
                return Err(invalid(
                    key,
                    &format!("{label} can only be configured globally"),
                ));
            }
        }
    }
    if let Some(scope) = &state.directory_scope {
        validate_directory_scope(scope)?;
    }
    validate_layout(&state.layout)?;
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
        validate_view(view)?;
    }
    if serde_json::to_vec(state).map_err(AppError::io)?.len() > 4 * 1024 * 1024 {
        return Err(invalid("state", "application state exceeds 4 MiB"));
    }
    Ok(())
}
pub fn is_shareable(key: &str) -> bool {
    ![
        "gitPath",
        "language",
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
    fn app_supplied_dialog_titles_resolve_persisted_language_and_native_locale() {
        for title in [
            DialogTitle::Repository,
            DialogTitle::Directory,
            DialogTitle::Import,
            DialogTitle::Export,
            DialogTitle::Archive,
        ] {
            assert!(title_for_language("en", true, title).is_ascii());
            assert!(!title_for_language("zh-CN", false, title).is_ascii());
            assert_eq!(
                title_for_language("system", false, title),
                title_for_language("en", true, title)
            );
            assert_eq!(
                title_for_language("system", true, title),
                title_for_language("zh-CN", false, title)
            );
        }
        for locale in ["zh", "zh-CN", "zh_TW.UTF-8", "ZH-hans-CN"] {
            assert!(is_chinese_locale(locale));
        }
        for locale in ["en", "en-US", "C", "zho", ""] {
            assert!(!is_chinese_locale(locale));
        }
        let directory = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::new(directory.path().join("profile"));
        state.persisted.lock().unwrap().settings["language"] = json!("zh-CN");
        assert_eq!(
            dialog_title(&state, DialogTitle::Directory),
            "打开 Git 仓库所在目录"
        );
        state.persisted.lock().unwrap().settings["language"] = json!("en");
        assert_eq!(
            dialog_title(&state, DialogTitle::Repository),
            "Open a Git repository"
        );
        assert!(
            serde_json::from_str::<crate::model::RepositoryPickerPurpose>("\"arbitrary title\"")
                .is_err()
        );
        assert!(matches!(
            serde_json::from_str::<crate::model::RepositoryPickerPurpose>("\"directory\"").unwrap(),
            crate::model::RepositoryPickerPurpose::Directory
        ));
    }

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
    fn directory_scope_roundtrips_without_scan_results_and_v1_v2_default_to_none() {
        for version in [1, 2] {
            let mut value = serde_json::to_value(PersistedState::default()).unwrap();
            value["version"] = json!(version);
            value.as_object_mut().unwrap().remove("directoryScope");
            let loaded: PersistedState = serde_json::from_value(value).unwrap();
            let migrated = migrate(loaded).unwrap();
            assert!(migrated.directory_scope.is_none());
            assert_eq!(migrated.settings["language"], "system");
            assert!(migrated.trusted.is_empty());
        }
        let directory = tempfile::tempdir().unwrap();
        let scope = crate::model::DirectoryScopeState {
            root: directory
                .path()
                .join("disconnected directory 中文")
                .to_string_lossy()
                .into_owned(),
            depth: 5,
            width: 180,
            collapsed: true,
            collapsed_paths: vec![
                String::new(),
                "parent/child%3A%5C%2F".into(),
                "name%20with%20spaces".into(),
            ],
        };
        let state = migrate(PersistedState {
            directory_scope: Some(scope.clone()),
            ..PersistedState::default()
        })
        .unwrap();
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(
            value["directoryScope"]["collapsedPaths"][1],
            "parent/child%3A%5C%2F"
        );
        assert!(value["directoryScope"].get("repositories").is_none());
        assert_eq!(
            serde_json::from_value::<PersistedState>(value.clone())
                .unwrap()
                .directory_scope,
            Some(scope)
        );
        let mut smuggled = value;
        smuggled["directoryScope"]["repositories"] = json!([{"path":"untrusted"}]);
        assert!(serde_json::from_value::<PersistedState>(smuggled).is_err());
    }

    #[test]
    fn directory_scope_enforces_path_depth_width_and_collapsed_key_bounds() {
        let directory = tempfile::tempdir().unwrap();
        let valid = crate::model::DirectoryScopeState {
            root: directory.path().to_string_lossy().into_owned(),
            depth: 0,
            width: 420,
            collapsed: false,
            collapsed_paths: vec![],
        };
        validate_directory_scope(&valid).unwrap();
        for root in [
            String::new(),
            "relative/root".into(),
            "bad\0root".into(),
            "bad\nroot".into(),
            "a".repeat(32769),
        ] {
            assert!(
                validate_directory_scope(&crate::model::DirectoryScopeState {
                    root,
                    ..valid.clone()
                })
                .is_err()
            );
        }
        for (depth, width) in [(6, 240), (0, 179), (0, 641)] {
            assert!(
                validate_directory_scope(&crate::model::DirectoryScopeState {
                    depth,
                    width,
                    ..valid.clone()
                })
                .is_err()
            );
        }
        for key in [
            "/absolute",
            "a//b",
            ".",
            "..",
            "a/../b",
            "a\\b",
            "a:b",
            "line\nbreak",
            "%bad",
            "a/%2e%2e",
            "%41",
            "%FF",
            "中文",
            "raw space",
        ] {
            assert!(
                validate_directory_scope(&crate::model::DirectoryScopeState {
                    collapsed_paths: vec![key.into()],
                    ..valid.clone()
                })
                .is_err(),
                "{key}"
            );
        }
        assert!(
            validate_directory_scope(&crate::model::DirectoryScopeState {
                collapsed_paths: vec!["a".repeat(32769)],
                ..valid.clone()
            })
            .is_err()
        );
        assert!(
            validate_directory_scope(&crate::model::DirectoryScopeState {
                collapsed_paths: vec!["a".into(); 257],
                ..valid.clone()
            })
            .is_err()
        );
        for key in [
            "folder%3Aname",
            "a%5Cb",
            "%E4%B8%AD%E6%96%87",
            "name%20space",
            "!~*'()_-.abc",
            "percent%25",
        ] {
            validate_directory_scope(&crate::model::DirectoryScopeState {
                collapsed_paths: vec![key.into()],
                ..valid.clone()
            })
            .unwrap();
        }
        validate_directory_scope(&crate::model::DirectoryScopeState {
            collapsed_paths: vec!["a".into(); 256],
            ..valid
        })
        .unwrap();
    }

    #[test]
    fn language_is_validated_global_only_and_never_shared() {
        for language in ["system", "en", "zh-CN"] {
            let state = migrate(PersistedState {
                settings: json!({"language":language}),
                ..PersistedState::default()
            })
            .unwrap();
            assert_eq!(state.settings["language"], language);
            assert_eq!(effective(&state, None)["language"], language);
            let (shared, warnings) =
                shared_settings(&json!({"language":language,"theme":"light"})).unwrap();
            assert_eq!(shared, json!({"theme":"light"}));
            assert_eq!(warnings.len(), 1);
            assert!(validate_settings(&json!({"language":language}), true, true).is_err());
        }
        for language in [
            json!("zh"),
            json!("auto"),
            json!("fr"),
            json!(true),
            Value::Null,
        ] {
            assert!(validate_settings(&json!({"language":language}), true, false).is_err());
        }
        let mut state = PersistedState::default();
        state
            .repo_settings
            .insert("repository".into(), json!({"language":"zh-CN"}));
        assert!(migrate(state.clone()).is_err());
        assert!(validate_state(&state).is_err());
        state.version = 1;
        let migrated = migrate(state).unwrap();
        assert!(migrated.repo_settings["repository"]
            .get("language")
            .is_none());
        assert_eq!(migrated.settings["language"], "system");
    }

    #[test]
    fn local_changes_position_migrates_and_remains_repo_overrideable_and_shareable() {
        let mut state = PersistedState {
            version: 2,
            settings: json!({"language":"zh-CN","startupScope":{"kind":"head"}}),
            layout: json!({"detailSize":360,"fileSize":280}),
            ..PersistedState::default()
        };
        state.repo_settings.insert(
            "repository".into(),
            json!({"localChangesPosition":"inline"}),
        );
        let state = migrate(state).unwrap();
        assert_eq!(state.version, 2);
        assert_eq!(state.settings["language"], "zh-CN");
        assert_eq!(state.settings["startupScope"], json!({"kind":"head"}));
        assert_eq!(state.settings["localChangesPosition"], "middle");
        assert_eq!(
            effective(&state, Some("repository"))["localChangesPosition"],
            "inline"
        );
        assert_eq!(
            state.layout,
            json!({"detailSize":360,"fileSize":280,"localWidth":390,"localListSize":230,"detailRatio":0.55})
        );
        for position in ["middle", "inline"] {
            validate_settings(&json!({"localChangesPosition":position}), true, true).unwrap();
            let (shared, warnings) = shared_settings(
                &json!({"localChangesPosition":position,"language":"en","localWidth":390}),
            )
            .unwrap();
            assert_eq!(shared, json!({"localChangesPosition":position}));
            assert_eq!(warnings.len(), 2);
        }
        for position in [
            json!("right"),
            json!(""),
            json!(false),
            json!(0.55),
            Value::Null,
        ] {
            assert!(
                validate_settings(&json!({"localChangesPosition":position}), true, false).is_err()
            );
        }
    }

    #[test]
    fn layout_defaults_fill_only_missing_fields_and_keep_finite_fractional_ratio() {
        assert_eq!(PersistedState::default().layout, layout_defaults());
        for version in [1, 2] {
            let state = migrate(PersistedState {
                version,
                layout: json!({}),
                ..PersistedState::default()
            })
            .unwrap();
            assert_eq!(state.version, 2);
            assert_eq!(state.layout, layout_defaults());
            let next = migrate(state.clone()).unwrap();
            assert_eq!(state.layout, next.layout);
            assert_eq!(state.settings, next.settings);
        }
        let layout = json!({"detailSize":480,"fileSize":320,"localWidth":500,"localListSize":300,"detailRatio":0.625});
        let state = migrate(PersistedState {
            layout: layout.clone(),
            ..PersistedState::default()
        })
        .unwrap();
        assert_eq!(state.layout, layout);
        let encoded = serde_json::to_value(state).unwrap();
        assert_eq!(encoded["layout"]["detailRatio"], 0.625);
        for layout in [
            json!({"localWidth":239}),
            json!({"localWidth":961}),
            json!({"localWidth":390.5}),
            json!({"localListSize":99}),
            json!({"localListSize":1201}),
            json!({"detailRatio":0.19}),
            json!({"detailRatio":0.81}),
            json!({"detailRatio":"0.55"}),
            json!({"detailRatio":null}),
            json!({"draft":"private message"}),
            json!([]),
        ] {
            assert!(
                migrate(PersistedState {
                    layout: layout.clone(),
                    ..PersistedState::default()
                })
                .is_err(),
                "{layout}"
            );
        }
        for (detail_size, file_size) in [(100.0, 100.0), (2000.0, 2000.0), (401.25, 300.75)] {
            let state = migrate(PersistedState {
                layout: json!({"detailSize":detail_size,"fileSize":file_size}),
                ..PersistedState::default()
            })
            .unwrap();
            assert_eq!(state.layout["detailSize"].as_f64(), Some(detail_size));
            assert_eq!(state.layout["fileSize"].as_f64(), Some(file_size));
        }
        for ratio in [0.2, 0.55, 0.8] {
            validate_layout(&json!({"detailRatio":ratio})).unwrap();
        }
    }

    #[test]
    fn new_detail_view_fields_roundtrip_with_old_language_scope_and_local_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let mut raw = serde_json::to_value(PersistedState::default()).unwrap();
        raw["directoryScope"] = json!({"root":directory.path().to_string_lossy(),"depth":2,"collapsed":true,"collapsedPaths":["folder"]});
        raw["settings"] =
            json!({"language":"zh-CN","startupScope":{"kind":"refs","refs":["refs/heads/main"]}});
        raw["views"] = json!({"repository":{
            "scope":{"kind":"head"},"search":"message","searchMode":"message","queryMode":"filter","order":"date",
            "scrollTop":54.5,"scrollLeft":23.25,"selected":"a".repeat(40),
            "detail":{"selection":{"kind":"commit","oid":"a".repeat(40),"parent":"b".repeat(40)},"path":"src/文件.ts",
                "scrollTop":12.5,"filesScrollTop":120.5,"filesScrollLeft":9.5,"fullMessage":true,"inlineSide":"above"},
            "filter":{"filesScrollTop":"120.5","diffMode":"diff"},"collapsed":["src"]
        }});
        let state = migrate(serde_json::from_value(raw.clone()).unwrap()).unwrap();
        assert_eq!(state.directory_scope.as_ref().unwrap().width, 376);
        assert_eq!(state.views["repository"], raw["views"]["repository"]);
        assert_eq!(state.settings["language"], "zh-CN");
        assert_eq!(
            state.settings["startupScope"],
            raw["settings"]["startupScope"]
        );
        let encoded = serde_json::to_value(&state).unwrap();
        let reloaded = migrate(serde_json::from_value(encoded).unwrap()).unwrap();
        assert_eq!(state.views, reloaded.views);
        assert_eq!(state.directory_scope, reloaded.directory_scope);
        for width in [180, 240, 376, 640] {
            raw["directoryScope"]["width"] = json!(width);
            let state = migrate(serde_json::from_value(raw.clone()).unwrap()).unwrap();
            assert_eq!(state.directory_scope.unwrap().width, width);
        }
        for width in [json!(179), json!(641), json!(376.5), json!("376")] {
            raw["directoryScope"]["width"] = width;
            let result = serde_json::from_value(raw.clone())
                .map_err(AppError::io)
                .and_then(migrate);
            assert!(result.is_err());
        }
    }

    #[test]
    fn detail_view_validation_rejects_unknown_fields_and_transient_drafts() {
        let valid = json!({"scrollTop":0,"scrollLeft":17.25,"detail":{"selection":{"kind":"working"},"filesScrollTop":0.5,"filesScrollLeft":20,"fullMessage":false,"inlineSide":"below"}});
        validate_view(&valid).unwrap();
        // Existing frontend budgets count UTF-16 units, including non-ASCII filenames and search text.
        let mut unicode = valid.clone();
        unicode["search"] = json!("文".repeat(32768));
        unicode["detail"]["path"] = json!("文".repeat(4096));
        unicode["filter"] = json!({"fileFilter":"文".repeat(4096)});
        unicode["collapsed"] = json!(["文".repeat(4096)]);
        validate_view(&unicode).unwrap();
        unicode["detail"]["path"] = json!("😀".repeat(2048));
        validate_view(&unicode).unwrap();
        unicode["detail"]["path"] = json!("😀".repeat(2049));
        assert!(validate_view(&unicode).is_err());
        for (key, value) in [
            ("scrollTop", json!(-1)),
            ("scrollLeft", json!(1_000_000_001_u64)),
            ("scrollLeft", json!("12")),
            ("scrollLeft", Value::Null),
            ("search", json!("x".repeat(32769))),
            ("searchMode", json!("shell")),
            ("draft", json!("private message")),
            ("localDrafts", json!({"repository":"private"})),
            ("collapsed", json!(vec!["path"; 10001])),
            ("filter", json!({"constructor":"unsafe"})),
        ] {
            let mut view = valid.clone();
            view[key] = value;
            assert!(validate_view(&view).is_err(), "{key}");
        }
        for (key, value) in [
            ("fullMessage", json!("true")),
            ("inlineSide", json!("left")),
            ("filesScrollTop", json!(-0.5)),
            ("filesScrollLeft", json!(true)),
            ("path", json!("x".repeat(4097))),
            ("draft", json!("private message")),
            ("files", json!([])),
            ("selection", json!({"kind":"commit","oid":"HEAD"})),
            (
                "selection",
                json!({"kind":"compare","base":"HEAD~1","target":"main"}),
            ),
            ("selection", json!({"kind":"working","draft":"private"})),
        ] {
            let mut view = valid.clone();
            view["detail"][key] = value;
            assert!(validate_view(&view).is_err(), "{key}");
        }
        for kind in ["commit", "compare"] {
            let target = if kind == "commit" {
                json!({"kind":kind,"oid":"a".repeat(64)})
            } else {
                json!({"kind":kind,"base":"a".repeat(40),"target":"b".repeat(40)})
            };
            validate_view_target(&target).unwrap();
        }
        let mut oversized = PersistedState::default();
        for index in 0..129 {
            oversized
                .views
                .insert(index.to_string(), json!({"search":"x".repeat(32768)}));
        }
        assert!(validate_state(&oversized).is_err());
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

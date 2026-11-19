//! Budgeted read-only disk observation; Runtime still owns cleanup eligibility.
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::{Path, PathBuf}, time::{Duration, Instant}};
const MAX_FILES: usize = 45_000;
const MAX_REPOS: usize = 32;
const DEADLINE: Duration = Duration::from_millis(1300);

fn plain_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).map(|stat| stat.is_dir() && !stat.file_type().is_symlink()).unwrap_or(false)
}

fn project_cache_paths(root: &Path, found: &mut Vec<(String, PathBuf)>) {
    if root.join("Package.swift").is_file() {
        found.push(("SwiftPM 构建缓存".into(), root.join(".build")));
    }
    if root.join("Cargo.toml").is_file() {
        found.push(("Cargo 构建缓存".into(), root.join("target")));
    }
    if root.join("package.json").is_file() {
        found.push(("Next.js 构建缓存".into(), root.join(".next")));
        found.push(("前端临时缓存".into(), root.join("node_modules/.cache")));
    }
}

fn disk_bytes(path: &Path, remaining: &mut usize, deadline: Instant) -> (u64, bool) {
    let mut stack = vec![(path.to_path_buf(), 0u8)];
    let mut size = 0u64;
    while let Some((item, depth)) = stack.pop() {
        if *remaining == 0 || Instant::now() >= deadline { return (size, true); }
        *remaining -= 1;
        let Ok(meta) = fs::symlink_metadata(&item) else { return (size, true); };
        if meta.file_type().is_symlink() { continue; }
        if meta.is_file() {
            size = size.saturating_add(meta.len());
        } else if meta.is_dir() {
            if depth >= 16 { return (size, true); }
            let Ok(children) = fs::read_dir(&item) else { return (size, true); };
            for child in children {
                let Ok(child) = child else { return (size, true); };
                stack.push((child.path(), depth + 1));
            }
        }
    }
    (size, false)
}

pub fn scan_repository_caches(repositories: &Value) -> Value {
    let deadline = Instant::now() + DEADLINE;
    let mut remaining = MAX_FILES;
    let mut locations: Vec<(String, String, PathBuf)> = Vec::new();
    let mut seen = HashSet::<PathBuf>::new();
    let repo_list = repositories.as_array().cloned().unwrap_or_default();
    for repo in repo_list.iter().take(MAX_REPOS) {
        if Instant::now() >= deadline { break; }
        let Some(raw_root) = repo.get("canonicalRoot").and_then(Value::as_str) else { continue; };
        let root = Path::new(raw_root);
        if !plain_directory(root) { continue; }
        let label = repo.get("displayName").and_then(Value::as_str).unwrap_or("项目");
        let mut caches = Vec::new();
        project_cache_paths(root, &mut caches);
        for scope in ["apps", "integrations", "packages"] {
            let container = root.join(scope);
            if !plain_directory(&container) { continue; }
            if let Ok(children) = fs::read_dir(container) {
                for child in children.flatten().take(30) {
                    if plain_directory(&child.path()) {
                        project_cache_paths(&child.path(), &mut caches);
                    }
                }
            }
        }
        for (kind, path) in caches {
            if plain_directory(&path) && seen.insert(path.clone()) {
                locations.push((label.into(), kind, path));
            }
        }
    }
    // Shared global tool caches are informational only.
    if let Some(home) = dirs::home_dir() {
        for (kind, path) in [
            ("Xcode DerivedData", home.join("Library/Developer/Xcode/DerivedData")),
            ("Gradle 共享缓存", home.join(".gradle/caches")),
        ] {
            if plain_directory(&path) && seen.insert(path.clone()) {
                locations.push(("全局缓存".into(), kind.into(), path));
            }
        }
    }
    let mut rows = Vec::new();
    let mut incomplete = repo_list.len() > MAX_REPOS;
    for (project, kind, path) in locations {
        if Instant::now() >= deadline { incomplete = true; break; }
        let (size, partial) = disk_bytes(&path, &mut remaining, deadline);
        incomplete |= partial;
        rows.push(json!({
            "project": project,
            "kind": kind,
            "path": path.to_string_lossy(),
            "logicalBytes": size,
            "partial": partial,
            "eligible": false
        }));
    }
    rows.sort_by(|a, b| b["logicalBytes"].as_u64().cmp(&a["logicalBytes"].as_u64()));
    json!({ "items": rows, "incomplete": incomplete, "measurement": "bounded_logical_bytes" })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scanner_does_not_follow_symlinks() {
        let root = std::env::temp_dir().join(format!("forge-inventory-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("cache")).unwrap();
        fs::write(root.join("cache/file"), b"abcde").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", root.join("cache/link")).unwrap();
        let (size, incomplete) = disk_bytes(&root.join("cache"), &mut 100, Instant::now() + Duration::from_secs(1));
        assert_eq!(size, 5);
        assert!(!incomplete);
        fs::remove_dir_all(root).unwrap();
    }
}
